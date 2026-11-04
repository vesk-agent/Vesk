/**
 * Coin page numbers computed from the trades we actually have (a window of recent public trades, or the live
 * stream). Pure. Nothing here is estimated beyond what the trades show; where a wallet sold tokens it bought before
 * the window, that sell is marked partial and its cost isn't invented.
 *
 *  - stats5m: volume, buys, sells and net flow over the last five minutes.
 *  - topTraders: realized PnL per wallet (average cost), bought / sold, still holding.
 *  - earlyBuyers: the first N distinct buyers and whether they still hold.
 *  - taxBreakdown: protocol fee + creator fee + any Token-2022 transfer fee = what a trade costs.
 */
import { BLOCK_WINDOW_MS } from "../watch/pulse.js";
import { bundledWallets, insiderWallets, isSniper, type LinkCtx } from "../watch/audits.js";

export interface TradeLite { at: number; side: "buy" | "sell"; wallet: string; sol: number; tokens: number }

export interface Stats5m { volSol: number; buys: number; sells: number; buySol: number; sellSol: number; netSol: number }
export function stats5m(trades: TradeLite[], now = Date.now(), windowMs = 300_000): Stats5m {
  const s: Stats5m = { volSol: 0, buys: 0, sells: 0, buySol: 0, sellSol: 0, netSol: 0 };
  for (const t of trades) {
    if (t.at < now - windowMs || t.at > now + 60_000) continue;
    s.volSol += t.sol;
    if (t.side === "buy") { s.buys++; s.buySol += t.sol; } else { s.sells++; s.sellSol += t.sol; }
  }
  s.netSol = s.buySol - s.sellSol;
  return s;
}

export interface TraderRow {
  wallet: string;
  buys: number;
  sells: number;
  boughtSol: number;
  soldSol: number;
  /** Tokens bought minus sold inside the window (can't see earlier buys). */
  netTokens: number;
  /** Realized PnL on sells whose cost we saw (average cost). */
  realizedSol: number;
  /** Value of the tokens still held from the window, at `priceSol`. */
  unrealizedSol: number;
  /** Realized PnL plus the gain on what's still held (value minus its average cost). */
  pnlSol: number;
  /** Sold more than it bought inside the window: part of the realized PnL is unknown. */
  partial: boolean;
}

export function topTraders(trades: TradeLite[], priceSol: number, limit = 25): TraderRow[] {
  const by = new Map<string, TraderRow & { held: number; cost: number }>();
  for (const t of [...trades].sort((a, b) => a.at - b.at)) {
    if (!t.wallet) continue;
    let r = by.get(t.wallet);
    if (!r) { r = { wallet: t.wallet, buys: 0, sells: 0, boughtSol: 0, soldSol: 0, netTokens: 0, realizedSol: 0, unrealizedSol: 0, pnlSol: 0, partial: false, held: 0, cost: 0 }; by.set(t.wallet, r); }
    if (t.side === "buy") {
      r.buys++; r.boughtSol += t.sol; r.held += t.tokens; r.cost += t.sol; r.netTokens += t.tokens;
    } else {
      r.sells++; r.soldSol += t.sol; r.netTokens -= t.tokens;
      const matched = Math.min(t.tokens, r.held);
      if (matched < t.tokens) r.partial = true;
      if (matched > 0 && t.tokens > 0) {
        const avg = r.cost / r.held;
        const proceeds = t.sol * (matched / t.tokens);
        r.realizedSol += proceeds - avg * matched;
        r.cost -= avg * matched;
        r.held -= matched;
      }
    }
  }
  return [...by.values()]
    .map(({ held, cost, ...r }) => ({ ...r, realizedSol: round(r.realizedSol), unrealizedSol: round(held * priceSol), pnlSol: round(r.realizedSol + held * priceSol - cost), boughtSol: round(r.boughtSol), soldSol: round(r.soldSol) }))
    .sort((a, b) => b.pnlSol - a.pnlSol)
    .slice(0, limit);
}

export interface EarlyBuyer { rank: number; wallet: string; firstAt: number; boughtSol: number; boughtTokens: number; soldTokens: number; holdingTokens?: number; status: "holding" | "sold some" | "sold all" | "unknown" }
/**
 * First N distinct buyers, oldest first. `holdings` (owner → tokens, from the RPC) is the source of truth for
 * "still holding" when given; otherwise it's read from the trades (and says unknown when they can't tell).
 */
export function earlyBuyers(trades: TradeLite[], n = 20, holdings?: Map<string, number>): EarlyBuyer[] {
  const sorted = [...trades].sort((a, b) => a.at - b.at);
  const out: EarlyBuyer[] = [];
  const seen = new Map<string, EarlyBuyer>();
  for (const t of sorted) {
    let e = seen.get(t.wallet);
    if (!e && t.side === "buy" && out.length < n) {
      e = { rank: out.length + 1, wallet: t.wallet, firstAt: t.at, boughtSol: 0, boughtTokens: 0, soldTokens: 0, status: "holding" };
      seen.set(t.wallet, e);
      out.push(e);
    }
    if (!e) continue;
    if (t.side === "buy") { e.boughtSol += t.sol; e.boughtTokens += t.tokens; } else e.soldTokens += t.tokens;
  }
  for (const e of out) {
    e.boughtSol = round(e.boughtSol);
    const h = holdings?.get(e.wallet);
    if (holdings) {
      e.holdingTokens = h ?? 0;
      e.status = !h ? "sold all" : h < e.boughtTokens * 0.98 ? "sold some" : "holding";
    } else {
      const left = e.boughtTokens - e.soldTokens;
      e.status = e.soldTokens === 0 ? "holding" : left <= e.boughtTokens * 0.02 ? "sold all" : "sold some";
    }
  }
  return out;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- Early buyers labels (shared with the Pulse audits)

export type BuyerLabel = "dev" | "team" | "you" | "tracked" | "sniper" | "bundled" | "insider";
export interface BuyerLabelCtx {
  /** When the coin was created (ms). */
  createdAt: number;
  dev?: string;
  /** Team wallets disclosed at launch. */
  team?: string[];
  /** Your own wallets. */
  own?: string[];
  /** Wallets from your address book. */
  tracked?: string[];
  /** wallet → funding source (sender of its first SOL), when known. */
  funding?: Record<string, string>;
  /** Creation block window when slots aren't known (ms). Defaults to Pulse's BLOCK_WINDOW_MS. */
  blockWindowMs?: number;
  /** v19: this coin's curve / pool accounts and program-owned funders: never links (watch/audits.ts linkableFunding). */
  link?: LinkCtx;
}
export interface BuyerLabels {
  labels: BuyerLabel[];
  /** False when "bundled" was decided without funding data (every creation-block buyer counts: an upper bound). */
  bundledExact: boolean;
  /** False when insiders couldn't be checked (no funding data). */
  insiderKnown: boolean;
}

/**
 * Labels for the coin page's Early buyers, with the same definitions as the Pulse audits (watch/audits.ts):
 *  - sniper: not the dev, first buy within SNIPER_WINDOW_MS (3 s) of the create;
 *  - bundled: bought in the creation block (within the block window of the create) together with the dev or with
 *    wallets funded from the same source (needs funding data; otherwise every block buyer, marked not exact);
 *  - insider: funded by the dev, the dev's funder, or the same source as another early buyer (needs funding data);
 *  - dev, team (disclosed at launch), you (your wallets), tracked (your address book).
 */
export function earlyBuyerLabels(early: EarlyBuyer[], ctx: BuyerLabelCtx): Map<string, BuyerLabels> {
  const win = ctx.blockWindowMs ?? BLOCK_WINDOW_MS;
  const team = new Set(ctx.team ?? []), own = new Set(ctx.own ?? []), tracked = new Set(ctx.tracked ?? []);
  const block = early.filter((e) => e.firstAt - ctx.createdAt <= win).map((e) => e.wallet);
  const bundled = bundledWallets(block, ctx.dev, ctx.funding, ctx.link);
  const insiders = insiderWallets(early.map((e) => e.wallet), ctx.dev, ctx.funding, ctx.link);
  const out = new Map<string, BuyerLabels>();
  for (const e of early) {
    const l: BuyerLabel[] = [];
    if (e.wallet === ctx.dev) l.push("dev");
    if (team.has(e.wallet)) l.push("team");
    if (own.has(e.wallet)) l.push("you");
    if (tracked.has(e.wallet)) l.push("tracked");
    if (isSniper(e.wallet, e.firstAt, ctx.createdAt, ctx.dev)) l.push("sniper");
    if (bundled.wallets.has(e.wallet) && e.wallet !== ctx.dev) l.push("bundled");
    if (insiders?.has(e.wallet)) l.push("insider");
    out.set(e.wallet, { labels: l, bundledExact: bundled.exact, insiderKnown: insiders !== null });
  }
  return out;
}

// ---------------------------------------------------------------- one wallet's trades (the coin page's "View trades")

export interface WalletSummary {
  wallet: string;
  buys: number;
  sells: number;
  boughtSol: number;
  soldSol: number;
  boughtTokens: number;
  soldTokens: number;
  firstBuyAt?: number;
  lastSellAt?: number;
  /** Average entry price (SOL per token) over the buys we have. */
  avgEntrySol?: number;
  /** Realized PnL on average cost, over the sells we can match to buys we have. */
  realizedSol: number;
  /** Tokens still held according to these trades (never below zero). */
  holdingTokens: number;
  /** A sell bigger than the buys we saw: the wallet bought before the loaded trades. */
  partial: boolean;
}
export function walletSummary(trades: TradeLite[], wallet: string): WalletSummary {
  const s: WalletSummary = { wallet, buys: 0, sells: 0, boughtSol: 0, soldSol: 0, boughtTokens: 0, soldTokens: 0, realizedSol: 0, holdingTokens: 0, partial: false };
  let held = 0, cost = 0;
  for (const t of trades.filter((x) => x.wallet === wallet).sort((a, b) => a.at - b.at)) {
    if (t.side === "buy") {
      s.buys++; s.boughtSol += t.sol; s.boughtTokens += t.tokens; held += t.tokens; cost += t.sol;
      if (s.firstBuyAt === undefined) s.firstBuyAt = t.at;
    } else {
      s.sells++; s.soldSol += t.sol; s.soldTokens += t.tokens; s.lastSellAt = t.at;
      const matched = Math.min(t.tokens, held);
      if (matched < t.tokens) s.partial = true;
      if (matched > 0 && t.tokens > 0) {
        const avg = cost / held;
        s.realizedSol += t.sol * (matched / t.tokens) - avg * matched;
        cost -= avg * matched; held -= matched;
      }
    }
  }
  return { ...s, boughtSol: round(s.boughtSol), soldSol: round(s.soldSol), realizedSol: round(s.realizedSol), holdingTokens: Math.max(0, held), avgEntrySol: s.boughtTokens > 0 ? s.boughtSol / s.boughtTokens : undefined };
}
