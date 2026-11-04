/**
 * Strategy & safety (v19): how the agent picks new coins, what it refuses, how much it buys and how it gets out.
 * One settings object, shared by the panel, the CLI (`vesk strategy`), chat and the agent. Pure: no I/O.
 *
 *   entry      the early-volume trigger, market cap / liquidity / age bounds, the buy size, optional scale-in
 *   rug        individually switchable holder checks (bundled, dev, top 10, snipers, insiders, holders, dev history,
 *              authorities, LP); bundled coins are refused unless you allow them
 *   honeypot   before buying a coin that isn't a pump.fun coin: can it be sold, and what does a transfer cost
 *   exits      the strategy's own exits: take-profit ladder, stop-loss, trailing, timed, no-volume
 *   rogue      a short, budgeted mode for hyped launches with many copies (strategy/rogue.ts)
 *
 * Hard limits (per trade, per day, open positions, buys per minute, kill switch) are not here: they're `Limits`,
 * enforced by the guardrails on every buy in every mode, including Rogue mode.
 */
import type { ExitSpec, TakeProfitStep, TradeOrigin } from "../types.js";

export type StrategyGroup = "entry" | "rug" | "honeypot" | "exits" | "limits" | "rogue";
export type StrategyPresetId = "safe" | "balanced" | "degen" | "rogue";

export interface EarlyVolume {
  enabled: boolean;
  /** Seconds after the coin's creation the trigger looks at. */
  windowSec: number;
  /** SOL traded (buys and sells) in that window. 0 = not checked. */
  minVolSol: number;
  /** Buys in that window. 0 = not checked. */
  minBuys: number;
  /** Distinct buying wallets in that window. 0 = not checked. */
  minBuyers: number;
  /** "all": every number you set must be reached; "any": one is enough. */
  need: "all" | "any";
}
export interface SizeSettings {
  mode: "fixed" | "pct";
  /** fixed: SOL per buy. */
  sol: number;
  /** pct: % of the wallet's SOL balance. */
  pct: number;
  /** pct: never more than this (SOL). */
  capSol: number;
}
export interface ScaleIn {
  enabled: boolean;
  /** Add `addPct` % of the first buy when the price reaches `atMultiple` × entry. At most `steps.length` adds. */
  steps: Array<{ atMultiple: number; addPct: number }>;
}
export interface EntrySettings {
  /** Watch new coins from the data stream and buy the ones that pass. Off: the checks still apply to your rules. */
  autoNewCoins: boolean;
  earlyVolume: EarlyVolume;
  minMcapUsd: number | null;
  maxMcapUsd: number | null;
  minLiquiditySol: number | null;
  /** Skip coins older than this (seconds since creation). */
  maxAgeSec: number | null;
  size: SizeSettings;
  scaleIn: ScaleIn;
}
export interface PctCheck { on: boolean; max: number }
export interface RugSettings {
  enabled: boolean;
  maxBundledPct: PctCheck;
  maxDevPct: PctCheck;
  maxTop10Pct: PctCheck;
  maxSnipersPct: PctCheck;
  maxInsidersPct: PctCheck;
  minHolders: { on: boolean; min: number };
  /** The dev's earlier coins: how many it rugged (sold most of its supply in the first 10 minutes) and launched. */
  devHistory: { on: boolean; maxRugs: number; maxLaunches: number };
  mintRevoked: boolean;
  freezeRevoked: boolean;
  /** AMM pools only (a bonding curve has no LP): the LP is burned or locked. */
  lpLocked: boolean;
  /** Off by default: heavily bundled coins are refused. On: the bundled check is skipped. */
  allowBundled: boolean;
  /** Read funding sources through your RPC (bundled / insiders exact, a few hundred ms per coin). */
  enrich: boolean;
  /** When a number can't be worked out yet: let it pass, or refuse the coin. */
  unknown: "pass" | "refuse";
  /**
   * v20: one wallet (or one cluster of linked wallets) buying more than `maxPct` of the supply in the first
   * `windowSec` seconds after creation. Read from the stream's trades since creation.
   */
  earlyConcentration: { on: boolean; maxPct: number; windowSec: number };
  /**
   * v20: the "fake pump" flag: inside `windowSec`, a big early buyer pushes the price up at least `minSpikePct` and then
   * sells at least `minDumpPct` of what it bought. Refused when it has already happened by the time of the check.
   */
  spikeDump: { on: boolean; minSpikePct: number; minDumpPct: number; windowSec: number };
}
export interface HoneypotSettings {
  enabled: boolean;
  /** Refuse a coin whose transfer fee (Token-2022) is above this %. */
  maxTaxPct: number;
  refuseTransferHook: boolean;
  refusePermanentDelegate: boolean;
  refuseNonTransferable: boolean;
  refuseDefaultFrozen: boolean;
  refuseFreezeAuthority: boolean;
  /** Simulate a sell from a current holder through your RPC (simulateTransaction, signatures not checked). */
  simulate: boolean;
}
export interface NoVolumeExit { enabled: boolean; windowSec: number; minVolSol: number }
export interface ExitSettings {
  takeProfit: TakeProfitStep[];
  stopLossPct: number | null;
  trailingStopPct: number | null;
  /** Sell everything after this many minutes. */
  timeoutMin: number | null;
  /** Sell everything when the coin trades less than `minVolSol` over the last `windowSec`. */
  noVolume: NoVolumeExit;
  /** v20: sell into big buys (strategy/sellIntoBuys.ts). */
  sellIntoBuys: SellIntoBuys;
}
/**
 * v20: when someone else's buy of at least `minBuySol` lands on a coin we hold, sell `sellPct` % of our own position as
 * a Jito bundle with a tip. Only after their buy landed; never a buy, never ahead of their transaction (guardrails).
 * The tip starts at `tipSol` and doubles after a miss, up to `maxTipSol`. One attempt per coin per `cooldownSec`.
 */
export interface SellIntoBuys { enabled: boolean; minBuySol: number; sellPct: number; tipSol: number; maxTipSol: number; cooldownSec: number }
/** v20: how many buys run at the same time (lanes), and launches (their own pool). More wait in a queue, in order. */
export interface Concurrency { lanes: number; launches: number }
export interface RogueSettings {
  /** The ticker to chase, without $. */
  ticker: string;
  /** Name keywords (any one matches). */
  keywords: string[];
  /** The creator you expect the real coin from (optional): it's never sold for lagging. */
  expectedCreator: string;
  /** Its X account (optional, without @): a coin whose metadata links it counts as expected too. */
  expectedX: string;
  /** How long the session runs. */
  windowMin: number;
  /** Coins bought at most. */
  maxCoins: number;
  /** SOL per coin (one buy each). */
  perCoinSol: number;
  /** Total SOL the session may spend. */
  budgetSol: number;
  /** Sell a coin when it trades less than `stallMinVolSol` in `stallSec`. */
  stallSec: number;
  stallMinVolSol: number;
  stopLossPct: number;
  /** After this long, sell every coin that isn't among the `keepTop` leaders by market cap (0 = off). */
  leaderAfterSec: number;
  keepTop: 0 | 1 | 2;
  /** The can-sell check (on by default; switching it off asks twice). */
  honeypot: boolean;
}
export interface StrategySettings {
  version: 1;
  preset: StrategyPresetId | "custom";
  /** "rogue" while a Rogue session runs (from `rogueStartedAt` for `rogue.windowMin`). */
  mode: "normal" | "rogue";
  rogueStartedAt?: number;
  entry: EntrySettings;
  rug: RugSettings;
  honeypot: HoneypotSettings;
  exits: ExitSettings;
  rogue: RogueSettings;
  /**
   * v19.1: where automatic buys may come from. Pulse (the strategy's own new-coin buys) is `entry.autoNewCoins`. A
   * source switched off is refused by the guardrails on every buy it sends (see `TradeOrigin`); manual buys never are.
   * Presets don't change these.
   */
  sources: TradeSources;
  /** v20: parallel lanes. */
  concurrency: Concurrency;
}

export interface TradeSources {
  /** Snipe rules (X posts with a CA, new-launch rules). */
  snipe: boolean;
  /** Copy trading (automatic copies; a copy you click is manual). */
  copy: boolean;
  /** Launch-on-post rules (launches with their dev buy). */
  launchOnPost: boolean;
}

// ---------------------------------------------------------------- defaults and presets

const balanced = (): StrategySettings => ({
  version: 1, preset: "balanced", mode: "normal",
  entry: {
    autoNewCoins: false,
    earlyVolume: { enabled: true, windowSec: 30, minVolSol: 5, minBuys: 15, minBuyers: 10, need: "all" },
    minMcapUsd: 5_000, maxMcapUsd: 60_000, minLiquiditySol: 1, maxAgeSec: 600,
    size: { mode: "fixed", sol: 0.1, pct: 3, capSol: 0.25 },
    scaleIn: { enabled: false, steps: [{ atMultiple: 1.3, addPct: 50 }] },
  },
  rug: {
    enabled: true,
    maxBundledPct: { on: true, max: 20 }, maxDevPct: { on: true, max: 10 }, maxTop10Pct: { on: true, max: 30 },
    maxSnipersPct: { on: true, max: 15 }, maxInsidersPct: { on: true, max: 15 }, minHolders: { on: true, min: 15 },
    devHistory: { on: true, maxRugs: 0, maxLaunches: 10 }, mintRevoked: true, freezeRevoked: true, lpLocked: true,
    allowBundled: false, enrich: true, unknown: "pass",
    earlyConcentration: { on: true, maxPct: 15, windowSec: 10 },
    spikeDump: { on: true, minSpikePct: 80, minDumpPct: 50, windowSec: 60 },
  },
  honeypot: { enabled: true, maxTaxPct: 5, refuseTransferHook: true, refusePermanentDelegate: true, refuseNonTransferable: true, refuseDefaultFrozen: true, refuseFreezeAuthority: true, simulate: true },
  exits: { takeProfit: [{ atMultiple: 2, sellPct: 50 }, { atMultiple: 4, sellPct: 50 }], stopLossPct: 30, trailingStopPct: 25, timeoutMin: 60, noVolume: { enabled: true, windowSec: 120, minVolSol: 0.5 }, sellIntoBuys: { enabled: false, minBuySol: 5, sellPct: 50, tipSol: 0.005, maxTipSol: 0.02, cooldownSec: 30 } },
  rogue: {
    ticker: "", keywords: [], expectedCreator: "", expectedX: "", windowMin: 10, maxCoins: 10, perCoinSol: 0.05, budgetSol: 0.5,
    stallSec: 20, stallMinVolSol: 0.3, stopLossPct: 35, leaderAfterSec: 90, keepTop: 2, honeypot: true,
  },
  sources: { snipe: true, copy: true, launchOnPost: true },
  concurrency: { lanes: 3, launches: 2 },
});

export const STRATEGY_PRESETS: Record<StrategyPresetId, { label: string; line: string; make: () => StrategySettings }> = {
  safe: {
    label: "Safe", line: "Strict holder checks, small fixed size, quick stop.",
    make: () => {
      const s = balanced();
      s.preset = "safe";
      s.entry.earlyVolume = { enabled: true, windowSec: 45, minVolSol: 8, minBuys: 25, minBuyers: 18, need: "all" };
      s.entry.maxMcapUsd = 40_000; s.entry.size = { mode: "fixed", sol: 0.05, pct: 2, capSol: 0.1 };
      Object.assign(s.rug, { maxBundledPct: { on: true, max: 10 }, maxDevPct: { on: true, max: 5 }, maxTop10Pct: { on: true, max: 25 }, maxSnipersPct: { on: true, max: 10 }, maxInsidersPct: { on: true, max: 10 }, minHolders: { on: true, min: 30 }, devHistory: { on: true, maxRugs: 0, maxLaunches: 3 }, unknown: "refuse" });
      s.honeypot.maxTaxPct = 1;
      s.exits = { ...s.exits, takeProfit: [{ atMultiple: 1.5, sellPct: 50 }, { atMultiple: 3, sellPct: 100 }], stopLossPct: 20, trailingStopPct: 15, timeoutMin: 30, noVolume: { enabled: true, windowSec: 90, minVolSol: 1 } };
      s.rug.earlyConcentration = { on: true, maxPct: 10, windowSec: 15 };
      return s;
    },
  },
  balanced: { label: "Balanced", line: "The default: sensible checks, 0.1 SOL, a two-step take-profit.", make: balanced },
  degen: {
    label: "Degen", line: "Looser checks and an earlier trigger. Expect more losers.",
    make: () => {
      const s = balanced();
      s.preset = "degen";
      s.entry.earlyVolume = { enabled: true, windowSec: 15, minVolSol: 2, minBuys: 8, minBuyers: 6, need: "any" };
      s.entry.maxMcapUsd = 150_000; s.entry.size = { mode: "pct", sol: 0.2, pct: 5, capSol: 0.5 };
      Object.assign(s.rug, { maxBundledPct: { on: true, max: 35 }, maxDevPct: { on: true, max: 15 }, maxTop10Pct: { on: true, max: 45 }, maxSnipersPct: { on: false, max: 30 }, maxInsidersPct: { on: true, max: 30 }, minHolders: { on: false, min: 5 }, devHistory: { on: true, maxRugs: 2, maxLaunches: 50 } });
      s.honeypot.maxTaxPct = 10;
      s.exits = { ...s.exits, takeProfit: [{ atMultiple: 3, sellPct: 50 }, { atMultiple: 10, sellPct: 100 }], stopLossPct: 45, trailingStopPct: 35, timeoutMin: 120, noVolume: { enabled: true, windowSec: 60, minVolSol: 0.3 } };
      s.rug.earlyConcentration = { on: true, maxPct: 25, windowSec: 8 };
      return s;
    },
  },
  rogue: {
    label: "Rogue", line: "For one hyped launch: buy every match small, sell the losers fast.",
    make: () => {
      const s = balanced();
      s.preset = "rogue";
      s.entry.autoNewCoins = false;
      s.exits = { ...s.exits, takeProfit: [{ atMultiple: 2, sellPct: 50 }], stopLossPct: 35, trailingStopPct: 30, timeoutMin: 30, noVolume: { enabled: true, windowSec: 20, minVolSol: 0.3 } };
      return s;
    },
  },
};

export const defaultStrategy = (): StrategySettings => balanced();
export const isStrategyPreset = (x: unknown): x is StrategyPresetId => typeof x === "string" && x in STRATEGY_PRESETS;
/** A preset's settings, keeping your Rogue target (ticker, keywords, expected creator) and any running session. */
export function applyPreset(cur: StrategySettings, id: StrategyPresetId): StrategySettings {
  const p = STRATEGY_PRESETS[id].make();
  p.rogue = { ...p.rogue, ticker: cur.rogue.ticker, keywords: [...cur.rogue.keywords], expectedCreator: cur.rogue.expectedCreator, expectedX: cur.rogue.expectedX };
  p.mode = cur.mode; p.rogueStartedAt = cur.rogueStartedAt;
  // v19.1: a preset changes how the agent trades, not where from
  p.sources = { ...cur.sources }; p.entry.autoNewCoins = cur.entry.autoNewCoins;
  // v20: lanes and selling into big buys are about your setup (RPC, Jito tips), not the preset's risk level
  p.concurrency = { ...cur.concurrency }; p.exits.sellIntoBuys = { ...cur.exits.sellIntoBuys };
  return p;
}

// ---------------------------------------------------------------- normalize / validate

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const numOrNull = (v: unknown, d: number | null, lo = 0, hi = Infinity): number | null => (v === null ? null : typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const str = (v: unknown, d: string, n = 64) => (typeof v === "string" ? v.trim().slice(0, n) : d);
const check = (v: unknown, d: PctCheck): PctCheck => ({ on: bool(obj(v).on, d.on), max: num(obj(v).max, d.max, 0, 100) });
const ladder = (v: unknown, d: TakeProfitStep[]): TakeProfitStep[] => (Array.isArray(v) ? v.slice(0, 6).map((x) => ({ atMultiple: num(obj(x).atMultiple, 2, 1.01, 1000), sellPct: num(obj(x).sellPct, 50, 1, 100) })) : d.map((x) => ({ ...x })));

/** Fill defaults and clamp every number into its range. Unknown keys are dropped. */
export function normalizeStrategy(x: unknown): StrategySettings {
  const d = defaultStrategy();
  const o = obj(x), e = obj(o.entry), ev = obj(e.earlyVolume), sz = obj(e.size), si = obj(e.scaleIn), r = obj(o.rug), h = obj(o.honeypot), xo = obj(o.exits), nv = obj(xo.noVolume), ro = obj(o.rogue);
  const mode = pick(o.mode, ["normal", "rogue"] as const, "normal");
  return {
    version: 1,
    preset: pick(o.preset, ["safe", "balanced", "degen", "rogue", "custom"] as const, d.preset),
    mode,
    ...(mode === "rogue" && typeof o.rogueStartedAt === "number" ? { rogueStartedAt: o.rogueStartedAt } : {}),
    entry: {
      autoNewCoins: bool(e.autoNewCoins, d.entry.autoNewCoins),
      earlyVolume: {
        enabled: bool(ev.enabled, d.entry.earlyVolume.enabled), windowSec: num(ev.windowSec, d.entry.earlyVolume.windowSec, 3, 600),
        minVolSol: num(ev.minVolSol, d.entry.earlyVolume.minVolSol, 0, 10_000), minBuys: Math.round(num(ev.minBuys, d.entry.earlyVolume.minBuys, 0, 100_000)),
        minBuyers: Math.round(num(ev.minBuyers, d.entry.earlyVolume.minBuyers, 0, 100_000)), need: pick(ev.need, ["all", "any"] as const, d.entry.earlyVolume.need),
      },
      minMcapUsd: numOrNull(e.minMcapUsd, d.entry.minMcapUsd), maxMcapUsd: numOrNull(e.maxMcapUsd, d.entry.maxMcapUsd),
      minLiquiditySol: numOrNull(e.minLiquiditySol, d.entry.minLiquiditySol), maxAgeSec: numOrNull(e.maxAgeSec, d.entry.maxAgeSec, 1, 7 * 86_400),
      size: { mode: pick(sz.mode, ["fixed", "pct"] as const, d.entry.size.mode), sol: num(sz.sol, d.entry.size.sol, 0.001, 1000), pct: num(sz.pct, d.entry.size.pct, 0.1, 100), capSol: num(sz.capSol, d.entry.size.capSol, 0.001, 1000) },
      scaleIn: { enabled: bool(si.enabled, d.entry.scaleIn.enabled), steps: Array.isArray(si.steps) ? si.steps.slice(0, 3).map((x) => ({ atMultiple: num(obj(x).atMultiple, 1.3, 1.01, 100), addPct: num(obj(x).addPct, 50, 1, 200) })) : d.entry.scaleIn.steps },
    },
    rug: {
      enabled: bool(r.enabled, d.rug.enabled),
      maxBundledPct: check(r.maxBundledPct, d.rug.maxBundledPct), maxDevPct: check(r.maxDevPct, d.rug.maxDevPct), maxTop10Pct: check(r.maxTop10Pct, d.rug.maxTop10Pct),
      maxSnipersPct: check(r.maxSnipersPct, d.rug.maxSnipersPct), maxInsidersPct: check(r.maxInsidersPct, d.rug.maxInsidersPct),
      minHolders: { on: bool(obj(r.minHolders).on, d.rug.minHolders.on), min: Math.round(num(obj(r.minHolders).min, d.rug.minHolders.min, 0, 100_000)) },
      devHistory: { on: bool(obj(r.devHistory).on, d.rug.devHistory.on), maxRugs: Math.round(num(obj(r.devHistory).maxRugs, d.rug.devHistory.maxRugs, 0, 1000)), maxLaunches: Math.round(num(obj(r.devHistory).maxLaunches, d.rug.devHistory.maxLaunches, 0, 100_000)) },
      mintRevoked: bool(r.mintRevoked, d.rug.mintRevoked), freezeRevoked: bool(r.freezeRevoked, d.rug.freezeRevoked), lpLocked: bool(r.lpLocked, d.rug.lpLocked),
      allowBundled: bool(r.allowBundled, d.rug.allowBundled), enrich: bool(r.enrich, d.rug.enrich), unknown: pick(r.unknown, ["pass", "refuse"] as const, d.rug.unknown),
      earlyConcentration: { on: bool(obj(r.earlyConcentration).on, d.rug.earlyConcentration.on), maxPct: num(obj(r.earlyConcentration).maxPct, d.rug.earlyConcentration.maxPct, 1, 100), windowSec: num(obj(r.earlyConcentration).windowSec, d.rug.earlyConcentration.windowSec, 1, 600) },
      spikeDump: { on: bool(obj(r.spikeDump).on, d.rug.spikeDump.on), minSpikePct: num(obj(r.spikeDump).minSpikePct, d.rug.spikeDump.minSpikePct, 5, 10_000), minDumpPct: num(obj(r.spikeDump).minDumpPct, d.rug.spikeDump.minDumpPct, 5, 100), windowSec: num(obj(r.spikeDump).windowSec, d.rug.spikeDump.windowSec, 5, 3600) },
    },
    honeypot: {
      enabled: bool(h.enabled, d.honeypot.enabled), maxTaxPct: num(h.maxTaxPct, d.honeypot.maxTaxPct, 0, 100),
      refuseTransferHook: bool(h.refuseTransferHook, true), refusePermanentDelegate: bool(h.refusePermanentDelegate, true), refuseNonTransferable: bool(h.refuseNonTransferable, true),
      refuseDefaultFrozen: bool(h.refuseDefaultFrozen, true), refuseFreezeAuthority: bool(h.refuseFreezeAuthority, true), simulate: bool(h.simulate, d.honeypot.simulate),
    },
    exits: {
      takeProfit: ladder(xo.takeProfit, d.exits.takeProfit).sort((a, b) => a.atMultiple - b.atMultiple),
      stopLossPct: numOrNull(xo.stopLossPct, d.exits.stopLossPct, 1, 99), trailingStopPct: numOrNull(xo.trailingStopPct, d.exits.trailingStopPct, 1, 99),
      timeoutMin: numOrNull(xo.timeoutMin, d.exits.timeoutMin, 1, 7 * 1440),
      noVolume: { enabled: bool(nv.enabled, d.exits.noVolume.enabled), windowSec: num(nv.windowSec, d.exits.noVolume.windowSec, 5, 3600), minVolSol: num(nv.minVolSol, d.exits.noVolume.minVolSol, 0, 10_000) },
      sellIntoBuys: ((b) => ({ enabled: bool(b.enabled, d.exits.sellIntoBuys.enabled), minBuySol: num(b.minBuySol, d.exits.sellIntoBuys.minBuySol, 0.1, 100_000), sellPct: num(b.sellPct, d.exits.sellIntoBuys.sellPct, 1, 100), tipSol: num(b.tipSol, d.exits.sellIntoBuys.tipSol, 0.0001, 1), maxTipSol: num(b.maxTipSol, d.exits.sellIntoBuys.maxTipSol, 0.0001, 5), cooldownSec: num(b.cooldownSec, d.exits.sellIntoBuys.cooldownSec, 1, 3600) }))(obj(xo.sellIntoBuys)),
    },
    rogue: {
      ticker: str(ro.ticker, d.rogue.ticker, 12).replace(/^\$/, "").toUpperCase(),
      keywords: Array.isArray(ro.keywords) ? ro.keywords.filter((k): k is string => typeof k === "string").map((k) => k.trim().toLowerCase().slice(0, 32)).filter(Boolean).slice(0, 10) : [],
      expectedCreator: str(ro.expectedCreator, "", 48), expectedX: str(ro.expectedX, "", 16).replace(/^@/, "").toLowerCase(),
      windowMin: num(ro.windowMin, d.rogue.windowMin, 1, 240), maxCoins: Math.round(num(ro.maxCoins, d.rogue.maxCoins, 1, 50)),
      perCoinSol: num(ro.perCoinSol, d.rogue.perCoinSol, 0.001, 100), budgetSol: num(ro.budgetSol, d.rogue.budgetSol, 0.001, 1000),
      stallSec: num(ro.stallSec, d.rogue.stallSec, 3, 3600), stallMinVolSol: num(ro.stallMinVolSol, d.rogue.stallMinVolSol, 0, 10_000),
      stopLossPct: num(ro.stopLossPct, d.rogue.stopLossPct, 1, 99), leaderAfterSec: num(ro.leaderAfterSec, d.rogue.leaderAfterSec, 0, 3600),
      keepTop: ro.keepTop === 0 || ro.keepTop === 1 || ro.keepTop === 2 ? ro.keepTop : d.rogue.keepTop, honeypot: bool(ro.honeypot, d.rogue.honeypot),
    },
    sources: { snipe: bool(obj(o.sources).snipe, d.sources.snipe), copy: bool(obj(o.sources).copy, d.sources.copy), launchOnPost: bool(obj(o.sources).launchOnPost, d.sources.launchOnPost) },
    concurrency: { lanes: Math.round(num(obj(o.concurrency).lanes, d.concurrency.lanes, 1, 5)), launches: Math.round(num(obj(o.concurrency).launches, d.concurrency.launches, 1, 3)) },
  };
}

export interface StrategyError { field: string; message: string }
/** Problems a save should refuse (beyond clamping). */
export function validateStrategy(s: StrategySettings, limits?: { perTradeMaxSol: number }): StrategyError[] {
  const e: StrategyError[] = [];
  const ev = s.entry.earlyVolume;
  if (ev.enabled && ev.minVolSol <= 0 && ev.minBuys <= 0 && ev.minBuyers <= 0) e.push({ field: "entry.earlyVolume", message: "Set at least one of volume, buys or buyers for the early-volume trigger." });
  if (s.entry.minMcapUsd !== null && s.entry.maxMcapUsd !== null && s.entry.minMcapUsd > s.entry.maxMcapUsd) e.push({ field: "entry.minMcapUsd", message: "Min market cap is above the max." });
  const sz = s.entry.size;
  if (limits && sz.mode === "fixed" && sz.sol > limits.perTradeMaxSol) e.push({ field: "entry.size.sol", message: `${sz.sol} SOL is above your per-trade max (${limits.perTradeMaxSol} SOL).` });
  if (limits && sz.mode === "pct" && sz.capSol > limits.perTradeMaxSol) e.push({ field: "entry.size.capSol", message: `The cap (${sz.capSol} SOL) is above your per-trade max (${limits.perTradeMaxSol} SOL).` });
  const tp = s.exits.takeProfit;
  for (let i = 1; i < tp.length; i++) if (tp[i].atMultiple <= tp[i - 1].atMultiple) e.push({ field: "exits.takeProfit", message: "Take-profit steps must go up." });
  const sb = s.exits.sellIntoBuys;
  if (sb.maxTipSol < sb.tipSol) e.push({ field: "exits.sellIntoBuys.maxTipSol", message: "The tip cap is below the starting tip." });
  const r = s.rogue;
  if (r.perCoinSol > r.budgetSol) e.push({ field: "rogue.perCoinSol", message: "The per-coin size is above the session budget." });
  if (limits && r.perCoinSol > limits.perTradeMaxSol) e.push({ field: "rogue.perCoinSol", message: `${r.perCoinSol} SOL per coin is above your per-trade max (${limits.perTradeMaxSol} SOL).` });
  if (s.mode === "rogue" && !r.ticker && !r.keywords.length) e.push({ field: "rogue.ticker", message: "Rogue mode needs a ticker or at least one name keyword." });
  if (r.expectedCreator && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.expectedCreator)) e.push({ field: "rogue.expectedCreator", message: "The expected creator must be a Solana address." });
  return e;
}

/** v19.1: the automatic sources switched off (the guardrails refuse their buys). Pulse is `entry.autoNewCoins`. */
export function sourcesOff(s: Pick<StrategySettings, "sources" | "entry">): TradeOrigin[] {
  return [...(s.sources.snipe ? [] : ["snipe" as const]), ...(s.sources.copy ? [] : ["copy" as const]), ...(s.entry.autoNewCoins ? [] : ["pulse" as const]), ...(s.sources.launchOnPost ? [] : ["launch-on-post" as const])];
}

/** The strategy's exits as the exit engine's spec (positions the strategy opens carry it). */
export function exitSpecOf(x: ExitSettings): ExitSpec {
  return {
    ...(x.takeProfit.length ? { takeProfit: x.takeProfit.map((t) => ({ ...t })) } : {}),
    ...(x.stopLossPct !== null ? { stopLossPct: x.stopLossPct } : {}),
    ...(x.trailingStopPct !== null ? { trailingStopPct: x.trailingStopPct } : {}),
    ...(x.timeoutMin !== null ? { timeoutMin: x.timeoutMin } : {}),
  };
}

// ---------------------------------------------------------------- export / import

export const exportStrategy = (s: StrategySettings): string => {
  const { mode: _m, rogueStartedAt: _r, ...rest } = s;
  return JSON.stringify({ kind: "vesk-strategy", ...rest }, null, 2);
};
/** Import from JSON text (an export, or a partial object). A running Rogue session is never started by an import. */
export function importStrategy(text: string, base?: StrategySettings): StrategySettings {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error("That isn't valid JSON."); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("Expected a JSON object.");
  const o = j as Record<string, unknown>;
  const merged = deepMerge(base ? JSON.parse(JSON.stringify(base)) : defaultStrategy(), o);
  const s = normalizeStrategy({ ...merged, mode: base?.mode ?? "normal", rogueStartedAt: base?.rogueStartedAt, preset: o.preset ?? "custom" });
  return s;
}
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) a[k] = deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>);
    else a[k] = v;
  }
  return a;
}
