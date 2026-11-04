# Wallet names, labels and icons

Every wallet in Vesk, yours or someone else's, can have a name, a colour tag, a picture and a note, and they show wherever that wallet appears. They all live in one place, your address book, so a name you give a wallet on the coin page is the same name in Copy trade, the Tracker and Instant Trade. Small icons next to a wallet say who it is on that coin (you, the dev, a tracked wallet) and point at risks (sniper, bundled, insider).

## In the panel

### Your wallets' names

- Your main (trading) wallet is called **Main**. Your other wallets are **Wallet 1**, **Wallet 2**, … in the order you created or imported them.
- The hosted vault and a paired agent each have their own **Main**, **Wallet 1**, …: the Wallets page switches between them with **Hosted vault** / **Your agent**, and a coin page uses the wallets that trade it.
- Rename any of them in place: hover the name, click the pencil, type, press Enter. Esc cancels; an empty name goes back to the default. This works on the **Wallets** page, in the Instant Trade wallet picker, on a coin page's **Positions** tab and in **Portfolio**.
- The new name shows everywhere at once: trade rows, holders, the chart's hover card, toasts, the Trading settings wallet picker.

### Team is a role, not a name

A wallet is a **team wallet** only in a launch that used it as a disclosed team wallet. There it shows its own name with the role: **Wallet 2 · Team**, with the Team icon. That happens in the launch flow's team picker and review, and in the coin's holders and trades. Outside that launch it's just **Wallet 2**.

Names are private. A launch publishes its team wallets' **addresses** in the coin description and treasury reports, never your names for them.

Before v12.2, some wallets were stored with names like "Team A" or "Team 1". Those were roles used as names, so they now show the default name (Wallet 1, Wallet 2…), and the launches that used them still show them as Team. Any other name you had given a wallet moved into the address book unchanged.

### Labels for any wallet

The pencil on a wallet row opens **Edit wallet**: on a coin page (Trades, Holders, Top traders, Early buyers), in Copy trade, in the Tracker and the address book.

- **Label**: shown instead of the address.
- **Colour tag**: a thin ring around its picture.
- **Image**: upload one, pick a generated avatar, or keep the identicon (below).
- **Notes**: shown when you hover its name.
- **Track**: follow its trades in the Tracker, get alerts, and see the Pulse "tracked dev" tag on coins it creates.

Saved to your address book. Your own wallets' entries are under **Wallets → Address book → Your wallets**; the default list shows other people's addresses.

### Images

- **Upload:** PNG, JPG, WebP or GIF up to 512 KB. Never SVG: its type is read from the file's bytes, so a renamed SVG is refused too. Crop it to a square (drag to move, slider or scroll to zoom). It's re-encoded in your browser to 64 and 128 px WebP, which drops EXIF, GPS and text metadata, and a GIF keeps only its first frame.
- **Generated:** monogram, rings, grid or stripes, in one of eight hues.
- **Identicon:** every wallet without an image gets a 5×5 picture worked out from its address, always the same for that wallet.

Where they show:

- trade rows, Holders and Top traders;
- the viewed-trader strip and the chart's marker hover card, in a ring;
- the Copy trade table and feed;
- the Tracker and its toasts ("Early bird bought 0.4 SOL of $GLINT");
- Pulse's tracked-dev tag;
- Instant Trade and the Wallets page.

### Wallet icons

On a coin page every wallet in Trades, Holders, Top traders and Early buyers carries these icons. Hover, focus or tap one for its name, what it means and how it's worked out. **What do these mean?** next to the coin tabs lists them all.

| Icon | Meaning | How it's worked out |
|---|---|---|
| You | One of your wallets | Your hosted, imported or signed-linked wallets |
| Dev | Created this coin | The wallet that signed the create transaction |
| Team (disclosed) | A team wallet disclosed at launch | Listed in the coin's description and treasury report |
| Tracked | In your address book with Track on | Wallets → Address book |
| Sniper | Bought right at launch, usually a bot | First buy within 3 seconds of creation, not the dev |
| Bundled | Bought in the creation block with linked wallets | In the creation block, and the dev, funded by the dev or the dev's funder, or funded by the same wallet as another block buyer. Without funding data every block buyer counts, marked ≈ |
| Insider | Funded by someone close to the coin | First SOL from the dev, the dev's funder, or the same wallet as another early buyer. Not shown without funding data |

Early buyers also have a holding gauge: full for **Holding**, half for **Sold part**, empty for **Sold all**.

Colour only where it means something. Sniper, Bundled and Insider are amber on someone else's wallet and grey on yours. You and Tracked use the accent, or the wallet's own colour tag. Sniper, Bundled and Insider are the same rules as the Pulse audit strip; the text comes from `core/coin/walletTags.ts`.

## From the terminal

```bash
vesk wallets                                # Main, Wallet 1, Wallet 2… (or your names)
vesk wallets label 2 "Sniper desk"          # by the n in "Wallet n", "main", or an address
vesk wallets label 2 ""                     # back to the default name
vesk book add <address> "Early bird" --marker violet
vesk book track <address>                   # follow its trades
vesk book avatar <address> ./face.png       # PNG or JPG ≤ 512 KB, metadata stripped, kept in ~/.vesk/avatars/
vesk book avatar <address> --gen rings --seed 3
vesk book avatar <address> --clear          # back to the identicon
vesk book export --format csv --out book.csv
```

Names go into the agent's address book (`~/.vesk/book.json`), so `vesk wallets label` doesn't need your keystore passphrase. `vesk treasury` shows your names next to team addresses in your terminal only; reports that get posted carry addresses.

## Settings

| Field | Notes |
|---|---|
| Label | Up to 40 characters. For your own wallets, empty means the default name. |
| Colour tag | None, ice, green, red, amber, violet, grey. Shown as a ring around the picture. |
| Image | Upload, generated (4 styles × 8 hues), or the identicon. |
| Notes | Up to 200 characters. |
| Track | Tracker trades and alerts, Pulse "tracked dev". |
| KOL | Counts the wallet in Pulse's KOL holders. |
| Bookmark | Offered first when you withdraw or send tokens. |

Export and import (JSON or CSV) keep all of these. The CSV columns are `address,label,marker,bookmark,note,track,kol,avatar,own`. `avatar` is a reference, not the picture.

## Limits and what's approximate

- **Private.** Names, labels, images and notes are yours. Hosted images live in a private storage bucket that only your account can read, served through links that expire after an hour. Nothing here goes on chain.
- **Exports carry references, not files.** An image reference only shows a picture where the file exists: your hosted account, or the agent's `~/.vesk/avatars/`.
- **The agent can't re-encode images.** `vesk book avatar` takes PNG and JPG, strips their metadata and stores them as they are. Upload WebP and GIF in the panel.
- **Self-hosted names:** a name you give in the terminal reaches the panel the first time your agent reports that wallet. After that the panel's name wins, so rename in one place.
- **Icons on a coin page** come from the trades loaded for that coin. Insider and exact Bundled need funding sources from your RPC. Without them, Bundled is an upper bound (≈) and Insider isn't shown.
