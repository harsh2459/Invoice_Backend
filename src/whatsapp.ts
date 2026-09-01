/**
 * Per-company WhatsApp clients (Baileys, no Chromium).
 *
 * One `WaClient` per company id. Each keeps its own paired session under
 * backend/.wa-auth/company-<id>/ and its own media under
 * backend/.wa-media/company-<id>/. Clients are supervised: they auto-start with
 * the server (for any company that has ever paired), auto-reconnect forever with
 * backoff, send a keep-alive, and queue outbound messages while a socket is
 * momentarily down so sends never fail from a blip.
 *
 * The UI only ever sees:
 *   idle        never started for this company
 *   qr          waiting for a first scan
 *   connecting  opening / reconnecting  (NOT shown as "disconnected")
 *   connected   ready
 *   logged_out  session invalid — needs a fresh scan
 *
 * Every exported function takes companyId as its first argument.
 */
import path from "path";
import fs from "fs";
import QRCode from "qrcode";
import { query, exec } from "./db";
import {
  waEvents,
  upsertContacts,
  upsertChats,
  saveIncomingMessage,
  recordOutgoing,
  updateStatuses,
  updateReceipts,
  setProfilePic,
  attachMediaPath,
  getMessageRaw,
  mediaDirFor,
  DATA_DIR,
} from "./waStore";
import { refreshRoster, getRoster } from "./waRoster";

export { waEvents } from "./waStore";

// Baileys 6.7+ is ESM-only; backend is CJS (run via tsx). Load via dynamic import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WASocket = any;
let baileysPromise: Promise<any> | null = null;
function baileys(): Promise<any> {
  if (!baileysPromise) baileysPromise = import("@whiskeysockets/baileys");
  return baileysPromise;
}

function boomStatus(err: unknown): number | undefined {
  const e = err as any;
  return e?.output?.statusCode ?? e?.output?.payload?.statusCode;
}

const AUTH_ROOT = path.join(DATA_DIR, ".wa-auth");
const authDirFor = (companyId: number) => path.join(AUTH_ROOT, `company-${companyId}`);

export type WaStatus =
  | "idle"
  | "connecting"
  | "qr"
  | "connected"
  | "logged_out"
  | "error";

export interface WaState {
  companyId: number;
  status: WaStatus;
  qrDataUrl: string | null;
  me: { name: string; number: string } | null;
  lastError: string | null;
  queued: number; // outbound messages waiting for reconnect
  updatedAt: string;
}

export function toJid(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) throw Object.assign(new Error("Phone number is empty"), { userError: true });
  const withCc = digits.length === 10 ? "91" + digits : digits;
  return `${withCc}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------

type QueuedSend = {
  run: () => Promise<string | null>;
  resolve: (id: string | null) => void;
  reject: (e: any) => void;
};

class WaClient {
  readonly companyId: number;
  private authDir: string;
  private sock: WASocket | null = null;
  private status: WaStatus = "idle";
  private qrDataUrl: string | null = null;
  private me: { name: string; number: string } | null = null;
  private lastError: string | null = null;
  private updatedAt = new Date().toISOString();

  private starting = false;
  private manualLogout = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 6;

  private queue: QueuedSend[] = [];

  constructor(companyId: number) {
    this.companyId = companyId;
    this.authDir = authDirFor(companyId);
  }

  // ---- state ----

  getState(): WaState {
    return {
      companyId: this.companyId,
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      me: this.me,
      lastError: this.lastError,
      queued: this.queue.length,
      updatedAt: this.updatedAt,
    };
  }

  private set(patch: Partial<Omit<WaState, "companyId" | "queued" | "updatedAt">>) {
    if (patch.status !== undefined) this.status = patch.status;
    if (patch.qrDataUrl !== undefined) this.qrDataUrl = patch.qrDataUrl;
    if (patch.me !== undefined) this.me = patch.me;
    if (patch.lastError !== undefined) this.lastError = patch.lastError;
    this.updatedAt = new Date().toISOString();
    waEvents.emit("status", this.getState());
    // persist a lightweight row so we know which companies to auto-start
    void exec(
      `INSERT INTO wa_sessions (company_id, status, phone_number, display_name, last_connected_at)
       VALUES (?, ?, ?, ?, ${this.status === "connected" ? "NOW()" : "last_connected_at"})
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         phone_number = COALESCE(VALUES(phone_number), phone_number),
         display_name = COALESCE(VALUES(display_name), display_name)${
           this.status === "connected" ? ", last_connected_at = NOW()" : ""
         }`,
      [this.companyId, this.status, this.me?.number ?? null, this.me?.name ?? null]
    ).catch(() => {});
  }

  private isReady() {
    return this.status === "connected" && !!this.sock;
  }

  // ---- lifecycle ----

  private initLock: Promise<void> | null = null;
  init(): Promise<void> {
    if (this.initLock) return this.initLock;
    this.initLock = this.doInit().finally(() => {
      this.initLock = null;
    });
    return this.initLock;
  }

  async reconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.consecutiveFailures = 0;
    this.sock = null;
    await this.init();
  }

  async logout(): Promise<void> {
    this.manualLogout = true;
    try {
      await this.sock?.logout();
    } catch {
      /* already dead */
    }
    this.stopKeepAlive();
    this.sock = null;
    this.wipeSession();
    this.set({ status: "logged_out", qrDataUrl: null, me: null, lastError: null });
    this.manualLogout = false;
    // begin a fresh session so a QR appears without another click
    void this.init();
  }

  private wipeSession() {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.sock = null;
  }

  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.init();
    }, delayMs);
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    // A light presence ping keeps the WhatsApp socket from going idle-dead.
    this.keepAlive = setInterval(() => {
      if (this.isReady()) {
        this.sock.sendPresenceUpdate("available").catch(() => {});
      }
    }, 30_000);
  }
  private stopKeepAlive() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  private async doInit(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    if (this.status !== "qr") this.set({ status: "connecting", lastError: null });

    try {
      const {
        default: makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        Browsers,
        DisconnectReason,
      } = await baileys();

      fs.mkdirSync(this.authDir, { recursive: true });
      const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      // Load the client roster before events fire, so the first history dump is
      // already filtered to this company's clients.
      await refreshRoster(this.companyId).catch(() => {});

      this.sock = makeWASocket({
        version,
        auth: authState,
        browser: Browsers.appropriate("Desktop"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        retryRequestDelayMs: 1500,
        keepAliveIntervalMs: 20_000,
      });

      this.sock.ev.on("creds.update", saveCreds);
      this.wireInboxEvents();
      this.wireConnectionEvents(DisconnectReason);
    } catch (e: any) {
      this.starting = false;
      this.consecutiveFailures++;
      this.set({ status: "error", lastError: e?.message || String(e) });
      this.scheduleReconnect(Math.min(5000 * this.consecutiveFailures, 30_000));
      return;
    }
    this.starting = false;
  }

  /** Rebuild this company's client roster (call after a client is added/edited). */
  async refreshRoster(): Promise<void> {
    await refreshRoster(this.companyId);
  }

  /** Best-effort: ask WhatsApp for recent messages in each client thread so
   *  existing conversations populate without importing the whole account. */
  private async pullClientHistory(): Promise<void> {
    if (!this.isReady()) return;
    const jids = [...getRoster(this.companyId).keys()];
    for (const jid of jids) {
      try {
        // fetchMessageHistory needs a cursor message; if we don't have one we
        // simply rely on live messages + whatever history.set already gave us.
        if (typeof this.sock.fetchMessageHistory === "function") {
          // 20 most recent, no cursor -> Baileys pulls the latest page
          await this.sock.fetchMessageHistory(20, { remoteJid: jid }, undefined);
        }
      } catch {
        /* thread may have no history — fine */
      }
    }
  }

  // ---- Baileys → waStore mirror ----

  private wireInboxEvents() {
    const cid = this.companyId;
    const s = this.sock;

    // History dump from WhatsApp on link. We DON'T bulk-import — waStore drops
    // anything that isn't one of this company's clients, so only client threads
    // land, and there's nothing to "sync" for everyone else.
    s.ev.on("messaging-history.set", async (h: any) => {
      try {
        if (h.contacts?.length) await upsertContacts(cid, h.contacts);
        if (h.chats?.length) await upsertChats(cid, h.chats);
        for (const m of h.messages || []) await saveIncomingMessage(cid, m, { isHistory: true });
      } catch (e) {
        console.error(`[wa:${cid}] history.set`, e);
      }
    });

    s.ev.on("contacts.upsert", (c: any[]) => void upsertContacts(cid, c).catch(() => {}));
    s.ev.on("contacts.update", (c: any[]) => void upsertContacts(cid, c).catch(() => {}));
    s.ev.on("chats.upsert", (c: any[]) => void upsertChats(cid, c).catch(() => {}));
    s.ev.on("chats.update", (c: any[]) => void upsertChats(cid, c).catch(() => {}));

    s.ev.on("messages.upsert", async (ev: any) => {
      if (ev.type !== "notify" && ev.type !== "append") return;
      for (const m of ev.messages || []) {
        try {
          await saveIncomingMessage(cid, m, { isHistory: ev.type === "append" });
        } catch (e) {
          console.error(`[wa:${cid}] messages.upsert`, e);
        }
      }
    });

    s.ev.on("messages.update", (u: any[]) => void updateStatuses(cid, u).catch(() => {}));
    s.ev.on("message-receipt.update", (u: any[]) => void updateReceipts(cid, u).catch(() => {}));
  }

  private wireConnectionEvents(DisconnectReason: any) {
    this.sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          this.set({ status: "qr", qrDataUrl: this.qrDataUrl });
        } catch (e: any) {
          this.set({ status: "error", lastError: e?.message || String(e) });
        }
      }

      if (connection === "open") {
        this.consecutiveFailures = 0;
        const user = this.sock?.user;
        this.set({
          status: "connected",
          qrDataUrl: null,
          lastError: null,
          me: user
            ? {
                name: user.name || user.verifiedName || "(unknown)",
                number: (user.id || "").split(":")[0].split("@")[0] || "(unknown)",
              }
            : null,
        });
        console.log(`[wa:${this.companyId}] connected as`, this.me?.name, this.me?.number);
        this.startKeepAlive();
        void this.flushQueue();
        // Build this company's client roster, then pull recent history for just
        // those numbers (not the whole account).
        refreshRoster(this.companyId)
          .then(() => this.pullClientHistory())
          .catch((e) => console.error(`[wa:${this.companyId}] roster/history`, e));
      }

      if (connection === "close") {
        this.starting = false;
        this.stopKeepAlive();
        const code = boomStatus(lastDisconnect?.error);

        if (this.manualLogout) return;

        if (code === DisconnectReason.loggedOut) {
          this.wipeSession();
          this.consecutiveFailures = 0;
          this.set({
            status: "logged_out",
            qrDataUrl: null,
            me: null,
            lastError: "Logged out on the phone. Scan the QR again.",
          });
          this.scheduleReconnect(800);
          return;
        }

        if (code === DisconnectReason.restartRequired) {
          this.set({ status: "connecting", lastError: null });
          this.scheduleReconnect(400);
          return;
        }

        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.MAX_FAILURES) {
          console.warn(
            `[wa:${this.companyId}] ${this.consecutiveFailures} straight failures — wiping session`
          );
          this.wipeSession();
          this.consecutiveFailures = 0;
          this.set({
            status: "logged_out",
            qrDataUrl: null,
            me: null,
            lastError: "Could not resume the session. Scan the QR again.",
          });
          this.scheduleReconnect(1000);
          return;
        }
        // transient — stay "connecting" (never "disconnected"), back off
        const delay = Math.min(2000 * 2 ** (this.consecutiveFailures - 1), 30_000);
        this.set({
          status: "connecting",
          lastError:
            (lastDisconnect?.error as Error | undefined)?.message || `reconnecting (${code})`,
        });
        this.scheduleReconnect(delay);
      }
    });
  }

  // ---- sending (with reconnect queue) ----

  private enqueue(run: () => Promise<string | null>): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      waEvents.emit("status", this.getState());
      // give a reconnect a nudge
      if (this.status !== "connected" && !this.reconnectTimer) this.scheduleReconnect(200);
    });
  }

  private async flushQueue() {
    if (!this.isReady()) return;
    const pending = this.queue.splice(0);
    for (const job of pending) {
      try {
        job.resolve(await job.run());
      } catch (e) {
        job.reject(e);
      }
    }
    waEvents.emit("status", this.getState());
  }

  /** Run now if connected; queue only during a transient reconnect. Reject
   *  immediately when there is no usable pairing (idle / qr / logged_out). */
  private send(run: () => Promise<string | null>): Promise<string | null> {
    if (this.status === "logged_out" || this.status === "idle" || this.status === "qr") {
      return Promise.reject(
        Object.assign(new Error("This company's WhatsApp is not connected."), {
          userError: true,
          code: "WA_NOT_CONNECTED",
        })
      );
    }
    if (this.isReady()) return run();
    // status is "connecting" or "error" with a prior pairing — queue briefly.
    // Safety valve: if it doesn't come back in 20s, fail the send rather than hang.
    return Promise.race([
      this.enqueue(run),
      new Promise<string | null>((_, reject) =>
        setTimeout(
          () =>
            reject(
              Object.assign(new Error("WhatsApp did not reconnect in time — try again."), {
                userError: true,
                code: "WA_NOT_CONNECTED",
              })
            ),
          20_000
        )
      ),
    ]);
  }

  async checkNumber(phone: string): Promise<string | null> {
    if (!this.isReady()) return null;
    const jid = toJid(phone);
    const results = await this.sock.onWhatsApp(jid);
    const hit = results?.find((r: { exists?: boolean; jid: string }) => r.exists);
    return hit ? hit.jid : null;
  }

  sendText(phone: string, body: string): Promise<string | null> {
    return this.send(async () => {
      const jid = (await this.checkNumber(phone)) ?? toJid(phone);
      const sent = await this.sock.sendMessage(jid, { text: body });
      const id = sent?.key?.id ?? null;
      if (id) await recordOutgoing(this.companyId, { chatJid: jid, msgId: id, type: "text", text: body });
      return id;
    });
  }

  sendPdf(phone: string, buffer: Buffer, filename: string, caption?: string): Promise<string | null> {
    return this.send(async () => {
      const jid = (await this.checkNumber(phone)) ?? toJid(phone);
      const sent = await this.sock.sendMessage(jid, {
        document: buffer,
        mimetype: "application/pdf",
        fileName: filename,
        caption: caption || undefined,
      });
      const id = sent?.key?.id ?? null;
      if (id) {
        await recordOutgoing(this.companyId, {
          chatJid: jid,
          msgId: id,
          type: "document",
          text: caption || "",
          filename,
        });
      }
      return id;
    });
  }

  sendChatText(jid: string, text: string): Promise<string | null> {
    return this.send(async () => {
      const sent = await this.sock.sendMessage(jid, { text });
      const id = sent?.key?.id ?? null;
      if (id) await recordOutgoing(this.companyId, { chatJid: jid, msgId: id, type: "text", text });
      return id;
    });
  }

  sendChatMedia(
    jid: string,
    buffer: Buffer,
    mime: string,
    filename: string,
    caption?: string
  ): Promise<string | null> {
    return this.send(async () => {
      const isImage = mime.startsWith("image/");
      const content: any = isImage
        ? { image: buffer, caption: caption || undefined }
        : { document: buffer, mimetype: mime, fileName: filename, caption: caption || undefined };
      const sent = await this.sock.sendMessage(jid, content);
      const id = sent?.key?.id ?? null;
      if (id) {
        const dir = mediaDirFor(this.companyId);
        const rel = path.join("out", `${id}-${filename}`.replace(/[^\w.\-]+/g, "_"));
        try {
          fs.mkdirSync(path.join(dir, "out"), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), buffer);
        } catch {
          /* non-fatal */
        }
        await recordOutgoing(this.companyId, {
          chatJid: jid,
          msgId: id,
          type: isImage ? "image" : "document",
          text: caption || "",
          filename,
          mediaPath: rel,
          mediaMime: mime,
        });
      }
      return id;
    });
  }

  async markRead(jid: string): Promise<void> {
    if (!this.isReady()) return;
    try {
      await this.sock.chatModify({ markRead: true, lastMessages: [] }, jid);
    } catch {
      /* no-op */
    }
  }

  async fetchProfilePic(jid: string): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const url = await this.sock.profilePictureUrl(jid, "image");
      await setProfilePic(this.companyId, jid, url || null);
      return url || null;
    } catch {
      await setProfilePic(this.companyId, jid, null);
      return null;
    }
  }

  async ensureMedia(msgKey: string): Promise<{ path: string; mime: string } | null> {
    const row = await getMessageRaw(this.companyId, msgKey);
    if (!row) return null;
    if (row.media_path) {
      return { path: row.media_path, mime: row.media_mime || "application/octet-stream" };
    }
    if (!this.isReady()) return null;

    const { downloadMediaMessage } = await baileys();
    const raw = typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw;
    const [remoteJid, fromMeStr, id] = String(row.msg_key).split("_");
    const fake = { key: { remoteJid, fromMe: fromMeStr === "1", id }, message: raw };
    try {
      const buf: Buffer = await downloadMediaMessage(fake, "buffer", {});
      const m =
        raw.imageMessage ||
        raw.videoMessage ||
        raw.documentMessage ||
        raw.documentWithCaptionMessage?.message?.documentMessage ||
        raw.audioMessage ||
        {};
      const mime = m.mimetype || "application/octet-stream";
      const ext = mime.split("/")[1]?.split(";")[0] || "bin";
      const dir = mediaDirFor(this.companyId);
      const rel = path.join("in", `${row.msg_key.replace(/[^\w.\-]+/g, "_")}.${ext}`);
      fs.mkdirSync(path.join(dir, "in"), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), buf);
      await attachMediaPath(this.companyId, row.msg_key, rel, mime);
      return { path: rel, mime };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// registry

const clients = new Map<number, WaClient>();

function client(companyId: number): WaClient {
  let c = clients.get(companyId);
  if (!c) {
    c = new WaClient(companyId);
    clients.set(companyId, c);
  }
  return c;
}

/** Start clients for every company that has an existing session folder or a
 *  wa_sessions row that was ever connected. Called once from server.ts. */
export async function initAll(): Promise<void> {
  const ids = new Set<number>();

  // from session folders on disk
  try {
    for (const name of fs.readdirSync(AUTH_ROOT)) {
      const m = name.match(/^company-(\d+)$/);
      if (m) ids.add(Number(m[1]));
    }
  } catch {
    /* dir may not exist yet */
  }

  // from the DB (in case the folder was moved but the row remains)
  try {
    const rows = await query<{ company_id: number }>(
      "SELECT company_id FROM wa_sessions WHERE status <> 'idle'"
    );
    for (const r of rows) ids.add(Number(r.company_id));
  } catch {
    /* table not ready */
  }

  for (const id of ids) {
    console.log(`[wa] supervising company ${id}`);
    client(id)
      .init()
      .catch((e) => console.error(`[wa:${id}] init`, e));
  }
}

// ---- per-company API used by routes ----

export const getState = (companyId: number) => client(companyId).getState();
export const connect = (companyId: number) => client(companyId).init();
export const reconnect = (companyId: number) => client(companyId).reconnect();
export const logout = (companyId: number) => client(companyId).logout();
/** Rebuild a company's client roster (call when clients are added/edited). */
export const refreshClientRoster = (companyId: number) =>
  client(companyId).refreshRoster();
export const checkNumber = (companyId: number, phone: string) =>
  client(companyId).checkNumber(phone);
export const sendText = (companyId: number, phone: string, body: string) =>
  client(companyId).sendText(phone, body);
export const sendPdf = (
  companyId: number,
  phone: string,
  buffer: Buffer,
  filename: string,
  caption?: string
) => client(companyId).sendPdf(phone, buffer, filename, caption);
export const sendChatText = (companyId: number, jid: string, text: string) =>
  client(companyId).sendChatText(jid, text);
export const sendChatMedia = (
  companyId: number,
  jid: string,
  buffer: Buffer,
  mime: string,
  filename: string,
  caption?: string
) => client(companyId).sendChatMedia(jid, buffer, mime, filename, caption);
export const markRead = (companyId: number, jid: string) => client(companyId).markRead(jid);
export const fetchProfilePic = (companyId: number, jid: string) =>
  client(companyId).fetchProfilePic(jid);
export const ensureMedia = (companyId: number, msgKey: string) =>
  client(companyId).ensureMedia(msgKey);

/** All known clients' states (for the sessions overview). */
export function allStates(): WaState[] {
  return [...clients.values()].map((c) => c.getState());
}
