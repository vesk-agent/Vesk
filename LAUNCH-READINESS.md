# Launch readiness (v17)

What was checked before launch, how, and what still needs a live test. The same file is in both repos.

Everything here ran **offline**: the site in its single-file preview against the mock API (`preview/mockApi.ts`), the agent against local mocks of Solana RPC, Jito, PumpPortal, X and the model (`e2e/run.mjs`). Nothing ran against mainnet, a live Supabase project, a live X stream or a real wallet. "Verified" below means verified in that setting, never live.

**Status keys**

- **Preview**: the flow works end to end in the offline preview, covered by a functional check (`tools/v*_func.py`).
- **Unit**: the logic behind it has unit tests (`packages/core/test`, the site's `*.test.ts`).
- **e2e (mocks)**: the agent's end-to-end run covers it against local mocks (`e2e/run.mjs`, 26 steps).
- **Needs a live test**: has to be tried once on the deployed site, with a small amount, before it's announced.

## Verdict

No blocker was found in what can be checked offline: every page renders on desktop and at 390 px with the sample account and with a brand-new one, with no horizontal scroll, no page errors, no "NaN" or "undefined" on screen, a page heading, names on every icon button and a visible focus ring. All checks pass (see the end).

**The blockers are the live steps**: deploying the edge function and migrations with their secrets, DNS for veskagent.com, the X handle in the brand constants, and the first small live test of each money flow (hosted wallet, buy and sell, withdraw, launch). Until those are done, nothing here proves the live paths.

## 1. User flows

| Flow | Status | How it was checked | Risk and what to watch |
|---|---|---|---|
| Sign up with a login phrase, log in, log out | Preview, Unit | The site's `crypto.test.ts` and `phrase` checks: deterministic lookup, salted scrypt hash, a wallet seed phrase is rejected. Signup screens shot in earlier rounds | **Needs a live test** against the deployed function (sessions, rate limits). A user who loses the phrase loses the account: the copy says so |
| Holder gate ($VESK minimum) | Unit, Preview | Core `access` tests; the preview's "access removed" state (`__veskPreview.setHeld`) and the gate bar | `VESK_MINT` and `VESK_GATE_MIN` must be set at launch. Balance reads depend on the RPC; a slow RPC delays re-checks, never removes data |
| Pair a self-hosted agent | Preview, e2e (mocks) | `v12_2_func.py` pairing screen; e2e "relay: needs pairing, then posts arrive over the Realtime websocket" | **Needs a live test**: pairing code → agent Online in the panel → Pause from the panel |
| Hosted wallet: create, deposit, see balance | Preview | Wallets page in the preview (sample balances) | **Needs a live test** with 0.05 SOL. Keys are envelope-encrypted with `VESK_KMS_SECRET` (unit-tested round trip); losing that secret loses every hosted wallet: back it up offline |
| Launch (manual, hosted or browser wallet) | Preview, e2e (mocks) | `v17_func.py`: full flow to Review, Launch, the landed card, Hand it to the agent; e2e "Launch page → hand to the agent: queued launch signed by the agent" | **Needs a live test**: one launch with a small dev buy. PumpPortal and Jito are external; the bundle can fail to land (the page shows the failed step and keeps the form) |
| Snipe rules (X posts, new launches) | Unit, Preview, e2e (mocks) | Core rule tests; `v17_func.py` cards, confirm before turning on, paper test; e2e Pulse and order steps | The X source decides speed. Paper test before turning a rule on. **Needs a live test** in paper mode first, then one tiny live rule |
| Launch on post | Unit, e2e (mocks) | e2e "summon (paper by default): post → would launch" and "summon --live: post → Jito bundle"; Auto now asks for confirmation | Auto launches by itself: keep Confirm until the paper runs look right. Image rights warning stays on every draft |
| Copy trade | Unit, Preview, e2e (mocks) | e2e copy step (copied via Jito, one skipped above max mcap, a Jupiter route over RPC, a 50% sell mirrored); `v17_func.py` first-wallet onboarding in Alert-only mode | Latency depends on the user's RPC and sources. A first wallet defaults to Alert only, so nothing is spent until they change it |
| Pulse quick buy | Preview, e2e (mocks) | e2e "Pulse: a column filter matches a new coin, quick buy with P2 lands as a Jito bundle only"; stability and perf checks | PumpPortal's websocket is external and unofficial in parts (pump live); the page says so |
| Instant Trade | Preview | `v12_2`, `v13`, `v15` func checks (drag, dock, chips, amount view, slide to confirm) | Same trade path as every buy (`placeTrade`), so the same live test covers it |
| Exits (TP, SL, trailing, timed, market-cap targets) | Unit, e2e (mocks) | Core exit tests; e2e timed dev sell; notifications for exits from the activity log | Exits run on the agent or the hosted cron: if neither runs, exits don't fire. The connection notification says when the agent goes offline |
| Kill switch | Preview, Unit | `v16_func.py`; guardrail unit tests (kill switch blocks buys, sells still work) | **Needs a live test**: turn it on, try a buy (refused), sell still works |
| Withdrawals and key export | Preview (screens only) | Wallets page screens; allowlist and confirmation in the UI | **Needs a live test** with a small amount to an allowlisted address. Nothing in the offline checks moves real SOL |
| Notifications (v17) | Preview, Unit | `v17_func.py` (103 checks): lifecycle, grouping, dedupe, rate limit, persistence across reload, swipe, Esc, the centre, per-kind settings, Do not disturb, mocked desktop permission; core `notify` tests | Server-side history needs the `notification_inbox` migration. Desktop notifications depend on the browser |

## 2. Empty, loading and error states

`tools/readiness_audit.py` opens every route (23) at 1440 and 390, once with the sample account and once with a **brand-new account** (`?fresh=1` in the preview: no rules, positions, launches, tracked accounts, copy wallets, chat or history). On the fresh account every page must say something useful rather than show a blank area.

Found and fixed this round:

- **Rules**: "No rules yet" now explains what a rule is and offers three templates (each opens in the builder, switched off).
- **Copy trade**: a new account opens on **Add your first wallet** (address, name, template, Alert only by default) instead of an empty table and a hero full of zeros.
- **Tracker**: a new account sees **Track your first X account** instead of two empty columns; the sample "last launch on a post" timing no longer shows on an account that has none.
- **Launch**: "Your launches" offers New launch and Import a coin; it shows a skeleton while loading; a failed launch shows the reason with Back to settings and Try again.
- **Chat**: a message that fails to send stays in the thread, marked not sent, with Retry and Edit (it used to vanish into a toast).
- **Notification centre**: empty state for no history and for an empty filter.
- **Portfolio**: the share card says when there are no closed trades in the period.

Loading: every page shows a skeleton shaped like its content while its data or code loads; errors show the page's error box with Retry (`ErrorBox`).

## 3. Phone (390 px)

All 23 routes, both accounts: **no horizontal page scroll**. Two pages scrolled sideways before this round and were fixed:

- Overview, Positions, Portfolio: a screen-reader-only label inside a wide, scrolling table widened the page by 41 px. Screen-reader text now sits at its own corner (`.sr-only` in `v17.css`).
- Overview: the top traders strip could push its card wider than the screen (`.tt` now has `min-width: 0`).

The v17 shots at 390 (`v17-*-390.png`) cover the notification stack and centre (a full-width sheet), Portfolio, the launch success card, Rules, Copy trade, Tracker and Chat.

## 4. Accessibility

- **Keyboard**: every page tabbed through from its heading; every stop shows a focus ring. Fixed: segmented controls and tab rows (their thumb showed the selection, not the focus) and the home page's launch waterfall rows. Inputs inside an input group show the ring on the group.
- **Names**: no visible button or link without an accessible name, on any page (audited). New icon buttons (bell, centre, toasts, rule actions) have labels; the bell's label includes the unread count.
- **Live regions**: notifications are announced politely, errors assertively. Peeking cards in the collapsed stack are hidden from screen readers and can't take focus.
- **Reduced motion**: notifications, the success ring, the allocation ring and button presses don't animate with reduced motion or the Low resource profile (checked in `v17_func.py`).
- **Contrast**: 1,527 text elements, none below AA (`tools/contrast_live.py`).

## 5. Performance

| What | Result |
|---|---|
| Route changes and interactions (`tools/perf_check.py`, 16 pages, Settings, coin page) | No step over 200 ms in two runs; the longest task was the first coin-page open (149 ms) |
| Pulse with 300+ rows per column (`tools/pulse_stress.py`, `?stress=1`) | 347 / 335 / 338 rows, 42 in the DOM (virtualised); scrolling under live updates at 59–60 fps, p95 frame gap 16.7 ms, no long animation frames |
| Chart | 10,000 one-second candles pan at 60 fps (draw 0.35 ms average, 1.5 ms zoomed out) |
| Bundle (estimate) | Pages were already code-split. This round the Settings center and the docs (32 pages of text) moved out of the first load. Measured on the preview build with splitting on (it includes the preview's mock data, so the real build is smaller): entry script 1,033 KB → 769 KB minified, 349 KB → 259 KB gzipped. CSS is 421 KB (77 KB gzipped) without the fonts. **Measure the real `vite build` at deploy** |

## 6. Copy and legal

- The footer carries the non-affiliation line ("Not affiliated with any company named Vesk, with X, pump.fun, Jupiter or any provider listed on this site"); the integrations strip says logos are trademarks of their owners; every launch-on-post coin says it's inspired by the post and not affiliated with the poster.
- Risk copy: "Not financial advice" on share cards, "only spend what you can afford to lose" on Launch, "past trades of any wallet say nothing about its next one" on Copy trade.
- Speed claims are measured, not promised: "First to launch, measured, not claimed" uses labelled sample data, and every latency in the panel is "measured on your setup".
- Sample data is labelled wherever it shows (hero tags, Pulse, the share card's SAMPLE DATA stamp, the notification centre's Sample tag, "preview only" for pump.fun links of preview coins, "tx: preview").
- The docs match the UI: the docs check passes (32 pages: links, anchors, CLI commands and flags, structure, the site's copy), and the v17 changes are documented (Notifications, Rules, Copy trade, Launch, Tracker, Portfolio, the panel tour).
- **Still needs a person**: a legal review of the hosted wallet terms and the risk copy, and a trademark check on the name.

## 7. SEO and sharing

- `index.html`: title, description, canonical, Open Graph (type, site name, title, description, URL, image 1200×630 with alt text) and Twitter card (`summary_large_image`, site, title, description, image with alt). The image is the new brand OG image (`public/og.png`). Image and URL tags are absolute; the build fills in the domain and X handle from `src/brand.ts`.
- Favicon (SVG and 32 px), Apple touch icon, web manifest with 192 and 512 px icons.
- **New**: `public/robots.txt` (the site and docs public, `/app` disallowed) and `public/sitemap.xml` (home, docs, every docs page, sign up, log in: 35 URLs), written by `scripts/seo.mjs` before every build from the brand domain and the docs index.
- Page titles: each docs page has its own; the panel's tab title now names the page and shows the unread notification count.
- The site is a single-page app: crawlers that don't run JavaScript see the shared title, description and social tags. Server-side rendering of the docs would help search later; it isn't needed to launch.

## 8. Before launch (your list)

Brand and accounts

- [x] Domain: `veskagent.com`, set in `src/brand.ts` (site) and `packages/core/src/brand.ts` (agent); the build fills it into the social tags, the sitemap and robots.txt.
- [ ] Point `veskagent.com` at the hosting, and set `SITE_DOMAIN=veskagent.com` for the edge function.
- [ ] Claim the X handle (`vesk_agent`, backup `veskagent`) and the GitHub org; update `xHandle`, `github`, `siteRepo` if they differ.
- [ ] Trademark check on the name.

Supabase

- [ ] Run every migration in `supabase/migrations`, including `20261230000000_vesk_v17_notifications.sql` (the notification history) `20270101000000_vesk_v19_strategy.sql` (Strategy & safety settings and the buys-per-minute limit) `20270115000000_vesk_v20.sql` (holder wallets: connected or generated) and `20270201000000_vesk_v22_1_claim.sql` (each launch's pair, rewards mode and creator fee; each claim's asset and amount, for Claim).
- [ ] Deploy the `vesk` edge function.
- [ ] Set its secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `VESK_KMS_SECRET` (generate it, back it up offline: it decrypts every hosted wallet), `HELIUS_RPC_URL`, `CRON_SECRET`, `SITE_DOMAIN`, `VESK_MINT` and `VESK_GATE_MIN` (holder gate), `X_BEARER_TOKEN`, `RELAY_INGEST_SECRET`, `RELAY_RULE_BUDGET`, `RELAY_RULE_LENGTH` (relay), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`.
- [ ] Schedule the cron (exits, portfolio snapshots, fee claims).
- [ ] Site env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_TELEGRAM_BOT`; `VITE_VESK_CA` at launch and nowhere else.

First live run (small amounts)

- [ ] Sign up → log out → log in with the phrase; a seed phrase is rejected.
- [ ] Self-hosted agent: `vesk init` (paper is the default), `vesk summon`, pair it; it shows Online; Pause from the panel works.
- [ ] Run rules and copy trading in **paper** for a day; check the paper test against what the agent logged.
- [ ] Hosted wallet: create, deposit 0.05 SOL, see the balance.
- [ ] One 0.01 SOL buy and a sell from the coin page: the notification shows the real slot, fees and a Solscan link.
- [ ] Kill switch on: a buy is refused, a sell still works. Off again.
- [ ] Withdraw a small amount to an allowlisted address; export the key and import it elsewhere.
- [ ] One launch with a small dev buy; hand it to the agent; the exit fires.
- [ ] Notification history survives a reload and a second browser (server side).
- [ ] Measure the real `vite build` bundle and run Lighthouse on the home page.

Strategy & safety (v19), first live run

- [ ] Self-hosted, in paper: turn on the early-volume trigger (Balanced) and watch Live for an hour. Misses show the numbers they reached; a coin that reaches them is bought in paper with the strategy's exits.
- [ ] v23, verify on first live launch (section 16): a USDC-pair launch with a 1.5% creator fee (`creatorFeeBps` 150), a USDC creator-fee claim (`quoteMint`; does one claim collect every USDC coin of the wallet?), and a small USDC → SOL swap from Claim at 1% slippage.
- [ ] Can-sell check on a real RPC: a normal migrated coin passes ("a holder's sell simulated fine"), a known Token-2022 coin with a transfer hook or a freeze authority is refused. Check the extra time it adds before a buy (expected: a few hundred ms) and that Jupiter's quote and swap endpoints answer from your server (`JUPITER_API_URL` overrides the base).
- [ ] Clustering on real coins: open a few coins' Early buyers with **Read funding through your RPC** on; buyers paid by a pool or an exchange aren't linked.
- [ ] Rogue mode in paper on a hyped ticker, then live with 0.01 SOL per coin and a 0.05 SOL budget: the budget, coin count and window hold; stalled coins are sold.
- [ ] Max buys per minute refuses the 11th buy in a minute (hosted and self-hosted).
- [ ] Live → Strategy: switch Copy trade off and see a tracked wallet's next buy refused ("Copy trade is off: buys from it are paused."), then on again; the same on the hosted agent.

v20, first live run

- [ ] Run a real `npm install`: the site now depends on `tweetnacl` 1.0.3 (holding wallets). The offline preview was built against 0.14.5, the same `sign` API.
- [ ] Holding wallet on the deployed site: create one, save the key, link it, send a few $VESK to it, see the total update at the next check; import the downloaded .json into Phantom or the Solana CLI and confirm it's the same address. Watch the browser's network panel: only the address and the signature go out.
- [ ] Fake pump checks in paper for a day: the filtered reasons ("one wallet … bought 28% of supply in the first 2 s") match what an explorer shows for those coins.
- [ ] Sell into big buys in paper first, then live with a tiny position and a low tip cap. Expect misses; check every attempt on Live and what the tips cost.
- [ ] Parallel lanes: with 3 lanes and a tight daily cap, three buys at once never go over the cap together (the third is refused with "…in flight"). The hosted engine still buys one at a time.
- [ ] Logos: drop the official files into `public/logos/` (names in its README) and point their slots in `brandLogos.ts` at them; only files from the brands' own press kits.
- [ ] Notifications → Appearance on a real phone and in Safari and Firefox (glass needs `backdrop-filter`; without it the card is the translucent colour alone).

StonkFun (not enabled)

- [ ] Its program ID from StonkFun's docs, SDK or a verified explorer label.
- [ ] A confirmed way to build the create transaction (an API that returns an unsigned transaction, or a published IDL).
- [ ] The metadata upload endpoint and its fields; whether a dev buy and a disclosed team bundle can go with the create; the fees.
- [ ] Put them into `makeStonkFunAdapter` (`core/launch/stonkfun.ts`, every gap is a `TODO(...)`), then one devnet or tiny mainnet launch before the "Soon" tag comes off.

Remaining TODOs in the code

- The domain is `veskagent.com` in `brand.ts` (site and agent).
- `data/programs.ts`: launchpads whose program IDs aren't confirmed are listed as TODO and not watched; Settings → Discovery says which.
- `launch/stonkfun.ts`: StonkFun's program ID, create interface and metadata endpoint are TODO; the adapter is "Soon" and refuses to run.
- `data/clusterExclude.ts`: pump.fun's fee recipients, its migration account and some vault authorities are TODO (`CLUSTER_EXCLUDE_TODO`), not guessed.
- Not verifiable offline (also in START-HERE): live RPC and Jito landing rates, PumpPortal's live messages, X stream latency, Helius enhanced websockets, desktop notifications on every browser.

## 9. Checks at the end of v17

| Check | Result |
|---|---|
| Type-check (site, preview, edge function, agent, chart) | Pass |
| Unit tests | Core 198, site 36: all pass |
| Agent e2e (local mocks) | 26 / 26 |
| Functional checks v8–v17 | All pass (v17: 103 checks) |
| Layout stability at 1440 and 390 | No element moves (now including the notification stack expanding, groups, swipe and the centre) |
| Sandbox (file://, sandboxed iframe) | Zero console errors |
| Contrast | 1,527 elements, 0 below AA |
| Docs | 32 pages check out |
| Readiness audit (23 routes × 2 widths × 2 accounts) | 0 problems |
| Perf | No step over 200 ms; Pulse 300+ rows at 60 fps |
| Old name | Zero hits (crawl and grep) |

## 10. Checks at the end of v19 (and v19.1)

Everything here ran offline: the preview against its mock API, the agent against local mocks. Nothing ran against mainnet, a real RPC, Jupiter, PumpPortal or a deployed Supabase project.

| Check | Result |
|---|---|
| Type-check (agent, site, preview, edge function, chart, agent builds) | Pass |
| Unit tests | Core 237 (v19 strategy 21, v19.1 sources 5), site 45: all pass; relay worker ok |
| Agent e2e (local mocks) | 32 / 32 (new: hard limits from the CLI, early-volume trigger, can-sell refusals, a Rogue session; v19.1: a trading source switched off and on) |
| Functional checks v8–v19.1 | All pass (v19: 105 checks; v19.1: 53 checks: Live's settings panel saving, sources, Now trading sells, layout) |
| Notification timing (v18.1) and exit frames | Pass in both styles, List and Stacked |
| Layout stability at 1440 and 390 | No element moves (now including the List style on the Tracker with a burst, and Live: hovering trades, switching the side card's tabs, saving a preset) |
| Sandbox (file://, sandboxed iframe) | Zero console errors |
| Contrast | 1,880 elements, 0 below AA |
| Docs | 38 pages check out |
| Readiness audit | 96 page views, 0 problems |
| Perf | No step over 200 ms |
| Old name | Zero hits (crawl and grep) |

## 11. Checks at the end of v20

Everything here ran offline: the preview against its mock API, the agent against local mocks. Nothing ran against mainnet, a real RPC, Jito, PumpPortal or a deployed Supabase project.

| Check | Result |
|---|---|
| Type-check (agent, site, preview, edge function, chart, agent builds) | Pass |
| Unit tests | Core 250 (v20: 13), site 48 (holding wallet and QR: 3): all pass; relay worker ok |
| Agent e2e (local mocks) | 35 / 35 (new: a fake pump skipped with its reason; a sell into a whale's landed buy in a Jito bundle with no buy of ours; two launches and two buys in parallel with the third refused at the cap) |
| Functional checks v8–v20 | All pass (v20: 111 checks: Strategy icons, diagrams and applicability, lanes, the holding wallet with the key absent from every request, call and storage, QR decoded with OpenCV, notification appearance, the calendar) |
| Notification timing (v18.1) and exit frames | Pass in List, Stacked, Compact (tinted, fade, S), Minimal (scale, fast, L, no pictures) and List (glass, slow, no bar, five at once) |
| Layout stability at 1440 and 390 | No element moves (now including the calendar's hover, range toggle and drawer, and Notifications → Appearance) |
| Sandbox (file://, sandboxed iframe) | Zero console errors |
| Contrast | 2,650 elements, 0 below AA (now with every notification style and background, Strategy's diagrams, holder access and the calendar) |
| Docs | 38 pages check out |
| Readiness audit | 96 page views, 0 problems |
| Perf | Pulse's first open is borderline: its slowest input measured 176–272 ms across runs (v19: 144); every other step under 200 ms. Pulse rows render the same as in v19, so this is mostly run-to-run noise in this sandbox, but measure it on real hardware |
| Old name | Zero hits (crawl and grep) |

## 12. v20.1

Icons and status labels lost their tinted tiles and fills (`src/styles/v20_1.css`, checked by `tools/tint_audit.py`). Holder access asks how to verify before showing any address; "Create a holding wallet" makes the wallet as its first step; after linking, "Send $VESK here to verify holder access" waits on the generated address and re-checks every 15 seconds. Checks re-run for this round, all passing: type-checks (7 configs); unit tests (core 250, site 48); `v20_func.py` (124 checks, including the new flow and the private key absent from every request, call and storage after linking and the automatic re-checks); the tint audit (0 found); functional checks v14, v15, v17, v19 and v19.1; layout stability at 1440 and 390; contrast (2,671 elements, 0 below AA); the sandbox (zero console errors); the old-name crawl and grep (zero hits).


## 13. v21: the subtraction pass

The panel says less. Nothing was added and nothing was removed from the product: the detail moved into the **?** help panel (now opened by a click, not always on), hovers and **Advanced** / **More** disclosures. Rendered text across 19 pages fell 20% (the first screen, 29%); the per-page numbers and what moved where are in `design-critique-v21.md` (site repo). As before, everything ran offline against the preview's mock API and the agent's local mocks.

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 250, site 48: all pass; relay worker ok |
| Agent e2e (local mocks) | 35 / 35 |
| Functional checks v8–v20.1 | All pass. Selectors were updated where an element moved, not where behaviour changed: Pause and Kill in the top bar, the agent's details in its hover, Advanced opened in Strategy & safety, the Portfolio wallets disclosure, the coin page's fee summary, and a Tab order next to the status bar's new details popover |
| Notification timing (v18.1) and exit frames | Pass |
| Layout stability at 1440 and 390 | No element moves |
| Tint audit | 0 tinted label / icon patterns |
| Sandbox (file://, sandboxed iframe) | Zero console errors |
| Contrast | 2,503 text elements, 0 below AA; chart and X card pass |
| Docs | 38 pages check out |
| Readiness audit | 96 page views, 0 problems |
| Perf | 0 steps over 200 ms, 0 page errors |
| Old name | Zero hits (66 pages + 11 settings tabs, and grep) |

One fix came out of the checks: when the help panel appeared on field focus, it could shift a drawer's layout between pressing and releasing a button, so a click missed (Copy trade's "Reset"). The panel now appears only from a **?** click, everywhere, and follows focus while it's open.

## 14. v21.1: Holder access and the wallet pop-ups

Holder access got two equal option cards, a calmer status hero (the big number over its threshold, a 2 px bar, the state dot), identicons in the wallets table, and the QR in a soft frame beside the address. "Connect a wallet" is now a four-step dialog (Choose wallet → Approve connection → Sign message → Linked) with a state for each step and a retry when the wallet turns something down. "Create a holding wallet" is three steps (Your new wallet → Save it → Link). Every wallet pop-up shares one modal system (`components/WalletModal.tsx`, `styles/v21_1.css`).

What this round could not test: a real Phantom, Solflare or Backpack extension. The connect flow ran against a test-only Wallet Standard wallet (`tools/test_wallet.js`) in the offline preview, whose mock backend doesn't check a connected wallet's signature. Try the flow with each real wallet before launch.

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 250, site 48: all pass |
| `v21_1_func.py` (new) | 38 checks pass: the option cards, hero, table and unlink; the wallet list (detected first with the wallet's own icon, Install links, initial tiles); each step, a rejected connection and a rejected signature with retry, linked with address and balance; the create steps; one system across four wallet dialogs; 390 px |
| Holder checks (`v20_func.py`, including v20.1) | Pass, with the private key in no request, API call, postMessage or storage (the intercept test) |
| Functional checks v8, v10, v12, v12.1, v12.2, v15, v17, v19, v19.1 | Pass |
| Layout stability at 1440 and 390 | No element moves |
| Contrast | 2,586 text elements, now including the new dialogs, 0 below AA |
| Tint audit, sandbox, docs, old name | 0 tinted patterns; zero console errors; 38 pages check out; zero hits |

## 15. v22: the launch flow

The "New launch" panel was redesigned (step line, live coin preview, calm launchpad tiles, a segmented "Launch from", Advanced for tip / priority / slippage) and the never-list paragraph left the UI (the guardrails still enforce it in core). A dev buy no longer needs a Jito tip or priority fee: create + dev buy is one transaction through your RPC; team wallets still go as one bundle with an automatic 0.0001 SOL tip.

**Verify on first live launch** (network was blocked; these ran only against mocks):

| Setting | What to check | Where |
|---|---|---|
| pump.fun quote pairs USDC and USD1 | That pump.fun offers them at create; that PumpPortal's create request takes the field `quoteMint` (a mint for USDC; USD1's mint isn't filled in, so its symbol is sent); how the dev buy is denominated with a non-SOL pair | `core/src/launch/capabilities.ts` |
| Creator rewards "To holders" | The create field and value (`creatorFeeRecipient: "holders"`) | same file |
| No-tip dev buy | That a create + dev buy sent through your RPC without a tip lands reliably; if not, set a tip under Advanced | `core/src/launch/plan.ts` |
| Browser-wallet launch | Sign with a real Phantom, Solflare and Backpack | the panel |

If PumpPortal rejects one of the unverified fields, the build fails before anything is signed or sent.

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 253 (v22: 3 new), site 48 |
| Agent e2e (local mocks) | 36 / 36, including "create + dev buy as one transaction, no tip" and "USDC quote pair and holder rewards reach the create request" |
| `v22_func.py` (new) | The whole flow in the preview: browser wallet (test-only Wallet Standard wallet) and agent wallet, Standard with disclosed team wallets and Manual, quote pair, creator fees, review, launch, landed; 390 px |
| Functional checks v8–v21.1 | All pass. Selectors updated where the launch flow moved ("Continue", the segmented "Launch from", the header line that replaced the Manual badge), not where behaviour changed |
| Notification timing and exit frames | Pass |
| Layout stability at 1440 and 390 | No element moves |
| Contrast | 2,824 text elements, now including every launch step, 0 below AA |
| Tint audit | 0, now also scanning the launch sheet at each step and the wallet dialogs (it found the "Team" role tag's fill, now plain text) |
| Readiness audit | 96 page views, 0 problems (it found the holder table's unlink had lost its focus ring in v21.1; fixed) |
| Sandbox, docs, perf, old name | Zero console errors; 38 pages check out; 0 steps over 200 ms; zero hits |

## 16. v23: Claim, the creator fee per pair, the launch flow finished

A **Claim** page under Agent (after Portfolio): what's claimable per asset (SOL, and USDC / USD1 for coins on those pairs), one row per launched coin, Claim / Claim ▾ → Claim and swap to SOL / Claim all (one claim per asset), Swap to SOL with Jupiter's quote and your slippage before anything is signed, each claim's lifecycle in one notification with Retry, and **Cleanup** (was Wallets → Recover rent; the old link redirects to `/app/claim#cleanup`). The same claims from `vesk claim [--all] [--swap]`, chat ("claim my fees"), Telegram and MCP. On Launch, a non-SOL pair gets a 1–3% creator fee (slider and preset chips) and a SOL pair gets no fee control at all; the launchpad step, review and success card were finished. It folds in an unreleased v22.1 round. Everything ran offline, as before.

**Verify on first live launch** (network was blocked; these ran only against mocks):

| Setting | What to check | Where |
|---|---|---|
| Non-SOL claim | Claim a USDC-pair coin's creator fees: that PumpPortal's `collectCreatorFee` takes `quoteMint` (USDC's mint) and pays USDC to the creator wallet; whether one claim collects every USDC-pair coin of that wallet (Vesk assumes it does, as for SOL); what USD1 needs (its mint isn't filled in) | `core/src/launch/capabilities.ts` (`claim`), `launch/claim.ts` (`claimCovers`) |
| Creator fee range param | Launch a USDC-pair coin with a 1.5% fee: that pump.fun offers 1–3% in 0.5 steps on non-SOL pairs (`creatorFeeRange`) and the create request takes `creatorFeeBps` (150). On a SOL pair nothing is sent | `capabilities.ts` (`creatorFeeRange`, `createParams.creatorFee`), `launch/plan.ts` (`createParams`) |
| Swap to SOL | Swap a few claimed USDC to SOL from Claim at 1%: the quote's "at least" holds, it lands, the SOL arrives | `trade/executor.ts` (`quoteToSol`, `swapToSol`), the hosted `claim-swap-quote` and `claim-swap` |
| Unclaimed amounts | Wire a source: the hosted panel and the agent show "Not reported" (claiming still works) | the hosted `creator-fees`, `claim.ts` (`rowsFromLaunches`) |
| SOL claims and SOL launches | Unchanged: the tested `collectCreatorFee`; no fee field on a SOL create | – |

If PumpPortal or Jupiter refuses one of these, nothing is signed or sent; the panel, the CLI and the review say "verify on first live launch".

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 261 (v23: 6 new, `test/v23.test.ts`), site 48; relay worker ok |
| Agent e2e (local mocks) | 40 / 40, including "v23 creator fee range" (200 bps sent for 2%; a fee on SOL, 2.25% and 3.5% refused), "v23 vesk claim --all --swap" (SOL claim plain, USDC claim with `quoteMint`, the quote shown, the swap through mock Jupiter, the treasury line in USDC) and "v23 chat: claim my fees" |
| `v23_func.py` (new; supersedes the unreleased `v22_1_func.py`) | 87 checks: sidebar, ⌘K and the old link; the per-asset hero and its sums; rows, marks and name-only fallbacks; holder and browser-wallet rows; the lifecycle toast; one claim per asset; Swap to SOL with slippage; Claim and swap; Claim all; error and Retry; empty and nothing-to-claim; Cleanup; panel chat; the launch pair tiles, no fee on SOL, the fee slider and chips, review, create params and success; 390 px |
| Functional checks v8–v22 (with v12.1, v12.2, v18.1, v19.1, v21.1) | All pass. Selectors updated where an element moved, not where behaviour changed: StonkFun is in the "Soon" list now (`v19_func.py`, `v22_func.py`) and the quote section's "?" has a second "?" beside it on USDC (`v22_func.py`) |
| Notification timing (v18.1) and exit frames | Pass |
| Layout stability at 1440 and 390 | No element moves, now including Claim's row actions, "Claim ▾", a claim from start to finish, and the fee slider and chips |
| Contrast | 3,076 text elements, now including Claim's menu and dialogs, 0 below AA |
| Tint audit | 0 tinted label / icon patterns, now also scanning Claim's menu and dialogs |
| Readiness audit | 100 page views, 0 problems |
| Sandbox, docs, perf, old name | Zero console errors; 39 pages check out; 0 steps over 200 ms; zero hits (68 pages + 11 settings tabs, and grep) |

One bug fixed along the way: `vesk launch --quote` and `--creator-fees` (v22) weren't registered with the CLI's argument parser, so they parsed as `true` and a USDC launch from the CLI failed validation. They're registered now, with `--creator-fee`.

## 17. v24: atmosphere, flows that end in a plan, sounds, the docs

The "premium feel" round: Proxima's craft studied from recordings and screenshots (design-notes.md, "Proxima study (v24)"), done in Vesk's own theme. Nothing from their feature set was built (no block-0 or MEV layers, no CEX or obfuscated funding, no activity generation, no wallet marketplace). What changed: rendered art (`public/art/`, made by `tools/art_render.py`) beside focus pages and behind the framed app from 1680 × 820 up; Claim, Holder access, Launch, Portfolio and Overview with hero cards, banner strips and corner ticks; "Advanced settings (optional)" disclosures across Strategy & safety, Launch, Instant Trade, Copy trade, Rules and Settings; dialogs in steps (edit → plan → progress → done) for Withdraw, Fund, Import, Return all, Create wallet, Folders, Claim all, Cleanup, the Rogue confirm and two new ones (Auto-sell on a coin page, Sell into big buys on Strategy & safety, both saving through existing actions); the sidebar's hover highlight and wallet selector; the status bar's prices and links; four animated diagrams; synthesized sounds; the docs (⌘K dialog, light theme, steps with screenshots, diagrams, view transitions, changelog); sign up and log in as one card.

No migration. One new read-only function action, `claim-history` (your SOL claims from `treasury_events`).

**Before launch, check in a real browser** (the sandbox had Chromium only and no network):

| What | What to check | Where |
|---|---|---|
| Prices in the status bar | Binance's public 24 h ticker answers from the deployed origin (CORS) and refreshes once a minute while the tab is visible; the preview shows sample prices, labelled | `src/lib/ticker.ts` |
| Sounds | Safari (desktop and iOS, including the silent switch) and Firefox: nothing plays before the first click, the volume is low, Do not disturb silences notification sounds | `src/lib/sounds.ts`, Settings → Sounds |
| The framed app | On a 1920 × 1080 and a 2560 × 1440 screen: the panel floats on the backdrop, scrolls inside itself, a page change starts at the top, find-in-page and keyboard scrolling work | `.app.framed` in `src/styles/v24.css` |
| Art files | `/art/*.webp` are deployed with the site and cached; the Low resource profile hides them | `public/art/`, `src/lib/art.ts` |
| Docs view transitions | Chromium cross-fades between docs pages; Safari and Firefox navigate plainly | `pages/Docs.tsx` (`useViewTransitions`) |
| Docs light theme | Read a few pages, tables and code blocks in light | `src/styles/v24_docs.css` |
| Claim chart | The deployed function's `claim-history` returns your SOL claims; Volume stays "Not reported" until a source is wired | `supabase/functions/vesk/index.ts` |

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 261, site 48 (the holding-wallet test needs `tweetnacl`: there is no npm registry here, so it ran against a local copy linked for the run); relay worker ok |
| Agent e2e (local mocks) | 40 / 40 |
| `v24_func.py` (new) | 148 checks: art, corner ticks, banner strips and the top highlight, the framed app at 1920 and none at 1440, Low resource; each disclosure (its divider, a height transition that leaves the divider in place, content unmounted when closed); the dialog flows step by step with the requests they make; sounds with a spied AudioContext (nothing before a click or key, the master switch, volume, categories, previews, quieter under reduced motion, the docs' click); the four diagrams (play on screen, pause off screen, one still frame under reduced motion); the sidebar's sliding highlights and wallet selector; the status bar; the launch blueprint; the docs (⌘K, the light theme at AA, the sliding highlights, view transitions, Copy link / Copy for AI, steps with screenshots); sign up and log in with the error state; no page errors |
| Functional checks v8–v23 (with v12.1, v12.2, v18.1, v19.1, v21.1) | All pass. Selectors updated where an element moved, not where behaviour changed: the docs search is a dialog (`v12_2_func.py`, `contrast_live.py`), the main action in a dialog is the white button (`v21_1_func.py`, `v23_func.py`), Claim all runs in its dialog and an account with no coins gets one empty state in the hero (`v23_func.py`), the launchpad tiles and step tabs moved (`v19`, `v22`, `v23`), Holder access's link button and status (`v20`, `v21_1`) |
| Notification timing (v18.1) and exit frames | Pass |
| Layout stability at 1440 and 390 | No element moves |
| Contrast | 3,368 text elements, now including the docs' search dialog and light theme, 0 below AA |
| Tint audit | 0 tinted label / icon patterns, now also scanning the new dialogs, the sidebar's wallet menu, sign up, log in and the docs |
| Readiness audit | 100 page views, 0 problems |
| Sandbox, docs, perf, old name | Zero console errors; 40 pages, 8 images and 4 diagrams check out; 0 steps over 200 ms; zero hits (69 pages + 12 settings tabs, and grep) |

Found and fixed along the way: the page art made the window 12 px wider than the screen on Claim and Holder access (the content column clips it now); code blocks were unreadable in the docs' light theme (they stay a dark panel); Claim with no coins said "No coins launched yet" twice; the backdrop's dot texture was repainted on every page change (about 40 ms per navigation; it's one screen tall on its own layer now).

## 18. v24.1: the rest of the panel in the v24 look

Pulse → Display, the Settings modal (every section), the claim flow (Claim, Claim all, Claim and swap, Swap to SOL) with its progress inside the dialog, Rules (cards, the builder as a step dialog, the paper test, templates), the end of sign-up and Connect a wallet, in the v24 system; the holder flows on the new step indicator; every dialog a bottom sheet under 640 px (design-notes.md "v24.1"). No migration, no new function action. Claim and swap is now a `claim-fees` request followed by a `claim-swap` request, so its progress is honest.

**Before launch, check in a real browser:**

| What | What to check | Where |
|---|---|---|
| Claim and swap on the deployed function | A USDC claim followed by its swap: two transactions, the dialog's Claiming then Swapping, a failed swap retried alone | `components/ClaimFlow.tsx` |
| Sounds on the sign-up page | Safari and Firefox: the chime on "You're in." after the clicks on that page | `pages/Auth.tsx` |
| Bottom sheets on real phones | iOS Safari and Android Chrome: a sheet clears the home indicator, the keyboard doesn't cover a focused field | `styles/v24_1.css` |
| Wallet logos | Drop the official `phantom.svg`, `solflare.svg`, `backpack.svg` into `public/logos/` (none ship); they appear on the next build | `public/logos/README.md` |

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 261 (with the e2e web3 shim), site 48 (with a local `tweetnacl` linked for the run); relay worker ok |
| Agent e2e (local mocks) | 40 / 40 |
| `v24_1_func.py` (new) | 143 checks: the Display popover, every Settings sub-section, the claim dialog end to end (single, all, claim and swap, swap to SOL, a failure and Retry failed, the requests in order), Rules (cards, builder steps, paper test, templates), sign-up done, Connect a wallet with and without a wallet, the holder flow, bottom sheets at 390, and the polish pass (the rule sentence's punctuation by text geometry, ruled rows, the hero back in view after a claim, the ≈, short Settings lines, the custom theme disclosure, the holder note word for word, the logo-file wiring) |
| Functional checks v8–v24 (with v12.1, v12.2, v18.1, v19.1, v21.1) | All pass |
| Notification timing and exit frames | Pass |
| Layout stability at 1440 and 390 | No element moves |
| Contrast | 5,764 text elements, 0 below AA (the first run this round found 91 on the new surfaces; fixed) |
| Tint audit | 0 tinted label / icon patterns |
| Readiness audit | 100 page views, 0 problems |
| Sandbox, docs, perf, old name | Zero console errors; 40 pages, 9 images and 4 diagrams check out; 0 steps over 200 ms; zero hits |

Found and fixed along the way: small labels on the atmosphere surfaces were under AA (ink-4 is lifted there); inactive settings rows faded their words (now only the switch dims); a comma could start a line in the rule sentence; the claim's landed moment happened off screen when the claim started low on the page; the hero's SOL total lacked ≈ with only USDC waiting.

## 19. v25: three ways to launch, burn and lock supply, chat, docs and home

The Launch landing as three alternatives with scenes in the current UI (the post scene uses a fictional account); the sidebar without its More fold; Connect a wallet and the holding wallet, second pass; **Burn supply** (panel, CLI, MCP, chat, Telegram; one SPL `BurnChecked`, disclosed); **Lock supply** shown as Coming soon (Streamflow not verified, no program ID guessed); chat polish; docs without badges or "example" stamps, Claim's creator fees and Cleanup explained apart, every screenshot re-taken; "Features" in the headers; the home page's visuals refreshed with one footer line for sample imagery. No migration. The function's `burn` action now requires `confirm: true`.

**Before launch, verify live:**

| What | What to check | Where |
|---|---|---|
| Burn | On devnet, or with a throwaway coin on mainnet: burn a small share from the dev wallet (hosted and self-hosted). The supply drops by exactly that amount, the treasury report lists the transaction, and an agent running the coin posts the line | `core/src/coin/supply.ts`, `Executor.burn`, `supabase/functions/vesk/index.ts` `burn` |
| Token-2022 burn | A Token-2022 mint burns through its own program (the instruction is the same; the account derivation uses the mint's program) | `Executor.burn` |
| A 100% burn | The dev wallet's token account is left at exactly 0 (the planned base units are sent, not a re-rounded number) | `burnPlan`, `Agent.burnSupply` |
| Lock | Stays "Soon" until Streamflow's program ID and its SDK's create call are checked against their docs and a devnet run; then implement `LockAdapter.build` and set `STREAMFLOW.programId` / `verified` | `core/src/coin/supply.ts` |
| MCP and Telegram burn | `vesk_burn_plan` then `vesk_burn_supply` with `confirm: true`; Telegram's Burn / Cancel buttons | `mcp/src/index.ts`, `telegram/src/index.ts` (type-checked only) |
| Wallet logos | `phantom.svg`, `solflare.svg`, `backpack.svg` from each wallet's press page into `public/logos/` | `public/logos/README.md` |

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 268 (7 new in `v25.test.ts`, with the e2e web3 shim), site 48 (with a local `tweetnacl` linked for the run); relay worker ok |
| Agent e2e (local mocks) | 41 / 41, including `vesk burn` (plan, refusals, `BurnChecked` executed and checked by the mock chain), chat burn and `vesk lock` (Soon, nothing sent) |
| `v25_func.py` (new) | 101 checks: the landing, the sidebar, Connect and the holding wallet, Burn (plan, gate, the request, progress, done, error, from Your launches, the phone sheet), Lock, chat, docs, header, home |
| Functional checks v8–v24.1 | All pass. Updated where the brief changed behaviour: `v12` and `v13` (the landing's scenes), `v20` and `v24` (diagrams carry no "example" stamp; launch on post is the scene; lazy images on the longer Claim page), `contrast_live.py` and `v24_1_shots.py` (open disclosures one at a time) |
| Notification timing and exit frames | Pass |
| Layout stability at 1440 and 390 | No element moves |
| Contrast | 5,726 text elements, 0 below AA |
| Tint audit | 0 (the first run found 3: filled ice step nodes, the illustrated white button and a filled "Install" pill; the nodes and the pill were reverted to hairlines and words, the illustration was allowed like the v13 one) |
| Readiness audit | 100 page views, 0 problems |
| Sandbox, docs, perf, old name | Zero console errors; 40 pages, 12 images and 6 diagrams check out; 0 steps over 200 ms; zero hits |

## 20. v25.1: sign-up done, quote pairs, loading sequences, docs examples

"You're in." without the boxed V tile (the type leads; one band of light crosses the card top). Quote pairs driven by one registry (`core/src/launch/capabilities.ts` `PUMPFUN_PAIRS`: symbol, name, mint, logo slot, status per asset; mints read only from `core/src/data/programs.ts`), shown as tiles plus a searchable **More pairs** list where anything unverified reads *Not available yet* and can't be picked. A boot splash on panel routes, page-shaped skeletons that crossfade into content, busy buttons that keep their width, a progress line on working dialogs, images that fade in. Docs: command blocks with a prompt and Copy, Panel / CLI / Chat tabs, numbered captions, diagrams framed like screenshots. No migration.

USD1 now sends its mint (`USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB`, from `data/programs.ts`) in create and claim requests and can be swapped to SOL; before v25.1 it was sent without one.

**Before launch, verify live:**

| What | What to check | Where |
|---|---|---|
| pump.fun's pair list | Open pump.fun's create screen and copy every quote pair it offers into `PUMPFUN_PAIRS`, one line each (`offered: "reported"` until a live launch on it works, then `"ready"`). Add each mint to `QUOTE_MINTS` from the issuer's own page, never from memory. Until then only SOL, USDC and USD1 are selectable | `core/src/launch/capabilities.ts`, `core/src/data/programs.ts` |
| USD1's mint | It is on disk in one place only (`data/programs.ts` `QUOTE_MINTS`, used for Pulse's pool parsing); confirm it against the issuer's page before the first USD1 launch, claim or swap | `core/src/data/programs.ts` |
| USDT | Its mint is on disk twice (`data/programs.ts`, `core/src/ca.ts`); whether pump.fun offers it as a pair isn't confirmed, so it shows *Not available yet*. If the create screen lists it, set `offered: "reported"` | `PUMPFUN_PAIRS` |
| Pair logos | `usdc.svg` and `usd1.svg` from each issuer's press kit into `public/logos/` (Tether's mark is Simple Icons', already on disk) | `public/logos/README.md` |
| Boot on a real deploy | The splash shows on `/app` routes only and hands over in under 1.5 s on a cold load from the CDN (`performance` mark `vesk-boot-done`); a slow network shows the page skeletons after it, never a blank screen | `index.html` `#boot`, `src/lib/boot.ts`, `tools/perf_check.py` |

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 269 (pairs registry, USD1 mint in create and claim requests), site 48; relay worker ok |
| Agent e2e (local mocks) | 41 / 41 |
| `v25_1_func.py` (new) | 121 checks: sign-up done (1440, 390, reduced motion), the pair registry and picker, the boot, route skeletons and the crossfade on three pages, axis-first charts, busy buttons and the dialog footer line, image fade, the docs |
| Functional checks v8–v25 | All pass. `v24_1_func.py` updated (it checked for the V tile) |
| Notification timing, layout stability at 1440 and 390 | Pass; no element moves |
| Contrast | 5,727 text elements, 0 below AA |
| Tint audit, readiness audit | 0 patterns; 100 page views, 0 problems |
| Sandbox, docs, perf, old name | Zero console errors; 40 pages, 13 images, 6 captioned diagrams and 2 tabbed blocks check out (`docs_check.mjs` now requires diagram captions); 0 steps over 200 ms and the boot handed over at 509 ms (budget 1,500); zero hits |

## 21. v26: launch on posts as a rule system, custom pairs, logos

Launch on posts is a full rule system: a nine-step builder (Template, Accounts, Triggers, Coin, Pair & fees, Buy, Exits, Safety, Plan), accounts in priority order with one launch per topic, include/exclude phrases and regex, explicit velocity (off by default), Short / Literal / Punny names or **Ask me** on the confirm card, a square crop around a focal guess, a ticker clash check that also matches the image, race reports, a backtest that falls back to the tracker's stored posts, per-rule stats and a launch lane on Live. Rules can also live in the config file (`launchRules:`). Custom pairs come from one registry (`core/src/launch/pairs.ts`: SOL, 32 listed with mints from a third-party list, 22 *Not available yet*), every mint is read on chain before a create, and pairs seen in live creates join as *Discovered*. Official logos are wired where they're on disk; every other slot is a neutral glyph with a drop-in file name. No migration beyond the one listed in START-HERE.

**Before launch, verify live:**

| What | What to check | Where |
|---|---|---|
| The pair list | Open pump.fun's create screen and compare its quote pairs with `pairs.ts`. Each listed mint came from Terminalpedia's list; confirm it on the issuer's page. A pair the screen offers that we mark *Not available yet* gets its mint from the issuer (never from memory); one we list that the screen doesn't offer goes to `U()` | `core/src/launch/pairs.ts`, `research/pumpfun-custom-pairs.md` |
| Create parameters for a custom pair | The names pump.fun expects, all marked TODO-verify in code: `quoteMint`, `creatorFeeBps` (0.05%-1%), `cashback`, `creatorFeeRecipients` (up to 10, by share), and a dev buy in the pair asset. All are flagged *verify on first live launch* in the UI and docs | `core/src/launch/capabilities.ts` `createParams`, `launch/pumpfun.ts` |
| PumpPortal's new-token stream | The field that carries a create's quote mint (we try `quoteMint`, `quote_mint`, `quoteTokenMint`, `quote`; none seen live yet), and the `image` in the coin's metadata (fetched from its `uri`) used for image matching | `core/src/launch/discovery.ts` `quoteMintOf`, `core/src/watch/creates.ts`, `relay/worker.mjs` |
| Mint check against a real RPC | NVDAx (Token-2022) and USDC (Token) pass; a wrong address is refused before anything is built; a freeze authority shows in the line, not as a refusal | `core/src/launch/mintcheck.ts` |
| Image matching | Copies of a post's picture on pump.fun are often re-encoded JPEG/WebP: SHA-256 catches exact copies, the dHash only PNGs. Measure the hit rate on a few real races before relying on it | `launch/imagecrop.ts` `imageHashes`, `launch/clash.ts` |
| Priority hold and topic dedupe | With two real accounts posting the same news, the higher one wins when the hold is set and the first one wins at 0; one launch per topic | `agent.ts` `onLaunchPost` |
| Ask me | The Telegram suggestion buttons and `/launch <id> Name $TICKER` name the draft; an unnamed draft can't launch; it expires on time | `telegram/src/index.ts`, function `launch-decide` |
| Race reports | Rank and gap against what pump.fun's own list shows for one real post | `launch/race.ts` |
| Logos | Drop the official files listed in `public/logos/README.md` (pump.fun, Jupiter, Jito, Phantom, …); `LOGOS-LOVABLE-PROMPT.txt` is the prompt to have them added | `site/vesk-site/public/logos/` |

| Check | Result |
|---|---|
| Type-check (7 configs) | Pass |
| Unit tests | Core 295 (pairs registry and statuses, mint check incl. freeze authority and wrong decimals, discovery merge, focal crop, image hashes, image clash, race label, templates, priority, regex, Ask me, tracker backtest, the example config), site 48; relay worker ok |
| Agent e2e (local mocks) | 44 / 44, incl. the pair validation step (NVDAx and ZEC verified, HYPE no account, xSOL not a mint, USDT wrong decimals, a launch on xSOL refused with nothing built) and a launch-on-posts step (clash skip, Ask me naming, race "1st of 2", backtest from the tracker's stored posts) |
| `v26_func.py` (rewritten) | 162 checks: rule list and stats, the Ask-me draft, every builder step at 1440 (and to Triggers at 390), the pair picker's categories, statuses and search, fees, the Telegram card, the backtest, the success mark, Live's launch lane, races, Claim without a swap, logos and the bento posts, scrollbars, skeletons at `?slow=1500` |
| Functional checks v8–v25 | All pass. Updated where v26 changed what they checked: `v19_1` (the source is "Launch on posts"), `v22` (pump.fun shows a neutral glyph in its logo slot; the creator-fee help wording), `v23` (USDC's neutral glyph; 7 coins on Claim), `v24_1` (the green success mark), `v25` (no badge on a third-party post), `v25_1` (the new statuses) |
| Layout stability at 1440 and 390 | Pass (the fee chips are the custom-pair presets now) |
| Contrast | 6,812 text elements, 0 below AA |
| Tint audit, readiness audit | 0 patterns (the Telegram card's keys and the verified mark allow-listed); 100 page views, 0 problems |
| Sandbox, docs, perf, old name | Zero console errors; 40 pages and 21 images check out; 0 steps over 200 ms, boot handed over at 499 ms; zero hits |
