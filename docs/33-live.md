# Live view

Live shows what your agent is doing right now. Every coin it considers is a candidate, and every candidate goes through the same six steps:

**Watch** (X posts, new pairs, tracked wallets) → **Check** (your limits and the guardrails, plus the rule's audits) → **Size** (your preset and limits set the amount) → **Execute** (signed by your agent, sent through Jito or your RPC) → **Exit** (take-profit, stop-loss, timers) → **Log** (the decision and its reason).

Most candidates stop at Check, and Live says why, in the same words the agent's code uses ("dev holds 12.4% (max 5%)", "freeze authority not revoked", "Kill switch is on. Buying is stopped."). The [strategy](34-strategy.md)'s checks show the same way: "early volume: 1.8 SOL, 6 buys, 5 buyers in 30 s (needs 5 SOL and 15 buys and 10 buyers)", "bundled 34% (max 20%)", "Not bought: transfer hook (program Abcd…wxyz) can block sells.".

## In the panel

Open **Live** in the sidebar under Agent, press **L** anywhere you're not typing, or find it with **⌘K**.

### The header

The agent and its state (Running, Paused, Paper, Kill switch on, Offline; hover it for uptime, self-hosted or hosted and paper or live), today's PnL, today's trades against your daily limit, wins and losses closed today, and spend against your daily cap. **Pause** and **Kill switch** are in the top bar: pausing stops new entries while exits keep running; the kill switch stops every buy (it asks first).

**Trading from** lists the four sources the agent buys from on its own, each on or off: **Snipe** (your snipe rules), **Copy** (copy trading), **Pulse** (the strategy's own new-coin buys) and **Launch on post**. Click one to change it in the Strategy tab. A source that's off still shows its matches here, but the guardrails refuse every buy it sends ("Copy trade is off: buys from it are paused."). Manual buys are never blocked by a source.

### Ready to run

A checklist of what the agent needs, one row each: **Wallet**, **RPC** (with its latency), **AI model** (provider and key), **X source** (the relay or your own API key), **Agent** (self-hosted and paired, or hosted), **Telegram** (optional, never counted as missing) and **Holder access**. Each row says Connected, Needs setup or Error, and why.

- **Fix** on the RPC row opens a drawer: paste the URL, **Test latency** (p50 and p95), **Save RPC**.
- **Fix** on the AI model row: pick Claude, GPT or OpenRouter, paste the key, **Save key** (stored encrypted).
- The other rows link to the page that sets them up (Wallets, Connections, Holder access).
- **Finish setup (N left)** opens the drawer with everything that's missing.

A missing piece greys the steps it blocks, with the reason: no RPC greys Check, Execute and Exit ("needs RPC"); no wallet greys Size and Execute; no X source greys Watch; an offline agent greys all six. When everything is connected the checklist folds into one **All connected** line; click it to see the rows.

### The pipeline

- **Incoming**, on the left: the newest candidates as they arrive, with where they came from (X, Pulse, a tracked wallet, a launch) and how each ended (filtered, landed, armed…).
- **The six steps**, each with what your strategy does there now (Watch: the sources that are on; Check: the rug and can-sell checks and the early-volume trigger; Size: the preset and buy size; Exit: the take-profit, stop-loss and timed sell), what it did last ("filtered $NOIR", "landed in 212 ms · $GLINT", "armed: Sell 50% at 2x · Stop-loss at -35%") and whether it's working right now.
- **Lanes.** The agent works on several candidates at once ([Parallel lanes](34-strategy.md#parallel-lanes), 1 to 5, plus launches in their own lane). The pipeline draws one thin row per lane, with a chip for each candidate in it, and the header says "3 lanes + launches · 2 busy · 1 queued". On a phone the rows fold into one.
- The candidate being worked on moves along the line as a small chip. A filtered one peels off into the **Filtered at Check** lane with its reason. One that executes shows "landed in N ms", then moves on to Exit as an open position with its exits armed.
- Under the steps: accounts and wallets watched, checked and filtered (with the most common reason), the strategy's preset and size (and the last amount sized), executed with the average landing time, exits armed (your open positions) and the last log line.

The page plays events about a second behind real time (three seconds in Low resource), so steps that arrive together still show one after another.

### Rogue mode

While a [Rogue mode](35-rogue-mode.md) session runs, one line under the header shows it: "Rogue mode · $TICKER · 6/10 coins · budget 2.4/5 SOL", how many coins are still open, a countdown and **Stop**. Its matches, buys, budget skips and cuts ("volume stalled: 0.1 SOL in 20 s") go through the pipeline and the decision log like everything else.

### Decision log

Every decision, newest first: the time, what it was (**Enter**, **Exit**, **Filtered**, **Skipped**, **Copied**, **Launched**), the coin, the reason and the result ("0.25 SOL", "+0.231 SOL", "not traded"). Filter by kind. **Follow live** keeps the newest at the top; scroll down (or turn it off) and the list holds still, with "N new · show latest" to jump back.

### Now trading, Strategy and Session

The right column is one card with three tabs, as tall as the decision log.

**Now trading**: each open position with its coin, where it came from (a snipe rule, a copied wallet, Pulse, a launch on post, a manual buy), entry against now in SOL, PnL in % and SOL, a small price line and the exits armed. Order it by **PnL** or **Recent**. Point at a row (or focus it) for **Sell 50%** and **All**; they go through the same trade path as everywhere else (your trading settings, then every guardrail). On a phone they're always shown. With nothing open it says how many sources Vesk is watching.

**Strategy**: the settings you change while you watch, without leaving Live. A preset (**Safe**, **Balanced**, **Degen**, **Rogue**, or **Custom** once you edit), then buy size, the early-volume trigger (SOL in the first N seconds), the rug check, the can-sell check, the main exits (first take-profit, stop-loss, timed sell), the daily limit, **Parallel lanes** (1 to 5, and launches 1 to 3), the four sources, and **Rogue mode** (type a ticker, switch it on, and it asks with the same confirm as Strategy & safety). Changes save by themselves a moment after you stop typing (a preset or a switch at once) through the same checks as [Strategy & safety](34-strategy.md); a value that isn't allowed says why under its row and isn't saved. "Saved" confirms it, and the pipeline's steps show the new values straight away. **All settings** opens Strategy & safety.

**Session**: wallet plus open positions at the start of the day and now, today's PnL line, and today's wins, losses, best and worst trade.

### Sell into big buys

With [Sell into big buys](34-strategy.md#sell-into-big-buys) on, every attempt is in the pipeline and the decision log: "a 7 SOL buy landed on $X", "selling 40% into it · tip 0.004 SOL", then the sell with "sold into a 7 SOL buy by WhaL…1111 · tip 0.004 SOL" or the miss.

### Launch on post

Right under the pipeline: how many launch-on-post rules are on, and a lane for each recent launch from a post: **the post** (the account and its text) → **the coin** (its picture, name, ticker and how long after the post it landed) → **the race** (its rank, e.g. *1st of 14*, and every coin for that post as a dot on a time line, yours ringed). Click the rank for the whole report: *1st of 14 · 1.7 s after the post*. Ranks count what the create stream saw (coins matched by the post's link, ticker, name or image on pump.fun's new-token stream).

Launch-on-post candidates also run through the pipeline in their own **launch** lane, with the reason at each step: *@maraokafor posted · Founders, launch on post*, then *waiting up to 120 s for 500 likes*, *1 coin for $DIAL already launched; skipped*, *draft sent · Launch or Skip within 120 s*, or *launched from @maraokafor's post in 1.7 s*. **Rules** goes to the rules. See [Launch on posts](05-launch-on-post.md#race-reports).

### Raw stream

A collapsible `tail -f` of the same events as text, one line per step, with the time to the millisecond.

## From the terminal

```bash
vesk live            # the same view, redrawn every second
vesk live --once     # print it once and exit
vesk live --json     # the view as JSON
```

`vesk live` reads your agent's state file, so it works on the machine the agent runs on whether `vesk summon` is in the foreground or running under systemd, pm2 or Docker.

## Settings

| Setting | Does |
|---|---|
| Settings → Performance | Low resource polls every 3 seconds instead of every second and turns the motion off. Reduced motion in your system turns the motion off too |

The decision log's filter and whether the raw stream is open are remembered in this browser.

## Limits and what's approximate

- The agent keeps the last 300 steps and sends the panel what's new with each report (about every 2 seconds, up to 200 at a time); the server keeps the last 200. Live is a window, not the full history: the full record is in **Logs**.
- **Landed in N ms** is measured by the agent from sending to the confirmed answer. A paper agent shows "paper · landed" for what it would have done; nothing is signed.
- Hosted agents and agents older than v19 don't send pipeline steps yet; Live then reads their activity log instead (a signal is Watch, a skip or a guardrail refusal is Check, a buy is Execute), which has less detail and no per-step timing.
- The server also broadcasts new steps on a private realtime channel, but the panel reads them by polling for now.
- Filtered candidates come from your rules' audits and the guardrails. A coin a rule doesn't apply to at all ("not a launch rule", someone you don't watch) isn't a candidate and doesn't show. Audit refusals are shown at most once every 1.5 seconds per rule so a flood of new pairs can't drown the page; every buy and every guardrail refusal is shown.
- In the offline preview the stream is simulated and labelled **Sample data**. Its reasons are produced by the agent's own audit, buy-decision and guardrail code on sample coins; the coins, timings and results are made up.
