# Getting started

Vesk is an open-source agent that trades and launches memecoins on Solana. It runs on your machine, uses the model you choose and the RPC you choose, and signs with a key that never leaves your computer.

> Memecoins are extremely risky. Sniping can lose everything you put in, fast. Use a fresh wallet and fund it with an amount you can afford to lose. Nothing here is financial advice.

## Install

One line (macOS, Linux, WSL). The script is short and readable: [install.sh](https://github.com/vesk-agent/vesk/blob/main/install.sh). Read it first if you like.

```bash
curl -fsSL https://veskagent.com/install.sh | bash
```

Or with npm (Node 22 or newer):

```bash
npm i -g vesk-agent
```

Or from source:

```bash
git clone https://github.com/vesk-agent/vesk.git && cd vesk
pnpm install && pnpm build
pnpm --filter vesk-agent link --global
```

## Set up in five steps

```bash
vesk init
```

1. **Wallet.** Vesk creates a new wallet (or imports one with `vesk init --import`) and encrypts it with your passphrase (scrypt + AES-256-GCM) in `~/.vesk/keystore.json`.
2. **RPC.** Paste a Helius, QuickNode or Triton URL, or press Enter for the public RPC. Vesk runs a latency test and offers a second try if the URL doesn't answer. The public RPC works, but it's rate-limited and slower, so snipes land later.
3. **Model and key.** `anthropic`, `openai`, `openrouter`, `ollama` or `none`. Paste the key when asked and it's stored in the encrypted keystore (or keep it in an environment variable). Chat understands common phrasings even without a model.
4. **Telegram (optional).** Paste a bot token from @BotFather and your chat id, or press Enter to skip.
5. **Mode.** Paper mode is the default: every decision is real, nothing is signed. `vesk summon --live` signs.

No prompts (servers, scripts): `VESK_PASSPHRASE=… vesk init --yes --rpc <url> --model ollama --model-url http://127.0.0.1:11434`. `VESK_HOME` moves `~/.vesk`.

## Your first rule

```bash
vesk snipe @alpha_calls --sol 0.25 --max-mcap 50k --tp 3x:50 --sl 30 --per-day 3
```

Or say it in plain English:

```bash
vesk rules add "snipe anything @alpha_calls posts under 50k mcap with 0.25 SOL, sell half if it 3x's"
```

Vesk shows you what it understood and asks before saving.

## Dry run, then go live

```bash
vesk summon             # paper mode after init: real signals, real decisions, nothing signed
vesk summon --live      # signs and sends, inside your limits
```

`vesk status` shows positions and today's spend. `vesk live` (or **Live** in the panel) shows each candidate going through Watch, Check, Size, Execute, Exit and Log, and why most of them stop at Check. `vesk kill on` stops all new buys at once.

## Two ways to run

| | Self-hosted (recommended) | Hosted agent (web panel) |
|---|---|---|
| Where it runs | Your machine | Vesk's servers |
| Your key | Encrypted keystore on your disk. Never leaves it. | A **separate trading wallet** created for you. Its key is encrypted server-side (envelope encryption). |
| Funding | Your agent wallet | Small amounts you send to the trading wallet |
| Control | CLI, Telegram, MCP, panel (optional) | Panel, Telegram |
| Exit | Your key, always | Withdraw any time, export the key, kill switch |

The hosted wallet is a convenience for small amounts. Only fund what you can lose.

## Next

- [Panel tour](02-panel-tour.md): what every page does.
- [Tracker](03-tracker.md): watch X 24/7, deploy on a post in one key.
- [Launch on posts](05-launch-on-post.md) and [Launch presets](06-launch-and-presets.md).
- [Running 24/7](10-running-24-7.md): systemd, pm2 or Docker on a VPS.
- Reference: [CLI](16-cli.md), [config](17-config.md), [RPC](18-rpc.md), [models](19-models.md).
