<p align="center"><img src="docs/assets/logo.png" width="96" alt="Vesk"></p>

<h1 align="center">Vesk</h1>
<p align="center"><b>Moves before you see it.</b><br>An open-source AI agent for memecoin trading and launching on Solana.</p>

<p align="center">MIT · runs on your machine · any model · any RPC · your keys</p>

---

Vesk watches the X accounts you choose and new pump.fun launches, and buys inside the limits you set when a coin shows up. It trades through pump.fun (PumpPortal) and Jupiter with take-profit ladders, stop-losses, trailing stops, limit, DCA, TWAP and dev-sell orders. It launches coins on pump.fun and can run your coin afterwards: updates, community answers, creator-fee claims and disclosed buybacks, all inside hard guardrails.

You talk to it in a terminal, on Telegram, or from another agent through MCP (OpenClaw, Hermes Agent, Claude Code…).

> **Memecoins are extremely risky.** Sniping can lose everything you put in. Use a fresh wallet with an amount you can afford to lose. This is software, not financial advice.

## Install

```bash
curl -fsSL https://veskagent.com/install.sh | bash   # read install.sh first if you like
# or
npm i -g vesk-agent
# or build from source (git + Node 22; pnpm via corepack)
VESK_FROM_SOURCE=1 bash install.sh
# or 24/7 in Docker
docker compose run --rm vesk init && docker compose up -d
```

```bash
vesk init                 # encrypted wallet keystore, RPC latency test, model; paper mode on
vesk doctor               # node, RPC latency + websocket, keystore, model key, X source
vesk snipe @alpha_calls --sol 0.25 --max-mcap 50k --tp 3x:50 --sl 30
vesk summon               # paper: real signals, nothing signed
vesk summon --live        # signs, inside your limits
```

Every Solana call goes to your own RPC (`rpc.url`), with confirmations pushed over its websocket. See [docs/18-rpc.md](docs/18-rpc.md) for why that is faster and what else Vesk talks to.

## What it does

| | |
|---|---|
| **Snipe** | X accounts (Vesk Relay for holders, your own X API key, or a provider) and new pump.fun launches with dev %, socials, liquidity, blocklist and rug-check filters. |
| **Trade** | pump.fun via PumpPortal and Jupiter. TP ladders, SL, trailing stops, market-cap targets, timed sells, and orders (`vesk order`): limit, stop-loss, trailing, DCA, TWAP and buy-when-the-dev-sells. Optional Jito tips. |
| **Copy trade** | Track any number of wallets (`vesk copy`, the panel, chat, Telegram, MCP). Their trades come from PumpPortal's account-trade stream and your RPC websocket; each buy is checked against your filters (market cap at their buy, liquidity, age, dev, top 10, bundled, socials, venues) and limits, then copied, sent to you to confirm, or skipped with the reason. Mirror their sells, exits per copy. Copies land after their transaction, never ahead of it. |
| **Tracker** | 24/7 X watcher with a live feed in groups, per-post latency in ms, and one-key Deploy / Instant deploy on any post. Posts come from Vesk Relay (free for $VESK holders), your own X key or a provider. |
| **Launch presets** | Dev buy (0 = free launch), fees, links, image source, naming and exits, including dev-sell timers in seconds. |
| **Launch on posts** | Optional rules: watch one account 24/7 or many, in priority order. When one posts something that matches, draft a coin from the post and launch it on pump.fun (Auto, or Confirm with a card), on SOL or a custom pair, after checking nobody launched the same post, image or ticker first; then sell at your exits. Race reports say where you landed. Always labelled "Inspired by a post from @handle. Not affiliated with or endorsed by them." |
| **Launch** | pump.fun today: create + dev buy in one Jito bundle (or deploy only), from the CLI, chat, MCP or the panel (sign with your own browser wallet, or hand the coin to the agent). Optional team wallets, always disclosed. More launchpads are listed as soon. |
| **Run your coin** | Updates to your own accounts, FAQ answers, creator-fee claims, disclosed buybacks and burns. `vesk treasury` lists every move. |
| **Wallets** | Many wallets in one keystore, folders, an address book with bookmarks (JSON/CSV), token sends, and rent recovery for empty token accounts. |
| **Any model** | Anthropic, OpenAI, OpenRouter (any model), Ollama (local), or none. |
| **Any chat** | CLI, Telegram, MCP. Discord later. |

## Guardrails (in code, not settings)

No wash trading or volume bots. No fake engagement, shill bots or sockpuppets. No impersonation. No coordinated pumps or hidden supply. Every trade comes from your own disclosed wallets, and team wallets at launch are always published. See [docs/14-guardrails.md](docs/14-guardrails.md) and `packages/core/src/guardrails.ts`.

## Repo

```
packages/core       rules engine, Pulse reducer, guardrails, CA detection, keystore, RPC, PumpPortal/Jupiter/Jito, X + pump.fun watchers, launch, coin manager, agent loop
packages/cli        the `vesk` command
packages/telegram   your own Telegram bot
packages/mcp        MCP server (stdio)
skills/openclaw     OpenClaw skill (SKILL.md)
e2e/                end-to-end run against local mocks (pnpm test:e2e)
docs/               everything in the docs site; _index.json sets order, groups and summaries (the site's /docs is generated from it)
```

```bash
pnpm install
pnpm test          # rules engine, guardrails, CA detection, chat parser, keystore
pnpm test:e2e      # the real CLI + agent against local mocks of X, PumpPortal, Jito, RPC and a model
pnpm typecheck
pnpm build         # tsc to packages/*/dist; `vesk` is packages/cli/dist/index.js
```

## Status

Early. The rules engine, guardrails, CA detection, chat parser and keystore are unit-tested. Network integrations (PumpPortal, Jupiter, Jito, X API, pump.fun upload, Telegram) are written against their public docs and marked where they still need live testing. Run in paper mode first (the default after `vesk init`), then small sizes. See [CLAIMS-AUDIT.md](CLAIMS-AUDIT.md) for what is tested and what still needs live testing.

## License

MIT. No token is required to use Vesk.

## Free and open source

The agent (CLI, Telegram bot, MCP server) is MIT and free for everyone. The optional hosted panel and API require holding $VESK ([holder access](docs/09-holder-access.md)). That gate only applies to the hosted service, never to this code.
