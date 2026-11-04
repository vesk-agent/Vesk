/**
 * Optional link between a self-hosted agent and the web panel.
 *
 * `vesk pair <code>` exchanges the short code shown in the panel (Wallets → Self-hosted) for an agent token.
 * After that the agent reports status, positions and activity, and can pull the rules you edit in the panel.
 * The panel can pause the agent or flip its kill switch. It can NOT sign, trade or see your keys:
 * the agent only ever sends public data (your wallet's public address, positions, activity lines).
 */
import type { Blacklist } from "./watch/blacklist.js";
import type { MigrationOrder } from "./watch/migration.js";
import type { CopyFeedItem, CopyWalletStats, PendingCopy } from "./copy/engine.js";
import type { SourceStatus } from "./copy/detect.js";
import { hostname } from "node:os";
import type { WatchEntry } from "./config.js";
import type { Activity, AgentStatus, ExitSpec, Limits, Order, Rule } from "./types.js";
import type { LaunchOnPostRule, PendingLaunch } from "./launch/onpost.js";
import type { LaunchPreset } from "./launch/presets.js";
import type { LaunchPlan } from "./launch/plan.js";
import type { PipelineEvent } from "./ui/pipeline.js";
import type { TradingSettings } from "./trade/settings.js";
import type { FeedPost, TrackerGroup } from "./watch/tracker.js";

export const AGENT_VERSION = "0.1.0";

export interface ReportBody {
  status: AgentStatus;
  version: string;
  wallet: string;
  /** v26: race reports and per-rule launch-on-post stats */
  races?: unknown[];
  launchStats?: unknown[];
  rpc: { kind: string; p50?: number };
  /** Paper mode: decisions are made, nothing is signed. */
  paper?: boolean;
  /** When this agent process started (ms), for uptime in the panel. */
  startedAt?: number;
  model: string;
  pnlTodaySol: number;
  spentTodaySol: number;
  positions: Array<{ mint: string; symbol: string; tokens: number; costSol: number; valueSol: number; pnlSol: number; pnlPct: number; openedAt: number }>;
  activity: Activity[];
  /** Public addresses, labels and balances of the main + imported wallets (never keys). */
  wallets?: Array<{ address: string; label: string; active: boolean; main: boolean; balanceSol: number }>;
  /** Launch-on-post drafts waiting for Launch / Skip (public data only). */
  pending?: PendingLaunch[];
  /** Which X source the watcher uses and its measured median post latency. */
  source?: { kind: "stream" | "poll" | "provider" | "relay" | "off"; p50Ms?: number };
  /** Tracker posts since the last report (public posts only). */
  feed?: FeedPost[];
  /** Launch-on-post / deploy speed records. */
  launches?: Array<{ postId: string; handle: string; mint?: string; symbol?: string; status: string; timings?: Array<{ mark: string; ms: number }> }>;
  /** Copy trading: feed items new or changed since the last report, copies waiting for Copy / Skip, and the detection sources. */
  copyFeed?: CopyFeedItem[];
  copyPending?: PendingCopy[];
  copySources?: SourceStatus[];
  /** Per tracked wallet: copies today, PnL from copies (closed + open at the reported value), win rate, last activity. */
  copyStats?: Record<string, CopyWalletStats>;
  /** Positions that are copies: mint → who they were copied from. */
  copiedFrom?: Record<string, { wallet: string; label: string }>;
  /** Orders (open and the last filled / cancelled ones), for the coin page's Orders tab. */
  orders?: Order[];
  /** v19: pipeline events since the last report (the panel's Live page). Public data only: coins, reasons, timings. */
  pipeline?: PipelineEvent[];
  /** v19: preset, mode and the Rogue session (Agent.strategyReport). */
  strategy?: unknown;
}

/** Fast lane (every 2 s): Launch / Skip decisions and Deploy requests from the panel. */
/** Something you asked for in the panel's Workspace or Wallets, signed here by this agent. */
export type PanelOp =
  | { id: string; op: "trade"; mint: string; side: "buy" | "sell"; wallets: string[]; amountSol?: number; pct?: number; slippagePct?: number; preset?: "p1" | "p2" | "p3"; source?: string; dev?: string }
  | { id: string; op: "send-tokens"; mint: string; from?: string; to: string; tokens: number }
  | { id: string; op: "claim-fees"; mint: string; quote?: import("./launch/launchpads.js").QuoteAsset }
  | { id: string; op: "burn"; mint: string; tokens: number }
  | { id: string; op: "rent-recover"; wallet?: string }
  | { id: string; op: "copy-decide"; pendingId: string; copy: boolean }
  | { id: string; op: "copy-manual"; feedId?: string; wallet: string; label?: string; mint: string; theirSig: string; theirSol: number; venue?: string; symbol?: string; amountSol?: number }
  /** An order placed on the coin page (Limit / Adv.): limit, stop-loss, trailing, DCA, TWAP or dev-sell. */
  | { id: string; op: "order"; order: Order }
  | { id: string; op: "order-cancel"; orderId: string }
  /** Launch from the panel's Launch page, signed by this agent. Optionally hand the coin to the agent right away. */
  | { id: string; op: "launch"; plan: LaunchPlan; imageDataUrl: string; exit?: ExitSpec; run?: RunPrefs };

/** "Run your coin" switches for one coin, set in the panel (Launch → Hand it to the agent, or the Workspace). */
export interface RunPrefs {
  updates: boolean;
  claimFees: boolean;
  /** % of claimed fees for disclosed buybacks, 0-50. */
  buybackPct: number;
  burnBuybacks: boolean;
}

export interface PollResult {
  ops?: PanelOp[];
  decisions: Array<{ id: string; launch: boolean; name?: { name: string; symbol: string } }>;
  deploys: Array<{ postId: string; presetId?: string; overrides?: { name?: string; symbol?: string; description?: string } }>;
}

export interface PanelControl {
  killSwitch: boolean;
  paused: boolean;
  rulesVersion: number;
  /** Launch / Skip decisions made in the panel for pending drafts. */
  decisions?: Array<{ id: string; launch: boolean; name?: { name: string; symbol: string } }>;
}

export class PanelLink {
  constructor(private url: string, private token?: string) {}

  /** One action on the panel function (used by the relay for `relay-token` / `relay-subscribe`). */
  async call<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.token ? { "x-agent-token": this.token } : {}) },
      body: JSON.stringify({ action, ...body }),
    });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `Panel ${r.status}`);
    return j;
  }

  async pair(code: string, wallet: string): Promise<{ agentToken: string; agentId: string }> {
    const r = await this.call<{ agentToken: string; agentId: string }>("agent-pair", { code: code.trim().toUpperCase(), wallet, version: AGENT_VERSION, host: hostname().slice(0, 40) });
    this.token = r.agentToken;
    return r;
  }

  report(b: ReportBody): Promise<PanelControl> {
    return this.call<PanelControl>("agent-report", b as unknown as Record<string, unknown>);
  }

  /** The 2 s poll. v19: carries the pipeline steps since the last send, so Live isn't 10 s behind. */
  poll(b: { pipeline?: PipelineEvent[] } = {}): Promise<PollResult> {
    return this.call<PollResult>("agent-poll", b as Record<string, unknown>);
  }

  rules(): Promise<{ rules: Rule[]; watchlist: WatchEntry[]; limits: Limits; version: number; launchRules?: LaunchOnPostRule[]; presets?: LaunchPreset[]; trackerGroups?: TrackerGroup[]; defaultPresetId?: string; coinPrefs?: Array<{ mint: string; exit?: ExitSpec; run?: RunPrefs }>; trading?: TradingSettings; pulse?: unknown; blacklist?: Blacklist; migration?: MigrationOrder[]; copy?: unknown; strategy?: unknown }> {
    return this.call("agent-rules", {});
  }
}
