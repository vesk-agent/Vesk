# Coin page, orders and callouts

The panel's coin page (`/app/coin/<mint>`) is one dense screen per coin: a header bar, a chart you can grab and zoom, tabs underneath, and a trade panel on the right. Everything here also works from the CLI (`vesk order …`), and every fill goes through the same limits and guardrails as any other trade.

Memecoins are extremely risky. Nothing on this page is advice, and no order type makes a trade safer than its coin.

## In the panel

### Header bar

Image, ticker and name, copy contract address, the coin's own links (X, website, Telegram), search the contract on X, age and tax per trade. Then the market numbers: **market cap** in large type (what follows the point is dimmed, and its digits roll when it changes) with its change under it, over 24 hours, or since the first loaded candle when the coin is younger (the line says how long); then price, liquidity, supply, global fees, bonding curve % (or "migrated") and ATH. Star, alerts, PnL card and trading settings sit on the right.

Where the numbers come from:

| Number | Source |
|---|---|
| Market cap, price, liquidity, curve % | Your RPC (pump.fun bonding curve or the pool) |
| Supply, holders | Your RPC (`getTokenLargestAccounts`, merged by owner) |
| ATH | The highest candle loaded for the page (not a lifetime high) |
| Global fees | An **estimate**: the loaded trades' volume × the coin's trading fee (protocol + creator). Priority fees and Jito tips aren't in public trade data, so they're not in it. Marked ≈ |
| Tax | Published venue fees (pump.fun curve, PumpSwap) plus any Token-2022 transfer fee read from the mint |

### Chart

Vesk draws the chart itself (an in-house canvas engine in the site's `src/chart/`). It doesn't use TradingView.

- **Wheel** (or pinch) zooms at the pointer. **Drag** pans back through history.
- **Drag the price axis** up or down to stretch or squash the candles. **Drag the time axis** to scale horizontally. **Double-click** an axis to reset it.
- Keyboard on the focused chart: ← → pan, + − zoom, Home jumps to the first candle, End back to now.
- Crosshair with O / H / L / C and volume at the top-left, the last price as a dashed line with a light **Now** tag on the axis ("Now $38.9K"), a volume histogram.
- Your take-profit targets and stop are dashed lines with small outlined tags on the price axis: **TP** in green, **Stop** in red.
- **Range** under the chart: **1H, 24H, 1W, 1M, All** show that much of the latest candles at the interval you picked. When the coin is younger than the range, it shows all of it and says so ("GLINT has 3h of candles: showing all of it").
- **Candles or line**: the two buttons at the right of the range row. The line is one smooth curve through the closes (it never overshoots a real high or low) with a soft area under it, green when the visible move is up and red when it's down. Markers, hover cards and every interaction work the same in both.
- Intervals: 1s, 5s, 15s, 1m, 5m, 15m, 1h, 4h, 1d. Second candles are built from the trades the page has loaded.
- Toolbar: Display (which markers), Hide all markers, First candle, Alerts (market cap or price, in this browser), USD / SOL, Market cap / Price, screenshot (PNG), fullscreen. At the bottom: % scale, log scale, auto scale.

#### Trade markers

A circle sits directly above the candle that contains a buy, or below the candle that contains a sell, at every interval.

| Marker | Meaning |
|---|---|
| **B** / **S** | Your buys and sells (white letter on green / red) |
| **DB** / **DS** | The dev wallet buying or selling (same colours, with a ring) |
| **T** | A wallet from your address book (tracked) |
| **C** | A holder's callout |

Several trades of the same kind in one candle become one marker with a count. Hover a marker for a card with the wallet (picture, name, role), the side and amount, the market cap and price at the trade, how long ago, and the transaction; on a **DS** marker it also says what share of the dev's holdings that sell moved (from the trades loaded for the coin). The card sits beside the marker, or above or below the candle near an edge, always inside the chart and never over the marker, the price axis or the price readout.

### Tabs under the chart

Drag the bar between the chart and the tabs to resize them.

- **Trades**: the loaded public trades, filtered by All / Mine / Tracked / Dev and a minimum size in SOL.
- **Positions**: what each of your wallets holds (by name: Main, Wallet 1… or yours, renamed with the pencil), sell 25 / 50 / 100%, the exit ladder, and for coins you launched: creator fees, burn, send.
- **Orders**: every open order on this coin (limit, stop-loss, trailing, DCA, TWAP, dev-sell, migration), with progress. Cancel any of them.
- **Holders**: % of supply. The pool is named; every other holder is a wallet with its icons (below). Your wallets and the dev are listed under the largest accounts when they hold less.
- **Top traders**: realized PnL per wallet on average cost, from the trades loaded. It says "partial" when a wallet sold more than we saw it buy.
- **Early buyers**: the first buyers in order, what they paid, their icons, and a status gauge: full for **Holding**, half for **Sold part**, empty for **Sold all**.
- **Dev tokens**: other coins the dev wallet created. Hosted: pump.fun's coin list for that wallet (an unofficial endpoint; when it doesn't answer, the tab says so) plus the creates Pulse saw in your tab. Market cap and migrated come from that list; ATH only when a source gives it.
- **Callouts**: see below.

The bottom bar shows whether the coin's DexScreener profile is paid ("DEX paid" / "Not paid").

#### View a trader

Click the **eye** on a row in Holders, Top traders, Early buyers or Trades to follow that wallet:

- Its buys and sells appear on the chart as ringed markers in the wallet's colour, stacked per candle.
- Trades shows only that wallet's trades. **Show all** stops viewing and brings every trade back.
- A strip above the chart sums up its first buy, last sell, SOL in and out, average entry (as a market cap), realized PnL and what it still holds. All of these come from the trades loaded for this coin; "partial" means it sold more than we saw it buy.

You can view up to three wallets at once, each in its own colour. A fourth replaces the oldest. **Esc** or **Clear** stops viewing.

#### Wallet icons, labels and images

Every wallet in Trades, Holders, Top traders and Early buyers carries small icons (You, Dev, Team, Tracked, Sniper, Bundled, Insider; hover, focus or tap one for what it means and how it's worked out) and shows its name and picture from your address book. **What do these mean?** next to the tabs lists the icons. The pencil on a row opens **Edit wallet** (label, colour tag, image, notes, Track). See [Wallet names, labels and icons](30-wallet-labels.md).

### Race for the post

A coin launched from a post shows its race report under the tabs: every coin created for the same post or topic on one time line from the post, and where this one landed (*1st of 14 · 1.7 s after the post*), counting what Vesk's create stream saw. See [Launch on posts](05-launch-on-post.md#race-reports).

### Trade panel

Top to bottom: 5-minute volume, buys, sells and net volume; Buy | Sell; **Market | Limit | Adv.**; a one-line fee summary (slippage · priority · bribe · MEV); the button (for a market trade, full width and solid green to buy or red to sell; it says *Processing* while the trade runs, then a small chip floats above it, "Bought 0.25 SOL of $GLINT ✓"; orders use the ice button); what you bought, sold, hold and your PnL; **Fees & MEV**, one row with the active preset and a summary (closed by default, and it remembers if you open it): open it for P1/P2/P3 with buy and sell settings (slippage, priority, bribe, the Jito tip floor, auto fee with a cap, MEV off / reduced / secure) and which RPC is used, with a link to Connections; token info; reused images.

| Tab | Buy | Sell |
|---|---|---|
| Market | Amount in SOL, quick chips | % of your holding |
| Limit | Amount and a target market cap or price (slider −100%…+100% from now) | % at a target |
| Adv. | **Migration** (buy when it migrates), **Dev sell** (buy X SOL the moment the dev wallet sells), **DCA** (total, slices, interval, optional min / max market cap), **TWAP** (total over a duration, even or custom slices) | **Migration**, **Dev sell**, **Trailing** (sell when it falls N% below the high since you placed it), **Stop-loss**, **DCA**, **TWAP** |

Orders run on your agent: a self-hosted agent gets them within seconds (and keeps them in its state); hosted accounts run them on the hosted tick (so they're as fast as your cron interval). Price orders are checked every 2 s on the agent. Dev-sell orders watch the coin's live trades. A DCA outside its market-cap band waits; it doesn't skip slices.

What an order can't do: buy from several wallets, split a buy across wallets, or trade against yourself. One wallet buys a coin, as everywhere in Vesk.

### Token info and reused images

- **Tax**: protocol fee + creator fee (+ LP fee after migration) + any Token-2022 transfer fee = total, with a "?" explaining each part.
- Tiles: top 10 holders %, dev holding, snipers, insiders, bundlers, LP burned, holders, pro traders and DEX paid. A number we can't compute from public data shows "–" with "not available" (pro traders always do: there's no verifiable way to label a wallet "pro").
- The contract address and the dev wallet, with copy, search on X, view dev tokens and track.
- **Reused image tokens**: other coins with exactly the same image URL (not a visual match). Hosted: the coins Pulse has seen in your tab. Click a thumbnail to enlarge it and open that coin.

## From the terminal

```bash
vesk order buy   <mint> <sol> --below <price> | --mcap 50k        # limit buy
vesk order sell  <mint> <pct> --above <price> | --mcap 250k       # limit sell
vesk order stop  <mint> <pct> --below <price> | --mcap 20k        # stop-loss
vesk order trail <mint> <pct> --trail 25                          # trailing stop, 25% below the high
vesk order dca   <mint> <sol> --every 2 --times 5                 # or --every-sec 30, --total 1 --slices 5,
                                                                   #    --min-mcap 20k --max-mcap 80k
vesk order twap  <mint> <total sol> --over 30m --slices 6         # or --weights 50,30,20
vesk order dev-sell <mint> <sol> --dev <wallet> [--min 0.5]       # buy when the dev sells at least 0.5 SOL
vesk orders [list | cancel <id>] [--json]
```

Every order takes `--preset p1|p2|p3` and `--slippage <pct>`; `--side sell` turns DCA, TWAP and dev-sell into sells (the amount is then a %).

## Settings

| Setting | Where | Notes |
|---|---|---|
| Markers shown | Chart → Display | Yours (B / S), dev (DB / DS), tracked (T), callouts (C), viewed wallets; **Hide all** hides every marker |
| USD / SOL, Market cap / Price | Chart toolbar | Units and what the price axis shows |
| % / log / auto scale | Under the chart | Auto scale turns off when you drag the price axis; double-click it to reset |
| Alerts | Chart → Alerts | Market cap or price, above or below; kept and fired in this browser |
| Interval | Chart toolbar | 1s … 1d, remembered |
| Range | Under the chart | 1H, 24H, 1W, 1M, All: how much of the latest candles to show (not remembered) |
| Candles / line | Under the chart, right | Remembered with the chart's other choices |
| Presets P1-P3 | Trade panel | Slippage, priority, bribe, auto fee, MEV, RPC ([Trading settings](21-trading-settings.md)) |
| My buys / My sells | Settings → Appearance | Your markers on every coin chart |

The layout (interval, tab, the chart / tabs split) is remembered in this browser.

## Callouts

A callout is a short plain-text note from someone who holds the coin. It shows as a **C** marker on the chart (hover for the text and author) and in the Callouts tab.

- **Holders only.** When you post, the server adds up the coin in your wallets (hosted wallet, imported wallets and wallets you linked by signing) and needs at least **$100** of it at the current price. The panel never decides this.
- **Plain text**, up to 140 characters. No links, no contract or wallet addresses; invisible characters are stripped.
- **Rate limits**: one callout per coin every 10 minutes, at most 6 an hour per person, at most 30 an hour per coin.
- **Flags**: anyone can flag a callout (not their own). Three flags hide it.

Each card shows:

- the author, with what they held when they posted;
- when they posted, and the market cap then;
- how far the coin has moved since.

You can report a card with the flag. Hover a **C** marker on the chart to see the same card. The composer shows your holder-check status and a character count. Below the minimum it stays locked and says how much you hold.

Callouts are opinions, not advice, and nobody checks them for accuracy. Paying for, trading or coordinating callouts falls under the [guardrails](14-guardrails.md) like any other engagement.

## Limits and what's approximate

- **Built from what's loaded.** Second candles, Top traders, Early buyers and View a trader use the trades the page has loaded; if those start after launch, the page says so.
- **ATH** is the highest loaded candle, not a lifetime high. **Global fees** is an estimate (≈): loaded volume × the coin's trading fee, without priority fees and tips.
- **Holders** are the largest accounts from your RPC, merged by owner, with your wallets and the dev added when they hold less.
- **Insider and exact Bundled icons** need funding sources from your RPC; without them Bundled is an upper bound (≈) and Insider isn't shown.
- **Dev tokens** use pump.fun's coin list for the wallet, an unofficial endpoint; when it doesn't answer, the tab says so.
- **Alerts fire in this browser**, while the page is open.
- **Hosted orders run on the hosted tick**, so they're as fast as your cron interval; a self-hosted agent checks price orders every 2 s.
- **Pro traders** always show "–": there's no verifiable way to label a wallet "pro".
