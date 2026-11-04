# CLI commands

Every command accepts `-c <path>` to use a specific config file. Without it Vesk looks for `vesk.config.{ts,yaml,yml,json}` in the current folder, then in `~/.vesk/` (or `$VESK_HOME`).

Every read-only command (`status`, `positions`, `doctor`, `wallet`, `wallets`, `rules list`, `presets list`, `pending`, `treasury`, `book list` and more) takes `--json` for scripts. `NO_COLOR=1`, a non-terminal stdout or `TERM=dumb` turns colour and spinners off.

Output is plain on purpose: dim timestamps, a 9-wide tag column, cyan for the agent's own words, green and red only for money.

This is the real output of the e2e run (`VESK_E2E_TRANSCRIPT=out.txt pnpm test:e2e`), against local mocks:

```
  vesk 0.1.0  live · signs inside your limits
  ─────────────────────────────────────────────────────────────────
  wallet 76E8…N29k  2.000 SOL             rpc    custom 4 ms · ws
  model  ollama                           rules  1 snipe · 1 launch
  x      x-filtered-stream · 1 account    today  0.000 SOL · 0 open
  ctrl-c stops · vesk pause / vesk kill on from another terminal

22:35:19.370  status    Vesk 0.1.0 online · wallet 76E8…N29k
22:35:19.405  status    Watching 1 X account via x-filtered-stream
22:35:19.549  launch    Launched Night Ferry ($FERRY) from @harbourdesk's post on pump.fun, standard, slot 300000001  5bVb1uHZKh…
22:35:19.552  status    $FERRY: post received → landed in 42 ms (received +0 ms → drafted +7 ms → image +9 ms → metadata +18 ms → built +25 ms → landed +42 ms)
22:35:24.553  timeout   FERRY: 5 s after launch, selling 100%
22:35:24.573  sell      Sold 100% of FERRY for 0.1980 SOL via pumpfun (timed sell 5 s)  32H9KHFF3e…
```

Latencies there are against mocks on the same machine. Yours depend on your RPC and model.

## Run

| Command | What it does |
|---|---|
| `vesk init [--import] [--yes]` | Five steps: wallet keystore, RPC with a latency test, model and key, Telegram (optional), paper mode (default). `--yes` takes flags and env vars instead of prompts: `VESK_PASSPHRASE`, `--rpc <url>`, `--model <provider>`, `--model-url <url>`, `--telegram env --telegram-chat <id>`, `--live`. |
| `vesk summon [--live\|--paper] [--stream]` | Start the agent in the foreground. After `init` it starts in paper mode (every decision, nothing signed); `--live` signs. `--stream` uses the X filtered stream instead of polling with your own key. |
| `vesk live [--once]` | The [Live view](33-live.md) in the terminal: the six steps with what each did last, the counters, open positions and the latest decisions with their reasons. Redraws every second; `--once` prints once, `--json` prints the view as JSON. |
| `vesk status` | Status, mode, today's spend against your cap, open positions, recent activity. |
| `vesk positions` | Open positions (cost, tokens, best PnL, TP steps done) and recently closed ones with realized PnL. |
| `vesk doctor` | Checks node 22+, config, paper/live, keystore (file mode; unlocks if `VESK_PASSPHRASE` is set), RPC latency (p50/p95) and websocket, model key, X source and Telegram. Changes nothing. Exit code 1 if any check fails. |
| `vesk pause` / `vesk resume` | Stop / restart rules firing. Exits on open positions keep running while paused. |
| `vesk stop` | Ask a running agent to exit cleanly. |
| `vesk kill [on\|off]` | Kill switch. No new buys while on. Sells and withdrawals still work so you can get out. |

## Strategy & safety

| Command | What it does |
|---|---|
| `vesk strategy [show]` | Every [Strategy & safety](34-strategy.md) setting, grouped, with its key and value (dimmed when its switch is off). `--json` for scripts. |
| `vesk strategy set <key> <value>` | Set one value: a number (`5`, `0.1 sol`, `$80k`), `on` / `off`, a choice, or a ladder (`"2x50, 4x50"`). Checked against its range; hard limits (`limits.*`) too. A running agent picks it up within 2 s. |
| `vesk strategy preset safe\|balanced\|degen\|rogue` | Apply a preset (your Rogue target is kept). |
| `vesk strategy explain <words>` | The help for every setting matching the words: what it does, a typical value, the trade-off. |
| `vesk strategy export [--out f]` / `vesk strategy import <file>` | Move the settings as JSON. An import never starts Rogue mode. |
| `vesk rogue start --ticker X [--keywords a,b] [--sol 0.05] [--coins 10] [--budget 0.5] [--window 10] [--yes]` | Start a [Rogue mode](35-rogue-mode.md) session. Also `--creator <wallet>`, `--x <handle>`, `--stall <s>`, `--stall-vol <sol>`, `--sl <pct>`, `--leaders <s>\|off`, `--keep 1\|2`. Prints what it will do and asks first. `--no-honeypot` also needs `--i-understand`. |
| `vesk rogue status` / `vesk rogue stop` | The session's line, countdown and coins (with why each was sold); turn it off (open coins keep their exits). |

## Snipe and rules

```bash
vesk snipe @handle --sol 0.25 [--max-mcap 50k] [--tp 3x:50,6x:100] [--sl 30] [--per-day 3] \
  [--keyword launch] [--slippage 15] [--priority 0.0005] [--jito 0.001]
vesk snipe --launches --sol 0.1 [--max-dev 5] [--socials] [--min-liq 10] [--block cat,dog]
vesk watch [list | add @handle | rm @handle]
vesk rules [list | show <id> | add "<plain English>" [--yes] | enable <id> | disable <id> | rm <id>]
vesk rules account <launch-rule-id> @handle on|off     # switch one watched account, keep it in the rule
vesk tracker source [relay | official-api | provider | off]
vesk chat ["message"]
```

`--keyword` switches a watched account from "CA in post" to "keyword + link" mode.

## Launch on post

```bash
vesk rules add --launch-on-post @a,@b --dev-buy 0.5 --sell 50%@100k,100%@250k [--stop 5k] [--timeout 720] [--auto]
  [--template founder|breaking|memes|product|custom]
  [--keyword moon,launching] [--exclude giveaway] [--media any|image|video|image-or-video]
  [--cashtag any|require|forbid] [--ca any|require|forbid] [--lang en,es] [--velocity 500/60s[/120s]]
  [--hours 09:00-17:30,22:00-02:00 --tz 60] [--allow-replies] [--allow-quotes] [--allow-reposts]
  [--naming model|template|post --style playful|literal|meme|deadpan --name "{Word}" --ticker "{WORD}"]
  [--image post|generate|mine --default-image ./coin.png] [--no-crop] [--website post|preset] [--web url --tg url --x url]
  [--pair NVDAx --creator-fee 0.25 --fees creator|holders|cashback|split --split <addr>:60,<addr>:40]
  [--clash skip|rename|launch --clash-window 120] [--race-window 10]
  [--sell-after 5:100] [--no-volume 0.5/120s] [--trail 25] [--sl 40]
  [--per-hour 2 --per-day 5 --max-sol 1 --max-sol-day 3 --cooldown 60 --max-open 3] [--team-wallets N --team-sol 0.1]
vesk rules templates                       the five templates and what each sets
vesk rules backtest <id>                   paper replay of 7 days of posts from the rule's accounts (your X API, else the tracker's stored posts); nothing spent
vesk rules stats [<id>]                    launches, first-place rate, median post → landed, PnL, creator fees, last fired
vesk races [<mint|$TICKER>]                race reports: "1st of 14 · 1.7 s after the post"
vesk pairs [--search nvda] [--category stock] [--seen]   the quote pairs, by category and status
vesk pairs --check NVDAx                   read a pair's mint on chain now: exists, token program, a mint, decimals (exit 2 when refused)
vesk pending [launch <id> ["Name" $TICKER] | skip <id>]   drafts waiting for you (Confirm mode; a name for "Ask me" drafts)
```

Confirm mode is the default. A template is applied first, then every flag on top. See [Launch on posts](05-launch-on-post.md).

## Trade and launch

`vesk buy` and `vesk sell` are what the panel's [Instant Trade](29-instant-trade.md) chips do: one wallet buys, and every order goes through the same limits and guardrails.

```bash
vesk buy <mint> <sol> [--preset p1|p2|p3] [--slippage 15] [--jito 0.001] [--yes]
vesk sell <mint> <percent|all> [--preset p1|p2|p3] [--yes]
vesk order buy <mint> <sol> --below <price> | --mcap <usd>         limit buy (sell <mint> <pct> --above … for a limit sell)
vesk order stop <mint> <pct> --below <price> | --mcap <usd>        stop-loss
vesk order trail <mint> <pct> --trail <pct>                        trailing stop below the high since you placed it
vesk order dca <mint> <sol> --every <min> --times <n>              [--total <sol> --slices <n>] [--min-mcap 20k --max-mcap 80k]
vesk order twap <mint> <total sol> --over 30m --slices 6           [--weights 50,30,20]
vesk order dev-sell <mint> <sol> --dev <wallet> [--min <sol>]      buy the moment the dev wallet sells
vesk orders [list | cancel <id>] [--json]
vesk launch --name "Night Owl" --ticker OWL --image ./owl.png \
  [--desc "..."] [--x https://x.com/...] [--tg https://t.me/...] [--web https://...] \
  [--mode standard|manual] [--dev-buy 0.5] [--jito 0.001] [--priority 0.0005] [--slippage 10] \
  [--team-wallets N --team-sol 0.2] [--quote SOL|USDC|NVDAx|…] [--creator-fee 0.05-1] [--fees creator|holders|cashback|split] [--split <addr>:<pct>,…]
```

Every order takes `--preset p1|p2|p3` and `--slippage`; `--side sell` makes DCA, TWAP and dev-sell orders sell a %. See [Coin page, orders and callouts](28-coin-page.md).

`standard` sends create + dev buy as one transaction (with team wallets, one Jito bundle). `manual` deploys only. `--quote <pair>` picks a custom pair (`vesk pairs` lists them: USDC, USD1, xStocks such as NVDAx…; a pair whose mint isn't known yet is refused) and `--creator-fee` (0.05 to 1%, paid in that asset) its creator fee; on SOL pump.fun sets the fee and the flag is refused. `--fees creator|holders|cashback` sets where fees go; `--split <addr>:<pct>,…` (up to 10 wallets) keeps them to you, shared among those wallets (Cashback and a split are for custom pairs). Fee settings lock once the coin is set up. Every custom-pair mint is read on chain before the create. Custom pairs, Cashback and the split are *verify on first live launch*. `--team-wallets` uses your first N active imported wallets (max 4), each buying `--team-sol`. Their addresses are always published in the coin description and treasury reports. See [Launch](06-launch-and-presets.md).

## Trading presets and Pulse

```bash
vesk trading                         # buy and sell presets P1/P2/P3, quick amounts, wallet, hotkeys
vesk trading active p2 [--sell]      # make P2 the active buy (or sell) preset
vesk trading export --out trading.json
vesk trading import trading.json     # validated; an MEV mode without a Jito tip is refused
vesk pulse [--column new|final|migrated] [--filter pulse-filters.json] [--for 60]
vesk pulse --filter f.json --buy 0.1 --preset p2 --max 1 [--paper]
vesk pulse --pools all                   # new pools via logsSubscribe on your RPC (Meteora DBC, LaunchLab, Raydium, Orca, Meteora AMM, PumpSwap)
vesk migration buy <mint> 0.1 --preset p2 | sell <mint> 100 | rm <id> | watch
vesk blacklist add dev|mint|funder|wallet <address> [--note "..."] | rm … | import <file> [--kind dev] | export
```

`--preset` uses that preset's slippage, priority fee (or the auto fee, capped), Jito tip and MEV mode. Explicit flags such as `--slippage` still win. `vesk snipe ... --preset p2` stores the preset on the rule. `vesk pulse` shows the coins that pass a column filter, exported from the panel's Pulse or written by hand. With `--buy`, it quick-buys the first `--max` matches through the same guardrails and limits as any other buy. See [Pulse](20-pulse.md), [Trading settings](21-trading-settings.md), [Migration snipe](25-migration-snipe.md) and [Blacklist](24-blacklist.md).

## Copy trading

```bash
vesk copy add <address> --label degen --sol 0.2 --max-mcap 300k --tp 2x:50,5x:100 --sl 30 --mode auto
vesk copy [list | show <wallet> | edit <wallet> [settings…] | on|off <wallet|all> | rm <wallet>]
vesk copy import wallets.csv | export --format csv|json
vesk copy defaults [settings…] | templates | template balanced <wallet|all>
vesk copy sources pumpportal,rpc[,helius] [--commitment processed]
vesk copy feed [--wallet degen] [--json]       # their trades → copied / skipped with the reason, latency
vesk copy decide <id> copy|skip | manual <feed id> [--sol 0.1]
vesk copy watch [--for 60] [--paper]           # detection + copying in the foreground (summon runs it too)
```

A wallet is its address or its label. Copies land after the copied wallet's transaction (same slot at best, usually the next few); they can't front-run it. Every setting and flag: [Copy trading](27-copy-trading.md).

## Setup

| Command | What it does |
|---|---|
| `vesk keys [list\|set NAME\|rm NAME]` | Store API keys in the encrypted keystore instead of env vars. |
| `vesk rpc test [url]` | Latency test: p50, p95 and errors over 8 calls. |
| `vesk wallets [list \| import <file> \| activate \| deactivate \| rm \| fund \| return]` | Many wallets in one encrypted keystore, listed as **Main**, **Wallet 1**, **Wallet 2**… or the names you gave them. Import keys one per line, as CSV or as JSON. `fund` sends direct transfers from main (`--total 1` split evenly, or `--each 0.2`). `return` sends everything back to main. |
| `vesk wallets label <address\|n\|main> "<name>"` | Rename one of your wallets (`2` is Wallet 2). An empty name goes back to the default. Saved in the address book, so no passphrase needed. See [Wallet names](30-wallet-labels.md). |
| `vesk wallet [export]` | Address, SOL balance and token holdings. `export` prints the secret key after two confirmations. |
| `vesk pair <CODE> --panel <url>` | Link to the web panel and save `panel.url` in your config. The panel sees status and activity, never your keys. Trades you start in the panel are queued and signed here. |
| `vesk book [list \| add <addr> "<label>" [--marker ice] [--bookmark] \| rm \| bookmark \| track \| import <file> \| export [--format csv] [--out f]]` | Address book. Public addresses only. |
| `vesk book avatar <addr> <image.png\|.jpg> \| --gen monogram\|rings\|grid\|stripes [--seed 0-7] \| --clear` | A wallet's picture. Files in `~/.vesk/avatars/`, metadata stripped. |
| `vesk folders [list \| add "<name>" <addr,addr> \| rm <id>]` | Group your own wallets. |
| `vesk claim [<mint\|$TICKER>] [--all] [--yes] [--json]` | Creator fees from coins this agent launched: lists them by pair, then one claim per asset and wallet after you confirm, each paid in its asset. Coins with rewards to holders are skipped. Quote-asset claims are *verify on first live launch*. See [Claim](39-claim.md). |
| `vesk rent [--yes]` | Close empty token accounts and get their rent back (the panel's Claim → Cleanup). Never touches coins you hold. |
| `vesk burn <mint\|$TICKER> <amount\|N%\|all> [--yes] [--json]` | Burn supply of a coin this agent launched: shows what you hold, what burns and what's left, asks "Burned tokens are gone forever. Burn …?", then one SPL `BurnChecked` from your wallet through the guardrails. Listed in the treasury report and the coin's next update. `--json` needs `--yes`. See [Burn and lock supply](06-launch-and-presets.md#burn-and-lock-supply). |
| `vesk lock <mint\|$TICKER> <amount\|N%> --days 90 [--json]` | Lock supply (Soon): shows the plan and the unlock date; nothing is sent until the lock venue is verified (exit code 2). |
| `vesk treasury [<mint>]` | The treasury report: disclosed team buys, dev sells, fee claims, buybacks and burns, each with its transaction. In your terminal, team addresses show your names for them (`Wallet 2 · Team`); `--json` and posted reports carry addresses only. |
| `vesk mcp` | Run the MCP server on stdio. |
| `vesk telegram` | Run your own Telegram bot with the agent. |

Set `VESK_PASSPHRASE` to run unattended (services, MCP, Telegram). Keep that environment private.
