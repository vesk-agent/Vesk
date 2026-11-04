/**
 * Rogue mode (v19): for one hyped launch where many copies appear. Pure.
 *
 * You set a target (ticker and/or name keywords, optionally the creator or X account you expect). For the session's
 * window the agent buys every new coin that matches, at a small fixed size, up to a number of coins and a total budget.
 * It skips the soft filters (the early-volume trigger, holder and dev checks), then sells the losers fast: a coin that
 * stalls (too little volume in the stall window), one that hits the stop-loss, and, after the leader time, every coin
 * that isn't among the top one or two by market cap. An expected coin is never sold for lagging.
 *
 * What it never skips, because the guardrails enforce it in core whatever the mode: the per-coin size, the session
 * budget and the coin count (`rogueGuard`, passed to checkTrade), your per-trade max, daily cap, open positions and buys
 * per minute, the kill switch, one wallet per coin, and the never-list. The can-sell check stays on unless you switch it
 * off (and confirm twice).
 */
import type { RogueSettings, StrategySettings } from "./settings.js";

export interface RogueCoin {
  mint: string;
  symbol: string;
  boughtAt: number;
  sol: number;
  expected?: boolean;
  sold?: { at: number; reason: string };
}
export interface RogueSession {
  startedAt: number;
  endsAt: number;
  coins: RogueCoin[];
  spentSol: number;
}
export const newRogueSession = (r: RogueSettings, now: number): RogueSession => ({ startedAt: now, endsAt: now + r.windowMin * 60_000, coins: [], spentSol: 0 });

/** Is Rogue mode running at `now`? (The mode stays "rogue" until the window ends; exits keep running after.) */
export const rogueActive = (s: Pick<StrategySettings, "mode" | "rogueStartedAt" | "rogue">, now: number) =>
  s.mode === "rogue" && typeof s.rogueStartedAt === "number" && now < s.rogueStartedAt + s.rogue.windowMin * 60_000;

const norm = (x: string) => x.toLowerCase().replace(/^\$/, "").trim();
/** Does a new coin match the target? `expected` when it's from the creator or X account you named. */
export function rogueMatch(r: RogueSettings, c: { symbol: string; name: string; creator?: string; xHandle?: string }): { match: boolean; why: string; expected: boolean } {
  const expected = (!!r.expectedCreator && c.creator === r.expectedCreator) || (!!r.expectedX && !!c.xHandle && norm(c.xHandle) === norm(r.expectedX));
  if (r.ticker && norm(c.symbol) === norm(r.ticker)) return { match: true, why: `ticker $${c.symbol.toUpperCase()} matches`, expected };
  const name = norm(c.name);
  const kw = r.keywords.find((k) => k && name.includes(norm(k)));
  if (kw) return { match: true, why: `name has "${kw}"`, expected };
  if (expected) return { match: true, why: r.expectedCreator && c.creator === r.expectedCreator ? "from the expected creator" : "links the expected X account", expected };
  return { match: false, why: `not $${r.ticker || "target"}`, expected: false };
}

/** Can the session buy this coin now? The same limits are enforced again by the guardrails (rogueGuard). */
export function rogueCanBuy(r: RogueSettings, s: RogueSession, mint: string, now: number): { ok: true; amountSol: number } | { ok: false; reason: string } {
  if (now >= s.endsAt) return { ok: false, reason: "Rogue window is over" };
  if (s.coins.some((c) => c.mint === mint)) return { ok: false, reason: "already bought in this Rogue session" };
  if (s.coins.length >= r.maxCoins) return { ok: false, reason: `Rogue: ${s.coins.length}/${r.maxCoins} coins already` };
  if (s.spentSol + r.perCoinSol > r.budgetSol + 1e-9) return { ok: false, reason: `Rogue budget: ${round(s.spentSol)} of ${r.budgetSol} SOL spent` };
  return { ok: true, amountSol: r.perCoinSol };
}

/** What the guardrails are told about a Rogue buy (types.ts GuardContext.rogue). */
export const rogueGuard = (r: RogueSettings, s: RogueSession) => ({ perCoinSol: r.perCoinSol, budgetSol: r.budgetSol, spentSol: s.spentSol, coins: s.coins.length, maxCoins: r.maxCoins, mints: s.coins.map((c) => c.mint) });

/** Record a landed Rogue buy. */
export function rogueBought(s: RogueSession, c: Omit<RogueCoin, "sold">): RogueSession {
  return { ...s, coins: [...s.coins, c], spentSol: round(s.spentSol + c.sol) };
}

export interface RogueLive { mint: string; mcapUsd?: number; priceMult?: number; volSol?: number }
export type RogueExitKind = "stall" | "sl" | "laggard";
/**
 * The coins to sell now, with why. `live` has, per coin: market cap, price as a multiple of entry, and SOL traded over
 * the last `stallSec`. Order of precedence per coin: stop-loss, stall, then not a leader.
 */
export function rogueExits(r: RogueSettings, s: RogueSession, live: Record<string, RogueLive>, now: number): Array<{ mint: string; symbol: string; kind: RogueExitKind; reason: string }> {
  const open = s.coins.filter((c) => !c.sold);
  const out: Array<{ mint: string; symbol: string; kind: RogueExitKind; reason: string }> = [];
  const ranked = [...open].filter((c) => live[c.mint]?.mcapUsd !== undefined).sort((a, b) => (live[b.mint].mcapUsd ?? 0) - (live[a.mint].mcapUsd ?? 0));
  for (const c of open) {
    const l = live[c.mint] ?? { mint: c.mint };
    const held = (now - c.boughtAt) / 1000;
    if (l.priceMult !== undefined && l.priceMult <= 1 - r.stopLossPct / 100) { out.push({ mint: c.mint, symbol: c.symbol, kind: "sl", reason: `Rogue stop-loss -${r.stopLossPct}% hit (${Math.round((l.priceMult - 1) * 100)}%)` }); continue; }
    if (held >= r.stallSec && l.volSol !== undefined && l.volSol < r.stallMinVolSol) { out.push({ mint: c.mint, symbol: c.symbol, kind: "stall", reason: `volume stalled: ${round(l.volSol)} SOL in ${r.stallSec} s` }); continue; }
    if (r.keepTop > 0 && r.leaderAfterSec > 0 && held >= r.leaderAfterSec && !c.expected) {
      const rank = ranked.findIndex((x) => x.mint === c.mint);
      if (rank >= r.keepTop) out.push({ mint: c.mint, symbol: c.symbol, kind: "laggard", reason: `not in the top ${r.keepTop} by market cap after ${r.leaderAfterSec} s (#${rank + 1})` });
    }
  }
  return out;
}

export function rogueSold(s: RogueSession, mint: string, reason: string, now: number): RogueSession {
  return { ...s, coins: s.coins.map((c) => (c.mint === mint && !c.sold ? { ...c, sold: { at: now, reason } } : c)) };
}

/** "Rogue mode · $TICKER · 6/10 coins · budget 2.4/5 SOL · 8:12 left" */
export function rogueLine(r: RogueSettings, s: RogueSession | null, now: number): { text: string; left: string; parts: { target: string; coins: string; budget: string } } {
  const target = r.ticker ? `$${r.ticker}` : r.keywords.length ? `"${r.keywords[0]}"` : "no target";
  const coins = `${s?.coins.length ?? 0}/${r.maxCoins} coins`;
  const budget = `budget ${round(s?.spentSol ?? 0)}/${r.budgetSol} SOL`;
  const ms = Math.max(0, (s?.endsAt ?? now) - now);
  const left = `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
  return { text: `Rogue mode · ${target} · ${coins} · ${budget}`, left, parts: { target, coins, budget } };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
