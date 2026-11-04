/**
 * Portfolio maths shared by the panel, the hosted edge function and the agent: where a position came from, its exit
 * targets and progress to the next one, closed positions from fills, the realized summary (today / 7d / all, win
 * rate, best / worst), a daily realized calendar and allocations. Pure: no I/O, no clock unless passed in.
 */

export type OriginKind = "copy" | "snipe" | "launch-on-post" | "manual" | "pulse" | "tracker" | "order";
export interface Origin { kind: OriginKind; label: string; wallet?: string }
export const ORIGIN_LABEL: Record<OriginKind, string> = {
  copy: "Copy trade", snipe: "Snipe rule", "launch-on-post": "Launch on post", manual: "Manual", pulse: "Pulse quick buy", tracker: "Tracker", order: "Order",
};

/** The origin of a position from what it carries: an explicit origin, a copied wallet, or the rule text. */
export function originOf(p: { origin?: Origin; copiedFrom?: { wallet: string; label: string }; rule?: string }): Origin {
  if (p.origin) return p.origin;
  if (p.copiedFrom) return { kind: "copy", label: p.copiedFrom.label, wallet: p.copiedFrom.wallet };
  const r = (p.rule ?? "").trim();
  if (!r || /^manual$/i.test(r)) return { kind: "manual", label: "Manual" };
  if (/^copy/i.test(r)) return { kind: "copy", label: "Copy trade" };
  if (/^pulse/i.test(r)) return { kind: "pulse", label: "Pulse quick buy" };
  if (/launch on post|launch-on-post/i.test(r)) return { kind: "launch-on-post", label: r };
  if (/^tracker/i.test(r)) return { kind: "tracker", label: "Tracker" };
  return { kind: "snipe", label: r };
}

export type ExitKind = "tp" | "sl" | "trail" | "limit";
/** An exit as a multiple of the entry price (2 = 2x, 0.7 = −30%). `pct` is the share it sells. */
export interface ExitTarget { kind: ExitKind; at: number; pct?: number; label: string }

/** Exit targets from the short exits text the agent reports ("TP 3x · SL −30%", "TP 2x:50,5x:100 · SL 35%"). */
export function parseExitTargets(exits?: string): ExitTarget[] {
  if (!exits) return [];
  const out: ExitTarget[] = [];
  for (const part of exits.split("·").map((s) => s.trim())) {
    const tp = part.match(/^TP\s+(.+)$/i);
    if (tp) {
      for (const step of tp[1].split(",")) {
        const m = step.trim().match(/^(\d+(?:\.\d+)?)x(?::(\d+))?/i);
        if (m) out.push({ kind: "tp", at: +m[1], pct: m[2] ? +m[2] : undefined, label: `TP ${m[1]}x` });
      }
      continue;
    }
    const sl = part.match(/^SL\s+[−-]?(\d+(?:\.\d+)?)%/i);
    if (sl) { out.push({ kind: "sl", at: 1 - +sl[1] / 100, label: `SL −${sl[1]}%` }); continue; }
    const tr = part.match(/^trail(?:ing)?\s+(\d+(?:\.\d+)?)%/i);
    if (tr) out.push({ kind: "trail", at: 1 - +tr[1] / 100, label: `Trail ${tr[1]}%` });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Where the price sits between the stop and the next take-profit, as a multiple of entry. `toward` says which one
 * it's nearer to; `pct` is 0..100 of the way from entry to that target (or from entry down to the stop).
 */
export function exitProgress(multiple: number, targets: ExitTarget[]): { next?: ExitTarget; stop?: ExitTarget; pct: number; toward: "tp" | "sl" | "none" } {
  const next = targets.filter((t) => t.kind === "tp" && t.at > multiple).sort((a, b) => a.at - b.at)[0];
  const stop = targets.filter((t) => t.kind === "sl" || t.kind === "trail").sort((a, b) => b.at - a.at)[0];
  if (multiple >= 1 && next) return { next, stop, toward: "tp", pct: clamp(((multiple - 1) / (next.at - 1)) * 100) };
  if (multiple < 1 && stop) return { next, stop, toward: "sl", pct: clamp(((1 - multiple) / (1 - stop.at)) * 100) };
  if (next) return { next, stop, toward: "tp", pct: 0 };
  return { next, stop, toward: "none", pct: 0 };
}
const clamp = (x: number) => Math.max(0, Math.min(100, Number.isFinite(x) ? x : 0));

/** A position you no longer hold. */
export interface ClosedPosition {
  mint: string; symbol: string; name?: string;
  investedSol: number; returnedSol: number; pnlSol: number; pnlPct: number;
  openedAt: number; closedAt: number;
  entryMcapUsd?: number; exitMcapUsd?: number;
  origin: Origin;
}

export interface Fill { at: number; mint: string; side: "buy" | "sell"; sol: number; mcapUsd?: number; symbol?: string; name?: string; origin?: Origin }

/**
 * Closed positions from fills: per coin you no longer hold (not in `open`), SOL in vs SOL out, first buy to last
 * sell, the market cap at the first buy and the last sell when the fills carry it.
 */
export function closedFromFills(fills: Fill[], open: Iterable<string>): ClosedPosition[] {
  const held = new Set(open);
  const by = new Map<string, Fill[]>();
  for (const f of fills) if (!held.has(f.mint)) (by.get(f.mint) ?? by.set(f.mint, []).get(f.mint)!).push(f);
  const out: ClosedPosition[] = [];
  for (const [mint, fs] of by) {
    fs.sort((a, b) => a.at - b.at);
    const buys = fs.filter((f) => f.side === "buy"), sells = fs.filter((f) => f.side === "sell");
    if (!buys.length || !sells.length) continue;
    const invested = buys.reduce((s, f) => s + f.sol, 0), returned = sells.reduce((s, f) => s + f.sol, 0);
    const first = buys[0], last = sells[sells.length - 1];
    out.push({
      mint, symbol: fs.find((f) => f.symbol)?.symbol ?? mint.slice(0, 4), name: fs.find((f) => f.name)?.name,
      investedSol: round(invested), returnedSol: round(returned), pnlSol: round(returned - invested), pnlPct: invested > 0 ? round(((returned - invested) / invested) * 100, 1) : 0,
      openedAt: first.at, closedAt: last.at, entryMcapUsd: first.mcapUsd, exitMcapUsd: last.mcapUsd,
      origin: first.origin ?? { kind: "manual", label: "Manual" },
    });
  }
  return out.sort((a, b) => b.closedAt - a.closedAt);
}
/** Rounded, and never −0 (it would print as "−0.000"). */
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d || 0;

const DAY = 86_400_000;
/** UTC day key, "2026-10-24". */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface RealizedSummary {
  todaySol: number; d7Sol: number; allSol: number;
  wins: number; losses: number; winRate: number | null;
  best?: ClosedPosition; worst?: ClosedPosition;
  /** Realized per UTC day for the last `days` days, oldest first. */
  daily: Array<{ day: string; sol: number; n: number }>;
}

export function realizedSummary(closed: ClosedPosition[], now: number, days = 14): RealizedSummary {
  const today = utcDay(now);
  const sum = (xs: ClosedPosition[]) => round(xs.reduce((s, c) => s + c.pnlSol, 0));
  const wins = closed.filter((c) => c.pnlSol > 0).length, losses = closed.filter((c) => c.pnlSol < 0).length;
  const sorted = [...closed].sort((a, b) => b.pnlSol - a.pnlSol);
  return {
    todaySol: sum(closed.filter((c) => utcDay(c.closedAt) === today)),
    d7Sol: sum(closed.filter((c) => now - c.closedAt < 7 * DAY)),
    allSol: sum(closed),
    wins, losses, winRate: wins + losses ? round((wins / (wins + losses)) * 100, 1) : null,
    best: sorted[0] && sorted[0].pnlSol > 0 ? sorted[0] : undefined,
    worst: sorted.length && sorted[sorted.length - 1].pnlSol < 0 ? sorted[sorted.length - 1] : undefined,
    daily: dailyRealized(closed, now, days),
  };
}

/** Realized SOL per UTC day for the last `days` days (oldest first), for the calendar and the bar sparkline. */
/** One day of realized PnL: net SOL, closed positions, and how many of them were wins (> 0) and losses (< 0). */
export interface DayRealized { day: string; sol: number; n: number; w: number; l: number }
/** The last `days` UTC days, oldest first, every day present (zeros for days with nothing closed). */
export function dailyRealized(closed: ClosedPosition[], now: number, days: number): DayRealized[] {
  const m = new Map<string, { sol: number; n: number; w: number; l: number }>();
  for (const c of closed) {
    const k = utcDay(c.closedAt); const v = m.get(k) ?? { sol: 0, n: 0, w: 0, l: 0 };
    v.sol += c.pnlSol; v.n++; if (c.pnlSol > 0) v.w++; else if (c.pnlSol < 0) v.l++;
    m.set(k, v);
  }
  const out: DayRealized[] = [];
  for (let i = days - 1; i >= 0; i--) { const k = utcDay(now - i * DAY); const v = m.get(k); out.push({ day: k, sol: round(v?.sol ?? 0), n: v?.n ?? 0, w: v?.w ?? 0, l: v?.l ?? 0 }); }
  return out;
}
/** The closed positions of one UTC day ("2026-10-14"), newest first (the calendar's day drawer). */
export function closedOnDay(closed: ClosedPosition[], day: string): ClosedPosition[] {
  return closed.filter((c) => utcDay(c.closedAt) === day).sort((a, b) => b.closedAt - a.closedAt);
}
/**
 * The calendar's colour step for a day: 0 (nothing or exactly flat) to 4, by |sol| against the range's largest
 * |sol|. Square-root scaled, so one big day doesn't wash every other day out to the palest step.
 */
export function calendarStep(sol: number, maxAbs: number): 0 | 1 | 2 | 3 | 4 {
  if (!sol || !(maxAbs > 0)) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(Math.abs(sol) / maxAbs) * 4))) as 1 | 2 | 3 | 4;
}

export interface Slice { key: string; label: string; value: number; pct: number; wallet?: string }
/** Group values into slices that add to 100 %, biggest first; the tail past `max` folds into "Other". */
export function slices(items: Array<{ key: string; label: string; value: number; wallet?: string }>, max = 6): Slice[] {
  const m = new Map<string, { key: string; label: string; value: number; wallet?: string }>();
  for (const it of items) { if (!(it.value > 0)) continue; const v = m.get(it.key); if (v) v.value += it.value; else m.set(it.key, { ...it }); }
  const all = [...m.values()].sort((a, b) => b.value - a.value);
  const total = all.reduce((s, x) => s + x.value, 0);
  if (!total) return [];
  const head = all.slice(0, max), tail = all.slice(max);
  if (tail.length) head.push({ key: "other", label: `Other (${tail.length})`, value: tail.reduce((s, x) => s + x.value, 0) });
  return head.map((x) => ({ ...x, value: round(x.value), pct: round((x.value / total) * 100, 1) }));
}

/** A value series' change over its window: absolute and %. */
export function seriesChange(points: Array<{ t: number; v: number }>): { abs: number; pct: number | null } {
  if (points.length < 2) return { abs: 0, pct: null };
  const a = points[0].v, b = points[points.length - 1].v;
  return { abs: round(b - a), pct: a > 0 ? round(((b - a) / a) * 100, 2) : null };
}

// ---------------------------------------------------------------- v17: the portfolio share card and CSV export

export type CardPeriod = "7d" | "30d" | "all";
export interface PortfolioCard {
  period: CardPeriod; pnlSol: number; investedSol: number; pct: number | null;
  trades: number; wins: number; losses: number; winRate: number | null;
  best?: { symbol: string; pnlPct: number; pnlSol: number };
}
/** Realized results over a period, from closed positions only (what you actually took out), for the share card. */
export function portfolioCard(closed: ClosedPosition[], now: number, period: CardPeriod): PortfolioCard {
  const ms = period === "7d" ? 7 * DAY : period === "30d" ? 30 * DAY : Infinity;
  const xs = closed.filter((c) => now - c.closedAt < ms);
  const pnlSol = round(xs.reduce((s, c) => s + c.pnlSol, 0));
  const investedSol = round(xs.reduce((s, c) => s + c.investedSol, 0));
  const wins = xs.filter((c) => c.pnlSol > 0).length, losses = xs.filter((c) => c.pnlSol < 0).length;
  const b = [...xs].sort((a, c) => c.pnlPct - a.pnlPct)[0];
  return {
    period, pnlSol, investedSol, pct: investedSol > 0 ? round((pnlSol / investedSol) * 100, 1) : null,
    trades: xs.length, wins, losses, winRate: wins + losses ? round((wins / (wins + losses)) * 100, 1) : null,
    best: b && b.pnlSol > 0 ? { symbol: b.symbol, pnlPct: round(b.pnlPct, 1), pnlSol: round(b.pnlSol) } : undefined,
  };
}

/**
 * One CSV cell: quoted when it needs to be, and text that a spreadsheet would run as a formula (= + - @, tab, CR)
 * gets a leading apostrophe. Numbers are written as numbers.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const iso = (t?: number) => (t ? new Date(t).toISOString() : "");
/** Holdings: one row per open coin. */
export function holdingsCsv(rows: Array<{ mint: string; symbol: string; name?: string; tokens: number; costSol: number; valueSol: number; pnlSol: number; pnlPct: number; openedAt: number; mcapUsd?: number }>): string {
  return toCsv(["symbol", "name", "mint", "tokens", "cost_sol", "value_sol", "pnl_sol", "pnl_pct", "mcap_usd", "opened_at"],
    rows.map((r) => [r.symbol, r.name ?? "", r.mint, r.tokens, round(r.costSol), round(r.valueSol), round(r.pnlSol), round(r.pnlPct, 2), r.mcapUsd ?? "", iso(r.openedAt)]));
}
/** Closed positions: one row per coin you sold out of. */
export function closedCsv(rows: ClosedPosition[]): string {
  return toCsv(["symbol", "name", "mint", "invested_sol", "returned_sol", "pnl_sol", "pnl_pct", "entry_mcap_usd", "exit_mcap_usd", "opened_at", "closed_at", "origin"],
    rows.map((c) => [c.symbol, c.name ?? "", c.mint, round(c.investedSol), round(c.returnedSol), round(c.pnlSol), round(c.pnlPct, 2), c.entryMcapUsd ?? "", c.exitMcapUsd ?? "", iso(c.openedAt), iso(c.closedAt), c.origin.kind]));
}
