/**
 * Address book and wallet folders. Public addresses only: labels, a colour marker, bookmarks (shown first
 * when you withdraw or send tokens) and folders for your own wallets. Import and export as JSON or CSV.
 * Nothing here is a key.
 */
import { b58decode } from "../base58.js";
import { avatarFromString, avatarToString, validAvatar, type AvatarRef } from "./avatar.js";

export const MARKERS = ["none", "ice", "green", "red", "amber", "violet", "grey"] as const;
export type Marker = (typeof MARKERS)[number];

export interface BookEntry {
  address: string;
  label: string;
  marker: Marker;
  /** Bookmarked addresses are offered first in Withdraw and Send tokens. */
  bookmark: boolean;
  note?: string;
  addedAt?: string;
  /** Tracked: the wallet tracker follows its trades, and Pulse highlights coins it created (tracked dev). */
  track?: boolean;
  /** Your own KOL list: Pulse counts these among a coin's holders ("KOLs"). */
  kol?: boolean;
  /** Its picture: an uploaded image (re-encoded 64 / 128 px squares) or a generated avatar. None = the identicon. */
  avatar?: AvatarRef;
  /** One of your own wallets: this entry is its name (wallet/naming.ts). Never published. */
  own?: boolean;
}

/** Your tracked wallets and your KOL list, as lookup sets. */
export function bookSets(entries: BookEntry[] | undefined): { tracked: Set<string>; kols: Set<string> } {
  const es = entries ?? [];
  return { tracked: new Set(es.filter((e) => e.track).map((e) => e.address)), kols: new Set(es.filter((e) => e.kol).map((e) => e.address)) };
}

export interface WalletFolder {
  id: string;
  name: string;
  /** Your own wallets' public addresses. */
  wallets: string[];
}

export const isAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && b58decode(a)?.length === 32;

export function validateEntry(e: Partial<BookEntry>): string[] {
  const out: string[] = [];
  if (!e.address || !isAddress(e.address)) out.push(`"${e.address ?? ""}" isn't a Solana address.`);
  if (!e.label?.trim()) out.push("Give it a label.");
  else if (e.label.length > 40) out.push("Labels are up to 40 characters.");
  if (e.marker && !MARKERS.includes(e.marker)) out.push(`Marker is one of ${MARKERS.join(", ")}.`);
  if ((e.note ?? "").length > 200) out.push("Notes are up to 200 characters.");
  if (e.avatar !== undefined && !validAvatar(e.avatar)) out.push("That image reference isn't valid.");
  return out;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function exportBook(entries: BookEntry[], format: "json" | "csv"): string {
  if (format === "json") return JSON.stringify({ version: 1, entries }, null, 2);
  const head = "address,label,marker,bookmark,note,track,kol,avatar,own";
  const yn = (b: boolean | undefined) => (b ? "yes" : "no");
  return [head, ...entries.map((e) => [e.address, e.label, e.marker, yn(e.bookmark), e.note ?? "", yn(e.track), yn(e.kol), avatarToString(e.avatar), yn(e.own)].map(csvCell).join(","))].join("\n");
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** JSON ({entries:[…]} or a bare array) or CSV with a header row. Bad rows are reported, not dropped silently. */
export function importBook(text: string): { entries: BookEntry[]; errors: string[] } {
  const errors: string[] = [];
  let raw: Array<Omit<Partial<BookEntry>, "bookmark"> & { bookmark?: unknown }> = [];
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t) as unknown;
      raw = (Array.isArray(j) ? j : (j as { entries?: unknown[] }).entries ?? []) as typeof raw;
    } catch {
      return { entries: [], errors: ["That isn't valid JSON."] };
    }
  } else {
    const rows = parseCsv(t);
    const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (n: string) => head.indexOf(n);
    if (col("address") < 0) return { entries: [], errors: ["CSV needs a header row with at least: address,label"] };
    const yes = (v: string | undefined) => /^(yes|true|1)$/i.test(String(v ?? "").trim());
    raw = rows.map((r) => ({
      address: r[col("address")]?.trim(), label: (col("label") >= 0 ? r[col("label")] : "")?.trim(), marker: (col("marker") >= 0 ? r[col("marker")]?.trim() : "none") as Marker,
      bookmark: col("bookmark") >= 0 ? r[col("bookmark")] : "", note: col("note") >= 0 ? r[col("note")] || undefined : undefined,
      ...(col("track") >= 0 && yes(r[col("track")]) ? { track: true } : {}), ...(col("kol") >= 0 && yes(r[col("kol")]) ? { kol: true } : {}), ...(col("own") >= 0 && yes(r[col("own")]) ? { own: true } : {}),
      ...(col("avatar") >= 0 && r[col("avatar")]?.trim() ? { avatar: r[col("avatar")].trim() as unknown as AvatarRef } : {}),
    }));
  }
  const seen = new Set<string>();
  const entries: BookEntry[] = [];
  raw.forEach((r, i) => {
    const e: BookEntry = {
      address: String(r.address ?? "").trim(), label: String(r.label ?? "").trim() || `Address ${i + 1}`, marker: (MARKERS as readonly string[]).includes(String(r.marker)) ? (r.marker as Marker) : "none",
      bookmark: r.bookmark === true || /^(yes|true|1)$/i.test(String(r.bookmark ?? "")), note: r.note ? String(r.note).slice(0, 200) : undefined,
      ...((r as { track?: unknown }).track === true ? { track: true } : {}), ...((r as { kol?: unknown }).kol === true ? { kol: true } : {}),
      ...((r as { own?: unknown }).own === true ? { own: true } : {}),
    };
    // images: an object in JSON, "upload:<id>" / "gen:<style>:<seed>" in CSV. A bad reference is reported and dropped.
    const av = (r as { avatar?: unknown }).avatar;
    if (av !== undefined && av !== null && av !== "") {
      const ref = typeof av === "string" ? avatarFromString(av) : validAvatar(av) ? av : undefined;
      if (ref) e.avatar = ref;
      else errors.push(`Row ${i + 1}: image reference ignored (not valid).`);
    }
    const bad = validateEntry(e);
    if (bad.length) return void errors.push(`Row ${i + 1}: ${bad[0]}`);
    if (seen.has(e.address)) return void errors.push(`Row ${i + 1}: duplicate of an earlier row.`);
    seen.add(e.address);
    entries.push(e);
  });
  return { entries, errors };
}

/** Merge imported entries into a book (imported values win for the same address). */
export function mergeBook(book: BookEntry[], incoming: BookEntry[]): BookEntry[] {
  const m = new Map(book.map((e) => [e.address, e]));
  for (const e of incoming) m.set(e.address, { ...m.get(e.address), ...e });
  return [...m.values()];
}

/** Addresses for Withdraw / Send tokens: bookmarks first, then the rest, by label. */
export function withdrawTargets(book: BookEntry[]): BookEntry[] {
  return [...book].sort((a, b) => Number(b.bookmark) - Number(a.bookmark) || a.label.localeCompare(b.label));
}
