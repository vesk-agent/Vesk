# Exits

Exits sell for you. They work on snipe positions, on coins you launch, and on the dev position of coins launched from a post. Every exit is a normal sell through the guardrails, signed on your machine (self-hosted) or by the hosted wallet.

## In the panel

Set exits where you set up what buys:

- **Launch presets**: *Exits* section (sell after seconds, sell at market cap, stop below).
- **Launch-on-post builder**: *Sell at market cap*.
- **Coin page → Positions**: the exit ladder for a coin you hold, and on the trade panel, stop-loss and trailing orders ([Coin page](28-coin-page.md#trade-panel)). **Auto-sell…** opens the same exits as cards you expand one at a time (market-cap ladder, stop, trailing stop; time limit and timed sell under *Advanced settings*), then the plan in plain words, then Save.
- **Copy trade**: exits on each copy ([Copy trading](27-copy-trading.md)).

The coin page chart draws your exit targets and stop as lines.

**Sell into big buys** is an exit that waits for someone else's big buy on a coin you hold, then sells part of your position after it lands, never ahead of it. Set it up in **Strategy & safety → Exits → Set up…** ([Strategy & safety](34-strategy.md#sell-into-big-buys)).

<!-- flow: bigbuy "Someone else's big buy lands on a coin you hold; your sell goes in the next block, after it. Never ahead of it." -->

## From the terminal

```bash
vesk snipe @x --sol 0.2 --tp 3x:50 --sl 30                     # take-profit and stop-loss on a rule
vesk rules add --launch-on-post @a --dev-buy 0.3 --sell 50%@100k,100%@250k --stop 5k --timeout 720
vesk presets add --name "Dev sells at 5 s" --dev-buy 0.5 --sell-after 5:100,30:100
vesk order trail <mint> 100 --trail 25                         # a trailing stop on what you hold
```

Flags: `--sell 50%@100k,100%@250k`, `--sell-after 5:100,30:100`, `--stop 5k`, `--timeout 720`, `--tp 3x:50`, `--sl 30`, `--trail 25`.

## Settings

### Kinds

| Exit | Example | Notes |
|---|---|---|
| **Timed sell (seconds)** | sell 100% 5 s after entry | Up to 4 steps, each a % of what's left. Gets its own timer, so 5 s means about 5 s plus the time to land the sell. |
| **Market-cap target** | sell 50% at $100k, the rest at $250k | Up to 6 steps, ascending. |
| **Market-cap stop** | sell everything below $5k | Checked first. |
| Take-profit (multiple) | sell 50% at 3x | Snipe rules. |
| Stop-loss | -30% from entry | |
| Trailing stop | 20% from the high | |
| Timeout | sell everything after 12 h | |
| **No volume** | sell everything if under 0.5 SOL trades in 120 s | Launched coins and launch-on-post rules (`--no-volume 0.5/120s`). Counts the coin's trades on PumpPortal from when it's armed, so it waits one full window first. |

Order of checks: timed sells, market-cap stop, stop-loss, trailing stop, timeout, take-profit, market-cap targets. The exit loop runs every 3 s. Timed sells also get exact timers.

### In the config

`exit: { timeSells: [{ afterSec: 5, sellPct: 100 }], mcapTargets: [{ atMcapUsd: 100000, sellPct: 50 }], stopBelowMcapUsd: 5000, takeProfit: [{ atMultiple: 3, sellPct: 50 }], stopLossPct: 30, trailingStopPct: 20, timeoutMin: 240 }`

## Dev-sell timers, and why devs use them

Many buyers prefer coins where the dev holds no supply, because a dev bag can be sold into them later. A dev-sell timer sells your dev buy on a schedule you set and says so in public:

- every dev sell is listed in the treasury report, with its transaction,
- when the dev position is fully sold and run-your-coin posting is on, Vesk posts that the dev wallet sold, with the transaction link, and stops promotional updates for that coin,
- the coin's description still says it was inspired by the post and isn't affiliated with the poster.

Nothing here hides a sale. If you want to hold, don't set a timer.

## Limits and what's approximate

- **The exit loop runs every 3 s.** In a fast drop a stop can fill below its line; slippage caps how far.
- **Timed sells** get their own timers, so 5 s means about 5 s plus the time to land the sell.
- **Market caps** come from the coin's price and its 1 billion supply at the time of the check.
- **Exits keep running while the agent is paused**, like every sell; the kill switch stops buys, not exits.
- **Every exit is a normal sell** through the guardrails and your limits.
