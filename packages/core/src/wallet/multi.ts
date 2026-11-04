/**
 * Multi-wallet helpers. Pure logic, no I/O, no signing.
 *
 *  - parseWalletImport: many private keys at once (one per line, CSV with labels, or JSON). Errors point
 *    at a line or entry number and NEVER include key material, so they're safe to show and log.
 *  - planFunding / planReturn: direct, transparent SOL transfers between the main wallet and your other
 *    wallets. Every transfer is a plain System Program transfer from A to B, visible on-chain.
 */
import { b58decode } from "../base58.js";
import type { Address } from "../types.js";

export interface WalletImportEntry {
  label?: string;
  /** Normalized 64-byte secret key. Hold briefly, encrypt, then zero it. */
  secret: Uint8Array;
  /** "line 3", "entry 2": where it came from, for messages. */
  where: string;
}

export interface WalletImportResult {
  entries: WalletImportEntry[];
  errors: Array<{ where: string; reason: string }>;
}

export const MAX_IMPORT = 100;

/** A 64-byte secret key from base58 or a JSON byte array (Solana CLI / Phantom export), else null. */
export function normalizeSecret(s: string): Uint8Array | null {
  const t = s.trim().replace(/^["']|["']$/g, "");
  if (!t) return null;
  if (t.startsWith("[")) {
    try {
      const a = JSON.parse(t) as unknown;
      if (Array.isArray(a) && a.length === 64 && a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Uint8Array.from(a as number[]);
    } catch { /* fall through */ }
    return null;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(t)) return null;
  const b = b58decode(t);
  return b && b.length === 64 ? b : null;
}

const looksLikeKey = (s: string) => /^\s*\[/.test(s) || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s.trim().replace(/^["']|["']$/g, ""));
const keyHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function parseWalletImport(text: string): WalletImportResult {
  const out: WalletImportResult = { entries: [], errors: [] };
  const seen = new Set<string>();
  const fail = (where: string, reason: string): void => void out.errors.push({ where, reason });
  const add = (secret: Uint8Array | null, where: string, label?: string): void => {
    if (!secret) return fail(where, "Not a valid 64-byte private key (base58 or JSON array).");
    const h = keyHex(secret);
    if (seen.has(h)) return fail(where, "Duplicate of an earlier key. Skipped.");
    if (out.entries.length >= MAX_IMPORT) return fail(where, `At most ${MAX_IMPORT} wallets per import.`);
    seen.add(h);
    out.entries.push({ secret, where, label: label?.trim().slice(0, 32) || undefined });
  };
  const t = text.trim();
  if (!t) return out;

  // JSON: one key as a byte array, a list of keys, or a list of { label, secretKey } objects.
  if (t.startsWith("[") || t.startsWith("{")) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      j = undefined;
    }
    if (j !== undefined) {
      if (Array.isArray(j) && j.length === 64 && j.every((n) => typeof n === "number")) {
        add(normalizeSecret(t), "entry 1");
        return out;
      }
      const list = Array.isArray(j) ? j : [j];
      list.forEach((item, i) => {
        const where = `entry ${i + 1}`;
        if (typeof item === "string") return add(normalizeSecret(item), where);
        if (Array.isArray(item)) return add(normalizeSecret(JSON.stringify(item)), where);
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const k = o.secretKey ?? o.privateKey ?? o.private_key ?? o.secret ?? o.key;
          const label = typeof (o.label ?? o.name) === "string" ? String(o.label ?? o.name) : undefined;
          return add(typeof k === "string" ? normalizeSecret(k) : Array.isArray(k) ? normalizeSecret(JSON.stringify(k)) : null, where, label);
        }
        return fail(where, "Unrecognized entry.");
      });
      return out;
    }
  }

  // Lines: "key", "label,key", "key,label" (comma, tab or semicolon). # comments and a header row are skipped.
  t.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const where = `line ${i + 1}`;
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("[")) return add(normalizeSecret(line), where);
    const cells = line.split(/[,\t;]/).map((c) => c.trim()).filter(Boolean);
    const keyCell = cells.find(looksLikeKey);
    if (!keyCell) {
      if (i === 0 && cells.some((c) => /key|secret|label|name/i.test(c))) return; // header
      return fail(where, "No private key found on this line.");
    }
    const label = cells.find((c) => c !== keyCell);
    add(normalizeSecret(keyCell), where, label);
  });
  return out;
}

export interface Transfer {
  from: Address;
  to: Address;
  sol: number;
}

const LAMPORT = 1e-9;
export const TRANSFER_FEE_SOL = 0.000005;
const floorLamports = (sol: number) => Math.floor(sol / LAMPORT + 1e-6) / 1e9;

/**
 * Fund wallets from the main wallet. "even" splits `totalSol` evenly (rounded down to the lamport);
 * "custom" uses `amounts` per address. Keeps `reserveSol` (plus fees) in the main wallet.
 */
export function planFunding(p: {
  main: Address;
  targets: Address[];
  mode: "even" | "custom";
  totalSol?: number;
  amounts?: Record<Address, number>;
  mainBalanceSol: number;
  reserveSol: number;
  /** Transfers per transaction (fees are per transaction). */
  perTx?: number;
}): { transfers: Transfer[]; totalSol: number; feeSol: number; errors: string[] } {
  const errors: string[] = [];
  const targets = [...new Set(p.targets)].filter((t) => t !== p.main);
  if (!targets.length) errors.push("Pick at least one wallet to fund (not the main wallet).");
  let transfers: Transfer[] = [];
  if (p.mode === "even") {
    const total = p.totalSol ?? 0;
    if (!(total > 0)) errors.push("Enter an amount above 0.");
    const each = targets.length ? floorLamports(total / targets.length) : 0;
    if (targets.length && total > 0 && each <= 0) errors.push("Amount is too small to split.");
    transfers = targets.map((to) => ({ from: p.main, to, sol: each }));
  } else {
    for (const to of targets) {
      const a = p.amounts?.[to] ?? 0;
      if (!(a > 0)) errors.push(`Enter an amount for ${to.slice(0, 4)}…${to.slice(-4)}.`);
      transfers.push({ from: p.main, to, sol: floorLamports(a) });
    }
  }
  const totalSol = transfers.reduce((a, t) => a + t.sol, 0);
  const feeSol = Math.ceil(transfers.length / (p.perTx ?? 8)) * TRANSFER_FEE_SOL;
  if (totalSol + feeSol + p.reserveSol > p.mainBalanceSol + 1e-12)
    errors.push(`Main wallet has ${p.mainBalanceSol.toFixed(4)} SOL. This needs ${(totalSol + feeSol).toFixed(4)} SOL plus your ${p.reserveSol} SOL reserve.`);
  return { transfers, totalSol, feeSol, errors };
}

/** Send everything back to the main wallet. Each wallet pays its own fee, so it sends balance minus the fee. */
export function planReturn(main: Address, wallets: Array<{ address: Address; balanceSol: number }>): Transfer[] {
  return wallets
    .filter((w) => w.address !== main && w.balanceSol > TRANSFER_FEE_SOL * 2)
    .map((w) => ({ from: w.address, to: main, sol: floorLamports(w.balanceSol - TRANSFER_FEE_SOL) }));
}
