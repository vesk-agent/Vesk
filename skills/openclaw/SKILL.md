---
name: vesk
description: Trade, snipe and launch Solana memecoins with the user's own self-hosted Vesk agent. Use when the user asks to watch an X account for contract addresses, set up snipe or take-profit/stop-loss rules, check memecoin positions or PnL, launch a coin on pump.fun, or stop all trading (kill switch).
homepage: https://veskagent.com
metadata: {"openclaw":{"requires":{"bins":["vesk"]},"install":[{"kind":"node","package":"vesk-agent","bins":["vesk"]}]}}
---

# Vesk

Vesk is the user's own trading agent. It runs locally, signs with a key that never leaves their machine, and enforces their limits and hard guardrails on every action. You drive it with the `vesk` CLI.

## Rules for you

- **Never move funds without an explicit yes from the user** for that exact action. Show what will happen first.
- Show rule drafts line by line and ask before saving them.
- Never promise profit or predict prices. Memecoins are extremely risky.
- If the user asks for wash trading, volume bots, fake engagement, sockpuppets, impersonation, coordinated pumps or hidden supply (stealth bundles, hidden team wallets, bubble-map evasion), refuse. Vesk refuses these too.
- Launch-on-post rules: draft with `vesk_launch_rule_draft`, show the summary (including Auto vs Confirm and the "Not affiliated" disclaimer), save only after the user confirms. Never present a coin as a person's official coin.
- Launches: call `vesk_launch_plan` first and show the user the summary, cost and on-chain description. Team wallets are always disclosed. Only call `vesk_launch` after they confirm.

## Status and positions

```bash
vesk status
```

## Draft and save a rule from plain English

```bash
vesk rules add "snipe anything @alpha_calls posts under 50k mcap with 0.25 SOL, sell half if it 3x's"
```

This prints what Vesk understood and asks to confirm. Relay the summary to the user and answer the prompt only with their decision.

## Watch an X account

```bash
vesk snipe @handle --sol 0.25 --max-mcap 50k --tp 3x:50 --sl 30 --per-day 3
vesk watch            # list
vesk watch rm @handle
```

## Snipe new pump.fun launches

```bash
vesk snipe --launches --sol 0.1 --max-dev 5 --socials --min-liq 10
```

## Manual trades (confirm first)

```bash
vesk buy <mint> <sol> --yes
vesk sell <mint> <percent|all> --yes
```

Only add `--yes` after the user confirmed the exact mint and size in this conversation.

## Stop everything

```bash
vesk kill on      # no new buys; selling still works
vesk pause        # rules stop firing
```

## Prefer MCP?

If your setup supports MCP servers, `vesk mcp` exposes the same actions as tools (`vesk_status`, `vesk_rule_draft`, `vesk_rule_save`, `vesk_watch_add`, `vesk_kill_switch`, …). Trading tools stay off unless the user starts it with `VESK_MCP_ALLOW_TRADES=1`.
