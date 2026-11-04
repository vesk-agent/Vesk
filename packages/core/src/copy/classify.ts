/**
 * What did the wallet just do? Classifies one transaction for one wallet into a buy or a sell.
 *
 * From the RPC (getTransaction, encoding jsonParsed, maxSupportedTransactionVersion 0):
 *  - the coin is the non-quote mint whose balance (owned by the wallet) changed the most, from pre/post token balances;
 *  - SOL in/out is the wallet's lamport change plus its wrapped-SOL change, with the network fee added back (fee payer)
 *    and new token-account rent taken out, so "their buy" is what went into the swap (pump.fun's 1% fee and any tip
 *    included);
 *  - the venue comes from the programs the transaction invoked (top level and inner instructions, plus log lines):
 *    a Jupiter route wins (the hops are listed), then pump.fun's curve, PumpSwap, LaunchLab, Raydium, Meteora, Orca.
 * From PumpPortal (subscribeAccountTrade): the message already says buy/sell, SOL, tokens, the new balance and the
 * market cap in SOL. pump.fun and Bonk trades only.
 *
 * Token-for-token swaps (no SOL or wrapped SOL moved) are not copied: they return a reason instead.
 */
import { QUOTE_MINTS } from "../data/programs.js";
import type { CopyVenue } from "./settings.js";

export type DetectSource = "pumpportal" | "rpc" | "helius" | "yellowstone" | "manual" | "relay";

export interface TargetTrade {
  signature: string;
  wallet: string;
  side: "buy" | "sell";
  mint: string;
  /** SOL they spent (buy) or received (sell), positive. */
  sol: number;
  /** Tokens bought or sold, positive. */
  tokens: number;
  /** Their balance of the coin before and after, when known. */
  tokensBefore?: number;
  tokensAfter?: number;
  /** Sells: the % of their holding they sold (0-100), when known. */
  sellPct?: number;
  venue: CopyVenue;
  /** Jupiter routes: the venues it went through. */
  route?: CopyVenue[];
  slot?: number;
  /** Block time from the chain (1 s resolution). */
  blockTimeMs?: number;
  /** Market cap in SOL at their trade (PumpPortal gives it; the RPC path computes it from their fill price × supply). */
  mcapSol?: number;
  /** Their fill price, SOL per token. */
  priceSol?: number;
  source: DetectSource;
  /** When Vesk saw it (ms, local clock). */
  detectedAt: number;
  symbol?: string;
  name?: string;
  pool?: string;
}

const WSOL = "So11111111111111111111111111111111111111112";
/** Rent of a new SPL token account (165 bytes), lamports. */
export const TOKEN_ACCOUNT_RENT = 2_039_280;

/** Program IDs → venue. Same sources as data/programs.ts; Jupiter v6 from Jupiter's docs. */
export const VENUE_PROGRAMS: Record<string, CopyVenue> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pumpfun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "launchlab",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "meteora",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "meteora",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "meteora",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca",
};
const VENUE_ORDER: CopyVenue[] = ["pumpfun", "pumpswap", "launchlab", "raydium", "meteora", "orca"];

type Key = string | { pubkey: string; signer?: boolean };
type TokenBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { amount?: string; decimals?: number; uiAmount?: number | null; uiAmountString?: string } };
type Ix = { programId?: string; programIdIndex?: number };
export interface ParsedTx {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown; fee?: number; preBalances?: number[]; postBalances?: number[];
    preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[];
    innerInstructions?: Array<{ index: number; instructions: Ix[] }>; logMessages?: string[];
  } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: Key[]; instructions?: Ix[] } };
}

export type Classified = { ok: true; trade: TargetTrade } | { ok: false; reason: string };

const keyOf = (k: Key) => (typeof k === "string" ? k : k.pubkey);
const ui = (b: TokenBal) => {
  const u = b.uiTokenAmount;
  if (!u) return 0;
  if (u.uiAmountString !== undefined) return Number(u.uiAmountString);
  if (u.uiAmount !== undefined && u.uiAmount !== null) return u.uiAmount;
  return Number(u.amount ?? 0) / 10 ** (u.decimals ?? 0);
};

/** Programs the transaction invoked, in order of first appearance. */
export function invokedPrograms(tx: ParsedTx): string[] {
  const keys = (tx.transaction?.message?.accountKeys ?? []).map(keyOf);
  const out: string[] = [];
  const add = (p?: string) => { if (p && !out.includes(p)) out.push(p); };
  const pid = (ix: Ix) => ix.programId ?? (ix.programIdIndex !== undefined ? keys[ix.programIdIndex] : undefined);
  const outer = tx.transaction?.message?.instructions ?? [];
  const inner = tx.meta?.innerInstructions ?? [];
  outer.forEach((ix, i) => { add(pid(ix)); for (const g of inner.filter((x) => x.index === i)) for (const j of g.instructions) add(pid(j)); });
  for (const l of tx.meta?.logMessages ?? []) { const m = /^Program (\w{32,44}) invoke/.exec(l); if (m) add(m[1]); }
  return out;
}

/** The venue a transaction traded on, and for Jupiter the hops. */
export function venueOf(tx: ParsedTx): { venue: CopyVenue; route?: CopyVenue[] } {
  const progs = invokedPrograms(tx).map((p) => VENUE_PROGRAMS[p]).filter(Boolean) as CopyVenue[];
  if (progs.includes("jupiter")) return { venue: "jupiter", route: [...new Set(progs.filter((v) => v !== "jupiter"))] };
  for (const v of VENUE_ORDER) if (progs.includes(v)) return { venue: v };
  return { venue: "unknown" };
}

/** Classify a jsonParsed transaction for `wallet`. */
export function classifyTx(tx: ParsedTx | null | undefined, wallet: string, detectedAt = Date.now(), source: DetectSource = "rpc"): Classified {
  if (!tx?.meta || !tx.transaction?.message) return { ok: false, reason: "transaction not readable yet" };
  if (tx.meta.err) return { ok: false, reason: "transaction failed on chain" };
  const keys = (tx.transaction.message.accountKeys ?? []).map(keyOf);
  const wi = keys.indexOf(wallet);
  const signature = tx.transaction.signatures?.[0] ?? "";
  // Token changes owned by the wallet, per mint.
  const pre = (tx.meta.preTokenBalances ?? []).filter((b) => b.owner === wallet);
  const post = (tx.meta.postTokenBalances ?? []).filter((b) => b.owner === wallet);
  const mints = new Set([...pre, ...post].map((b) => b.mint));
  const delta = new Map<string, { before: number; after: number; newAccounts: number }>();
  for (const m of mints) {
    const b = pre.filter((x) => x.mint === m);
    const a = post.filter((x) => x.mint === m);
    const preIdx = new Set(b.map((x) => x.accountIndex));
    delta.set(m, { before: b.reduce((s, x) => s + ui(x), 0), after: a.reduce((s, x) => s + ui(x), 0), newAccounts: a.filter((x) => !preIdx.has(x.accountIndex)).length });
  }
  if (wi < 0 && !mints.size) return { ok: false, reason: "wallet isn't in this transaction" };
  let lamports = wi >= 0 ? (tx.meta.postBalances?.[wi] ?? 0) - (tx.meta.preBalances?.[wi] ?? 0) : 0;
  if (wi === 0) lamports += tx.meta.fee ?? 0; // the fee payer: the network fee isn't part of the trade
  const wsol = delta.get(WSOL);
  let sol = lamports / 1e9 + (wsol ? wsol.after - wsol.before : 0);
  // The coin: biggest non-quote change.
  let coin: string | undefined;
  let best = 0;
  for (const [m, d] of delta) {
    if (QUOTE_MINTS[m]) continue;
    const ch = Math.abs(d.after - d.before);
    if (ch > best) { best = ch; coin = m; }
  }
  if (!coin || best <= 0) return { ok: false, reason: "no coin balance changed (transfer or other instruction)" };
  const d = delta.get(coin)!;
  const bought = d.after > d.before;
  // New token accounts' rent isn't spent on the coin (closing them gives it back).
  if (bought && d.newAccounts) sol += (d.newAccounts * TOKEN_ACCOUNT_RENT) / 1e9;
  if (!bought && d.after === 0 && pre.some((x) => x.mint === coin) && !post.some((x) => x.mint === coin)) sol -= TOKEN_ACCOUNT_RENT / 1e9; // closed the account after selling
  const usdIn = [...delta].some(([m, x]) => QUOTE_MINTS[m] && m !== WSOL && Math.abs(x.after - x.before) > 0);
  if (Math.abs(sol) < 1e-6) return { ok: false, reason: usdIn ? "stablecoin swap, not SOL (not copied)" : "token-for-token swap (no SOL moved)" };
  if (bought && sol > 0) return { ok: false, reason: "received tokens and SOL together (not a buy)" };
  if (!bought && sol < 0) return { ok: false, reason: "sent tokens and SOL together (not a sell)" };
  const tokens = Math.abs(d.after - d.before);
  const v = venueOf(tx);
  const absSol = +Math.abs(sol).toFixed(9);
  return {
    ok: true,
    trade: {
      signature, wallet, side: bought ? "buy" : "sell", mint: coin, sol: absSol, tokens, tokensBefore: d.before, tokensAfter: d.after,
      ...(bought ? {} : { sellPct: d.before > 0 ? Math.min(100, +((tokens / d.before) * 100).toFixed(2)) : undefined }),
      venue: v.venue, ...(v.route ? { route: v.route } : {}), slot: tx.slot, blockTimeMs: tx.blockTime ? tx.blockTime * 1000 : undefined,
      priceSol: tokens > 0 ? absSol / tokens : undefined, source, detectedAt,
    },
  };
}

/** PumpPortal account-trade message (subscribeAccountTrade). */
export interface AccountTradeMsg {
  signature?: string; mint?: string; traderPublicKey?: string; txType?: string; tokenAmount?: number; solAmount?: number;
  newTokenBalance?: number; marketCapSol?: number; pool?: string; name?: string; symbol?: string;
}

export function fromPumpPortal(m: AccountTradeMsg, detectedAt = Date.now()): TargetTrade | null {
  if (!m?.mint || !m.traderPublicKey || !m.signature || (m.txType !== "buy" && m.txType !== "sell")) return null;
  const tokens = Math.abs(m.tokenAmount ?? 0);
  const after = m.newTokenBalance !== undefined ? Math.max(0, m.newTokenBalance) : undefined;
  const before = after === undefined ? undefined : m.txType === "buy" ? Math.max(0, after - tokens) : after + tokens;
  const sol = Math.abs(m.solAmount ?? 0);
  const pool = m.pool ?? "pump";
  return {
    signature: m.signature, wallet: m.traderPublicKey, side: m.txType, mint: m.mint, sol, tokens, tokensBefore: before, tokensAfter: after,
    ...(m.txType === "sell" && before !== undefined ? { sellPct: before > 0 ? Math.min(100, +((tokens / before) * 100).toFixed(2)) : 100 } : {}),
    venue: pool === "pump-amm" ? "pumpswap" : pool === "bonk" || pool === "launchlab" ? "launchlab" : pool === "raydium" ? "raydium" : "pumpfun",
    mcapSol: m.marketCapSol, priceSol: tokens > 0 ? sol / tokens : undefined, source: "pumpportal", detectedAt, symbol: m.symbol, name: m.name, pool,
  };
}
