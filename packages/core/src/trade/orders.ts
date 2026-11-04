/**
 * Trade orders: what `vesk order …`, the coin page (Limit / Adv.) and chat can create. Pure: the agent's order
 * loop and the hosted tick call these, and every fill still goes through the executor's guardrails and limits.
 *
 *   limit-buy   buy when the price (or market cap) falls to a target
 *   limit-sell  sell when the price (or market cap) rises to a target
 *   stop-loss   sell when the price (or market cap) falls to a level
 *   trailing    sell when the price falls trailPct below the highest price seen since the order was placed
 *   dca         split a total into slices, one every interval, optionally only while the market cap is in a band
 *   twap        spread a total evenly (or by your own weights) over a duration, on a fixed schedule
 *   dev-sell    buy (or sell) the moment the coin's dev wallet sells, seen on the live trade stream
 *
 * Migration buys and sells are their own orders (watch/migration.ts). There is no order type that trades from
 * several wallets, splits a buy across wallets, or trades against yourself: those aren't expressible here.
 */
import type { MarketSnapshot, Order, OrderSlice } from "../types.js";

export const ORDER_MIN_INTERVAL_SEC = 2;
export const TWAP_MAX_SLICES = 100;
export const TWAP_MAX_DURATION_SEC = 7 * 86_400;

type Mkt = Pick<MarketSnapshot, "mint" | "priceSol"> & Partial<Pick<MarketSnapshot, "mcapUsd">>;
export type OrderFire = { order: Order; action: "buy" | "sell"; amountSol?: number; sellPct?: number; slice?: number };

const roundSol = (v: number) => Math.round(v * 1e9) / 1e9;
const isB58 = (s: unknown) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const sideOf = (o: Order): "buy" | "sell" => o.side ?? (o.kind === "limit-sell" || o.kind === "stop-loss" || o.kind === "trailing" ? "sell" : "buy");
const intervalMs = (o: Order) => (o.intervalSec ?? (o.intervalMin ?? 60) * 60) * 1000;

/** A price trigger: `priceSol` when set, else the market cap in USD (needs a snapshot with mcapUsd). */
function crossed(o: Order, m: Mkt, dir: "below" | "above"): boolean {
  if (o.priceSol !== undefined) return dir === "below" ? m.priceSol <= o.priceSol : m.priceSol >= o.priceSol;
  if (o.atMcapUsd !== undefined && m.mcapUsd !== undefined) return dir === "below" ? m.mcapUsd <= o.atMcapUsd : m.mcapUsd >= o.atMcapUsd;
  return false;
}
/** DCA band: true when there's no band, or the market cap is inside it. Unknown market cap with a band = wait. */
export function inBand(o: Pick<Order, "minMcapUsd" | "maxMcapUsd">, mcapUsd?: number): boolean {
  if (o.minMcapUsd === undefined && o.maxMcapUsd === undefined) return true;
  if (mcapUsd === undefined) return false;
  return (o.minMcapUsd === undefined || mcapUsd >= o.minMcapUsd) && (o.maxMcapUsd === undefined || mcapUsd <= o.maxMcapUsd);
}

/** The highest price a trailing order has seen, updated with this tick. Returns the same order when unchanged. */
export function notePrice(o: Order, priceSol: number): Order {
  if (o.kind !== "trailing" || o.status !== "open") return o;
  return priceSol > (o.peakPriceSol ?? 0) ? { ...o, peakPriceSol: priceSol } : o;
}

/** Orders that should fire at this price and time. Dev-sell orders never fire here (see matchDevSell). */
export function evaluateOrders(orders: Order[], market: Mkt, now = Date.now()): OrderFire[] {
  const out: OrderFire[] = [];
  for (const o of orders) {
    if (o.status !== "open" || o.mint !== market.mint) continue;
    switch (o.kind) {
      case "limit-buy":
        if (crossed(o, market, "below")) out.push({ order: o, action: "buy", amountSol: o.amountSol });
        break;
      case "limit-sell":
        if (crossed(o, market, "above")) out.push({ order: o, action: "sell", sellPct: o.sellPct ?? 100 });
        break;
      case "stop-loss":
        if (crossed(o, market, "below")) out.push({ order: o, action: "sell", sellPct: o.sellPct ?? 100 });
        break;
      case "trailing": {
        const peak = Math.max(o.peakPriceSol ?? market.priceSol, market.priceSol);
        if (o.trailPct && market.priceSol <= peak * (1 - o.trailPct / 100)) out.push({ order: o, action: "sell", sellPct: o.sellPct ?? 100 });
        break;
      }
      case "dca":
        if ((o.remaining ?? 0) > 0 && (o.nextAt ?? 0) <= now && inBand(o, market.mcapUsd)) {
          out.push(sideOf(o) === "buy" ? { order: o, action: "buy", amountSol: o.amountSol } : { order: o, action: "sell", sellPct: o.sellPct });
        }
        break;
      case "twap": {
        const i = (o.schedule ?? []).findIndex((s) => !s.done);
        const s = i >= 0 ? o.schedule![i] : undefined;
        if (s && s.at <= now) out.push(sideOf(o) === "buy" ? { order: o, action: "buy", amountSol: s.amountSol, slice: i } : { order: o, action: "sell", sellPct: s.sellPct, slice: i });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** A trade seen on the coin's live stream. */
export interface StreamTrade { mint: string; trader: string; side: "buy" | "sell"; sol: number; signature?: string }
/** Dev-sell orders that fire on this trade: same coin, the order's dev wallet, a sell of at least minDevSellSol. */
export function matchDevSell(orders: Order[], t: StreamTrade): OrderFire[] {
  return orders
    .filter((o) => o.status === "open" && o.kind === "dev-sell" && o.mint === t.mint && o.dev === t.trader && t.side === "sell" && t.sol >= (o.minDevSellSol ?? 0))
    .map((o) => (sideOf(o) === "buy" ? { order: o, action: "buy" as const, amountSol: o.amountSol } : { order: o, action: "sell" as const, sellPct: o.sellPct ?? 100 }));
}
/** Mints whose trade stream the agent must watch (open dev-sell orders). */
export const devSellMints = (orders: Order[]) => [...new Set(orders.filter((o) => o.status === "open" && o.kind === "dev-sell").map((o) => o.mint))];

/** Advance an order after a fill. */
export function afterFire(o: Order, now = Date.now(), slice?: number): Order {
  const fills = (o.fills ?? 0) + 1;
  if (o.kind === "dca") {
    const remaining = (o.remaining ?? 1) - 1;
    return { ...o, remaining, fills, nextAt: now + intervalMs(o), status: remaining > 0 ? "open" : "filled", lastError: undefined };
  }
  if (o.kind === "twap") {
    const schedule = (o.schedule ?? []).map((s, i) => (i === (slice ?? (o.schedule ?? []).findIndex((x) => !x.done)) ? { ...s, done: true } : s));
    return { ...o, schedule, fills, status: schedule.every((s) => s.done) ? "filled" : "open", lastError: undefined };
  }
  return { ...o, fills, status: "filled", lastError: undefined };
}
/** A fill was refused or failed: keep the order (it retries next tick) and remember why. */
export const afterFail = (o: Order, error: string): Order => ({ ...o, lastError: error.slice(0, 160) });

/** Even DCA: per-slice amount for a total split into `slices`. */
export const dcaSlice = (total: number, slices: number) => roundSol(total / Math.max(1, slices));

/**
 * TWAP schedule: `slices` fills spread over `durationSec` starting at `start` (the first fills right away), with
 * amounts split evenly or by `weights` (any positive numbers, e.g. [50, 30, 20]). The last slice takes the rounding
 * remainder, so the amounts add up exactly to the total.
 */
export function twapSchedule(o: { side: "buy" | "sell"; total: number; durationSec: number; slices?: number; weights?: number[] }, start: number): OrderSlice[] {
  const w = o.weights?.length ? o.weights.map((x) => Math.max(0, x)) : Array.from({ length: Math.max(1, o.slices ?? 1) }, () => 1);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const n = w.length;
  const gap = n > 1 ? (o.durationSec * 1000) / (n - 1) : 0;
  let used = 0;
  return w.map((x, i) => {
    const amt = i === n - 1 ? roundSol(o.total - used) : roundSol((o.total * x) / sum);
    used = roundSol(used + amt);
    const at = Math.round(start + i * gap);
    return o.side === "buy" ? { at, amountSol: amt } : { at, sellPct: amt };
  });
}

const fmtUsdK = (v: number) => (v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const trig = (o: Order, word: string) => (o.priceSol !== undefined ? `price ${word} ${o.priceSol} SOL` : `market cap ${word} ${fmtUsdK(o.atMcapUsd ?? 0)}`);
const every = (o: Order) => (o.intervalSec !== undefined ? (o.intervalSec % 60 === 0 ? `${o.intervalSec / 60} min` : `${o.intervalSec} s`) : `${o.intervalMin} min`);
const dur = (sec: number) => (sec >= 3600 ? `${+(sec / 3600).toFixed(1)} h` : sec >= 60 ? `${+(sec / 60).toFixed(1)} min` : `${sec} s`);

/** "limit buy 0.1 SOL when price ≤ 0.0000004 SOL" etc., for logs, `vesk orders` and the Orders tab. */
export function describeOrder(o: Order): string {
  const side = sideOf(o);
  switch (o.kind) {
    case "limit-buy": return `limit buy ${o.amountSol} SOL when ${trig(o, "≤")}`;
    case "limit-sell": return `limit sell ${o.sellPct}% when ${trig(o, "≥")}`;
    case "stop-loss": return `stop-loss: sell ${o.sellPct ?? 100}% when ${trig(o, "≤")}`;
    case "trailing": return `trailing stop: sell ${o.sellPct ?? 100}% ${o.trailPct}% below the high${o.peakPriceSol ? ` (high ${o.peakPriceSol} SOL)` : ""}`;
    case "dev-sell": return `when the dev (${(o.dev ?? "").slice(0, 4)}…${(o.dev ?? "").slice(-4)}) sells${o.minDevSellSol ? ` ≥ ${o.minDevSellSol} SOL` : ""}: ${side === "buy" ? `buy ${o.amountSol} SOL` : `sell ${o.sellPct ?? 100}%`}`;
    case "twap": {
      const s = o.schedule ?? [];
      const left = s.filter((x) => !x.done).length;
      return `TWAP ${side} ${side === "buy" ? `${o.totalSol} SOL` : `${o.totalPct}%`} over ${dur(o.durationSec ?? 0)} in ${s.length} slices, ${left} left`;
    }
    case "dca": {
      const band = o.minMcapUsd !== undefined || o.maxMcapUsd !== undefined ? ` while market cap ${o.minMcapUsd !== undefined ? `≥ ${fmtUsdK(o.minMcapUsd)}` : ""}${o.minMcapUsd !== undefined && o.maxMcapUsd !== undefined ? " and " : ""}${o.maxMcapUsd !== undefined ? `≤ ${fmtUsdK(o.maxMcapUsd)}` : ""}` : "";
      return side === "buy" ? `DCA ${o.amountSol} SOL every ${every(o)}, ${o.remaining} more${band}` : `DCA sell ${o.sellPct}% every ${every(o)}, ${o.remaining} more${band}`;
    }
    default: return o.kind;
  }
}

/** Validate an order before it's queued. Guardrails still run on every fill. */
export function validateOrder(o: Partial<Order>): string[] {
  const e: string[] = [];
  if (!o.mint) e.push("Missing mint.");
  const side = o.side ?? (o.kind === "limit-sell" || o.kind === "stop-loss" || o.kind === "trailing" ? "sell" : "buy");
  const pctOk = (v: unknown) => Number(v) > 0 && Number(v) <= 100;
  const trigOk = () => Number(o.priceSol) > 0 || Number(o.atMcapUsd) > 0;
  switch (o.kind) {
    case "limit-buy":
      if (!(Number(o.amountSol) > 0)) e.push("Amount must be above 0 SOL.");
      if (!trigOk()) e.push("Price must be above 0 (SOL per token), or give a market cap.");
      break;
    case "limit-sell":
    case "stop-loss":
      if (!pctOk(o.sellPct)) e.push("Sell percent must be 1-100.");
      if (!trigOk()) e.push("Price must be above 0 (SOL per token), or give a market cap.");
      break;
    case "trailing":
      if (!pctOk(o.sellPct ?? 100)) e.push("Sell percent must be 1-100.");
      if (!(Number(o.trailPct) >= 1 && Number(o.trailPct) <= 90)) e.push("Trailing distance must be 1-90%.");
      break;
    case "dca": {
      if (side === "buy" && !(Number(o.amountSol) > 0)) e.push("Amount must be above 0 SOL.");
      if (side === "sell" && !pctOk(o.sellPct)) e.push("Sell percent per slice must be 1-100.");
      const secOk = o.intervalSec !== undefined ? Number(o.intervalSec) >= ORDER_MIN_INTERVAL_SEC : Number(o.intervalMin) >= 1;
      if (!secOk || !(Number(o.remaining) >= 1 && Number(o.remaining) <= 1000)) e.push(o.intervalSec !== undefined ? `DCA needs an interval of at least ${ORDER_MIN_INTERVAL_SEC} s and 1-1000 slices.` : "DCA needs --every <minutes ≥ 1> and --times <1-1000>.");
      if (o.minMcapUsd !== undefined && o.maxMcapUsd !== undefined && !(o.minMcapUsd < o.maxMcapUsd)) e.push("Min market cap must be below max market cap.");
      break;
    }
    case "twap": {
      const s = o.schedule ?? [];
      if (s.length < 2 || s.length > TWAP_MAX_SLICES) e.push(`TWAP needs 2-${TWAP_MAX_SLICES} slices.`);
      if (!(Number(o.durationSec) >= 10 && Number(o.durationSec) <= TWAP_MAX_DURATION_SEC)) e.push("TWAP duration must be 10 s to 7 days.");
      if (side === "buy" && !(Number(o.totalSol) > 0)) e.push("TWAP total must be above 0 SOL.");
      if (side === "sell" && !pctOk(o.totalPct)) e.push("TWAP sell total must be 1-100%.");
      if (s.some((x) => (side === "buy" ? !(Number(x.amountSol) > 0) : !(Number(x.sellPct) > 0)))) e.push("Every TWAP slice needs an amount above 0.");
      break;
    }
    case "dev-sell":
      if (!isB58(o.dev)) e.push("Dev-sell orders need the dev's wallet address.");
      if (side === "buy" && !(Number(o.amountSol) > 0)) e.push("Amount must be above 0 SOL.");
      if (side === "sell" && !pctOk(o.sellPct ?? 100)) e.push("Sell percent must be 1-100.");
      break;
    default:
      e.push("Unknown order type.");
  }
  if (o.slippageBps !== undefined && !(Number(o.slippageBps) >= 0 && Number(o.slippageBps) <= 5000)) e.push("Slippage must be 0-50%.");
  return e;
}

/** Normalise orders coming from the panel or a file: drop unknown/invalid ones, cap the list. */
export function normalizeOrders(x: unknown, max = 200): Order[] {
  if (!Array.isArray(x)) return [];
  return (x as Order[]).filter((o) => o && typeof o === "object" && typeof o.id === "string" && validateOrder(o).length === 0).slice(-max)
    .map((o) => ({ ...o, status: o.status === "filled" || o.status === "cancelled" ? o.status : "open" }));
}
