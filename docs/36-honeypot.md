# Honeypot check

The can-sell check runs before the agent buys a coin that isn't on a pump.fun bonding curve: a coin from another launchpad, one in an AMM pool, or a Token-2022 token. It asks two things: can this coin be sold, and what does a transfer cost? A coin that can't be sold, or taxes more than your limit, is refused before anything is built or signed, and the refusal says why.

## What it checks

On Solana a token can stop you selling in a few concrete ways, all visible on the mint account (read through your RPC):

| Check | Refused when | Reason shown |
|---|---|---|
| Non-transferable | the Token-2022 non-transferable extension is set | can't sell: the token is non-transferable |
| Paused | a pausable mint is paused | can't sell: transfers are paused by the issuer |
| Default frozen | new token accounts start frozen | can't sell: new token accounts start frozen |
| Transfer hook | the issuer's program runs on every transfer | transfer hook (program Abcd…wxyz) can block sells |
| Permanent delegate | someone can move or burn tokens in any wallet | permanent delegate Abcd…wxyz can take tokens from any wallet |
| Freeze authority | the issuer can freeze your token account later | freeze authority set: the issuer can freeze your tokens |
| Transfer tax | the Token-2022 transfer fee is above your limit | transfer tax 12% (max 5%) |

Then, with **Simulate a sell** on, it tests a real sell: it finds a current holder that is a person's wallet (owned by the System Program, so not the pool, a curve or a vault), asks Jupiter for a quote to sell 10% of that holder's tokens back to SOL, builds that swap for the holder, and runs it through your RPC's `simulateTransaction` with signatures not checked. Nothing is signed or sent. No route back to SOL, or a simulation that fails, is a refusal: "can't sell: a holder's sell failed in simulation (Error: AccountFrozen)".

pump.fun coins on their bonding curve are skipped: the pump.fun program mints them without a freeze authority or extensions, and selling goes back into the same curve.

The Honeypot tab's header and the help for every row say it the same way: "Applies to non-pump.fun launches: other launchpads, AMM pools and Token-2022 coins. pump.fun bonding-curve coins can't be honeypotted (fixed program, no freeze authority or transfer hooks), so this check is skipped for them."

## In the panel

**Strategy & safety → Honeypot**: the check itself, the sell simulation, the maximum transfer tax, and one switch per extension. A refused buy shows its reason in Live's filtered lane and the decision log, and in the activity log as a guardrail line.

In Rogue mode the check stays on by default; switching it off asks twice. See [Rogue mode](35-rogue-mode.md).

## From the terminal

```bash
vesk strategy set honeypot.enabled on
vesk strategy set honeypot.maxTaxPct 3
vesk strategy set honeypot.simulate on
vesk strategy explain honeypot
```

A refused `vesk buy` prints the reason: "Not bought: transfer hook (program Abcd…wxyz) can block sells."

## Settings

| Setting | Key | Default |
|---|---|---|
| Can-sell check | `honeypot.enabled` | on |
| Simulate a sell | `honeypot.simulate` | on |
| Max transfer tax | `honeypot.maxTaxPct` | 5% |
| Refuse a transfer hook | `honeypot.refuseTransferHook` | on |
| Refuse a permanent delegate | `honeypot.refusePermanentDelegate` | on |
| Refuse non-transferable | `honeypot.refuseNonTransferable` | on |
| Refuse default-frozen | `honeypot.refuseDefaultFrozen` | on |
| Refuse a freeze authority | `honeypot.refuseFreezeAuthority` | on |

## Limits and what's approximate

- You can't simulate your own sell before you hold a coin, so the check simulates a current holder's. A brand-new coin whose only holder is its pool has nobody to simulate from; then the mint's extensions decide and the check notes that the sell wasn't simulated.
- A simulation shows the coin can be sold right now. An issuer with a freeze authority or a transfer hook can still change that later, which is why those are refused by default.
- The hosted agent checks the mint's authorities and extensions; the sell simulation runs on self-hosted agents.
- One check per coin per minute is reused, so a burst of buys on the same coin doesn't repeat it.
- The check adds the time of a few RPC calls and one Jupiter quote (typically a few hundred ms) before a non-pump.fun buy. The landing time Live shows doesn't include it.
- Tested here against local mocks of the RPC and Jupiter (a transfer hook, a failing simulation, a 1% tax that passes), not against mainnet.
