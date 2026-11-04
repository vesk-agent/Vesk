# Holder access

**The open-source agent (CLI, Telegram bot, MCP server) is free and MIT for everyone. It isn't gated, and it can't be.**

The **hosted** panel and API need you to hold at least **500,000 $VESK**, summed across the wallets you link and your hosted trading wallet. The operator can change the minimum with `VESK_GATE_MIN`, for example to 1,000,000.

## In the panel

**Setup → Holder access** shows your linked wallets, the $VESK they hold together with your hosted trading wallet, and the minimum. The status bar's hover shows "holder access" when you're above it; below it, "access removed" shows in the status bar and a bar at the top of the panel.

### Linking a wallet

You prove you own a wallet by signing a one-time message (Sign-In-With-Solana style). The server checks the ed25519 signature. Vesk never asks for a private key or seed phrase to check access.

- **Browser wallet:** Holder access → **Connect a wallet**. Four steps, shown along the top of the dialog: **Choose wallet** (wallets in this browser are listed under *In this browser* as *Detected*, with the icon the wallet itself provides; Phantom, Solflare and Backpack are listed under *Not installed* with **Install ↗**, a link to their site; with none in this browser it says "No wallet found in this browser. Install one, or sign with the CLI.") → **Approve** in your wallet → **Sign** → **Linked**, with the address and its $VESK balance. A wallet that isn't installed shows a plain tile until its official logo file is added: Vesk doesn't draw other brands' logos. The message screen says: "This signature only proves you own this wallet. It can't move funds or approve transactions." If you turn down the connection or the signature, the dialog says so (for example "Signature rejected") and offers **Try again**. Any Wallet Standard wallet works.
- **Vesk CLI:** in the same wallet list, **Vesk CLI**: paste your address, copy the message, sign it in your terminal (below) and paste the signature back.
- **A holding wallet made here:** Holder access → **Create a holding wallet** (below).

The signature can't move funds. Link as many wallets as you like; balances add up.

### Pick how to verify

Until you've made a holding wallet, the Holder access page doesn't show an address to send to. It asks how you want to verify: **Create a holding wallet** or **Connect a wallet** (the wallet your $VESK is already in).

### Create a holding wallet

If you'd rather not connect the wallet your $VESK is in, make a new one just for holding it:

The dialog has three steps: **Your new wallet**, **Save it** and **Link**.

1. **Create a holding wallet** makes a fresh Solana keypair in your browser straight away (ed25519, from the browser's own random number generator). The first thing you see is its address, with the private key under it, blurred until you press the eye. **Make another** throws this one away and makes a new one. **Continue** goes on to saving it.
2. Save the key: **Copy key**, **Download .json** (the Solana CLI's keypair file, which Phantom, Solflare and Backpack can import too) or **Download base58**. The note under it says exactly: "Save this key now. Vesk can't recover it, ever. This wallet is only for holding $VESK to unlock access. You don't need to use it for anything else."
3. Tick **I saved it**. Until you do, **Link this wallet** stays off.
4. **Link this wallet** asks the server for a one-time message, signs it in the page with the new key, and sends only the address and the signature. The server checks it the same way as a connected wallet's signature. The last step then shows the address with its QR code and a copy button.
5. Back on the page, **Send $VESK here to verify holder access** shows that address, a copy button and a QR code, and "Waiting for $VESK… 0 / 500,000" until something arrives. While it waits, the page re-checks balances by itself every 15 seconds (only while the tab is open and visible).

If you also have a connected wallet, a small switcher above the address picks which one to show; the holding wallet is the default.

The private key is never sent to Vesk or anyone else: it stays in the page's memory, isn't written to storage, and is wiped when you make another one or leave. If you lose it, the $VESK in that wallet is lost; Vesk can't recover it.

### The wallet list

The Holder access page lists every wallet that counts: your hosted trading wallet, wallets you connected, and holding wallets made here (the **Type** column says Hosted, Connected or Holding), each with its $VESK balance, then the **Total** against the minimum and whether that's enough or how much more is needed.

### Checks

Balances are read from your RPC when you sign in, on every session refresh, every 10 minutes, whenever you press **Re-check now**, and every 15 seconds while the page is waiting for $VESK to reach a new holding wallet.

Below the minimum, **access is removed**:

- hosted panel features and the API stop, and so do your rules and automations (including the relay),
- your data, **withdrawals (SOL and tokens), exports and the kill switch keep working**, so nobody gets locked out of their funds,
- your settings, rules, presets and address book are kept.

Access comes back by itself as soon as your balance is back to the minimum. Nothing to re-enable.

## From the terminal

```bash
vesk access sign "<message>"     # sign the panel's holder-access message with your wallet, locally
```

The CLI itself is never gated.

## Limits and what's approximate

- **Before $VESK launches:** The gate is off until the operator sets `VESK_MINT`. Everything works in the meantime, and the panel shows "holder access off".
- **What holding means:** Holding $VESK unlocks the hosted panel and API. It gives no revenue share and comes with no promises. Only buy what you can afford to lose, and verify the contract address on the site and the project's own accounts.
- **Balances are read from your RPC** at the moments listed above (and every 15 seconds while the page waits for a new holding wallet), so a transfer counts from the next check, not instantly.
- **A holding wallet is a normal Solana wallet.** Vesk can't move from it, freeze it or recover it. Keep the key file somewhere safe and offline; anyone with it controls the wallet.
- The keypair and the signature are made with tweetnacl in the browser; the self-test signs and verifies locally, and the checks confirm no network request carries the key. The QR code is drawn by a small built-in encoder and was checked by decoding it with OpenCV.
