/**
 * Instant Trade panel settings (saved with the panel settings, per account) and the maths for a floating panel you
 * drag around: where it sits, how it snaps to the window's edges and stays inside it. Positions are stored as
 * fractions of the free space (0 = left / top edge, 1 = right / bottom edge), so a saved spot still makes sense in a
 * window of another size.
 *
 * "Initials" (sell back your cost) is deliberately not a chip: the SOL a sell returns depends on price impact and
 * fees, so a % worked out from the position's value would not reliably return your cost.
 */
import type { PresetId } from "../trade/settings.js";

export interface PanelPos { x: number; y: number }
export interface InstantTradeSettings {
  /** 1 or 2 rows of buy amounts in SOL, up to 5 per row. */
  buyRows: number[][];
  /** 1 or 2 rows of sell percentages, up to 5 per row. */
  sellRows: number[][];
  /** The preset the panel opens on; "active" follows Trading settings. */
  preset: "active" | PresetId;
  /** Ask before buys above this (SOL); null follows Trading settings. */
  confirmAboveSol: number | null;
  showHotkeys: boolean;
  showPosition: boolean;
  showPnl: boolean;
  size: "compact" | "normal";
  /** v15: chip rows, or one big amount with % chips, available balance and the fee. */
  entry: "chips" | "amount";
  collapsed: boolean;
  /** Keep one position for every page, or one per coin page. */
  remember: "global" | "per-coin";
  /** null = docked (bottom right). */
  pos: PanelPos | null;
  posByMint: Record<string, PanelPos>;
}

export const IT_MAX_ROWS = 2;
export const IT_MAX_CHIPS = 5;
export const IT_MAX_COINS = 50;

export function defaultInstantTrade(): InstantTradeSettings {
  return {
    buyRows: [[0.1, 0.25, 0.5, 1]], sellRows: [[10, 25, 50, 100]], preset: "active", confirmAboveSol: null,
    showHotkeys: true, showPosition: true, showPnl: true, size: "normal", entry: "chips", collapsed: false, remember: "global", pos: null, posByMint: {},
  };
}

const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
const rows = (v: unknown, min: number, max: number, d: number[][]): number[][] => {
  if (!Array.isArray(v)) return d;
  const out = v.slice(0, IT_MAX_ROWS).map((r) => (Array.isArray(r) ? r.map((x) => num(x, min, max)).filter((x): x is number => x !== null).slice(0, IT_MAX_CHIPS) : [])).filter((r) => r.length);
  return out.length ? out : d;
};
const pos = (v: unknown): PanelPos | null => {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const x = num(p.x, 0, 1), y = num(p.y, 0, 1);
  return x === null || y === null ? null : { x, y };
};

export function normalizeInstantTrade(v: unknown): InstantTradeSettings {
  const d = defaultInstantTrade();
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const byMint: Record<string, PanelPos> = {};
  for (const [k, p] of Object.entries((o.posByMint && typeof o.posByMint === "object" ? o.posByMint : {}) as Record<string, unknown>).slice(-IT_MAX_COINS)) {
    const q = pos(p);
    if (q && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(k)) byMint[k] = q;
  }
  return {
    buyRows: rows(o.buyRows, 0.001, 1000, d.buyRows),
    sellRows: rows(o.sellRows, 1, 100, d.sellRows),
    preset: o.preset === "p1" || o.preset === "p2" || o.preset === "p3" ? o.preset : "active",
    confirmAboveSol: o.confirmAboveSol === null || o.confirmAboveSol === undefined ? null : num(o.confirmAboveSol, 0, 1000),
    showHotkeys: o.showHotkeys !== false, showPosition: o.showPosition !== false, showPnl: o.showPnl !== false,
    size: o.size === "compact" ? "compact" : "normal",
    entry: o.entry === "amount" ? "amount" : "chips",
    collapsed: o.collapsed === true,
    remember: o.remember === "per-coin" ? "per-coin" : "global",
    pos: pos(o.pos), posByMint: byMint,
  };
}

/** Validation messages for the settings form (the normalizer drops bad values; this says why). */
export function validateInstantTrade(s: { buyRows: number[][]; sellRows: number[][]; confirmAboveSol: number | null }): string[] {
  const e: string[] = [];
  if (!s.buyRows.length || s.buyRows.length > IT_MAX_ROWS) e.push("Buy chips: 1 or 2 rows.");
  if (!s.sellRows.length || s.sellRows.length > IT_MAX_ROWS) e.push("Sell chips: 1 or 2 rows.");
  for (const r of s.buyRows) { if (!r.length || r.length > IT_MAX_CHIPS) e.push(`Each buy row has 1 to ${IT_MAX_CHIPS} chips.`); if (r.some((x) => !(x > 0 && x <= 1000))) e.push("Buy amounts are above 0 and at most 1000 SOL."); }
  for (const r of s.sellRows) { if (!r.length || r.length > IT_MAX_CHIPS) e.push(`Each sell row has 1 to ${IT_MAX_CHIPS} chips.`); if (r.some((x) => !(x >= 1 && x <= 100))) e.push("Sell chips are 1 to 100 %."); }
  if (s.confirmAboveSol !== null && !(s.confirmAboveSol >= 0 && s.confirmAboveSol <= 1000)) e.push("Confirm above: 0 to 1000 SOL.");
  return [...new Set(e)];
}

// ---------------------------------------------------------------- floating position

export interface Box { w: number; h: number }
export const IT_MARGIN = 12;
export const IT_SNAP = 28;

/** Pixel position (left, top) for a stored spot; null = docked bottom right. Always inside the window. */
export function placeAt(p: PanelPos | null, panel: Box, view: Box, margin = IT_MARGIN): { left: number; top: number } {
  const fx = view.w - panel.w - 2 * margin, fy = view.h - panel.h - 2 * margin;
  const q = p ?? { x: 1, y: 1 };
  return { left: Math.round(margin + Math.max(0, fx) * q.x), top: Math.round(margin + Math.max(0, fy) * q.y) };
}

/** Where a drag ends up: kept inside the window, and pulled to an edge when it's within `snap` px of it. */
export function settle(left: number, top: number, panel: Box, view: Box, margin = IT_MARGIN, snap = IT_SNAP): { left: number; top: number } {
  const maxL = Math.max(margin, view.w - panel.w - margin), maxT = Math.max(margin, view.h - panel.h - margin);
  let l = Math.min(maxL, Math.max(margin, left)), t = Math.min(maxT, Math.max(margin, top));
  if (l - margin < snap) l = margin; else if (maxL - l < snap) l = maxL;
  if (t - margin < snap) t = margin; else if (maxT - t < snap) t = maxT;
  return { left: Math.round(l), top: Math.round(t) };
}

/** Pixel position → stored spot. */
export function toSpot(left: number, top: number, panel: Box, view: Box, margin = IT_MARGIN): PanelPos {
  const fx = view.w - panel.w - 2 * margin, fy = view.h - panel.h - 2 * margin;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { x: fx > 0 ? r(Math.min(1, Math.max(0, (left - margin) / fx))) : 1, y: fy > 0 ? r(Math.min(1, Math.max(0, (top - margin) / fy))) : 1 };
}

/** The saved spot for this page (per-coin keeps one per coin, else the global one). */
export function spotFor(s: InstantTradeSettings, mint?: string): PanelPos | null {
  return s.remember === "per-coin" && mint ? s.posByMint[mint] ?? s.pos : s.pos;
}

/** Save a spot (null = dock) the way `remember` says. Keeps the last IT_MAX_COINS coins. */
export function withSpot(s: InstantTradeSettings, spot: PanelPos | null, mint?: string): InstantTradeSettings {
  if (s.remember === "per-coin" && mint) {
    const by = { ...s.posByMint };
    delete by[mint];
    if (spot) by[mint] = spot;
    const keys = Object.keys(by);
    for (const k of keys.slice(0, Math.max(0, keys.length - IT_MAX_COINS))) delete by[k];
    return { ...s, posByMint: by };
  }
  return { ...s, pos: spot };
}
