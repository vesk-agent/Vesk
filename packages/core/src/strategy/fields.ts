/**
 * Every Strategy & safety parameter, described once (v19). The panel draws its form, its search and every "?" from
 * this list; `vesk strategy set <key> <value>` and chat set values through `setField`; docs/34-strategy.md lists the
 * same entries. Pure.
 */
import type { Limits } from "../types.js";
import { normalizeStrategy, type StrategyGroup, type StrategySettings } from "./settings.js";

export type FieldKind = "bool" | "number" | "check" | "enum" | "text" | "list" | "ladder" | "steps";
export type FieldUnit = "SOL" | "%" | "s" | "min" | "USD" | "buys" | "wallets" | "holders" | "coins" | "x" | "launches" | "rugs" | "per min" | "per day" | "positions" | "lanes";

export interface StrategyField {
  /** Dot path into StrategySettings, or `limits.<key>` for a hard limit. */
  key: string;
  group: StrategyGroup;
  /** Sub-heading inside the group. */
  section: string;
  label: string;
  /** What it does, in one or two sentences. */
  help: string;
  typical?: string;
  tradeoff?: string;
  kind: FieldKind;
  unit?: FieldUnit;
  min?: number;
  max?: number;
  step?: number;
  /** null allowed (off) for number fields. */
  nullable?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** The toggle that turns this field on; it's shown dimmed while that is off. */
  on?: string;
  /** Only used when another field has this value (e.g. the % fields when sizing by %); dimmed otherwise. */
  when?: { key: string; is: string | number | boolean };
  /** Extra words people search for. */
  tags?: string[];
  /** Example text for an empty text field. */
  placeholder?: string;
  /** v20: where it applies, when that differs from its group's line (GROUPS[].applies). */
  applies?: string;
}

export const GROUPS: Array<{ id: StrategyGroup; label: string; line: string; applies: string }> = [
  { id: "entry", label: "Entry", line: "Which new coins the agent buys, and how much.", applies: "Applies to the strategy's own buys (Pulse: buy new coins automatically). Snipe rules and copies keep their own filters." },
  { id: "rug", label: "Rug check", line: "Holder checks. Each one can be switched off.", applies: "Applies to the strategy's own buys, before they're sent. Rogue mode skips it on purpose." },
  { id: "honeypot", label: "Honeypot", line: "Before buying a coin that isn't on pump.fun: can it be sold?", applies: "Applies to non-pump.fun launches: other launchpads, AMM pools and Token-2022 coins. pump.fun bonding-curve coins can't be honeypotted (fixed program, no freeze authority or transfer hooks), so this check is skipped for them." },
  { id: "exits", label: "Exits", line: "How positions get sold.", applies: "Applies to positions the strategy opens. Snipe-rule and copy positions keep their own exits." },
  { id: "limits", label: "Hard limits", line: "Enforced on every buy, in every mode.", applies: "Applies to every buy, in every mode and from every source, manual buys included." },
  { id: "rogue", label: "Rogue mode", line: "One hyped launch, many copies: buy every match small, cut the losers.", applies: "Applies only while a Rogue session runs." },
];

/** v20: where a field applies (its own line, else its group's). */
export const appliesOf = (f: StrategyField): string => f.applies ?? GROUPS.find((g) => g.id === f.group)!.applies;
/** Hard limits live with the guardrails' limits (`limits.<key>`), not in the strategy. */
export const isLimitKey = (key: string) => key.startsWith("limits.");

const F = (f: StrategyField) => f;
export const STRATEGY_FIELDS: StrategyField[] = [
  // ---------------------------------------------------------------- entry
  F({ key: "entry.autoNewCoins", group: "entry", section: "Trading from", label: "Pulse: buy new coins automatically", kind: "bool", help: "Watch new coins from the data stream (what Pulse shows) and buy the ones that pass every check below. Off: the strategy buys nothing by itself; the can-sell check and the hard limits still apply to every buy. Presets don't change this.", typical: "Off until you've watched it in paper mode.", tags: ["snipe", "auto", "pulse", "source"] }),
  F({ key: "sources.snipe", group: "entry", section: "Trading from", label: "Snipe rules", kind: "bool", help: "Buys from your snipe rules (an X post with a contract address, a new launch that matches a rule). Off: the rules still match and Live shows them, but every buy they send is refused. Presets don't change this.", typical: "On.", tags: ["source", "rules", "x"] }),
  F({ key: "sources.copy", group: "entry", section: "Trading from", label: "Copy trade", kind: "bool", help: "Automatic copies of the wallets you track. Off: their buys show in the copy feed but aren't copied; a copy you click or confirm still goes through. Presets don't change this.", typical: "On.", tags: ["source", "copy", "wallet"] }),
  F({ key: "sources.launchOnPost", group: "entry", section: "Trading from", label: "Launch on post", kind: "bool", help: "Launch-on-post rules (a launch, with its dev buy, when an account you watch posts). Off: matching posts are logged and skipped. Presets don't change this.", typical: "On.", tags: ["source", "launch"] }),
  F({ key: "entry.earlyVolume.enabled", group: "entry", section: "Early-volume trigger", label: "Early-volume trigger", kind: "bool", help: "Wait for proof of interest: buy only once a new coin reaches your volume, buys or buyers inside its first seconds. A coin that doesn't is filtered with the numbers it reached.", typical: "On.", tradeoff: "You buy a little later and a little higher, after other people have.", tags: ["trigger", "volume", "momentum"] }),
  F({ key: "entry.earlyVolume.windowSec", group: "entry", section: "Early-volume trigger", label: "Within the first", kind: "number", unit: "s", min: 3, max: 600, step: 1, on: "entry.earlyVolume.enabled", help: "The window after the coin's creation the trigger counts in (T).", typical: "15 to 60 s." }),
  F({ key: "entry.earlyVolume.minVolSol", group: "entry", section: "Early-volume trigger", label: "Volume at least", kind: "number", unit: "SOL", min: 0, max: 10000, step: 0.1, on: "entry.earlyVolume.enabled", help: "SOL traded (buys and sells) inside the window (X). 0 means not checked.", typical: "3 to 10 SOL." }),
  F({ key: "entry.earlyVolume.minBuys", group: "entry", section: "Early-volume trigger", label: "Buys at least", kind: "number", unit: "buys", min: 0, max: 100000, step: 1, on: "entry.earlyVolume.enabled", help: "Buy transactions inside the window (N). 0 means not checked.", typical: "10 to 30." }),
  F({ key: "entry.earlyVolume.minBuyers", group: "entry", section: "Early-volume trigger", label: "Unique buyers at least", kind: "number", unit: "wallets", min: 0, max: 100000, step: 1, on: "entry.earlyVolume.enabled", help: "Distinct wallets that bought inside the window. Harder to fake than a buy count. 0 means not checked.", typical: "8 to 20." }),
  F({ key: "entry.earlyVolume.need", group: "entry", section: "Early-volume trigger", label: "Needs", kind: "enum", options: [{ value: "all", label: "All of them" }, { value: "any", label: "Any one" }], on: "entry.earlyVolume.enabled", help: "Whether every number you set must be reached, or one is enough.", typical: "All of them." }),
  F({ key: "entry.minMcapUsd", group: "entry", section: "Bounds", label: "Min market cap", kind: "number", unit: "USD", min: 0, step: 1000, nullable: true, help: "Skip coins below this market cap when they're checked. Empty: no minimum.", typical: "$5K." }),
  F({ key: "entry.maxMcapUsd", group: "entry", section: "Bounds", label: "Max market cap", kind: "number", unit: "USD", min: 0, step: 1000, nullable: true, help: "Skip coins above this market cap when they're checked. Empty: no maximum.", typical: "$40K to $150K.", tags: ["mc", "mcap"] }),
  F({ key: "entry.minLiquiditySol", group: "entry", section: "Bounds", label: "Min liquidity", kind: "number", unit: "SOL", min: 0, step: 0.5, nullable: true, help: "Real SOL in the bonding curve or pool. Empty: no minimum.", typical: "1 SOL." }),
  F({ key: "entry.maxAgeSec", group: "entry", section: "Bounds", label: "Max age", kind: "number", unit: "s", min: 1, step: 10, nullable: true, help: "Skip coins older than this when they're checked. Empty: any age.", typical: "600 s (10 minutes)." }),
  F({ key: "entry.size.mode", group: "entry", section: "Buy amount", label: "Size by", kind: "enum", options: [{ value: "fixed", label: "Fixed SOL" }, { value: "pct", label: "% of wallet" }], help: "A fixed amount per buy, or a share of the wallet's SOL balance with a cap.", typical: "Fixed." }),
  F({ key: "entry.size.sol", group: "entry", section: "Buy amount", label: "Amount", kind: "number", unit: "SOL", min: 0.001, max: 1000, step: 0.01, when: { key: "entry.size.mode", is: "fixed" }, help: "SOL per buy when sizing is fixed. Your per-trade max still applies.", typical: "0.05 to 0.25 SOL." }),
  F({ key: "entry.size.pct", group: "entry", section: "Buy amount", label: "Share of wallet", kind: "number", unit: "%", min: 0.1, max: 100, step: 0.5, when: { key: "entry.size.mode", is: "pct" }, help: "When sizing by %: this share of the wallet's SOL balance at the moment of the buy.", typical: "2 to 5%." }),
  F({ key: "entry.size.capSol", group: "entry", section: "Buy amount", label: "Cap", kind: "number", unit: "SOL", min: 0.001, max: 1000, step: 0.01, when: { key: "entry.size.mode", is: "pct" }, help: "When sizing by %: never more than this per buy.", typical: "Your per-trade max or less." }),
  F({ key: "entry.scaleIn.enabled", group: "entry", section: "Scale-in", label: "Scale in", kind: "bool", help: "Add to a position once it's proving itself: when the price reaches a multiple of your entry, buy a share of the first amount again. Every add passes the guardrails and limits.", typical: "Off.", tradeoff: "Your average entry goes up; a reversal after an add costs more." }),
  F({ key: "entry.scaleIn.steps", group: "entry", section: "Scale-in", label: "Adds", kind: "steps", on: "entry.scaleIn.enabled", help: "Each add: at this multiple of entry, buy this % of the first buy. Up to three.", typical: "At 1.3x add 50%." }),
  // ---------------------------------------------------------------- rug
  F({ key: "rug.enabled", group: "rug", section: "Rug check", label: "Rug check", kind: "bool", help: "Run the holder checks below before a strategy buy. Each check can be switched off on its own.", typical: "On." }),
  F({ key: "rug.allowBundled", group: "rug", section: "Rug check", label: "Allow bundled coins", kind: "bool", on: "rug.enabled", help: "Off: coins whose creation block was bought together by linked wallets above your limit are refused. On: the bundled check is skipped so you can ride heavily bundled coins.", typical: "Off.", tradeoff: "Bundled supply can be sold into you at any moment.", tags: ["bundle", "bundler"] }),
  F({ key: "rug.maxBundledPct", group: "rug", section: "Holders", label: "Max bundled", kind: "check", unit: "%", min: 0, max: 100, step: 1, on: "rug.enabled", when: { key: "rug.allowBundled", is: false }, applies: "Applies to coins the agent watched from creation. Exact with Read funding through your RPC; without it, an upper bound.", help: "Supply bought in the creation block by the dev and wallets funded together. Never linked through pools, curves, programs or exchanges. Not used while Allow bundled coins is on.", typical: "10 to 20%.", tags: ["bundle"] }),
  F({ key: "rug.maxDevPct", group: "rug", section: "Holders", label: "Max dev holding", kind: "check", unit: "%", min: 0, max: 100, step: 1, on: "rug.enabled", help: "The creator's share of supply right now.", typical: "5 to 10%.", tags: ["creator"] }),
  F({ key: "rug.maxTop10Pct", group: "rug", section: "Holders", label: "Max top 10", kind: "check", unit: "%", min: 0, max: 100, step: 1, on: "rug.enabled", help: "The 10 largest holders' share of supply, curve and pool accounts left out.", typical: "25 to 35%." }),
  F({ key: "rug.maxSnipersPct", group: "rug", section: "Holders", label: "Max snipers", kind: "check", unit: "%", min: 0, max: 100, step: 1, on: "rug.enabled", applies: "Applies to coins the agent watched from creation (it needs the buys in the first blocks).", help: "Supply held by wallets whose first buy came within 3 s of the create (not the dev).", typical: "10 to 15%." }),
  F({ key: "rug.maxInsidersPct", group: "rug", section: "Holders", label: "Max insiders", kind: "check", unit: "%", min: 0, max: 100, step: 1, on: "rug.enabled", applies: "Applies to coins the agent watched from creation, with funding read through your RPC.", help: "Supply held by wallets funded by the dev, the dev's funder, or a funder they share. Needs funding data (read through your RPC).", typical: "10 to 15%." }),
  F({ key: "rug.minHolders", group: "rug", section: "Holders", label: "Min holders", kind: "check", unit: "holders", min: 0, max: 100000, step: 1, on: "rug.enabled", help: "Wallets holding the coin (curve and pool accounts left out).", typical: "15 to 30." }),
  F({ key: "rug.earlyConcentration.on", group: "rug", section: "Fake pump", label: "Early concentration", kind: "bool", on: "rug.enabled", applies: "Applies to coins the agent watched from creation (the stream's trades since the create).", help: "Refuse a coin when one wallet, or one cluster of wallets funded by the same address, bought more than a set share of the supply in its first seconds. That's how a fake pump starts: a big buy spikes the price so others pile in.", typical: "On.", tags: ["fake pump", "concentration", "whale", "cluster"] }),
  F({ key: "rug.earlyConcentration.maxPct", group: "rug", section: "Fake pump", label: "Max bought by one wallet or cluster", kind: "number", unit: "%", min: 1, max: 100, step: 1, on: "rug.earlyConcentration.on", applies: "Applies to coins the agent watched from creation. Clusters need funding read through your RPC; without it each wallet counts alone.", help: "The largest share of the supply one wallet (or one cluster) may have bought, net of its sells, in the window below.", typical: "10 to 20%.", tradeoff: "Lower refuses more real coins with an early whale; higher lets more fake pumps through.", tags: ["fake pump", "concentration"] }),
  F({ key: "rug.earlyConcentration.windowSec", group: "rug", section: "Fake pump", label: "In the first", kind: "number", unit: "s", min: 1, max: 600, step: 1, on: "rug.earlyConcentration.on", help: "How many seconds after creation count as early.", typical: "8 to 15 s.", tags: ["fake pump"] }),
  F({ key: "rug.spikeDump.on", group: "rug", section: "Fake pump", label: "Spike then dump", kind: "bool", on: "rug.enabled", applies: "Applies to coins the agent watched from creation, when the dump has already happened by the time of the check.", help: "Refuse a coin when a big early buyer pushed the price up and then sold a large part of what it bought, inside the window. It only sees what happened before the check, so it catches the pattern once it's underway.", typical: "On.", tags: ["fake pump", "dump", "spike", "rug"] }),
  F({ key: "rug.spikeDump.minSpikePct", group: "rug", section: "Fake pump", label: "Price up at least", kind: "number", unit: "%", min: 5, max: 10000, step: 5, on: "rug.spikeDump.on", help: "How far the price rose from that buyer's first buy before it sold.", typical: "80%.", tags: ["fake pump"] }),
  F({ key: "rug.spikeDump.minDumpPct", group: "rug", section: "Fake pump", label: "Then sold at least", kind: "number", unit: "%", min: 5, max: 100, step: 5, on: "rug.spikeDump.on", help: "The share of its own buy that wallet sold back.", typical: "50%.", tags: ["fake pump"] }),
  F({ key: "rug.spikeDump.windowSec", group: "rug", section: "Fake pump", label: "Within", kind: "number", unit: "s", min: 5, max: 3600, step: 5, on: "rug.spikeDump.on", help: "Seconds after creation the pattern is looked for.", typical: "60 s.", tags: ["fake pump"] }),
  F({ key: "rug.devHistory.on", group: "rug", section: "Dev history", label: "Dev's earlier coins", kind: "bool", on: "rug.enabled", help: "Look at the coins this dev made before, as far as this agent has seen them (a lower bound).", typical: "On." }),
  F({ key: "rug.devHistory.maxRugs", group: "rug", section: "Dev history", label: "Max earlier rugs", kind: "number", unit: "rugs", min: 0, max: 1000, step: 1, on: "rug.devHistory.on", help: "A rug here means the dev sold most (80% or more) of its own supply within 10 minutes of launch.", typical: "0." }),
  F({ key: "rug.devHistory.maxLaunches", group: "rug", section: "Dev history", label: "Max earlier launches", kind: "number", unit: "launches", min: 0, max: 100000, step: 1, on: "rug.devHistory.on", help: "Serial launchers make many coins and abandon them.", typical: "3 to 10." }),
  F({ key: "rug.mintRevoked", group: "rug", section: "Authorities", label: "Mint authority revoked", kind: "bool", on: "rug.enabled", applies: "Applies to every coin. pump.fun mints are created with it already revoked.", help: "Refuse a coin whose supply can still be increased.", typical: "On. pump.fun coins always pass." }),
  F({ key: "rug.freezeRevoked", group: "rug", section: "Authorities", label: "Freeze authority revoked", kind: "bool", on: "rug.enabled", applies: "Applies to every coin. pump.fun mints are created with it already revoked.", help: "Refuse a coin whose issuer can freeze your tokens.", typical: "On. pump.fun coins always pass." }),
  F({ key: "rug.lpLocked", group: "rug", section: "Authorities", label: "LP burned or locked", kind: "bool", on: "rug.enabled", applies: "Applies to AMM pools (coins that migrated or launched straight into a pool). A bonding curve has no LP, so the check passes there.", help: "For coins in an AMM pool: the liquidity tokens are burned or locked, so the pool can't be pulled. Bonding curves have no LP and pass.", typical: "On." }),
  F({ key: "rug.enrich", group: "rug", section: "Data", label: "Read funding through your RPC", kind: "bool", on: "rug.enabled", applies: "Applies to every rug check the strategy runs. Costs a few RPC calls per coin.", help: "Who funded each early wallet (first SOL transfer), so bundled and insiders are exact. Costs a few hundred ms per coin on your RPC.", typical: "On.", tradeoff: "Off: bundled is an upper bound and insiders are unknown." }),
  F({ key: "rug.unknown", group: "rug", section: "Data", label: "When a number is unknown", kind: "enum", options: [{ value: "pass", label: "Let it pass" }, { value: "refuse", label: "Refuse the coin" }], on: "rug.enabled", help: "Some numbers need data that isn't there yet (insiders without funding data, holders before your RPC answers).", typical: "Let it pass. Safe preset: refuse." }),
  // ---------------------------------------------------------------- honeypot
  F({ key: "honeypot.enabled", group: "honeypot", section: "Can-sell check", label: "Can-sell check", kind: "bool", help: "Before buying a coin that isn't a pump.fun coin (another launchpad, an AMM, Token-2022), check the mint's extensions and simulate a sell. Refused coins show why.", typical: "On.", tags: ["honeypot", "scam", "sell"] }),
  F({ key: "honeypot.simulate", group: "honeypot", section: "Can-sell check", label: "Simulate a sell", kind: "bool", on: "honeypot.enabled", help: "Build a Jupiter sell for a current holder and run it through your RPC's simulateTransaction (signatures not checked, nothing is sent). A coin no route or simulation can sell is refused.", typical: "On." }),
  F({ key: "honeypot.maxTaxPct", group: "honeypot", section: "Tax", label: "Max transfer tax", kind: "number", unit: "%", min: 0, max: 100, step: 0.5, on: "honeypot.enabled", help: "Token-2022 coins can charge a fee on every transfer, buys and sells included. Refused above this.", typical: "1 to 5%." }),
  F({ key: "honeypot.refuseTransferHook", group: "honeypot", section: "Token-2022 extensions", label: "Refuse a transfer hook", kind: "bool", on: "honeypot.enabled", help: "A transfer hook runs the issuer's program on every transfer and can block sells.", typical: "On." }),
  F({ key: "honeypot.refusePermanentDelegate", group: "honeypot", section: "Token-2022 extensions", label: "Refuse a permanent delegate", kind: "bool", on: "honeypot.enabled", help: "A permanent delegate can move or burn tokens in any wallet, yours included.", typical: "On." }),
  F({ key: "honeypot.refuseNonTransferable", group: "honeypot", section: "Token-2022 extensions", label: "Refuse non-transferable", kind: "bool", on: "honeypot.enabled", help: "Non-transferable tokens can't be sent or sold at all.", typical: "On." }),
  F({ key: "honeypot.refuseDefaultFrozen", group: "honeypot", section: "Token-2022 extensions", label: "Refuse default-frozen", kind: "bool", on: "honeypot.enabled", help: "New token accounts start frozen; only the issuer can thaw yours.", typical: "On." }),
  F({ key: "honeypot.refuseFreezeAuthority", group: "honeypot", section: "Token-2022 extensions", label: "Refuse a freeze authority", kind: "bool", on: "honeypot.enabled", help: "The issuer can freeze any holder's tokens later. Classic SPL tokens can have one too.", typical: "On." }),
  // ---------------------------------------------------------------- exits
  F({ key: "exits.takeProfit", group: "exits", section: "Take-profit", label: "Take-profit ladder", kind: "ladder", help: "At each multiple of your entry, sell this % of what's left. Steps go up.", typical: "2x sell 50%, 4x sell 50%.", tags: ["tp"] }),
  F({ key: "exits.stopLossPct", group: "exits", section: "Protection", label: "Stop-loss", kind: "number", unit: "%", min: 1, max: 99, step: 1, nullable: true, help: "Sell everything when the price falls this far below your entry. Empty: off.", typical: "20 to 35%.", tags: ["sl"] }),
  F({ key: "exits.trailingStopPct", group: "exits", section: "Protection", label: "Trailing stop", kind: "number", unit: "%", min: 1, max: 99, step: 1, nullable: true, help: "Sell everything when the price falls this far from the highest price since you bought (only once it's above entry). Empty: off.", typical: "15 to 30%." }),
  F({ key: "exits.timeoutMin", group: "exits", section: "Time", label: "Timed sell", kind: "number", unit: "min", min: 1, step: 1, nullable: true, help: "Sell everything this many minutes after the buy, whatever the price. Empty: off.", typical: "30 to 120 min." }),
  F({ key: "exits.noVolume.enabled", group: "exits", section: "No-volume exit", label: "No-volume exit", kind: "bool", help: "Sell when the coin goes quiet: less than your volume over the last seconds. Dead coins rarely come back.", typical: "On." }),
  F({ key: "exits.noVolume.windowSec", group: "exits", section: "No-volume exit", label: "Over the last", kind: "number", unit: "s", min: 5, max: 3600, step: 5, on: "exits.noVolume.enabled", help: "The window the volume is measured over (N).", typical: "60 to 180 s." }),
  F({ key: "exits.noVolume.minVolSol", group: "exits", section: "No-volume exit", label: "Volume below", kind: "number", unit: "SOL", min: 0, max: 10000, step: 0.1, on: "exits.noVolume.enabled", help: "Sell when less than this traded in the window (X).", typical: "0.3 to 1 SOL." }),
  F({ key: "exits.sellIntoBuys.enabled", group: "exits", section: "Sell into big buys", label: "Sell into big buys", kind: "bool", applies: "Applies to every coin this agent holds, on the venues the PumpPortal stream carries (pump.fun, PumpSwap and the launchpads it covers). Needs a Jito block engine.", help: "When someone else's buy of at least the size below lands on a coin you hold, sell part of your position straight away in a Jito bundle with a tip, at the higher price the buy left behind. Only your own position, only after their buy has landed: Vesk never trades ahead of or around another trader's transaction.", typical: "Off. Try it in paper mode first.", tradeoff: "Competitive; often fails; you pay the tip even when the price moves.", tags: ["mev", "whale", "jito", "big buy", "exit"] }),
  F({ key: "exits.sellIntoBuys.minBuySol", group: "exits", section: "Sell into big buys", label: "Their buy at least", kind: "number", unit: "SOL", min: 0.1, max: 100000, step: 0.5, on: "exits.sellIntoBuys.enabled", help: "Only buys this big trigger a sell.", typical: "3 to 10 SOL on pump.fun.", tags: ["mev", "whale"] }),
  F({ key: "exits.sellIntoBuys.sellPct", group: "exits", section: "Sell into big buys", label: "Sell", kind: "number", unit: "%", min: 1, max: 100, step: 5, on: "exits.sellIntoBuys.enabled", help: "The share of your position sold each time.", typical: "25 to 50%.", tags: ["mev"] }),
  F({ key: "exits.sellIntoBuys.tipSol", group: "exits", section: "Sell into big buys", label: "Tip", kind: "number", unit: "SOL", min: 0.0001, max: 1, step: 0.001, on: "exits.sellIntoBuys.enabled", help: "The Jito tip on the first try. After a miss the next try doubles it, up to the cap.", typical: "0.003 to 0.01 SOL.", tradeoff: "Competitive; often fails; you pay the tip even when the price moves.", tags: ["mev", "jito", "tip", "fee"] }),
  F({ key: "exits.sellIntoBuys.maxTipSol", group: "exits", section: "Sell into big buys", label: "Tip cap", kind: "number", unit: "SOL", min: 0.0001, max: 5, step: 0.001, on: "exits.sellIntoBuys.enabled", help: "The most it will ever tip for one sell.", typical: "0.02 SOL.", tags: ["mev", "jito", "tip"] }),
  F({ key: "exits.sellIntoBuys.cooldownSec", group: "exits", section: "Sell into big buys", label: "One try per coin every", kind: "number", unit: "s", min: 1, max: 3600, step: 5, on: "exits.sellIntoBuys.enabled", help: "So a run of big buys doesn't sell the whole position in seconds.", typical: "30 s.", tags: ["mev"] }),
  // ---------------------------------------------------------------- hard limits (Limits, enforced by the guardrails)
  F({ key: "limits.perTradeMaxSol", group: "limits", section: "Spend", label: "Max per trade", kind: "number", unit: "SOL", min: 0.001, step: 0.01, help: "No single buy can be larger, in any mode.", typical: "0.25 to 0.5 SOL." }),
  F({ key: "limits.dailySpendCapSol", group: "limits", section: "Spend", label: "Max per day", kind: "number", unit: "SOL", min: 0.001, step: 0.1, help: "Total SOL spent on buys per UTC day, in any mode.", typical: "1 to 3 SOL." }),
  F({ key: "limits.minSolReserve", group: "limits", section: "Spend", label: "Keep in the wallet", kind: "number", unit: "SOL", min: 0, step: 0.01, help: "Never let a buy take the wallet below this (fees, rent).", typical: "0.02 SOL." }),
  F({ key: "limits.maxOpenPositions", group: "limits", section: "Exposure", label: "Max open positions", kind: "number", unit: "positions", min: 1, max: 100, step: 1, help: "No new coin is bought while this many are open.", typical: "5 to 10." }),
  F({ key: "limits.maxBuysPerMinute", group: "limits", section: "Exposure", label: "Max buys per minute", kind: "number", unit: "per min", min: 1, max: 120, step: 1, help: "A ceiling on buys in any 60 seconds, across every source. Stops a runaway loop.", typical: "6. Raise it for Rogue sessions with many coins." }),
  F({ key: "limits.maxBuysPerDay", group: "limits", section: "Exposure", label: "Max buys per day", kind: "number", unit: "per day", min: 1, step: 1, help: "Agent-wide buys per UTC day across every rule and the strategy.", typical: "20." }),
  F({ key: "concurrency.lanes", group: "limits", section: "Parallel lanes", label: "Parallel lanes", kind: "number", unit: "lanes", min: 1, max: 5, step: 1, applies: "Applies to every buy the agent sends: snipe rules, copies, the strategy and Rogue mode. Sells never wait.", help: "How many buys the agent works on at the same time. More wait in a queue, in order. Every limit still applies across all lanes: spend, buys per minute, open positions, one buy per coin.", typical: "3.", tradeoff: "More lanes react faster in a busy minute and use more RPC; one lane is simplest to follow.", tags: ["concurrency", "parallel", "queue", "lanes"] }),
  F({ key: "concurrency.launches", group: "limits", section: "Parallel lanes", label: "Launches at once", kind: "number", unit: "launches", min: 1, max: 3, step: 1, applies: "Applies to launches from the panel and launch-on-post rules.", help: "Launches have their own lanes, so a launch never waits behind buys (or the other way round).", typical: "1 or 2.", tags: ["concurrency", "launch"] }),
  F({ key: "limits.killSwitch", group: "limits", section: "Kill switch", label: "Kill switch", kind: "bool", help: "Stops every buy at once. Sells and withdrawals still work so you can get out.", typical: "Off. Also in the top bar." }),
  // ---------------------------------------------------------------- rogue
  F({ key: "rogue.ticker", group: "rogue", section: "Target", label: "Ticker", kind: "text", placeholder: "e.g. ORBIT", help: "The ticker to chase, without $. Every new coin with exactly this ticker matches.", typical: "The hyped ticker." }),
  F({ key: "rogue.keywords", group: "rogue", section: "Target", label: "Name keywords", kind: "list", placeholder: "e.g. orbit, orbit cat", help: "A new coin whose name contains any of these matches too. Comma-separated.", typical: "One or two words from the name." }),
  F({ key: "rogue.expectedCreator", group: "rogue", section: "Target", label: "Expected creator", kind: "text", placeholder: "wallet address (optional)", help: "Optional. The wallet you expect the real coin from. Its coin is never sold for lagging (the stop-loss still applies).", typical: "Empty unless you know it." }),
  F({ key: "rogue.expectedX", group: "rogue", section: "Target", label: "Expected X account", kind: "text", placeholder: "@handle (optional)", help: "Optional. A coin whose metadata links this account counts as expected too.", typical: "Empty unless you know it." }),
  F({ key: "rogue.windowMin", group: "rogue", section: "Session", label: "Window", kind: "number", unit: "min", min: 1, max: 240, step: 1, help: "How long the session buys new matches. Exits keep running after it ends.", typical: "5 to 15 min." }),
  F({ key: "rogue.maxCoins", group: "rogue", section: "Session", label: "Max coins", kind: "number", unit: "coins", min: 1, max: 50, step: 1, help: "At most this many coins are bought in the session.", typical: "5 to 10." }),
  F({ key: "rogue.perCoinSol", group: "rogue", section: "Session", label: "Per coin", kind: "number", unit: "SOL", min: 0.001, step: 0.01, help: "One small buy per matching coin. Your per-trade max still applies.", typical: "0.02 to 0.1 SOL." }),
  F({ key: "rogue.budgetSol", group: "rogue", section: "Session", label: "Session budget", kind: "number", unit: "SOL", min: 0.001, step: 0.1, help: "The most the session can spend in total. Enforced by the guardrails, with your daily cap on top.", typical: "0.5 to 2 SOL." }),
  F({ key: "rogue.stallSec", group: "rogue", section: "Cut the losers", label: "Stalled after", kind: "number", unit: "s", min: 3, max: 3600, step: 1, help: "A coin is stalled when it trades less than the volume below in this many seconds. Stalled coins are sold.", typical: "15 to 30 s." }),
  F({ key: "rogue.stallMinVolSol", group: "rogue", section: "Cut the losers", label: "Stalled below", kind: "number", unit: "SOL", min: 0, step: 0.1, help: "The volume a coin needs over the stall window to keep it.", typical: "0.3 SOL." }),
  F({ key: "rogue.stopLossPct", group: "rogue", section: "Cut the losers", label: "Stop-loss", kind: "number", unit: "%", min: 1, max: 99, step: 1, help: "Sell a coin that falls this far below its entry.", typical: "30 to 40%." }),
  F({ key: "rogue.leaderAfterSec", group: "rogue", section: "Cut the losers", label: "Leaders after", kind: "number", unit: "s", min: 0, max: 3600, step: 5, help: "After this long, coins that aren't among the leaders by market cap are sold. 0: off.", typical: "60 to 120 s." }),
  F({ key: "rogue.keepTop", group: "rogue", section: "Cut the losers", label: "Keep the top", kind: "enum", options: [{ value: "0", label: "Off" }, { value: "1", label: "1" }, { value: "2", label: "2" }], help: "How many leaders by market cap to keep once the leader time has passed.", typical: "2." }),
  F({ key: "rogue.honeypot", group: "rogue", section: "Safety", label: "Can-sell check in Rogue mode", kind: "bool", help: "Fakes of a hyped launch are where honeypots live. On by default; switching it off asks twice.", typical: "On.", tradeoff: "Off saves a few hundred ms per coin and risks buying something you can't sell." }),
];

export const fieldOf = (key: string): StrategyField | undefined => STRATEGY_FIELDS.find((f) => f.key === key);

/** Search by label, help, section, key and tags (every word must match). */
export function searchFields(q: string): StrategyField[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return STRATEGY_FIELDS;
  return STRATEGY_FIELDS.filter((f) => {
    const hay = `${f.label} ${f.section} ${f.help} ${f.key} ${(f.tags ?? []).join(" ")} ${GROUPS.find((g) => g.id === f.group)?.label ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---------------------------------------------------------------- read / write by key

export function getPath(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
}
function setPath<T>(o: T, path: string, v: unknown): T {
  const c = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
  const ks = path.split(".");
  let cur = c;
  for (const k of ks.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k] as Record<string, unknown>; }
  cur[ks[ks.length - 1]] = v;
  return c as T;
}

/** A field's value as text (CLI, chat replies, docs). */
export function fieldText(f: StrategyField, v: unknown): string {
  const u = f.unit === "USD" ? "" : f.unit ? ` ${f.unit}` : "";
  if (v === null || v === undefined) return "off";
  if (f.kind === "bool") return v ? "on" : "off";
  if (f.kind === "check") { const c = v as { on: boolean; max?: number; min?: number }; return c.on ? `${c.max ?? c.min}${u}` : "off"; }
  if (f.kind === "ladder") return (v as Array<{ atMultiple: number; sellPct: number }>).map((s) => `${s.atMultiple}x sell ${s.sellPct}%`).join(", ") || "none";
  if (f.kind === "steps") return (v as Array<{ atMultiple: number; addPct: number }>).map((s) => `${s.atMultiple}x add ${s.addPct}%`).join(", ") || "none";
  if (f.kind === "list") return (v as string[]).join(", ") || "none";
  if (f.unit === "USD" && typeof v === "number") return `$${v.toLocaleString("en-US")}`;
  return `${v}${u}`;
}

const ON = /^(on|yes|true|enable|enabled|1)$/i, OFF = /^(off|no|false|disable|disabled|0|none|-)$/i;
/** Parse "2x50,4x50" or "2x sell 50%, 4x sell 50%". */
function parseLadder(t: string, word: "sell" | "add"): Array<{ atMultiple: number; v: number }> | null {
  if (OFF.test(t.trim())) return [];
  const parts = t.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const out: Array<{ atMultiple: number; v: number }> = [];
  for (const p of parts) {
    const m = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*x\\s*(?:${word}\\s*)?(\\d+(?:\\.\\d+)?)\\s*%?$`, "i").exec(p);
    if (!m) return null;
    out.push({ atMultiple: +m[1], v: +m[2] });
  }
  return out;
}

export type SetResult = { ok: true; strategy: StrategySettings; limits?: Partial<Limits>; text: string } | { ok: false; error: string };

/**
 * Set one field from text (`vesk strategy set`, chat). Hard limits come back in `limits` (they're saved with the
 * guardrails' limits, not in the strategy). Values are checked against the field's range.
 */
export function setField(s: StrategySettings, key: string, raw: string | number | boolean, limits?: Limits): SetResult {
  const f = fieldOf(key);
  if (!f) {
    const near = STRATEGY_FIELDS.filter((x) => x.key.toLowerCase().includes(key.toLowerCase().split(".").pop() ?? "")).slice(0, 3).map((x) => x.key);
    return { ok: false, error: `No setting "${key}".${near.length ? ` Did you mean ${near.join(", ")}?` : " `vesk strategy` lists them."}` };
  }
  const t = String(raw).trim();
  let v: unknown;
  const numOf = (x: string) => { const n = Number(x.replace(/^\$/, "").replace(/[, ]/g, "").replace(/(sol|%|s|sec|min|k)$/i, "")); return /k$/i.test(x.trim()) ? n * 1000 : n; };
  const ranged = (n: number) => (f.min !== undefined && n < f.min ? `${f.label} is at least ${f.min}${f.unit ? ` ${f.unit}` : ""}.` : f.max !== undefined && n > f.max ? `${f.label} is at most ${f.max}${f.unit ? ` ${f.unit}` : ""}.` : null);
  switch (f.kind) {
    case "bool":
      if (typeof raw === "boolean") v = raw; else if (ON.test(t)) v = true; else if (OFF.test(t)) v = false; else return { ok: false, error: `${f.label} is on or off.` };
      break;
    case "number": {
      if (f.nullable && OFF.test(t)) { v = null; break; }
      const n = typeof raw === "number" ? raw : numOf(t);
      if (!Number.isFinite(n)) return { ok: false, error: `${f.label} takes a number${f.unit ? ` (${f.unit})` : ""}.` };
      const bad = ranged(n);
      if (bad) return { ok: false, error: bad };
      v = n;
      break;
    }
    case "check": {
      const cur = getPath(s, key) as { on: boolean; max?: number; min?: number };
      const field = "min" in cur ? "min" : "max";
      if (OFF.test(t)) { v = { ...cur, on: false }; break; }
      if (ON.test(t)) { v = { ...cur, on: true }; break; }
      const n = numOf(t);
      if (!Number.isFinite(n)) return { ok: false, error: `${f.label} takes a number or off.` };
      const bad = ranged(n);
      if (bad) return { ok: false, error: bad };
      v = { ...cur, on: true, [field]: n };
      break;
    }
    case "enum": {
      const o = f.options!.find((x) => x.value.toLowerCase() === t.toLowerCase() || x.label.toLowerCase() === t.toLowerCase());
      if (!o) return { ok: false, error: `${f.label} is one of: ${f.options!.map((x) => x.value).join(", ")}.` };
      v = key === "rogue.keepTop" ? Number(o.value) : o.value;
      break;
    }
    case "text": v = t; break;
    case "list": v = OFF.test(t) ? [] : t.split(",").map((x) => x.trim()).filter(Boolean); break;
    case "ladder": { const l = parseLadder(t, "sell"); if (!l) return { ok: false, error: `${f.label}: write steps like "2x50, 4x50" (multiple x sell %).` }; v = l.map((x) => ({ atMultiple: x.atMultiple, sellPct: x.v })); break; }
    case "steps": { const l = parseLadder(t, "add"); if (!l) return { ok: false, error: `${f.label}: write steps like "1.3x50" (multiple x add %).` }; v = l.map((x) => ({ atMultiple: x.atMultiple, addPct: x.v })); break; }
  }
  if (isLimitKey(key)) {
    // only the key that changed: the rest stay wherever they're set (config file, panel)
    const k = key.slice("limits.".length) as keyof Limits;
    void limits;
    return { ok: true, strategy: s, limits: { [k]: v } as Partial<Limits>, text: `${f.label}: ${fieldText(f, v)}` };
  }
  const next = normalizeStrategy({ ...setPath(s, key, v), preset: "custom" });
  return { ok: true, strategy: next, text: `${f.label}: ${fieldText(f, getPath(next, key))}` };
}

/** Every field with its current value, grouped (the CLI's `vesk strategy`). */
export function describeStrategy(s: StrategySettings, limits?: Limits): Array<{ group: string; rows: Array<{ key: string; label: string; value: string; off: boolean }> }> {
  return GROUPS.map((g) => ({
    group: g.label,
    rows: STRATEGY_FIELDS.filter((f) => f.group === g.id).map((f) => {
      const v = isLimitKey(f.key) ? (limits ? (limits as unknown as Record<string, unknown>)[f.key.slice(7)] : undefined) : getPath(s, f.key);
      const off = (!!f.on && getPath(s, f.on) === false) || (!!f.when && getPath(s, f.when.key) !== f.when.is);
      return { key: f.key, label: f.label, value: v === undefined ? "–" : fieldText(f, v), off };
    }),
  }));
}
