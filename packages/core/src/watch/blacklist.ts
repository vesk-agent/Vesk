/**
 * Your blacklist: wallets, devs, contract addresses and funding wallets you never want to see or buy.
 * Shared by the panel and the agent:
 *  - Pulse and the tracker hide matching coins and posts (`blacklistHit`),
 *  - every buy is refused by the guardrails when the coin, its dev or its dev's funder is listed (guardrails.ts),
 *  - rules skip matching signals (agent.ts → onSignal).
 * Saved per account; a paired agent pulls it with your rules. Import/export is plain JSON or one address per line.
 */
import { isPubkey } from "../base58.js";

export type BlacklistKind = "wallets" | "devs" | "mints" | "funders";
export const BLACKLIST_KINDS: BlacklistKind[] = ["mints", "devs", "funders", "wallets"];
export const BLACKLIST_LABEL: Record<BlacklistKind, string> = { mints: "Contract addresses", devs: "Devs", funders: "Funding wallets", wallets: "Wallets" };
export const BLACKLIST_MAX = 5000;

export interface BlacklistEntry { address: string; note?: string; addedAt?: string }
export type Blacklist = Record<BlacklistKind, BlacklistEntry[]>;

export const emptyBlacklist = (): Blacklist => ({ wallets: [], devs: [], mints: [], funders: [] });

/** Keep only valid, unique Solana addresses, at most BLACKLIST_MAX per kind. */
export function normalizeBlacklist(x: unknown): Blacklist {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const out = emptyBlacklist();
  for (const k of BLACKLIST_KINDS) {
    const seen = new Set<string>();
    const list = Array.isArray(o[k]) ? (o[k] as unknown[]) : [];
    for (const e of list) {
      const a = typeof e === "string" ? { address: e } : (e as BlacklistEntry);
      const addr = String(a?.address ?? "").trim();
      if (!isPubkey(addr) || seen.has(addr)) continue;
      seen.add(addr);
      out[k].push({ address: addr, ...(a.note ? { note: String(a.note).slice(0, 120) } : {}), ...(a.addedAt ? { addedAt: String(a.addedAt) } : {}) });
      if (out[k].length >= BLACKLIST_MAX) break;
    }
  }
  return out;
}

/** Fast lookup sets. Build once per render / per check batch. */
export interface BlacklistIndex { wallets: Set<string>; devs: Set<string>; mints: Set<string>; funders: Set<string>; size: number }
export function indexBlacklist(b: Blacklist | undefined): BlacklistIndex {
  const s = (k: BlacklistKind) => new Set((b?.[k] ?? []).map((e) => e.address));
  const i = { wallets: s("wallets"), devs: s("devs"), mints: s("mints"), funders: s("funders"), size: 0 };
  i.size = i.wallets.size + i.devs.size + i.mints.size + i.funders.size;
  return i;
}

/** Why a coin (or a trader) is blacklisted, or null. A dev counts in "devs" and in "wallets". */
export function blacklistHit(i: BlacklistIndex, x: { mint?: string; dev?: string; funder?: string; wallet?: string }): string | null {
  if (!i.size) return null;
  if (x.mint && i.mints.has(x.mint)) return "the contract address is on your blacklist";
  if (x.dev && (i.devs.has(x.dev) || i.wallets.has(x.dev))) return "the dev is on your blacklist";
  if (x.funder && (i.funders.has(x.funder) || i.wallets.has(x.funder))) return "the dev's funding wallet is on your blacklist";
  if (x.wallet && i.wallets.has(x.wallet)) return "the wallet is on your blacklist";
  return null;
}

export function addToBlacklist(b: Blacklist, kind: BlacklistKind, address: string, note?: string, now = new Date()): Blacklist {
  if (!isPubkey(address)) throw new Error("That isn't a Solana address.");
  if (b[kind].some((e) => e.address === address)) return b;
  return { ...b, [kind]: [...b[kind], { address, ...(note ? { note } : {}), addedAt: now.toISOString() }] };
}

export function removeFromBlacklist(b: Blacklist, kind: BlacklistKind, address: string): Blacklist {
  return { ...b, [kind]: b[kind].filter((e) => e.address !== address) };
}

export const exportBlacklist = (b: Blacklist) => JSON.stringify({ version: 1, ...b }, null, 2);

/**
 * Import: a JSON export, or plain text with one address per line (optionally "kind,address[,note]").
 * Plain addresses go to `defaultKind`. Returns the merged list and how many were added.
 */
export function importBlacklist(text: string, base: Blacklist, defaultKind: BlacklistKind = "mints"): { list: Blacklist; added: number } {
  const t = text.trim();
  let incoming: Blacklist;
  if (t.startsWith("{")) {
    try { incoming = normalizeBlacklist(JSON.parse(t)); } catch { throw new Error("That isn't valid JSON."); }
  } else {
    incoming = emptyBlacklist();
    for (const line of t.split(/\r?\n/)) {
      const parts = line.split(",").map((x) => x.trim()).filter(Boolean);
      if (!parts.length) continue;
      const kind = (BLACKLIST_KINDS as string[]).includes(parts[0]) ? (parts.shift() as BlacklistKind) : defaultKind;
      const [address, note] = parts;
      if (isPubkey(address ?? "")) incoming[kind].push({ address, ...(note ? { note } : {}) });
    }
  }
  const before = BLACKLIST_KINDS.reduce((n, k) => n + base[k].length, 0);
  const merged = normalizeBlacklist(Object.fromEntries(BLACKLIST_KINDS.map((k) => [k, [...base[k], ...incoming[k]]])));
  const after = BLACKLIST_KINDS.reduce((n, k) => n + merged[k].length, 0);
  return { list: merged, added: after - before };
}
