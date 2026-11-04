# Migration snipe

Buy a coin the moment it migrates (pump.fun or LetsBonk bonding curve → PumpSwap or Raydium), or sell what you hold when it does. Use the sell for coins you only wanted while they were on the curve.

## In the panel

Arm an order from a Pulse row (**M+** buys on migration, **M−** sells on migration, only on coins you hold) or in Settings → **Trading → Migration**, which lists armed orders with their status and result.

### How it works

1. You arm an order (panel or CLI).
2. Your agent keeps PumpPortal's data websocket open with `subscribeMigration` while any order is armed. Hosted edge functions can't hold a websocket, so migration orders run on a **self-hosted agent**. The panel stores them, and the agent pulls them with your rules.
3. When the migration event for that coin arrives, the agent fires every armed order on it: sells first, then buys. Each one goes through the executor with your trading preset (slippage, priority fee, Jito tip, MEV mode), your own RPC, and every guardrail, limit and the blacklist.
4. The order is marked **done** (with the signature) or **failed** (with the reason). A later pull from the panel never re-arms an order the agent already fired.

A paused agent doesn't fire orders; they stay armed. With MEV mode Reduced or Secure, the buy goes only as a Jito bundle.

## From the terminal

```bash
vesk migration buy <mint> 0.1 --preset p2    # arm a buy
vesk migration sell <mint> 100               # sell everything you hold when it migrates
vesk migration                               # list (status, result)
vesk migration rm <id>                       # cancel
vesk migration watch [--for 600]             # run the watcher in the foreground (vesk summon does it by itself)
```

## Limits and what's approximate

- **Self-hosted only.** Hosted edge functions can't hold a websocket, so migration orders run on your agent; the panel stores them and the agent pulls them.
- **A paused agent doesn't fire orders;** they stay armed.
- **Tested against mocks, not live migrations:** the end-to-end test arms a P2 buy and a buy on a blacklisted coin, pushes migrations through a mock PumpPortal websocket, mock RPC and mock Jito, and checks that the first coin is bought as one Jito bundle with P2's fees, the blacklisted one never builds a transaction, and the orders settle as done and failed. Real migrations depend on PumpPortal's migration stream.
