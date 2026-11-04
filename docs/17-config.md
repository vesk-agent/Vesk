# Config file reference

Vesk reads `vesk.config.yaml` (or `.yml`, `.json`), or `vesk.config.ts` with type checking:

```ts
// vesk.config.ts
import { defineConfig } from "@vesk-agent/core";

export default defineConfig({
  rpc: { url: process.env.HELIUS_RPC_URL!, priorityFeeSol: 0.0005 },
  model: { provider: "anthropic", model: "" },
  x: { source: "official-api", bearerTokenEnv: "X_BEARER_TOKEN", pollIntervalSec: 15 },
  limits: { perTradeMaxSol: 0.25, dailySpendCapSol: 1 },
});
```

Secrets never go in the config. It only names them. Vesk reads each name from the environment first, then from the encrypted keystore (`vesk keys set NAME`).

## Paper mode

`paper: true` (what `vesk init` writes) makes `vesk summon` decide everything and sign nothing. Run `vesk summon --live` to sign, or set `paper: false`.

## Full example

```yaml
dataDir: ~/.vesk                 # state, logs, keystore

rpc:
  url: https://mainnet.helius-rpc.com/?api-key=...   # or QuickNode, Triton, any URL
  priorityFeeSol: 0.0005          # default priority fee per transaction
  jito:
    enabled: false
    blockEngineUrl: https://mainnet.block-engine.jito.wtf
    tipSol: 0.001                 # default tip when a rule sets jitoTipSol

model:
  provider: anthropic             # anthropic | openai | openrouter | ollama | none
  model: ""                       # empty = provider default
  # baseUrl: http://127.0.0.1:11434   (Ollama / OpenAI-compatible servers)

x:
  source: relay                   # relay (Vesk Relay, needs vesk pair) | official-api | provider | off
  bearerTokenEnv: X_BEARER_TOKEN  # your own X developer app
  pollIntervalSec: 15
  # provider: { listenPort: 8787, secretEnv: X_PROVIDER_SECRET }

launches:
  enabled: true                   # watch new pump.fun launches (PumpPortal stream)

telegram:
  enabled: true
  botTokenEnv: TELEGRAM_BOT_TOKEN
  allowedChatIds: [123456789]

limits:
  perTradeMaxSol: 0.25
  dailySpendCapSol: 1
  maxOpenPositions: 6
  maxBuysPerDay: 10
  minSolReserve: 0.02
  maxBuysPerMinute: 10
  killSwitch: false

watchlist:
  - handle: alpha_calls
    enabled: true
    mode: ca-in-post              # or keyword-link (+ keywords)
    amountSol: 0.25
    maxMcapUsd: 50000
    slippageBps: 1500
    jitoTipSol: 0.001
    takeProfit: [{ atMultiple: 3, sellPct: 50 }]
    stopLossPct: 30
    maxBuysPerDay: 3

rules: []                         # see "Rules syntax"

coin:                             # optional: run your coin after launch
  mint: <your mint>
  symbol: OWL
  postTo: { x: your_handle, telegramChatId: "-100..." }
  updates: { enabled: true, everyMin: 240, onMilestones: true }
  community: { answerQuestions: true, faq: "What is OWL? ..." }
  treasury: { claimFees: true, claimEveryMin: 360, buybackPct: 0, burnBuybacks: false }

strategy:                         # optional: Strategy & safety (partial is fine; see docs 34)
  entry:
    autoNewCoins: false
    earlyVolume: { enabled: true, windowSec: 30, minVolSol: 5, minBuys: 15, minBuyers: 10, need: all }
    size: { mode: fixed, sol: 0.1 }
  rug: { allowBundled: false, maxDevPct: { on: true, max: 10 } }
  honeypot: { enabled: true, maxTaxPct: 5 }

panel:                            # optional, after `vesk pair`
  url: https://<project>.supabase.co/functions/v1/vesk
  report: true
  syncRules: false
```

## Limits

| Key | Meaning |
|---|---|
| `perTradeMaxSol` | No single buy above this. Rules above it are rejected when you save them. |
| `dailySpendCapSol` | Total SOL spent on buys per UTC day. |
| `maxOpenPositions` | New coins are skipped when this many are open. |
| `maxBuysPerDay` | Agent-wide ceiling across all rules. |
| `minSolReserve` | Never spend below this balance (fees, rent). |
| `maxBuysPerMinute` | Buys in any 60 seconds, across every source (default 10). Stops a runaway loop; raise it for a busy [Rogue mode](35-rogue-mode.md) session. |
| `killSwitch` | No new buys. Also settable with `vesk kill on`, Telegram, MCP or the panel. |

## Strategy

`strategy:` sets [Strategy & safety](34-strategy.md): `entry`, `rug`, `honeypot`, `exits` and `rogue`, with the keys listed on that page. Anything you leave out takes the Balanced default. `vesk strategy set`, chat and the panel save to `rules.json`, which wins over this block.
