/**
 * Trading settings: one set of buy and sell presets (P1/P2/P3), quick amounts, the active trading wallet,
 * a large-trade confirmation and hotkeys. The same object is used by the CLI (`vesk buy --preset p2`),
 * rules (`buy.preset`), the panel (Pulse, Workspace, Instant Trade, Tracker) and the hosted agent.
 *
 * MEV protection, plainly:
 *  - off:     sent through your RPC (and also as a Jito bundle if the preset has a tip and Jito is on).
 *  - reduced: sent ONLY as a Jito bundle (trade + tip). Never to the public mempool through your RPC, so
 *             searchers watching the mempool can't see it before it lands. If the bundle doesn't land, the trade
 *             fails instead of falling back. Bundles can still be outbid, and Jito isn't the only block builder.
 *  - secure:  the same as reduced, plus slippage is capped at 10%, so a sandwich has less room even if the
 *             transaction is exposed somewhere else.
 * Neither mode makes a trade private or guarantees a price.
 */

export type MevMode = "off" | "reduced" | "secure";
export type PresetId = "p1" | "p2" | "p3";

export interface ExecPreset {
  slippagePct: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  /** Use a fee estimate from your RPC (recent prioritization fees) instead of the fixed priority fee, capped at maxFeeSol. */
  autoFee: boolean;
  maxFeeSol: number;
  mev: MevMode;
}

export interface Hotkey { key: string; action: HotkeyAction }
export type HotkeyAction = "buy-active" | "sell-50" | "sell-100" | "instant-trade" | "preset-1" | "preset-2" | "preset-3" | "close";

export interface TradingSettings {
  buy: Record<PresetId, ExecPreset>;
  sell: Record<PresetId, ExecPreset>;
  activeBuy: PresetId;
  activeSell: PresetId;
  /** Four quick-buy amounts in SOL. */
  quickBuy: [number, number, number, number];
  /** Four quick-sell percentages. */
  quickSellPct: [number, number, number, number];
  /** The one wallet that trades. Buys of a coin always come from one wallet (guardrail). Empty = main wallet. */
  wallet?: string;
  /** Ask before a trade above this many SOL (0 = never ask). */
  confirmAboveSol: number;
  hotkeys: Hotkey[];
  /** "single": press the key. "space": hold Space and press the key (safer: a stray key does nothing). */
  hotkeyMode?: "single" | "space";
}

export const MEV_SECURE_MAX_SLIPPAGE_PCT = 10;
export const PRESET_IDS: PresetId[] = ["p1", "p2", "p3"];
const preset = (p: Partial<ExecPreset>): ExecPreset => ({ slippagePct: 15, priorityFeeSol: 0.0005, jitoTipSol: 0, autoFee: false, maxFeeSol: 0.005, mev: "off", ...p });

export function defaultTradingSettings(): TradingSettings {
  return {
    buy: {
      p1: preset({ slippagePct: 15, priorityFeeSol: 0.0005 }),
      p2: preset({ slippagePct: 20, priorityFeeSol: 0.001, jitoTipSol: 0.001, mev: "reduced" }),
      p3: preset({ slippagePct: 25, priorityFeeSol: 0.003, jitoTipSol: 0.003, autoFee: true, maxFeeSol: 0.01, mev: "reduced" }),
    },
    sell: {
      p1: preset({ slippagePct: 15, priorityFeeSol: 0.0005 }),
      p2: preset({ slippagePct: 20, priorityFeeSol: 0.001, jitoTipSol: 0.001, mev: "reduced" }),
      p3: preset({ slippagePct: 30, priorityFeeSol: 0.003, jitoTipSol: 0.003, mev: "reduced" }),
    },
    activeBuy: "p1",
    activeSell: "p1",
    quickBuy: [0.05, 0.1, 0.25, 0.5],
    quickSellPct: [25, 50, 75, 100],
    confirmAboveSol: 1,
    hotkeys: [
      { key: "b", action: "buy-active" },
      { key: "s", action: "sell-50" },
      { key: "t", action: "instant-trade" },
      { key: "1", action: "preset-1" },
      { key: "2", action: "preset-2" },
      { key: "3", action: "preset-3" },
      { key: "Escape", action: "close" },
    ],
  };
}

export const HOTKEY_LABEL: Record<HotkeyAction, string> = {
  "buy-active": "Buy with the active preset", "sell-50": "Sell 50%", "sell-100": "Sell 100%", "instant-trade": "Open Instant Trade",
  "preset-1": "Switch to P1", "preset-2": "Switch to P2", "preset-3": "Switch to P3", close: "Close",
};

export interface TradingFieldError { field: string; message: string }

export function validateTradingSettings(s: TradingSettings): TradingFieldError[] {
  const e: TradingFieldError[] = [];
  for (const side of ["buy", "sell"] as const) {
    for (const id of PRESET_IDS) {
      const p = s[side]?.[id];
      const f = `${side}.${id}`;
      if (!p) { e.push({ field: f, message: `${side} ${id.toUpperCase()} is missing.` }); continue; }
      if (!(p.slippagePct > 0 && p.slippagePct <= 50)) e.push({ field: `${f}.slippagePct`, message: `${side} ${id.toUpperCase()}: slippage must be 0.1-50%.` });
      if (!(p.priorityFeeSol >= 0 && p.priorityFeeSol <= 0.1)) e.push({ field: `${f}.priorityFeeSol`, message: `${side} ${id.toUpperCase()}: priority fee must be 0-0.1 SOL.` });
      if (!(p.jitoTipSol >= 0 && p.jitoTipSol <= 0.1)) e.push({ field: `${f}.jitoTipSol`, message: `${side} ${id.toUpperCase()}: Jito tip must be 0-0.1 SOL.` });
      if (p.autoFee && !(p.maxFeeSol > 0 && p.maxFeeSol <= 0.1)) e.push({ field: `${f}.maxFeeSol`, message: `${side} ${id.toUpperCase()}: auto fee needs a max fee of 0-0.1 SOL.` });
      if (!["off", "reduced", "secure"].includes(p.mev)) e.push({ field: `${f}.mev`, message: `${side} ${id.toUpperCase()}: MEV mode is off, reduced or secure.` });
      if (p.mev !== "off" && !(p.jitoTipSol >= 0.0001)) e.push({ field: `${f}.jitoTipSol`, message: `${side} ${id.toUpperCase()}: MEV protection sends through Jito only, so it needs a tip of at least 0.0001 SOL.` });
    }
  }
  if (!PRESET_IDS.includes(s.activeBuy) || !PRESET_IDS.includes(s.activeSell)) e.push({ field: "active", message: "Active preset is p1, p2 or p3." });
  if (s.quickBuy?.length !== 4 || !s.quickBuy.every((n) => n > 0 && n <= 100)) e.push({ field: "quickBuy", message: "Four quick-buy amounts above 0 SOL." });
  if (s.quickSellPct?.length !== 4 || !s.quickSellPct.every((n) => n > 0 && n <= 100)) e.push({ field: "quickSellPct", message: "Four quick-sell percentages, 1-100." });
  if (!(s.confirmAboveSol >= 0)) e.push({ field: "confirmAboveSol", message: "Confirmation threshold can't be negative." });
  const keys = (s.hotkeys ?? []).map((h) => h.key.toLowerCase());
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) e.push({ field: "hotkeys", message: `Hotkey "${dup}" is used twice.` });
  if ((s.hotkeys ?? []).some((h) => !(h.key.length >= 1 && h.key.length <= 12) || !(h.action in HOTKEY_LABEL))) e.push({ field: "hotkeys", message: "Each hotkey needs a key and a known action." });
  return e;
}

/** Fill in anything missing from older saved settings. */
export function normalizeTradingSettings(s: Partial<TradingSettings> | null | undefined): TradingSettings {
  const d = defaultTradingSettings();
  if (!s) return d;
  const side = (x: Partial<Record<PresetId, Partial<ExecPreset>>> | undefined, def: Record<PresetId, ExecPreset>) =>
    Object.fromEntries(PRESET_IDS.map((id) => [id, { ...def[id], ...(x?.[id] ?? {}) }])) as Record<PresetId, ExecPreset>;
  return {
    ...d, ...s,
    buy: side(s.buy, d.buy), sell: side(s.sell, d.sell),
    quickBuy: (s.quickBuy?.length === 4 ? s.quickBuy : d.quickBuy) as TradingSettings["quickBuy"],
    quickSellPct: (s.quickSellPct?.length === 4 ? s.quickSellPct : d.quickSellPct) as TradingSettings["quickSellPct"],
    hotkeys: s.hotkeys?.length ? s.hotkeys : d.hotkeys,
    hotkeyMode: s.hotkeyMode === "space" ? "space" : "single",
  };
}

export interface ExecParams {
  slippageBps: number;
  priorityFeeSol: number;
  jitoTipSol?: number;
  /** Send through Jito only, no RPC fallback. */
  jitoOnly: boolean;
  mev: MevMode;
}

/**
 * Turn a preset into execution parameters. `feeEstimateSol` is your RPC's recent prioritization fee estimate,
 * used when autoFee is on (capped at maxFeeSol; the fixed fee is the floor).
 */
export function execParams(p: ExecPreset, feeEstimateSol?: number): ExecParams {
  const slip = p.mev === "secure" ? Math.min(p.slippagePct, MEV_SECURE_MAX_SLIPPAGE_PCT) : p.slippagePct;
  const prio = p.autoFee && feeEstimateSol !== undefined ? Math.min(p.maxFeeSol, Math.max(p.priorityFeeSol, feeEstimateSol)) : p.priorityFeeSol;
  return { slippageBps: Math.round(slip * 100), priorityFeeSol: +prio.toFixed(9), jitoTipSol: p.jitoTipSol > 0 ? p.jitoTipSol : undefined, jitoOnly: p.mev !== "off", mev: p.mev };
}

export const presetLabel = (id: PresetId) => id.toUpperCase();
export const isPresetId = (s: unknown): s is PresetId => s === "p1" || s === "p2" || s === "p3";

/** Should the UI ask before this trade? */
export const needsConfirm = (s: TradingSettings, amountSol: number) => s.confirmAboveSol > 0 && amountSol > s.confirmAboveSol;
