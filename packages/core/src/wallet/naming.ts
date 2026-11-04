/**
 * Your own wallets' names. One registry: the address book (wallet/book.ts). An entry with `own: true` is the
 * name, colour tag, image and note of one of your wallets, the same entries v12.1 uses for any wallet.
 *
 * - Default names: "Main" for the main / trading wallet, "Wallet 1", "Wallet 2", … for the others, in registry
 *   order (the order the wallets were created or imported).
 * - "Team" is a role, not a name. A wallet is a team wallet only in a launch that used it as a disclosed team
 *   wallet; there it shows as "Wallet 2 · Team". Old stored names like "Team A" or "Team 1 (disclosed)" are
 *   dropped by the migration and the wallet gets its default name (its role stays on the launches that used it).
 * - Names are private. Launch disclosures publish addresses, never these names.
 */
import type { BookEntry } from "./book.js";

export interface OwnWallet { address: string; main: boolean; /** A name stored with the wallet before v12.2 (keystore / vault / agent report). */ label?: string }
export type LabelSource = "book" | "stored" | "default";

export const MAIN_LABEL = "Main";
export const isDefaultWalletLabel = (s: string) => /^(Main|Wallet \d+)$/.test(s.trim());
/** Names that were really a launch role: "Team", "Team A", "Team 2", "Team B (disclosed)". */
export const isLegacyRoleLabel = (s: string) => /^team(\s+([a-z]|\d+))?(\s*\(disclosed\))?$/i.test(s.trim());

/** "Main" for the main wallet, "Wallet n" for the n-th other wallet in registry order. */
export function defaultWalletLabels(ws: readonly OwnWallet[]): Map<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  for (const w of ws) out.set(w.address, w.main ? MAIN_LABEL : `Wallet ${++n}`);
  return out;
}

/** Each wallet's name and where it came from: the address book, else a custom stored name, else the default. */
export function ownWalletLabels(ws: readonly OwnWallet[], book: readonly BookEntry[] = []): Map<string, { label: string; source: LabelSource }> {
  const defs = defaultWalletLabels(ws);
  const byAddr = new Map(book.map((e) => [e.address, e]));
  const out = new Map<string, { label: string; source: LabelSource }>();
  for (const w of ws) {
    const e = byAddr.get(w.address);
    const stored = (w.label ?? "").trim();
    if (e?.label?.trim()) out.set(w.address, { label: e.label.trim(), source: "book" });
    else if (stored && !isDefaultWalletLabel(stored) && !isLegacyRoleLabel(stored)) out.set(w.address, { label: stored, source: "stored" });
    else out.set(w.address, { label: defs.get(w.address)!, source: "default" });
  }
  return out;
}

/** Apply the names to a wallet list (keeps every other field). */
export function withOwnLabels<T extends OwnWallet>(ws: readonly T[], book: readonly BookEntry[] = []): Array<T & { label: string }> {
  const m = ownWalletLabels(ws, book);
  return ws.map((w) => ({ ...w, label: m.get(w.address)!.label }));
}

/**
 * The migration: book entries to add so stored custom names move into the address book. Legacy role names
 * ("Team A") and default-looking names aren't moved (the wallet keeps its default name). Existing entries win.
 */
export function migrateOwnLabels(ws: readonly OwnWallet[], book: readonly BookEntry[]): BookEntry[] {
  const have = new Set(book.map((e) => e.address));
  return ws.filter((w) => !have.has(w.address) && w.label && !isDefaultWalletLabel(w.label) && !isLegacyRoleLabel(w.label))
    .map((w) => ({ address: w.address, label: w.label!.trim().slice(0, 40), marker: "none" as const, bookmark: false, own: true, addedAt: new Date(0).toISOString() }));
}

/**
 * Rename one of your wallets (address book entry with own: true). An empty name or the default name goes back to
 * the default: the entry is dropped unless it carries something else (image, note, colour tag).
 */
export function setOwnLabel(book: readonly BookEntry[], ws: readonly OwnWallet[], address: string, label: string): BookEntry[] {
  if (!ws.some((w) => w.address === address)) throw new Error("That isn't one of your wallets.");
  const name = label.trim();
  if (name.length > 40) throw new Error("Names are up to 40 characters.");
  const def = defaultWalletLabels(ws).get(address)!;
  const e = book.find((x) => x.address === address);
  const reset = !name || name === def;
  if (reset) {
    if (!e) return [...book];
    const keeps = e.avatar || e.note || (e.marker && e.marker !== "none") || e.track || e.kol || e.bookmark;
    return keeps ? book.map((x) => (x.address === address ? { ...x, label: def, own: true } : x)) : book.filter((x) => x.address !== address);
  }
  return e ? book.map((x) => (x.address === address ? { ...x, label: name, own: true } : x)) : [...book, { address, label: name, marker: "none", bookmark: false, own: true, addedAt: new Date().toISOString() }];
}

/** A wallet by address, by its default number ("2" → Wallet 2) or "main" / "0". */
export function resolveWalletRef(ws: readonly OwnWallet[], ref: string): string | null {
  const r = ref.trim();
  if (ws.some((w) => w.address === r)) return r;
  if (/^(main|0)$/i.test(r)) return ws.find((w) => w.main)?.address ?? null;
  if (/^\d+$/.test(r)) {
    const others = ws.filter((w) => !w.main);
    return others[Number(r) - 1]?.address ?? null;
  }
  return null;
}

/** "Wallet 2 · Team": the wallet's own name with its role in a launch. */
export const withRole = (label: string, role: "team") => `${label} · ${role === "team" ? "Team" : role}`;
