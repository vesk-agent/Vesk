# Pulse settings

Settings shape how Pulse and the rest of the panel look and behave: columns and layout, what a row shows, metric colours, hover previews and the quick-buy button. They're saved to your account, and in your browser so reloads are instant.

## In the panel

Open **Settings** from the gear in the top bar or the Pulse toolbar. Every control changes Pulse at once. **Reset all** goes back to the defaults; **Extras → Import / export** saves everything as one JSON file.

The modal has its title and a **search field** at the top (search filters every setting across all sections as you type; groups that are normally folded away open while you search, so nothing is hidden from it). On the left, the sections with an icon each, in three groups: **Pulse** (Layout, Row, Metric colors, Hover previews, Quick buy), **Alerts** (Notifications, Sounds, Tracker) and **Panel** (Trading, Appearance, Performance, Extras); a highlight slides to the one you pick. Each section starts with its name and one line, then its sub-sections as tabs with a sliding underline (for example Layout → Display / Row elements / Mini chart / Table order; Trading → Presets, Hotkeys, PnL & chart, Wallets and Migration; Extras → Discovery, Blacklist, Import / export). The header stays at the top while the settings scroll; a thin line appears under it once you've scrolled. It reopens on the section you used last. On a phone the sections are a row you scroll sideways and Settings opens as a sheet from the bottom.

Settings come in groups under a small label. Choices are **visual tiles**: each option is drawn as a small preview, and the chosen one is outlined in ice with two corner ticks; several sections show a live preview of a sample row that follows your choices. On/off settings are switches on the right, and fields carry their unit (%, SOL, s) inside them. Rarely changed groups sit under a divider marked **(optional)**, closed until you open it. Every **?** opens its help on click, tap, Enter or Space; Esc or a click outside closes it.

### Keyboard

Click into Pulse and use:

- **↑ ↓** to move through a column, and **← →** to switch columns;
- **Enter** to open the coin, **Esc** to clear;
- **B** to quick-buy the focused or hovered row.

In Space mode (Settings → Trading), it's **Space+B**.

## Settings

Performance profiles (Low resource, Auto, Full speed) have their own page: [Performance profiles](31-performance.md). Themes and fonts: [Appearance](23-appearance.md).

### Layout

- **Column order**: drag New pairs, Final stretch and Migrated into any order, or use the arrows. Example: Migrated on the left.
- **Show / hide** each column. At least one stays visible.
- **List or grid**: in grid view, the columns stack, and each one shows coins as tiles, several per line.
- **Wallet switcher**: the trading-wallet picker sits on the left or right of the toolbar. Changing it changes your trading wallet; buys still come from one wallet.
- **Header sync**: one quick-buy amount for every column, set in the toolbar, instead of one per column.
- **Search bar**: filters every column by name, ticker or contract address.

### Display

| Setting | What it changes |
|---|---|
| Metrics size | Small or Large numbers in every row (the tile shows "MC 77K" at each size). |
| Spacing | Compact, normal or comfy rows. |
| Table density | Spacing in the audit strip. |
| Image size / shape | 28-56 px; square (the default) or circle. |
| Progress bar | A ring around the image, or a bar under it. |
| Spaced tables | Merged (one table, hairlines between columns) or Spaced (a panel per column). |
| Volume placement | Next to the market cap, or in the audit strip. |
| Rounded market caps | $63.7K instead of $63,712. |
| Bonding % on hover | Hover the image to see the curve %. |
| Ticker first | Ticker before the name. |
| Copy mark | The copy-CA button. |
| Show migrated / pre-migrated | Hide whole stages. |
| Show hidden tokens | Coins and devs you hid, and blacklisted ones, show dimmed instead of disappearing. **Unhide all** clears your hidden list. |

Volume placement, Bonding % on hover, Unhide on migrated, Show migrated / pre-migrated and Copy mark are under **More display options (optional)**.

The **Display** button in the Pulse toolbar opens the most-used choices as a small panel: **Rows** (spacing and metric size), **Coin image** (size and progress) and **Values** (rounded market caps, ticker first), each drawn as tiles that preview the choice, with show hidden, unhide on migrated, image shape and volume under **Advanced (optional)**, and a link to all display settings. Esc or a click outside closes it; on a phone it opens as a sheet from the bottom.

### Row elements

Each element of a row can be switched on or off, with a live preview at the top. Every element says where its value comes from: the stream, your RPC, a public API, your own lists, or *unavailable*. Unavailable elements can't be switched on, because we don't invent numbers. The full list, with how each value is computed, is in [Data sources](26-data-sources.md).

### Metric colors

For each audit (dev %, top 10 %, snipers %, insiders %, bundlers %, holders, tax %) you set:

- which direction is better (lower or higher);
- the value where it becomes good, and the value where it becomes bad.

Between those two it's neutral. You also pick the three colours. The defaults keep good values quiet, neutral values light grey, and bad values amber, because amber means a warning everywhere in Vesk. You can also set the tracked-dev highlight (the left edge of rows whose dev you track), the row border and the hover colour.

### Hover previews

- **X post**: hover an X icon that links to a single post to see its author and text. The edge function reads the post from X's public oEmbed endpoint and returns it as text; no X scripts load in the panel.
- **Token image**: a larger version of the image.
- **Mini chart**: a sparkline of the market cap over the trades Pulse has seen.

#### X card elements

Hover previews → **X card elements** shows a live preview of the X hover card with a fictional sample account, and a tile per element underneath: avatar, verified badge, renames count, blacklist button, X logo, post age, joined date, followers, pinned, reply context, quoted post, media, timestamp, bookmarks, views, likes, reposts, replies, Launch and "Read more on X". Click an element in the preview, or its tile, to show or hide it. The real hover card in Pulse uses the same switches. It draws only what the source returns: X's oEmbed gives the author, handle and text, so on live posts most extras (followers, views, media…) aren't there to show.

### Quick buy

- **After a quick buy**: stay, open the coin, or open it in a new tab.
- **Quick buy in header**: amount and preset controls at the top of each column.
- **Quick sell in rows**: an **S** button on coins you hold. It sells your second quick-sell % with the active sell preset.

### Quick-buy button

Settings → **Quick buy** has four tabs: Appearance, Style, Amounts and Holdings.

- **Appearance**: the size as tiles, each drawn as the real button: **Small, Large, Mega, Ultra**. Toggles: **Grey buttons** (quiet grey instead of the accent), and for Ultra: **Glowing Ultra**, **Border Ultra**, **Wide Ultra**. The **Low Resource** performance profile pauses glow effects; your choice is kept and returns in Auto or Full speed.
- **Style**: font (system, mono or a font name), text colour, glow (off, soft or strong, with a colour) and an optional two-colour gradient.
- **Holdings**: show the SOL you hold in a coin next to the buy amount.

**Amounts** are your four quick-buy amounts from Trading settings. Mega and Ultra buttons get their own column, so they never cover a row's numbers.

## Limits and what's approximate

- **Unavailable row elements can't be switched on.** Every element says where its value comes from; we don't invent numbers ([Data sources](26-data-sources.md)).
- **X hover cards** show only what X's oEmbed returns (author, handle, text), so most extras aren't there on live posts. The X card elements preview uses a fictional sample account.
- **The mini chart** covers only the trades Pulse has seen since it started watching the coin.
- **One wallet buys a coin**, whichever wallet the switcher shows.
