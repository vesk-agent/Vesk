/**
 * Copy decisions. Given one trade by a wallet you track, its settings and what Vesk knows about the coin:
 * copy it (and for how much), ask you, alert only, or skip it with the reason ("mcap $412k > max $250k").
 * Pure: the agent gathers the facts, the executor and its guardrails still decide whether a transaction is sent.
 *
 * Honesty: a copy can only start after their transaction is visible, so it lands after theirs (usually the same
 * or the next few slots, depending on your RPC / stream). Copying can't front-run the wallet you copy.
 */
import { effectiveProfile, usdShort, VENUE_LABEL, type CopyConfig, type CopyFilters, type CopyProfile, type CopyWallet } from "./settings.js";
import type { DetectSource, TargetTrade } from "./classify.js";

/** What Vesk knows about the coin at their trade. undefined = not available (never guessed). */
export interface CopyFacts {
  mcapUsd?: number;
  /** "their-trade": from their fill (PumpPortal's market cap or price × supply). "now": a snapshot after detection. */
  mcapSource?: "their-trade" | "now";
  liquiditySol?: number;
  ageSec?: number;
  devPct?: number;
  top10Pct?: number;
  bundledPct?: number;
  mintRevoked?: boolean;
  freezeRevoked?: boolean;
  socials?: { x?: boolean; telegram?: boolean; website?: boolean };
  name?: string;
  symbol?: string;
}

export interface CopyCounters {
  /** SOL copied today from this wallet, and in total. */
  spentWalletTodaySol: number;
  spentTotalTodaySol: number;
  /** Open positions that came from copies. */
  openCopies: number;
  /** Last copy of this coin (any wallet), ms. */
  lastCopyOfMintAt?: number;
  /** They bought this coin before (seen in the feed or in their pre-trade balance). */
  targetBoughtBefore: boolean;
  /** You already hold this coin. */
  holding: boolean;
  /** Blacklist hit for this coin (or its dev), as a reason. */
  blacklist?: string | null;
  now?: number;
}

export type CopySkipCode =
  | "off" | "wallet-off" | "buys-off" | "blacklist" | "venue" | "target-size" | "keyword" | "first-buy" | "holding"
  | "mcap-max" | "mcap-min" | "liquidity" | "age" | "dev" | "top10" | "bundled" | "audit" | "socials" | "data"
  | "cooldown" | "wallet-day" | "total-day" | "max-open" | "amount";

export type CopyDecision =
  | { ok: true; action: "copy" | "confirm" | "alert"; amountSol: number; why: string }
  | { ok: false; code: CopySkipCode; reason: string };

const sol = (n: number) => `${+n.toFixed(4)} SOL`;
const no = (code: CopySkipCode, reason: string): CopyDecision => ({ ok: false, code, reason });

/** SOL to spend on a copy of a buy of `theirSol`: the amount mode, then min/max, then the per-trade cap. */
export function copyAmount(p: CopyProfile, theirSol: number): number {
  const a = p.amount;
  const raw = a.mode === "fixed" ? a.value : a.mode === "pct" ? theirSol * (a.value / 100) : theirSol * a.value;
  const clamped = Math.min(Math.max(raw, a.minSol), a.maxSol, p.limits.maxSolPerTrade);
  return Math.floor(clamped * 1e6) / 1e6;
}

/** Which facts the filters need, so the agent fetches only those (each one costs RPC calls and time). */
export function factsNeeded(f: CopyFilters): Array<keyof CopyFacts> {
  const n = new Set<keyof CopyFacts>();
  if (f.minMcapUsd !== undefined || f.maxMcapUsd !== undefined) n.add("mcapUsd");
  if (f.minLiquiditySol !== undefined) n.add("liquiditySol");
  if (f.minAgeSec !== undefined || f.maxAgeSec !== undefined) n.add("ageSec");
  if (f.maxDevPct !== undefined) n.add("devPct");
  if (f.maxTop10Pct !== undefined) n.add("top10Pct");
  if (f.maxBundledPct !== undefined) n.add("bundledPct");
  if (f.mintRevoked) n.add("mintRevoked");
  if (f.freezeRevoked) n.add("freezeRevoked");
  if (f.requireSocials?.length) n.add("socials");
  if (f.include?.length || f.exclude?.length) { n.add("name"); n.add("symbol"); }
  return [...n];
}

/**
 * Filters only (no limits): the first one that fails, or null. Order: cheap and decisive first, the market cap
 * check before the holder checks.
 */
export function filterFail(p: CopyProfile, t: TargetTrade, x: CopyFacts, c: Pick<CopyCounters, "targetBoughtBefore" | "holding" | "blacklist">): CopyDecision | null {
  const f = p.filters;
  const missing = (what: string): CopyDecision | null => (f.missingData === "allow" ? null : no("data", `${what} unavailable (filter set; missing data skips)`));
  if (c.blacklist) return no("blacklist", c.blacklist);
  if (f.venues?.length && !f.venues.includes(t.venue)) return no("venue", `venue ${VENUE_LABEL[t.venue]} not in your list`);
  if (f.minTargetBuySol !== undefined && t.sol < f.minTargetBuySol) return no("target-size", `their buy ${sol(t.sol)} < min ${sol(f.minTargetBuySol)}`);
  if (f.firstBuyOnly && c.targetBoughtBefore) return no("first-buy", "not their first buy of this coin (first buy only)");
  if (f.firstBuyOnly && c.holding) return no("holding", "you already hold this coin (first buy only)");
  const text = `${x.name ?? ""} ${x.symbol ?? ""}`.toLowerCase();
  if (f.include?.length || f.exclude?.length) {
    if (!x.name && !x.symbol) { const m = missing("name/ticker"); if (m) return m; }
    else {
      if (f.include?.length && !f.include.some((k) => text.includes(k.toLowerCase()))) return no("keyword", `name/ticker has none of ${f.include.join(", ")}`);
      const bad = f.exclude?.find((k) => text.includes(k.toLowerCase()));
      if (bad) return no("keyword", `name/ticker contains "${bad}"`);
    }
  }
  if (f.maxMcapUsd !== undefined || f.minMcapUsd !== undefined) {
    if (x.mcapUsd === undefined) { const m = missing("market cap"); if (m) return m; }
    else {
      const at = x.mcapSource === "now" ? " (now)" : "";
      if (f.maxMcapUsd !== undefined && x.mcapUsd > f.maxMcapUsd) return no("mcap-max", `mcap ${usdShort(x.mcapUsd)}${at} > max ${usdShort(f.maxMcapUsd)}`);
      if (f.minMcapUsd !== undefined && x.mcapUsd < f.minMcapUsd) return no("mcap-min", `mcap ${usdShort(x.mcapUsd)}${at} < min ${usdShort(f.minMcapUsd)}`);
    }
  }
  if (f.minLiquiditySol !== undefined) {
    if (x.liquiditySol === undefined) { const m = missing("liquidity"); if (m) return m; }
    else if (x.liquiditySol < f.minLiquiditySol) return no("liquidity", `liquidity ${sol(x.liquiditySol)} < min ${sol(f.minLiquiditySol)}`);
  }
  if (f.minAgeSec !== undefined || f.maxAgeSec !== undefined) {
    if (x.ageSec === undefined) { const m = missing("token age"); if (m) return m; }
    else {
      if (f.minAgeSec !== undefined && x.ageSec < f.minAgeSec) return no("age", `age ${Math.round(x.ageSec)} s < min ${f.minAgeSec} s`);
      if (f.maxAgeSec !== undefined && x.ageSec > f.maxAgeSec) return no("age", `age ${Math.round(x.ageSec)} s > max ${f.maxAgeSec} s`);
    }
  }
  const pctCheck = (k: "devPct" | "top10Pct" | "bundledPct", max: number | undefined, label: string, code: CopySkipCode): CopyDecision | null => {
    if (max === undefined) return null;
    const v = x[k];
    if (v === undefined) return missing(label);
    return v > max ? no(code, `${label} ${+v.toFixed(1)}% > max ${max}%`) : null;
  };
  const pc = pctCheck("devPct", f.maxDevPct, "dev holds", "dev") ?? pctCheck("top10Pct", f.maxTop10Pct, "top 10", "top10") ?? pctCheck("bundledPct", f.maxBundledPct, "bundled", "bundled");
  if (pc) return pc;
  if (f.mintRevoked) { if (x.mintRevoked === undefined) { const m = missing("mint authority"); if (m) return m; } else if (!x.mintRevoked) return no("audit", "mint authority not revoked"); }
  if (f.freezeRevoked) { if (x.freezeRevoked === undefined) { const m = missing("freeze authority"); if (m) return m; } else if (!x.freezeRevoked) return no("audit", "freeze authority not revoked"); }
  if (f.requireSocials?.length) {
    if (!x.socials) { const m = missing("socials"); if (m) return m; }
    else { const miss = f.requireSocials.filter((s) => !x.socials![s]); if (miss.length) return no("socials", `no ${miss.map((s) => (s === "x" ? "X" : s)).join(", ")} link`); }
  }
  return null;
}

/** Decide on a buy by a tracked wallet. */
export function decideCopy(cfg: Pick<CopyConfig, "enabled" | "defaults">, w: CopyWallet, t: TargetTrade, x: CopyFacts, c: CopyCounters): CopyDecision {
  if (!cfg.enabled) return no("off", "copy trading is off");
  if (!w.enabled) return no("wallet-off", `${w.label} is switched off`);
  const p = effectiveProfile(cfg.defaults, w);
  if (!p.buys) return no("buys-off", "copying buys is off for this wallet");
  const ff = filterFail(p, t, x, c);
  if (ff) return ff;
  const now = c.now ?? Date.now();
  if (c.lastCopyOfMintAt !== undefined && now - c.lastCopyOfMintAt < p.limits.tokenCooldownSec * 1000)
    return no("cooldown", `copied this coin ${Math.round((now - c.lastCopyOfMintAt) / 1000)} s ago (cooldown ${p.limits.tokenCooldownSec} s)`);
  const amt = copyAmount(p, t.sol);
  if (!(amt > 0)) return no("amount", "copy size rounds to 0");
  if (!c.holding && c.openCopies >= p.limits.maxOpenCopies) return no("max-open", `${c.openCopies} copied positions open (max ${p.limits.maxOpenCopies})`);
  if (c.spentWalletTodaySol + amt > p.limits.maxSolPerWalletDay + 1e-9) return no("wallet-day", `${sol(c.spentWalletTodaySol)} copied from ${w.label} today (max ${sol(p.limits.maxSolPerWalletDay)})`);
  if (c.spentTotalTodaySol + amt > p.limits.maxSolTotalDay + 1e-9) return no("total-day", `${sol(c.spentTotalTodaySol)} copied today (max ${sol(p.limits.maxSolTotalDay)})`);
  const why = `copy ${w.label}: ${amountWhy(p, t.sol, amt)}`;
  return { ok: true, action: p.mode === "auto" ? "copy" : p.mode, amountSol: amt, why };
}

function amountWhy(p: CopyProfile, theirSol: number, amt: number): string {
  const a = p.amount;
  const base = a.mode === "fixed" ? `${sol(amt)}` : `${a.mode === "pct" ? `${a.value}%` : `${a.value}×`} of their ${sol(theirSol)} = ${sol(amt)}`;
  return base;
}

export type SellDecision = { ok: true; pct: number; why: string } | { ok: false; reason: string };

/** They sold: mirror their %, sell everything, or nothing. Only positions copied from that wallet are touched. */
export function decideSell(cfg: Pick<CopyConfig, "enabled" | "defaults">, w: CopyWallet, t: TargetTrade, ours: { tokens: number } | undefined): SellDecision {
  if (!cfg.enabled) return { ok: false, reason: "copy trading is off" };
  if (!w.enabled) return { ok: false, reason: `${w.label} is switched off` };
  const p = effectiveProfile(cfg.defaults, w);
  if (p.sells === "off") return { ok: false, reason: "copying sells is off for this wallet" };
  if (!ours || ours.tokens <= 0) return { ok: false, reason: "no position copied from this wallet in this coin" };
  if (p.sells === "all") return { ok: true, pct: 100, why: `${w.label} sold${t.sellPct !== undefined ? ` ${Math.round(t.sellPct)}%` : ""}: selling all (sell all when they sell)` };
  if (t.sellPct === undefined) {
    if (t.tokensAfter === 0) return { ok: true, pct: 100, why: `${w.label} sold everything: mirroring 100%` };
    return { ok: false, reason: "their sell % is unknown (their balance before the sell isn't in the data)" };
  }
  const pct = Math.max(1, Math.min(100, Math.round(t.sellPct)));
  return { ok: true, pct, why: `${w.label} sold ${pct}%: mirroring ${pct}%` };
}

// ---------- dedupe ----------

/** Signatures already handled (bounded). Two sources often deliver the same trade; the first one wins. */
export class SigDedupe {
  private set = new Set<string>();
  private ring: string[] = [];
  constructor(private max = 20_000) {}
  /** true the first time a signature is seen. */
  first(sig: string): boolean {
    if (!sig || this.set.has(sig)) return false;
    this.set.add(sig);
    this.ring.push(sig);
    if (this.ring.length > this.max) this.set.delete(this.ring.shift()!);
    return true;
  }
  has(sig: string) { return this.set.has(sig); }
  get size() { return this.set.size; }
}

// ---------- the feed ----------

export interface CopyLatency {
  /** Their block time (1 s resolution, from the chain; RPC sources only). */
  blockTimeMs?: number;
  targetSlot?: number;
  detectedAt: number;
  decidedAt?: number;
  sentAt?: number;
  landedAt?: number;
  ourSlot?: number;
}

export type CopyStatus = "copied" | "skipped" | "pending" | "alert" | "failed" | "expired" | "sold";

export interface CopyFeedItem {
  id: string;
  at: number;
  wallet: string;
  label: string;
  side: "buy" | "sell";
  mint: string;
  symbol?: string;
  theirSol: number;
  theirSig: string;
  sellPct?: number;
  venue: TargetTrade["venue"];
  source: DetectSource;
  mcapUsd?: number;
  status: CopyStatus;
  /** Skip / failure reason, or what was done. */
  reason: string;
  amountSol?: number;
  ourPct?: number;
  ourSig?: string;
  latency: CopyLatency;
  manual?: boolean;
}

export const COPY_FEED_MAX = 1000;

/** detected → landed (ms), their block → detected (ms, block time has 1 s resolution), and slots behind. */
export function latencyOf(l: CopyLatency): { detectToLandMs?: number; blockToDetectMs?: number; slotsBehind?: number } {
  return {
    detectToLandMs: l.landedAt !== undefined ? l.landedAt - l.detectedAt : undefined,
    blockToDetectMs: l.blockTimeMs !== undefined ? Math.max(0, l.detectedAt - l.blockTimeMs) : undefined,
    slotsBehind: l.ourSlot !== undefined && l.targetSlot !== undefined ? l.ourSlot - l.targetSlot : undefined,
  };
}

/** One feed line, e.g. "copied 0.1 SOL in 180 ms" / "skipped: mcap $412k > max $250k". */
export function feedLine(i: CopyFeedItem): string {
  const l = latencyOf(i.latency);
  if (i.status === "copied") return i.side === "buy" ? `copied ${sol(i.amountSol ?? 0)}${l.detectToLandMs !== undefined ? ` in ${l.detectToLandMs} ms` : ""}` : `sold ${i.ourPct ?? 0}%${l.detectToLandMs !== undefined ? ` in ${l.detectToLandMs} ms` : ""}`;
  if (i.status === "skipped") return `skipped: ${i.reason}`;
  if (i.status === "pending") return `waiting for you: ${i.reason}`;
  if (i.status === "alert") return `alert: ${i.reason}`;
  if (i.status === "failed") return `failed: ${i.reason}`;
  if (i.status === "expired") return "expired without a decision";
  return i.reason;
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** SOL copied today from one wallet / in total (buys that were sent). */
export function copySpentToday(feed: CopyFeedItem[], now = Date.now(), wallet?: string): number {
  const d = dayOf(now);
  return +feed.filter((i) => i.side === "buy" && i.status === "copied" && dayOf(i.at) === d && (!wallet || i.wallet === wallet)).reduce((s, i) => s + (i.amountSol ?? 0), 0).toFixed(9);
}

export interface CopyPositionLike { mint: string; tokens: number; costSol: number; realizedSol: number; closedAt?: number; copiedFrom?: { wallet: string } }

export interface CopyWalletStats {
  wallet: string;
  copiesToday: number;
  skippedToday: number;
  /** Realized PnL of closed copies + (value − cost) of open ones when a price is given. SOL. */
  pnlSol: number;
  /** Closed copies that made money / closed copies. null = none closed yet. */
  winRate: number | null;
  closed: number;
  open: number;
  lastActivityAt?: number;
  /** Median detected → landed of today's copies, ms. */
  p50LatencyMs?: number;
}

export function copyStats(feed: CopyFeedItem[], open: CopyPositionLike[], closed: CopyPositionLike[], now = Date.now(), valueOf?: (mint: string, tokens: number) => number | undefined): Record<string, CopyWalletStats> {
  const d = dayOf(now);
  const out: Record<string, CopyWalletStats> = {};
  const get = (w: string) => (out[w] ??= { wallet: w, copiesToday: 0, skippedToday: 0, pnlSol: 0, winRate: null, closed: 0, open: 0 });
  const lat: Record<string, number[]> = {};
  for (const i of feed) {
    const s = get(i.wallet);
    s.lastActivityAt = Math.max(s.lastActivityAt ?? 0, i.at);
    if (dayOf(i.at) !== d) continue;
    if (i.status === "copied" && i.side === "buy") {
      s.copiesToday++;
      const l = latencyOf(i.latency).detectToLandMs;
      if (l !== undefined) (lat[i.wallet] ??= []).push(l);
    }
    if (i.status === "skipped") s.skippedToday++;
  }
  const wins: Record<string, number> = {};
  for (const p of closed) {
    if (!p.copiedFrom) continue;
    const s = get(p.copiedFrom.wallet);
    s.closed++;
    const pnl = p.realizedSol - p.costSol;
    s.pnlSol += pnl;
    if (pnl > 0) wins[s.wallet] = (wins[s.wallet] ?? 0) + 1;
  }
  for (const p of open) {
    if (!p.copiedFrom) continue;
    const s = get(p.copiedFrom.wallet);
    s.open++;
    const v = valueOf?.(p.mint, p.tokens);
    // Unrealized PnL needs a price; without one, only closed copies count.
    if (v !== undefined) s.pnlSol += v + p.realizedSol - p.costSol;
  }
  for (const s of Object.values(out)) {
    s.pnlSol = +s.pnlSol.toFixed(6);
    s.winRate = s.closed ? +((wins[s.wallet] ?? 0) / s.closed).toFixed(3) : null;
    const l = (lat[s.wallet] ?? []).sort((a, b) => a - b);
    if (l.length) s.p50LatencyMs = l[Math.floor(l.length / 2)];
  }
  return out;
}

/** Pending copies (Confirm mode) expire after this long: the price has moved on by then. */
export const COPY_CONFIRM_TTL_MS = 60_000;

export interface PendingCopy {
  id: string;
  createdAt: number;
  expiresAt: number;
  wallet: string;
  label: string;
  trade: TargetTrade;
  amountSol: number;
  why: string;
  mcapUsd?: number;
}

export const pendingCopyText = (p: PendingCopy) =>
  `Copy ${p.label}? They bought ${sol(p.trade.sol)} of ${p.trade.symbol ?? p.trade.mint.slice(0, 4) + "…"}${p.mcapUsd !== undefined ? ` at ${usdShort(p.mcapUsd)} mcap` : ""} on ${VENUE_LABEL[p.trade.venue]}. Copy with ${sol(p.amountSol)}? Expires in ${Math.round((p.expiresAt - p.createdAt) / 1000)} s.`;
