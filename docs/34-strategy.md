# Strategy & safety

Strategy & safety is how your agent picks new coins, what it refuses, how much it buys and how it gets out, plus the hard limits nothing can cross. It has six groups: **Entry** (the early-volume trigger, market-cap, liquidity and age bounds, the buy size, scale-in), **Rug check** (holder and authority checks, each switchable), **Honeypot** (the can-sell check), **Exits** (take-profit ladder, stop-loss, trailing, timed and no-volume sells), **Hard limits** (enforced on every buy in every mode) and **Rogue mode** (one hyped launch, many copies).

Every value is described once in the agent's code (`core/strategy/fields.ts`). The panel's rows, its search and every "?", `vesk strategy explain` and the table at the end of this page all come from that list.

## What applies where

- **Hard limits** apply to every buy: rules, copies, orders, Pulse quick buys, manual buys, the strategy and Rogue mode. They're the guardrails' limits (see [Guardrails](14-guardrails.md)).
- **The can-sell check** runs before every buy of a coin that isn't on a pump.fun bonding curve, whoever asked for it. See [Honeypot check](36-honeypot.md).
- **Entry, Rug check and Exits** are the strategy's own: they decide the coins it buys when **Pulse: buy new coins automatically** is on, and the exits its positions carry. Your snipe rules keep their own filters and exits ([Snipe rules](04-snipe-rules.md)).
- **Trading from** (in Entry, and on [Live](33-live.md)) switches each automatic source on or off: **Snipe rules**, **Copy trade**, **Pulse** (the strategy's own buys) and **Launch on post**. A source that's off is refused by the guardrails on every buy it sends, in the agent and the hosted engine alike; manual buys, and copies you click or confirm, never are. Presets don't change these.
- **Rogue mode** skips Entry and the Rug check on purpose, and keeps everything else. See [Rogue mode](35-rogue-mode.md).
- **Each check says where it applies.** The help panel, every "?" and the tab title (on hover) carry an "Applies to" line; the Honeypot tab also shows it on the page. The honeypot one, word for word: "Applies to non-pump.fun launches: other launchpads, AMM pools and Token-2022 coins. pump.fun bonding-curve coins can't be honeypotted (fixed program, no freeze authority or transfer hooks), so this check is skipped for them." The LP check applies to AMM pools (bonding curves have no LP); mint and freeze authority apply to every coin; the fake-pump checks apply to coins the agent watched from creation.

## How a new coin is decided

1. A new coin arrives on the data stream (PumpPortal: pump.fun and the launchpads it carries). Live shows it at **Watch**.
2. **The early-volume trigger** (when on) counts, from the coin's creation, the SOL traded, the buys and the distinct buying wallets. The moment your numbers are reached (all of them, or any one) it moves on. If the window ends first it's filtered with what it reached: "early volume: 1.8 SOL, 6 buys, 5 buyers in 30 s (needs 5 SOL and 15 buys and 10 buyers)".
3. **Check**: the market-cap, liquidity and age bounds, then the rug check (bundled, dev, top 10, snipers, insiders, holders, the dev's earlier coins, the fake-pump checks, authorities, LP). The first failing check is the reason: "bundled 34% (max 20%)", "dev holds 12.0% (max 10%)".
4. **Size**: a fixed amount, or a share of the wallet's balance with a cap.
5. **Execute**: the guardrails and hard limits, the can-sell check, then signing and sending. The position carries the strategy's exits.
6. **Exit**: take-profit ladder, stop-loss, trailing stop, timed sell, and the no-volume exit (checked every second against the stream).

## In the panel

**Setup → Strategy & safety** (it replaces Limits & safety; ⌘K finds it, and "Rogue mode" opens its tab).

- **Preset**: Safe, Balanced (the default), Degen or Rogue. A preset fills the groups below; change anything and it says Custom. Your Rogue target is kept when you switch.
- **Search settings** finds a field by its name, its help, its key or a tag ("bundle", "tp", "honeypot") across every group.
- **The tabs**: one ruled list per group, the essentials first and the rest under **Advanced** (it opens by itself when one of its fields has an error; search shows every field). Each row has its "?" (what it does, a typical value, the trade-off); on a wide screen clicking it, or focusing the field, slides in the help panel. Diagrams start small; click one to see it larger with its caption. A field whose switch is off is dimmed, not hidden. Errors show under the row they're about.
- **Allow bundled coins** is off by default. Turned on, one line under it says what it risks.
- **Hard limits** has the kill switch, the spend and exposure limits (including **Max buys per minute**), the withdraw allowlist and the guardrails that are always on.
- **Icons and diagrams.** Each tab and the key rows have a small icon (entry, rug check, honeypot, exits, limits, Rogue, MEV, sources). Sections with a pattern worth seeing have small diagrams, each labelled **example** (made-up numbers, not your data): the early-volume trigger as a timeline with its threshold; bundled supply (one funder fanning out), a dev dump, snipers at block 0 and a fake pump; the take-profit ladder on a price path; selling into a big buy; Rogue mode (copies come in, losers are cut, the leader is kept); parallel lanes.
- **Trading from** also shows the venues the new-coin stream covers (pump.fun, LetsBonk, PumpSwap, Raydium), with their logos once the official files are supplied (see [Launchpads](38-launchpads.md)).
- **Export** downloads the settings as JSON; **Import** loads a file into the draft for you to review. Nothing changes until **Save**; **Discard** goes back.

Saved settings are stored with your account. A paired self-hosted agent picks them up with your rules (about every 10 seconds) and runs them; the hosted agent applies the hard limits and the mint part of the can-sell check to its own buys (see the limits below).

## From the terminal

```bash
vesk strategy                                     # every setting, grouped, with its key
vesk strategy set entry.earlyVolume.minVolSol 5   # set one value (checked against its range)
vesk strategy set rug.maxDevPct off               # switch one check off (or give it a number to turn it on)
vesk strategy set exits.takeProfit "2x50, 4x50"   # a ladder: multiple x sell %
vesk strategy set limits.maxBuysPerMinute 6       # hard limits too
vesk strategy preset safe                         # Safe, Balanced, Degen or Rogue
vesk strategy explain bundled                     # the help for anything matching
vesk strategy export --out strategy.json
vesk strategy import strategy.json
vesk strategy --json
```

Chat works too, and shows the change for you to confirm first: "only buy if it does 5 SOL and 20 buys in the first 30 seconds", "max dev 8%", "allow bundled", "honeypot check off", "sell if no volume for 2 minutes", "max 4 buys per minute", "use the safe preset".

In `vesk.config.yaml` a `strategy:` block sets the same values (partial is fine; the rest take the Balanced defaults). What you set with `vesk strategy`, chat or the panel is saved to `rules.json` and wins over the file.

```yaml
strategy:
  entry:
    autoNewCoins: true
    earlyVolume: { windowSec: 20, minVolSol: 4, minBuys: 12, minBuyers: 8, need: all }
  rug:
    maxBundledPct: { on: true, max: 15 }
  exits:
    stopLossPct: 25
```

## Fake pump

A fake pump is one wallet (or one cluster of wallets funded from the same place) buying a big share of the supply right after creation, so the chart looks like demand, then selling into whoever followed. Two checks in **Rug check → Fake pump**, both configurable and on by default (Safe, Balanced and Degen; Rogue mode skips the rug check):

- **Early concentration**: refuse a coin where one wallet or one cluster bought more than **X%** of the supply in the first **N seconds** (Balanced 15% in 10 s; Safe 10% in 15 s; Degen 25% in 8 s). Net of what it sold back in that window. The reason names it: "one wallet (Pump…1111) bought 28% of supply in the first 2 s (max 15%)".
- **Spike then dump**: refuse a coin where a wallet that bought at least 5% of the supply saw the price rise at least **X%** and then sold at least **Y%** of its buy, all within **N seconds** of creation (defaults 80%, 50%, 60 s). "fake pump: 7xKX…9AsU bought 10% of supply, price +150%, then sold 80% of it in 8 s".

Both read the stream's trades from the coin's creation, so they apply to coins the agent watched from the start; for others they're unknown (and pass unless you refuse unknowns). Clusters come from your RPC when **Read funding through your RPC** is on ([Wallet clustering](37-clustering.md)).

## Sell into big buys

An exit for coins you already hold (**Exits → Sell into big buys**, off by default): when someone else's buy of at least **X SOL** lands on one of them, the agent sells **Y%** of your position (or all of it) right away, as a Jito bundle with a tip, so the sell has a chance to fill at the price their buy just set.

- "Lands" means it's on the PumpPortal trade stream, which carries only executed trades, each with its transaction signature. Nothing acts on a pending transaction. Your sell goes out through your RPC as a Jito bundle.
- **The tip** starts at your floor (default 0.005 SOL) and doubles after a miss, up to your cap (default 0.02 SOL). A cooldown (default 30 s) stops it from firing on every buy in a run.
- **Honest limits: competitive; often fails; you pay the tip even when the price moves.** Landing in the same or the next slot isn't guaranteed; others are trying the same thing.
- **Never front-running or sandwiching.** It only ever sells your own holding after their buy has landed. The guardrails enforce it in the core: an intent triggered by someone else's buy can only be a sell, needs that buy's signature, can't be triggered by one of your own wallets, and nothing buys before or around another trader's transaction ("ahead-of-trade").
- Every attempt is on [Live](33-live.md): "a 7 SOL buy landed on $X", "selling 40% into it · tip 0.004 SOL", then the result or "missed".

## Parallel lanes

The agent runs several things at once (**Hard limits → Parallel lanes**, also on Live's Strategy tab): buys from the strategy, rules, copies and Rogue share **1 to 5 lanes** (default 3), and launches have their own **1 to 3** (default 2). Past that, work waits in a queue (up to 20; more is refused with a reason).

- **Guardrails stay global.** Every buy reserves its SOL before it's checked, so two lanes can't both fit under the daily cap or the position limit: "Daily cap: 1.2 of 2 SOL spent today and 0.6 SOL in flight". One buy per coin at a time: "Another lane is buying this coin right now".
- The hosted engine runs buys one at a time; the setting is saved and used by a self-hosted agent.

## Settings

Every parameter, with its key (for `vesk strategy set` and the config file), its Balanced default and what it does.

<!-- generated by tools/strategy_doc.ts from core/strategy/fields.ts -->

### Entry

Which new coins the agent buys, and how much. Applies to the strategy's own buys (Pulse: buy new coins automatically). Snipe rules and copies keep their own filters.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Pulse: buy new coins automatically | `entry.autoNewCoins` | off | Watch new coins from the data stream (what Pulse shows) and buy the ones that pass every check below. Off: the strategy buys nothing by itself; the can-sell check and the hard limits still apply to every buy. Presets don't change this. Typical: Off until you've watched it in paper mode. |
| Snipe rules | `sources.snipe` | on | Buys from your snipe rules (an X post with a contract address, a new launch that matches a rule). Off: the rules still match and Live shows them, but every buy they send is refused. Presets don't change this. Typical: On. |
| Copy trade | `sources.copy` | on | Automatic copies of the wallets you track. Off: their buys show in the copy feed but aren't copied; a copy you click or confirm still goes through. Presets don't change this. Typical: On. |
| Launch on post | `sources.launchOnPost` | on | Launch-on-post rules (a launch, with its dev buy, when an account you watch posts). Off: matching posts are logged and skipped. Presets don't change this. Typical: On. |
| Early-volume trigger | `entry.earlyVolume.enabled` | on | Wait for proof of interest: buy only once a new coin reaches your volume, buys or buyers inside its first seconds. A coin that doesn't is filtered with the numbers it reached. Typical: On. |
| Within the first | `entry.earlyVolume.windowSec` | 30 s | The window after the coin's creation the trigger counts in (T). Range 3-600 s. Typical: 15 to 60 s. |
| Volume at least | `entry.earlyVolume.minVolSol` | 5 SOL | SOL traded (buys and sells) inside the window (X). 0 means not checked. Range 0-10000 SOL. Typical: 3 to 10 SOL. |
| Buys at least | `entry.earlyVolume.minBuys` | 15 buys | Buy transactions inside the window (N). 0 means not checked. Range 0-100000 buys. Typical: 10 to 30. |
| Unique buyers at least | `entry.earlyVolume.minBuyers` | 10 wallets | Distinct wallets that bought inside the window. Harder to fake than a buy count. 0 means not checked. Range 0-100000 wallets. Typical: 8 to 20. |
| Needs | `entry.earlyVolume.need` | all | Whether every number you set must be reached, or one is enough. Typical: All of them. |
| Min market cap | `entry.minMcapUsd` | $5,000 | Skip coins below this market cap when they're checked. Empty: no minimum. Range 0+. Typical: $5K. |
| Max market cap | `entry.maxMcapUsd` | $60,000 | Skip coins above this market cap when they're checked. Empty: no maximum. Range 0+. Typical: $40K to $150K. |
| Min liquidity | `entry.minLiquiditySol` | 1 SOL | Real SOL in the bonding curve or pool. Empty: no minimum. Range 0+ SOL. Typical: 1 SOL. |
| Max age | `entry.maxAgeSec` | 600 s | Skip coins older than this when they're checked. Empty: any age. Range 1+ s. Typical: 600 s (10 minutes). |
| Size by | `entry.size.mode` | fixed | A fixed amount per buy, or a share of the wallet's SOL balance with a cap. Typical: Fixed. |
| Amount | `entry.size.sol` | 0.1 SOL | SOL per buy when sizing is fixed. Your per-trade max still applies. Range 0.001-1000 SOL. Typical: 0.05 to 0.25 SOL. |
| Share of wallet | `entry.size.pct` | 3 % | When sizing by %: this share of the wallet's SOL balance at the moment of the buy. Range 0.1-100 %. Typical: 2 to 5%. |
| Cap | `entry.size.capSol` | 0.25 SOL | When sizing by %: never more than this per buy. Range 0.001-1000 SOL. Typical: Your per-trade max or less. |
| Scale in | `entry.scaleIn.enabled` | off | Add to a position once it's proving itself: when the price reaches a multiple of your entry, buy a share of the first amount again. Every add passes the guardrails and limits. Typical: Off. |
| Adds | `entry.scaleIn.steps` | 1.3x add 50% | Each add: at this multiple of entry, buy this % of the first buy. Up to three. Typical: At 1.3x add 50%. |

### Rug check

Holder checks. Each one can be switched off. Applies to the strategy's own buys, before they're sent. Rogue mode skips it on purpose.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Rug check | `rug.enabled` | on | Run the holder checks below before a strategy buy. Each check can be switched off on its own. Typical: On. |
| Allow bundled coins | `rug.allowBundled` | off | Off: coins whose creation block was bought together by linked wallets above your limit are refused. On: the bundled check is skipped so you can ride heavily bundled coins. Typical: Off. |
| Max bundled | `rug.maxBundledPct` | 20 % | Supply bought in the creation block by the dev and wallets funded together. Never linked through pools, curves, programs or exchanges. Not used while Allow bundled coins is on. Range 0-100 %. Typical: 10 to 20%. Applies to coins the agent watched from creation. Exact with Read funding through your RPC; without it, an upper bound. |
| Max dev holding | `rug.maxDevPct` | 10 % | The creator's share of supply right now. Range 0-100 %. Typical: 5 to 10%. |
| Max top 10 | `rug.maxTop10Pct` | 30 % | The 10 largest holders' share of supply, curve and pool accounts left out. Range 0-100 %. Typical: 25 to 35%. |
| Max snipers | `rug.maxSnipersPct` | 15 % | Supply held by wallets whose first buy came within 3 s of the create (not the dev). Range 0-100 %. Typical: 10 to 15%. Applies to coins the agent watched from creation (it needs the buys in the first blocks). |
| Max insiders | `rug.maxInsidersPct` | 15 % | Supply held by wallets funded by the dev, the dev's funder, or a funder they share. Needs funding data (read through your RPC). Range 0-100 %. Typical: 10 to 15%. Applies to coins the agent watched from creation, with funding read through your RPC. |
| Min holders | `rug.minHolders` | 15 holders | Wallets holding the coin (curve and pool accounts left out). Range 0-100000 holders. Typical: 15 to 30. |
| Early concentration | `rug.earlyConcentration.on` | on | Refuse a coin when one wallet, or one cluster of wallets funded by the same address, bought more than a set share of the supply in its first seconds. That's how a fake pump starts: a big buy spikes the price so others pile in. Typical: On. Applies to coins the agent watched from creation (the stream's trades since the create). |
| Max bought by one wallet or cluster | `rug.earlyConcentration.maxPct` | 15 % | The largest share of the supply one wallet (or one cluster) may have bought, net of its sells, in the window below. Range 1-100 %. Typical: 10 to 20%. Applies to coins the agent watched from creation. Clusters need funding read through your RPC; without it each wallet counts alone. |
| In the first | `rug.earlyConcentration.windowSec` | 10 s | How many seconds after creation count as early. Range 1-600 s. Typical: 8 to 15 s. |
| Spike then dump | `rug.spikeDump.on` | on | Refuse a coin when a big early buyer pushed the price up and then sold a large part of what it bought, inside the window. It only sees what happened before the check, so it catches the pattern once it's underway. Typical: On. Applies to coins the agent watched from creation, when the dump has already happened by the time of the check. |
| Price up at least | `rug.spikeDump.minSpikePct` | 80 % | How far the price rose from that buyer's first buy before it sold. Range 5-10000 %. Typical: 80%. |
| Then sold at least | `rug.spikeDump.minDumpPct` | 50 % | The share of its own buy that wallet sold back. Range 5-100 %. Typical: 50%. |
| Within | `rug.spikeDump.windowSec` | 60 s | Seconds after creation the pattern is looked for. Range 5-3600 s. Typical: 60 s. |
| Dev's earlier coins | `rug.devHistory.on` | on | Look at the coins this dev made before, as far as this agent has seen them (a lower bound). Typical: On. |
| Max earlier rugs | `rug.devHistory.maxRugs` | 0 rugs | A rug here means the dev sold most (80% or more) of its own supply within 10 minutes of launch. Range 0-1000 rugs. Typical: 0. |
| Max earlier launches | `rug.devHistory.maxLaunches` | 10 launches | Serial launchers make many coins and abandon them. Range 0-100000 launches. Typical: 3 to 10. |
| Mint authority revoked | `rug.mintRevoked` | on | Refuse a coin whose supply can still be increased. Typical: On. pump.fun coins always pass. Applies to every coin. pump.fun mints are created with it already revoked. |
| Freeze authority revoked | `rug.freezeRevoked` | on | Refuse a coin whose issuer can freeze your tokens. Typical: On. pump.fun coins always pass. Applies to every coin. pump.fun mints are created with it already revoked. |
| LP burned or locked | `rug.lpLocked` | on | For coins in an AMM pool: the liquidity tokens are burned or locked, so the pool can't be pulled. Bonding curves have no LP and pass. Typical: On. Applies to AMM pools (coins that migrated or launched straight into a pool). A bonding curve has no LP, so the check passes there. |
| Read funding through your RPC | `rug.enrich` | on | Who funded each early wallet (first SOL transfer), so bundled and insiders are exact. Costs a few hundred ms per coin on your RPC. Typical: On. Applies to every rug check the strategy runs. Costs a few RPC calls per coin. |
| When a number is unknown | `rug.unknown` | pass | Some numbers need data that isn't there yet (insiders without funding data, holders before your RPC answers). Typical: Let it pass. Safe preset: refuse. |

### Honeypot

Before buying a coin that isn't on pump.fun: can it be sold? Applies to non-pump.fun launches: other launchpads, AMM pools and Token-2022 coins. pump.fun bonding-curve coins can't be honeypotted (fixed program, no freeze authority or transfer hooks), so this check is skipped for them.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Can-sell check | `honeypot.enabled` | on | Before buying a coin that isn't a pump.fun coin (another launchpad, an AMM, Token-2022), check the mint's extensions and simulate a sell. Refused coins show why. Typical: On. |
| Simulate a sell | `honeypot.simulate` | on | Build a Jupiter sell for a current holder and run it through your RPC's simulateTransaction (signatures not checked, nothing is sent). A coin no route or simulation can sell is refused. Typical: On. |
| Max transfer tax | `honeypot.maxTaxPct` | 5 % | Token-2022 coins can charge a fee on every transfer, buys and sells included. Refused above this. Range 0-100 %. Typical: 1 to 5%. |
| Refuse a transfer hook | `honeypot.refuseTransferHook` | on | A transfer hook runs the issuer's program on every transfer and can block sells. Typical: On. |
| Refuse a permanent delegate | `honeypot.refusePermanentDelegate` | on | A permanent delegate can move or burn tokens in any wallet, yours included. Typical: On. |
| Refuse non-transferable | `honeypot.refuseNonTransferable` | on | Non-transferable tokens can't be sent or sold at all. Typical: On. |
| Refuse default-frozen | `honeypot.refuseDefaultFrozen` | on | New token accounts start frozen; only the issuer can thaw yours. Typical: On. |
| Refuse a freeze authority | `honeypot.refuseFreezeAuthority` | on | The issuer can freeze any holder's tokens later. Classic SPL tokens can have one too. Typical: On. |

### Exits

How positions get sold. Applies to positions the strategy opens. Snipe-rule and copy positions keep their own exits.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Take-profit ladder | `exits.takeProfit` | 2x sell 50%, 4x sell 50% | At each multiple of your entry, sell this % of what's left. Steps go up. Typical: 2x sell 50%, 4x sell 50%. |
| Stop-loss | `exits.stopLossPct` | 30 % | Sell everything when the price falls this far below your entry. Empty: off. Range 1-99 %. Typical: 20 to 35%. |
| Trailing stop | `exits.trailingStopPct` | 25 % | Sell everything when the price falls this far from the highest price since you bought (only once it's above entry). Empty: off. Range 1-99 %. Typical: 15 to 30%. |
| Timed sell | `exits.timeoutMin` | 60 min | Sell everything this many minutes after the buy, whatever the price. Empty: off. Range 1+ min. Typical: 30 to 120 min. |
| No-volume exit | `exits.noVolume.enabled` | on | Sell when the coin goes quiet: less than your volume over the last seconds. Dead coins rarely come back. Typical: On. |
| Over the last | `exits.noVolume.windowSec` | 120 s | The window the volume is measured over (N). Range 5-3600 s. Typical: 60 to 180 s. |
| Volume below | `exits.noVolume.minVolSol` | 0.5 SOL | Sell when less than this traded in the window (X). Range 0-10000 SOL. Typical: 0.3 to 1 SOL. |
| Sell into big buys | `exits.sellIntoBuys.enabled` | off | When someone else's buy of at least the size below lands on a coin you hold, sell part of your position straight away in a Jito bundle with a tip, at the higher price the buy left behind. Only your own position, only after their buy has landed: Vesk never trades ahead of or around another trader's transaction. Typical: Off. Try it in paper mode first. Applies to every coin this agent holds, on the venues the PumpPortal stream carries (pump.fun, PumpSwap and the launchpads it covers). Needs a Jito block engine. |
| Their buy at least | `exits.sellIntoBuys.minBuySol` | 5 SOL | Only buys this big trigger a sell. Range 0.1-100000 SOL. Typical: 3 to 10 SOL on pump.fun. |
| Sell | `exits.sellIntoBuys.sellPct` | 50 % | The share of your position sold each time. Range 1-100 %. Typical: 25 to 50%. |
| Tip | `exits.sellIntoBuys.tipSol` | 0.005 SOL | The Jito tip on the first try. After a miss the next try doubles it, up to the cap. Range 0.0001-1 SOL. Typical: 0.003 to 0.01 SOL. |
| Tip cap | `exits.sellIntoBuys.maxTipSol` | 0.02 SOL | The most it will ever tip for one sell. Range 0.0001-5 SOL. Typical: 0.02 SOL. |
| One try per coin every | `exits.sellIntoBuys.cooldownSec` | 30 s | So a run of big buys doesn't sell the whole position in seconds. Range 1-3600 s. Typical: 30 s. |

### Hard limits

Enforced on every buy, in every mode. Applies to every buy, in every mode and from every source, manual buys included.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Max per trade | `limits.perTradeMaxSol` | 0.5 SOL | No single buy can be larger, in any mode. Range 0.001+ SOL. Typical: 0.25 to 0.5 SOL. |
| Max per day | `limits.dailySpendCapSol` | 2 SOL | Total SOL spent on buys per UTC day, in any mode. Range 0.001+ SOL. Typical: 1 to 3 SOL. |
| Keep in the wallet | `limits.minSolReserve` | 0.02 SOL | Never let a buy take the wallet below this (fees, rent). Range 0+ SOL. Typical: 0.02 SOL. |
| Max open positions | `limits.maxOpenPositions` | 8 positions | No new coin is bought while this many are open. Range 1-100 positions. Typical: 5 to 10. |
| Max buys per minute | `limits.maxBuysPerMinute` | 10 per min | A ceiling on buys in any 60 seconds, across every source. Stops a runaway loop. Range 1-120 per min. Typical: 6. Raise it for Rogue sessions with many coins. |
| Max buys per day | `limits.maxBuysPerDay` | 20 per day | Agent-wide buys per UTC day across every rule and the strategy. Range 1+ per day. Typical: 20. |
| Parallel lanes | `concurrency.lanes` | 3 lanes | How many buys the agent works on at the same time. More wait in a queue, in order. Every limit still applies across all lanes: spend, buys per minute, open positions, one buy per coin. Range 1-5 lanes. Typical: 3. Applies to every buy the agent sends: snipe rules, copies, the strategy and Rogue mode. Sells never wait. |
| Launches at once | `concurrency.launches` | 2 launches | Launches have their own lanes, so a launch never waits behind buys (or the other way round). Range 1-3 launches. Typical: 1 or 2. Applies to launches from the panel and launch-on-post rules. |
| Kill switch | `limits.killSwitch` | off | Stops every buy at once. Sells and withdrawals still work so you can get out. Typical: Off. Also in the top bar. |

### Rogue mode

One hyped launch, many copies: buy every match small, cut the losers. Applies only while a Rogue session runs.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Ticker | `rogue.ticker` |  | The ticker to chase, without $. Every new coin with exactly this ticker matches. Typical: The hyped ticker. |
| Name keywords | `rogue.keywords` | none | A new coin whose name contains any of these matches too. Comma-separated. Typical: One or two words from the name. |
| Expected creator | `rogue.expectedCreator` |  | Optional. The wallet you expect the real coin from. Its coin is never sold for lagging (the stop-loss still applies). Typical: Empty unless you know it. |
| Expected X account | `rogue.expectedX` |  | Optional. A coin whose metadata links this account counts as expected too. Typical: Empty unless you know it. |
| Window | `rogue.windowMin` | 10 min | How long the session buys new matches. Exits keep running after it ends. Range 1-240 min. Typical: 5 to 15 min. |
| Max coins | `rogue.maxCoins` | 10 coins | At most this many coins are bought in the session. Range 1-50 coins. Typical: 5 to 10. |
| Per coin | `rogue.perCoinSol` | 0.05 SOL | One small buy per matching coin. Your per-trade max still applies. Range 0.001+ SOL. Typical: 0.02 to 0.1 SOL. |
| Session budget | `rogue.budgetSol` | 0.5 SOL | The most the session can spend in total. Enforced by the guardrails, with your daily cap on top. Range 0.001+ SOL. Typical: 0.5 to 2 SOL. |
| Stalled after | `rogue.stallSec` | 20 s | A coin is stalled when it trades less than the volume below in this many seconds. Stalled coins are sold. Range 3-3600 s. Typical: 15 to 30 s. |
| Stalled below | `rogue.stallMinVolSol` | 0.3 SOL | The volume a coin needs over the stall window to keep it. Range 0+ SOL. Typical: 0.3 SOL. |
| Stop-loss | `rogue.stopLossPct` | 35 % | Sell a coin that falls this far below its entry. Range 1-99 %. Typical: 30 to 40%. |
| Leaders after | `rogue.leaderAfterSec` | 90 s | After this long, coins that aren't among the leaders by market cap are sold. 0: off. Range 0-3600 s. Typical: 60 to 120 s. |
| Keep the top | `rogue.keepTop` | 2 | How many leaders by market cap to keep once the leader time has passed. Typical: 2. |
| Can-sell check in Rogue mode | `rogue.honeypot` | on | Fakes of a hyped launch are where honeypots live. On by default; switching it off asks twice. Typical: On. |

<!-- end generated -->

### Presets

| Preset | In short |
|---|---|
| Safe | Strict holder checks (bundled 10%, dev 5%, top 10 25%, 30 holders, unknowns refused), a 45 s trigger at 8 SOL / 25 buys / 18 buyers, 0.05 SOL, a quick stop |
| Balanced | The defaults above |
| Degen | Looser checks, a 15 s trigger at 2 SOL / 8 buys / 6 buyers (any one), 5% of the wallet capped at 0.5 SOL, wider stops. Expect more losers |
| Rogue | The exits Rogue mode uses; start a session from the Rogue mode tab or `vesk rogue start` |

## Limits and what's approximate

- The strategy buys new coins only on a self-hosted agent: it needs the live data stream (a websocket). The hosted agent applies the hard limits and the mint part of the can-sell check to its buys.
- Numbers come from the stream since the agent started watching a coin, plus your RPC when **Read funding through your RPC** is on. Holders, top 10 and insiders need the RPC; without it they're the stream's view, and bundled is an upper bound. See [Wallet clustering](37-clustering.md) and [Data sources](26-data-sources.md).
- **Dev history** counts the coins this agent has seen the dev make and rug since it started (a lower bound). A rug here means the dev sold at least 80% of its creation buy within 10 minutes.
- **LP burned or locked** can't be read for most AMM pools yet, so it's unknown there (and passes unless you refuse unknowns). Bonding curves have no LP and pass.
- A busy stream misses most coins at the early-volume trigger; Live shows one such miss every 1.5 seconds, not all of them.
- Fake pump, sell into big buys and parallel lanes are tested against local mocks (the e2e suite) and in unit tests; they haven't run against live markets. Sell into big buys is competitive and often misses.
- The no-volume exit and scale-in read the stream's trades for coins the strategy bought. If the agent restarts, it picks them up again from new trades only.
