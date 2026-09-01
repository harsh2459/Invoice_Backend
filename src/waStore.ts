/**
 * Persistence + fan-out for the per-company WhatsApp inbox. `whatsapp.ts` feeds
 * Baileys events in here (always with a companyId); this writes them to MySQL and
 * re-emits normalised shapes on `waEvents`, which waSocketBridge routes to the
 * right Socket.IO room.
 *
 * Every table row is scoped by company_id. Every emitted event carries companyId.
 *
 * Normalised message shape sent to the frontend:
 *   { companyId, msgKey, chatJid, fromMe, senderJid, ts, type, text, hasMedia,
 *     mediaMime, filename, status, quotedKey }
 */
import { EventEmitter } from "events";
import path from "path";
import fs from "fs";
import { query, exec } from "./db";
import { inRoster, getRoster, phoneToJid } from "./waRoster";

// DATA_DIR lets a host mount a persistent volume (Railway/Render disk). WhatsApp
// auth + media MUST survive restarts or every company has to re-scan its QR.
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
export const MEDIA_ROOT = path.join(DATA_DIR, ".wa-media");
fs.mkdirSync(MEDIA_ROOT, { recursive: true });
export const mediaDirFor = (companyId: number) =>
  path.join(MEDIA_ROOT, `company-${companyId}`);

export const waEvents = new EventEmitter();
waEvents.setMaxListeners(200);

// ---- helpers --------------------------------------------------------

export function jidIsGroup(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** Best-effort plain text from a Baileys message node. */
export function extractText(m: any): { type: string; text: string; filename?: string } {
  const msg = m?.message || {};
  if (msg.conversation) return { type: "text", text: msg.conversation };
  if (msg.extendedTextMessage?.text) return { type: "text", text: msg.extendedTextMessage.text };
  if (msg.imageMessage) return { type: "image", text: msg.imageMessage.caption || "" };
  if (msg.videoMessage) return { type: "video", text: msg.videoMessage.caption || "" };
  if (msg.documentMessage)
    return {
      type: "document",
      text: msg.documentMessage.caption || "",
      filename: msg.documentMessage.fileName || "document",
    };
  if (msg.documentWithCaptionMessage?.message?.documentMessage) {
    const d = msg.documentWithCaptionMessage.message.documentMessage;
    return { type: "document", text: d.caption || "", filename: d.fileName || "document" };
  }
  if (msg.audioMessage) return { type: "audio", text: "" };
  if (msg.stickerMessage) return { type: "sticker", text: "" };
  if (msg.contactMessage) return { type: "contact", text: msg.contactMessage.displayName || "" };
  if (msg.locationMessage) return { type: "location", text: "" };
  if (msg.reactionMessage) return { type: "reaction", text: msg.reactionMessage.text || "" };
  if (msg.protocolMessage) return { type: "protocol", text: "" };
  return { type: "unknown", text: "" };
}

function preview(type: string, text: string): string {
  if (text) return text;
  return (
    {
      image: "📷 Photo",
      video: "🎥 Video",
      document: "📄 Document",
      audio: "🎧 Audio",
      sticker: "🌟 Sticker",
      contact: "👤 Contact",
      location: "📍 Location",
    } as Record<string, string>
  )[type] || "";
}

function keyStr(key: any): string {
  return `${key?.remoteJid || "?"}_${key?.fromMe ? 1 : 0}_${key?.id || Math.random()}`;
}

// ---- contacts -----------------------------------------------------

export async function upsertContacts(companyId: number, contacts: any[]): Promise<void> {
  for (const c of contacts) {
    if (!c?.id) continue;
    if (!inRoster(companyId, c.id)) continue; // only client contacts
    await exec(
      `INSERT INTO wa_contacts (company_id, jid, name, notify, is_business)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = COALESCE(VALUES(name), name),
         notify = COALESCE(VALUES(notify), notify),
         is_business = VALUES(is_business)`,
      [companyId, c.id, c.name || c.verifiedName || null, c.notify || null, c.isBusiness ? 1 : 0]
    );
  }
}

export async function setProfilePic(
  companyId: number,
  jid: string,
  url: string | null
): Promise<void> {
  await exec(
    `INSERT INTO wa_contacts (company_id, jid, pic_url, pic_fetched_at) VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE pic_url = VALUES(pic_url), pic_fetched_at = NOW()`,
    [companyId, jid, url]
  );
  waEvents.emit("contact", { companyId, jid, picUrl: url });
}

async function displayName(companyId: number, jid: string): Promise<string | null> {
  const rows = await query<{ name: string; notify: string }>(
    "SELECT name, notify FROM wa_contacts WHERE company_id = ? AND jid = ?",
    [companyId, jid]
  );
  return rows[0]?.name || rows[0]?.notify || null;
}

// ---- chats ------------------------------------------------------

export async function upsertChats(companyId: number, chats: any[]): Promise<void> {
  for (const ch of chats) {
    if (!ch?.id) continue;
    if (!inRoster(companyId, ch.id)) continue; // only this company's clients
    const isGroup = jidIsGroup(ch.id) ? 1 : 0;
    const name = ch.name || ch.subject || (await displayName(companyId, ch.id));
    const ts = Number(ch.conversationTimestamp) || Number(ch.lastMessageRecvTimestamp) || 0;
    await exec(
      `INSERT INTO wa_chats (company_id, jid, name, is_group, last_message_ts, unread_count, archived, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = COALESCE(VALUES(name), name),
         is_group = VALUES(is_group),
         last_message_ts = GREATEST(last_message_ts, VALUES(last_message_ts)),
         unread_count = VALUES(unread_count),
         archived = VALUES(archived),
         pinned = VALUES(pinned)`,
      [
        companyId,
        ch.id,
        name || null,
        isGroup,
        ts * (ts < 1e12 ? 1000 : 1),
        Math.max(0, Number(ch.unreadCount) || 0),
        ch.archived ? 1 : 0,
        ch.pinned ? 1 : 0,
      ]
    );
    waEvents.emit("chat", await getChat(companyId, ch.id));
  }
}

export async function getChat(companyId: number, jid: string) {
  const rows = await query<any>(
    `SELECT c.jid, c.name, c.is_group AS isGroup, c.last_message_text AS lastMessageText,
            c.last_message_ts AS lastMessageTs, c.unread_count AS unreadCount,
            c.archived, c.pinned, ct.pic_url AS picUrl, ct.notify
     FROM wa_chats c
     LEFT JOIN wa_contacts ct ON ct.company_id = c.company_id AND ct.jid = c.jid
     WHERE c.company_id = ? AND c.jid = ?`,
    [companyId, jid]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    companyId,
    isGroup: !!r.isGroup,
    archived: !!r.archived,
    pinned: !!r.pinned,
    name: r.name || r.notify || null,
  };
}

/**
 * The inbox list IS the company's client roster. One row per client linked to
 * this company, left-joined to any conversation we've mirrored. Clients with no
 * chat yet still appear (lastMessageTs = 0) so you can start one.
 *
 * Order: clients with activity first (newest message first), then the rest
 * alphabetically.
 */
export async function listChats(companyId: number, _limit = 500, _offset = 0) {
  // Two cheap indexed queries + a JS merge — no regex in the JOIN.
  const [clients, chats] = await Promise.all([
    query<{ id: number; name: string; phone: string | null }>(
      `SELECT cl.id, cl.name, cl.phone
       FROM company_clients ccl
       JOIN clients cl ON cl.id = ccl.client_id
       WHERE ccl.company_id = ?`,
      [companyId]
    ),
    query<any>(
      `SELECT c.jid, c.last_message_text, c.last_message_ts, c.unread_count, c.pinned,
              ct.pic_url
       FROM wa_chats c
       LEFT JOIN wa_contacts ct ON ct.company_id = c.company_id AND ct.jid = c.jid
       WHERE c.company_id = ?`,
      [companyId]
    ),
  ]);

  const chatByJid = new Map<string, any>();
  for (const c of chats) chatByJid.set(c.jid, c);

  const rows = clients
    .map((cl) => {
      const jid = phoneToJid(cl.phone);
      if (!jid) return null;
      const c = chatByJid.get(jid);
      return {
        companyId,
        clientId: Number(cl.id),
        jid,
        name: cl.name,
        phone: cl.phone || null,
        isGroup: false,
        lastMessageText: (c?.last_message_text as string) || null,
        lastMessageTs: Number(c?.last_message_ts) || 0,
        unreadCount: Number(c?.unread_count) || 0,
        pinned: !!c?.pinned,
        archived: false,
        picUrl: (c?.pic_url as string) || null,
        notify: null as string | null,
      };
    })
    .filter(Boolean) as any[];

  rows.sort((a, b) => {
    if ((a.lastMessageTs > 0) !== (b.lastMessageTs > 0)) return a.lastMessageTs > 0 ? -1 : 1;
    if (a.lastMessageTs !== b.lastMessageTs) return b.lastMessageTs - a.lastMessageTs;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

/** JIDs of the company's clients (for a targeted history pull on connect). */
export function rosterJids(companyId: number): string[] {
  return [...getRoster(companyId).keys()];
}

async function bumpChatFromMessage(
  companyId: number,
  row: {
    chat_jid: string;
    ts: number;
    type: string;
    text: string;
    from_me: number;
    isHistory?: boolean;
  }
) {
  const isGroup = jidIsGroup(row.chat_jid) ? 1 : 0;
  const name = await displayName(companyId, row.chat_jid);
  const unreadDelta = row.from_me || row.isHistory ? 0 : 1;
  await exec(
    `INSERT INTO wa_chats (company_id, jid, name, is_group, last_message_text, last_message_ts, unread_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = COALESCE(name, VALUES(name)),
       last_message_text = IF(VALUES(last_message_ts) >= last_message_ts, VALUES(last_message_text), last_message_text),
       last_message_ts = GREATEST(last_message_ts, VALUES(last_message_ts)),
       unread_count = unread_count + ?`,
    [companyId, row.chat_jid, name, isGroup, preview(row.type, row.text), row.ts, unreadDelta, unreadDelta]
  );
}

// ---- messages ---------------------------------------------------

function toWire(companyId: number, r: any) {
  return {
    companyId,
    msgKey: r.msg_key,
    chatJid: r.chat_jid,
    fromMe: !!r.from_me,
    senderJid: r.sender_jid,
    ts: Number(r.ts),
    type: r.type,
    text: r.text,
    hasMedia: !!r.media_path,
    mediaMime: r.media_mime,
    filename: r.filename,
    status: r.status,
    quotedKey: r.quoted_key,
  };
}

export async function saveIncomingMessage(
  companyId: number,
  m: any,
  opts: { isHistory?: boolean } = {}
): Promise<ReturnType<typeof toWire> | null> {
  const key = m?.key;
  if (!key?.remoteJid) return null;
  if (key.remoteJid === "status@broadcast") return null;
  // Only mirror conversations with this company's own clients.
  if (!inRoster(companyId, key.remoteJid)) return null;

  const msgKey = keyStr(key);
  const { type, text, filename } = extractText(m);
  if (type === "protocol" || type === "reaction") return null;

  const tsSec = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
  const ts = tsSec ? tsSec * 1000 : Date.now();
  const fromMe = key.fromMe ? 1 : 0;
  const senderJid = key.participant || (fromMe ? "me" : key.remoteJid);
  const quoted =
    m.message?.extendedTextMessage?.contextInfo?.stanzaId ||
    m.message?.imageMessage?.contextInfo?.stanzaId ||
    null;

  const res = await exec(
    `INSERT INTO wa_chat_messages
       (company_id, msg_key, chat_jid, from_me, sender_jid, ts, type, text, filename, status, quoted_key, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE text = VALUES(text), status = GREATEST(status, VALUES(status))`,
    [
      companyId,
      msgKey,
      key.remoteJid,
      fromMe,
      senderJid,
      ts,
      type,
      text || null,
      filename || null,
      fromMe ? 1 : 0,
      quoted,
      JSON.stringify(m.message || {}).slice(0, 60000),
    ]
  );

  await bumpChatFromMessage(companyId, {
    chat_jid: key.remoteJid,
    ts,
    type,
    text,
    from_me: fromMe,
    isHistory: opts.isHistory,
  });

  const wire = toWire(companyId, {
    msg_key: msgKey,
    chat_jid: key.remoteJid,
    from_me: fromMe,
    sender_jid: senderJid,
    ts,
    type,
    text,
    media_path: null,
    media_mime: null,
    filename,
    status: fromMe ? 1 : 0,
    quoted_key: quoted,
  });

  if (!opts.isHistory && res.affectedRows > 0) {
    waEvents.emit("message", wire);
    waEvents.emit("chat", await getChat(companyId, key.remoteJid));
  }
  return wire;
}

export async function recordOutgoing(
  companyId: number,
  opts: {
    chatJid: string;
    msgId: string;
    type: string;
    text: string;
    filename?: string;
    mediaPath?: string;
    mediaMime?: string;
  }
) {
  const msgKey = `${opts.chatJid}_1_${opts.msgId}`;
  const ts = Date.now();
  await exec(
    `INSERT INTO wa_chat_messages
       (company_id, msg_key, chat_jid, from_me, sender_jid, ts, type, text, media_path, media_mime, filename, status)
     VALUES (?, ?, ?, 1, 'me', ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE text = VALUES(text)`,
    [
      companyId,
      msgKey,
      opts.chatJid,
      ts,
      opts.type,
      opts.text || null,
      opts.mediaPath || null,
      opts.mediaMime || null,
      opts.filename || null,
    ]
  );
  await bumpChatFromMessage(companyId, {
    chat_jid: opts.chatJid,
    ts,
    type: opts.type,
    text: opts.text,
    from_me: 1,
  });
  const wire = toWire(companyId, {
    msg_key: msgKey,
    chat_jid: opts.chatJid,
    from_me: 1,
    sender_jid: "me",
    ts,
    type: opts.type,
    text: opts.text,
    media_path: opts.mediaPath || null,
    media_mime: opts.mediaMime || null,
    filename: opts.filename || null,
    status: 1,
    quoted_key: null,
  });
  waEvents.emit("message", wire);
  waEvents.emit("chat", await getChat(companyId, opts.chatJid));
  return wire;
}

export async function attachMediaPath(
  companyId: number,
  msgKey: string,
  relPath: string,
  mime: string
) {
  await exec(
    "UPDATE wa_chat_messages SET media_path = ?, media_mime = ? WHERE company_id = ? AND msg_key = ?",
    [relPath, mime, companyId, msgKey]
  );
  waEvents.emit("message-update", { companyId, msgKey, hasMedia: true, mediaMime: mime });
}

export async function updateStatuses(companyId: number, updates: any[]): Promise<void> {
  for (const u of updates) {
    const key = u?.key;
    const st = u?.update?.status;
    if (!key?.id || st == null) continue;
    const msgKey = keyStr(key);
    await exec(
      "UPDATE wa_chat_messages SET status = GREATEST(status, ?) WHERE company_id = ? AND msg_key = ?",
      [Number(st), companyId, msgKey]
    );
    waEvents.emit("message-update", { companyId, msgKey, status: Number(st) });
  }
}

export async function updateReceipts(companyId: number, updates: any[]): Promise<void> {
  for (const u of updates) {
    const key = u?.key;
    const r = u?.receipt;
    if (!key?.id || !r) continue;
    const msgKey = keyStr(key);
    const st = r.readTimestamp ? 4 : r.receiptTimestamp ? 3 : null;
    if (st == null) continue;
    await exec(
      "UPDATE wa_chat_messages SET status = GREATEST(status, ?) WHERE company_id = ? AND msg_key = ?",
      [st, companyId, msgKey]
    );
    waEvents.emit("message-update", { companyId, msgKey, status: st });
  }
}

export async function listMessages(
  companyId: number,
  jid: string,
  before?: number,
  limit = 40
) {
  const params: any[] = [companyId, jid];
  let where = "company_id = ? AND chat_jid = ?";
  if (before) {
    where += " AND ts < ?";
    params.push(before);
  }
  params.push(limit);
  const rows = await query<any>(
    `SELECT msg_key, chat_jid, from_me, sender_jid, ts, type, text,
            media_path, media_mime, filename, status, quoted_key
     FROM wa_chat_messages
     WHERE ${where}
     ORDER BY ts DESC
     LIMIT ?`,
    params
  );
  return rows.map((r) => toWire(companyId, r)).reverse();
}

export async function markChatRead(companyId: number, jid: string) {
  await exec("UPDATE wa_chats SET unread_count = 0 WHERE company_id = ? AND jid = ?", [
    companyId,
    jid,
  ]);
  waEvents.emit("chat", await getChat(companyId, jid));
}

export async function getMessageRaw(companyId: number, msgKey: string) {
  const rows = await query<any>(
    "SELECT msg_key, chat_jid, raw, media_path, media_mime, filename FROM wa_chat_messages WHERE company_id = ? AND msg_key = ?",
    [companyId, msgKey]
  );
  return rows[0] || null;
}
