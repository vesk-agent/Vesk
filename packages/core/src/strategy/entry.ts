/**
 * Entry decisions (v19): the early-volume trigger, the market-cap / liquidity / age bounds, the buy size and scale-in.
 * Pure. Reasons are written the way the rest of the agent writes them, so Live's filtered lane reads the same.
 */
import { fmtK } from "../rules/engine.js";
import type { EarlyVolume, EntrySettings, ScaleIn, SizeSettings } from "./settings.js";

/** One trade on a coin (from the data stream). */
export interface TradeTick { at: number; side: "buy" | "sell"; sol: number; wallet: string; /** v20: tokens in the trade (fake-pump checks). */ tokens?: number }

export interface EarlyVolumeState {
  status: "waiting" | "fired" | "missed";
  volSol: number;
  buys: number;
  buyers: number;
  /** Seconds after creation the numbers were reached (fired) or counted to (waiting / missed). */
  sec: number;
  reason: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const sol = (n: number) => `${r1(n)} SOL`;
const needs = (c: EarlyVolume) => [c.minVolSol > 0 ? sol(c.minVolSol) : "", c.minBuys > 0 ? `${c.minBuys} buys` : "", c.minBuyers > 0 ? `${c.minBuyers} buyers` : ""].filter(Boolean);
const reached = (c: EarlyVolume, v: number, b: number, u: number) => {
  const tests = [c.minVolSol > 0 ? v >= c.minVolSol : null, c.minBuys > 0 ? b >= c.minBuys : null, c.minBuyers > 0 ? u >= c.minBuyers : null].filter((x): x is boolean => x !== null);
  if (!tests.length) return true;
  return c.need === "all" ? tests.every(Boolean) : tests.some(Boolean);
};

/**
 * Has a new coin reached your early volume? Counts trades from its creation to `windowSec` after it: SOL traded (buys
 * and sells), buys, and distinct buying wallets. Fired the moment the numbers are reached; missed once the window is
 * over without them; waiting until then.
 */
export function earlyVolume(c: EarlyVolume, createdAt: number, trades: TradeTick[], now: number): EarlyVolumeState {
  const end = createdAt + c.windowSec * 1000;
  let v = 0, b = 0;
  const who = new Set<string>();
  const line = (sec: number) => `early volume: ${sol(v)}, ${b} buy${b === 1 ? "" : "s"}, ${who.size} buyer${who.size === 1 ? "" : "s"} in ${Math.max(0, Math.round(sec))} s`;
  for (const t of [...trades].sort((x, y) => x.at - y.at)) {
    if (t.at > end) break;
    v += t.sol;
    if (t.side === "buy") { b++; who.add(t.wallet); }
    if (reached(c, v, b, who.size)) { const sec = (t.at - createdAt) / 1000; return { status: "fired", volSol: r1(v), buys: b, buyers: who.size, sec: r1(sec), reason: line(sec) }; }
  }
  if (now >= end) return { status: "missed", volSol: r1(v), buys: b, buyers: who.size, sec: c.windowSec, reason: `${line(c.windowSec)} (needs ${needs(c).join(c.need === "all" ? " and " : " or ")})` };
  return { status: "waiting", volSol: r1(v), buys: b, buyers: who.size, sec: r1((now - createdAt) / 1000), reason: line((now - createdAt) / 1000) };
}

const age = (s: number) => (s >= 3600 ? `${r1(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);
/** The first bound the coin breaks, or null. */
export function entryBounds(e: Pick<EntrySettings, "minMcapUsd" | "maxMcapUsd" | "minLiquiditySol" | "maxAgeSec">, c: { mcapUsd?: number; liquiditySol?: number; ageSec?: number }): string | null {
  if (c.mcapUsd !== undefined && e.maxMcapUsd !== null && c.mcapUsd > e.maxMcapUsd) return `mcap $${fmtK(c.mcapUsd)} is above $${fmtK(e.maxMcapUsd)}`;
  if (c.mcapUsd !== undefined && e.minMcapUsd !== null && c.mcapUsd < e.minMcapUsd) return `mcap $${fmtK(c.mcapUsd)} is below $${fmtK(e.minMcapUsd)}`;
  if (c.liquiditySol !== undefined && e.minLiquiditySol !== null && c.liquiditySol < e.minLiquiditySol) return `liquidity ${c.liquiditySol.toFixed(2)} SOL < ${e.minLiquiditySol}`;
  if (c.ageSec !== undefined && e.maxAgeSec !== null && c.ageSec > e.maxAgeSec) return `age ${age(c.ageSec)} is above ${age(e.maxAgeSec)}`;
  return null;
}

/** How much to buy. `walletSol` is needed for % sizing. */
export function sizeFor(s: SizeSettings, walletSol?: number): { amountSol: number; reason: string } {
  if (s.mode === "fixed") return { amountSol: s.sol, reason: `${s.sol} SOL fixed` };
  const bal = walletSol ?? 0;
  const raw = (bal * s.pct) / 100;
  const amt = Math.floor(Math.min(raw, s.capSol) * 1e4) / 1e4;
  if (!(amt > 0)) return { amountSol: 0, reason: "wallet balance unknown or empty" };
  return { amountSol: amt, reason: `${s.pct}% of ${bal.toFixed(3)} SOL${raw > s.capSol ? `, capped at ${s.capSol} SOL` : ""} = ${amt} SOL` };
}

/** The next scale-in add that's due, or null. `adds` is how many were done already. */
export function scaleInDue(s: ScaleIn, p: { avgEntryPriceSol: number; firstSol: number; adds: number }, priceSol: number): { step: number; addSol: number; reason: string } | null {
  if (!s.enabled || p.avgEntryPriceSol <= 0 || p.adds >= s.steps.length) return null;
  const st = s.steps[p.adds];
  if (priceSol / p.avgEntryPriceSol < st.atMultiple) return null;
  const addSol = Math.floor(p.firstSol * (st.addPct / 100) * 1e4) / 1e4;
  return addSol > 0 ? { step: p.adds, addSol, reason: `scale-in at ${st.atMultiple}x: add ${st.addPct}% (${addSol} SOL)` } : null;
}

/** SOL traded in the last `windowSec` (for the no-volume exit and Rogue's stall check). */
export function volumeSince(trades: TradeTick[], now: number, windowSec: number): number {
  const from = now - windowSec * 1000;
  return Math.round(trades.reduce((a, t) => (t.at >= from && t.at <= now ? a + t.sol : a), 0) * 100) / 100;
}

/** The no-volume exit: due once the position is at least `windowSec` old and less than `minVolSol` traded in it. */
export function noVolumeDue(x: { enabled: boolean; windowSec: number; minVolSol: number }, openedAt: number, trades: TradeTick[], now: number): string | null {
  if (!x.enabled || now - openedAt < x.windowSec * 1000) return null;
  const v = volumeSince(trades, now, x.windowSec);
  return v < x.minVolSol ? `no volume: ${v} SOL in ${x.windowSec} s (below ${x.minVolSol})` : null;
}
