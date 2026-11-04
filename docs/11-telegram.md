# Telegram setup

## Self-hosted: your own bot

1. Message **@BotFather**, send `/newbot`, copy the token.
2. `vesk keys set TELEGRAM_BOT_TOKEN`
3. Find your chat id (message **@userinfobot**) and add it:

```yaml
telegram:
  enabled: true
  botTokenEnv: TELEGRAM_BOT_TOKEN
  allowedChatIds: [123456789]
```

4. Run it: `VESK_PASSPHRASE=... vesk telegram`

The bot answers only the chat ids you list. Everyone else is ignored.

| Command | |
|---|---|
| `/status` | Online/paused, today's spend, open positions, kill switch |
| `/positions` | PnL per position |
| `/rules` | Your rules |
| `/pause` `/resume` | Stop / restart rules |
| `/kill on` `/kill off` | Kill switch |
| `/buy <mint> <sol>` `/sell <mint> <pct>` | Manual trades, through the guardrails |
| `/copy` `/copy feed` `/copy on\|off <label\|all>` | Copy trading: wallets with today's copies, the last trades and what Vesk did, switch copying |
| anything else | Chat: Vesk drafts a rule and shows **Confirm** / **Discard** buttons ("copy @degen with 0.2 SOL, skip above 300k mcap" drafts a copy rule) |

Buys, sells, take-profits, stop-losses and guardrail blocks are sent to you as they happen. Copy trading in Confirm mode sends each copy with **Copy** / **Skip** buttons (60 s to decide); copies and failed copies are announced, skips stay in the feed.

## Hosted panel

In the panel go to **Connections → Telegram** and press **Link Telegram**. It opens the Vesk bot with a one-time code (`t.me/<bot>?start=<code>`). Press Start and the panel shows your chat as linked. Unlink any time.

Discord is on the roadmap.

## Launch-on-post drafts

Confirm-mode rules send each draft with **Launch** and **Skip** buttons. You can also reply `/launch <id>` or `/skip <id>`. Limits are checked again before signing, and drafts expire after the window you set.
