/**
 * Shared types for the Vesk agent. Everything the rules engine, guardrails, executor, CLI,
 * Telegram bot, MCP server and the web panel exchange is defined here.
 *
 * Units: SOL amounts are plain numbers in SOL (UI units) at the edges and converted to lamports
 * (bigint) right before a transaction is built. Market caps are in USD. Percentages are 0-100.
 */

export type Mint = string; // base58 public key of an SPL mint
export type Address = string; // base58 public key of any account

export type Venue = "pumpfun" | "jupiter";
export type VenuePref = "auto" | Venue;
export type Launchpad =
  | "pumpfun" | "stonkfun" | "letsbonk" | "bags" | "anoncoin" | "surge" | "printr" | "meteora-dbc" | "stoxes" | "lesgo" | "memefun";
export type Chain = "solana" | "base" | "bnb" | "ethereum";

/** How an X post must look before an x-post rule fires. */
export type XTriggerMode =
  /** The post itself contains a full, valid Solana mint address (default, safest). */
  | "ca-in-post"
  /** The post contains one of the keywords AND a link to a launchpad/explorer page for a mint. */
  | "keyword-link";

export interface LaunchFilters {
  /** Skip if the creator holds more than this % of supply right after launch. */
  maxDevHoldingPct?: number;
  /** Every listed social must be present in the coin metadata. */
  requireSocials?: Array<"x" | "telegram" | "website">;
  /** Minimum SOL in the bonding curve / pool. */
  minLiquiditySol?: number;
  /** Skip coins above this market cap (USD) at detection time. */
  maxMcapUsd?: number;
  /** Case-insensitive substrings; a match in name or ticker skips the coin. */
  blocklist?: string[];
  /** Only coins whose name or ticker contains one of these (case-insensitive). */
  nameIncludes?: string[];
  /** Creators (wallet addresses) to always skip. */
  blockedCreators?: Address[];
  rugChecks?: {
    mintAuthorityRevoked?: boolean;
    freezeAuthorityRevoked?: boolean;
    /** Max % of supply held by the top 10 holders (excluding the bonding curve). */
    maxTop10Pct?: number;
  };
}

export type Trigger =
  | { kind: "x-post"; handles: string[]; mode: XTriggerMode; keywords?: string[]; includeReplies?: boolean; includeReposts?: boolean }
  | { kind: "new-launch"; launchpad: "pumpfun"; filters: LaunchFilters }
  | { kind: "manual" };

export interface BuySpec {
  amountSol: number;
  /** Skip if market cap (USD) is above this at decision time. */
  maxMcapUsd?: number;
  slippageBps: number;
  /** Priority fee in SOL (compute-unit price is derived from it). */
  priorityFeeSol?: number;
  /** Optional Jito tip in SOL. Sent through a Jito block engine when set. */
  jitoTipSol?: number;
  venue: VenuePref;
  /** Use a trading preset (P1/P2/P3) for slippage, fees, tip and MEV protection instead of the fields above. */
  preset?: "p1" | "p2" | "p3";
}

export interface TakeProfitStep {
  /** Price multiple of the average entry, e.g. 3 = "3x". */
  atMultiple: number;
  /** % of the remaining position to sell at that step. */
  sellPct: number;
}

export interface ExitSpec {
  takeProfit?: TakeProfitStep[];
  /** Sell everything if price falls this % below entry. */
  stopLossPct?: number;
  /** Sell everything if price falls this % below the highest price seen since entry. */
  trailingStopPct?: number;
  /** Sell everything after this many minutes, whatever the price. */
  timeoutMin?: number;
  /** Market-cap ladder (USD), ascending. sellPct is a % of what's left at that point. */
  mcapTargets?: Array<{ atMcapUsd: number; sellPct: number }>;
  /** Sell everything if market cap falls below this (USD). */
  stopBelowMcapUsd?: number;
  /**
   * Time-based sells in seconds after entry (e.g. sell 100% of the dev position 5 s after launch).
   * sellPct is a % of what's left at that moment. Many buyers prefer coins where the dev holds no supply.
   */
  timeSells?: Array<{ afterSec: number; sellPct: number }>;
  /**
   * v26: the no-volume exit. Sell everything once the position is at least `windowSec` old and less than `minVolSol`
   * SOL traded in the last `windowSec`. Needs a trade feed for the coin (PumpPortal); skipped, with a log line, without one.
   */
  noVolume?: { windowSec: number; minVolSol: number };
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  buy: BuySpec;
  exit: ExitSpec;
  /** Hard ceiling on fills for this rule per UTC day. */
  maxBuysPerDay: number;
  /** Ignore a second signal for the same rule within this many seconds. */
  cooldownSec?: number;
  /** When a post contains several mint addresses: skip it (default) or take the first. */
  multiCa?: "skip" | "first";
  createdAt: string;
  updatedAt?: string;
}

/** One watched X account with its own buy rule (the panel's "X watchlist"). */
export interface WatchEntry {
  handle: string;
  enabled: boolean;
  mode: XTriggerMode;
  keywords?: string[];
  amountSol: number;
  maxMcapUsd?: number;
  slippageBps: number;
  priorityFeeSol?: number;
  jitoTipSol?: number;
  takeProfit?: TakeProfitStep[];
  stopLossPct?: number;
  maxBuysPerDay: number;
  note?: string;
  /** Trading preset for fees, tip and MEV protection. */
  preset?: "p1" | "p2" | "p3";
}

/** Spend and safety limits. Enforced by guardrails before every transaction. */
export interface Limits {
  perTradeMaxSol: number;
  dailySpendCapSol: number;
  maxOpenPositions: number;
  /** Agent-wide ceiling on buys per UTC day across all rules. */
  maxBuysPerDay: number;
  /** Never let the wallet's SOL balance drop below this (fees, rent). */
  minSolReserve: number;
  killSwitch: boolean;
  /** v19: buys in any 60 seconds, across every source (a runaway-loop stop). Missing = DEFAULT_LIMITS'. */
  maxBuysPerMinute?: number;
}

export const DEFAULT_LIMITS: Limits = {
  perTradeMaxSol: 0.5,
  dailySpendCapSol: 2,
  maxOpenPositions: 8,
  maxBuysPerDay: 20,
  minSolReserve: 0.02,
  killSwitch: false,
  maxBuysPerMinute: 10,
};

// ---------- signals ----------

export interface XPost {
  id: string;
  handle: string; // lower-case, without "@"
  text: string;
  urls: string[]; // expanded URLs from the post entities
  createdAt: string;
  isReply?: boolean;
  isRepost?: boolean;
  isQuote?: boolean;
  /** Attached media (photos first). Present when the X source returns it. */
  media?: Array<{ type: "photo" | "video" | "animated_gif"; url: string }>;
  /** Public counts, when the X source returns them. */
  metrics?: { likes?: number; views?: number; reposts?: number; replies?: number; bookmarks?: number };
  /** v26: the post's language (BCP 47, e.g. "en"), when the X source returns it. */
  lang?: string;
}

export interface LaunchEvent {
  mint: Mint;
  name: string;
  symbol: string;
  creator: Address;
  /** Tokens the creator bought in the create transaction (UI units). */
  devTokens: number;
  totalSupply: number;
  liquiditySol: number;
  mcapUsd: number;
  socials: { x?: string; telegram?: string; website?: string };
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  top10Pct?: number;
  at: string;
}

export type Signal =
  | { kind: "x-post"; post: XPost }
  | { kind: "new-launch"; launch: LaunchEvent }
  | { kind: "manual"; mint: Mint };

export interface MarketSnapshot {
  mint: Mint;
  priceSol: number;
  priceUsd: number;
  mcapUsd: number;
  liquiditySol: number;
  /** true while the coin is still on the pump.fun bonding curve. */
  onCurve: boolean;
  at: number;
}

// ---------- positions & orders ----------

export interface Position {
  mint: Mint;
  symbol: string;
  ruleId?: string;
  wallet: Address;
  tokens: number;
  costSol: number;
  avgEntryPriceSol: number;
  highestPriceSol: number;
  /** Indexes of take-profit steps already executed. */
  tpDone: number[];
  realizedSol: number;
  openedAt: number;
  closedAt?: number;
  /** Exits carried by the position itself (coins Vesk launched from a launch-on-post rule). */
  exit?: ExitSpec;
  /** Set when this is the dev position of a coin Vesk launched. */
  launched?: { ruleId?: string; handle?: string; postId?: string; exitAnnounced?: boolean };
  /** Set when this position is a copy of a tracked wallet's buy (copy trading). */
  copiedFrom?: { wallet: string; label: string; signature: string };
}

export type OrderKind = "limit-buy" | "limit-sell" | "dca" | "twap" | "dev-sell" | "trailing" | "stop-loss";
/** One scheduled TWAP fill. */
export interface OrderSlice { at: number; amountSol?: number; sellPct?: number; done?: boolean }
/** A trade order (see trade/orders.ts for what each kind does). Every fill passes the guardrails and limits. */
export interface Order {
  id: string;
  kind: OrderKind;
  mint: Mint;
  /** dca, twap and dev-sell can buy or sell (default buy). The others imply their side. */
  side?: "buy" | "sell";
  /** limit-buy / stop-loss: fire when price <= priceSol. limit-sell: when price >= priceSol. */
  priceSol?: number;
  /** Same triggers on market cap in USD, when no priceSol is given. */
  atMcapUsd?: number;
  amountSol?: number; // buys (per fill)
  sellPct?: number; // sells (per fill)
  /** DCA: one slice every intervalSec (or intervalMin), `remaining` more times. */
  intervalMin?: number;
  intervalSec?: number;
  remaining?: number;
  /** DCA / TWAP: number of slices when placed (for progress). */
  slices?: number;
  nextAt?: number;
  /** DCA: only fill while the market cap is inside this band (USD). */
  minMcapUsd?: number;
  maxMcapUsd?: number;
  /** TWAP: the total and its schedule. */
  totalSol?: number;
  totalPct?: number;
  durationSec?: number;
  schedule?: OrderSlice[];
  /** dev-sell: the coin's dev wallet, and the smallest dev sell (SOL) that triggers it. */
  dev?: Address;
  minDevSellSol?: number;
  /** trailing: distance below the high, and the high seen so far. */
  trailPct?: number;
  peakPriceSol?: number;
  slippageBps: number;
  /** Trading preset for fees and MEV (P1/P2/P3). */
  preset?: "p1" | "p2" | "p3";
  createdAt: number;
  status: "open" | "filled" | "cancelled";
  fills?: number;
  lastError?: string;
  source?: "cli" | "panel" | "chat";
  symbol?: string;
}

// ---------- intents (what the executor is asked to do) ----------

/**
 * The only trade actions Vesk can express. There is deliberately no "volume", "wash", "bundle"
 * or "multi-wallet" action: those are not implemented anywhere and are rejected by guardrails
 * if they appear in config, chat or tool calls.
 */
export type TradeAction = "buy" | "sell" | "buyback" | "burn" | "claim-fees" | "withdraw" | "send-tokens" | "close-accounts";

/** v19.1: the automatic sources that buy (Strategy & safety → Trading from; Live → Strategy). */
export type TradeOrigin = "snipe" | "copy" | "pulse" | "launch-on-post";
export const TRADE_ORIGIN_LABEL: Record<TradeOrigin, string> = { snipe: "Snipe rules", copy: "Copy trade", pulse: "Pulse", "launch-on-post": "Launch on post" };

export interface TradeIntent {
  action: TradeAction;
  mint?: Mint;
  wallet: Address;
  amountSol?: number; // buy / buyback / withdraw
  sellPct?: number; // sell
  tokens?: number; // burn / send-tokens
  to?: Address; // withdraw / send-tokens
  slippageBps?: number;
  priorityFeeSol?: number;
  jitoTipSol?: number;
  /** MEV protection: send only as a Jito bundle, never through the RPC / public mempool. */
  jitoOnly?: boolean;
  /** The coin's dev and the dev's funding wallet, when the caller knows them (blacklist check). */
  dev?: Address;
  funder?: Address;
  venue?: VenuePref;
  reason: string;
  ruleId?: string;
  /** buyback/burn must be publicly disclosed; the coin manager sets this. */
  disclosed?: boolean;
  /** v19: a Rogue-mode buy. The guardrails then also enforce the session's per-coin size, budget and coin count. */
  rogue?: boolean;
  /** v19.1: which automatic source sent this buy. A source switched off is refused; manual buys leave it unset. */
  origin?: TradeOrigin;
  /**
   * v20: what set this trade off, when it reacts to someone else's trade. "big-buy": sell our own position after a large
   * buy landed (exits.sellIntoBuys). The guardrails allow only a sell of our own holding, and only once their buy has a
   * signature (it landed): never a buy, never anything placed ahead of or around their transaction.
   */
  trigger?: { kind: "big-buy"; signature?: string; wallet: string; sol: number; at: number };
  /** v19: the pipeline candidate this trade belongs to; the executor reports Check / Execute on it. */
  trace?: { id: string; symbol?: string; source?: import("./ui/pipeline.js").Source; action?: import("./ui/pipeline.js").DecisionAction };
}

export interface TradeResult {
  ok: boolean;
  signature?: string;
  venue?: Venue;
  tokens?: number;
  solDelta?: number;
  latencyMs?: number;
  error?: string;
}

// ---------- activity ----------

export type ActivityKind =
  | "signal" | "skip" | "buy" | "sell" | "tp" | "sl" | "trail" | "timeout" | "launch" | "post" | "reply"
  | "claim" | "buyback" | "burn" | "guardrail" | "error" | "status" | "withdraw";

export interface Activity {
  at: number;
  kind: ActivityKind;
  message: string;
  mint?: Mint;
  ruleId?: string;
  signature?: string;
  solDelta?: number;
  latencyMs?: number;
}

export type AgentStatus = "online" | "paused" | "stopped";
