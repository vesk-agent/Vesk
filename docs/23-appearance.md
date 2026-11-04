# Appearance

How the panel looks: one of ten tested themes or your own, the font, motion and chart colours. Appearance is saved with your panel settings (your account, and this browser for instant reloads) and never changes what your agent does.

## In the panel

Settings (the gear in the top bar) → **Appearance**. Changes apply at once.

### Themes

Dark (Vesk's default), Night, Dusk, Astro, Neo, Crimson, Blue, Nord, Teal and Orange, plus **Custom**. Each built-in theme is tested: its primary, secondary and tertiary text pass WCAG AA (4.5:1) on every background in the theme, and so do its increase, decrease and yellow colours on cards. The accent passes 3:1.

### Custom editor

Under **Custom theme (optional)** below the theme tiles (it opens by itself when Custom is your theme). Colour pickers for:

- **Backgrounds**: primary, secondary and tertiary background, subtle background, chart background, canvas;
- **Strokes**: primary and secondary stroke;
- **Text**: primary, secondary and tertiary text;
- **Price colours**: increase and decrease (and their hover colours), and candle body, border and wick for up and down candles;
- **Palette**: primary green, yellow, orange, red and blue (blue is the accent).

Editing starts from the theme you had selected. The editor checks contrast as you type and lists every pair that falls below AA. It doesn't stop you from saving; it tells you. **Export / import** saves a theme as JSON (a bare object with some tokens works too; missing tokens keep their current value). **Reset to Dark** returns to the default.

### Fonts

- The panel uses **Archivo** at 92% width. Numbers use its tabular figures, so ticking values never change width.
- Code, keys and the terminal use **Geist Mono**.
- The site's big headings use **Inter Display**.

All three are open-source (OFL) and bundled, so nothing loads from a font service. **Font** in the custom editor sets any font installed on your computer, by name; empty means Archivo.

### Motion

When values change, they flash green or red for a moment. Big numbers (today's PnL, totals, a coin's market cap) roll their digits to the new value; the digits are tabular and keep their width, so nothing next to them moves. New rows slide in, and the chart's last-price label glides to the new price. Pages fade, their sections fade up once in a short stagger, tab underlines slide and dialogs spring in. Buttons press in a little when you click them. Notifications drop in from the top on a spring into a list (or a deck that opens when you point at it, with Style → Stacked); when one arrives or leaves, the others glide to their new place. Moving the Instant Trade panel never moves the page under it.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Theme | Dark | 10 built-in themes plus Custom |
| Custom tokens | Dark's | Backgrounds, strokes, text, price colours, palette |
| Font | Archivo | Any installed font by name |
| My buys / My sells | On | Your trade markers on coin charts |
| Notification position | Top centre | Just under the top bar, or **Bottom right**. Either way they move out of the way of Instant Trade and open dialogs. Also under Settings → [Notifications](32-notifications.md), with sounds, desktop notifications and Do not disturb |
| Rolling digits | On | Big numbers roll their digits when they change |

**Charts:** the chart background and candle colours follow the theme.

## Limits and what's approximate

- **Motion turns off** when your system asks for reduced motion, and in the **Low resource** [performance profile](31-performance.md): no rolling digits, entrances, press feedback or notification springs.
- **A custom font** must be installed on each computer you use; where it isn't, the panel falls back to Archivo.
- **Custom colours aren't held to AA.** The editor lists every pair below it, but lets you save.
- **Emoji are system only.** The panel doesn't draw emoji in its own chrome; coin names that contain emoji use your system's emoji font.
