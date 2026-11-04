/**
 * The copy trader: detection → facts → decision → executor, for the self-hosted agent (24/7).
 *
 *   PumpPortal account trades ┐
 *   RPC logs + getTransaction ├─ dedupe ─ their buy  ─ facts (only what filters need) ─ decideCopy ─┬ auto    → executor.buy (guardrails, limits, blacklist)
 *   Helius (optional)         ┘           their sell ─ decideSell (positions copied from them)      ├ confirm → pending → Copy / Skip (Telegram, panel, CLI)
 *                                                                                                  └ alert   → feed only
 * Every trade seen lands in the copy feed with its status and reason, and timings (detected → sent → landed, and
 * their slot vs ours once both are known). Copies buy from the one active trading wallet; there is no
 * multi-wallet copy buying, and the multi-wallet / wash-trade guardrails still apply.
 */
import { blacklistHit, type BlacklistIndex } from "../watch/blacklist.js";
import type { Executor } from "../trade/executor.js";
import type { ExecParams, PresetId } from "../trade/settings.js";
import type { Rpc } from "../rpc.js";
import type { State } from "../state.js";
import type { ExitSpec } from "../types.js";
import type { TargetTrade } from "./classify.js";
import { CopyDetector, type SourceStatus } from "./detect.js";
import {
  COPY_CONFIRM_TTL_MS, COPY_FEED_MAX, copySpentToday, copyStats, decideCopy, decideSell, factsNeeded, feedLine, pendingCopyText, copyAmount,
  type CopyDecision, type CopyFacts, type CopyFeedItem, type PendingCopy,
} from "./engine.js";
import { effectiveProfile, normalizeCopyConfig, shortAddr, type CopyConfig, type CopyProfile, type CopyWallet } from "./settings.js";
import { CoinFacts } from "./facts.js";

export interface CopyTraderDeps {
  rpc: Rpc;
  state: State;
  /** The copy config as stored (rules.json → copy). */
  config: () => unknown;
  executor: () => Executor;
  address: () => string;
  tradeParams: (side: "buy" | "sell", id?: PresetId) => Promise<ExecParams>;
  blacklist: () => BlacklistIndex;
  /** Paused agents don't open copies; mirrored sells (exits) still run. */
  paused: () => boolean;
  log?: (kind: "status" | "error" | "skip" | "signal", message: string, mint?: string) => void;
  /** URL for the optional Helius adapter (from the keystore). */
  adapterUrl?: () => string | undefined;
  /** Timed sells need second precision (the 3 s exit loop is the safety net). */
  scheduleTimedSells?: (mint: string, exit: ExitSpec) => void;
  solUsd?: () => Promise<number>;
  /** Called for every new or updated feed item (Telegram, the panel report, `vesk copy feed --follow`). */
  onFeed?: (i: CopyFeedItem) => void;
  onPending?: (p: PendingCopy) => void;
}

const rid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CopyTrader {
  detector?: CopyDetector;
  readonly facts: CoinFacts;
  private key = "";
  private queue = new Map<string, Promise<void>>();
  private listeners = new Set<(i: CopyFeedItem) => void>();
  /** Every new or updated feed item (CLI `copy watch`, Telegram). Returns an unsubscribe. */
  subscribe(fn: (i: CopyFeedItem) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  constructor(private d: CopyTraderDeps) {
    this.facts = new CoinFacts(d.rpc, { solUsd: d.solUsd });
  }

  config(): CopyConfig { return normalizeCopyConfig(this.d.config()); }
  get feed() { return this.d.state.data.copyFeed; }
  get pending() { return this.d.state.data.copyPending; }

  private activeWallets(c = this.config()) { return c.enabled ? c.wallets.filter((w) => w.enabled).map((w) => w.address) : []; }

  /** Start, update or stop detection to match the config. Cheap to call often. */
  sync() {
    const c = this.config();
    const wallets = this.activeWallets(c);
    const s = c.sources;
    const key = JSON.stringify([s.pumpportal, s.rpc, s.rpcCommitment, s.adapter]);
    if (!wallets.length) { if (this.detector) { this.detector.stop(); this.detector = undefined; this.d.log?.("status", "Copy trading idle: no wallets switched on"); } return; }
    if (this.detector && key !== this.key) { this.detector.stop(); this.detector = undefined; }
    if (!this.detector) {
      this.key = key;
      this.detector = new CopyDetector({
        rpc: this.d.rpc, pumpportal: s.pumpportal, rpcLogs: s.rpc, commitment: s.rpcCommitment,
        adapter: s.adapter !== "none" ? { kind: s.adapter, url: this.d.adapterUrl?.() } : undefined,
        onTrade: (t) => void this.onTrade(t), onError: (e) => this.d.log?.("error", `Copy: ${e.message}`),
      });
      this.detector.start(wallets);
      const via = [s.pumpportal && "PumpPortal", s.rpc && "your RPC websocket", s.adapter !== "none" && s.adapter].filter(Boolean).join(" + ");
      this.d.log?.("status", `Copy trading: watching ${wallets.length} wallet${wallets.length === 1 ? "" : "s"} via ${via}`);
    } else this.detector.setWallets(wallets);
  }

  stop() { this.detector?.stop(); this.detector = undefined; }
  status(): SourceStatus[] { return this.detector?.status() ?? []; }

  private push(i: CopyFeedItem) {
    const f = this.feed;
    f.push(i);
    if (f.length > COPY_FEED_MAX) f.splice(0, f.length - COPY_FEED_MAX);
    this.d.onFeed?.(i);
    for (const l of this.listeners) l(i);
    void this.d.state.save();
  }
  private update(i: CopyFeedItem, patch: Partial<CopyFeedItem>) {
    Object.assign(i, patch);
    this.d.onFeed?.(i);
    for (const l of this.listeners) l(i);
    void this.d.state.save();
  }

  private item(t: TargetTrade, w: CopyWallet, x: Partial<CopyFacts>): CopyFeedItem {
    return {
      id: rid(), at: Date.now(), wallet: w.address, label: w.label, side: t.side, mint: t.mint, symbol: t.symbol ?? x.symbol, theirSol: t.sol, theirSig: t.signature,
      sellPct: t.sellPct, venue: t.venue, source: t.source, mcapUsd: x.mcapUsd, status: "skipped", reason: "", latency: { detectedAt: t.detectedAt, blockTimeMs: t.blockTimeMs, targetSlot: t.slot },
    };
  }

  /** One trade by a tracked wallet. Trades on the same coin run one after another (a buy then its sell). */
  onTrade(t: TargetTrade): Promise<void> {
    const prev = this.queue.get(t.mint) ?? Promise.resolve();
    const next = prev.then(() => this.handle(t)).catch((e: Error) => this.d.log?.("error", `Copy: ${e.message}`, t.mint));
    this.queue.set(t.mint, next);
    void next.finally(() => { if (this.queue.get(t.mint) === next) this.queue.delete(t.mint); });
    return next;
  }

  private async handle(t: TargetTrade) {
    const c = this.config();
    const w = c.wallets.find((x) => x.address === t.wallet);
    if (!w) return;
    if (t.side === "sell") return this.handleSell(c, w, t);
    const p = effectiveProfile(c.defaults, w);
    const need = factsNeeded(p.filters);
    if (t.mcapSol !== undefined && !need.includes("mcapUsd")) need.push("mcapUsd"); // free from PumpPortal: show it in the feed
    const x = need.length ? await this.facts.gather(t, need) : {};
    const it = this.item(t, w, x);
    const now = Date.now();
    const lastCopy = [...this.feed].reverse().find((i) => i.mint === t.mint && i.side === "buy" && i.status === "copied");
    const d = decideCopy(c, w, t, x, {
      spentWalletTodaySol: copySpentToday(this.feed, now, w.address), spentTotalTodaySol: copySpentToday(this.feed, now),
      openCopies: this.d.state.data.positions.filter((q) => q.copiedFrom && q.tokens > 0).length, lastCopyOfMintAt: lastCopy?.at,
      targetBoughtBefore: (t.tokensBefore ?? 0) > 0 || this.feed.some((i) => i.wallet === w.address && i.mint === t.mint && i.side === "buy" && i.theirSig !== t.signature),
      holding: this.d.state.holding(t.mint), blacklist: blacklistHit(this.d.blacklist(), { mint: t.mint, dev: (x as { dev?: string }).dev, wallet: t.wallet }), now,
    });
    it.latency.decidedAt = Date.now();
    if (!d.ok) return this.push({ ...it, status: "skipped", reason: d.reason });
    if (this.d.paused()) return this.push({ ...it, status: "skipped", reason: "agent is paused" });
    if (d.action === "alert") return this.push({ ...it, status: "alert", amountSol: d.amountSol, reason: `would copy ${d.amountSol} SOL (alert only)` });
    if (d.action === "confirm") {
      const pc: PendingCopy = { id: it.id, createdAt: now, expiresAt: now + COPY_CONFIRM_TTL_MS, wallet: w.address, label: w.label, trade: t, amountSol: d.amountSol, why: d.why, mcapUsd: x.mcapUsd };
      this.pending.push(pc);
      this.push({ ...it, status: "pending", amountSol: d.amountSol, reason: pendingCopyText(pc) });
      this.d.onPending?.(pc);
      return;
    }
    const item = { ...it, status: "pending" as const, amountSol: d.amountSol, reason: "sending" };
    this.push(item);
    await this.buy(item, t, w, p, d.amountSol, d.why, (x as { dev?: string }).dev);
  }

  private async exec(side: "buy" | "sell", p: CopyProfile) {
    const x = await this.d.tradeParams(side, p.preset);
    const jitoOnly = p.mev ? p.mev !== "off" : x.jitoOnly;
    const slip = p.mev === "secure" ? Math.min(x.slippageBps, 1000) : x.slippageBps;
    return { slippageBps: slip, priorityFeeSol: x.priorityFeeSol, jitoTipSol: jitoOnly ? Math.max(x.jitoTipSol ?? 0, 0.0001) : x.jitoTipSol, jitoOnly };
  }

  private async buy(item: CopyFeedItem, t: TargetTrade, w: CopyWallet, p: CopyProfile, amountSol: number, why: string, dev?: string, manual = false) {
    if (p.delayMs > 0) await sleep(p.delayMs);
    const fees = await this.exec("buy", p);
    const sentAt = Date.now();
    const symbol = t.symbol ?? item.symbol ?? t.mint.slice(0, 4);
    // v19: a copy is one pipeline candidate: Watch (their buy) → Size → Check / Execute in the executor
    const trace = { id: `c-${t.mint.slice(0, 6)}-${Date.now().toString(36)}`, symbol: symbol !== "?" ? symbol : undefined, source: "wallet" as const, action: "copied" as const };
    this.d.state.stage({ id: trace.id, stage: "watch", outcome: "pass", source: "wallet", mint: t.mint, symbol: trace.symbol, reason: `${w.label} bought` });
    this.d.state.stage({ id: trace.id, stage: "size", outcome: "pass", mint: t.mint, symbol: trace.symbol, amountSol, reason: why });
    const r = await this.d.executor().buy({ action: "buy", wallet: this.d.address(), mint: t.mint, dev, amountSol, ...fees, venue: "auto", reason: why, trace, ...(manual ? {} : { origin: "copy" as const }) }, symbol);
    const landedAt = Date.now();
    if (!r.ok) return this.update(item, { status: "failed", reason: r.error ?? "buy failed", latency: { ...item.latency, sentAt } });
    this.update(item, { status: "copied", reason: why, ourSig: r.signature, latency: { ...item.latency, sentAt, landedAt } });
    const pos = this.d.state.data.positions.find((q) => q.mint === t.mint && q.wallet === this.d.address());
    if (pos) {
      pos.copiedFrom ??= { wallet: w.address, label: w.label, signature: t.signature };
      if (!pos.exit && Object.keys(p.exit).length) pos.exit = p.exit;
      if (p.exit.timeSells?.length) this.d.scheduleTimedSells?.(t.mint, p.exit);
    }
    void this.slots(item);
    await this.d.state.save();
  }

  /** Their slot and ours, after the fact (getSignatureStatuses), for "N slots behind". */
  private async slots(item: CopyFeedItem) {
    if (!item.ourSig || item.ourSig === "paper") return;
    const sigs = [item.ourSig, ...(item.latency.targetSlot === undefined ? [item.theirSig] : [])];
    const r = await this.d.rpc.call<{ value: Array<{ slot?: number } | null> }>("getSignatureStatuses", [sigs, { searchTransactionHistory: true }]).catch(() => null);
    const ours = r?.value?.[0]?.slot;
    const theirs = item.latency.targetSlot ?? r?.value?.[1]?.slot;
    if (ours !== undefined || theirs !== undefined) this.update(item, { latency: { ...item.latency, ourSlot: ours, targetSlot: theirs } });
  }

  private async handleSell(c: CopyConfig, w: CopyWallet, t: TargetTrade) {
    const me = this.d.address();
    const pos = this.d.state.data.positions.find((q) => q.mint === t.mint && q.wallet === me && q.copiedFrom?.wallet === w.address);
    const it = this.item(t, w, {});
    const d = decideSell(c, w, t, pos);
    it.latency.decidedAt = Date.now();
    if (!d.ok) return this.push({ ...it, status: "skipped", reason: d.reason });
    const p = effectiveProfile(c.defaults, w);
    if (p.mode === "alert") return this.push({ ...it, status: "alert", reason: `would sell ${d.pct}% (alert only)` });
    const item = { ...it, status: "pending" as const, ourPct: d.pct, reason: "selling" };
    this.push(item);
    if (p.delayMs > 0) await sleep(p.delayMs);
    const fees = await this.exec("sell", p);
    const sentAt = Date.now();
    const r = await this.d.executor().sell({ action: "sell", wallet: me, mint: t.mint, sellPct: d.pct, ...fees, venue: "auto", reason: d.why });
    if (!r.ok) return this.update(item, { status: "failed", reason: r.error ?? "sell failed", latency: { ...item.latency, sentAt } });
    this.update(item, { status: "copied", reason: d.why, ourSig: r.signature, latency: { ...item.latency, sentAt, landedAt: Date.now() } });
    void this.slots(item);
  }

  /** Copy / Skip on a pending copy (Telegram button, panel, `vesk copy decide`). Guardrails still decide. */
  async decide(id: string, copy: boolean): Promise<string> {
    const p = this.pending.find((x) => x.id === id);
    if (!p) return "No pending copy with that id (it may have expired).";
    this.d.state.data.copyPending = this.pending.filter((x) => x !== p);
    const item = this.feed.find((i) => i.id === id);
    if (Date.now() > p.expiresAt) { if (item) this.update(item, { status: "expired", reason: "expired without a decision" }); return "That copy expired."; }
    if (!copy) { if (item) this.update(item, { status: "skipped", reason: "you skipped it" }); return "Skipped."; }
    const c = this.config();
    const w = c.wallets.find((x) => x.address === p.wallet);
    if (!w) return "That wallet isn't tracked any more.";
    const target = item ?? this.item(p.trade, w, { mcapUsd: p.mcapUsd });
    if (!item) this.push(target);
    this.update(target, { status: "pending", reason: "sending" });
    await this.buy(target, p.trade, w, effectiveProfile(c.defaults, w), p.amountSol, `${p.why} (confirmed)`, undefined, true);
    return target.status === "copied" ? `Copied ${p.amountSol} SOL of ${p.trade.symbol ?? shortAddr(p.trade.mint)}.` : `Not copied: ${target.reason}`;
  }

  /**
   * One-click manual copy of a trade in the feed (skipped or alert-only ones too). Your filters are bypassed because
   * you chose it; guardrails, limits and the blacklist still apply.
   */
  async manual(feedId: string, amountSol?: number): Promise<string> {
    const src = this.feed.find((i) => i.id === feedId);
    if (!src) return "No such trade in the feed.";
    if (src.side !== "buy") return "Manual copy is for buys. Sell from Positions.";
    const c = this.config();
    const w = c.wallets.find((x) => x.address === src.wallet) ?? { address: src.wallet, label: src.label, tag: "none", enabled: true, addedAt: "" } as CopyWallet;
    const p = effectiveProfile(c.defaults, w);
    const amt = amountSol ?? copyAmount(p, src.theirSol);
    const t: TargetTrade = { signature: src.theirSig, wallet: src.wallet, side: "buy", mint: src.mint, sol: src.theirSol, tokens: 0, venue: src.venue, source: "manual", detectedAt: Date.now(), symbol: src.symbol };
    const item: CopyFeedItem = { ...this.item(t, w, { mcapUsd: src.mcapUsd }), manual: true, status: "pending", amountSol: amt, reason: "sending" };
    this.push(item);
    await this.buy(item, t, w, p, amt, `manual copy of ${w.label}`, undefined, true);
    return item.status === "copied" ? `Copied ${amt} SOL of ${src.symbol ?? shortAddr(src.mint)}.` : `Not copied: ${item.reason}`;
  }

  expirePending(now = Date.now()) {
    const gone = this.pending.filter((p) => p.expiresAt < now);
    if (!gone.length) return;
    this.d.state.data.copyPending = this.pending.filter((p) => p.expiresAt >= now);
    for (const p of gone) { const i = this.feed.find((x) => x.id === p.id); if (i) this.update(i, { status: "expired", reason: "expired without a decision" }); }
  }

  stats(valueOf?: (mint: string, tokens: number) => number | undefined) {
    return copyStats(this.feed, this.d.state.data.positions, this.d.state.data.closed, Date.now(), valueOf);
  }

  line(i: CopyFeedItem) { return feedLine(i); }
}

export type { CopyDecision };
