# MCP, OpenClaw and Hermes

Vesk ships an MCP server so other agents can use its tools, and an OpenClaw skill.

## MCP server

```bash
vesk mcp
```

| Tool | Does |
|---|---|
| `vesk_status` | Status, today's spend vs cap, recent activity |
| `vesk_positions` | Open positions with live PnL |
| `vesk_detect_ca` | Find mint addresses in a post (with look-alike filtering) |
| `vesk_market` | Price, market cap, liquidity |
| `vesk_rule_draft` | Plain English → rule draft (no side effects) |
| `vesk_rule_save` | Save a draft after the user confirmed (`confirm: true`) |
| `vesk_rules_list` | Rules and watchlist |
| `vesk_watch_add` | Watch an X account with limits (`confirm: true`) |
| `vesk_kill_switch` | Kill switch on/off |
| `vesk_buy`, `vesk_sell` | Only with `VESK_MCP_ALLOW_TRADES=1`, and `confirm: true` per call |
| `vesk_creator_fees` | Coins this agent launched: pair, where creator rewards go, claimed so far, and the claims `vesk_claim_fees` would send (one per asset) |
| `vesk_burn_plan` | What a burn would take: what the wallet holds of a coin you launched, the amount or share, what's left. Nothing is signed |
| `vesk_burn_supply` | Burn supply of a coin you launched (one `BurnChecked`; "Burned tokens are gone forever"). Only with `VESK_MCP_ALLOW_TRADES=1` and `confirm: true`; show `vesk_burn_plan` first |
| `vesk_lock_supply` | Lock supply: not available yet (Soon). Returns the plan and the reason; nothing is sent |
| `vesk_claim_fees` | "Claim my fees": one claim per asset and wallet, each paid in its asset. Only with `VESK_MCP_ALLOW_TRADES=1` and `confirm: true` |
| `vesk_pairs` | The quote pairs for a pump.fun launch: SOL and the custom pairs by category, each with its mint and status (Verified on-chain, Listed, Discovered), and the pairs discovered live. With `check`, reads one pair's mint on chain now (exists, Token / Token-2022, a mint, decimals) and remembers the result |
| `vesk_launch_rule_templates` / `vesk_launch_rule_from_template` | Launch-on-post templates (Founder announcements, Breaking news, Image memes, Product launches, Custom) and a draft from one. No side effects |
| `vesk_launch_rule_backtest` | Replay the last 7 days of posts from a rule's accounts through its triggers (needs your X API key for history). Nothing is spent |
| `vesk_launch_rule_stats` | Per rule: launches, first-place rate, median post → landed, PnL, creator fees |
| `vesk_race_reports` | Race reports of launches from posts: rank among every coin made for the same post, and how long after the post yours landed |

Trading tools are off by default. Even when on, every call passes the same guardrails and limits as the CLI.

## Claude Code

```bash
claude mcp add vesk -- vesk mcp
# with trading tools:
claude mcp add vesk -e VESK_MCP_ALLOW_TRADES=1 -e VESK_PASSPHRASE=... -- vesk mcp
```

## Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "vesk": { "command": "vesk", "args": ["mcp"] }
  }
}
```

## Hermes Agent (Nous Research)

Add Vesk as an MCP server in your Hermes config (check the Hermes docs for the exact file for your version):

```yaml
mcp_servers:
  vesk:
    command: vesk
    args: ["mcp"]
```

## OpenClaw

Install the skill from `skills/openclaw/` (or ClawHub once it's published). It teaches OpenClaw to drive the `vesk` CLI: status, drafting and confirming rules, watching accounts, and the kill switch. OpenClaw setups that support MCP can also use `vesk mcp` directly.

```bash
cp -r skills/openclaw ~/.openclaw/skills/vesk    # path may differ; see OpenClaw's skills docs
```

## Tools

Read-only: `vesk_status`, `vesk_positions`, `vesk_detect_ca`, `vesk_market`, `vesk_rules_list`, `vesk_launchpads`, `vesk_launch_plan`, `vesk_wallets` (names as in the panel: Main, Wallet 1… or yours), `vesk_pending_launches`, `vesk_treasury` (team buys, dev sells, claims, buybacks and burns with transactions), `vesk_launch_rule_accounts` (which accounts in a launch rule are on), `vesk_creator_fees`, `vesk_pairs`, `vesk_launch_rule_templates`, `vesk_launch_rule_backtest`, `vesk_launch_rule_stats`, `vesk_race_reports`, `vesk_burn_plan`, `vesk_lock_supply` (Soon: the plan only) (needs `VESK_PASSPHRASE` to read the wallet's token decimals; signs nothing).
Drafts (no side effects until confirmed): `vesk_rule_draft` / `vesk_rule_save`, `vesk_launch_rule_draft` / `vesk_launch_rule_save`, `vesk_watch_add`.
Copy trading: `vesk_copy_list` and `vesk_copy_feed` (read-only), `vesk_copy_add` and `vesk_copy_update` (need `confirm: true` after the user agreed; a wallet in Auto mode spends SOL through your agent's guardrails and limits). See [Copy trading](27-copy-trading.md).
Safety: `vesk_kill_switch` turns the kill switch on (no new buys) or off.
Moves funds (only with `VESK_MCP_ALLOW_TRADES=1` and `confirm: true`): `vesk_buy`, `vesk_sell`, `vesk_launch`, `vesk_pending_decide`, `vesk_claim_fees`, `vesk_burn_supply` (show `vesk_burn_plan` first).
