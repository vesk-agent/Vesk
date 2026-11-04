# Trading settings

One place for how your trades are sent. Open it with the **P1** button in the top bar, from Pulse, or with `vesk trading` in the CLI. The settings are saved to your account, and a paired agent pulls them with your rules.

They're used everywhere a trade starts: Pulse quick-buy, the coin page's trade panel, Instant Trade, Tracker **Buy CA**, rules that name a preset, and `vesk buy --preset p2`.

## In the panel

The **P1** button in the top bar opens Trading settings; the coin page's trade panel and Instant Trade show the active preset and switch it with one click. The settings modal's **Trading** tab has sub-tabs: Presets, Hotkeys, PnL & chart, Wallets and Migration.

## From the terminal

```bash
vesk trading                         # show
vesk trading active p2               # active buy preset (add --sell for sells)
vesk trading export --out t.json     # and: vesk trading import t.json
vesk buy <mint> 0.1 --preset p2
vesk snipe @handle --sol 0.1 --preset p3   # the rule stores the preset
vesk pulse --filter f.json --buy 0.1 --preset p2 --max 1
```

A rule with a preset reads the preset when it fires, so changing P3 changes every rule that uses P3.

## Settings

### Presets: P1, P2, P3

There are three buy presets and three sell presets. Each one has:

| Field | What it does |
|---|---|
| **Slippage %** | The most the price may move against you before the trade fails. |
| **Priority fee** (SOL) | Paid to the validator to order your transaction sooner. |
| **Jito tip** (SOL) | Paid to the Jito block builder when the trade goes as a bundle. |
| **Auto fee** + **max** | Uses your RPC's recent prioritization fees (median of `getRecentPrioritizationFees` × 200k compute units) instead of the fixed fee. The fixed fee is the floor and **max** is the cap. |
| **MEV protection** | Off, Reduced or Secure (below). |

One buy preset and one sell preset are **active**; trades use them unless you pick another. **1/2/3** switch the active buy preset.

Defaults (buy): P1 15% / 0.0005 SOL, sent normally. P2 20% / 0.001 SOL with a 0.001 SOL tip, Reduced. P3 25% / 0.003 SOL with a 0.003 SOL tip and auto fee up to 0.01 SOL, Reduced. Sell presets are the same except P3 sells allow 30% slippage, without auto fee.

### Quick amounts, wallet, confirmation

- **Quick amounts**: four buy amounts (SOL, default 0.05, 0.1, 0.25, 0.5) and four sell percentages (25, 50, 75, 100), used as the chips on the coin page's trade panel, by Tracker **Buy CA** (the first buy amount) and by the Pulse quick sell (the second sell %). Instant Trade has its own chips ([Instant Trade settings](29-instant-trade.md#settings)).
- **Trading wallet**: the one wallet buys come from. Buying the same coin from several of your wallets is refused (coordinated buying). Sells can come from every wallet that holds the coin.
- **Ask before trades above**: buys bigger than this ask for confirmation (default 1 SOL). 0 never asks. Instant Trade can set its own.
- **Slide to confirm** (Settings → Trading → Presets, off by default): above that size, the trade button on the coin page and in Instant Trade's amount view becomes a slide. Drag the handle to the end (or focus it and press Enter); the slide is the confirmation, so no dialog follows. Smaller buys stay one click, and hotkeys still use the dialog.

### Hotkeys

Defaults: **B** buy with the active preset, **S** sell 50%, **T** Instant Trade, **1/2/3** switch preset, **Esc** close. Click a key box and press the key you want; add or remove rows. Hotkeys don't fire while you type in a field or while a dialog is open. **B** acts on the most specific thing in front of you: Instant Trade when it's open, else the Pulse row under your pointer, else the coin page you're on.

## MEV protection

- **Off**: sent through your RPC. If Jito is on in your setup and the preset has a tip, it goes as a Jito bundle instead.
- **Reduced**: sent **only** as a Jito bundle (your trade plus the tip transfer) to the block engine. It never goes to the public mempool or your RPC's `sendTransaction`. If the bundle doesn't land, the trade fails instead of falling back. Needs a tip of at least 0.0001 SOL.
- **Secure**: Reduced, plus slippage capped at 10% so a sandwich has less room.

Neither mode makes a trade private or guarantees a price. A bundle can still be outbid, and a validator that doesn't run Jito won't include it. What these modes remove is the public-mempool path that most sandwich bots watch, even when Jito is off in your config.

## Limits and what's approximate

- **MEV modes reduce exposure; they don't guarantee anything.** A bundle can be outbid, and a validator that doesn't run Jito won't include it.
- **Auto fee** is a median of recent prioritization fees from your RPC, capped by your max; a busy moment can still need more.
- **One wallet buys a coin.** Buying the same coin from several of your wallets is refused.
- **A rule with a preset reads it when it fires,** so changing P3 changes every rule that uses P3.
