# Data sources and what each metric means

Pulse shows only numbers it can compute from a source it really has. A value that isn't known shows as "–". An element that can't be derived from public data is marked **unavailable** and can't be switched on. This page is generated from the same registry the panel uses (`core/watch/facts.ts`, `core/watch/pulse.ts`, `core/data/programs.ts`).

## Sources

| Source | What it gives | Where it runs |
|---|---|---|
| PumpPortal data websocket (`wss://pumpportal.fun/api/data`) | Creates (pump.fun, LetsBonk), trades on the coins on the board, migrations, and trades by wallets you track (`subscribeAccountTrade`) | Your browser (panel) and your agent |
| Coin metadata (the coin's URI) | Image, X, Telegram, website, Discord | Your browser / agent |
| Your RPC | Holder count (`getProgramAccounts` with an owner + amount slice), largest holders (`getTokenLargestAccounts`, curve removed), funding transfers (`getSignaturesForAddress` + `getTransaction`), the mint's Token-2022 transfer fee | Edge function `pulse-enrich` (panel, 3 coins per call, cached 2 min) and your agent |
| RPC logs (`logsSubscribe`) | New pools on the programs below | Your agent: `vesk pulse --pools` |
| DexScreener public API | Paid orders (`/orders/v1/solana/<mint>`) and active boosts (`/token-pairs/v1/solana/<mint>`) | Edge function and agent |
| pump.fun currently-live list | Coins live-streaming now | Edge function `pump-live`. **Unofficial and undocumented**; shown only when it answers |
| X oEmbed | A post's author and text for the hover preview | Edge function `tweet-preview`, returned as text |
| Your own lists | Tracked wallets and KOLs (address book), blacklist | Your account |
| `data/exchanges.ts` | Labels for known exchange hot wallets (from public explorer tags), for "funded exchange" | Shipped with the code; edit it if a label is wrong |

Everything from the stream counts **since the board started watching the coin**. Supply is 1 billion tokens.

## Row elements

### Token info

| Element | Source | How it's computed |
|---|---|---|
| Socials | PumpPortal stream | X, Telegram, website and Discord links from the coin's metadata JSON (its URI). |
| Quote chip | PumpPortal stream | The quote asset of the coin's curve or pool: SOL for pump.fun and LetsBonk. |
| Quote ticker | PumpPortal stream | Ticker shown as TICKER/SOL. |
| X link | PumpPortal stream | The X link in the metadata, opened in a new tab. |
| X renames | **unavailable** | Needs the account's name history, which no public source here provides. |
| Communities | PumpPortal stream | Marks an X link that points to an X Community (x.com/i/communities/…) rather than an account. |
| Launchpad | PumpPortal stream | From the stream's pool field (pump, bonk) or the program that created the pool. |
| Pump live | public API | pump.fun's currently-live list (an unofficial endpoint, checked through the edge function). Shown only when it answers. |
| Website | PumpPortal stream | Website link from the metadata. |
| Telegram | PumpPortal stream | Telegram link from the metadata. |
| Discord | PumpPortal stream | Discord link from the metadata, when the coin sets one (most don't). |
| Fee split | **unavailable** | Creator-fee sharing settings aren't in the stream or the metadata. |
| Indicators | PumpPortal stream | Small marks for reused X link, reused image and blacklisted funder. |
| Boosts | public API | Active DexScreener boosts on the coin's pairs (DexScreener token API). |
| X search | PumpPortal stream | A link that searches X for the contract address. |
| Image reuse | PumpPortal stream | The same image URL was used by an earlier coin on the board (URL match, not a visual match). |
| X handle | PumpPortal stream | The @handle in the coin's X link. |
| X following | **unavailable** | Needs the X API user lookup; not fetched for every coin (rate limits). |
| X followers | **unavailable** | Needs the X API user lookup; not fetched for every coin (rate limits). |

### Token metrics

| Element | Source | How it's computed |
|---|---|---|
| Volume | PumpPortal stream | Sum of SOL traded since the board started watching, × SOL price. |
| Market cap | PumpPortal stream | marketCapSol from the latest trade × SOL price. |
| Fees | PumpPortal stream | Volume × 1.25% (an estimate of launchpad trading fees). |
| TX | PumpPortal stream | Buys + sells seen. |
| Traders | PumpPortal stream | Distinct wallets seen trading. |
| Holders | your RPC | Token accounts with a balance (getProgramAccounts, curve removed); stream count until your RPC answers. |
| Pro traders | **unavailable** | There's no public, checkable definition of a pro trader. |
| KOLs | your lists | Holders that you marked as KOL in your address book. Nobody else's list. |
| Dev migrations | PumpPortal stream | Coins by the same dev that migrated, as seen by this board (a lower bound). |
| Dev creations | PumpPortal stream | Coins by the same dev seen by this board (a lower bound). |

### Audit

| Element | Source | How it's computed |
|---|---|---|
| Top 10 | your RPC | Share of supply in the 10 largest holders (getTokenLargestAccounts, curve removed). |
| Dev holding | PumpPortal stream | The dev's balance / supply from the stream. |
| Track dev | your lists | Highlights coins by devs you track in your address book. |
| Funding amount | your RPC | SOL in the dev wallet's funding transfer (oldest transfer among its last 25 signatures). |
| Funding wallet | your RPC | Who sent that transfer. |
| Funded exchange | your RPC | The funding wallet matched against labelled exchange hot wallets (data/exchanges.ts). |
| Funding time | your RPC | How long before the create the dev wallet was funded (block time of the funding transfer). |
| Flagged | your lists | The dev or the dev's funder is on your blacklist. |
| Snipers | PumpPortal stream | Supply held by wallets whose first buy came within 3 s of the create. |
| Insiders | your RPC | Supply held by wallets funded by the dev, the dev's funder or a shared funder. Never linked through pools, curves, programs or exchanges ([Wallet clustering](37-clustering.md)). |
| Bundlers | PumpPortal stream | Supply bought in the creation block by wallets funded together (upper bound without funding data). |
| Tax | your RPC | Token-2022 transfer fee from the mint's transferFeeConfig extension (0 for classic SPL mints). |
| DEX paid | public API | DexScreener orders API: an approved paid order (token profile) for this coin. |

## Discovery protocols

| Protocol | Kind | Source |
|---|---|---|
| pump.fun | launchpad | live (PumpPortal) |
| LetsBonk | launchpad | live (PumpPortal) |
| PumpSwap | dex | live (PumpPortal) |
| Raydium | dex | live (PumpPortal) |
| LaunchLab | launchpad | agent: RPC logs |
| Meteora DBC | launchpad | agent: RPC logs |
| Meteora AMM | dex | agent: RPC logs |
| Meteora AMM v2 | dex | agent: RPC logs |
| Orca | dex | agent: RPC logs |
| Mayhem | launchpad | not in feed yet |
| Bags | launchpad | not in feed yet |
| Bonkers | launchpad | not in feed yet |
| Printr | launchpad | not in feed yet |
| Stonk.fun | launchpad | not in feed yet |
| Liquid | launchpad | not in feed yet |
| LiquidAF | launchpad | not in feed yet |
| Surge | launchpad | not in feed yet |
| Soar | launchpad | not in feed yet |
| Moonshot | launchpad | not in feed yet |
| Haven | launchpad | not in feed yet |
| Wordless | launchpad | not in feed yet |
| daos.fun | launchpad | not in feed yet |
| Candle | launchpad | not in feed yet |
| Sugar | launchpad | not in feed yet |
| Believe | launchpad | not in feed yet |
| Jupiter Studio | launchpad | not in feed yet |
| Moonit | launchpad | not in feed yet |
| Boop | launchpad | not in feed yet |
| PancakeSwap | dex | not in feed yet |
| Wavebreak | launchpad | not in feed yet |
| LiquidAF MM | dex | not in feed yet |
| RiseRich | launchpad | not in feed yet |
| MetaDAO | launchpad | not in feed yet |
| pve.win | launchpad | not in feed yet |

### Program IDs watched for new pools (`data/programs.ts`)

| Program | ID | Create log line |
|---|---|---|
| pump.fun bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `Instruction: Create` |
| PumpSwap (Pump AMM) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | `Instruction: CreatePool` |
| Meteora Dynamic Bonding Curve | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `Instruction: InitializeVirtualPoolWithSplToken`, `Instruction: InitializeVirtualPoolWithToken2022` |
| Raydium LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | `Instruction: Initialize`, `Instruction: InitializeV2` |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | `initialize2` |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `Instruction: Initialize` |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | `Instruction: InitializePool`, `Instruction: InitializePoolV2` |
| Meteora Dynamic AMM (DAMM v1) | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | `Instruction: InitializePermissionlessConstantProductPoolWithConfig`, `Instruction: InitializePermissionlessPool` |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `Instruction: InitializePool`, `Instruction: InitializeCustomizablePool`, `Instruction: InitializePoolWithDynamicConfig` |

Not watched until their program ID and create log line are confirmed (TODO in the data file): moonshot, boop, bonkers, printr, stonkfun, liquid, liquidaf, surge, soar, haven, wordless, daosfun, candle, sugar, moonit, pancakeswap, wavebreak, liquidaf-mm, riserich, metadao, pvewin, mayhem.

The create log lines come from the programs' IDLs and source as we know them. The detection tests use hand-written logs in each program's log format, not logs recorded from mainnet. Check against live logs on your RPC before relying on a protocol.

## Not shown, on purpose

- **Pro traders**: there is no public, checkable definition.
- **X followers / following**: these need an X API user lookup per coin, which hits rate limits. They're not fetched.
- **X renames**: no public source has an account's name history.
- **Fee split**: creator-fee sharing isn't in the stream or the metadata.
