# Wallet clustering

Bundled, insiders and the coin page's Early buyers labels link wallets that were funded by the same address: when the same wallet sent each of them its first SOL, they're probably one person. That's right for a person's wallet and wrong for infrastructure. An AMM pool or a bonding curve pays out to every seller, an exchange hot wallet funds thousands of strangers, and a program account isn't anyone. Linked through them, unrelated buyers would look like one bundle. Since v19 they never are.

## The rule

An address is never a funder and never a link when it is:

1. a program or fixed account in `core/data/clusterExclude.ts`: the System, Token, Token-2022, Associated Token Account and Compute Budget programs, Jupiter's aggregator, the Raydium AMM v4 authority, the pool and curve programs Vesk watches (pump.fun, PumpSwap, Raydium AMM v4 and CPMM, LaunchLab, Meteora DBC, DAMM v1 and v2, Orca Whirlpools) and the quote mints (SOL, USDC, USDT, USD1);
2. a labelled exchange hot wallet (`core/data/exchanges.ts`);
3. this coin's own bonding curve or pool accounts;
4. any funder whose account is owned by a program other than the System Program (a pool, a vault, a PDA). Enrichment reads the funders' owners with one `getMultipleAccounts` call.

A wallet that is itself one of these (a pool account that shows up among the largest holders) doesn't link anyone either. Everything else is unchanged: the dev, wallets funded by the dev or the dev's funder, and wallets funded by the same ordinary wallet still link.

## In the panel

Pulse's bundled and insiders numbers, the coin page's Early buyers labels and the strategy's rug check all use the same rule, so they agree. The wallet tags' tooltips say how each label is worked out ([Wallet labels](30-wallet-labels.md)).

## Limits and what's approximate

- Only addresses we're confident of are listed, each with where it comes from. pump.fun's fee recipients, its migration account and some protocols' vault authorities are listed as TODO in the file, not guessed; most of them are program-owned and caught by rule 4 when your RPC can read their owner.
- Exchange labels come from public explorer tags and can be wrong or go stale; add or fix entries in `core/data/exchanges.ts`.
- Funding is the sender of a wallet's first SOL among its last 25 signatures. For old, busy wallets that's the oldest transfer in that page, not necessarily the first ever.
- Without funding data, bundled counts every creation-block buyer (an upper bound, marked as such) and insiders are unknown.
