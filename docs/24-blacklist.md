# Blacklist

Coins, devs, funding wallets and wallets you never want to see or buy. Blacklisted coins disappear from Pulse and the Tracker, and every buy path refuses them, while sells always stay open so you can get out.

## In the panel

Edit it in Settings → **Blacklist** (add, remove, notes, import and export), or from a Pulse row: the ban button blacklists the dev.

### What it does

| Where | Effect |
|---|---|
| Pulse | Coins whose contract, dev or the dev's funding wallet is listed are hidden (or shown dimmed with **Show hidden tokens**). |
| Tracker | Posts whose contract address is listed are hidden; trades by listed wallets or in listed coins are hidden in the wallet tracker. |
| Quick buy, Instant Trade, coin page | The panel refuses the buy before sending it. |
| Every buy (agent and hosted) | The guardrails refuse a buy of a listed coin, or of a coin whose dev or dev funder is listed, when the caller knows the dev (Pulse quick buys, rule buys on new launches). Code: `blacklist`. |
| Rules | Signals for listed coins or devs are skipped and logged. |
| Migration orders | A listed coin isn't bought when it migrates; the order fails with the reason. |

## From the terminal

```bash
vesk blacklist                                  # list
vesk blacklist add dev <address> --note "rugged twice"
vesk blacklist add mint <address>
vesk blacklist add funder <address>             # a wallet that funds devs
vesk blacklist rm dev <address>
vesk blacklist import list.txt --kind dev       # one address per line, or kind,address,note lines, or a JSON export
vesk blacklist export --out blacklist.json
```

## Limits and what's approximate

- Sells are never blocked, so you can always get out.
- The list is saved to your account. A paired agent pulls it with your rules, and the CLI edits the agent's copy. Each kind holds up to 5,000 addresses. Only valid Solana addresses are kept.
- **Dev and funder checks need the dev.** They apply when the caller knows the coin's creator (Pulse quick buys, rule buys on new launches); a buy by contract address alone checks the coin itself.
