/**
 * The agent loop.
 *
 *   X watcher ─┐                      ┌─ guardrails ─ executor ─ state/activity
 *   pump.fun ──┼─ signal → rules ─────┤
 *   manual ────┘                      └─ skip (logged with the reason)
 *   every 3s: open positions → exit engine (TP ladder / SL / trailing / timeout) → executor.sell
 *   every 5s: limit orders and DCA
 *   every 2s: control file (pause / kill switch / stop from `vesk stop`, Telegram or the panel)
 *   every 10s: optional status report to the panel
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoinManager } from "./coin/manager.js";
import { TelegramPoster, XPoster, type Poster } from "./coin/posters.js";
import { allRules, configLaunchRules, secret, type VeskConfig } from "./config.js";
import { snapshot } from "./market.js";
import { parseWithModel } from "./models/intent.js";
import { KEY_ENV, makeModel, type ModelClient } from "./models/providers.js";
import { AGENT_VERSION, PanelLink, type PanelOp, type RunPrefs } from "./panel.js";
import { execParams, normalizeTradingSettings, type ExecParams, type PresetId, type TradingSettings } from "./trade/settings.js";
import { afterFail, afterFire, decideBuy, describeOrder, devSellMints, evaluateExit, evaluateOrders, matchDevSell, matchSignal, notePrice, positionPnl, TIME_STEP, validateOrder, type OrderFire, type StreamTrade } from "./rules/engine.js";
import { TokenTradeWatcher } from "./watch/tradeWatcher.js";
import { describeExit, type ParseResult } from "./rules/parse.js";
import { RuleStore } from "./rules/store.js";
import { Rpc, rpcKind, type LatencyResult } from "./rpc.js";
import { State } from "./state.js";
import { Executor } from "./trade/executor.js";
import type { Activity, AgentStatus, Limits, Order, Rule, Signal } from "./types.js";
import type { Keystore, WalletInfo } from "./wallet/keystore.js";
import { checkLaunch, estimateCurveBuys, summarizePlan, type LaunchPlan } from "./launch/plan.js";
import { launchpad, type QuoteAsset } from "./launch/launchpads.js";
import { planFee } from "./launch/capabilities.js";
import { claimGroups, rowsFromLaunches, type ClaimGroup, type CreatorFeeRow } from "./launch/claim.js";
import { launchPlanOnPump, type LaunchInput, type LaunchPlanResult, type LaunchProgress } from "./launch/pumpfun.js";
import { planFunding, planReturn, type Transfer } from "./wallet/multi.js";
import { sendTransfers } from "./wallet/transfers.js";
import {
  applyName, askSuggestions, checkAutoLaunch, describeLaunchExit, draftToken, matchLaunchPost, normalizeLaunchRule, pendingText, pickImage, planFor, postLaunchPrompt, postUrl,
  priorityHold, spendOf, topicClash, velocityDecision, type LaunchOnPostRule, type LaunchRecord, type PendingLaunch, type Suggestion,
} from "./launch/onpost.js";
import { checkClash, resolveClash, type ImageHash } from "./launch/clash.js";
import { raceLabel, raceReport } from "./launch/race.js";
import { backtestRule, type BacktestResult } from "./launch/backtest.js";
import { ruleStats, type RuleStats } from "./launch/rulestats.js";
import { mintLine, pairCheckOf, verifyQuoteMint, type MintCheck, type PairCheck } from "./launch/mintcheck.js";
import { PairDiscovery } from "./launch/discovery.js";
import { findPair, PUMPFUN_PAIRS, type PairAsset } from "./launch/pairs.js";
import { CreateStream } from "./watch/creates.js";
import { parseMetaplex } from "./copy/facts.js";
import { generateImage, imageFromFile, imageFromUrl } from "./launch/image.js";
import { imageHashes, prepareCoinImage, xPngVariant } from "./launch/imagecrop.js";
import type { TokenDetails } from "./launch/plan.js";
import { effectiveRule, ruleFromPreset, type LaunchPreset } from "./launch/presets.js";
import { keepWarm, Timeline } from "./launch/speed.js";
import { enrichPost, type FeedPost } from "./watch/tracker.js";
import { activeHandles, draftToken as draftFor } from "./launch/onpost.js";
import type { XPost } from "./types.js";
import { postMetrics, ProviderWebhook, recentPosts, toXPost, XFilteredStream, XSearchPoller, type XWatcher } from "./watch/x.js";
import { blacklistHit, indexBlacklist, normalizeBlacklist, type BlacklistIndex } from "./watch/blacklist.js";
import { armedCount, describeMigrationOrder, matchMigration, mergeMigration, normalizeMigrationOrders, settleMigration, type MigrationEvent, type MigrationOrder } from "./watch/migration.js";
import { MigrationWatcher } from "./watch/migrationWatcher.js";
import { BURN_CONFIRM_TEXT, burnDisclosure, burnPlan, fmtTokens, lockPlan, streamflowLock, type BurnPlan, type LockPlan } from "./coin/supply.js";
import { PumpLaunchWatcher } from "./watch/pumpfun.js";
import { RelayWatcher } from "./watch/relay.js";
import { planRentRecovery } from "./wallet/rent.js";
import { loadBookFile } from "./wallet/bookStore.js";
import { withOwnLabels } from "./wallet/naming.js";
import { endpoints } from "./endpoints.js";
import { CopyTrader } from "./copy/trader.js";
import type { CopyFeedItem } from "./copy/engine.js";
import { BRAND } from "./brand.js";
import { StrategyRunner } from "./strategy/runner.js";
import { normalizeStrategy, sourcesOff, type StrategySettings } from "./strategy/settings.js";
import { sourceOffReason } from "./guardrails.js";
import { WorkQueue } from "./work/queue.js";
import { Reservations } from "./work/reserve.js";
import { checkCanSell } from "./strategy/canSell.js";
import { rogueActive, rogueGuard, rogueLine } from "./strategy/rogue.js";

export interface AgentOptions {
  config: VeskConfig;
  keystore: Keystore;
  paper?: boolean;
  xMode?: "poll" | "stream";
}

export interface ControlFile {
  paused?: boolean;
  killSwitch?: boolean;
  stop?: boolean;
  at?: number;
  /** Launch / Skip decisions for pending launch-on-post drafts (`vesk pending launch <id>`). */
  decisions?: Array<{ id: string; launch: boolean; /** v26: the name you gave (naming "ask") */ name?: { name: string; symbol: string } }>;
  /** `vesk deploy <post>`: launch a coin on that post with a preset. */
  deploys?: Array<{ postId: string; presetId?: string }>;
  /** `vesk order …`: limit buys, limit sells and DCA to add; `vesk orders cancel <id>`: ids to cancel. */
  orders?: Order[];
  cancelOrders?: string[];
  /** `vesk copy decide <id> copy|skip` and `vesk copy manual <feed id>`. */
  copyDecisions?: Array<{ id: string; copy: boolean }>;
  copyManual?: Array<{ feedId: string; amountSol?: number }>;
}

export class Agent {
  readonly state: State;
  readonly rpc: Rpc;
  readonly executor: Executor;
  readonly store: RuleStore;
  /** Copy trading: tracked wallets → detection → decisions → executor (copy/trader.ts). */
  readonly copy: CopyTrader;
  private copyDirty = new Map<string, CopyFeedItem>();
  model: ModelClient | null = null;
  private x?: XWatcher;
  private launches?: PumpLaunchWatcher;
  /** v26: every pump.fun create (clash check, race reports, pair discovery), while launch-on-post rules are on */
  private creates?: CreateStream;
  /** v26: quote mints seen in creates */
  readonly pairsSeen = new PairDiscovery({
    describe: (mint) => this.describeMint(mint),
    onNew: (q) => { this.state.data.seenQuotes = this.pairsSeen.list(); this.state.log({ kind: "status", message: `New quote pair seen live: ${q.symbol ?? q.mint.slice(0, 6) + "…"}${q.decimals !== undefined ? ` (${q.decimals} decimals)` : ""}` }); },
  });
  private migrations?: MigrationWatcher;
  /** Live trades of coins with an open dev-sell order. */
  private tradeFeed?: TokenTradeWatcher;
  private coin?: CoinManager;
  /** Coins handed to the agent from the panel ("Run your coin" per mint), on top of the one in the config. */
  private coinRuns = new Map<string, { key: string; m: CoinManager }>();
  private panel?: PanelLink;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private reported = 0;
  /** v19: the newest pipeline step already sent to the panel (by the 2 s poll or the report). */
  private piped = 0;
  private stopWarm?: () => void;
  latency?: LatencyResult;
  /** When start() ran, for uptime. */
  startedAt = Date.now();
  /** v19: Strategy & safety: new coins, the rug check, Rogue mode (strategy/runner.ts). */
  readonly runner: StrategyRunner;
  /** v20: parallel lanes (shared by every executor and by launches) and the budget buys in flight reserve. */
  readonly work = new WorkQueue(() => this.strategy().concurrency);
  readonly reserve = new Reservations();

  constructor(private o: AgentOptions) {
    const c = o.config;
    this.state = new State(c.dataDir);
    this.store = new RuleStore(c.dataDir);
    this.rpc = new Rpc(c.rpc.url, 10_000, c.rpc.wsUrl);
    this.executor = new Executor({
      rpc: this.rpc, wallet: o.keystore.keypair(), state: this.state, limits: () => this.limits(),
      defaultPriorityFeeSol: c.rpc.priorityFeeSol, jito: c.rpc.jito, paper: o.paper, allWallets: () => o.keystore.wallets().map((w) => w.address),
      blacklist: () => this.blacklist(), rogue: () => this.rogueCtx(), sourcesOff: () => sourcesOff(this.strategy()), preBuy: (i, ctx) => this.canSellGate(i, ctx),
      work: this.work, reserve: this.reserve,
    });
    this.runner = new StrategyRunner({
      rpc: this.rpc, state: this.state, executor: () => this.executor, address: () => this.address, settings: () => this.strategy(),
      tradeParams: (side) => this.tradeParams(side), paused: () => this.status === "paused",
      endRogue: async () => { this.store.data.strategy = { ...this.strategy(), mode: "normal", rogueStartedAt: undefined }; await this.store.save(); },
    });
    this.copy = new CopyTrader({
      rpc: this.rpc, state: this.state, config: () => this.store.data.copy, executor: () => this.executor, address: () => this.address,
      tradeParams: (side, id) => this.tradeParams(side, id), blacklist: () => this.blacklist(), paused: () => this.status === "paused",
      log: (kind, message, mint) => void this.state.log({ kind, message, mint }),
      adapterUrl: () => { const k = normalizeKey(this.store.data.copy); return k ? secret(k, this.secrets()) : undefined; },
      scheduleTimedSells: (mint, exit) => this.scheduleTimedSells(mint, exit as LaunchOnPostRule["exit"]),
      onFeed: (i) => { this.copyDirty.set(i.id, i); },
    });
  }

  private blIndex?: { v: number; i: BlacklistIndex };
  /** Your blacklist as lookup sets (rebuilt when rules.json changes). */
  blacklist(): BlacklistIndex {
    if (!this.blIndex || this.blIndex.v !== this.store.data.version) this.blIndex = { v: this.store.data.version, i: indexBlacklist(normalizeBlacklist(this.store.data.blacklist)) };
    return this.blIndex.i;
  }

  get config() {
    return this.o.config;
  }
  get address() {
    return this.executor.address;
  }

  /** v19: Strategy & safety in force: rules.json (CLI, chat, the panel) wins over the config file's `strategy`. */
  strategy(): StrategySettings {
    return normalizeStrategy(this.store.data.strategy ?? this.o.config.strategy ?? {});
  }

  /** The running Rogue session's limits for the guardrails (none outside a session: a Rogue buy is then refused). */
  private rogueCtx() {
    const s = this.strategy(), ses = this.state.data.rogue;
    return ses && rogueActive(s, Date.now()) ? rogueGuard(s.rogue, ses) : undefined;
  }

  /**
   * v19: the can-sell (honeypot) check, after the guardrails and before anything is built. Skipped for coins on a
   * pump.fun bonding curve (minted by the pump.fun program: no freeze authority, no extensions). One check per coin
   * per minute is cached.
   */
  private sellChecks = new Map<string, { at: number; r: { ok: true } | { ok: false; reason: string } }>();
  async canSellGate(i: { mint: string; rogue?: boolean }, ctx: { onCurve?: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const s = this.strategy();
    if (!s.honeypot.enabled || (i.rogue && !s.rogue.honeypot)) return { ok: true };
    if (ctx.onCurve || this.runner.protocolOf(i.mint) === "pumpfun") return { ok: true };
    const hit = this.sellChecks.get(i.mint);
    if (hit && Date.now() - hit.at < 60_000) return hit.r;
    const c = await checkCanSell(this.rpc, i.mint, s.honeypot);
    const r: { ok: true } | { ok: false; reason: string } = c.ok ? { ok: true } : { ok: false, reason: `Not bought: ${c.reason}.` };
    this.sellChecks.set(i.mint, { at: Date.now(), r });
    if (c.ok && c.notes.length) this.state.log({ kind: "status", mint: i.mint, message: `Can-sell check passed (${c.ms} ms): ${c.notes.join(", ")}` });
    return r;
  }

  limits(): Limits {
    return { ...this.o.config.limits, ...(this.store.data.limits ?? {}), killSwitch: this.o.config.limits.killSwitch || this.store.data.limits?.killSwitch === true };
  }

  /** Rules from the config file, the watchlist and rules.json (later sources win on id). */
  rules(): Rule[] {
    const fromStore = [...this.store.data.rules, ...allRules({ ...this.o.config, rules: [], watchlist: this.store.data.watchlist })];
    const map = new Map<string, Rule>();
    for (const r of [...allRules(this.o.config), ...fromStore]) map.set(r.id, r);
    return [...map.values()];
  }

  private secrets() {
    return this.o.keystore.secrets();
  }

  // ---------- wallets & launches ----------

  private execs = new Map<string, Executor>();
  /** An executor that signs with one of your keystore wallets (main or imported). Same guardrails and limits. */
  executorFor(address: string): Executor {
    if (address === this.address) return this.executor;
    let e = this.execs.get(address);
    if (!e) {
      const c = this.o.config;
      e = new Executor({
        rpc: this.rpc, wallet: this.o.keystore.keypairOf(address), state: this.state, limits: () => this.limits(),
        defaultPriorityFeeSol: c.rpc.priorityFeeSol, jito: c.rpc.jito, paper: this.o.paper, allWallets: () => this.o.keystore.wallets().map((w) => w.address),
        blacklist: () => this.blacklist(), rogue: () => this.rogueCtx(), sourcesOff: () => sourcesOff(this.strategy()), preBuy: (i, ctx) => this.canSellGate(i, ctx),
        work: this.work, reserve: this.reserve,
      });
      this.execs.set(address, e);
    }
    return e;
  }

  /** Run one thing you asked for in the panel. Guardrails decide; the result goes to the activity log. */
  async runPanelOp(op: PanelOp): Promise<void> {
    const say = (kind: "status" | "error" | "guardrail", message: string): void => void this.state.log({ kind, message: `Panel: ${message}` });
    try {
      if (op.op === "trade") {
        if (op.side === "buy" && op.wallets.length !== 1) return say("guardrail", "buys run from one wallet per coin.");
        const x = op.preset ? await this.tradeParams(op.side, op.preset) : null;
        const fees = x ? { slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly } : { slippageBps: Math.round((op.slippagePct ?? 15) * 100) };
        const why = `manual ${op.side} (${op.source ?? "panel"}${op.preset ? ` · ${op.preset.toUpperCase()}` : ""})`;
        // v19: a buy from the panel is a candidate in Live too (watch → size → the guardrails → execute)
        const trace = op.side === "buy" ? { id: `p-${op.mint.slice(0, 6)}-${Date.now().toString(36)}`, source: "panel" as const } : undefined;
        if (trace) {
          this.state.stage({ id: trace.id, stage: "watch", outcome: "pass", source: "panel", mint: op.mint, reason: why });
          this.state.stage({ id: trace.id, stage: "size", outcome: "pass", mint: op.mint, amountSol: op.amountSol, preset: op.preset, reason: op.preset ? `preset ${op.preset.toUpperCase()}` : "your amount" });
        }
        for (const w of op.wallets) {
          const ex = this.executorFor(w);
          const r = op.side === "buy"
            ? await ex.buy({ action: "buy", wallet: w, mint: op.mint, dev: op.dev, amountSol: op.amountSol ?? 0, ...fees, reason: why, trace })
            : await ex.sell({ action: "sell", wallet: w, mint: op.mint, sellPct: op.pct ?? 100, ...fees, reason: why });
          if (!r.ok) say("error", `${op.side} from ${w.slice(0, 4)}… failed: ${r.error}`);
        }
      } else if (op.op === "send-tokens") {
        const r = await this.executorFor(op.from ?? this.address).sendTokens(op.mint, op.to, op.tokens);
        if (!r.ok) say("guardrail", `send refused: ${r.error}`);
      } else if (op.op === "claim-fees") {
        // v22.1: the pair's reward asset (SOL or the quote asset); v26: kept in that asset
        const r = await this.executor.claimCreatorFees(op.mint, { quote: op.quote });
        if (r.ok && (r.solDelta || r.amount)) this.state.data.treasury.push({ at: Date.now(), kind: "claim", mint: op.mint, sol: Math.max(0, r.solDelta ?? 0), asset: r.asset ?? "SOL", amount: r.amount, signature: r.signature });
        say(r.ok ? "status" : "error", r.ok
          ? (r.asset && r.asset !== "SOL" ? `claimed ${(r.amount ?? 0).toFixed(2)} ${r.asset} creator fees` : `claimed ${(r.solDelta ?? 0).toFixed(4)} SOL creator fees`)
          : `claim failed: ${r.error}`);
      } else if (op.op === "burn") {
        // v25: the panel's Burn dialog showed the plan and the confirmation; a coin this agent launched also gets the
        // disclosure in its public updates (burnSupply). Any other coin the panel launched: the plain disclosed burn.
        if (this.launchedCoin(op.mint)) {
          const r = await this.burnSupply({ mint: op.mint, tokens: op.tokens, confirm: true });
          say(r.ok ? "status" : "error", r.ok ? `burned ${fmtTokens(op.tokens)} $${r.coin?.symbol} (disclosed)` : `burn failed: ${r.error}`);
        } else {
          const r = await this.executor.burn(op.mint, op.tokens, true);
          if (r.ok) this.state.data.treasury.push({ at: Date.now(), kind: "burn", mint: op.mint, tokens: op.tokens, signature: r.signature });
          else say("error", `burn failed: ${r.error}`);
        }
      } else if (op.op === "launch") {
        const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/.exec(op.imageDataUrl ?? "");
        if (!m) return say("error", "launch needs a PNG, JPG, GIF or WebP image.");
        const image = { bytes: new Uint8Array(Buffer.from(m[3], "base64")), mime: m[1], filename: `${op.plan.token.symbol.toLowerCase()}.${m[2] === "jpeg" ? "jpg" : m[2]}` };
        const r = await this.launch(op.plan, image, (e) => this.state.log({ kind: "status", message: `Launch: ${e.step} · ${e.detail}` }), "from the panel");
        if (op.exit) for (const p of this.state.data.positions.filter((x) => x.mint === r.mint)) p.exit = op.exit;
        if (op.run) this.applyRun(r.mint, op.plan.token.symbol.toUpperCase(), op.run);
      } else if (op.op === "copy-decide") {
        say("status", `copy: ${await this.copy.decide(op.pendingId, op.copy)}`);
      } else if (op.op === "copy-manual") {
        let id = op.feedId && this.copy.feed.some((i) => i.id === op.feedId) ? op.feedId : undefined;
        if (!id) {
          // A trade the panel saw (hosted feed) that this agent didn't: add it to the feed, then copy it.
          const it: CopyFeedItem = { id: Math.random().toString(36).slice(2, 10), at: Date.now(), wallet: op.wallet, label: op.label ?? op.wallet.slice(0, 4), side: "buy", mint: op.mint, symbol: op.symbol, theirSol: op.theirSol, theirSig: op.theirSig, venue: (op.venue as CopyFeedItem["venue"]) ?? "unknown", source: "relay", status: "alert", reason: "from the panel", latency: { detectedAt: Date.now() } };
          this.copy.feed.push(it);
          id = it.id;
        }
        say("status", `copy: ${await this.copy.manual(id, op.amountSol)}`);
      } else if (op.op === "order") {
        this.addOrder({ ...op.order, source: "panel" });
      } else if (op.op === "order-cancel") {
        this.cancelOrder(op.orderId);
      } else if (op.op === "rent-recover") {
        const ex = this.executorFor(op.wallet ?? this.address);
        const keep = this.state.data.positions.map((p) => p.mint);
        await ex.recoverRent(planRentRecovery(await ex.emptyTokenAccounts(), { keepMints: keep }));
      }
      await this.state.save();
    } catch (e) {
      say("error", (e as Error).message);
    }
  }

  /**
   * Run one coin for you: updates to your own linked accounts, creator-fee claims, disclosed buybacks (and burns).
   * Same CoinManager and guardrails as the coin in your config. Switching everything off stops it.
   */
  /**
   * v25: burn supply of a coin this agent launched (`vesk burn`, MCP `vesk_burn_supply`, chat "burn 10% of $DIAL",
   * the panel's Burn dialog through the ops queue). Plans against what the wallet holds, needs `confirm` (the caller
   * showed the plan and "Burned tokens are gone forever"), burns through the executor's guardrails, writes the
   * treasury report and posts the disclosure when the agent runs the coin.
   */
  async burnSupply(o: { mint?: string; symbol?: string; tokens?: number; pct?: number; confirm: boolean; planOnly?: boolean }): Promise<{ ok: boolean; coin?: { mint: string; symbol: string }; plan?: BurnPlan; signature?: string; error?: string; disclosure?: string }> {
    const coin = this.launchedCoin(o.mint, o.symbol);
    if (!coin) return { ok: false, error: "Burning is for coins you launched with this agent. Launch one, or import it, first." };
    const h = await this.executor.holding(coin.mint);
    const plan = burnPlan({ holding: h.tokens, decimals: h.decimals, tokens: o.tokens, pct: o.pct });
    if (!plan.ok) return { ok: false, coin, plan, error: plan.error };
    if (o.planOnly) return { ok: true, coin, plan };
    if (!o.confirm) return { ok: false, coin, plan, error: `Not confirmed. ${BURN_CONFIRM_TEXT}: confirm to burn ${fmtTokens(plan.tokens)} $${coin.symbol}.` };
    const r = await this.executor.burn(coin.mint, plan.tokens, true, plan.raw);
    if (!r.ok) return { ok: false, coin, plan, error: r.error ?? "burn failed" };
    this.state.data.treasury.push({ at: Date.now(), kind: "burn", mint: coin.mint, tokens: plan.tokens, signature: r.signature });
    const disclosure = burnDisclosure(coin.symbol, plan.tokens, r.signature);
    const m = this.coinRuns.get(coin.mint)?.m ?? (this.coin?.mint === coin.mint ? this.coin : undefined);
    if (m) await m.publish(disclosure).catch(() => undefined);
    await this.state.save();
    return { ok: true, coin, plan, signature: r.signature, disclosure };
  }

  /** v25: lock supply. Not available yet (coin/supply.ts `streamflowLock`): returns the plan and the reason. */
  async lockSupply(o: { mint?: string; symbol?: string; tokens?: number; pct?: number; days: number }): Promise<{ ok: false; coin?: { mint: string; symbol: string }; plan?: LockPlan; error: string; soon: true }> {
    const coin = this.launchedCoin(o.mint, o.symbol);
    if (!coin) return { ok: false, soon: true, error: "Locking is for coins you launched with this agent." };
    const h = await this.executor.holding(coin.mint);
    const plan = lockPlan({ holding: h.tokens, decimals: h.decimals, tokens: o.tokens, pct: o.pct, days: o.days });
    return { ok: false, soon: true, coin, plan, error: plan.ok ? streamflowLock.reason ?? "Locking isn't available yet." : plan.error ?? "invalid lock" };
  }

  private launchedCoin(mint?: string, symbol?: string): { mint: string; symbol: string } | undefined {
    const sym = symbol?.replace(/^\$/, "").toUpperCase();
    const l = (this.state.data.launched ?? []).find((c) => (mint && c.mint === mint) || (sym && c.symbol.toUpperCase() === sym));
    return l ? { mint: l.mint, symbol: l.symbol } : undefined;
  }

  /** v23: the Claim rows for coins this agent launched (unclaimed amounts aren't readable from the venue: null). */
  creatorFeeRows(): CreatorFeeRow[] {
    return rowsFromLaunches(this.state.data.launched ?? [], this.state.data.treasury.filter((e) => e.kind === "claim"));
  }

  /**
   * v23: claim creator fees (`vesk claim`, MCP `vesk_claim_fees`, chat "claim my fees"). One claim per asset and
   * creator wallet (claimGroups); fees stay in the asset they were paid in. Every claim goes through the executor's
   * guardrails. Returns one result per group.
   */
  async claimFees(o: { mint?: string; symbol?: string } = {}): Promise<Array<{ group: ClaimGroup; ok: boolean; asset: string; amount: number; sol: number; signature?: string; error?: string }>> {
    const rows = this.creatorFeeRows();
    const sym = o.symbol?.replace(/^\$/, "").toUpperCase();
    const pick = o.mint || sym ? (r: CreatorFeeRow) => r.mint === o.mint || r.symbol.toUpperCase() === sym : undefined;
    const groups = claimGroups(rows, pick);
    const out: Awaited<ReturnType<Agent["claimFees"]>> = [];
    for (const g of groups) {
      const r = await this.executor.claimCreatorFees(g.lead, { quote: g.asset as QuoteAsset });
      const amount = r.amount ?? Math.max(0, r.solDelta ?? 0);
      const sol = Math.max(0, r.solDelta ?? 0);
      if (r.ok && (sol || amount)) this.state.data.treasury.push({ at: Date.now(), kind: "claim", mint: g.lead, sol, asset: r.asset ?? g.asset, amount, signature: r.signature });
      out.push({ group: g, ok: r.ok, asset: r.asset ?? g.asset, amount, sol, signature: r.signature, error: r.error });
    }
    await this.state.save();
    return out;
  }

  applyRun(mint: string, symbol: string, run: RunPrefs): void {
    if (this.o.config.coin?.mint === mint) return; // the config's coin is managed by the config
    const key = JSON.stringify(run);
    const cur = this.coinRuns.get(mint);
    if (cur?.key === key) return;
    cur?.m.stop();
    this.coinRuns.delete(mint);
    if (!run.updates && !run.claimFees) return;
    const c = this.o.config;
    const posters: Poster[] = [];
    const xUser = secret("X_USER_TOKEN", this.secrets());
    if (run.updates && c.coin?.postTo.x && xUser) posters.push(new XPoster(c.coin.postTo.x, xUser));
    const tg = secret(c.telegram.botTokenEnv, this.secrets());
    if (run.updates && c.coin?.postTo.telegramChatId && tg) posters.push(new TelegramPoster(c.coin.postTo.telegramChatId, tg));
    const m = new CoinManager({
      mint, symbol, postTo: c.coin?.postTo ?? {},
      updates: { enabled: run.updates && posters.length > 0, everyMin: 240, onMilestones: true },
      community: { answerQuestions: false, faq: "" },
      treasury: { claimFees: run.claimFees, claimEveryMin: 60, buybackPct: Math.max(0, Math.min(50, run.buybackPct)), burnBuybacks: run.burnBuybacks },
    }, { rpc: this.rpc, state: this.state, executor: this.executor, posters, model: this.model });
    if (this.status === "online" || this.status === "paused") m.start();
    this.coinRuns.set(mint, { key, m });
    this.state.log({ kind: "status", mint, message: `Running $${symbol}: ${[run.updates && (posters.length ? "updates" : "updates (no linked account yet)"), run.claimFees && "fee claims", run.buybackPct > 0 && `${run.buybackPct}% disclosed buybacks${run.burnBuybacks ? " + burns" : ""}`].filter(Boolean).join(", ")}` });
  }

  private symbolOf(mint: string): string {
    return this.state.data.positions.find((p) => p.mint === mint)?.symbol
      ?? this.state.data.launchHistory.find((h) => h.mint === mint)?.symbol
      ?? mint.slice(0, 4).toUpperCase();
  }

  /** The trading settings in force (P1/P2/P3 presets, quick amounts, hotkeys). */
  trading(): TradingSettings {
    return normalizeTradingSettings(this.store.data.trading);
  }

  /** Execution parameters for a preset (the active one if none is given), with your RPC's fee estimate when auto fee is on. */
  async tradeParams(side: "buy" | "sell", id?: PresetId): Promise<ExecParams> {
    const t = this.trading();
    const p = t[side][id ?? (side === "buy" ? t.activeBuy : t.activeSell)];
    return execParams(p, p.autoFee ? await this.rpc.priorityFeeEstimateSol() : undefined);
  }

  /**
   * Main + imported wallets with live balances. Public data only. Names come from the address book (book.json,
   * wallet/naming.ts): your name for the wallet, else a custom name stored with the key, else "Main" / "Wallet n".
   */
  async wallets(): Promise<Array<WalletInfo & { balanceSol: number }>> {
    const book = await loadBookFile(this.o.config.dataDir).catch(() => ({ entries: [], folders: [] }));
    const list = withOwnLabels(this.o.keystore.wallets(), book.entries);
    const bals = await Promise.all(list.map((w) => this.rpc.getBalanceSol(w.address).catch(() => 0)));
    return list.map((w, i) => ({ ...w, balanceSol: bals[i] }));
  }

  /** Direct transfers from the main wallet to the given wallets (even split or custom amounts). */
  async fundWallets(p: { targets: string[]; mode: "even" | "custom"; totalSol?: number; amounts?: Record<string, number> }) {
    const main = this.address;
    const plan = planFunding({ ...p, main, mainBalanceSol: await this.rpc.getBalanceSol(main), reserveSol: this.limits().minSolReserve });
    if (plan.errors.length) throw new Error(plan.errors.join(" "));
    return this.sendLogged(plan.transfers, "Funded");
  }

  /** Every imported wallet sends its SOL back to the main wallet. */
  async returnAll() {
    const ws = (await this.wallets()).filter((w) => !w.main);
    return this.sendLogged(planReturn(this.address, ws), "Returned");
  }

  private async sendLogged(transfers: Transfer[], verb: string) {
    if (this.o.paper) return transfers.map((t) => ({ ...t, signature: "paper", ok: true }));
    const sent = await sendTransfers(this.rpc, (a) => this.o.keystore.keypairOf(a), transfers);
    for (const s of sent) this.state.log({ kind: "withdraw", message: `${verb} ${s.count} wallet transfer${s.count === 1 ? "" : "s"} (direct, on-chain)`, signature: s.signature });
    await this.state.save();
    return sent;
  }

  /** Launch from a plan. Guardrails first; team wallets are recorded and disclosed in the treasury report. */
  async launch(plan: LaunchPlan, image: LaunchInput["image"], onProgress?: (e: LaunchProgress) => void, source?: string): Promise<LaunchPlanResult> {
    // v20: launches run in their own lanes (concurrency.launches) and reserve their dev and team buys while they run
    return this.work.run("launch", async () => {
      const team = plan.mode === "standard" ? plan.team?.wallets ?? [] : [];
      const sol = plan.mode === "standard" ? plan.devBuySol + (plan.team?.solEach ?? 0) * team.length : 0;
      const rid = this.reserve.reserve({ mint: `launch:${plan.token.symbol}:${Date.now()}`, sol, newPosition: plan.mode === "standard" && plan.devBuySol > 0 });
      try { return await this.launchNow(plan, image, onProgress, source, () => this.reserve.others(rid).sol); } finally { this.reserve.release(rid); }
    });
  }

  private async launchNow(plan: LaunchPlan, image: LaunchInput["image"], onProgress?: (e: LaunchProgress) => void, source?: string, inFlightSol: () => number = () => 0): Promise<LaunchPlanResult> {
    const own = this.o.keystore.wallets().map((w) => w.address);
    const team = plan.mode === "standard" ? plan.team?.wallets ?? [] : [];
    const balances: Record<string, number> = {};
    for (const a of [this.address, ...team]) balances[a] = await this.rpc.getBalanceSol(a).catch(() => 0);
    const g = checkLaunch(plan, { limits: this.limits(), ownWallets: own, creator: this.address, spentTodaySol: this.state.spentToday() + inFlightSol(), balances });
    if (!g.ok) {
      this.state.log({ kind: "guardrail", message: `Launch refused: ${g.reason}` });
      throw new Error(g.reason);
    }
    if (this.o.paper) throw new Error("Paper mode: launches are never signed. Run without --paper to launch.");
    // v26: a custom pair's quote mint is read on chain through your RPC before anything is built; a mismatch refuses
    if (plan.token.quote !== "SOL") {
      const pair = findPair(plan.token.quote, this.pairs());
      if (!pair?.mint || pair.mint === "native") throw new Error(`${plan.token.quote} has no verified mint, so it can't be used.`);
      const chk = await verifyQuoteMint(this.rpc, pair.mint, { decimals: pair.decimals });
      this.notePairCheck(pair.mint, chk);
      this.state.log({ kind: chk.ok ? "status" : "guardrail", message: mintLine(pair.id, chk) });
      if (!chk.ok) throw new Error(`Launch refused: the ${pair.id} quote mint failed its on-chain check: ${chk.reason}.`);
    }
    const r = await launchPlanOnPump({
      rpc: this.rpc, plan, creator: this.o.keystore.keypair(), signerOf: (a) => this.o.keystore.keypairOf(a), image,
      jitoEngine: this.o.config.rpc.jito.blockEngineUrl, onProgress,
    });
    const s = summarizePlan(plan);
    const sym = plan.token.symbol.toUpperCase();
    const est = estimateCurveBuys([plan.mode === "standard" ? plan.devBuySol : 0]);
    if (plan.mode === "standard" && plan.devBuySol > 0) {
      // Record what actually landed in the wallet (the curve estimate is only a fallback).
      const onChain = await this.rpc.getTokenBalances(this.address).then((l) => l.find((x) => x.mint === r.mint)?.amount ?? 0).catch(() => 0);
      this.state.recordBuy({ mint: r.mint, symbol: sym, wallet: this.address, sol: plan.devBuySol, tokens: onChain > 0 ? onChain : est[0].tokens });
    }
    // Team wallets: count the spend and the fills (so the multi-wallet guard sees them), but they are not
    // positions the agent trades. Selling from a team wallet is a manual, disclosed action.
    const day = new Date().toISOString().slice(0, 10);
    for (const w of team) {
      this.state.data.fills.push({ at: Date.now(), mint: r.mint, side: "buy", wallet: w, amountSol: plan.team!.solEach });
      this.state.data.spentSol[day] = (this.state.data.spentSol[day] ?? 0) + plan.team!.solEach;
    }
    if (team.length) this.state.data.treasury.push({ at: Date.now(), kind: "team", mint: r.mint, sol: s.teamTotalSol, wallets: team, signature: r.teamSignatures[0] });
    // v23: what the Claim rows and `vesk claim` need later: the pair, where creator rewards go, the fee and the creator
    const fee = planFee(launchpad(plan.launchpad).caps, plan.token.quote ?? "SOL", plan.token.creatorFeePct);
    (this.state.data.launched ??= []).push({
      mint: r.mint, name: plan.token.name, symbol: sym, launchpad: plan.launchpad, quote: plan.token.quote ?? "SOL", mode: plan.token.creatorFees ?? "creator",
      creator: this.address, ...(fee !== null ? { feePct: fee } : {}), at: Date.now(), signature: r.signature,
    });
    this.state.log({
      kind: "launch", mint: r.mint, signature: r.signature, solDelta: -s.buySol,
      message: `Launched ${plan.token.name} ($${sym}) ${source ? `${source} ` : ""}on pump.fun, ${plan.mode}${r.slot ? `, slot ${r.slot}` : ""}${team.length ? `. ${s.teamLine}` : ""}`,
    });
    await this.state.save();
    return r;
  }

  async init(): Promise<this> {
    await this.state.load();
    await this.store.load();
    const m = this.o.config.model;
    if (m.provider !== "none") this.model = makeModel(m, secret(m.apiKeyEnv ?? KEY_ENV[m.provider] ?? "", this.secrets()));
    return this;
  }

  async start(): Promise<void> {
    const c = this.o.config;
    this.startedAt = Date.now();
    this.state.data.status = "online";
    this.state.log({ kind: "status", message: `${BRAND.name} ${AGENT_VERSION} online${this.o.paper ? " (paper mode: nothing is signed)" : ""} · wallet ${this.address.slice(0, 4)}…${this.address.slice(-4)}` });
    this.latency = await this.rpc.latencyTest(3).catch(() => undefined);
    if (rpcKind(c.rpc.url) === "public") this.state.log({ kind: "status", message: "Using the public Solana RPC. It works, but it is rate-limited and slower. A private RPC lands snipes sooner." });

    if (c.panel?.url) {
      const token = secret("VESK_AGENT_TOKEN", this.secrets());
      if (token) this.panel = new PanelLink(c.panel.url, token);
    }
    const handles = this.watchedHandles();
    if (c.x.source !== "off" && handles.length) {
      if (c.x.source === "relay") {
        if (!this.panel) this.state.log({ kind: "error", message: "X source is the relay, but this agent isn't paired. Run `vesk pair <CODE> --panel <url>`." });
        else this.x = new RelayWatcher((a, b) => this.panel!.call(a, b));
      } else if (c.x.source === "official-api") {
        const token = secret(c.x.bearerTokenEnv, this.secrets());
        if (!token) this.state.log({ kind: "error", message: `X watching is on but ${c.x.bearerTokenEnv} is not set.` });
        else this.x = this.o.xMode === "stream" ? new XFilteredStream(token) : new XSearchPoller(token, c.x.pollIntervalSec);
      } else if (c.x.provider) {
        const s = secret(c.x.provider.secretEnv, this.secrets());
        if (s) this.x = new ProviderWebhook(c.x.provider.listenPort, s);
      }
      if (this.x) {
        await this.x.setHandles(handles);
        await this.x.start(
          (post) => void this.onSignal({ kind: "x-post", post }),
          (e) => this.state.log({ kind: "error", message: `X: ${e.message}` }),
        );
        this.state.log({ kind: "status", message: `Watching ${handles.length} X account${handles.length === 1 ? "" : "s"} via ${this.x.name}` });
        const rs = this.x instanceof RelayWatcher ? this.x.lastSubscribe : undefined;
        if (rs?.notCarried.length) this.state.log({ kind: "status", message: `Relay doesn't carry ${rs.notCarried.map((n) => `@${n.handle} (${n.reason})`).join(", ")}. Use your own X key for those.` });
      }
    }
    if (c.launches.enabled && this.rules().some((r) => r.enabled && r.trigger.kind === "new-launch")) {
      this.launches = new PumpLaunchWatcher();
      this.launches.start((launch) => void this.onSignal({ kind: "new-launch", launch }), (e) => this.state.log({ kind: "error", message: e.message }));
      this.state.log({ kind: "status", message: "Watching new pump.fun launches" });
    }
    if (c.coin) {
      const posters: Poster[] = [];
      const xUser = secret("X_USER_TOKEN", this.secrets());
      if (c.coin.postTo.x && xUser) posters.push(new XPoster(c.coin.postTo.x, xUser));
      const tg = secret(c.telegram.botTokenEnv, this.secrets());
      if (c.coin.postTo.telegramChatId && tg) posters.push(new TelegramPoster(c.coin.postTo.telegramChatId, tg));
      this.coin = new CoinManager(c.coin, { rpc: this.rpc, state: this.state, executor: this.executor, posters, model: this.model });
      this.coin.start();
    }
    // v26: creates on pump.fun, for the clash check, race reports and pair discovery
    this.pairsSeen.load(this.state.data.seenQuotes ?? []);
    if (this.launchRules().some((r) => r.enabled)) {
      this.creates = new CreateStream({ onQuote: (m) => this.pairsSeen.ingest(m) });
      this.creates.start();
      this.state.log({ kind: "status", message: "Watching pump.fun creates (ticker clash check, race reports)" });
    }
    // Warm connections on the launch path, so a launch on a post doesn't pay for TLS handshakes.
    if (this.launchRules().some((r) => r.enabled) || this.presets().length) this.stopWarm = keepWarm([endpoints.pumpPortal(), `${c.rpc.jito.blockEngineUrl}/api/v1/bundles`, c.rpc.url]);
    this.syncMigrations();
    this.copy.sync();
    this.runner.sync();
    this.timers.push(setInterval(() => void this.exitLoop(), 3000));
    this.timers.push(setInterval(() => void this.orderLoop(), 2000));
    this.syncDevSell();
    this.timers.push(setInterval(() => void this.controlLoop(), 2000));
    // v20: the lanes right now, for `vesk live` (saved with the state)
    this.timers.push(setInterval(() => { this.state.data.work = { ...this.work.stats(), at: Date.now() }; }, 1000));
    if (this.panel && c.panel?.report) {
      this.timers.push(setInterval(() => void this.reportLoop(), 10_000));
      this.timers.push(setInterval(() => void this.pollLoop(), 2_000));
    }
    await writeFile(join(c.dataDir, "agent.pid"), String(process.pid));
    await this.state.save();
  }

  async stop(reason = "stopped"): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.x?.stop();
    this.launches?.stop();
    this.creates?.stop();
    this.migrations?.stop();
    this.tradeFeed?.stop();
    this.copy.stop();
    this.runner.stop();
    this.coin?.stop();
    for (const r of this.coinRuns.values()) r.m.stop();
    this.stopWarm?.();
    this.state.data.status = "stopped";
    this.state.log({ kind: "status", message: `Agent ${reason}` });
    await this.state.save();
  }

  // ---------- migration orders ----------

  migrationOrders(): MigrationOrder[] {
    return normalizeMigrationOrders(this.store.data.migration);
  }

  /** Listen for migrations while any order is armed; stop when none are. */
  syncMigrations() {
    const armed = armedCount(this.migrationOrders());
    if (armed && !this.migrations) {
      this.migrations = new MigrationWatcher((e) => void this.onMigration(e), (e) => this.state.log({ kind: "error", message: e.message }));
      this.migrations.start();
      this.state.log({ kind: "status", message: `Watching migrations for ${armed} armed order${armed === 1 ? "" : "s"}` });
    } else if (!armed && this.migrations) {
      this.migrations.stop();
      this.migrations = undefined;
    }
  }

  /** A coin migrated: fire the armed orders on it (sells first), each through the executor and its guardrails. */
  async onMigration(e: MigrationEvent): Promise<void> {
    const fire = matchMigration(this.migrationOrders(), e);
    if (!fire.length) return;
    if (this.status === "paused") return void this.state.log({ kind: "skip", message: `Migration of ${e.mint.slice(0, 4)}…: agent is paused, orders stay armed`, mint: e.mint });
    for (const o of fire) {
      const x = await this.tradeParams(o.side, o.preset);
      const fees = { slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly };
      const why = `${describeMigrationOrder(o)}${e.pool ? ` (${e.pool})` : ""}`;
      this.state.log({ kind: "signal", message: `Migrated: ${o.symbol ?? e.mint.slice(0, 4) + "…"} → ${e.pool ?? "AMM"}`, mint: e.mint });
      const r = o.side === "buy"
        ? await this.executor.buy({ action: "buy", wallet: this.address, mint: o.mint, amountSol: o.amountSol ?? 0, ...fees, venue: "auto", reason: why }, o.symbol ?? o.mint.slice(0, 4))
        : await this.executor.sell({ action: "sell", wallet: this.address, mint: o.mint, sellPct: o.pct ?? 100, ...fees, venue: "auto", reason: why });
      this.store.data.migration = settleMigration(this.migrationOrders(), o.id, r.ok, r.ok ? (r.signature ?? "ok") : (r.error ?? "failed"));
    }
    await this.store.save();
    await this.state.save();
    this.syncMigrations();
  }

  /** One compact snapshot for the CLI header and the periodic status line. Public data only. */
  async summary() {
    const bal = await this.rpc.getBalanceSol(this.address).catch(() => null);
    const open = this.state.data.positions;
    return {
      status: this.status, paper: !!this.o.paper, wallet: this.address, balanceSol: bal,
      rpc: { kind: rpcKind(this.o.config.rpc.url), p50Ms: this.latency?.p50, ws: !!this.rpc.wsUrl },
      model: this.o.config.model.provider,
      rules: { snipe: this.rules().filter((r) => r.enabled).length, launch: this.launchRules().filter((r) => r.enabled).length },
      x: { source: this.x ? this.x.name : "off", accounts: this.watchedHandles().length },
      todayPnlSol: this.state.realizedToday(), spentTodaySol: this.state.spentToday(), openPositions: open.length,
    };
  }

  get status(): AgentStatus {
    return this.state.data.status;
  }

  setPaused(p: boolean) {
    this.state.data.status = p ? "paused" : "online";
    this.state.log({ kind: "status", message: p ? "Paused: rules won't fire. Exits on open positions keep running." : "Resumed" });
  }

  async setKillSwitch(on: boolean) {
    this.store.data.limits = { ...(this.store.data.limits ?? {}), killSwitch: on };
    await this.store.save();
    this.state.log({ kind: "guardrail", message: on ? "Kill switch ON: no new buys." : "Kill switch off" });
  }

  /** A signal arrives: run every enabled rule, buy at most once per mint per signal. */
  /** Recent posts from the 24/7 watcher, newest last (the tracker feed). */
  readonly feed: FeedPost[] = [];

  async onSignal(s: Signal): Promise<void> {
    if (s.kind === "x-post") {
      if (!this.state.data.seenPosts.includes(s.post.id)) {
        this.feed.push(enrichPost(s.post, this.store.data.trackerGroups ?? []));
        if (this.feed.length > 300) this.feed.splice(0, 100);
      }
      if (this.state.data.seenPosts.includes(s.post.id)) return;
      this.state.data.seenPosts.push(s.post.id);
      if (this.state.data.seenPosts.length > 2000) this.state.data.seenPosts.splice(0, 500);
    }
    if (this.status !== "online") return;
    const bought = new Set<string>();
    const source = s.kind === "x-post" ? "x" : s.kind === "new-launch" ? "pulse" : "panel";
    for (const rule of this.rules()) {
      const m = matchSignal(rule, s);
      if (!m.match) {
        this.auditMiss(rule, s, m.reason, source);
        continue;
      }
      if (bought.has(m.mint)) continue;
      // v19: one pipeline candidate per rule match, the same id from Watch to Execute
      const id = `${rule.id.slice(0, 8)}-${m.mint.slice(0, 6)}-${Date.now().toString(36)}`;
      const symbol = s.kind === "new-launch" ? s.launch.symbol : m.mint.slice(0, 4);
      const stage = (st: Parameters<State["stage"]>[0]) => this.state.stage({ ...st, mint: m.mint, symbol, source });
      stage({ id, stage: "watch", outcome: "pass", reason: m.why });
      const bl = blacklistHit(this.blacklist(), { mint: m.mint, dev: s.kind === "new-launch" ? s.launch.creator : undefined });
      if (bl) {
        this.state.log({ kind: "skip", message: `Skipped: ${bl}`, mint: m.mint, ruleId: rule.id });
        stage({ id, stage: "check", outcome: "fail", reason: `Not bought: ${bl}.`, action: "filtered", result: "not traded" });
        continue;
      }
      this.state.log({ kind: "signal", message: `${m.why}: ${m.mint.slice(0, 4)}…${m.mint.slice(-4)}`, mint: m.mint, ruleId: rule.id });
      stage({ id, stage: "check", outcome: "start" });
      if (!(await this.rpc.isMint(m.mint).catch(() => true))) {
        this.state.log({ kind: "skip", message: "Address is not a token mint", mint: m.mint, ruleId: rule.id });
        stage({ id, stage: "check", outcome: "fail", reason: "Address is not a token mint", action: "skipped", result: "not traded" });
        continue;
      }
      const market = await snapshot(this.rpc, m.mint).catch(() => null);
      const d = decideBuy(rule, m, market, { buysToday: this.state.ruleBuysToday(rule.id), lastFiredAt: this.state.data.lastFired[rule.id], holding: (x) => this.state.holding(x) });
      if (!d.ok) {
        this.state.log({ kind: "skip", message: d.reason, mint: m.mint, ruleId: rule.id });
        stage({ id, stage: "check", outcome: "fail", reason: d.reason, action: "skipped", result: "not traded" });
        continue;
      }
      const x = rule.buy.preset ? await this.tradeParams("buy", rule.buy.preset) : null;
      stage({ id, stage: "size", outcome: "pass", amountSol: d.amountSol, preset: rule.buy.preset, reason: rule.buy.preset ? `preset ${rule.buy.preset.toUpperCase()}` : "rule amount" });
      const r = await this.executor.buy({ action: "buy", wallet: this.address, mint: d.mint, dev: s.kind === "new-launch" ? s.launch.creator : undefined, amountSol: d.amountSol, slippageBps: x?.slippageBps ?? d.slippageBps, priorityFeeSol: x?.priorityFeeSol ?? d.priorityFeeSol, jitoTipSol: x ? x.jitoTipSol : d.jitoTipSol, jitoOnly: x?.jitoOnly, venue: d.venue, reason: d.why + (x ? ` · ${rule.buy.preset!.toUpperCase()}` : ""), ruleId: rule.id, origin: "snipe", trace: { id, symbol, source } }, symbol);
      if (r.ok) {
        bought.add(d.mint);
        // the position is open: its exits are armed (Live moves the candidate on to Exit)
        stage({ id, stage: "exit", outcome: "pass", reason: `armed: ${describeExit(rule.exit).slice(0, 2).join(" · ") || "no exits set"}` });
      }
    }
    if (s.kind === "x-post") await this.onLaunchPost(s.post).catch((e: Error) => this.state.log({ kind: "error", message: `Launch on post: ${e.message}` }));
  }

  /**
   * v19: a coin a rule looked at and its audits refused (dev holding, top 10, socials, authorities; a reply or repost
   * from a watched account) shows in Live's filtered lane. Not-for-this-rule misses ("not a launch rule", someone not
   * on the rule) aren't candidates. At most one every 1.5 s, so a busy launch feed can't flood the pipeline.
   */
  private lastAudit = 0;
  private auditMiss(rule: Rule, s: Signal, reason: string, source: "x" | "pulse" | "panel") {
    if (/^(not an X rule|not a launch rule|rule is off|manual signal)$|is not on this rule$/.test(reason)) return;
    const now = Date.now();
    if (now - this.lastAudit < 1500) return;
    this.lastAudit = now;
    const mint = s.kind === "new-launch" ? s.launch.mint : undefined, symbol = s.kind === "new-launch" ? s.launch.symbol : undefined;
    const id = `${rule.id.slice(0, 8)}-a-${now.toString(36)}`;
    this.state.stage({ id, stage: "watch", outcome: "pass", source, mint, symbol, reason: s.kind === "x-post" ? `@${s.post.handle} posted` : `new pair ${symbol}` });
    this.state.stage({ id, stage: "check", outcome: "fail", source, mint, symbol, reason, action: "filtered", result: "not traded" });
  }

  // ---------- launch on post ----------

  launchRules(): LaunchOnPostRule[] {
    const saved = this.store.data.launchRules ?? [];
    // v26: rules from the config file too (`launchRules:` in vesk.config.yaml); a saved rule with the same id wins
    const fromFile = configLaunchRules(this.o.config).filter((r) => !saved.some((x) => x.id === r.id));
    return [...saved, ...fromFile].map((r) => effectiveRule(r, this.presets()));
  }

  presets(): LaunchPreset[] {
    return this.store.data.presets ?? [];
  }

  /** Image for a post, started the moment the post arrives (runs while the name is being drafted). */
  private resolveImage(r: LaunchOnPostRule, post: XPost) {
    const pick = pickImage(r, post);
    const key = secret("OPENAI_API_KEY", this.secrets());
    if (pick.kind === "url") {
      // v26: the post photo as PNG (X's CDN serves one) so it can be cropped square; the minimum size is checked first
      const crop = r.coin.crop !== false, minPx = r.coin.minImagePx ?? 256;
      return imageFromUrl(crop ? xPngVariant(pick.url) : pick.url).catch(() => imageFromUrl(pick.url)).then(async (img) => {
        const p = await prepareCoinImage(img, { crop, minPx });
        if (p.ok) { this.state.log({ kind: "status", message: `Post image: ${p.note}` }); return p.image; }
        if (r.coin.defaultImage) { this.state.log({ kind: "status", message: `Post image skipped: ${p.reason}; using your image` }); return imageFromFile(r.coin.defaultImage); }
        throw new Error(`No image: ${p.reason}, and no image of yours is set.`);
      });
    }
    if (pick.kind === "generate" && key) return generateImage(`Square memecoin logo inspired by this post: "${post.text.slice(0, 200)}". No text, no logos, no real person's face.`, key);
    if (r.coin.defaultImage) return imageFromFile(r.coin.defaultImage);
    return Promise.reject(new Error("No image: the post has none and no default image is set."));
  }

  /**
   * Deploy a coin on a post with a preset (tracker "Deploy" / "Instant deploy"). Same honesty rules, guardrails,
   * dedupe and limits as launch-on-post rules. Overrides come from the Deploy card.
   */
  async deployPost(post: XPost, presetId?: string, overrides: Partial<TokenDetails> = {}): Promise<string | null> {
    const preset = this.presets().find((p) => p.id === (presetId ?? this.store.data.defaultPresetId)) ?? this.presets()[0];
    if (!preset) throw new Error("Create a launch preset first (Settings → Launch presets, or `vesk presets add`).");
    const r = ruleFromPreset(preset, post.handle);
    const tl = new Timeline();
    const g = checkAutoLaunch(r, post, { killSwitch: this.limits().killSwitch, history: this.state.data.launchHistory });
    if (!g.ok) throw new Error(g.reason);
    const imgP = this.resolveImage(r, post);
    imgP.catch(() => undefined);
    const d = draftFor(r, post, r.coin.naming === "model" ? await this.suggest(post) : null);
    const token = { ...d.token, ...overrides };
    const again = draftFor({ ...r, coin: { ...r.coin, naming: "template" } }, post, { name: token.name, symbol: token.symbol, description: overrides.description ?? d.token.description });
    if (again.errors.length || d.errors.length) throw new Error([...d.errors, ...again.errors][0]);
    tl.mark("drafted");
    return this.launchFromPost(r, post, { ...again.token, telegram: token.telegram, website: token.website ?? again.token.website }, { imgP, tl });
  }

  private async suggest(post: XPost, style?: LaunchOnPostRule["coin"]["style"]): Promise<Suggestion | null> {
    if (!this.model) return null;
    try {
      const raw = await this.model.chat([{ role: "system", content: postLaunchPrompt(style) }, { role: "user", content: `Post by @${post.handle}:\n${post.text.slice(0, 600)}` }], { json: true, maxTokens: 200, temperature: 0.8 });
      return JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as Suggestion;
    } catch {
      return null;
    }
  }

  /** v26: launched coins of a rule that are still open (maxOpenCoins). */
  private openLaunched(ruleId: string): number {
    return this.state.data.positions.filter((p) => p.launched?.ruleId === ruleId && p.tokens > 0).length;
  }

  /** v26: watch a post's likes until the rule's velocity is met or the wait is over (X API only; else it says so). */
  private async waitVelocity(r: LaunchOnPostRule, post: XPost, v: NonNullable<LaunchOnPostRule["trigger"]["velocity"]>): Promise<{ go: true; note: string } | { go: false; reason: string }> {
    const token = secret(this.o.config.x.bearerTokenEnv, this.secrets());
    const postAt = +new Date(post.createdAt) || Date.now();
    const samples: Array<{ ms: number; likes?: number }> = [{ ms: Math.max(0, Date.now() - postAt), likes: post.metrics?.likes }];
    const every = Number(process.env.VESK_VELOCITY_POLL_MS ?? 5000);
    this.state.log({ kind: "status", message: `@${post.handle}: waiting up to ${v.waitSec} s for ${v.likes} likes (${r.name})` });
    for (;;) {
      const d = velocityDecision(v, samples, Date.now() - postAt);
      if (d.go) return d;
      if (!d.wait) return { go: false, reason: d.reason };
      await new Promise((res) => setTimeout(res, every));
      const m = token ? await postMetrics(token, post.id).catch(() => null) : null;
      samples.push({ ms: Date.now() - postAt, likes: m?.likes });
    }
  }

  /** v26: keep the posts launch-on-post accounts made (7 days, at most 3000), for backtests when the X source has no history. */
  private logPost(post: XPost) {
    const watched = new Set(this.launchRules().flatMap((r) => r.trigger.handles.map((h) => h.toLowerCase())));
    if (!watched.has(post.handle.toLowerCase())) return;
    const log = (this.state.data.postLog ??= []);
    if (log.some((p) => p.id === post.id)) return;
    log.push({ id: post.id, handle: post.handle, text: post.text.slice(0, 600), urls: post.urls.slice(0, 4), createdAt: post.createdAt, media: post.media?.slice(0, 2), isReply: post.isReply, isQuote: post.isQuote, isRepost: post.isRepost, lang: post.lang, metrics: post.metrics });
    const cut = Date.now() - 7 * 86_400_000;
    this.state.data.postLog = log.filter((p) => +new Date(p.createdAt) >= cut).slice(-3000);
  }

  /** A watched account posted: match launch-on-post rules, check limits, draft, then launch (auto) or ask (confirm). */
  async onLaunchPost(post: XPost): Promise<void> {
    this.logPost(post);
    for (const r0 of this.launchRules()) {
      const r = normalizeLaunchRule(r0);
      const m = matchLaunchPost(r, post);
      if (!m.ok) continue;
      // v26: Live's lanes: the candidate, with why it matched and where it stopped
      const cid = `${r.id.slice(0, 8)}-p-${post.id.slice(-10)}`;
      const lane = (stage: "watch" | "check" | "size" | "execute", outcome: "start" | "pass" | "fail" | "done", reason: string, extra: Record<string, unknown> = {}) => this.state.stage({ id: cid, stage, outcome, source: "launch", reason, ...extra });
      lane("watch", "pass", `@${post.handle} posted · ${r.name}${m.notes.length ? ` · ${m.notes[0]}` : ""}`);
      if (!this.strategy().sources.launchOnPost) { this.state.log({ kind: "skip", message: `Launch on @${post.handle} post skipped: ${sourceOffReason("launch-on-post")}` }); lane("check", "fail", sourceOffReason("launch-on-post"), { action: "skipped", result: "not launched" }); continue; }
      const hist = this.state.data.launchHistory;
      const skip = (reason: string, kind: "skip" | "guardrail" = "skip") => {
        this.state.log({ kind, message: `Launch on @${post.handle} post skipped: ${reason}` });
        hist.push({ at: Date.now(), ruleId: r.id, handle: post.handle, postId: post.id, status: "skipped", sol: 0, reason, postUrl: postUrl(post), postText: post.text.slice(0, 280) });
        lane("check", "fail", reason, { action: "skipped", result: "not launched" });
      };
      const g = checkAutoLaunch(r, post, { killSwitch: this.limits().killSwitch, history: hist, openLaunched: this.openLaunched(r.id) });
      if (!g.ok) {
        if (g.code === "launch-dedupe") { this.state.log({ kind: "skip", message: `Launch on @${post.handle} post skipped: ${g.reason}` }); lane("check", "fail", g.reason, { action: "skipped", result: "not launched" }); }
        else skip(g.reason, "guardrail");
        continue;
      }
      // v26: priority: an account lower in the list waits, so a same-topic post from one higher up can win
      const hold = priorityHold(r, post.handle);
      if (hold) {
        lane("check", "start", `waiting ${hold} s for accounts higher in the list`);
        await new Promise((res) => setTimeout(res, hold * 1000));
      }
      const topic = topicClash(r, post, hist);
      if (topic) { skip(topic); continue; }
      for (const n of m.notes) this.state.log({ kind: "status", message: `@${post.handle}: ${n}` });
      if (m.wait) {
        lane("check", "start", `waiting up to ${m.wait.waitSec} s for ${m.wait.likes} likes`);
        const v = await this.waitVelocity(r, post, m.wait);
        if (!v.go) { skip(v.reason); continue; }
        this.state.log({ kind: "signal", message: `@${post.handle}: ${v.note}` });
      }
      const tl = new Timeline();
      const imgP = r.mode === "auto" && !this.o.paper ? this.resolveImage(r, post) : null;
      imgP?.catch(() => undefined);
      // v26: the image half of the clash check starts now, while the name is drafted
      const imgHash = this.imageClashPrep(r, post);
      const sug = r.coin.naming === "model" || r.coin.naming === "ask" ? await this.suggest(post, r.coin.style) : null;
      const d = draftToken(r, post, sug);
      tl.mark("drafted");
      if (d.errors.length) { skip(`refused: ${d.errors.join("; ")}`, "guardrail"); continue; }
      // v26: the clash check against recent pump.fun creates (post link, image, ticker, name)
      const clash = await this.clashFor(r, post, d.token, imgHash);
      if (!clash.go) { skip(clash.reason); continue; }
      const token = { ...d.token, symbol: clash.symbol };
      if (clash.note) this.state.log({ kind: "status", message: `@${post.handle}: ${clash.note}` });
      tl.mark("clash");
      lane("check", "pass", `limits ok · ${clash.note ?? "no clash"}`, { symbol: token.symbol });
      if (r.mode === "confirm") {
        const ask = r.coin.naming === "ask";
        const p: PendingLaunch = {
          id: Math.random().toString(36).slice(2, 8), ruleId: r.id, handle: post.handle, postId: post.id, postUrl: postUrl(post), postText: post.text.slice(0, 280),
          imageUrl: post.media?.find((x) => x.type === "photo")?.url, token, devBuySol: r.plan.mode === "standard" ? r.plan.devBuySol : 0, teamWallets: r.plan.teamWallets,
          exitSummary: describeLaunchExit(r.exit), createdAt: Date.now(), expiresAt: Date.now() + r.confirmTtlSec * 1000,
          quote: token.quote, clashNote: clash.note, postAt: +new Date(post.createdAt) || Date.now(), reason: `Matched ${r.name}`,
          ...(ask ? { ask: true, suggestions: askSuggestions(r, post, sug) } : {}),
        };
        this.state.data.pendingLaunches.push(p);
        hist.push({ at: Date.now(), ruleId: r.id, handle: post.handle, postId: post.id, status: "pending", sol: 0, symbol: token.symbol, postText: post.text.slice(0, 280), postUrl: p.postUrl });
        this.state.log({ kind: "signal", message: pendingText(p) });
        lane("execute", "start", ask ? `draft sent · waiting for your name and Launch (${r.confirmTtlSec} s)` : `draft sent · Launch or Skip within ${r.confirmTtlSec} s`, { symbol: token.symbol });
        await this.state.save();
        continue;
      }
      const mint = await this.launchFromPost(r, post, token, { imgP: imgP ?? undefined, tl, clash: clash.record, image: imgHash });
      if (mint) lane("execute", "done", `launched from @${post.handle}'s post in ${tl.total} ms`, { mint, symbol: token.symbol, action: "launched", result: `${spendOf(r)} SOL dev buy`, ms: tl.total });
      else lane("execute", this.o.paper ? "done" : "fail", this.o.paper ? "paper: would launch" : "launch failed (see the log)", { symbol: token.symbol, paper: this.o.paper || undefined, action: this.o.paper ? "launched" : "skipped" });
    }
  }

  /**
   * v26: the image half of the clash check, started when a post matches: the post photo's hashes, and the hashes of the
   * images of creates in the clash window (40 newest at most). Resolves to the post photo's hashes; null when the rule
   * turned image matching off, the post has no photo, or the create stream isn't running.
   */
  private imageClashPrep(r: LaunchOnPostRule, post: XPost): Promise<ImageHash | null> | null {
    const c = normalizeLaunchRule(r).clash!;
    const photo = post.media?.find((x) => x.type === "photo");
    if (!this.creates || c.image === false || !photo) return null;
    const feed = this.creates.feed;
    const mine = imageFromUrl(photo.url).then((i) => imageHashes(i.bytes));
    const theirs = Promise.all(feed.between(Date.now() - c.windowSec * 1000).filter((x) => x.imageUrl && !x.image).slice(-40)
      .map((x) => imageFromUrl(x.imageUrl!).then((i) => imageHashes(i.bytes)).then((h) => feed.update(x.mint, { image: h })).catch(() => undefined)));
    const p = Promise.all([mine, theirs]).then(([m]) => m).catch(() => null);
    p.catch(() => undefined);
    return p;
  }

  /** v26: the clash check for a draft: the rule's action applied to recent creates of the same post, image, ticker or name. */
  private async clashFor(r: LaunchOnPostRule, post: XPost, token: TokenDetails, imgHash?: Promise<ImageHash | null> | null): Promise<{ go: true; symbol: string; note?: string; record?: LaunchRecord["clash"] } | { go: false; reason: string }> {
    const c = r.clash ?? { action: "skip" as const, windowSec: 120 };
    if (!this.creates) return { go: true, symbol: token.symbol };
    // image matching never holds a launch more than 0.3 s past the draft
    const image = imgHash ? await Promise.race([imgHash, new Promise<null>((res) => setTimeout(() => res(null), 300))]) : null;
    const recent = this.creates.feed.between(Date.now() - c.windowSec * 1000);
    const found = checkClash(token, postUrl(post), recent, image);
    const res = resolveClash(c.action, found, token, recent);
    if (!res.go) return res;
    return { go: true, symbol: res.symbol, note: res.note, record: found ? { kind: found.kind, action: c.action, ...(res.renamedFrom ? { renamedFrom: res.renamedFrom } : {}) } : undefined };
  }

  /** Launch / Skip a pending draft (Telegram, panel, CLI). v26: `name` names the coin (naming "ask", or to change it). */
  async decidePending(id: string, launch: boolean, name?: { name: string; symbol: string }): Promise<string> {
    const list = this.state.data.pendingLaunches;
    const p = list.find((x) => x.id === id);
    if (!p) return "No draft with that id (it may have expired).";
    if (launch && p.ask && !name && Date.now() <= p.expiresAt) return `Name it first: /launch ${p.id} Name $TICKER${p.suggestions?.length ? ` (or tap: ${p.suggestions.map((x) => `${x.name} $${x.symbol}`).join(", ")})` : ""}`;
    if (launch && name) {
      const n = applyName(p.token, { handle: p.handle, id: p.postId }, name);
      if (n.errors.length) return `That name was refused: ${n.errors[0]}.`;
      p.token = n.token;
    }
    this.state.data.pendingLaunches = list.filter((x) => x !== p);
    const rec = this.state.data.launchHistory.find((h) => h.postId === p.postId && h.status === "pending");
    if (Date.now() > p.expiresAt) {
      if (rec) rec.status = "expired";
      return "That draft expired.";
    }
    if (!launch) {
      if (rec) rec.status = "skipped";
      this.state.log({ kind: "skip", message: `Skipped the $${p.token.symbol} draft from @${p.handle}'s post` });
      await this.state.save();
      return "Skipped.";
    }
    const r = this.launchRules().find((x) => x.id === p.ruleId);
    if (!r) return "The rule for that draft is gone.";
    if (rec) this.state.data.launchHistory = this.state.data.launchHistory.filter((h) => h !== rec);
    const post: XPost = { id: p.postId, handle: p.handle, text: p.postText, urls: [], createdAt: new Date(p.postAt ?? p.createdAt).toISOString(), media: p.imageUrl ? [{ type: "photo", url: p.imageUrl }] : undefined };
    const g = checkAutoLaunch(r, post, { killSwitch: this.limits().killSwitch, history: this.state.data.launchHistory, openLaunched: this.openLaunched(r.id) });
    if (!g.ok) return g.reason;
    // the clash check again: time has passed since the draft
    const clash = await this.clashFor(normalizeLaunchRule(r), post, p.token);
    if (!clash.go) return clash.reason;
    const res = await this.launchFromPost(r, post, { ...p.token, symbol: clash.symbol }, { clash: clash.record });
    return res ? `Launched $${clash.symbol}: https://pump.fun/coin/${res}` : "Launch failed. See the log.";
  }

  /** Timed sells need second precision, so each one gets its own timer (the 3 s exit loop is the safety net). */
  scheduleTimedSells(mint: string, exit: LaunchOnPostRule["exit"]) {
    for (const [i, t] of (exit.timeSells ?? []).entries()) {
      setTimeout(() => {
        const p = this.state.data.positions.find((x) => x.mint === mint && x.wallet === this.address);
        if (!p || p.tpDone.includes(TIME_STEP + i)) return;
        this.state.log({ kind: "timeout", message: `${p.symbol}: ${t.afterSec} s after launch, selling ${t.sellPct}%`, mint });
        void this.executor.sell({ action: "sell", wallet: this.address, mint, sellPct: t.sellPct, reason: `timed sell ${t.afterSec} s`, slippageBps: 2500 }, TIME_STEP + i);
      }, t.afterSec * 1000);
    }
  }

  private expirePending() {
    const now = Date.now();
    for (const p of this.state.data.pendingLaunches.filter((x) => x.expiresAt < now)) {
      const rec = this.state.data.launchHistory.find((h) => h.postId === p.postId && h.status === "pending");
      if (rec) rec.status = "expired";
      this.state.log({ kind: "skip", message: `Draft $${p.token.symbol} from @${p.handle}'s post expired without a decision` });
    }
    this.state.data.pendingLaunches = this.state.data.pendingLaunches.filter((x) => x.expiresAt >= now);
  }

  private async launchFromPost(r: LaunchOnPostRule, post: XPost, token: TokenDetails, fast: { imgP?: Promise<LaunchInput["image"]>; tl?: Timeline; clash?: LaunchRecord["clash"]; image?: Promise<ImageHash | null> | null } = {}): Promise<string | null> {
    const tl = fast.tl ?? new Timeline();
    const hist = this.state.data.launchHistory;
    const postAt = +new Date(post.createdAt) || Date.now();
    const rec: LaunchRecord = { at: Date.now(), ruleId: r.id, handle: post.handle, postId: post.id, status: "launched", sol: spendOf(r), symbol: token.symbol, name: token.name, postUrl: postUrl(post), postAt, postText: post.text.slice(0, 280), quote: token.quote, ...(fast.clash ? { clash: fast.clash } : {}) };
    const team = (await this.wallets().catch(() => [])).filter((w) => !w.main && w.active).map((w) => w.address);
    const plan = planFor(r, token, team);
    if (this.o.paper) {
      hist.push({ ...rec, status: "paper" });
      this.state.log({ kind: "launch", message: `[paper] Would launch ${token.name} ($${token.symbol}) from @${post.handle}'s post, ${plan.mode}${plan.mode === "standard" ? `, ${plan.devBuySol} SOL dev buy` : ""}${token.quote !== "SOL" ? `, ${token.symbol}/${token.quote}` : ""}` });
      await this.state.save();
      return null;
    }
    try {
      const image = await (fast.imgP ?? this.resolveImage(r, post));
      tl.mark("image");
      const res = await this.launch(plan, image, (e) => {
        if (e.step === "build") tl.mark("metadata");
        else if (e.step === "bundle") tl.mark("built");
        else if (e.step === "landed") tl.mark("landed");
      }, `from @${post.handle}'s post`);
      if (tl.marks[tl.marks.length - 1].mark !== "landed") tl.mark("landed");
      const landedAt = Date.now();
      this.state.log({ kind: "status", message: `$${token.symbol}: post received → landed in ${tl.total} ms (${tl.toString()})`, mint: res.mint });
      this.scheduleTimedSells(res.mint, r.exit);
      const pos = this.state.data.positions.find((x) => x.mint === res.mint && x.wallet === this.address);
      if (pos) Object.assign(pos, { exit: r.exit, launched: { ruleId: r.id, handle: post.handle, postId: post.id } });
      else this.state.data.positions.push({ mint: res.mint, symbol: token.symbol, wallet: this.address, tokens: 0, costSol: 0, avgEntryPriceSol: 0, highestPriceSol: 0, tpDone: [], realizedSol: 0, openedAt: Date.now(), exit: r.exit, launched: { ruleId: r.id, handle: post.handle, postId: post.id } });
      const done: LaunchRecord = { ...rec, mint: res.mint, timings: tl.marks, landedAt };
      hist.push(done);
      this.scheduleRace(done, normalizeLaunchRule(r).race!.windowMin, fast.image ? await Promise.race([fast.image, Promise.resolve(null)]).catch(() => null) : null);
      await this.state.save();
      return res.mint;
    } catch (e) {
      hist.push({ ...rec, status: "failed", reason: (e as Error).message });
      this.state.log({ kind: "error", message: `Launch from @${post.handle}'s post failed: ${(e as Error).message}` });
      return null;
    }
  }

  /**
   * v26: the race report for a launch: first a minute after landing (VESK_RACE_DELAY_MS), then once the window has
   * passed. Stored on the launch record; logged when it changes.
   */
  private scheduleRace(rec: LaunchRecord, windowMin: number, image: ImageHash | null = null) {
    const first = Number(process.env.VESK_RACE_DELAY_MS ?? 60_000);
    const compute = () => {
      if (!rec.mint || !rec.postUrl) return;
      const postAt = rec.postAt ?? rec.at;
      const creates = this.creates?.feed.between(postAt - windowMin * 60_000, postAt + windowMin * 60_000) ?? [];
      const since = this.creates?.connectedSince ?? null;
      const rep = raceReport({ mint: rec.mint, name: rec.name ?? rec.symbol ?? "", symbol: rec.symbol ?? "", landedAt: rec.landedAt ?? rec.at }, { id: rec.postId, url: rec.postUrl, at: postAt }, creates, { windowMin, complete: since !== null && since <= postAt - windowMin * 60_000, image });
      const before = rec.race ? `${rec.race.rank}/${rec.race.total}` : "";
      rec.race = rep;
      const live = this.state.data.launchHistory.find((h) => h.mint === rec.mint && h.status === "launched");
      if (live && live !== rec) live.race = rep;
      if (`${rep.rank}/${rep.total}` !== before) this.state.log({ kind: "status", message: `Race report $${rec.symbol}: ${raceLabel(rep)}${rep.complete ? "" : " (the create stream wasn't connected the whole window)"}`, mint: rec.mint });
      void this.state.save();
    };
    const t1 = setTimeout(compute, Math.min(first, windowMin * 60_000));
    const t2 = setTimeout(compute, windowMin * 60_000 + 1000);
    this.timers.push(t1 as unknown as ReturnType<typeof setInterval>, t2 as unknown as ReturnType<typeof setInterval>);
  }

  // ---------- v26: pairs, stats, backtest, races ----------

  /** The pair list with what pair discovery has seen merged in. */
  pairs(): PairAsset[] { return this.pairsSeen.pairs(PUMPFUN_PAIRS); }

  /** v26: the last on-chain check of each custom-pair mint (by mint). A passing one shows "Verified on-chain". */
  pairChecks(): Record<string, PairCheck> { return this.state.data.pairChecks ?? {}; }
  private notePairCheck(mint: string, c: MintCheck) { (this.state.data.pairChecks ??= {})[mint] = pairCheckOf(mint, c); }
  /** v26: read one pair's mint on chain now (the panel's picker, `vesk pairs --check`, MCP) and remember the result. */
  async checkPair(idOrMint: string): Promise<{ pair: PairAsset; check: MintCheck } | { error: string }> {
    const pair = findPair(idOrMint, this.pairs());
    if (!pair) return { error: `${idOrMint} isn't in the pair list.` };
    if (pair.mint === "native") return { error: "SOL is native: there's no mint to check." };
    if (!pair.mint || pair.status === "unavailable") return { error: `${pair.id} isn't available yet: no mint is listed, so nothing is guessed.` };
    const check = await verifyQuoteMint(this.rpc, pair.mint, { decimals: pair.decimals });
    this.notePairCheck(pair.mint, check);
    await this.state.save();
    return { pair, check };
  }

  /** Decimals and name / symbol of a mint from chain (Token-2022 metadata or Metaplex). */
  private async describeMint(mint: string): Promise<{ symbol?: string; name?: string; decimals?: number } | null> {
    const v = await this.rpc.getAccountInfo(mint, "jsonParsed").catch(() => null) as { data?: { parsed?: { info?: { decimals?: number; extensions?: Array<{ extension?: string; state?: { name?: string; symbol?: string } }> } } } } | null;
    const info = v?.data?.parsed?.info;
    const t22 = info?.extensions?.find((e) => e.extension === "tokenMetadata")?.state;
    let name = t22?.name, symbol = t22?.symbol;
    if (!name) {
      try {
        const { PublicKey } = await import("@solana/web3.js");
        const META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
        const pda = PublicKey.findProgramAddressSync([new TextEncoder().encode("metadata"), new PublicKey(META).toBytes(), new PublicKey(mint).toBytes()], new PublicKey(META))[0].toBase58();
        const m = await this.rpc.getAccountInfo(pda, "base64").catch(() => null) as { data?: [string, string] } | null;
        const md = m?.data ? parseMetaplex(Uint8Array.from(atob(String(m.data[0])), (c) => c.charCodeAt(0))) : null;
        name = md?.name; symbol = md?.symbol;
      } catch { /* no metadata */ }
    }
    return info ? { decimals: info.decimals, name, symbol } : null;
  }

  launchRuleStats(ruleId?: string): RuleStats[] {
    const pnlByMint: Record<string, number> = {};
    for (const c of this.state.data.closed) pnlByMint[c.mint] = (pnlByMint[c.mint] ?? 0) + c.realizedSol - c.costSol;
    for (const p of this.state.data.positions) pnlByMint[p.mint] = (pnlByMint[p.mint] ?? 0) + p.realizedSol - (p.tokens > 0 ? 0 : p.costSol);
    const feesByMint: Record<string, Array<{ asset: string; amount: number }>> = {};
    for (const t of this.state.data.treasury.filter((x) => x.kind === "claim" && x.mint)) (feesByMint[t.mint!] ??= []).push({ asset: t.asset ?? "SOL", amount: t.amount ?? t.sol ?? 0 });
    return this.launchRules().filter((r) => !ruleId || r.id === ruleId).map((r) => ruleStats(r.id, this.state.data.launchHistory, { pnlByMint, feesByMint }));
  }

  /** Race reports of launched coins (newest first), or one coin's. */
  raceReports(mint?: string): Array<Pick<LaunchRecord, "mint" | "symbol" | "handle" | "postUrl" | "race" | "ruleId" | "at">> {
    return this.state.data.launchHistory.filter((h) => h.status === "launched" && h.race && (!mint || h.mint === mint)).reverse().map((h) => ({ mint: h.mint, symbol: h.symbol, handle: h.handle, postUrl: h.postUrl, race: h.race, ruleId: h.ruleId, at: h.at }));
  }

  /** Backtest a rule over the last `days` (≤ 7) of posts from its accounts, through the X API's recent search. Nothing is spent. */
  async backtestLaunchRule(ruleOrId: string | LaunchOnPostRule, days = 7): Promise<BacktestResult> {
    const r = typeof ruleOrId === "string" ? this.launchRules().find((x) => x.id === ruleOrId) : ruleOrId;
    if (!r) throw new Error("No launch-on-post rule with that id.");
    const token = secret(this.o.config.x.bearerTokenEnv, this.secrets());
    const d = Math.min(7, days);
    const stored = () => {
      const log = this.state.data.postLog ?? [];
      if (!log.length) return { ...backtestRule(r, [], { days: d, source: "none" }), notes: ["No post history: your X source doesn't return past posts, and the tracker hasn't stored any from these accounts yet. Posts are kept from the moment a rule watches an account."] };
      return backtestRule(r, log, { days: d, source: "tracker" });
    };
    if (!token) return stored();
    try {
      const posts = await recentPosts(token, r.trigger.handles, Date.now() - d * 86_400_000);
      return backtestRule(r, posts, { days: d, source: "x-api" });
    } catch (e) {
      const res = stored();
      return { ...res, notes: [`Your X API didn't return history (${(e as Error).message}).`, ...res.notes] };
    }
  }

  private async exitLoop() {
    this.expirePending();
    this.copy.expirePending();
    for (const p of [...this.state.data.positions]) {
      const rule = this.rules().find((r) => r.id === p.ruleId);
      const exit = p.exit ?? rule?.exit;
      if (!exit) continue;
      const m = await snapshot(this.rpc, p.mint).catch(() => null);
      if (!m) continue;
      // v26: the no-volume exit counts the coin's trades on the PumpPortal socket; until it has watched a full window, it waits
      let volSol: number | undefined;
      if (exit.noVolume) {
        if (!this.creates) { this.creates = new CreateStream({ onQuote: (m) => this.pairsSeen.ingest(m) }); this.creates.start(); }
        this.creates.trackTrades(p.mint);
        volSol = this.creates.volume(p.mint, exit.noVolume.windowSec);
      }
      const { action, highest } = evaluateExit(p, exit, m.priceSol, Date.now(), m.mcapUsd, volSol);
      p.highestPriceSol = highest;
      if (!action) continue;
      const kind = action.kind === "tp" || action.kind === "mcap" ? "tp" : action.kind === "sl" || action.kind === "mcap-stop" || action.kind === "novol" ? "sl" : action.kind === "timed" ? "timeout" : action.kind;
      this.state.log({ kind, message: `${p.symbol}: ${action.reason}`, mint: p.mint, ruleId: rule?.id });
      this.state.stage({ id: `x-${p.mint.slice(0, 6)}-${Date.now().toString(36)}`, stage: "exit", outcome: "done", mint: p.mint, symbol: p.symbol, reason: action.reason, action: "exit", result: `sell ${action.sellPct}%` });
      await this.executor.sell({ action: "sell", wallet: this.address, mint: p.mint, sellPct: action.sellPct, reason: action.reason, slippageBps: rule?.buy.slippageBps ?? 1500, priorityFeeSol: rule?.buy.priorityFeeSol }, action.step);
    }
    // Dev position of a launched coin fully sold: disclose it, and stop promotional updates for that coin.
    for (const c of this.state.data.closed.filter((x) => x.launched && !x.launched.exitAnnounced)) {
      c.launched!.exitAnnounced = true;
      const sells = this.state.data.treasury.filter((t) => t.kind === "dev-sell" && t.mint === c.mint);
      const last = sells[sells.length - 1];
      this.state.log({ kind: "status", message: `Dev position in $${c.symbol} fully sold (${c.realizedSol.toFixed(4)} SOL). Listed in the treasury report.`, mint: c.mint, signature: last?.signature });
      if (this.coin && this.coin.mint === c.mint && last?.signature) await this.coin.announceDevExit(last.signature, c.realizedSol).catch(() => undefined);
    }
  }

  private async orderLoop() {
    if (this.orderBusy) return;
    this.orderBusy = true;
    try {
      const open = this.state.data.orders.filter((o) => o.status === "open" && o.kind !== "dev-sell");
      for (const mint of new Set(open.map((o) => o.mint))) {
        const m = await snapshot(this.rpc, mint).catch(() => null);
        if (!m) continue;
        // Trailing orders remember the highest price they've seen.
        this.state.data.orders = this.state.data.orders.map((o) => (o.mint === mint ? notePrice(o, m.priceSol) : o));
        for (const f of evaluateOrders(this.state.data.orders, m)) await this.fireOrder(f, `${f.order.kind} order`);
      }
    } finally {
      this.orderBusy = false;
    }
  }
  private orderBusy = false;

  /** Fill one order through the executor (guardrails, limits, the order's preset) and advance it. */
  private async fireOrder(f: OrderFire, why: string): Promise<boolean> {
    const o = f.order;
    const x = o.preset ? await this.tradeParams(f.action, o.preset).catch(() => null) : null;
    const fees = x ? { slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly } : { slippageBps: o.slippageBps };
    const r = f.action === "buy"
      ? await this.executor.buy({ action: "buy", wallet: this.address, mint: o.mint, amountSol: f.amountSol ?? 0, ...fees, reason: why })
      : await this.executor.sell({ action: "sell", wallet: this.address, mint: o.mint, sellPct: f.sellPct ?? 100, ...fees, reason: why });
    const i = this.state.data.orders.findIndex((x) => x.id === o.id);
    if (i >= 0) this.state.data.orders[i] = r.ok ? afterFire(this.state.data.orders[i], Date.now(), f.slice) : afterFail(this.state.data.orders[i], r.error ?? "failed");
    const after = this.state.data.orders[i];
    if (r.ok) this.state.log({ kind: "status", mint: o.mint, message: `Order ${o.id} filled${f.slice !== undefined ? ` (slice ${f.slice + 1}/${o.schedule?.length ?? "?"})` : o.kind === "dca" ? ` (slice ${(after?.fills ?? 1)}/${o.slices ?? (after?.fills ?? 0) + (after?.remaining ?? 0)})` : ""}: ${why}`, signature: r.signature });
    await this.state.save();
    if (o.kind === "dev-sell") this.syncDevSell();
    return r.ok;
  }

  /** Add an order (from the CLI's control file or the panel). Validated again here. */
  private addOrder(o: Order) {
    if (this.state.data.orders.some((x) => x.id === o.id)) return;
    const errs = validateOrder(o);
    if (errs.length) return void this.state.log({ kind: "error", mint: o.mint, message: `Order ${o.id} refused: ${errs.join(" ")}` });
    this.state.data.orders.push({ ...o, status: "open", createdAt: o.createdAt || Date.now() });
    this.state.log({ kind: "status", mint: o.mint, message: `Order ${o.id} added: ${describeOrder(o)}` });
    this.syncDevSell();
  }
  private cancelOrder(id: string) {
    const o = this.state.data.orders.find((x) => x.id === id && x.status === "open");
    if (!o) return;
    o.status = "cancelled";
    this.state.log({ kind: "status", mint: o.mint, message: `Order ${id} cancelled` });
    this.syncDevSell();
  }

  /** Watch the trade stream of coins with an open dev-sell order (and nothing else). */
  private syncDevSell() {
    const mints = devSellMints(this.state.data.orders);
    if (!mints.length) { this.tradeFeed?.stop(); this.tradeFeed = undefined; return; }
    if (!this.tradeFeed) {
      this.tradeFeed = new TokenTradeWatcher((t) => void this.onStreamTrade(t), (e) => this.state.log({ kind: "error", message: e.message }));
      this.state.log({ kind: "status", message: `Watching dev sells on ${mints.length} coin${mints.length === 1 ? "" : "s"}` });
    }
    this.tradeFeed.set(mints);
  }
  private async onStreamTrade(t: StreamTrade) {
    if (this.status === "paused") return;
    for (const f of matchDevSell(this.state.data.orders, t)) {
      this.state.log({ kind: "status", mint: t.mint, message: `Dev ${t.trader.slice(0, 4)}… sold ${t.sol.toFixed(3)} SOL: order ${f.order.id} fires`, signature: t.signature });
      await this.fireOrder(f, "dev-sell order");
    }
  }

  private async controlLoop() {
    const f = join(this.o.config.dataDir, "control.json");
    if (!existsSync(f)) return;
    const c = JSON.parse(await readFile(f, "utf8").catch(() => "{}")) as ControlFile;
    if (c.stop) {
      await writeFile(f, JSON.stringify({ ...c, stop: false }));
      await this.stop("stopped by `vesk stop`");
      process.exit(0);
    }
    if (c.paused !== undefined && (c.paused ? "paused" : "online") !== this.status) this.setPaused(c.paused);
    if (c.killSwitch !== undefined && c.killSwitch !== this.limits().killSwitch) await this.setKillSwitch(c.killSwitch);
    if (c.deploys?.length) {
      await writeFile(f, JSON.stringify({ ...c, deploys: [] }));
      for (const d of c.deploys) {
        const post = this.feed.find((p) => p.id === d.postId) ?? (await this.fetchPost(d.postId).catch(() => null));
        if (!post) this.state.log({ kind: "error", message: `Deploy: couldn't load post ${d.postId}.` });
        else await this.deployPost(post, d.presetId).catch((e: Error) => this.state.log({ kind: "guardrail", message: `Deploy refused: ${e.message}` }));
      }
    }
    if (c.orders?.length || c.cancelOrders?.length) {
      await writeFile(f, JSON.stringify({ ...c, orders: [], cancelOrders: [] }));
      for (const o of c.orders ?? []) this.addOrder({ ...o, source: o.source ?? "cli" });
      for (const id of c.cancelOrders ?? []) this.cancelOrder(id);
      await this.state.save();
    }
    if (c.decisions?.length) {
      await writeFile(f, JSON.stringify({ ...c, decisions: [] }));
      for (const d of c.decisions) this.state.log({ kind: "status", message: await this.decidePending(d.id, d.launch, d.name) });
    }
    if (c.copyDecisions?.length || c.copyManual?.length) {
      await writeFile(f, JSON.stringify({ ...c, copyDecisions: [], copyManual: [] }));
      for (const d of c.copyDecisions ?? []) this.state.log({ kind: "status", message: `Copy: ${await this.copy.decide(d.id, d.copy)}` });
      for (const d of c.copyManual ?? []) this.state.log({ kind: "status", message: `Copy: ${await this.copy.manual(d.feedId, d.amountSol)}` });
    }
    // Pick up rules saved by the CLI / chat while running, and watch any new accounts.
    const before = this.watchedHandles().join(",");
    await this.store.load();
    this.copy.sync();
    this.runner.sync();
    const after = this.watchedHandles();
    if (this.x && after.join(",") !== before) await this.x.setHandles(after);
  }

  private watchedHandles(): string[] {
    return [...new Set([
      ...(this.store.data.trackerGroups ?? []).flatMap((g) => g.handles),
      ...this.rules().flatMap((r) => (r.trigger.kind === "x-post" && r.enabled ? r.trigger.handles : [])),
      ...this.launchRules().filter((r) => r.enabled).flatMap((r) => activeHandles(r)),
    ])].sort();
  }

  /** One post by id, through the official X API (for `vesk deploy <url>` on posts older than the feed). */
  async fetchPost(id: string): Promise<XPost | null> {
    const token = secret(this.o.config.x.bearerTokenEnv, this.secrets());
    if (!token) return null;
    const r = await fetch(`${endpoints.xApi()}/tweets/${id}?tweet.fields=created_at,entities,referenced_tweets,note_tweet,author_id,attachments,public_metrics&expansions=author_id,attachments.media_keys&user.fields=username&media.fields=url,preview_image_url,type`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: Parameters<typeof toXPost>[0]; includes?: { users?: Parameters<typeof toXPost>[1]; media?: Parameters<typeof toXPost>[2] } };
    return j.data ? toXPost(j.data, j.includes?.users, j.includes?.media) : null;
  }

  /** Fast lane from the panel: Launch / Skip and Deploy clicks reach the agent within ~2 s. */
  private polling = false;
  private async pollLoop() {
    if (!this.panel || this.polling) return;
    this.polling = true;
    try {
      const fresh = this.state.data.pipeline.filter((e) => e.at > this.piped).slice(-200);
      const r = await this.panel.poll(fresh.length ? { pipeline: fresh } : {});
      if (fresh.length) this.piped = Math.max(this.piped, ...fresh.map((e) => e.at));
      // v20: buys and launches from the panel run side by side in their lanes; everything else in order
      const ops = r.ops ?? [];
      const par = (op: PanelOp) => (op.op === "trade" && op.side === "buy") || op.op === "launch";
      for (const op of ops.filter((o) => !par(o))) await this.runPanelOp(op);
      await Promise.all(ops.filter(par).map((op) => this.runPanelOp(op)));
      for (const d of r.decisions) this.state.log({ kind: "status", message: await this.decidePending(d.id, d.launch, d.name) });
      for (const d of r.deploys) {
        const post = this.feed.find((p) => p.id === d.postId);
        if (!post) this.state.log({ kind: "error", message: `Deploy: post ${d.postId} isn't in this agent's feed (it may be older than the agent's buffer).` });
        else await this.deployPost(post, d.presetId, d.overrides).catch((e: Error) => this.state.log({ kind: "guardrail", message: `Deploy refused: ${e.message}` }));
      }
    } catch {
      /* panel unreachable: the agent keeps running on its own */
    } finally {
      this.polling = false;
    }
  }

  private async reportLoop() {
    if (!this.panel) return;
    const positions = await Promise.all(this.state.data.positions.map(async (p) => {
      const m = await snapshot(this.rpc, p.mint).catch(() => null);
      const pnl = positionPnl(p, m?.priceSol ?? p.avgEntryPriceSol);
      return { mint: p.mint, symbol: p.symbol, tokens: p.tokens, costSol: p.costSol, valueSol: pnl.valueSol, pnlSol: pnl.pnlSol, pnlPct: pnl.pnlPct, openedAt: p.openedAt };
    }));
    const activity: Activity[] = this.state.data.activity.filter((a) => a.at > this.reported).slice(-100);
    try {
      const ctl = await this.panel.report({
        status: this.status, version: AGENT_VERSION, wallet: this.address, rpc: { kind: rpcKind(this.o.config.rpc.url), p50: this.latency?.p50 }, paper: !!this.o.paper, startedAt: this.startedAt,
        model: this.o.config.model.provider, pnlTodaySol: this.state.realizedToday() + positions.reduce((s, p) => s + p.pnlSol, 0),
        spentTodaySol: this.state.spentToday(), positions, activity,
        wallets: (await this.wallets().catch(() => [])).map(({ address, label, active, main, balanceSol }) => ({ address, label, active, main, balanceSol })),
        pending: this.state.data.pendingLaunches,
        // v26: race reports and per-rule stats for the panel (Rules, Your launches, the coin page)
        races: this.raceReports().slice(0, 30),
        launchStats: this.launchRuleStats(),
        feed: this.feed.filter((p) => p.receivedAt > this.reported).slice(-50),
        source: {
          kind: !this.x ? "off" : this.o.config.x.source === "relay" ? "relay" : this.o.config.x.source === "provider" ? "provider" : this.o.xMode === "stream" ? "stream" : "poll",
          p50Ms: this.feed.length ? [...this.feed].map((p) => p.latencyMs).sort((a, b) => a - b)[Math.floor(this.feed.length / 2)] : undefined,
        },
        launches: this.state.data.launchHistory.filter((h) => h.at > this.reported - 60_000 && (h.status === "launched" || h.status === "failed")).map((h) => ({ postId: h.postId, handle: h.handle, mint: h.mint, symbol: h.symbol, status: h.status, timings: h.timings })),
        copyFeed: [...this.copyDirty.values()].slice(-200), copyPending: this.state.data.copyPending, copySources: this.copy.status(),
        copyStats: this.copy.stats((mint) => positions.find((x) => x.mint === mint)?.valueSol),
        copiedFrom: Object.fromEntries(this.state.data.positions.filter((p) => p.copiedFrom).map((p) => [p.mint, { wallet: p.copiedFrom!.wallet, label: p.copiedFrom!.label }])),
        orders: this.state.data.orders.slice(-100),
        pipeline: this.state.data.pipeline.filter((e) => e.at > this.piped).slice(-200),
        strategy: this.strategyReport(),
      });
      this.copyDirty.clear();
      this.piped = Math.max(this.piped, ...this.state.data.pipeline.map((e) => e.at), 0);
      for (const d of ctl.decisions ?? []) await this.decidePending(d.id, d.launch, d.name).catch(() => undefined);
      this.reported = Date.now();
      if (ctl.paused !== (this.status === "paused")) this.setPaused(ctl.paused);
      if (ctl.killSwitch !== this.limits().killSwitch) await this.setKillSwitch(ctl.killSwitch);
      if (this.o.config.panel?.syncRules && ctl.rulesVersion > this.store.data.version) {
        const r = await this.panel.rules();
        Object.assign(this.store.data, {
          rules: r.rules, watchlist: r.watchlist, limits: r.limits, ...(r.launchRules ? { launchRules: r.launchRules } : {}), ...(r.presets ? { presets: r.presets } : {}),
          ...(r.trackerGroups ? { trackerGroups: r.trackerGroups } : {}), ...(r.defaultPresetId ? { defaultPresetId: r.defaultPresetId } : {}),
          ...(r.trading ? { trading: r.trading } : {}), ...(r.pulse ? { pulse: r.pulse } : {}),
          ...(r.blacklist ? { blacklist: r.blacklist } : {}), ...(r.migration ? { migration: mergeMigration(this.migrationOrders(), normalizeMigrationOrders(r.migration)) } : {}),
          ...(r.copy ? { copy: r.copy } : {}),
          ...(r.strategy ? { strategy: r.strategy } : {}),
        });
        await this.store.save();
        this.syncMigrations();
        this.copy.sync();
        this.runner.sync();
        // Per-coin exits edited in the panel's Workspace apply to the open positions in that coin.
        for (const cp of r.coinPrefs ?? []) for (const p of this.state.data.positions.filter((x) => x.mint === cp.mint)) if (cp.exit) p.exit = cp.exit;
        // "Run your coin" switches per coin (Launch → Hand it to the agent, or the Workspace).
        for (const cp of r.coinPrefs ?? []) if (cp.run) this.applyRun(cp.mint, this.symbolOf(cp.mint), cp.run);
        this.state.log({ kind: "status", message: `Pulled ${r.rules.length + r.watchlist.length} rules from the panel` });
      }
    } catch (e) {
      this.state.log({ kind: "error", message: `Panel report failed: ${(e as Error).message}` });
    }
  }

  /** v19: what the panel's Live and Strategy pages show about the strategy: preset, mode and the Rogue session. */
  strategyReport() {
    const s = this.strategy(), ses = this.state.data.rogue, now = Date.now();
    return {
      preset: s.preset, mode: s.mode, autoNewCoins: s.entry.autoNewCoins, work: this.work.stats(),
      rogue: ses ? { active: rogueActive(s, now), line: rogueLine(s.rogue, ses, now).text, startedAt: ses.startedAt, endsAt: ses.endsAt, spentSol: ses.spentSol, budgetSol: s.rogue.budgetSol, maxCoins: s.rogue.maxCoins, coins: ses.coins } : null,
    };
  }

  /** Chat → intent. Never executes anything by itself. */
  chat(text: string): Promise<ParseResult> {
    return parseWithModel(text, this.model);
  }
}

/** The keystore key that holds the copy adapter URL (default HELIUS_WS_URL). */
function normalizeKey(copy: unknown): string | undefined {
  const s = (copy as { sources?: { adapter?: string; adapterUrlKey?: string } } | undefined)?.sources;
  if (!s || s.adapter === "none" || !s.adapter) return undefined;
  return s.adapterUrlKey ?? (s.adapter === "helius" ? "HELIUS_WS_URL" : "YELLOWSTONE_URL");
}
