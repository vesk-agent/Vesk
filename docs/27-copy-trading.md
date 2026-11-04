# Copy trading

Track as many wallets as you like. When one of them buys, Vesk checks your filters and limits and copies the buy from your one trading wallet, asks you first, or only tells you. When it sells, Vesk can mirror the sell on the position it copied. Every trade it sees lands in the copy feed with what it did and why.

> **How fast is it?** As fast as your setup sees their trade, and never ahead of it. A copy can only start once their transaction is visible, so it lands **after** theirs: in the same slot at best, usually the next few, depending on your RPC and stream. Copy trading can't front-run the wallet you copy. The panel and `vesk copy feed` show detected → landed in ms and how many slots after theirs, measured on your setup.

Memecoins are extremely risky. A wallet's past trades say nothing about its next one. Start with Alert only or Confirm, and small sizes.

<!-- flow: copy "A wallet you track buys; your filters check it; the copy goes out at your size, or it's skipped with the reason." -->

## In the panel

**Agent → Copy trade** opens on **PnL from copies**, large: what your copies made (closed copies, plus open ones at the last price), with its USD value, and beside it the wallets you track, copies today, detected → landed (p50) and the detection sources. Then two tabs.

With no wallets yet, the page opens on **Add your first wallet**: paste one address (and a name if you like), pick a starting template, and how it acts. **Alert only** is the default for a first wallet: you see every trade it makes and what Vesk would have copied, and nothing is spent until you change it. **Paste many or import CSV** opens the full Add wallets dialog.

**Leaderboard** ranks your tracked wallets by what copying them made you, or by win rate (closed copies that made money): each with its picture and name, a bar, the PnL, win rate, closed and open copies and last activity. It's computed from **your own copies**, not from a wallet's whole on-chain history, so a wallet you copy rarely ranks on little data. Click one for its drawer. The offline preview's leaderboard is sample data and says so.

**Wallets and feed**: tracked wallets (picture, label and tag, address, mode, size and max market cap, copies today, PnL from copies, win rate, last activity, on/off), groups, search, bulk edit, CSV / JSON export; the live feed, one sentence per trade ("Night desk bought $GLINT · at $36K MC · 2m", their picture, a bought / sold chip and their SOL on the right) with what Vesk did as a small tag (Copied, Skipped, Failed, Waiting, Alert, Expired, Sold) and the reason in a sentence under the amount, the latency badge and a one-click manual copy of any skipped buy (filters bypassed because you chose it; guardrails still apply); pending copies with Copy / Skip. Click a wallet for its drawer: their recent trades from your RPC with a realized PnL estimate (sells only count against buys seen in that window), what it holds, and every setting with the help rail. Positions and Portfolio tag copied positions "copied from <label>". The pencil on a wallet opens **Edit wallet** for its address-book name, colour tag and picture ([Wallet names, labels and icons](30-wallet-labels.md)); the feed shows the same picture and name.

## From the terminal

```
vesk copy add <address> --label degen --sol 0.2 --max-mcap 300k --tp 2x:50,5x:100 --sl 30 --mode auto
vesk copy list [--group Snipers]
vesk copy show degen
vesk copy edit degen --pct 25 --max-sol 0.3 --sells mirror --max-dev 10
vesk copy edit degen --max-dev off            # switch a default filter off for this wallet
vesk copy on|off degen | all
vesk copy rm degen
vesk copy import wallets.csv [--group KOLs] [--template balanced]
vesk copy export --format csv|json [--out file]
vesk copy defaults [settings…]
vesk copy templates | template conservative <wallet|all>
vesk copy sources pumpportal,rpc[,helius] [--commitment processed]
vesk copy feed [--wallet degen] [--limit 30] [--json]
vesk copy decide <id> copy|skip | manual <feed id> [--sol 0.1]
vesk copy watch [--for 60] [--paper]
```

Settings flags: `--sol | --pct | --mult`, `--min-sol`, `--max-sol`, `--mode`, `--sells`, `--no-buys`, `--max-mcap`, `--min-mcap`, `--min-liq`, `--min-age`, `--max-age`, `--min-buy`, `--max-dev`, `--max-top10`, `--max-bundled`, `--socials`, `--venues`, `--include`, `--exclude`, `--first-only | --every-buy`, `--allow-missing`, `--tp`, `--sl`, `--trail`, `--sell-after 30:100`, `--timeout`, `--max-trade`, `--max-sol-day`, `--max-sol-total`, `--max-open`, `--cooldown`, `--preset`, `--mev`, `--delay`, `--group`, `--tag`, `--note`, `--template`.

## Settings

One **default profile** applies to every wallet. Each wallet can override any field (marked "set here" in the panel; Reset follows the defaults again). A filter you clear on a wallet is off for that wallet even if the default sets it.

### Per wallet

- **Label, colour tag, group, notes, on/off.** Tags avoid green, red and amber (those mean PnL and warnings in Vesk).
- **Import / export**: CSV or JSON; imports also read address-book exports and plain lists of addresses (one per line, optionally with a label).

### Mode

- **Alert only**: you're told, nothing is bought.
- **Confirm**: Copy / Skip buttons in Telegram and the panel; a copy waits 60 s, then expires.
- **Auto copy**: buys as soon as the trade passes your filters and limits.

Mirrored sells run in Confirm and Auto modes without asking (they only reduce a position the copy opened), and they keep running while the agent is paused, like every other exit.

### Size

- **Fixed** SOL per copy, **% of their buy**, or a **multiple of their buy**.
- **Min / max per copy**: the size is clamped to this range, then to your max per trade.

### Sells

- **Mirror %**: they sell 50% of their bag, you sell 50% of the copied position.
- **Sell all**: any sell by them closes yours.
- **Off**: only your exits sell.

Only positions copied from that wallet are touched.

### Entry filters (checked at their buy)

| Filter | Data |
|---|---|
| Skip above / below market cap | PumpPortal's market cap at their trade, or their fill price × the mint's supply (`getTokenSupply`). If neither is known, a snapshot after detection, shown as "(now)" in the reason. |
| Min liquidity | the bonding curve (your RPC) or DexScreener's pool data |
| Token age (min / max) | the coin's oldest transaction (`getSignaturesForAddress`, one page of 1000) |
| Their buy at least | their SOL |
| Max dev holds | the creator (fee payer of the first transaction) and their current balance |
| Max top 10 | `getTokenLargestAccounts` → owners, minus the bonding curve |
| Max bundled | supply bought in the creation slot (the create included), from that slot's transactions |
| Mint / freeze authority revoked | the mint account |
| Require socials | the metadata URI's JSON (Token-2022 metadata extension or Metaplex) |
| Venues | the classified venue |
| First buy only | their pre-trade balance and the feed |
| Name keywords (include / exclude) | the token's name and ticker |
| When data is missing | skip (default) or allow |

Age, dev % and bundled % need the coin's creation in one page of signatures, so for coins with more than 1000 transactions they're unavailable (never guessed). Each fact is fetched only when a filter needs it, in parallel; the market cap from PumpPortal costs nothing.

Skip reasons read like `mcap $412k > max $250k`, `their buy 0.12 SOL < min 0.3 SOL`, `dev holds 22% > max 10%`, `not their first buy of this coin (first buy only)`, `0.5 SOL copied from Night desk today (max 0.5 SOL)`.

### Exits on each copy

Take-profit ladder, stop-loss, trailing stop, timed sells (seconds after the copy lands), market-cap targets: the same exit engine as your rules, checked every 3 s (timed sells to the second).

### Limits

Max SOL per copy, per wallet per day, total per day, max open copied positions, and a cooldown per coin (any wallet). Your agent-wide limits (per-trade max, daily cap, max positions, reserve, kill switch) apply on top.

### Execution

Trading preset (P1 / P2 / P3: slippage, priority fee, Jito tip), an optional MEV override (reduced and secure send as a Jito bundle only), and an optional delay in ms (0 = send as soon as it passes).

### Templates

Conservative, Balanced and Aggressive are starting points: apply one to a wallet or many, then change anything. They're not advice.

## Where it runs

**Self-hosted (recommended).** `vesk summon` watches your tracked wallets 24/7, decides and signs on your machine. Settings saved in the panel reach a paired agent within seconds (or edit them with `vesk copy …`).

**Hosted.** The Vesk relay worker keeps one PumpPortal websocket subscribed to every wallet hosted accounts copy and posts each trade to the edge function, which runs the same decisions. That's one extra hop. Trades PumpPortal doesn't carry (Jupiter routes, Raydium, Meteora, Orca) are found by the cron tick, which polls each tracked wallet's new signatures about once a minute. That fallback is slow: by the time it sees a trade, the price has usually moved. Hosted copies check market cap, liquidity, their size, venue, first buy, limits and the blacklist; holder, dev, age, bundle, socials and name checks need the self-hosted agent (with them set, hosted copies follow your missing-data setting: skip by default).

## How trades are detected

| Source | What it sees | How |
|---|---|---|
| PumpPortal account trades | pump.fun curve, PumpSwap, Bonk | `subscribeAccountTrade` with your wallets on PumpPortal's data websocket. The message already says buy or sell, SOL, tokens, their new balance and the market cap in SOL. Usually the first to arrive for those venues. |
| Your RPC websocket | every venue | `logsSubscribe` with `mentions: [wallet]` (one subscription per wallet; wallets are spread over sockets of 100), then `getTransaction` (jsonParsed, `maxSupportedTransactionVersion: 0`) and Vesk's classifier. One extra request per trade. |
| Helius enhanced websocket (optional) | every venue | `transactionSubscribe` with `accountInclude` = your wallets; the full parsed transaction comes with the notification, so there's no `getTransaction` round trip. Built to Helius's documented message format and tested against a mock, not a live Helius endpoint. Store the URL (with your key) in the keystore: `vesk keys set HELIUS_WS_URL`, then `vesk copy sources pumpportal,rpc,helius`. |
| Yellowstone gRPC | – | **Not built in.** It needs a gRPC client. Implement the `DetectionSource` interface (`packages/core/src/copy/detect.ts`: `start`, `setWallets`, `stop`, `status`) and pass it to the `CopyDetector`. Asking for it says so instead of pretending. |

All sources run at once behind one dedupe: the first delivery of a (signature, wallet) wins, the others skip it (the RPC source doesn't even fetch a transaction PumpPortal already delivered). Every socket reconnects with backoff (1 s doubling to 30 s) and resubscribes.

### How a transaction is classified

From `getTransaction`: the coin is the non-quote mint whose balance (owned by the wallet) changed the most, from the pre and post token balances. SOL in or out is the wallet's lamport change plus its wrapped-SOL change, with the network fee added back and new token-account rent taken out (so "their buy" is what went into the swap, platform fees and tips included). The venue comes from the programs the transaction invoked: a Jupiter route wins (the hops are listed), then the pump.fun curve, PumpSwap, LaunchLab (Bonk), Raydium (AMM v4, CPMM, CLMM), Meteora (DBC, DLMM, DAMM v1/v2) and Orca. Token-for-token and stablecoin swaps aren't copied. Sells record the % of their balance they sold.

The unit tests use hand-built transactions in the jsonParsed shape with the real program IDs (the build machine has no mainnet access). Before you rely on a venue, record a real transaction from your RPC and add it to `packages/core/test/copyFixtures.ts`.

### Latency, recorded per copy

- **detected**: when Vesk saw the trade (your clock);
- **decided**, **sent**, **landed**: through the executor (landed = confirmed);
- **their slot** and **your slot**: from `getSignatureStatuses` after the fact;
- **their block time**: RPC sources only, with 1 s resolution.

The feed's badge is detected → landed in ms, plus "+N slots" when both slots are known.

## Guardrails

Copies buy from your **one active trading wallet**. There's no multi-wallet copy buying, and the guardrails refuse it anyway (one wallet per coin). Every copy goes through the executor: blacklist (the coin, its dev, or the tracked wallet itself), wash-trade check, limits, reserve, kill switch. Copy trading can't be used for volume, wash trades or coordinated buying.

## Chat, Telegram, MCP

- **Chat** (terminal, panel, Telegram): "copy @degen with 0.2 SOL, skip above 300k mcap, TP 2x 50%, SL 30%" or "copy <address> as whale with 25% of their buy, auto, mirror sells". You get a draft with every setting; nothing changes until you confirm.
- **Telegram**: Confirm-mode copies arrive with **Copy** / **Skip** buttons; copies and failures are announced (skips stay in the feed). `/copy` lists wallets with today's copies, `/copy feed` shows the last trades, `/copy on|off <label|all>`.
- **MCP**: `vesk_copy_list`, `vesk_copy_add`, `vesk_copy_update` (both need `confirm: true` after the user agreed), `vesk_copy_feed`.

## Limits and what's approximate

- **A copy lands after their trade, never before.** In the same slot at best, usually a few slots later, depending on your RPC and stream. The feed measures it on your setup.
- **Hosted copying is slower and checks less:** one extra hop through the relay worker, a once-a-minute fallback for venues PumpPortal doesn't carry, and holder, dev, age, bundle, socials and name checks need the self-hosted agent.
- **Market cap at their buy** is PumpPortal's figure or their fill price × supply; when neither is known, a snapshot after detection, marked "(now)".
- **Age, dev % and bundled %** need the coin's creation in one page of 1000 signatures, so they're unavailable for older, busier coins (never guessed).
- **Venue classification is tested on hand-built transactions;** record a real one from your RPC before relying on a venue.
- **Their realized PnL** in the drawer counts only sells against buys seen in that window.
- **The leaderboard ranks your copies, not the wallets.** A wallet's own on-chain PnL isn't computed; its rank is what copying it made you, so it depends on your size, filters and timing.
