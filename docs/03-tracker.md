# Tracker

One 24/7 X watcher feeds three things: the live feed in the panel, your [snipe rules](04-snipe-rules.md) and your [launch-on-post rules](05-launch-on-post.md). It runs in your agent (self-hosted) or in Vesk's cron (hosted).

## In the panel

**Agent → Tracker** has four tabs: the **Social feed**, **Callouts** (posts from your groups that contain a contract address), the **Wallet tracker** (live trades by wallets you track, with a PnL per wallet since the page opened) and **Accounts and buy rules**. Toasts and sounds per alert type are in Settings → Tracker & alerts.

### The live feed

- **Columns:** All, one per account group, and Mentions CA (posts with a contract address).
- **Post cards:** avatar, name and handle, followers, age, and **latency in ms**. Then the text, media thumbnails, quoted post or reply context, and a CA line with Buy when an address is detected.
- **Latency** is when the watcher received the post minus when X says it was created: the X source's delay plus yours. It's measured, not estimated.
- **Filters:** keywords, with media only, minimum followers, accounts and groups.
- **Pause on hover:** the feed stops moving while your pointer is over a column, so cards don't jump under your mouse.
- **Groups:** e.g. Founders, KOLs, News. Each group is a column in the feed and can play a sound and/or send a desktop notification for new posts. In **Groups** each group's accounts are chips: type a handle and press Enter to add it, × to remove it. Tracking an account in a group only reads its posts; buying needs a rule.
- **A new account** sees **Track your first X account** instead of empty columns: type a handle and it goes into a group (Following), with what to do next.
- **On each post:** **Deploy** (D) opens a draft coin from the post that you review before launching; **Instant** (Shift+D) launches from the post right away with your default launch preset (it asks first, unless the preset turns that off). A post with a contract address also shows **Buy** with your first quick-buy amount.

### Deploy on a post

| Action | Key | What happens |
|---|---|---|
| Deploy | **D** | Opens a launch card prefilled from your preset: name and ticker (model or template), image from the post, your links. Edit, then Deploy. |
| Instant deploy | **⇧D** | Launches right away with your default preset, no form. Asks once the first time (setting on the preset). |
| Buy CA | | Buys a detected contract address within your limits. |
| Copy / Open | | The post link. |

Keys apply to the post under your pointer. Deploys go through the same honesty rules, guardrails, dedupe and limits as [launch-on-post](05-launch-on-post.md): the coin says it was inspired by the post and isn't affiliated with the poster, and there's never a second coin for the same post.

In self-hosted mode the panel hands Deploy to your agent through a fast lane (checked every 2 s). The agent signs.

### Being first

When a post lands, the agent:

1. starts fetching the image the instant the post arrives (in parallel with naming),
2. drafts the coin from your preset (templates are fastest; a model adds a round trip),
3. uploads metadata, builds the create (+ dev buy) transaction, signs it locally,
4. sends one Jito bundle, over connections it keeps warm (PumpPortal, Jito, your RPC).

Every step is timed. The log line looks like `post received → landed in 1702 ms (received +0 → drafted +4 → image +212 → metadata +861 → built +1094 → landed +1702)`. The panel shows the last one above the feed. **Speed depends on your X source, your RPC and the network. Vesk measures it on your setup and doesn't promise a number.**

## From the terminal

```bash
vesk deploy <post url> [--preset id]              # Deploy on a post (the agent signs)
vesk watch [list | add @handle | rm @handle]      # accounts with a buy rule
vesk tracker group add "Founders" @a,@b,@c --sound --notify
vesk tracker groups
vesk tracker source <relay|official-api|provider|off>
vesk summon --stream                              # the filtered stream with your own X key
```

## Settings

### Where posts come from

Pick a source in the panel (Tracker → the source line → change) or with `vesk tracker source`.

| Source | Who pays | Notes |
|---|---|---|
| **Vesk Relay** (default) | Vesk | One X filtered stream that Vesk runs with **its own** X developer account, fanned out to $VESK holders' panels and agents over a private Supabase Realtime channel. It carries a curated list of popular accounts plus up to **25 accounts you add**, deduped across everyone. Needs `vesk pair` and holder access. |
| **Your X API key** | You | Your own developer account and plan. The filtered stream (`vesk summon --stream`) skips the relay's extra hop, so it's usually faster. |
| **Provider webhook** | You | A data provider you pay for pushes posts to your agent. |

#### The relay, plainly

- Vesk pays for the relay's X API plan. Holders don't pay extra for it.
- X API plans cap how many stream rules (and how long each rule is) and how many posts a month one account can read. The relay packs accounts into as few rules as fit; when the budget is used, new accounts aren't carried and the panel and `vesk summon` say which ones. Use your own key or a provider for those.
- It adds one hop: X → Vesk → you. The panel shows the relay's measured median delay.
- It's Vesk's own developer account. Vesk doesn't share anyone's X login or a third-party tracker account, which would break those services' terms.
- If holder access is removed, the relay stops for that account. Your own key keeps working.

### How Vesk reads X

Vesk uses the **official X API** (the relay's account, or your own developer credentials), or a data provider you choose. It does not scrape X.

| Source | Latency | Notes |
|---|---|---|
| **Filtered stream (recommended for speed)** (`vesk summon --stream`) | typically under a second plus X's own delay | Needs an X plan that includes the filtered stream. Vesk manages `from:` rules tagged `vesk:`. |
| Recent search polling (default) | your poll interval (15 s default) | One `from:a OR from:b` query covers every account. Works on plans with recent search. Respect your plan's rate limits. |
| Your data provider | provider-dependent | The provider POSTs posts to `http://127.0.0.1:<port>/x` with an HMAC-SHA256 signature in `X-Vesk-Signature`. |

On the very first poll Vesk only remembers where it is. It never acts on posts from before it started.

### Accounts and buy rules (watchlist)

Each watched account can have its own buy rule: when it posts a contract address, buy within these settings.

#### Per-account settings

| Setting | Meaning |
|---|---|
| Amount | SOL per buy |
| Max market cap | Skip if the coin is above this when the post is seen |
| Slippage | Max price movement accepted |
| Priority fee / Jito tip | Paid to land faster |
| Take-profit / stop-loss | Exits for positions this account opened |
| Max buys per day | Hard ceiling for this account |
| Trigger | **CA in post** (safest) or **keyword + link** |

## What counts as a contract address

- A full base58 address that decodes to 32 bytes, bounded by spaces or punctuation.
- Not truncated (`7xKX...pump` is ignored), not a transaction signature, not an EVM address.
- Not a program or system address (System, Token, wrapped SOL, pump.fun, Jupiter…).
- Invisible zero-width characters are stripped first.
- Context matters: "CA:" raises confidence, "send to my wallet" lowers it.
- Two different addresses in one post are skipped by default (ambiguous).
- Links to pump.fun, Birdeye, Solscan, Jupiter, GMGN and LetsBonk are read in keyword + link mode. Dexscreener links point at pools and are resolved first.

Before buying, Vesk checks on-chain that the address really is a token mint.

## Limits and what's approximate

- **Accounts get hacked.** Watched accounts get compromised, and scammers post fake CAs from them. Keep sizes small, keep `maxBuysPerDay` low, and use a max market cap.
- **Latency is measured, not promised.** It's when the watcher received the post minus when X says it was created. Speed depends on your X source, your RPC and the network.
- **The relay** carries a curated list plus up to 25 accounts of yours, within its X plan's budget. When the budget is used, new accounts aren't carried and the panel says which.
- **On the very first poll** Vesk only remembers where it is. It never acts on posts from before it started.
