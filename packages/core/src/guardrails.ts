/**
 * Guardrails. Every transaction and every public post passes through here first, in every mode
 * (CLI, Telegram, MCP, hosted panel). They cannot be switched off from config, chat or tool calls.
 *
 * What Vesk will never do:
 *  1. Wash trading or volume bots: no buying and selling the same coin back and forth, no trades
 *     between the owner's own wallets, no "make volume" mode.
 *  2. Fake engagement, shill bots or sockpuppets: posts only go to the owner's own linked accounts,
 *     are rate-limited, are never duplicated across accounts, and never promise returns.
 *  3. Impersonation: no posting as, or claiming to be, anyone else.
 *  4. Coordinated pump schemes: no undisclosed multi-wallet buying, no "everyone buy at" calls.
 *     The one exception is a team allocation at launch: up to 4 of the owner's own wallets buy in the
 *     create bundle, and their full addresses are published in the coin description and the treasury
 *     report. It can't be enabled without that disclosure (see launch/plan.ts, checkLaunch).
 *  5. Every trade comes from one of the owner's own disclosed wallets.
 *  6. No hidden supply: no stealth or "block 0" bundles, temporary holder wallets, obfuscated or
 *     CEX-routed funding, bubble-map evasion, randomized "organic-looking" buys or MEV layers.
 *
 * Spend limits (per-trade max, daily cap, open positions, buys per minute, reserve, kill switch) are enforced here too,
 * and for a Rogue-mode buy (v19) the session's per-coin size, total budget and coin count, whatever the strategy says.
 */
import { blacklistHit, type BlacklistIndex } from "./watch/blacklist.js";
import { TRADE_ORIGIN_LABEL, type Address, type Limits, type TradeIntent, type TradeOrigin } from "./types.js";
import { BRAND } from "./brand.js";

export type GuardCode =
  | "kill-switch" | "undisclosed-wallet" | "per-trade-max" | "daily-cap" | "max-positions" | "daily-buys" | "reserve"
  | "wash-trade" | "self-trade" | "multi-wallet" | "forbidden-action" | "undisclosed-buyback" | "buyback-rate"
  | "post-account" | "post-rate" | "post-duplicate" | "post-promise" | "post-impersonation" | "post-coordination" | "withdraw-target"
  | "launch-disclosure" | "launch-team" | "launch-invalid"
  | "launch-dedupe" | "launch-rate" | "launch-cooldown" | "launch-spend" | "launch-honesty" | "paused" | "blacklist"
  | "buys-per-minute" | "rogue-off" | "rogue-size" | "rogue-budget" | "rogue-coins" | "honeypot" | "source-off" | "in-flight" | "ahead-of-trade";

export type GuardResult = { ok: true } | { ok: false; code: GuardCode; reason: string };
const no = (code: GuardCode, reason: string): GuardResult => ({ ok: false, code, reason });
/** v19.1: the refusal for a buy from a source you switched off (Live → Strategy, or Strategy & safety → Entry). */
export const sourceOffReason = (o: TradeOrigin) => `${TRADE_ORIGIN_LABEL[o]} is off: buys from it are paused.`;
const OK: GuardResult = { ok: true };

/** Words that describe things Vesk refuses to do. Used on chat input, config and MCP tool arguments. */
export const FORBIDDEN_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bwash[\s-]?trad/i, what: "wash trading" },
  { re: /\bvolume[\s-]?(bot|boost|farm|generat|maker)/i, what: "volume bots" },
  { re: /\b(make|fake|pump|boost|inflate)\s+(the\s+)?volume\b/i, what: "fake volume" },
  { re: /\b(fake|bot|buy)\s+(followers|likes|engagement|replies|views)\b/i, what: "fake engagement" },
  { re: /\bshill\s*(bot|army|raid)s?\b|\braid\s+bots?\b/i, what: "shill bots" },
  { re: /\bsock\s?puppets?\b|\balt\s+accounts?\b|\bburner\s+accounts?\b/i, what: "sockpuppets" },
  { re: /\bimpersonat|\bpretend\s+to\s+be\b|\bpose\s+as\b/i, what: "impersonation" },
  { re: /\bbundl(e|ed|ing)\s+(buy|wallet|launch)|\b(multiple|many|\d+)\s+wallets?\s+to\s+buy\b|\bspread\s+(buys|the buy)\s+across\s+wallets/i, what: "multi-wallet buying" },
  { re: /\bstealth\s+(launch|bundles?|buys?|wallets?)|\bhid(e|den)\s+(the\s+)?(bundle|supply|holdings|team\s+wallets?)|\b(avoid|evade|bypass|beat|dodge|fool)\s+(the\s+)?(bubble\s*maps?|bundle\s+(detection|checkers?)|detection)/i, what: "hidden supply or stealth bundles" },
  { re: /\b(obfuscat\w*|untraceable|hid(e|den))\s+(the\s+)?funding|\btemp(orary)?[\s-]holder\s+wallets?|\bfresh\s+wallets?\s+(funded\s+)?(from|via|through)\s+(a\s+)?cex/i, what: "obfuscated wallet funding" },
  { re: /\borganic[\s-]looking|\brandomi[sz]e\w*\s+(the\s+)?(buys?|amounts?|wallets?|timing)/i, what: "fake organic buying" },
  { re: /\b(front|back)[\s-]?run\w*\s+(layers?|wallets?)|\bsandwich\s+(attack|bot)s?\b|\bmev\s+layers?\b/i, what: "MEV attacks" },
  { re: /\bmarket[\s-]?mak(er|ing)\s+bots?\b/i, what: "market-maker bots" },
  { re: /\bcoordinat\w*\s+(pump|buy)|\bpump\s+(and|&|n)\s+dump\b|\beveryone\s+buy\s+at\b/i, what: "coordinated pumps" },
];

export function forbiddenIntent(text: string): string | null {
  for (const f of FORBIDDEN_PATTERNS) if (f.re.test(text)) return f.what;
  return null;
}

export const ALLOWED_ACTIONS = new Set(["buy", "sell", "buyback", "burn", "claim-fees", "withdraw", "send-tokens", "close-accounts"]);

/** Recent fills the wash/self-trade checks look at. */
export interface RecentFill {
  at: number;
  mint: string;
  side: "buy" | "sell";
  wallet: Address;
  amountSol: number;
}

export interface GuardContext {
  limits: Limits;
  /** The owner's disclosed wallets. Trades from anything else are refused. */
  ownWallets: Address[];
  spentTodaySol: number;
  buysToday: number;
  openPositions: number;
  /** true if the intent's mint is already an open position (adding doesn't open a new one). */
  holdsMint?: boolean;
  walletBalanceSol?: number;
  recentFills: RecentFill[];
  /** Destination addresses the owner approved for withdrawals (hosted mode). Empty = any address the owner types. */
  withdrawAllowlist?: Address[];
  /** All of the owner's wallets (main + imported), for token sends. */
  allOwnWallets?: Address[];
  /** Coins this agent launched (dev supply). */
  launchedMints?: string[];
  /** Last disclosed buyback time for the coin (ms). */
  lastBuybackAt?: number;
  /** Your blacklist (watch/blacklist.ts). Buys of a listed coin, dev or funder are refused. */
  blacklist?: BlacklistIndex;
  /** v19: the running Rogue session (strategy/rogue.ts rogueGuard). A Rogue buy without one is refused. */
  rogue?: { perCoinSol: number; budgetSol: number; spentSol: number; coins: number; maxCoins: number; mints: string[] };
  /** v19.1: automatic sources switched off (strategy/settings.ts sourcesOff). Their buys are refused; manual ones aren't. */
  sourcesOff?: TradeOrigin[];
  /**
   * v20: buys other lanes have reserved but not finished (work/reserve.ts). Spend, buys and positions count them, and
   * a coin another lane is buying right now is refused, so running several lanes at once can't overshoot a limit or buy
   * one coin twice.
   */
  inFlight?: { sol: number; buys: number; positions: number; mints: string[] };
  now?: number;
}

export const BUYS_PER_MINUTE_DEFAULT = 10;

export const WASH_WINDOW_MS = 10 * 60_000;
export const MULTI_WALLET_WINDOW_MS = 30 * 60_000;
export const BUYBACK_MIN_INTERVAL_MS = 60 * 60_000;

export function checkTrade(i: TradeIntent, c: GuardContext): GuardResult {
  const now = c.now ?? Date.now();
  if (!ALLOWED_ACTIONS.has(i.action)) return no("forbidden-action", `"${String(i.action)}" is not something ${BRAND.name} does.`);
  const reasonBad = forbiddenIntent(i.reason ?? "");
  if (reasonBad) return no("forbidden-action", `Refused: ${reasonBad} is never allowed.`);
  if (!c.ownWallets.includes(i.wallet)) return no("undisclosed-wallet", "Trades only run from your own disclosed wallets.");

  // The kill switch stops everything that spends. Selling and withdrawing still work so you can get out.
  const spends = i.action === "buy" || i.action === "buyback";
  if (c.limits.killSwitch && spends) return no("kill-switch", "Kill switch is on. Buying is stopped.");
  if (i.action === "buy" && c.blacklist) {
    const hit = blacklistHit(c.blacklist, { mint: i.mint, dev: i.dev, funder: i.funder });
    if (hit) return no("blacklist", `Not bought: ${hit}.`);
  }

  if (i.action === "withdraw") {
    if (!i.to) return no("withdraw-target", "Withdraw needs a destination address.");
    if (c.ownWallets.includes(i.to) && i.to === i.wallet) return no("withdraw-target", "That is the same wallet.");
    if (c.withdrawAllowlist?.length && !c.withdrawAllowlist.includes(i.to)) return no("withdraw-target", "Destination is not on your withdraw allowlist.");
    return OK;
  }

  if (i.action === "close-accounts") return OK;
  if (i.action === "send-tokens") {
    if (!i.to || !i.mint) return no("withdraw-target", "Send tokens needs a coin and a destination address.");
    if (i.to === i.wallet) return no("withdraw-target", "That is the same wallet.");
    if (!(i.tokens! > 0)) return no("withdraw-target", "Amount must be above 0.");
    // Moving a launched coin's dev supply into your other wallets would hide it from holders.
    if (c.launchedMints?.includes(i.mint) && c.allOwnWallets?.includes(i.to))
      return no("launch-disclosure", "Moving dev supply between your own wallets would hide it. Sell or burn it (both are listed in the treasury report), or send it to an outside address.");
    if (c.withdrawAllowlist?.length && !c.withdrawAllowlist.includes(i.to)) return no("withdraw-target", "Destination is not on your withdraw allowlist.");
    return OK;
  }

  // v20: reacting to another trader's trade: only a sell of our own position, only after their buy landed
  if (i.trigger) {
    if (i.action !== "sell") return no("ahead-of-trade", `${BRAND.name} never trades ahead of or around another trader's transaction. It only sells its own position after their buy has landed.`);
    if (!i.trigger.signature) return no("ahead-of-trade", "Their buy hasn't landed (no signature yet). Vesk only reacts to trades that have landed.");
    if (i.trigger.wallet && c.ownWallets.includes(i.trigger.wallet)) return no("self-trade", "That buy came from one of your own wallets. Selling into it would trade against yourself.");
  }

  const fills = c.recentFills.filter((f) => f.mint === i.mint);
  const fl = c.inFlight;
  if (i.action === "buy" || i.action === "buyback") {
    const amt = i.amountSol ?? 0;
    if (i.action === "buy" && fl?.mints.includes(i.mint ?? "")) return no("in-flight", "Another lane is buying this coin right now. One buy per coin at a time.");
    if (i.action === "buy" && i.origin && c.sourcesOff?.includes(i.origin)) return no("source-off", sourceOffReason(i.origin));
    if (amt <= 0) return no("per-trade-max", "Amount must be above 0.");
    if (amt > c.limits.perTradeMaxSol) return no("per-trade-max", `${amt} SOL is above your per-trade max (${c.limits.perTradeMaxSol} SOL).`);
    const spent = c.spentTodaySol + (fl?.sol ?? 0);
    if (spent + amt > c.limits.dailySpendCapSol + 1e-9)
      return no("daily-cap", fl?.sol ? `Daily cap: ${round(c.spentTodaySol)} of ${c.limits.dailySpendCapSol} SOL spent today and ${round(fl.sol)} SOL in flight.` : `Daily cap: ${round(c.spentTodaySol)} of ${c.limits.dailySpendCapSol} SOL already spent today.`);
    if (i.action === "buy" && c.buysToday + (fl?.buys ?? 0) >= c.limits.maxBuysPerDay) return no("daily-buys", `Hit the ${c.limits.maxBuysPerDay} buys/day limit.`);
    const perMin = c.limits.maxBuysPerMinute ?? BUYS_PER_MINUTE_DEFAULT;
    if (i.action === "buy" && c.recentFills.filter((f) => f.side === "buy" && now - f.at < 60_000).length + (fl?.buys ?? 0) >= perMin) return no("buys-per-minute", `Hit the ${perMin} buys per minute limit.`);
    if (i.action === "buy" && i.rogue) {
      const r = c.rogue;
      if (!r) return no("rogue-off", "Rogue mode isn't running.");
      if (amt > r.perCoinSol + 1e-9) return no("rogue-size", `${amt} SOL is above the Rogue size (${r.perCoinSol} SOL per coin).`);
      if (!r.mints.includes(i.mint ?? "") && r.coins >= r.maxCoins) return no("rogue-coins", `Rogue: ${r.coins}/${r.maxCoins} coins already.`);
      if (r.spentSol + amt > r.budgetSol + 1e-9) return no("rogue-budget", `Rogue budget: ${round(r.spentSol)} of ${r.budgetSol} SOL spent.`);
    }
    if (i.action === "buy" && !c.holdsMint && c.openPositions + (fl?.positions ?? 0) >= c.limits.maxOpenPositions)
      return no("max-positions", `Already ${c.openPositions} open positions${fl?.positions ? ` and ${fl.positions} opening` : ""} (max ${c.limits.maxOpenPositions}).`);
    if (c.walletBalanceSol !== undefined && c.walletBalanceSol - amt < c.limits.minSolReserve)
      return no("reserve", `Would leave less than the ${c.limits.minSolReserve} SOL reserve.`);
    // Wash trading: buying back a coin we sold moments ago (round trips make fake volume).
    const soldRecently = fills.some((f) => f.side === "sell" && now - f.at < WASH_WINDOW_MS);
    if (soldRecently && i.action === "buy") return no("wash-trade", "Sold this coin in the last 10 minutes. Re-buying now would be a round trip.");
    // Coordinated / multi-wallet: another of our wallets bought this coin recently.
    const otherWallet = fills.some((f) => f.side === "buy" && f.wallet !== i.wallet && c.ownWallets.includes(f.wallet) && now - f.at < MULTI_WALLET_WINDOW_MS);
    if (otherWallet) return no("multi-wallet", `Another of your wallets bought this coin recently. ${BRAND.name} buys from one wallet per coin.`);
    if (i.action === "buyback") {
      if (!i.disclosed) return no("undisclosed-buyback", "Buybacks must be publicly disclosed (treasury report).");
      if (c.lastBuybackAt && now - c.lastBuybackAt < BUYBACK_MIN_INTERVAL_MS)
        return no("buyback-rate", "One buyback per hour at most, so buybacks can't be used to paint volume.");
    }
    return OK;
  }

  if (i.action === "sell") {
    // Selling into a coin we bought seconds ago from another own wallet = self-trade.
    const boughtByOther = fills.some((f) => f.side === "buy" && f.wallet !== i.wallet && now - f.at < WASH_WINDOW_MS);
    if (boughtByOther) return no("self-trade", "Another of your wallets just bought this coin. Selling now would trade against yourself.");
    return OK;
  }

  if (i.action === "burn" && !i.disclosed) return no("undisclosed-buyback", "Burns must be publicly disclosed (treasury report).");
  return OK; // claim-fees, burn
}

// ---------- posting ----------

export interface PostContext {
  /** Accounts the owner linked (X handles without @, Telegram chat ids as strings). */
  ownAccounts: string[];
  /** Posts made in the last hour by this agent, all accounts. */
  recentPosts: Array<{ at: number; account: string; text: string }>;
  maxPostsPerHour?: number;
  now?: number;
}

const PROMISE = /\b(guarantee[ds]?|can'?t lose|risk[\s-]?free|easy money|free money|\d{2,}x\s+(soon|incoming|guaranteed)|next\s+100x|will\s+(moon|10x|100x)|to the moon)\b/i;
const COORD = /\b(everyone|all of you|y'?all)\s+(buy|ape|aping)\b|\bbuy\s+at\s+\d{1,2}[:.]\d{2}\b|\braid\s+(this|now)\b/i;
const IMPERSONATE = /\b(official|from the team of|on behalf of)\s+@?(?!vesk)[a-z0-9_]{2,}\b/i;

export function checkPost(account: string, text: string, c: PostContext): GuardResult {
  const now = c.now ?? Date.now();
  if (!c.ownAccounts.map((a) => a.toLowerCase()).includes(account.toLowerCase()))
    return no("post-account", `${BRAND.name} only posts to accounts you linked yourself.`);
  if (PROMISE.test(text)) return no("post-promise", "Posts can't promise returns or price moves.");
  if (COORD.test(text)) return no("post-coordination", "Posts can't call for coordinated buying.");
  const bad = forbiddenIntent(text);
  if (bad) return no("forbidden-action", `Refused: ${bad}.`);
  if (IMPERSONATE.test(text)) return no("post-impersonation", "Posts can't speak for another person or project.");
  const hour = c.recentPosts.filter((p) => now - p.at < 3_600_000);
  const max = c.maxPostsPerHour ?? 6;
  if (hour.filter((p) => p.account.toLowerCase() === account.toLowerCase()).length >= max) return no("post-rate", `Posting limit: ${max} per hour per account.`);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (hour.some((p) => norm(p.text) === norm(text))) return no("post-duplicate", "Same text was already posted in the last hour (no copies across accounts).");
  return OK;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
