# Instant Trade

Instant Trade is a small floating panel for fast buys and sells on the coin you're looking at, or any coin you paste. You can drag it anywhere, shrink it, collapse it to a bar and choose its chips. Every trade goes the same way as everywhere else in Vesk: one wallet buys a coin, sells can come from several of your wallets, and your limits, the blacklist and the guardrails apply.

## In the panel

Press **T** anywhere in the panel, or **Trade** in the top bar or on a coin page. Press **T** again or **Esc** to close it. On a coin page it opens on that coin; elsewhere, paste a contract address or pick one of your open positions.

### Move it

- **Drag** it by its header anywhere in the window. It can't leave the window, and when you let go within about 28 px of an edge it snaps to that edge.
- **Double-click** the header to dock it back to the bottom right.
- Where it sits is saved with your panel settings (your account, and this browser for instant reloads). **Remember position** in its settings keeps one spot for every page, or one per coin page (the last 50 coins).
- If the window gets smaller, the panel keeps its relative spot and stays inside.
- On a phone it's a bottom sheet and doesn't drag.

Moving it never moves the page underneath. The panel floats above the page and only its own position changes. Notifications never cover it or its header: wherever it sits, they move to the next free spot (top centre by default, then the top right, the top left or a bottom corner).

### Size and collapse

- The square button switches between **Normal** and **Compact**. Compact has smaller chips and hides the fine print.
- The chevron collapses it to a slim bar: the coin and its market cap, expand and close.

Size and collapsed state are saved too.

### Trade

- **Buy** chips buy that many SOL from the wallet picked under **Buy from**. That's your trading wallet unless you pick another. Only one wallet buys a coin.
- **Sell** chips sell that % from every wallet ticked under **Sell from**. All wallets that hold the coin are ticked at first.
- **Preset** P1, P2 or P3 picks the slippage, fees and MEV mode for the trade. The line next to it shows them; click it to edit presets.
- **Holding** and **PnL** lines sum up the wallets ticked to sell from: tokens, value in SOL, and PnL in SOL and %.
- Wallets show their names (Main, Wallet 1, … or yours). Rename one in place with the pencil.

Above your confirm size, a buy asks first. The last result shows under the wallets.

### Amount view

The amount button in its header (next to the gear) switches between the chips and an **amount view**, like a phone trading app:

- **Buy | Sell** at the top.
- One big centred amount: SOL to buy, or % of your holding to sell. Under it, roughly what it's worth.
- **10% / 25% / 50% / Max** of what's available: the buy wallet's SOL, or what you hold. **Max** keeps about 0.01 SOL plus the preset's priority fee and tip back, so the buy can still pay its fees.
- The available balance on the left and the fee on the right: the preset's priority fee and Jito tip, plus the coin's trading fee when it's known.
- One wide solid green or red button. While the trade runs it says *Processing*; when it lands a small chip floats above it ("Bought 0.3 SOL of $GLINT ✓").

With **Slide to confirm** on (Trading settings → Presets), a buy above your confirm size shows a slide in the button's place: drag the handle to the end, or focus it and press Enter. The slide is the confirmation, so no dialog follows. Smaller buys stay one click.

The view you were on is remembered. It's the same trade as a chip: the same wallet rules, preset, limits and guardrails.

### Hotkeys

| Key (default) | Does |
|---|---|
| **T** | Open or hide Instant Trade |
| **B** | Buy the first buy chip |
| **S** | Sell 50% |
| *(none)* | Sell 100%: give it a key in Trading settings |
| **1 / 2 / 3** | Switch preset |
| **Esc** | Close |

While Instant Trade is open it takes these keys first. With **Hotkeys on chips** on, a chip that has a key shows it in its corner: **B** on the first buy chip and **S** on the 50% sell chip, and the 100% chip once you give *Sell 100%* a key. Change keys in [Trading settings](21-trading-settings.md#hotkeys).

## From the terminal

There's no floating panel in a terminal. The same trades are:

```bash
vesk buy <mint> 0.25 --preset p2      # one wallet: your trading wallet
vesk sell <mint> 50                   # % of what you hold
vesk sell <mint> all
```

They go through the same executor, limits and guardrails, and ask before signing unless you add `--yes`.

## Settings

The gear in its header opens the settings tab. A live preview at the top shows the chips as you edit. **Save** applies them, **Cancel** leaves them, and **Reset to defaults** fills in the defaults.

| Setting | Default | Notes |
|---|---|---|
| Buy chips | 1 row: 0.1, 0.25, 0.5, 1 SOL | 1 or 2 rows, up to 5 chips per row, each above 0 and at most 1000 SOL |
| Sell chips | 1 row: 10, 25, 50, 100 % | 1 or 2 rows, up to 5 chips per row, 1 to 100 % |
| Opens on preset | Active | Active follows Trading settings; or always P1, P2 or P3 |
| Confirm buys above | Trading settings' value | Empty follows Trading settings |
| Hotkeys on chips | On | Shows a chip's key in its corner |
| Position line | On | Holding: tokens and value |
| PnL line | On | PnL in SOL and % |
| Remember position | Everywhere | Or one spot per coin page |
| Size | Normal | Or Compact |
| Entry | Chips | Or **Amount**: the big amount with % chips (also the button in the header) |

## Limits and what's approximate

- **One wallet buys a coin.** Buying the same coin from several of your wallets is refused (coordinated buying). Sells can come from many of your wallets.
- **Every trade passes the guardrails:** per-trade max, daily cap, kill switch, reserve and the blacklist. A trade from Instant Trade is no different from any other.
- **There's no "Initials" chip** (sell back what you paid). What a sell returns depends on price impact and fees at that moment, so a % worked out from the position's value couldn't promise your cost back.
- **Holding and PnL** come from your positions as the coin page loads them: value at the current price, cost from your fills. They're not what a sell would return.
- **Phones:** the panel is a bottom sheet with no dragging; its size and collapse still work.
