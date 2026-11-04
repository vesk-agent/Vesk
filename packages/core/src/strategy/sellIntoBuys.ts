/**
 * Sell into big buys (v20), an exit. Pure.
 *
 * When someone else's buy of at least `minBuySol` LANDS on a coin we hold, sell `sellPct` % of our own position right
 * away as a Jito bundle with a tip, so our sell has a chance to fill at the higher price the buy left behind.
 *
 * What it is: selling our own holding after their transaction landed (we read it from the trade stream, which only
 * carries trades that executed, each with its signature).
 * What it is not: front-running or sandwiching. Nothing here ever buys, and nothing is placed ahead of or around
 * another trader's transaction. The guardrails enforce it too: an intent with a `big-buy` trigger can only be a sell,
 * and only once their buy has a signature (guardrails.ts, "ahead-of-trade").
 *
 * Honest limits: landing in the same or the next slot is competitive and often fails; you pay the tip even when the
 * price has already moved. The tip starts at `tipSol` and doubles after a miss, up to `maxTipSol`.
 */
import type { TradeIntent } from "../types.js";
import type { SellIntoBuys } from "./settings.js";

/** A trade from the stream (PumpPortal: it has executed; `signature` is its transaction). */
export interface BigBuyTrade { txType?: string; mint?: string; traderPublicKey?: string; solAmount?: number; signature?: string; at: number }

export interface BigBuyState { lastAt?: number; lastTip?: number; missed?: boolean }

export type BigBuyDecision =
  | { sell: true; pct: number; tipSol: number; reason: string; trigger: NonNullable<TradeIntent["trigger"]> }
  | { sell: false; why: string };

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Should we sell into this trade? `holds`: we hold this coin (tokens > 0). `own`: our wallets. */
export function bigBuyDecision(c: SellIntoBuys, t: BigBuyTrade, ctx: { holds: boolean; own: string[]; state?: BigBuyState; now: number }): BigBuyDecision {
  if (!c.enabled) return { sell: false, why: "off" };
  if (t.txType !== "buy") return { sell: false, why: "not a buy" };
  if (!ctx.holds) return { sell: false, why: "not holding this coin" };
  const sol = Number(t.solAmount ?? 0);
  if (!(sol >= c.minBuySol)) return { sell: false, why: `buy of ${r3(sol)} SOL is under ${c.minBuySol} SOL` };
  if (!t.signature) return { sell: false, why: "their buy hasn't landed yet (no signature)" };
  if (!t.traderPublicKey || ctx.own.includes(t.traderPublicKey)) return { sell: false, why: "our own buy" };
  const st = ctx.state ?? {};
  if (st.lastAt !== undefined && ctx.now - st.lastAt < c.cooldownSec * 1000) return { sell: false, why: `cooling down (${c.cooldownSec} s between tries)` };
  const tipSol = r3(Math.min(c.maxTipSol, st.missed && st.lastTip ? st.lastTip * 2 : c.tipSol)) || c.tipSol;
  return {
    sell: true, pct: c.sellPct, tipSol,
    reason: `sold into a ${r3(sol)} SOL buy by ${short(t.traderPublicKey)} · tip ${tipSol} SOL`,
    trigger: { kind: "big-buy", signature: t.signature, wallet: t.traderPublicKey, sol, at: t.at },
  };
}

/** After an attempt: remember when, the tip, and whether it missed (the next one raises the tip). */
export function afterBigBuy(r: { ok: boolean; tipSol: number; at: number }): BigBuyState {
  return { lastAt: r.at, lastTip: r.tipSol, missed: !r.ok };
}
