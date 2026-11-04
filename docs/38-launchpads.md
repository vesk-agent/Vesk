# Launchpads

Vesk launches through one interface for every launchpad (`core/launch/adapter.ts`). An adapter says what it can do (a dev buy in the create, disclosed team buys in the same Jito bundle), validates a plan, and runs the launch: metadata, the unsigned create transaction, signing with your keys on your machine, sending, and the result. The guardrails run before any adapter is called and are the same for all of them: team wallets at launch are always disclosed, limits apply, the never-list holds.

## Status

| Launchpad | Status | How |
|---|---|---|
| pump.fun | Ready | PumpPortal local transactions and a Jito bundle; tested end to end against local mocks |
| StonkFun | Soon | Adapter scaffold only, not enabled (see below) |
| LetsBonk | Soon | Trading works through PumpPortal; the create path isn't built |
| Meteora DBC | Soon | Needs Meteora's Dynamic Bonding Curve SDK |
| Others in the picker | Soon | No public create interface integrated yet |

Only a launchpad marked Ready can be picked in the panel, the CLI, chat or MCP.

## StonkFun

The StonkFun adapter (`core/launch/stonkfun.ts`) is a typed scaffold: the generic flow (metadata, an unsigned create transaction, a check that the transaction calls the expected program before anything is signed, local signing with your wallet and a new mint key, sending, confirming) with validation and errors. It is tested against local mocks only and has never run against StonkFun.

What's needed to enable it:

1. **StonkFun's program ID**, from its own docs, SDK or a verified explorer label. Vesk never guesses program IDs.
2. **How a create transaction is built**: a local-transaction API (POST a request, get an unsigned transaction back, the way PumpPortal works) or the instruction layout from a published IDL.
3. **The metadata upload**: the endpoint and its fields.
4. **What the create can include**: a dev buy, and whether disclosed team buys can share a Jito bundle with it.
5. **A test on devnet or a tiny mainnet launch**, then the status goes to Ready in `core/launch/launchpads.ts`.

Until then StonkFun shows **Soon** on the Launch page, and asking for it says what's missing.

## In the panel

**Launch** → the launchpad picker shows every launchpad with Ready or Soon and a one-line note. Soon launchpads can't be picked.

## Logos

Launchpads and venues show their official logo next to their name in Pulse (the launchpad tag and the protocol filters), the launchpad picker, the coin header, Strategy & safety (Trading from) and the tables in these docs, once the logo file is supplied. Until then the launchpad tiles show a neutral glyph tile and the tags show the name alone: Vesk never redraws a brand's logo.

Each logo has a slot in `site/src/components/brandLogos.ts`: `pumpfun`, `pumpswap`, `raydium` (Raydium and LaunchLab), `meteora` (DBC and its AMMs), `jupiter` (and Jupiter Studio), `letsbonk`, `bags`, `stonkfun`, `orca` and `moonshot`. `public/logos/README.md` lists the exact file names and each brand's official page; drop the file into `public/logos/` and it fills the slot everywhere (the launchpad tiles, New launch's banner, Pulse, Bring your stack), with no code change. `LOGOS-LOVABLE-PROMPT.txt` at the site's root is a ready prompt for Lovable to add them.

## Limits and what's approximate

- Ready means tested against local mocks of PumpPortal, the pump.fun metadata endpoint, Jito and an RPC, plus the live interfaces' published docs. Do a tiny launch first.
- Where a launchpad's coins appear in Pulse is a separate question (the data stream and your RPC's logs): see [Data sources](26-data-sources.md).
