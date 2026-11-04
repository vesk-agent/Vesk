# RPC

Your RPC is the biggest single factor in how fast a snipe lands. Vesk never uses a shared Vesk RPC: every Solana call goes to the URL in your config.

```bash
vesk rpc test                      # the URL in your config
vesk rpc test https://my-rpc.example
vesk doctor                        # RPC latency + websocket, plus everything else
```

```yaml
# vesk.config.yaml
rpc:
  url: https://mainnet.helius-rpc.com/?api-key=…
  wsUrl: wss://mainnet.helius-rpc.com/?api-key=…   # optional; derived from url (https -> wss) if left out
  priorityFeeSol: 0.0005
```

## Why your own RPC is faster

- **No queue behind other users.** The public endpoint (`api.mainnet-beta.solana.com`) is rate-limited per IP and shared by everyone. Under load it returns 429s or slow responses, and a retried `sendTransaction` loses hundreds of milliseconds. A paid endpoint gives you your own rate limit.
- **Shorter path to the leader.** Good providers forward transactions to the current and next block leaders over staked connections (stake-weighted QoS). Unstaked public submissions are the first to be dropped when the network is busy.
- **Fresher state.** A blockhash or balance read from a node that is a few slots behind can cause a failed or expired transaction. Paid nodes keep up with the tip.
- **Distance.** Latency is the round trip from your machine to the RPC. Run Vesk in the same region as your endpoint (Frankfurt, Amsterdam, New York, Tokyo are common). A small VPS there beats a laptop on Wi-Fi.

`vesk rpc test` measures p50/p95 round trips from where you run it. Numbers are measured on your setup; they are not a promise of fill speed.

## Confirmations over websocket

After sending, Vesk subscribes to the signature on your RPC's websocket (`signatureSubscribe`, commitment `confirmed`) and, at the same time, polls `getSignatureStatuses` every 400 ms. Whichever answers first wins. The push usually arrives sooner than the next poll, so exits and follow-up steps start earlier. If the websocket can't be opened (some proxies block it), polling still works; `vesk doctor` tells you which you have.

## What talks to what

| Call | Goes to |
|---|---|
| Balances, token accounts, blockhash, `sendTransaction`, confirmations, mint checks | **Your RPC** (`rpc.url`, `rpc.wsUrl`) |
| Bundles (Standard launch, Jito-tipped trades) | The Jito block engine in `rpc.jito.blockEngineUrl` |
| Building pump.fun buy/sell/create transactions | PumpPortal `trade-local` (returns an unsigned transaction; Vesk signs it locally and sends it through your RPC) |
| Swaps after migration | Jupiter quote + swap API (same: unsigned transaction, signed locally, sent through your RPC) |
| SOL/USD and token prices | Jupiter price API, DexScreener |
| Posts | Vesk Relay (holders), your X API key, or your webhook provider |
| Naming, chat, images | The model provider you picked, or none |

Private keys never leave your machine. Each base URL can be overridden with an environment variable (see `packages/core/src/endpoints.ts`).

## Providers

| Provider | Notes |
|---|---|
| Helius | Good default. Use the URL with your API key. Websocket on the same host. |
| QuickNode | Pick an endpoint region close to where Vesk runs. |
| Triton | Low-latency, used by many trading tools. |
| Any URL | Self-hosted or other providers work the same way. |
| Public RPC | Works, but it's rate-limited and slower. Snipes land later. |

## Fees and Jito

- **Priority fee** (`priorityFeeSol`): paid per transaction to get scheduled sooner. 0.0005 SOL is a reasonable start. Raise it when the network is busy.
- **Jito tip** (`jitoTipSol` on a rule or watch entry, plus `rpc.jito.enabled: true`): Vesk sends your signed trade and a separate tip transfer as a bundle to a Jito block engine. The tip goes to one of Jito's published tip accounts.

Both are spent whether or not the trade gets the price you hoped for. Count them in your sizing.
