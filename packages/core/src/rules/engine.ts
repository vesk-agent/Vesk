/**
 * The rules engine. Pure functions, no I/O, fully unit-tested.
 *
 *   signal ──matchSignal──▶ candidate mint ──(agent fetches market data)──▶ decideBuy ──▶ guardrails ──▶ executor
 *   price tick ──evaluateExit──▶ sell action (TP ladder, stop-loss, trailing stop, timeout)
 *   price tick ──evaluateOrders──▶ limit, stop-loss, trailing, DCA and TWAP fills (trade/orders.ts)
 */
import { detectMints, type CaMatch } from "../ca.js";
import type { LaunchEvent, MarketSnapshot, Position, Rule, Signal, XPost } from "../types.js";
import { normalizeHandle } from "./validate.js";

export type Match =
  | { match: true; mint: string; why: string; ca?: CaMatch }
  | { match: false; reason: string };

export type SkipCode =
  | "disabled" | "no-match" | "mcap-too-high" | "daily-max" | "cooldown" | "already-holding" | "no-market" | "liquidity" | "pair-unresolved";

export type Decision =
  | { ok: true; mint: string; amountSol: number; slippageBps: number; priorityFeeSol?: number; jitoTipSol?: number; venue: Rule["buy"]["venue"]; why: string }
  | { ok: false; code: SkipCode; reason: string };

export interface RuleCounters {
  /** Fills for this rule since 00:00 UTC. */
  buysToday: number;
  /** Last time this rule fired (ms). */
  lastFiredAt?: number;
  /** Mints already held in an open position. */
  holding: Set<string> | ((mint: string) => boolean);
}

const lc = (s: string) => s.toLowerCase();

// ---------- matching ----------

export function matchXPost(rule: Rule, post: XPost): Match {
  const t = rule.trigger;
  if (t.kind !== "x-post") return { match: false, reason: "not an X rule" };
  const handle = normalizeHandle(post.handle);
  if (!t.handles.map(normalizeHandle).includes(handle)) return { match: false, reason: `@${handle} is not on this rule` };
  if (post.isRepost && !t.includeReposts) return { match: false, reason: "repost (reposts are off for this rule)" };
  if (post.isReply && !t.includeReplies) return { match: false, reason: "reply (replies are off for this rule)" };

  const found = detectMints(post.text, post.urls);
  if (t.mode === "ca-in-post") {
    const inText = found.filter((m) => m.source === "text");
    if (inText.length === 0) return { match: false, reason: "no contract address in the post" };
    if (inText.length > 1 && (rule.multiCa ?? "skip") === "skip") return { match: false, reason: `${inText.length} addresses in one post (ambiguous, skipped)` };
    const ca = inText[0];
    if (ca.confidence < 0.3) return { match: false, reason: "address looks like a wallet, not a coin" };
    return { match: true, mint: ca.mint, why: `@${handle} posted a CA`, ca };
  }

  // keyword + link
  const text = lc(post.text);
  const kw = (t.keywords ?? []).map(lc).filter(Boolean).find((k) => text.includes(k));
  if (!kw) return { match: false, reason: "no keyword in the post" };
  const linked = found.filter((m) => m.source === "url" || m.source === "text");
  if (linked.length === 0) return { match: false, reason: `keyword "${kw}" but no coin link` };
  if (linked.length > 1 && (rule.multiCa ?? "skip") === "skip") return { match: false, reason: "several coins linked (ambiguous, skipped)" };
  const ca = linked[0];
  return { match: true, mint: ca.mint, why: `@${handle} said "${kw}" with a link`, ca };
}

export function matchLaunch(rule: Rule, ev: LaunchEvent): Match {
  const t = rule.trigger;
  if (t.kind !== "new-launch") return { match: false, reason: "not a launch rule" };
  const f = t.filters ?? {};
  const name = lc(`${ev.name} ${ev.symbol}`);
  if (f.blocklist?.some((b) => b.trim() && name.includes(lc(b.trim())))) return { match: false, reason: "name or ticker is on the blocklist" };
  if (f.nameIncludes?.length && !f.nameIncludes.some((k) => name.includes(lc(k)))) return { match: false, reason: "name doesn't match" };
  if (f.blockedCreators?.includes(ev.creator)) return { match: false, reason: "creator is blocked" };
  const devPct = ev.totalSupply > 0 ? (ev.devTokens / ev.totalSupply) * 100 : 100;
  if (f.maxDevHoldingPct !== undefined && devPct > f.maxDevHoldingPct)
    return { match: false, reason: `dev holds ${devPct.toFixed(1)}% (max ${f.maxDevHoldingPct}%)` };
  for (const s of f.requireSocials ?? []) if (!ev.socials[s]) return { match: false, reason: `no ${s === "x" ? "X account" : s} in metadata` };
  if (f.minLiquiditySol !== undefined && ev.liquiditySol < f.minLiquiditySol)
    return { match: false, reason: `liquidity ${ev.liquiditySol.toFixed(2)} SOL < ${f.minLiquiditySol}` };
  if (f.maxMcapUsd !== undefined && ev.mcapUsd > f.maxMcapUsd) return { match: false, reason: `mcap $${Math.round(ev.mcapUsd)} > $${f.maxMcapUsd}` };
  const rc = f.rugChecks;
  if (rc?.mintAuthorityRevoked && ev.mintAuthorityRevoked === false) return { match: false, reason: "mint authority not revoked" };
  if (rc?.freezeAuthorityRevoked && ev.freezeAuthorityRevoked === false) return { match: false, reason: "freeze authority not revoked" };
  if (rc?.maxTop10Pct !== undefined && ev.top10Pct !== undefined && ev.top10Pct > rc.maxTop10Pct)
    return { match: false, reason: `top 10 hold ${ev.top10Pct.toFixed(0)}%` };
  return { match: true, mint: ev.mint, why: `new launch ${ev.symbol} passed filters` };
}

export function matchSignal(rule: Rule, s: Signal): Match {
  if (!rule.enabled) return { match: false, reason: "rule is off" };
  if (s.kind === "x-post") return matchXPost(rule, s.post);
  if (s.kind === "new-launch") return matchLaunch(rule, s.launch);
  return rule.trigger.kind === "manual" ? { match: true, mint: s.mint, why: "manual" } : { match: false, reason: "manual signal" };
}

// ---------- deciding ----------

export function decideBuy(rule: Rule, m: Match, market: MarketSnapshot | null, c: RuleCounters, now = Date.now()): Decision {
  if (!rule.enabled) return { ok: false, code: "disabled", reason: "rule is off" };
  if (!m.match) return { ok: false, code: "no-match", reason: m.reason };
  if (m.ca?.isPair) return { ok: false, code: "pair-unresolved", reason: "link points at a pool; resolve the mint first" };
  const holding = typeof c.holding === "function" ? c.holding(m.mint) : c.holding.has(m.mint);
  if (holding) return { ok: false, code: "already-holding", reason: "already holding this coin" };
  if (c.buysToday >= rule.maxBuysPerDay) return { ok: false, code: "daily-max", reason: `rule hit its ${rule.maxBuysPerDay} buys for today` };
  if (rule.cooldownSec && c.lastFiredAt && now - c.lastFiredAt < rule.cooldownSec * 1000)
    return { ok: false, code: "cooldown", reason: `cooldown (${rule.cooldownSec}s)` };
  if (!market) return { ok: false, code: "no-market", reason: "no market data for this coin yet" };
  if (rule.buy.maxMcapUsd !== undefined && market.mcapUsd > rule.buy.maxMcapUsd)
    return { ok: false, code: "mcap-too-high", reason: `mcap $${fmtK(market.mcapUsd)} is above $${fmtK(rule.buy.maxMcapUsd)}` };
  return {
    ok: true,
    mint: m.mint,
    amountSol: rule.buy.amountSol,
    slippageBps: rule.buy.slippageBps,
    priorityFeeSol: rule.buy.priorityFeeSol,
    jitoTipSol: rule.buy.jitoTipSol,
    venue: rule.buy.venue,
    why: m.why,
  };
}

export function fmtK(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

// ---------- exits ----------

export type ExitAction = { kind: "tp" | "sl" | "trail" | "timeout" | "mcap" | "mcap-stop" | "timed" | "novol"; sellPct: number; step?: number; reason: string };

/** Market-cap ladder steps are stored in Position.tpDone as MCAP_STEP + index, next to take-profit indexes. */
export const MCAP_STEP = 1000;
/** Time-based sells are stored as TIME_STEP + index. */
export const TIME_STEP = 2000;
const usd = (n: number) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${+(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`);

/**
 * Decide whether an open position should (partly) sell at `priceSol`.
 * Order of precedence: stop-loss, trailing stop, timeout, then the lowest pending take-profit step.
 * Returns the updated highest price so the caller can persist it.
 */
export function evaluateExit(p: Position, x: Rule["exit"], priceSol: number, now = Date.now(), mcapUsd?: number, volSol?: number): { action: ExitAction | null; highest: number } {
  const highest = Math.max(p.highestPriceSol, priceSol);
  if (p.tokens <= 0) return { action: null, highest };
  const timed = timeStep(p, x, now);
  if (timed) return { action: timed, highest };
  // v26: no-volume, only when the caller measured the window (volSol given)
  const nv = x.noVolume;
  if (nv && volSol !== undefined && now - p.openedAt >= nv.windowSec * 1000 && volSol < nv.minVolSol)
    return { action: { kind: "novol", sellPct: 100, reason: `no volume: ${volSol} SOL in ${nv.windowSec} s (below ${nv.minVolSol})` }, highest };
  if (mcapUsd !== undefined && x.stopBelowMcapUsd !== undefined && mcapUsd < x.stopBelowMcapUsd)
    return { action: { kind: "mcap-stop", sellPct: 100, reason: `market cap ${usd(mcapUsd)} below ${usd(x.stopBelowMcapUsd)}` }, highest };
  if (p.avgEntryPriceSol <= 0) {
    // No entry price (e.g. a launch whose fill price isn't known yet): only time and market-cap exits apply.
    if (x.timeoutMin !== undefined && now - p.openedAt >= x.timeoutMin * 60_000) return { action: { kind: "timeout", sellPct: 100, reason: `held ${x.timeoutMin} min` }, highest };
    return { action: mcapUsd !== undefined ? mcapStep(p, x, mcapUsd) : null, highest };
  }
  const mult = priceSol / p.avgEntryPriceSol;
  if (x.stopLossPct !== undefined && mult <= 1 - x.stopLossPct / 100)
    return { action: { kind: "sl", sellPct: 100, reason: `stop-loss -${x.stopLossPct}% hit (${pct(mult)})` }, highest };
  if (x.trailingStopPct !== undefined && highest > p.avgEntryPriceSol && priceSol <= highest * (1 - x.trailingStopPct / 100))
    return { action: { kind: "trail", sellPct: 100, reason: `trailing stop ${x.trailingStopPct}% from high` }, highest };
  if (x.timeoutMin !== undefined && now - p.openedAt >= x.timeoutMin * 60_000)
    return { action: { kind: "timeout", sellPct: 100, reason: `held ${x.timeoutMin} min` }, highest };
  const steps = x.takeProfit ?? [];
  for (let i = 0; i < steps.length; i++) {
    if (p.tpDone.includes(i)) continue;
    if (mult >= steps[i].atMultiple)
      return { action: { kind: "tp", sellPct: steps[i].sellPct, step: i, reason: `take-profit ${steps[i].atMultiple}x hit, selling ${steps[i].sellPct}%` }, highest };
    break; // steps are ascending; later ones can't be hit if this one isn't
  }
  return { action: mcapUsd !== undefined ? mcapStep(p, x, mcapUsd) : null, highest };
}

/** The earliest due time-based sell that hasn't run yet. */
export function timeStep(p: Pick<Position, "tpDone" | "openedAt">, x: Rule["exit"], now = Date.now()): ExitAction | null {
  const t = x.timeSells ?? [];
  for (let i = 0; i < t.length; i++) {
    if (p.tpDone.includes(TIME_STEP + i)) continue;
    if (now - p.openedAt >= t[i].afterSec * 1000) return { kind: "timed", sellPct: t[i].sellPct, step: TIME_STEP + i, reason: `${t[i].afterSec} s after entry, selling ${t[i].sellPct}%` };
  }
  return null;
}

/** The lowest market-cap target that's been reached and not sold yet. */
function mcapStep(p: Position, x: Rule["exit"], mcapUsd: number): ExitAction | null {
  const t = x.mcapTargets ?? [];
  for (let i = 0; i < t.length; i++) {
    if (p.tpDone.includes(MCAP_STEP + i)) continue;
    if (mcapUsd >= t[i].atMcapUsd) return { kind: "mcap", sellPct: t[i].sellPct, step: MCAP_STEP + i, reason: `market cap ${usd(mcapUsd)} reached ${usd(t[i].atMcapUsd)}, selling ${t[i].sellPct}%` };
    break;
  }
  return null;
}

const pct = (mult: number) => `${mult >= 1 ? "+" : ""}${((mult - 1) * 100).toFixed(0)}%`;

/** Unrealised PnL in SOL and % for a position at `priceSol`. */
export function positionPnl(p: Position, priceSol: number): { valueSol: number; pnlSol: number; pnlPct: number } {
  const valueSol = p.tokens * priceSol;
  const pnlSol = valueSol + p.realizedSol - p.costSol;
  return { valueSol, pnlSol, pnlPct: p.costSol > 0 ? (pnlSol / p.costSol) * 100 : 0 };
}

// ---------- orders ----------
// Limit, stop-loss, trailing, DCA, TWAP and dev-sell orders live in trade/orders.ts (re-exported here).
export * from "../trade/orders.js";

/** UTC day key used for "per day" counters. */
export const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
