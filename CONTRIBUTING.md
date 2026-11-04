# Contributing

- `pnpm install`, `pnpm test`, `pnpm typecheck`.
- Anything that touches signing, limits or guardrails needs tests in `packages/core/test/`.
- Pull requests that add volume, wash-trading, multi-wallet buying, engagement farming or impersonation features will be closed.
- Keep the CLI output calm: one accent colour, no emoji.

## End-to-end test

```bash
pnpm test:e2e
```

Runs the real CLI and agent against local mock servers for every third party: the X filtered stream, PumpPortal and pump.fun's IPFS endpoint, the Jito block engine, a Solana RPC that verifies every ed25519 signature, Jupiter/DexScreener prices, an Ollama-style model and the panel with a Realtime websocket for Vesk Relay. It covers `vesk init` (paper by default), presets, a launch-on-post rule with a switched-off account, chat-to-rule through the model, a paper run, a live launch through a Jito bundle with a timed dev sell, the treasury report, `vesk status`, the relay, panel orders reaching the agent (and the guardrails refusing a wash-trade and a multi-wallet buy), recovering rent and the address book. Nothing touches the network.

Offline (no `pnpm install`), set `VESK_E2E_NODE_PATH` to a `node_modules` that has `tsx` and `yaml`; `@solana/web3.js` then falls back to `e2e/web3-shim.mjs` (real ed25519 via `node:crypto`), and the run says so.
