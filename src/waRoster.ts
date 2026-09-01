/**
 * Per-company client roster: the ONLY WhatsApp JIDs a company's inbox cares
 * about. Built from company_clients ⋈ clients (their phone numbers). Everything
 * else Baileys reports for that account is ignored.
 *
 * Call refreshRoster(companyId) on connect and whenever a client is added/edited
 * for that company.
 */
import { query } from "./db";

/** 10-digit -> +91; already-CC numbers used as-is. Returns null if unusable. */
export function phoneToJid(raw: string | null | undefined): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const withCc = digits.length === 10 ? "91" + digits : digits;
  return `${withCc}@s.whatsapp.net`;
}

export interface RosterClient {
  clientId: number;
  name: string;
  phone: string | null;
  jid: string;
}

// companyId -> (jid -> RosterClient)
const rosters = new Map<number, Map<string, RosterClient>>();

export async function refreshRoster(companyId: number): Promise<Map<string, RosterClient>> {
  const rows = await query<{ id: number; name: string; phone: string | null }>(
    `SELECT c.id, c.name, c.phone
     FROM company_clients cc
     JOIN clients c ON c.id = cc.client_id
     WHERE cc.company_id = ?`,
    [companyId]
  );
  const map = new Map<string, RosterClient>();
  for (const r of rows) {
    const jid = phoneToJid(r.phone);
    if (!jid) continue;
    // last write wins if two clients share a number — fine for our purposes
    map.set(jid, { clientId: r.id, name: r.name, phone: r.phone, jid });
  }
  rosters.set(companyId, map);
  return map;
}

export function getRoster(companyId: number): Map<string, RosterClient> {
  return rosters.get(companyId) ?? new Map();
}

/** Is this JID one of the company's clients? Group JIDs are always false. */
export function inRoster(companyId: number, jid: string): boolean {
  if (!jid || jid.endsWith("@g.us")) return false;
  return getRoster(companyId).has(jid);
}

export function rosterClient(companyId: number, jid: string): RosterClient | undefined {
  return getRoster(companyId).get(jid);
}
