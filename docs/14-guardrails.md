# Guardrails

Guardrails run before every transaction and every public post, in every mode: CLI, Telegram, MCP and the hosted panel. They're code, not settings. You can't turn them off from config, chat or a tool call. They live in `packages/core/src/guardrails.ts` and are unit-tested.

<!-- flow: guardrails "Buys pass three checks; the ones that pass fill your daily budget until it closes." -->

## Vesk will never

| | What it means in code |
|---|---|
| **Wash trade or run volume bots** | There is no volume action. Re-buying a coin within 10 minutes of selling it is refused. Buybacks are limited to one per hour. |
| **Fake engagement, shill bots or sockpuppets** | Posts only go to accounts you linked. Max 6 posts per hour per account. The same text can't go out twice within an hour, on any account. |
| **Impersonate** | Posts that speak "on behalf of" another account or project are blocked. Automated posts are labelled as automated. |
| **Coordinate pumps** | Only one of your wallets can buy a given coin within 30 minutes. Posts that call for timed group buys are blocked. The one exception is a team allocation at launch: up to 4 of your own wallets buy in the create bundle, and their full addresses are published in the coin description and every treasury report. It can't be turned on without that disclosure. |
| **Trade from undisclosed wallets** | Every trade must come from one of your own disclosed wallets. |
| **Hide supply** | No stealth or "block 0" bundles, temporary holder wallets, hidden or CEX-routed funding, bubble-map evasion, randomized "organic-looking" buys, MEV layers or market-maker bots. Funding between your wallets is a direct, visible transfer. |

Requests for any of these in chat ("run a volume bot", "buy followers", "spread buys across wallets", "stealth launch", "hide the bundle from bubble maps") get one plain reply ("I can't do that one.") and nothing is drafted.

## Launch-on-post rules and deploys

- Every auto-launched coin's description ends with "Inspired by a post from @handle. Not affiliated with or endorsed by them."
- Names, tickers and descriptions can't claim to be the person's official, verified or endorsed coin. The X link is never the person's account or post.
- Never two coins for the same post. Per-hour, per-day, per-launch and per-day SOL limits, a cooldown per account, and the kill switch always apply.
- Deploy and Instant deploy from the tracker follow the same rules.
- Dev sells always appear in the treasury report, including dev-sell timers. A full dev exit is announced (when posting is on) and stops promotional updates for that coin.

## Run-your-coin rules

- Creator fees are claimed to your disclosed wallet and reported publicly.
- Buybacks and burns must be disclosed. Each one is posted with its transaction link.
- Community answers come only from the FAQ you write. No price talk, no predictions, never financial advice.
- Posts can't promise returns ("guaranteed", "can't lose", "next 100x").

## Limits

Per-trade max, daily spend cap, max open positions, max buys per day, max buys per minute (any 60 seconds, every source), SOL reserve, and the kill switch. The kill switch stops buys but never stops you from selling or withdrawing. A trading source you switched off (Snipe rules, Copy trade, Pulse, Launch on post; see [Strategy & safety](34-strategy.md)) has its buys refused here too; manual buys never are.

**Rogue mode doesn't loosen any of this.** A Rogue buy is checked against the session's per-coin size, total budget and coin count here, in the guardrails, on top of every limit above, the kill switch, one wallet per coin and the never-list. See [Rogue mode](35-rogue-mode.md). The [can-sell check](36-honeypot.md) runs after these checks and before anything is built.
