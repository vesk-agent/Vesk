# Rogue mode

Rogue mode is for one hyped launch where many copies appear at once: a ticker everyone is waiting for, and a dozen coins with that ticker in the first minute. You name the target; for a short window the agent buys every new coin that matches, small and fixed, then sells the losers fast and keeps the leaders. It skips the soft filters on purpose (they can't work on a coin that's seconds old). It never skips your hard limits or the never-list.

## What it does

- **Matches** a new coin when its ticker is your target, or its name contains one of your keywords. Optionally you name the creator wallet or X account you expect the real one from: that coin is marked expected and is never sold for lagging.
- **Buys** each match once, at your per-coin size, until the window ends, the coin count is reached or the session budget is spent. A match past any of those is skipped with the reason ("Rogue budget: 0.4 of 0.4 SOL spent").
- **Skips** the early-volume trigger and the holder and dev checks (bundled, dev %, top 10, snipers, insiders, holders, dev history).
- **Cuts the losers**, checked every second: a coin that trades less than your stall volume in the stall window ("volume stalled: 0.1 SOL in 20 s"), one that falls through the stop-loss, and after the leader time every coin that isn't in the top one or two by market cap ("not in the top 2 by market cap after 90 s (#4)"). An expected coin is only ever sold by the stop-loss and your normal exits.
- **Ends** when the window is over: no new buys, the mode goes back to normal, and the coins still open keep their exits.

## What is still enforced, whatever the mode

These are in the guardrails, in code, and Rogue mode can't change them:

- the session's **per-coin size**, **total budget** and **coin count** (a Rogue buy that would cross one is refused by the guardrails, not just by the strategy);
- your **per-trade max**, **daily cap**, **open positions**, **buys per day** and **buys per minute**;
- the **kill switch**;
- **one wallet per coin**: every buy comes from the same wallet; no spreading a coin across wallets;
- the **never-list**: no wash trading or volume bots, no fake engagement, no impersonation, no coordinated pumps, no hidden supply. See [Guardrails](14-guardrails.md).

The **can-sell check** stays on by default: copies of a hyped launch are where honeypots live. Turning it off for Rogue mode asks you twice (once when you switch it, once when you start).

## In the panel

**Strategy & safety → Rogue mode**: the target (ticker, keywords, expected creator, expected X account), the session (window, max coins, per coin, budget), cutting the losers (stall, stop-loss, leaders after, keep the top) and the can-sell check. **Start Rogue mode…** shows what it will do, what it skips and what still applies, before anything starts.

While it runs, **Live** shows one line under the header: "Rogue mode · $TICKER · 6/10 coins · budget 2.4/5 SOL", how many are open, a countdown and **Stop**. Each match, buy, skip and cut is in the pipeline and the decision log with its reason.

## From the terminal

```bash
vesk rogue start --ticker ORBIT --sol 0.05 --coins 10 --budget 0.5 --window 10
vesk rogue start --ticker ORBIT --keywords orbit,orbit cat --creator <wallet> --x orbit_official --stall 20 --stall-vol 0.3 --sl 35 --leaders 90 --keep 2
vesk rogue status           # the line, the countdown and every coin with why it was sold
vesk rogue stop
```

`vesk rogue start` prints the same summary as the panel and asks before it starts (`--yes` skips the question). `--no-honeypot` needs `--i-understand` as well. Chat: "rogue mode $ORBIT 0.05 sol each, budget 1 sol, 10 coins" shows the session and waits for you. `vesk live` shows the Rogue line under its header.

## Settings

| Setting | Key | Default |
|---|---|---|
| Ticker | `rogue.ticker` | none |
| Name keywords | `rogue.keywords` | none |
| Expected creator | `rogue.expectedCreator` | none |
| Expected X account | `rogue.expectedX` | none |
| Window | `rogue.windowMin` | 10 min |
| Max coins | `rogue.maxCoins` | 10 |
| Per coin | `rogue.perCoinSol` | 0.05 SOL |
| Session budget | `rogue.budgetSol` | 0.5 SOL |
| Stalled after / below | `rogue.stallSec`, `rogue.stallMinVolSol` | 20 s, 0.3 SOL |
| Stop-loss | `rogue.stopLossPct` | 35% |
| Leaders after / keep the top | `rogue.leaderAfterSec`, `rogue.keepTop` | 90 s, 2 |
| Can-sell check | `rogue.honeypot` | on |

Every field's help is in [Strategy & safety](34-strategy.md#settings).

## Limits and what's approximate

- Self-hosted only: matches come from the live data stream (PumpPortal: pump.fun and the launchpads it carries). Copies launched somewhere the stream doesn't carry aren't seen.
- A match is decided from the coin's create message, so an expected X account counts only once the coin's metadata has loaded.
- Market cap, price and stall volume come from the stream's trades since the agent saw the coin. A coin nobody trades looks stalled, which is the point.
- Your buys-per-minute limit paces a session with many coins; raise it for the session if you need to.
- Copies of a hyped launch usually go to zero. Rogue mode cuts losses fast; it doesn't prevent them.
