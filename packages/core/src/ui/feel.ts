/**
 * v15 helpers for the panel's hero numbers, social rows and trade actions. They're pure, so they're tested here.
 * - heroParts: one big number with its decimals split off, so they can be dimmed.
 * - changeOf: the arrow, direction and words under a hero number.
 * - topTrades: "Top trades this week", your best closed trades plus the best of your copies of tracked wallets.
 * - feedSentence: "Night desk bought $GLINT · 0.40 SOL at $36K MC · 2m".
 * - amountForPct: % chips of an available balance, keeping a fee reserve on Max.
 * - rangeStart: the chart's 24H / 1W / 1M / All window.
 * - slideDone: whether a slide-to-confirm handle has gone far enough.
 */
import type { ClosedPosition } from "../portfolio/stats.js";

const MINUS = "−";

/** Sign, integer part with thousands separators, and the decimal part (with its point) of a number. */
export function heroParts(n: number, decimals: number, opts: { signed?: boolean } = {}): { sign: string; int: string; dec: string } {
  if (!Number.isFinite(n)) return { sign: "", int: "–", dec: "" };
  const fixed = Math.abs(n).toFixed(Math.max(0, decimals));
  const zero = Number(fixed) === 0;
  const [i, d] = fixed.split(".");
  const sign = zero ? "" : n < 0 ? MINUS : opts.signed ? "+" : "";
  return { sign, int: Number(i).toLocaleString("en-US"), dec: d ? `.${d}` : "" };
}

export type Dir = "up" | "down" | "flat";
/** Direction and arrow of a change (▲ / ▼ / –), from its absolute value. */
export function changeOf(abs: number): { dir: Dir; arrow: string } {
  if (!Number.isFinite(abs) || Math.abs(abs) < 1e-12) return { dir: "flat", arrow: "–" };
  return abs > 0 ? { dir: "up", arrow: "▲" } : { dir: "down", arrow: "▼" };
}

export interface TopTrade { key: string; who: "you" | "tracked"; wallet?: string; label: string; symbol: string; mint: string; pnlSol: number; closedAt: number }
/**
 * Your best closed trades in the window, and the best copy of each tracked wallet (a tracked wallet's trade is shown
 * through your copy of it, so the number is one you actually made). Winners only, biggest first.
 */
export function topTrades(closed: ClosedPosition[], now: number, opts: { days?: number; n?: number } = {}): TopTrade[] {
  const since = now - (opts.days ?? 7) * 86_400_000;
  const wins = closed.filter((c) => c.closedAt >= since && c.closedAt <= now && c.pnlSol > 0);
  const tracked = new Map<string, TopTrade>();
  const yours: TopTrade[] = [];
  for (const c of wins) {
    const w = c.origin.kind === "copy" ? c.origin.wallet : undefined;
    const t: TopTrade = { key: `${c.mint}:${c.closedAt}`, who: w ? "tracked" : "you", wallet: w, label: w ? c.origin.label : "You", symbol: c.symbol, mint: c.mint, pnlSol: c.pnlSol, closedAt: c.closedAt };
    if (w) { const b = tracked.get(w); if (!b || b.pnlSol < t.pnlSol) tracked.set(w, t); }
    else yours.push(t);
  }
  return [...yours, ...tracked.values()].sort((a, b) => b.pnlSol - a.pnlSol).slice(0, opts.n ?? 6);
}

/** $36K, $1.2M, $940: compact, upper-case unit, no trailing ".0". */
export function compactUsd(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  const f = (x: number, u: string) => `$${(x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""))}${u}`;
  return a >= 1e9 ? f(a / 1e9, "B") : a >= 1e6 ? f(a / 1e6, "M") : a >= 1e3 ? f(a / 1e3, "K") : `$${Math.round(a)}`;
}

/** 12s, 4m, 3h, 2d. */
export function shortAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

/** One feed row as a sentence (also the row's accessible name). */
export function feedSentence(r: { label: string; side: "buy" | "sell"; symbol?: string; mint: string; sol: number; mcapUsd?: number; at: number }, now: number): string {
  const coin = r.symbol ? `$${r.symbol}` : `${r.mint.slice(0, 4)}…`;
  return `${r.label} ${r.side === "buy" ? "bought" : "sold"} ${coin} · ${r.sol.toFixed(2)} SOL${r.mcapUsd ? ` at ${compactUsd(r.mcapUsd)} MC` : ""} · ${shortAgo(r.at, now)}`;
}

/** SOL for a % chip of what's available. Max (100%) keeps `reserveSol` back for fees. Rounded down to 0.001. */
export function amountForPct(availableSol: number, pct: number, reserveSol = 0): number {
  if (!(availableSol > 0) || !(pct > 0)) return 0;
  const raw = pct >= 100 ? availableSol - reserveSol : (availableSol * pct) / 100;
  return Math.max(0, Math.floor(raw * 1000 + 1e-9) / 1000);
}

export type ChartRange = "1h" | "24h" | "1w" | "1m" | "all";
/** 1H is there for memecoins: most are hours old, so 24H and up often cover their whole life. */
export const CHART_RANGES: ChartRange[] = ["1h", "24h", "1w", "1m", "all"];
export const CHART_RANGE_LABEL: Record<ChartRange, string> = { "1h": "1H", "24h": "24H", "1w": "1W", "1m": "1M", all: "All" };
/** How long a range is (ms); null for All. */
export function rangeMs(r: ChartRange): number | null {
  return r === "1h" ? 3_600_000 : r === "24h" ? 86_400_000 : r === "1w" ? 7 * 86_400_000 : r === "1m" ? 30 * 86_400_000 : null;
}
/** Where a range starts (ms). All = -Infinity. */
export function rangeStart(r: ChartRange, now: number): number {
  const ms = rangeMs(r);
  return ms === null ? -Infinity : now - ms;
}

/** A slide-to-confirm handle confirms once its left edge has travelled 92% of the track. */
export function slideDone(x: number, track: number, handle: number): boolean {
  const room = track - handle;
  return room > 0 && x / room >= 0.92;
}
