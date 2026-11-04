# Changelog

What changed in the panel, the agent and these docs, newest first. Every entry names where to read more.

## v27: pump.fun's own pair list and official logos

- **Custom pairs** now follow pump.fun's own [Supported Pair Assets](https://pump.fun/docs/custom-pairs) list (9 October 2026): 153 pairs you can pick (SOL, USDC and USD1 as tiles, 150 more), every mint copied from that page and read on chain before use, and a new **Memes** filter. Pairs pump.fun doesn't list were dropped (discovery adds them back if seen live); ALON and Cupsey are left out like ANSEM. Each pair shows its token's own picture. See [Custom pairs](06-launch-and-presets.md#custom-pairs).
- **Official logos** for the chains, wallets, launchpads, venues, RPC providers and tools, from each brand's own site or media kit, everywhere a mark is shown.

## v26: launch on posts as a rule system, custom pairs, logos

- **Launch on posts** is a full rule system in Rules, with a nine-step builder: a template tile (Founder announcements, Breaking news, Image memes, Product launches, Custom); accounts in priority order with a switch each, Tracker groups, one launch per topic and an optional priority hold; triggers (words in and out, regex patterns under Advanced, image or video, skip posts with a contract address, replies / quotes / reposts, language, instant or once a post takes off, hours, a cooldown per account); the coin (your model in a Short, Literal or Punny style, a template, or **Ask me** on the confirm card; the post's picture cropped square around its subject; description; your links) with a live preview on pump.fun and in the panel; the pair and fees; the buy; exits; safety (the clash check, limits, Auto or Confirm); then a Plan with a 7-day **backtest**. Also in the CLI, `vesk.config.yaml`, chat, Telegram and MCP. See [Launch on posts](05-launch-on-post.md).
- **Clash check** before every launch from a post: skip, rename or launch anyway when the same post, image, ticker or name already launched.
- **Race reports**: where your coin landed among every coin made for the same post or topic, e.g. *1st of 14 · 1.7 s after the post*, on Live, Your launches and the coin page; per-rule stats with launches, first-place rate, median post → landed, PnL, fees and when it last fired.
- **Confirm** cards in Telegram and the panel: the post, the coin, the plan and one-tap Launch / Skip (or name suggestions); they expire.
- **Backtest** replays your X API's history, or the posts the tracker stored when your X source has none, and says which.
- **Live** runs launch-on-post candidates in their own lane, with the reason at each step.
- **Custom pairs**, rebuilt from pump.fun's Custom Pairs: Stablecoins, Crypto, Stocks, Pre-IPO, Metals and pairs discovered live, each **Verified on-chain**, **Listed**, **Discovered** or **Not available yet**. Every custom-pair mint is read on chain before a create; a failed check refuses it. The creator fee on a custom pair is **0.05% to 1%** (the earlier 1-3% was wrong), paid in the pair's asset; fees go to you (optionally split among up to 10 wallets), back to traders (Cashback) or to holders. See [Custom pairs](06-launch-and-presets.md#custom-pairs).
- **Claim** pays each coin's fees in its own asset. There is no swap step.
- **Logos**: every mark on disk is wired (Simple Icons, and OpenAI's glyph from Bootstrap Icons); every other brand has a slot that a file in `public/logos/` fills, with `public/logos/README.md` and a Lovable prompt listing the files.
- **A no-volume exit** and a stop-loss for launched coins. See [Exits](07-exits.md).
- **One green success mark** when something is confirmed on chain or saved: a claim, a burn, a launch, a linked wallet, sign-up, a saved rule.
- **Smaller touches**: numbers count up as they arrive, thin scrollbars that appear while you're over them, every page and dialog loads into its own outline, and Your launches fits its panel.

## v25: three ways to launch, burn and lock, a calmer chat

- **Launch** shows its three ways as three equal choices: launch it yourself, launch and hand it to the agent, or let the agent launch on posts, each with a picture of what you get. See [Launch flow](06-launch-and-presets.md).
- **Burn supply** for coins you launched: a share of what you hold or an exact amount, the Plan, a "gone forever" confirmation, then the burn and its transaction, in the treasury report. **Lock supply** is shown with its plan and says it's coming soon. Also `vesk burn`, `vesk lock`, MCP and chat. See [Burn and lock supply](06-launch-and-presets.md#burn-and-lock-supply).
- **Claim** explains creator fees and Cleanup separately: they're different things. See [Claim](39-claim.md).
- **Connect a wallet** and **Create a holding wallet** read more clearly: what's detected, what to install, what a connection shares, and a key you reveal on purpose. See [Holder access](09-holder-access.md).
- **The sidebar** lists every page; nothing is folded under More.
- **Chat**: drafts as cards with the main action first, `/burn`, and four ways to start.

## v24.1: the rest of the panel in the same look

- **Claim** happens in one dialog: what's waiting per asset, the Plan (coins, the wallet, the network fee), then the progress with a row per coin, and the result with its transactions. A failure stays on its coins, and **Retry failed** sends only what didn't go through. See [Claim](39-claim.md#the-claim-dialog).
- **Settings** has its sections on the left with icons, search at the top, and sub-sections as tabs; rare groups fold away under **(optional)**. See [Pulse settings](22-pulse-settings.md#in-the-panel).
- **Pulse → Display** is a small panel of tiles that preview each choice, with the rarer ones under **Advanced (optional)**. See [Pulse](20-pulse.md).
- **Rules**: cards with **Details**, a builder in five steps that ends in a Plan, a clearer paper test, and template tiles on a new account. See [Snipe rules](04-snipe-rules.md#in-the-panel).
- **Connect a wallet** shows its steps along the top, wallets in this browser and the ones to install, and the Vesk CLI as another way. See [Holder access](09-holder-access.md).
- **Sign up** ends with "You're in." and the two things to set up next.
- **On a phone** every dialog opens as a sheet from the bottom.
- **Smaller touches**: Settings' long explanations moved behind their **?**, the custom theme editor folds under **Custom theme (optional)**, and after a claim the Claim page scrolls back to its total so you see it settle.

## v24: atmosphere, sounds and these docs

- **A calmer, deeper panel.** One light from the top right, a faint dot texture, hairline frames with corner ticks on the main card of a page, a slim banner strip, and a little art beside focus pages. The Low resource profile turns the art and the texture off. See [Performance](31-performance.md).
- **Claim**, redesigned: one column, the claimable total with its split per asset, **Claimed to date** and **Coins launched**, and a chart of what you claimed by day or by coin. See [Claim](39-claim.md#step-by-step).
- **Holder access** and **Launch** use the same one-column layout.
- **Wallets** has three parts: the source and your folders on the left, the table on the right, with search, sortable headers and small icon buttons. See [Wallets](08-wallets.md#wallets).
- **Positions** and Portfolio's holdings sort by age, invested, value or unrealized.
- **The sidebar** keeps **Launch** and **Import** at its bottom. **The status bar** shows SOL, BNB and ETH prices and links to X, Telegram, the docs, Activity and Settings.
- **Sounds**: Vesk's own, made in your browser: a soft click for navigation, a tick for switches, a chime when a claim or a launch lands, and their own sounds for buys, sells, alerts and errors. Quiet by default, never before your first click. See [Notifications](32-notifications.md#sounds).
- **Dialogs in steps**: Withdraw, Fund wallets, Import, Create wallet, Claim all, Cleanup and the Rogue confirm show what you set, then the plan, then a progress line and the result with its transaction. Optional settings sit under **Advanced settings (optional)**, closed until you open them.
- **Auto-sell** on a coin's page opens the take-profit ladder, stop-loss and trailing stop as one dialog, and **Sell into big buys** has its own dialog on Strategy & safety. See [Exits](07-exits.md).
- **Diagrams that move**: the hard limits, selling into big buys, copy trading and launch on post are drawn as short loops in the panel and these docs. They stop when they're off screen and stay still if you've asked your system for reduced motion. See [Guardrails](14-guardrails.md).
- **Sign up and log in** moved into one centred card, with the steps for your 12 words shown at the top.
- **These docs**: a light theme (the sun / moon button at the top), search with ⌘K, the page's sections on the right, **Copy link** and **Copy for AI** on every page, numbered steps with screenshots, and this changelog.

## v23: Claim, the creator fee per pair, the launch flow finished

- **Claim** (under Agent): creator fees per coin and per asset, **Claim all**, and **Cleanup** for empty token accounts (it replaces Wallets → Recover rent). See [Claim](39-claim.md).
- The launch flow sets the creator fee on USDC and USD1 pairs. See [Launch flow and presets](06-launch-and-presets.md).
- `vesk claim`, chat ("claim my fees") and MCP tools for the same.

## v20: launch polish

- Strategy & safety: the fake-pump check, selling into big buys, parallel lanes. See [Strategy & safety](34-strategy.md).
- Holder access: a holding wallet made in your browser, with a QR code. See [Holder access](09-holder-access.md).
- Notification appearance: style, position, size, motion and time on screen. See [Notifications](32-notifications.md#settings).

## v19: Live, Strategy & safety, Rogue mode

- **Live** shows the agent work, step by step, with every decision and its reason. See [Live view](33-live.md).
- **Strategy & safety** puts every trading parameter on one page. See [Strategy & safety](34-strategy.md).
- **Rogue mode**: one hyped launch, many copies, small buys within a budget. See [Rogue mode](35-rogue-mode.md).

## Earlier

Notifications as one card per trade (v17 and v18), a cleaner panel (v16), and the panel's first rounds. The repository's history has every change.
