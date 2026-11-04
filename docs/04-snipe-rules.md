# Snipe rules

A rule is a trigger, a buy and an exit, plus limits. Rules start **off** when drafted and only run after you confirm. Snipe rules buy: when a watched account posts a contract address, or when a new coin launches that passes your filters.

## In the panel

**Agent → Rules → Snipe** lists your rules as cards that read in four parts: **Watches** (the trigger), **Buys**, **Exits** and **Limits**, with whether it's on, today's buys against its daily maximum and when it last fired. **Details** at the foot of a card opens every value (slippage, fees, venue, cooldown, what it can spend in a day). Add one with **New rule**, start from a template (a new account sees three tiles: callers, strict new launches, launch announcements; each opens in the builder, switched off), or describe it in **Chat**. Every draft is shown line by line with the assumptions Vesk made, and nothing runs until you confirm. A rule can name a [trading preset](21-trading-settings.md) for its slippage, fees and MEV mode.

The builder is a dialog in five steps: **Watch** (the name and the trigger), **Buy** (amount and maximum market cap; slippage, fees and venue under *Advanced (optional)*), **Exit** (take-profit steps, stop-loss, trailing stop, sell after), **Limits** (buys a day; cooldown and several CAs in a post under *More limits*) and **Plan**. It reads the rule back as one sentence at the top ("When @a posts a contract address, buy 0.25 SOL if market cap is under $50k, then sell 50% at 3x…"); each part opens its step. The Plan lists what it watches, buys, how it exits, its limits and the most it can spend in a day, then **Save rule** (or **Test in paper** first). If you choose *On after saving*, the Plan says once what that means: it buys by itself.

**Turning a rule on asks first**, with what it can spend in a day: a rule buys by itself whenever it matches.

**Test in paper** (on each card, and in the builder) replays recent events through the rule with the same matcher and buy decision your agent runs, and shows what it would have done: how many it would buy and skip, the SOL it would have spent, the top reasons to skip as bars, and every event, newest first. X rules replay the posts in your Tracker feed; new-launch rules replay the launches Pulse has seen in this tab (a sample board in the offline preview). Nothing is sent or signed. A post carries no price, so for X rules the market-cap check is reported as not checked rather than guessed.

### Chat

Say it in plain English in the panel, Telegram or the CLI (`vesk chat`):

| You say | Vesk drafts |
|---|---|
| snipe anything @x posts under 50k mcap with 0.5 SOL | x-post rule, CA in post, 0.5 SOL, max mcap $50k |
| sell half if it 3x's | take-profit: 50% at 3x |
| buy 0.1 sol of new launches with socials, dev under 5% | new-launch rule with filters |
| stop loss 30%, trailing 20%, max 2 buys a day | exits and limits |
| buy 0.3 sol of `<mint>` | a one-off buy for you to confirm |

Every draft is shown line by line with the assumptions Vesk made. Nothing runs until you confirm.

## From the terminal

```bash
vesk snipe @alpha_calls --sol 0.25 --max-mcap 50k --tp 3x:50 --sl 30 --per-day 3
vesk snipe --launches --sol 0.1 --max-dev 5 --socials --min-liq 10 --block cat,dog
vesk rules add "snipe anything @alpha_calls posts under 50k mcap with 0.25 SOL, sell half if it 3x's"
vesk rules [list | show <id> | enable <id> | disable <id> | rm <id>]
vesk chat "stop loss 30%, trailing 20%, max 2 buys a day"
```

### Limit orders and DCA

Orders live next to rules: limit buy below a price, limit sell above a price, or DCA (buy an amount every N minutes, N times). Prices are in SOL per token. The running agent picks new orders up within 2 seconds (or when it next starts), checks them every 2 seconds, and every fill passes the same limits and guardrails as any other trade.

```bash
vesk order buy  <mint> 0.1 --below 0.00000040     # limit buy
vesk order sell <mint> 50  --above 0.00000120     # limit sell 50% of the position
vesk order dca  <mint> 0.05 --every 60 --times 6  # 0.05 SOL every hour, six times
vesk orders                                        # list (or --json)
vesk orders cancel <id>
```

All order types (stop-loss, trailing, TWAP, dev-sell, migration) are on the [coin page](28-coin-page.md#trade-panel).

## Settings

A rule in your config (`vesk.config.yaml`) or as saved from the panel:

```yaml
rules:
  - id: r_quiet
    name: Quiet sniper
    enabled: true
    trigger:
      kind: x-post                 # x-post | new-launch | manual
      handles: [alpha_calls, beta_dev]
      mode: ca-in-post             # the post itself contains a full mint address
      includeReplies: false
      includeReposts: false
    buy:
      amountSol: 0.25
      maxMcapUsd: 50000            # skip if the coin is already above this
      slippageBps: 1500            # 15%
      priorityFeeSol: 0.0005
      jitoTipSol: 0.001            # optional
      venue: auto                  # auto | pumpfun | jupiter
    exit:
      takeProfit:
        - { atMultiple: 3, sellPct: 50 }
        - { atMultiple: 6, sellPct: 100 }
      stopLossPct: 30
      trailingStopPct: 20          # from the highest price since entry
      timeoutMin: 240              # sell everything after 4 hours
    maxBuysPerDay: 3
    cooldownSec: 30
    multiCa: skip                  # several addresses in one post: skip (default) or take the first
```

### New-launch rules

```yaml
trigger:
  kind: new-launch
  launchpad: pumpfun
  filters:
    maxDevHoldingPct: 5
    requireSocials: [x, telegram, website]
    minLiquiditySol: 10
    maxMcapUsd: 15000
    blocklist: [cat, dog]          # name/ticker substrings
    nameIncludes: []               # only these, if set
    blockedCreators: []
    rugChecks: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxTop10Pct: 30 }
```

## How a rule decides

1. **Match.** The post is from a watched handle (replies and reposts off unless enabled), and it contains exactly one valid mint address (or a keyword plus a coin link).
2. **Verify.** The address is checked on-chain to be a token mint.
3. **Decide.** Market cap under your max, the rule is under its daily buys, not in cooldown, not already holding the coin.
4. **Guard.** Kill switch, per-trade max, daily cap, open positions, SOL reserve, and the manipulation guardrails.
5. **Execute.** pump.fun coins through PumpPortal (bonding curve or PumpSwap), everything else through Jupiter. Optional Jito bundle.
6. **Exit.** Every 3 seconds: market-cap stop, then stop-loss, trailing stop, timeout, the next take-profit step, and the next market-cap target.

Market-cap targets and timed sells work on any rule (see [Exits](07-exits.md)): `exit: { mcapTargets: [{ atMcapUsd: 100000, sellPct: 50 }, { atMcapUsd: 250000, sellPct: 100 }], stopBelowMcapUsd: 5000 }`. Each target sells a % of what's left.

## Launch-on-post rules

A second rule type launches a coin when a watched account posts, instead of buying one. See [Launch on posts](05-launch-on-post.md).

## Limits and what's approximate

- **Rules start off.** A drafted rule only runs after you confirm it.
- **Every buy passes the guardrails:** kill switch, per-trade max, daily cap, open positions, SOL reserve, the blacklist and the manipulation checks. A rule's `maxBuysPerDay` and `cooldownSec` come on top.
- **Market cap is read when the signal arrives.** A fast-moving coin can be higher by the time the buy lands; slippage caps how much.
- **Several addresses in one post** are skipped unless the rule says `multiCa: first`.
- **Exits are checked every 3 s** (timed sells get their own timers), so a stop can fill below its line in a fast drop.
