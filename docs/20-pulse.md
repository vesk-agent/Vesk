# Pulse

Pulse is a live board of new coins in three columns:

| Column | What lands there |
|---|---|
| **New pairs** | Coins created since the board started, still on their bonding curve below 80%. |
| **Final stretch** | Bonding curve at 80% or more, not migrated yet. |
| **Migrated** | Coins that left the curve for a DEX pool. |

In the panel the data comes straight from PumpPortal's public data websocket (`wss://pumpportal.fun/api/data`) into your browser. The agent uses the same stream (`vesk pulse`, see [CLI](16-cli.md)). The reducer, audits and filters are one shared module (`core/watch/pulse.ts`, `core/watch/audits.ts`), with unit tests, so the panel and the agent agree on every number.

Coins on Pulse are not vetted. Most go to zero. Audits help you see hidden supply; they don't make a coin safe.

Every part of the board is configurable in Settings: column order, list or grid, what each row shows, metric colours, hover previews, the quick-buy button, themes and the performance profile. See [Pulse settings](22-pulse-settings.md). Where each number comes from is in [Data sources](26-data-sources.md).

## In the panel

**Agent → Pulse**. The toolbar has the trading-wallet picker, **Display** (the most-used display switches), the blacklist and Settings. Hover an audit value (Snp, Ins, Bnd, Dev) for what it counts, with the same icon and rule text as the coin page's [wallet icons](30-wallet-labels.md#wallet-icons).

### Each column

- **Gear**: that column's filters (below). A number on the gear shows how many filters are on.
- **Quick-buy amount** and **P1/P2/P3**: what the lightning button on each row buys, with which [trading preset](21-trading-settings.md).
- **Bell**: a short chime when a new coin passes the column's filter. Off by default.
- **Pause on hover**: while your pointer is over a column, its rows stop moving (a *Paused* label shows). New data keeps arriving and shows when you move away.
- **shown/total**: coins passing the filter / coins in the column.

Rows: avatar with a ring that fills with the bonding curve, ticker, name, age, socials, a "search the contract on X" link, copy CA. Under that, the audit strip (holders, top 10, dev, snipers, insiders, bundled). Values stay muted unless they cross your warning thresholds (Display). On the right: **MC** market cap, **V** volume, **TX** transactions, **F** fees. Hovering a row shows hide coin, hide every coin by this dev, and track the dev wallet (added to your address book as "Dev of $TICKER" with an amber tag and Track on; its name and image then show on the **tracked dev** tag of every coin it creates). Click a row to open its [coin page](28-coin-page.md). With your pointer on a row, **B** quick-buys it.

**Display** opens a small panel with the most-used choices as tiles that preview themselves: row spacing, metric size, the coin image's size and progress, rounded market caps and ticker first, with the rarer ones (show hidden, unhide on migrated, image shape, volume) under **Advanced (optional)**. Everything else, including which audit values show and the warning thresholds, is in [Pulse settings](22-pulse-settings.md).

### Quick buy

The lightning button, and **B** on a hovered row, buys the column's amount with the column's preset:

1. Your **trading wallet** (Trading settings), else your main wallet. Buys always come from one wallet. Buying the same coin from several of your wallets is refused.
2. If the amount is above your **confirmation threshold**, you're asked first.
3. The trade goes to your hosted wallet or your paired agent, and from there through **every guardrail and limit**: per-trade max, daily cap, kill switch, one wallet per coin.

With a preset whose MEV mode is Reduced or Secure, the buy is sent as a Jito bundle only. See [Trading settings](21-trading-settings.md).

The end-to-end test `Pulse: a column filter matches a new coin, quick buy with P2 lands as a Jito bundle only` runs this path against a mock PumpPortal stream, a mock RPC and a mock Jito block engine.

## From the terminal

```bash
vesk pulse                                            # the live board in your terminal
vesk pulse --column final --filter f.json             # one column, your filter (a panel export works)
vesk pulse --filter f.json --buy 0.1 --preset p2 --max 1 --for 60   # auto-buy matches, at most 1, for 60 s
vesk pulse --pools all                                # new pools on other launchpads too (see Data sources)
```

Auto-buys from the terminal go through the same trading wallet, preset, limits and guardrails as the panel's quick buy.

## Settings

Each column has its own filters; the board's look (layout, row elements, colours, quick-buy button, performance) is in [Pulse settings](22-pulse-settings.md).

### Filters

Each column has its own filters with **Reset** and **Apply**. They're saved to your account (and in your browser for instant reloads), and a paired agent pulls them with your rules. **Export** downloads JSON; **Import** takes a full export or a single filter such as `{"audits":{"devPct":{"max":10}}}`. While you edit, the drawer shows how many coins each filter hides right now.

- **Launchpads**: pump.fun, LetsBonk, Bags, Meteora DBC, Moonshot, Raydium LaunchLab, others. Only launchpads the data source delivers can be picked; the rest show *not in feed*. PumpPortal's stream carries pump.fun and LetsBonk (its `pool` field); if it starts sending another launchpad, Pulse enables it as soon as one shows up.
- **Search / exclude keywords**: matched against name, ticker and contract address, case-insensitive.
- **Audits** (min/max): dev %, top 10 %, snipers %, insiders %, bundled %, holders, dev's previous launches and migrated coins.
- **Metrics** (min/max): age, market cap, liquidity, volume, transactions, buys, sells, bonding curve %, fees paid.
- **Socials**: has X, website, Telegram, at least one; exclude reused X links.
- **CA ends in "pump"**.
- **Hide unknown audits**: an audit that isn't known yet (insiders need RPC data) passes by default. Turn this on to hide those coins instead.

"Pro traders" isn't in the list on purpose: there is no public, checkable definition of one, so Pulse doesn't invent a number.

## How each number is computed

Everything from the stream is counted **since the board started watching the coin**. A coin created before you opened Pulse starts with only what PumpPortal sends from then on. Supply is 1 billion tokens.

| Number | How | Where it's approximate |
|---|---|---|
| **Holders** | Wallets with a balance above 0, from the trade stream. With RPC data: every token account of the mint with a non-zero amount (`getProgramAccounts` on the mint's token program, owner and amount only, bonding curve removed). | Stream-only it counts wallets seen trading. Some RPCs refuse `getProgramAccounts`; then the stream count stays. |
| **Dev %** | The creator's current balance / supply. The create message carries the dev's initial buy; later trades update it. | If the dev moved tokens to another wallet without trading, the stream doesn't see it. Insiders and bundled catch some of that. |
| **Top 10 %** | The 10 largest balances / supply. With RPC data: `getTokenLargestAccounts`, owners resolved with `getMultipleAccounts`, the bonding curve (and pool) account removed. | Stream-only, a lower bound (only wallets seen trading). |
| **Snipers %** | Current balance of wallets (not the dev) whose first buy came within 3 seconds of the create. | Uses message times, not slots. |
| **Bundled %** | Tokens bought in the creation block by the dev and by wallets funded together: the same funding source as the dev, funded by the dev, or sharing a funder with another creation-block buyer. "Creation block" means the same slot when known, otherwise within 600 ms of the create. | Without funding data it counts every creation-block buy (an upper bound). |
| **Insiders %** | Current balance of holders (not the dev) funded by the dev, by the dev's own funder, or sharing a funder with another holder. | Needs funding data, so it's "–" until your RPC answers. Funding sources below. |
| **Dev launches / migrated** | Coins by the same creator that this board has seen, and how many of them migrated. | A lower bound: only what Pulse saw. |
| **F (fees)** | Volume × 1.25% (`PULSE_FEE_RATE`). | An estimate from the launchpad's published fee schedule at the time of writing. Change it if your launchpad charges differently. |
| **Bonding curve %** | (SOL in the curve − 30) / (115 − 30), from `vSolInBondingCurve`. | pump.fun's curve constants. Other launchpads differ. |
| **Liquidity** | Real SOL in the curve (virtual SOL minus the 30 SOL start). | Same constants. |

**Funding source** of a wallet: the sender of the oldest SOL transfer among its 25 most recent signatures (`getSignaturesForAddress`, then `getTransaction`). Pools, bonding curves, known programs, program-owned accounts and labelled exchange hot wallets never count as a funder or a link, so buyers paid out by the same pool don't look connected ([Wallet clustering](37-clustering.md)). Fresh sniper and insider wallets usually have only a few transactions, so this is their funding transfer. For old, busy wallets it's only the oldest transfer on that page, so treat it as a hint.

**Where RPC data comes from.** In the panel, the coins at the top of each column are enriched through **your** RPC by the hosted edge function (`pulse-enrich`): at most 3 coins per call, every 4 seconds, cached 2 minutes per coin, funding looked up for up to 8 wallets (the dev first, then the largest holders). The agent does the same with `vesk pulse` when a filter uses an audit that needs it (holders, top 10, bundled, insiders) or hides unknown audits. Each candidate is enriched and checked again before it's shown or bought, which costs a few hundred milliseconds per coin.

## Limits and what's approximate

- **Coins on Pulse are not vetted.** Most go to zero. Audits help you see hidden supply; they don't make a coin safe.
- **Counted since the board started watching.** A coin created before you opened Pulse starts with only what the stream sends from then on.
- **Some numbers are estimates**, as the table above says: fees (volume × 1.25%), the bonding curve and liquidity (pump.fun's constants), and funding sources (a hint for busy wallets).
- **Insiders need your RPC.** Until it answers they show "–", and **Hide unknown audits** decides whether those coins pass.
- **In the preview** the offline preview has no network, so Pulse runs a **sample feed** (invented coins, labelled *Sample data*) through the same reducer, audits and filters.
