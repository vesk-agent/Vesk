/**
 * Local agent state (positions, fills, counters, orders, activity, treasury ledger), persisted as JSON
 * in the data dir. Small and boring on purpose: one process owns it.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dayKey } from "./rules/engine.js";
import type { RecentFill } from "./guardrails.js";
import type { Activity, AgentStatus, Order, Position } from "./types.js";
import type { LaunchRecord, PendingLaunch } from "./launch/onpost.js";
import type { SeenQuote } from "./launch/discovery.js";
import type { PairCheck } from "./launch/mintcheck.js";
import type { XPost } from "./types.js";
import type { CopyFeedItem, PendingCopy } from "./copy/engine.js";
import { pushEvent, type PipelineEvent } from "./ui/pipeline.js";
import type { StrategyPos } from "./strategy/runner.js";
import type { RogueSession } from "./strategy/rogue.js";
import type { WorkStats } from "./work/queue.js";
import type { LaunchedCoin } from "./launch/claim.js";

export interface TreasuryEntry {
  at: number;
  kind: "claim" | "buyback" | "burn" | "team" | "dev-sell";
  mint: string;
  /** kind "team": the disclosed team wallets that bought in the launch bundle. */
  wallets?: string[];
  sol?: number;
  tokens?: number;
  signature?: string;
  /** Where it was disclosed (post id / message link). */
  disclosedAt?: string;
  /** v23, kind "claim": the asset the fees were paid in ("SOL", "USDC", …) and the amount in it. `sol` is the ≈ SOL. */
  asset?: string;
  amount?: number;
}

export interface StateData {
  status: AgentStatus;
  positions: Position[];
  closed: Position[];
  fills: RecentFill[];
  orders: Order[];
  spentSol: Record<string, number>; // day -> SOL
  buys: Record<string, number>; // day -> count
  ruleBuys: Record<string, Record<string, number>>; // day -> ruleId -> count
  lastFired: Record<string, number>; // ruleId -> ms
  activity: Activity[];
  treasury: TreasuryEntry[];
  seenPosts: string[]; // post ids already processed
  /** Launch-on-post history (dedupe, limits) and drafts waiting for Launch / Skip. */
  launchHistory: LaunchRecord[];
  pendingLaunches: PendingLaunch[];
  /** Copy trading: every trade seen from a tracked wallet with what Vesk did (copied / skipped + reason), newest last. */
  copyFeed: CopyFeedItem[];
  /** Copies waiting for Copy / Skip (Confirm mode). */
  copyPending: PendingCopy[];
  /** v19: the pipeline's structured events (watch → check → size → execute → exit → log), newest last, capped. */
  pipeline: PipelineEvent[];
  /** v19: positions the strategy opened (for scale-in and the no-volume exit) and the Rogue session, if one runs. */
  strategyPos?: StrategyPos[];
  rogue?: RogueSession | null;
  /** v20: the parallel lanes right now (for `vesk live` and the panel). */
  work?: WorkStats & { at: number };
  /** v23: coins this agent launched, with their pair and where creator rewards go (the Claim rows, `vesk claim`). */
  launched?: LaunchedCoin[];
  /** v26: quote mints seen in pump.fun creates (pair discovery), merged into the pair list as "Discovered". */
  seenQuotes?: SeenQuote[];
  /** v26: the last on-chain check of each custom-pair mint (by mint): "Verified on-chain" in the pair list. */
  pairChecks?: Record<string, PairCheck>;
  /** v26: posts from launch-on-post accounts the tracker received (the last 7 days, capped), for backtests when the X source has no history. */
  postLog?: XPost[];
}

const empty = (): StateData => ({
  status: "stopped", positions: [], closed: [], fills: [], orders: [], spentSol: {}, buys: {}, ruleBuys: {}, lastFired: {}, activity: [], treasury: [], seenPosts: [], launchHistory: [], pendingLaunches: [], copyFeed: [], copyPending: [], pipeline: [],
});

export class State {
  data: StateData = empty();
  private listeners = new Set<(a: Activity) => void>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private dir: string) {}

  get file() {
    return join(this.dir, "state.json");
  }

  async load(): Promise<this> {
    try {
      this.data = { ...empty(), ...(JSON.parse(await readFile(this.file, "utf8")) as Partial<StateData>) };
    } catch {
      this.data = empty();
    }
    return this;
  }

  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = this.file + ".tmp";
      await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.saving;
  }

  onActivity(fn: (a: Activity) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private stageListeners = new Set<(e: PipelineEvent) => void>();
  onStage(fn: (e: PipelineEvent) => void): () => void {
    this.stageListeners.add(fn);
    return () => this.stageListeners.delete(fn);
  }
  /**
   * One step of a candidate through the pipeline. A candidate that ends here (filtered at Check, landed or failed at
   * Execute, an Exit) is also written to the log, so the Log stage counts real lines.
   */
  private stageSave?: ReturnType<typeof setTimeout>;
  stage(e: Omit<PipelineEvent, "at"> & { at?: number }): PipelineEvent {
    const full: PipelineEvent = { at: Date.now(), ...e };
    // v19: steps reach state.json within half a second (`vesk live` in another terminal reads the file)
    if (!this.stageSave) { this.stageSave = setTimeout(() => { this.stageSave = undefined; void this.save().catch(() => undefined); }, 500); (this.stageSave as { unref?: () => void }).unref?.(); }
    pushEvent(this.data.pipeline, full);
    for (const l of this.stageListeners) l(full);
    const terminal = (full.stage === "check" && full.outcome === "fail") || (full.stage === "execute" && (full.outcome === "done" || full.outcome === "fail")) || (full.stage === "exit" && full.outcome === "done");
    if (terminal) {
      const line: PipelineEvent = { at: full.at + 1, id: full.id, stage: "log", outcome: "done", mint: full.mint, symbol: full.symbol, reason: `line #${this.data.activity.length + 1}` };
      pushEvent(this.data.pipeline, line);
      for (const l of this.stageListeners) l(line);
    }
    return full;
  }

  log(a: Omit<Activity, "at"> & { at?: number }): Activity {
    const full: Activity = { at: Date.now(), ...a };
    this.data.activity.push(full);
    if (this.data.activity.length > 1000) this.data.activity.splice(0, this.data.activity.length - 1000);
    for (const l of this.listeners) l(full);
    void this.save();
    return full;
  }

  spentToday(now = Date.now()) {
    return this.data.spentSol[dayKey(now)] ?? 0;
  }
  buysToday(now = Date.now()) {
    return this.data.buys[dayKey(now)] ?? 0;
  }
  ruleBuysToday(ruleId: string, now = Date.now()) {
    return this.data.ruleBuys[dayKey(now)]?.[ruleId] ?? 0;
  }
  holding(mint: string) {
    return this.data.positions.some((p) => p.mint === mint && p.tokens > 0);
  }

  recordBuy(p: { mint: string; symbol: string; wallet: string; sol: number; tokens: number; ruleId?: string; now?: number }) {
    const now = p.now ?? Date.now();
    const d = dayKey(now);
    this.data.spentSol[d] = (this.data.spentSol[d] ?? 0) + p.sol;
    this.data.buys[d] = (this.data.buys[d] ?? 0) + 1;
    if (p.ruleId) {
      this.data.ruleBuys[d] ??= {};
      this.data.ruleBuys[d][p.ruleId] = (this.data.ruleBuys[d][p.ruleId] ?? 0) + 1;
      this.data.lastFired[p.ruleId] = now;
    }
    this.data.fills.push({ at: now, mint: p.mint, side: "buy", wallet: p.wallet, amountSol: p.sol });
    this.trimFills(now);
    const price = p.tokens > 0 ? p.sol / p.tokens : 0;
    const pos = this.data.positions.find((x) => x.mint === p.mint && x.wallet === p.wallet);
    if (pos) {
      pos.costSol += p.sol;
      pos.tokens += p.tokens;
      pos.avgEntryPriceSol = pos.tokens > 0 ? pos.costSol / pos.tokens : price;
      pos.highestPriceSol = Math.max(pos.highestPriceSol, price);
    } else {
      this.data.positions.push({
        mint: p.mint, symbol: p.symbol, ruleId: p.ruleId, wallet: p.wallet, tokens: p.tokens, costSol: p.sol, avgEntryPriceSol: price,
        highestPriceSol: price, tpDone: [], realizedSol: 0, openedAt: now,
      });
    }
    void this.save();
  }

  recordSell(p: { mint: string; wallet: string; tokensSold: number; solOut: number; tpStep?: number; now?: number; signature?: string }) {
    const now = p.now ?? Date.now();
    this.data.fills.push({ at: now, mint: p.mint, side: "sell", wallet: p.wallet, amountSol: p.solOut });
    this.trimFills(now);
    const pos = this.data.positions.find((x) => x.mint === p.mint && x.wallet === p.wallet);
    if (!pos) return;
    pos.tokens = Math.max(0, pos.tokens - p.tokensSold);
    pos.realizedSol += p.solOut;
    // Every sell from the dev position of a coin Vesk launched goes into the public treasury report.
    if (pos.launched) this.data.treasury.push({ at: now, kind: "dev-sell", mint: p.mint, sol: p.solOut, tokens: p.tokensSold, signature: p.signature });
    if (p.tpStep !== undefined && !pos.tpDone.includes(p.tpStep)) pos.tpDone.push(p.tpStep);
    if (pos.tokens <= 1e-9) {
      pos.closedAt = now;
      this.data.positions = this.data.positions.filter((x) => x !== pos);
      this.data.closed.push(pos);
      if (this.data.closed.length > 500) this.data.closed.shift();
    }
    void this.save();
  }

  /** Realised PnL (SOL) of positions closed today plus realised parts of open ones. */
  realizedToday(now = Date.now()) {
    const d = dayKey(now);
    return this.data.closed.filter((p) => p.closedAt && dayKey(p.closedAt) === d).reduce((s, p) => s + p.realizedSol - p.costSol, 0);
  }

  private trimFills(now: number) {
    this.data.fills = this.data.fills.filter((f) => now - f.at < 24 * 3_600_000);
  }
}
