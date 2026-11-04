/** Validation for rules coming from config files, the chat parser, the panel or MCP tool calls. */
import type { BuySpec, ExitSpec, LaunchFilters, Limits, Rule, Trigger } from "../types.js";

export const BOUNDS = {
  amountSol: { min: 0.001, max: 100 },
  slippageBps: { min: 1, max: 5000 },
  priorityFeeSol: { max: 0.1 },
  jitoTipSol: { max: 0.1 },
  maxBuysPerDay: { min: 1, max: 200 },
  tpMultiple: { min: 1.01, max: 1000 },
  pct: { min: 1, max: 100 },
  stopLossPct: { min: 1, max: 99 },
  cooldownSec: { max: 86_400 },
  handles: { max: 50 },
} as const;

export const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

export interface FieldError {
  field: string;
  message: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/[/?#].*$/, "").toLowerCase();
}

function trigger(t: Trigger | undefined, e: FieldError[]): void {
  if (!t || typeof t !== "object") {
    e.push({ field: "trigger", message: "A rule needs a trigger." });
    return;
  }
  if (t.kind === "x-post") {
    if (!Array.isArray(t.handles) || t.handles.length === 0) e.push({ field: "trigger.handles", message: "Add at least one X account." });
    else if (t.handles.length > BOUNDS.handles.max) e.push({ field: "trigger.handles", message: `At most ${BOUNDS.handles.max} accounts per rule.` });
    else for (const h of t.handles) if (!X_HANDLE.test(normalizeHandle(h))) e.push({ field: "trigger.handles", message: `"${h}" is not a valid X handle.` });
    if (t.mode !== "ca-in-post" && t.mode !== "keyword-link") e.push({ field: "trigger.mode", message: 'Mode must be "ca-in-post" or "keyword-link".' });
    if (t.mode === "keyword-link" && (!t.keywords || t.keywords.filter((k) => k.trim()).length === 0))
      e.push({ field: "trigger.keywords", message: "Keyword + link mode needs at least one keyword." });
  } else if (t.kind === "new-launch") {
    filters(t.filters ?? {}, e);
  } else if (t.kind !== "manual") {
    e.push({ field: "trigger.kind", message: "Unknown trigger." });
  }
}

function filters(f: LaunchFilters, e: FieldError[]): void {
  if (f.maxDevHoldingPct !== undefined && (!num(f.maxDevHoldingPct) || f.maxDevHoldingPct < 0 || f.maxDevHoldingPct > 100))
    e.push({ field: "trigger.filters.maxDevHoldingPct", message: "Dev holding must be 0-100%." });
  if (f.minLiquiditySol !== undefined && (!num(f.minLiquiditySol) || f.minLiquiditySol < 0))
    e.push({ field: "trigger.filters.minLiquiditySol", message: "Liquidity must be 0 or more." });
  if (f.maxMcapUsd !== undefined && (!num(f.maxMcapUsd) || f.maxMcapUsd <= 0))
    e.push({ field: "trigger.filters.maxMcapUsd", message: "Max market cap must be above 0." });
  const top = f.rugChecks?.maxTop10Pct;
  if (top !== undefined && (!num(top) || top <= 0 || top > 100)) e.push({ field: "trigger.filters.rugChecks.maxTop10Pct", message: "Top-10 share must be 1-100%." });
}

function buy(b: BuySpec | undefined, e: FieldError[], limits?: Limits): void {
  if (!b) {
    e.push({ field: "buy", message: "A rule needs a buy size." });
    return;
  }
  if (!num(b.amountSol) || b.amountSol < BOUNDS.amountSol.min || b.amountSol > BOUNDS.amountSol.max)
    e.push({ field: "buy.amountSol", message: `Amount must be ${BOUNDS.amountSol.min}-${BOUNDS.amountSol.max} SOL.` });
  else if (limits && b.amountSol > limits.perTradeMaxSol)
    e.push({ field: "buy.amountSol", message: `Above your per-trade max of ${limits.perTradeMaxSol} SOL (Limits & safety).` });
  if (!num(b.slippageBps) || b.slippageBps < BOUNDS.slippageBps.min || b.slippageBps > BOUNDS.slippageBps.max)
    e.push({ field: "buy.slippageBps", message: "Slippage must be 0.01%-50%." });
  if (b.maxMcapUsd !== undefined && (!num(b.maxMcapUsd) || b.maxMcapUsd <= 0)) e.push({ field: "buy.maxMcapUsd", message: "Max market cap must be above 0." });
  if (b.priorityFeeSol !== undefined && (!num(b.priorityFeeSol) || b.priorityFeeSol < 0 || b.priorityFeeSol > BOUNDS.priorityFeeSol.max))
    e.push({ field: "buy.priorityFeeSol", message: `Priority fee must be 0-${BOUNDS.priorityFeeSol.max} SOL.` });
  if (b.jitoTipSol !== undefined && (!num(b.jitoTipSol) || b.jitoTipSol < 0 || b.jitoTipSol > BOUNDS.jitoTipSol.max))
    e.push({ field: "buy.jitoTipSol", message: `Jito tip must be 0-${BOUNDS.jitoTipSol.max} SOL.` });
  if (!["auto", "pumpfun", "jupiter"].includes(b.venue)) e.push({ field: "buy.venue", message: "Venue must be auto, pumpfun or jupiter." });
}

export function validateExit(x: ExitSpec | undefined): FieldError[] {
  const e: FieldError[] = [];
  exit(x, e);
  return e;
}

function exit(x: ExitSpec | undefined, e: FieldError[]): void {
  if (!x) return;
  if (x.takeProfit) {
    let last = 1;
    x.takeProfit.forEach((s, i) => {
      if (!num(s.atMultiple) || s.atMultiple < BOUNDS.tpMultiple.min || s.atMultiple > BOUNDS.tpMultiple.max)
        e.push({ field: `exit.takeProfit.${i}.atMultiple`, message: "Take-profit must be above 1x." });
      else if (s.atMultiple <= last) e.push({ field: `exit.takeProfit.${i}.atMultiple`, message: "Take-profit steps must go up." });
      else last = s.atMultiple;
      if (!num(s.sellPct) || s.sellPct < BOUNDS.pct.min || s.sellPct > BOUNDS.pct.max)
        e.push({ field: `exit.takeProfit.${i}.sellPct`, message: "Sell size must be 1-100%." });
    });
  }
  if (x.stopLossPct !== undefined && (!num(x.stopLossPct) || x.stopLossPct < BOUNDS.stopLossPct.min || x.stopLossPct > BOUNDS.stopLossPct.max))
    e.push({ field: "exit.stopLossPct", message: "Stop-loss must be 1-99%." });
  if (x.trailingStopPct !== undefined && (!num(x.trailingStopPct) || x.trailingStopPct < 1 || x.trailingStopPct > 99))
    e.push({ field: "exit.trailingStopPct", message: "Trailing stop must be 1-99%." });
  if (x.timeoutMin !== undefined && (!num(x.timeoutMin) || x.timeoutMin < 1)) e.push({ field: "exit.timeoutMin", message: "Timeout must be at least 1 minute." });
  if (x.noVolume && (!num(x.noVolume.windowSec) || x.noVolume.windowSec < 5 || x.noVolume.windowSec > 3600)) e.push({ field: "exit.noVolume", message: "No-volume window: 5-3600 seconds." });
  if (x.noVolume && (!num(x.noVolume.minVolSol) || x.noVolume.minVolSol <= 0)) e.push({ field: "exit.noVolume", message: "No-volume threshold must be above 0 SOL." });
  if (x.mcapTargets) {
    let last = 0;
    x.mcapTargets.forEach((t, i) => {
      if (!num(t.atMcapUsd) || t.atMcapUsd < 1000 || t.atMcapUsd > 1e11) e.push({ field: `exit.mcapTargets.${i}.atMcapUsd`, message: "Market-cap target must be at least $1k." });
      else if (t.atMcapUsd <= last) e.push({ field: `exit.mcapTargets.${i}.atMcapUsd`, message: "Market-cap targets must go up." });
      else last = t.atMcapUsd;
      if (!num(t.sellPct) || t.sellPct < 1 || t.sellPct > 100) e.push({ field: `exit.mcapTargets.${i}.sellPct`, message: "Sell size must be 1-100%." });
    });
    if (x.mcapTargets.length > 6) e.push({ field: "exit.mcapTargets", message: "At most 6 market-cap targets." });
  }
  if (x.timeSells) {
    if (x.timeSells.length > 4) e.push({ field: "exit.timeSells", message: "At most 4 timed sells." });
    let last = -1;
    x.timeSells.forEach((t, i) => {
      if (!num(t.afterSec) || t.afterSec < 1 || t.afterSec > 86_400) e.push({ field: `exit.timeSells.${i}.afterSec`, message: "Timed sells: 1 s to 24 h." });
      else if (t.afterSec <= last) e.push({ field: `exit.timeSells.${i}.afterSec`, message: "Timed sells must go up." });
      else last = t.afterSec;
      if (!num(t.sellPct) || t.sellPct < 1 || t.sellPct > 100) e.push({ field: `exit.timeSells.${i}.sellPct`, message: "Sell size must be 1-100%." });
    });
  }
  if (x.stopBelowMcapUsd !== undefined) {
    if (!num(x.stopBelowMcapUsd) || x.stopBelowMcapUsd < 0) e.push({ field: "exit.stopBelowMcapUsd", message: "Market-cap stop must be a positive amount." });
    else if (x.mcapTargets?.length && x.stopBelowMcapUsd >= x.mcapTargets[0].atMcapUsd) e.push({ field: "exit.stopBelowMcapUsd", message: "The stop must be below your first target." });
  }
}

export function validateRule(r: Partial<Rule>, limits?: Limits): FieldError[] {
  const e: FieldError[] = [];
  if (!r.name || !r.name.trim()) e.push({ field: "name", message: "Give the rule a name." });
  else if (r.name.length > 60) e.push({ field: "name", message: "Keep the name under 60 characters." });
  trigger(r.trigger, e);
  buy(r.buy, e, limits);
  exit(r.exit, e);
  if (!num(r.maxBuysPerDay) || r.maxBuysPerDay < BOUNDS.maxBuysPerDay.min || r.maxBuysPerDay > BOUNDS.maxBuysPerDay.max)
    e.push({ field: "maxBuysPerDay", message: `Max buys per day must be ${BOUNDS.maxBuysPerDay.min}-${BOUNDS.maxBuysPerDay.max}.` });
  if (r.cooldownSec !== undefined && (!num(r.cooldownSec) || r.cooldownSec < 0 || r.cooldownSec > BOUNDS.cooldownSec.max))
    e.push({ field: "cooldownSec", message: "Cooldown must be 0-86400 seconds." });
  return e;
}

export function validateLimits(l: Partial<Limits>): FieldError[] {
  const e: FieldError[] = [];
  const pos = (k: keyof Limits, label: string, max: number) => {
    const v = l[k];
    if (!num(v) || v < 0 || v > max) e.push({ field: k, message: `${label} must be 0-${max}.` });
  };
  pos("perTradeMaxSol", "Per-trade max", 100);
  pos("dailySpendCapSol", "Daily spend cap", 1000);
  pos("maxOpenPositions", "Max open positions", 100);
  pos("maxBuysPerDay", "Max buys per day", 500);
  pos("minSolReserve", "SOL reserve", 10);
  if (l.maxBuysPerMinute !== undefined && (!num(l.maxBuysPerMinute) || l.maxBuysPerMinute < 1 || l.maxBuysPerMinute > 120)) e.push({ field: "maxBuysPerMinute", message: "Max buys per minute must be 1-120." });
  if (num(l.perTradeMaxSol) && num(l.dailySpendCapSol) && l.perTradeMaxSol > l.dailySpendCapSol)
    e.push({ field: "perTradeMaxSol", message: "Per-trade max can't be above the daily cap." });
  return e;
}

/** Sensible defaults used by the CLI, the chat parser and the panel's "New rule" form. */
export function defaultRule(partial: Partial<Rule> = {}): Rule {
  const now = new Date().toISOString();
  return {
    id: partial.id ?? `r_${Math.random().toString(36).slice(2, 10)}`,
    name: partial.name ?? "New rule",
    enabled: partial.enabled ?? false,
    trigger: partial.trigger ?? { kind: "x-post", handles: [], mode: "ca-in-post" },
    buy: { amountSol: 0.1, slippageBps: 1500, priorityFeeSol: 0.0005, venue: "auto", ...partial.buy },
    exit: partial.exit ?? { takeProfit: [{ atMultiple: 2, sellPct: 50 }], stopLossPct: 35 },
    maxBuysPerDay: partial.maxBuysPerDay ?? 3,
    cooldownSec: partial.cooldownSec ?? 30,
    multiCa: partial.multiCa ?? "skip",
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
  };
}
