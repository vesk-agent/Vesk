/**
 * v26: pair discovery. pump.fun's CreateEvent carries the coin's `quote_mint` (DefiLlama's adapter notes it); the agent
 * and the hosted backend read it from create messages on the PumpPortal stream (or from decoded program logs) and keep
 * every quote mint they see. Each new one is described from chain (decimals, and the name / symbol from its metadata)
 * and merged into the registry as "Discovered" (pairs.ts mergeSeen). This is how the list becomes complete without
 * guessing: nothing is added that wasn't seen in a real create. A pair seen here is listed with its count (under its category when
 * the registry names it without a mint, else under Discovered), and goes through the same on-chain check (launch/mintcheck.ts) before it can be used. Excluded mints (ANSEM)
 * are never kept.
 *
 * TODO-verify: the field name PumpPortal uses for the quote mint on create messages. Every spelling below is accepted;
 * a message without one is a SOL-pair create.
 */
import { EXCLUDED_QUOTES, mergeSeen, PUMPFUN_PAIRS, type PairAsset } from "./pairs.js";

const WSOL = "So11111111111111111111111111111111111111112";
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The quote mint on a create message, or null for a SOL pair (or a message that doesn't carry one). */
export function quoteMintOf(m: Record<string, unknown>): string | null {
  for (const k of ["quoteMint", "quote_mint", "quoteTokenMint", "quote"]) {
    const v = m[k];
    if (typeof v === "string" && PUBKEY.test(v) && v !== WSOL) return v;
  }
  return null;
}

export interface SeenQuote { mint: string; at: number; count: number; symbol?: string; name?: string; decimals?: number }

export class PairDiscovery {
  private seen = new Map<string, SeenQuote>();
  constructor(private o: { describe?: (mint: string) => Promise<{ symbol?: string; name?: string; decimals?: number } | null>; onNew?: (s: SeenQuote) => void } = {}) {}
  /** Feed one create message. Returns the quote mint when it is new. */
  ingest(m: Record<string, unknown>, now = Date.now()): string | null {
    const q = quoteMintOf(m);
    if (!q || q in EXCLUDED_QUOTES) return null;
    const s = this.seen.get(q);
    if (s) { s.at = now; s.count++; return null; }
    const n: SeenQuote = { mint: q, at: now, count: 1 };
    this.seen.set(q, n);
    if (this.o.describe) void this.o.describe(q).then((d) => { if (d) Object.assign(n, d); this.o.onNew?.(n); }).catch(() => this.o.onNew?.(n));
    else this.o.onNew?.(n);
    return q;
  }
  list(): SeenQuote[] { return [...this.seen.values()].sort((a, b) => b.count - a.count); }
  load(list: SeenQuote[]) { for (const s of list) if (!(s.mint in EXCLUDED_QUOTES)) this.seen.set(s.mint, s); }
  /** The registry with what was seen merged in. */
  pairs(base: PairAsset[] = PUMPFUN_PAIRS): PairAsset[] { return mergeSeen(base, this.list()); }
}
