/**
 * v26: pump.fun Custom Pairs, the registry. Data plus a few pure helpers; no I/O.
 *
 * What Custom Pairs are (press, 2026-09-09; see SOURCES and research/pumpfun-custom-pairs.md): a pump.fun coin can be
 * quoted in a Solana asset other than SOL: stablecoins, crypto (wrapped BTC / ETH and others), tokenized stocks
 * (xStocks by Backed; Backpack Securities), a pre-IPO token, metals and memecoins. The creator fee on a custom pair is
 * 0.05% to 1%, paid in the quote asset; there is a Cashback option (fees back to traders) and fees can be split among up
 * to 10 recipients. Those settings lock once the coin is set up.
 *
 * v27 G: the list is pump.fun's own: the Supported Pair Assets list (https://pump.fun/docs/custom-pairs, updated
 * 2026-10-09; 155 assets with mints, copied in research/logos/PAIRS-FOUND.md). Every asset on it is one entry here,
 * selectable, with its mint exactly as written there (base58, 32 bytes: test/v26.test.ts), `source: PF`, its issuer
 * where known and its token picture (`logo`: a `pair-*` file in public/logos/, mapped by mint). The symbol is the one
 * pump.fun shows; where its spelling differs from the token's own (APPLX for AAPLx, ETH for WETH) the token's symbol is
 * the id and pump.fun's is an alias (`aka`): both find it. Entries we had before that pump.fun doesn't list were dropped
 * (see the note at the end of the list); discovery still adds any of them seen in a live create.
 *
 * One entry per asset: symbol, name, category, mint, logo, status. Statuses (what the picker shows):
 *  - native       SOL. No mint to check.
 *  - listed       on pump.fun's supported list (or, for USD1 only, the owner's report: see its note). Selectable.
 *  - discovered   learned at runtime from pump.fun CreateEvents (`quote_mint`) by pair discovery (launch/discovery.ts).
 *                 Selectable, labelled as such.
 *  - unavailable  a symbol with no mint from any source: never selectable, never guessed (none today).
 * "Verified on-chain" is not stored here: it is what a listed or discovered pair shows once its mint has passed the
 * on-chain check (launch/mintcheck.ts) through your RPC; see `pairStatus`.
 *
 * Nothing here is trusted at launch time. Before any create on a non-SOL pair, the agent and the hosted backend read the
 * mint on chain (the account exists, is owned by the SPL Token or Token-2022 program, is an initialized mint, its
 * decimals) and refuse the create with the reason on any failure. Every non-SOL pair is "verify on first live launch".
 *
 * Logos: the asset's own token picture (its metadata image, or its issuer's official token logo) as
 * public/logos/pair-<symbol>.png|svg; a pair whose picture shows a real person, or is a wide banner that reads as nothing
 * in a circle, has none (`noImage` says why) and shows its ticker on a plate. A company's corporate logo is never used for a token the company doesn't issue.
 *
 * Left out on purpose (EXCLUDED_QUOTES): quotes named after a real individual (ANSEM, ALON, Cupsey). Never listed,
 * dropped by discovery too. Adding a pair: one entry, with the mint from pump.fun's list, never from memory.
 */
import { QUOTE_MINTS } from "../data/programs.js";

export type PairCategory = "native" | "stable" | "crypto" | "stock" | "preipo" | "metal" | "meme" | "other";
export type PairStatus = "native" | "listed" | "discovered" | "unavailable";
/** What a row shows: the stored status, or "verified" once its mint passed the on-chain check. */
export type PairShownStatus = PairStatus | "verified";

export interface PairAsset {
  /** the symbol, as pump.fun shows it (the token's own spelling where they differ: `aka`) */
  id: string;
  /** other spellings that find it: pump.fun's label when it differs from the token's symbol (APPLX, ETH) */
  aka?: string[];
  name: string;
  category: PairCategory;
  /** "native" for SOL; the mint; or null when no source has it (unavailable) */
  mint: string | null;
  /** brandLogos.ts slot; null = a neutral tile */
  logo: string | null;
  status: PairStatus;
  /** who issues it */
  issuer?: string;
  /** where the mint comes from */
  source?: string;
  /** a tile in the picker (SOL, USDC, USD1); the rest are under "More pairs" */
  main?: boolean;
  /** decimals, when known for certain (well-known stablecoins); the on-chain check compares them */
  decimals?: number;
  /** verify on the first live launch (every non-SOL pair) */
  verify?: boolean;
  /** why an entry isn't offered, or what's special about its source (v27 G) */
  note?: string;
  /** why the pair shows no picture (its token image shows a real person, or is a banner that reads as nothing in a circle): its ticker on a plate instead (v27 G) */
  noImage?: string;
  /** discovery: when it was last seen in a create, and in how many */
  seenAt?: number;
  seenCount?: number;
}

export const CATEGORY_LABEL: Record<PairCategory, string> = { native: "Solana", stable: "Stablecoins", crypto: "Crypto", stock: "Stocks", preipo: "Pre-IPO", metal: "Metals", meme: "Memes", other: "Discovered" };
export const CATEGORY_ORDER: PairCategory[] = ["native", "stable", "crypto", "stock", "preipo", "metal", "meme", "other"];
export const STATUS_LABEL: Record<PairShownStatus, string> = { native: "Native", verified: "Verified on-chain", listed: "Listed", discovered: "Discovered", unavailable: "Not available yet" };

export const SOURCES = {
  pumpfun: "https://pump.fun/docs/custom-pairs",
  marinade: "https://docs.marinade.finance/developers/contract-addresses",
  terminalpedia: "https://terminalpedia.com/ecosystem/tokenized-stocks-solana-terminal",
  kucoin: "https://www.kucoin.com/news/flash/pump-fun-launches-custom-pairs-with-93-quoting-assets-including-tokenized-stocks",
  fxstreet: "https://www.fxstreet.com/cryptocurrencies/news/pumpfun-launches-custom-pairs-for-tokenized-stocks-and-real-world-assets-on-solana-202609100558",
  techflow: "https://www.techflowpost.com/en-US/article/33890",
  defillama: "https://github.com/DefiLlama/dimension-adapters/pull/10036",
  onDisk: "on disk: core/src/data/programs.ts QUOTE_MINTS and core/src/ca.ts",
  onDiskOnce: "on disk once: core/src/data/programs.ts QUOTE_MINTS",
  discovered: "seen live in a pump.fun create (quote_mint)",
} as const;

/** Never listed, never merged from discovery. */
export const EXCLUDED_QUOTES: Record<string, string> = {
  "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump": "ANSEM: named after a real person",
  "8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS": "ALON: named after pump.fun's co-founder",
  "6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump": "Cupsey: named after a real trader",
};

const disk = (symbol: string): string | null => Object.entries(QUOTE_MINTS).find(([, s]) => s === symbol)?.[0] ?? null;
/** pump.fun's Supported Pair Assets list, as read on 2026-10-09 (site/vesk-site/public/logos/PAIRS-FOUND.md) */
export const PF = "pump.fun/docs/custom-pairs (2026-10-09)";
const XS = "xStocks by Backed";
const BPS = "Backpack Securities";
const WH = "Wormhole";
/** an asset on pump.fun's list: selectable; its mint is read on chain before every create */
const P = (id: string, name: string, category: PairCategory, mint: string, logo: string | null, extra: Partial<PairAsset> = {}): PairAsset =>
  ({ id, name, category, mint, logo, status: "listed", source: PF, verify: true, ...extra });

export const PUMPFUN_PAIRS: PairAsset[] = [
  // ---- Solana
  { id: "SOL", name: "Solana", category: "native", mint: "native", logo: "solana", status: "native", source: PF, main: true }, // native SOL: no mint to check
  // ---- Stablecoins
  P("USDC", "USD Coin", "stable", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "usdc", { issuer: "Circle", main: true, decimals: 6 }),
  // USD1: the owner's report (v23) and data/programs.ts; NOT on pump.fun's custom-pairs list (2026-10-09). Kept selectable
  // as a tile pending the owner's call (it was a launch option before custom pairs); the on-chain check still runs first.
  { id: "USD1", name: "World Liberty Financial USD", category: "stable", mint: disk("USD1") /* on disk once: data/programs.ts */, logo: "usd1", status: "listed", issuer: "World Liberty Financial", source: SOURCES.onDiskOnce, note: "not on pump.fun's custom-pairs list (2026-10-09); a launch option from the owner's report", main: true, verify: true },
  P("CHIP", "USD.AI", "stable", "chipCAT7vi5CZtbZsn9z7iMPXvFwyAnKz3QFu8XVuHm", "pair-chip"),
  // ---- Crypto
  P("PEAQ", "peaq", "crypto", "PEAQjk7SRS6rXHVFFmpRr7zrC4g5ZuEebpwTxvaLr3b", "pair-peaq"),
  P("DOGE", "Dogecoin", "crypto", "DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R", "pair-doge"),
  P("ARB", "Arbitrum", "crypto", "ARBzQTYDCW2KnVEjs1Mc81LekB1ibVFZKbSVmorkoT9d", "pair-arb"),
  P("PONS", "Pons", "crypto", "poNSfquKq512ApeYjVghwViSun4x1MhCqHVH2Paq4jN", "pair-pons"),
  P("MORPHO", "Morpho", "crypto", "Morpho2VPeTr2E1Jx6monxCzF7mqwUnjz74RdwLXYyP", "pair-morpho"),
  P("SLX", "Solstice", "crypto", "SLXdx4BUt2v9uJQNzWqSfzTJ9UKLUDsvxHFMEEdrfgq", "pair-slx"),
  P("SV151", "Scarlet & Violet 151", "crypto", "SV151D5pjygAKA8aJJcKzm4wFnRX5G92Fye94jQJk7g", "pair-sv151"),
  P("PSG", "Paris Saint-Germain", "crypto", "5eyib4qghYGHNh7VvxSFGYLFJSanjq9hug9fR52kksnm", "pair-psg"),
  P("BILL", "Billions Network", "crypto", "Bi11Je4MH3PpyCNiuTAepRbsA5U6DK3DJy79ZFthddX", "pair-bill"),
  P("ENA", "Ethena", "crypto", "72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1", "pair-ena"),
  P("TAO", "Bittensor", "crypto", "taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY", "pair-tao"),
  P("MEGA", "MegaETH", "crypto", "megaA5QDK1qLXtjpvg9oCFMvxT9d5BCMrVTBddnM5kV", "pair-mega"),
  P("CHZ", "Chiliz", "crypto", "6eftxVbSAunVEoxUWdGhPdxg5UdsJ8Wkwy5w5YFuxouw", "pair-chz"),
  P("BP", "Backpack", "crypto", "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy", "pair-bp"),
  P("AAVE", "Aave", "crypto", "AavE1kKKnesPw4MuRJmJ9jZs9QzEE8CPxQ3ViczUDfc1", "pair-aave"),
  P("SUI", "Sui", "crypto", "suifhC9gU1VbJAPYPTBkHJyyyStKGLLYPVDTmPoqbvA", "pair-sui"),
  P("UNI", "Uniswap", "crypto", "uniHfuPhEQSrtpzXpJZDCSq53yaejKKpNhFUiKoHKHV", "pair-uni"),
  P("HYPE", "Hyperliquid", "crypto", "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g", "pair-hype"),
  P("ZEC", "Zcash", "crypto", "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "pair-zec"),
  P("NEAR", "NEAR Protocol", "crypto", "3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG", "pair-near"),
  P("XRP", "Ripple (wrapped XRP)", "crypto", "6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2", "pair-xrp"),
  P("XMR", "Monero", "crypto", "WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp", "pair-xmr"),
  P("LIT", "Lighter", "crypto", "EicWvteVi2fWepEzS3FYWsnuPoP6caZfjnKqNvydLjCH", "pair-lit"),
  P("PUMP", "Pump", "crypto", "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "pair-pump", { issuer: "pump.fun" }),
  P("ORE", "ORE", "crypto", "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", "pair-ore"),
  P("AFC", "Arsenal FC", "crypto", "Dst93spXQEXxFzwYbFrQRnFYBYpw7AzB2QyALEeP4NGQ", "pair-afc"),
  P("MON", "Monad", "crypto", "CrAr4RRJMBVwRsZtT62pEhfA9H5utymC2mVx8e7FreP2", "pair-mon"),
  P("hSOL", "Helius Staked SOL", "crypto", "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A", "pair-hsol"),
  P("SKR", "Seeker", "crypto", "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", "pair-skr"),
  P("MET", "Meteora", "crypto", "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL", "pair-met"),
  P("RAY", "Raydium", "crypto", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", "pair-ray"),
  P("STONK", "STONK", "crypto", "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx", "pair-stonk"),
  P("WBTC", "Wrapped BTC", "crypto", "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", "pair-wbtc", { issuer: WH }),
  P("WETH", "Ether (Wormhole Portal)", "crypto", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", "pair-weth", { issuer: WH, aka: ["ETH"] }), // pump.fun lists it as ETH
  P("CARDS", "Collector Crypt", "crypto", "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp", "pair-cards"),
  // ---- Stocks: xStocks (Xs… mints, Backed) and Backpack Securities
  P("AAPLx", "Apple xStock", "stock", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", "pair-aaplx", { issuer: XS, aka: ["APPLX"] }), // pump.fun's page writes it APPLX
  P("BRKx", "Berkshire Hathaway B xStock", "stock", "Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x", "pair-brkx", { issuer: XS }),
  P("SPYx", "SP500 xStock", "stock", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "pair-spyx", { issuer: XS }),
  P("GOOGLx", "Alphabet xStock", "stock", "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", "pair-googlx", { issuer: XS }),
  P("TSLAx", "Tesla xStock", "stock", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", "pair-tslax", { issuer: XS }),
  P("HOODx", "Robinhood xStock", "stock", "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", "pair-hoodx", { issuer: XS }),
  P("NVDAx", "NVIDIA xStock", "stock", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", "pair-nvdax", { issuer: XS }),
  P("CRCLx", "Circle xStock", "stock", "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", "pair-crclx", { issuer: XS }),
  P("AMZNx", "Amazon xStock", "stock", "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", "pair-amznx", { issuer: XS }),
  P("COINx", "Coinbase xStock", "stock", "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", "pair-coinx", { issuer: XS }),
  P("MSTRx", "MicroStrategy xStock", "stock", "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", "pair-mstrx", { issuer: XS }),
  P("METAx", "Meta xStock", "stock", "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", "pair-metax", { issuer: XS }),
  P("QQQx", "Nasdaq xStock", "stock", "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", "pair-qqqx", { issuer: XS }),
  P("MCDx", "McDonald's xStock", "stock", "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2", "pair-mcdx", { issuer: XS }),
  P("AVGOx", "Broadcom xStock", "stock", "XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo", "pair-avgox", { issuer: XS }),
  P("MSFTx", "Microsoft xStock", "stock", "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", "pair-msftx", { issuer: XS }),
  P("PLTRx", "Palantir xStock", "stock", "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4", "pair-pltrx", { issuer: XS }),
  P("STRCx", "Strategy STRC xStock", "stock", "Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH", "pair-strcx", { issuer: XS }),
  P("KOx", "Coca-Cola xStock", "stock", "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ", "pair-kox", { issuer: XS }),
  P("GMEx", "GameStop xStock", "stock", "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc", "pair-gmex", { issuer: XS }),
  P("INTCx", "Intel xStock", "stock", "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM", "pair-intcx", { issuer: XS }),
  P("VIDAx", "Vida Global xStock", "stock", "XsfCC9VL4DamVGNgdJpfLXB3sBVa158Gbx8sh7NzmTk", "pair-vidax", { issuer: XS }),
  P("NKE", "NIKE", "stock", "NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg", "pair-nke", { issuer: BPS }),
  P("AMC", "AMC Entertainment", "stock", "AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc", "pair-amc", { issuer: BPS }),
  P("GPRO", "GoPro", "stock", "GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH", "pair-gpro", { issuer: BPS }),
  P("LLY", "Eli Lilly", "stock", "LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD", "pair-lly", { issuer: BPS }),
  P("MRNA", "Moderna", "stock", "MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT", "pair-mrna", { issuer: BPS }),
  P("INTC", "Intel", "stock", "iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF", "pair-intc", { issuer: BPS }),
  P("HOOD", "Robinhood Markets", "stock", "HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A", "pair-hood", { issuer: BPS }),
  P("SKHY", "SK Hynix", "stock", "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3", "pair-skhy", { issuer: BPS }),
  P("BOT", "RoboStrategy", "stock", "BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T", "pair-bot", { issuer: BPS }),
  P("DRAM", "Roundhill Memory ETF", "stock", "DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw", "pair-dram", { issuer: BPS }),
  P("SNDK", "SanDisk", "stock", "SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH", "pair-sndk", { issuer: BPS }),
  P("MU", "Micron", "stock", "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1", "pair-mu", { issuer: BPS }),
  P("TTWO", "Take-Two", "stock", "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo", "pair-ttwo", { issuer: BPS }),
  P("NBIS", "Nebius", "stock", "NBiSF3UaVUFtRzHwAfxyHsBCAZWGEKnMpewAE4oh7BG", "pair-nbis", { issuer: BPS }),
  P("MRVL", "Marvell", "stock", "MRVLSjkR2ceUBukujaD3xCyHP1H3B2SzpsNTZF546jo", "pair-mrvl", { issuer: BPS }),
  P("DKNG", "DraftKings", "stock", "DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow", "pair-dkng", { issuer: BPS }),
  P("GRND", "Grindr", "stock", "GRNDYDpqwpCm6jVxpbh4xT5AM4r3p391qYsKTHqgaET2", "pair-grnd", { issuer: BPS }),
  P("DNUT", "Krispy Kreme", "stock", "DNUTsCvKbKwu2RM72cUuW3TD9YpzArzACcqYQssjPLSk", "pair-dnut", { issuer: BPS }),
  P("WEN", "Wendy's", "stock", "WENAZ2WyPbmgvUcKfQ8hyMDfBQP9bZ65hsZ5KTFrRGZ", "pair-wen", { issuer: BPS }),
  P("HTZ", "Hertz Global Holdings", "stock", "HTZsLG4zqaNvWMwXSLHH3GG5KyJpKwpBRsKVdMG6hvzP", "pair-htz", { issuer: BPS }),
  P("SPHR", "Sphere Entertainment", "stock", "SPHRp8cZaSQBTp1KMNP4V1X821SXhXWt4Q2yLdyHzju", "pair-sphr", { issuer: BPS }),
  P("DFDVx", "DeFi Development Corp xStock", "stock", "Xs2yquAgsHByNzx68WJC55WHjHBvG9JsMB7CWjTLyPy", "pair-dfdvx", { issuer: XS }),
  P("BA", "Boeing", "stock", "BArimz1PcKZr8PcPh3tcZ2dg4S7FJLk3cw6R5F8GsHKg", "pair-ba", { issuer: BPS }),
  P("BABA", "Alibaba Group", "stock", "BABANGA4JE7Kkam4nTrALAwAVgsNJUuFJnnkF7S16BZp", "pair-baba", { issuer: BPS }),
  P("COST", "Costco", "stock", "CZEB3WNZuF2Yz1z2H81RcCk8T7fsw82KB33zqamASVsg", "pair-cost", { issuer: BPS }),
  P("DELL", "Dell Technologies", "stock", "DELL2aRKQz7DMq5DrKLtkn47ZCnbxXPZXrSGbkmd13wy", "pair-dell", { issuer: BPS }),
  P("JNJ", "Johnson & Johnson", "stock", "JNJg1znKdF712Phe7L7z52AATAvEjEytBdN2w8Lnh1Y", "pair-jnj", { issuer: BPS }),
  P("LMT", "Lockheed Martin", "stock", "LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV", "pair-lmt", { issuer: BPS }),
  P("PFE", "Pfizer", "stock", "PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x", "pair-pfe", { issuer: BPS }),
  P("RIVN", "Rivian Automotive", "stock", "RcZmt84VMJv9bDhKqmw1uWDahYrUT468VwAChTnfD8p", "pair-rivn", { issuer: BPS }),
  P("SHOP", "Shopify", "stock", "SH55hfaipFAbwT42nQYhRoM5o5t61QpkmJ6p62vXB3m", "pair-shop", { issuer: BPS }),
  P("SNAP", "Snap", "stock", "SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz", "pair-snap", { issuer: BPS }),
  P("BULL", "Webull", "stock", "BULL151gUXcFV5wXEUqu9Am2L7Qt4bTJRLRuAUjkcspC", "pair-bull", { issuer: BPS }),
  P("DJT", "Trump Media & Technology Group", "stock", "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF", "pair-djt", { issuer: BPS }),
  P("HIMS", "Hims & Hers Health", "stock", "HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx", "pair-hims", { issuer: BPS }),
  P("IBM", "IBM", "stock", "BMKdM4yUxX12moFqVk195k7coMbaybd4RUKCUdm7D1Sk", "pair-ibm", { issuer: BPS }),
  P("LULU", "Lululemon", "stock", "LULUmT9VMttkfAJE236LXJcYJ2tTP7nunrSWR5G1BdS", "pair-lulu", { issuer: BPS }),
  P("MGM", "MGM Resorts International", "stock", "MGMuubtUEirmkhfEQdmGUh4pr7HuUdMWcZXFtpPbVJD", "pair-mgm", { issuer: BPS }),
  P("QUBT", "Quantum Computing", "stock", "QUBTAD8C9bMU9LvmMNgKPhrmBGbHvxpu6vfWQtThxxw", "pair-qubt", { issuer: BPS }),
  P("RBLX", "Roblox", "stock", "RBLXDGRD64AtRamHMFVcjqne3Ar7NLWtFtYNtsrf1cE", "pair-rblx", { issuer: BPS }),
  P("RDDT", "Reddit", "stock", "RDDTGbhHwVXfyCvQMXzzowKjf5qrYBZAnehoXW83ooh", "pair-rddt", { issuer: BPS }),
  P("UPS", "UPS", "stock", "UPSqUeMHcWbkdg784XuBUEF9DtySSnW9ur5LAVdcuB9", "pair-ups", { issuer: BPS }),
  // ---- Pre-IPO
  P("SPCX", "SpaceX", "preipo", "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", "pair-spcx", { issuer: BPS }), // pump.fun's SpaceX token (Backpack Securities); not the SPCXx xStock below
  // ---- Metals
  P("GLDx", "Gold xStock", "metal", "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re", "pair-gldx", { issuer: XS }),
  P("PAXG", "PAX Gold", "metal", "5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW", "pair-paxg"),
  // ---- Memes
  P("CASHCAT", "Cash Cat", "meme", "CashcatZMRn4Jv8sPQZUSsbTLi2PcPe1ssqbHcnaJqSS", "pair-cashcat"),
  P("Fartcoin", "Fartcoin", "meme", "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", null, { noImage: "its token image is a 3.6 : 1 terminal screenshot: nothing of it reads in a circle" }),
  P("CATE", "Catecoin", "meme", "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump", "pair-cate"),
  P("TROLL", "TROLL", "meme", "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2", "pair-troll"),
  P("Pnut", "Peanut the Squirrel", "meme", "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump", "pair-pnut"),
  P("MOODENG", "Moo Deng", "meme", "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY", "pair-moodeng"),
  P("ZEREBRO", "zerebro", "meme", "8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn", "pair-zerebro"),
  P("ALCH", "Alchemist AI", "meme", "HNg5PYJmtqcmzXrv6S9zP1CDKk5BgDuyFBxbvNApump", "pair-alch"),
  P("neet", "NotInEmploymentEducationTraining", "meme", "Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump", null, { noImage: "its token image is a posterised photo of a real person's face" }),
  P("pippin", "Pippin", "meme", "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump", "pair-pippin"),
  P("PUMPCADE", "PUMPCADE", "meme", "Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu", "pair-pumpcade"),
  P("OTC", "OTC", "meme", "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump", "pair-otc"),
  P("Bert", "Bertram The Pomeranian", "meme", "HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump", "pair-bert"),
  P("GOAT", "Goatseus Maximus", "meme", "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump", "pair-goat"),
  P("aura", "aura", "meme", "DtR4D9FtVoTX2569gaL837ZgrB6wNjj6tkmnX9Rdk9B2", "pair-aura"),
  P("CHILLGUY", "Just a chill guy", "meme", "Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump", "pair-chillguy"),
  P("fone", "apeonfone", "meme", "CTPoyCwkjMvoJwU4xvZZqoD8tiYk6yDchySiN5gGpump", "pair-fone"),
  P("Buttcoin", "Buttcoin", "meme", "Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump", "pair-buttcoin"),
  P("ACT", "Act I : The AI Prophecy", "meme", "GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump", "pair-act"),
  P("TripleT", "Tung Tung Tung Sahur", "meme", "J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump", "pair-triplet"),
  P("VINE", "Vine Coin", "meme", "6AJcP7wuLwmRYLBNbi825wgguaPsWzPBEHcHndpRpump", "pair-vine"),
  P("USELESS", "USELESS COIN", "meme", "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk", "pair-useless"),
  P("$WIF", "dogwifhat", "meme", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "pair-wif"),
  P("TRUMP", "OFFICIAL TRUMP", "meme", "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", null, { noImage: "its token image shows a real person" }),
  P("CHILLHOUSE", "Chill House", "meme", "GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump", "pair-chillhouse"),
  P("GIGA", "GIGACHAD", "meme", "63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9", null, { noImage: "its token image is a photo of a real man" }),
  P("PENGU", "Pudgy Penguins", "meme", "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", "pair-pengu"),
  P("TOAD", "The Toad Pepe", "meme", "A13oRB9FFaiUjfi6LdCg6p9ka1u8SfGkUFs4SKvPpump", "pair-toad"),
  P("Jimothy", "Jimothy The Raccoon", "meme", "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump", "pair-jimothy"),
  P("USDUC", "unstable coin", "meme", "CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump", "pair-usduc"),
  P("LMAO!", "LMAO!", "meme", "H74CYmXgMkYHYuSRsZt6RJb4NYp2u72Vw8BS5huApump", "pair-lmao"),
  P("BOBO", "Bobo", "meme", "4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump", "pair-bobo"),
  P("Tokabu", "The Spirit of Gambling", "meme", "H8xQ6poBjB9DTPMDTKWzWPrnxu4bDEhybxiouF8Ppump", "pair-tokabu"),
  P("MANIFEST", "Manifesting", "meme", "BCdwQBAn8dYB5YjTsoB6TdHAWokxv28k2oZUodERpump", null, { noImage: "its token image is a 3 : 1 white banner: nothing of it reads in a circle" }),
  P("baton", "baton", "meme", "Hg5Ja55T5wESq4vyFoiVCMeHXtGyVA69X2UHq8hgpump", "pair-baton"),
  P("CLAW", "clawpump.tech", "meme", "739dnZEG4yaBWFsY8L8ZwrfhGG6dhtCSercW8Umspump", "pair-claw"),
  P("CODEC", "Codec Flow", "meme", "69LjZUUzxj3Cb3Fxeo1X4QpYEQTboApkhXTysPpbpump", "pair-codec"),
  P("MICHI", "michi", "meme", "AywAYdNJnSLSXwKWYxDciPjqGRnwp4iZdQptuuQTpump", "pair-michi"),
  P("67", "The Official 67 Coin", "meme", "9AvytnUKsLxPxFHFqS6VLxaxt5p6BhYNr53SD2Chpump", null, { noImage: "its token image is a photo of a young person" }),
  P("gork", "@gork", "meme", "76EDL5qNcte2ZH29quTaFzagXjWAEY83CATEjyA6pump", null, { noImage: "its token image is a screenshot of a real person's profile" }),
  P("ZAUTH", "zauthx402", "meme", "DNhQZ1CE9qZ2FNrVhsCXwQJ2vZG8ufZkcYakTS5Jpump", "pair-zauth"),
  P("KINS", "Kintara", "meme", "Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump", "pair-kins"),
  P("Percolator", "Percolator", "meme", "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump", "pair-percolator"),
  P("Jotchua", "Jotchua", "meme", "BcHEaaTCvycPwwsJ9yQTXdHP9X2gCLkznDbZ8VySpump", "pair-jotchua"),
  P("ZCAT", "Anonymous Cat", "meme", "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR", "pair-zcat"),
  P("SPX", "SPX6900", "meme", "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr", "pair-spx"),
  P("BONK", "Bonk", "meme", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "pair-bonk"),
  // ---- Dropped in v27 G: not on pump.fun's supported list (2026-10-09), so never offered: USDT (on disk in
  // data/programs.ts and ca.ts, still a wallet asset), xSOL, the SPCXx xStock (pump.fun's SpaceX is SPCX above), the
  // OPENAI / ANTHROPIC PreStocks, tOpenAI, tKalshi and SILV (Terminalpedia), mSOL (Marinade's docs). Discovery adds any of
  // them that shows up as a quote in a live pump.fun create (Discovered, its mint read on chain like any other).
  // ---- Discovered: filled at runtime by pair discovery
];

/** The tiles, in order. Everything else is under "More pairs". */
export const TILE_ORDER = ["SOL", "USDC", "USD1"];
/** pump.fun's Supported Pair Assets list had this many assets on 2026-10-09 (three are left out: EXCLUDED_QUOTES). Discovery finds any added since. */
export const REPORTED_TOTAL = 155;

/** Can a pair be picked? It needs a mint and mustn't be excluded; "unavailable" never can. The on-chain check runs again before any create. */
export const pairSelectable = (p: Pick<PairAsset, "status" | "mint">) => p.status !== "unavailable" && p.mint !== null && !(p.mint in EXCLUDED_QUOTES);
/** A pair that hasn't been used on a live launch: shown with "verify on first live launch" wherever it is picked. */
export const pairUnverified = (p: Pick<PairAsset, "status">) => p.status !== "native";
/** What a row shows: "verified" once its mint passed the on-chain check; otherwise its stored status. */
export const pairStatus = (p: Pick<PairAsset, "status" | "mint">, check?: { mint: string; ok: boolean } | null): PairShownStatus =>
  p.status !== "native" && p.status !== "unavailable" && check?.ok && check.mint === p.mint ? "verified" : p.status;

export function pairCounts(list: PairAsset[] = PUMPFUN_PAIRS): Record<PairStatus, number> & { total: number; selectable: number; withMint: number } {
  const c = { native: 0, listed: 0, discovered: 0, unavailable: 0, total: list.length, selectable: 0, withMint: 0 };
  for (const p of list) { c[p.status]++; if (pairSelectable(p)) c.selectable++; if (p.mint && p.mint !== "native") c.withMint++; }
  return c;
}

/** By symbol (case, a leading "$" and a trailing "!" don't matter: "$WIF" or "wif", "LMAO!" or "lmao") or by mint. */
const symKey = (s: string) => s.toLowerCase().replace(/^\$/, "").replace(/!+$/, "");
export const findPair = (id: string, list: PairAsset[] = PUMPFUN_PAIRS) => list.find((p) => p.id.toLowerCase() === id.toLowerCase() || (p.mint && p.mint === id)) ?? list.find((p) => symKey(p.id) === symKey(id) || (p.aka ?? []).some((a) => symKey(a) === symKey(id)));
export const tilesOf = (list: PairAsset[] = PUMPFUN_PAIRS) => TILE_ORDER.map((id) => list.find((p) => p.id === id)).filter((p): p is PairAsset => !!p && pairSelectable(p));
/** Pairs discovery has seen in real creates (listed or not), most creates first. SOL is left out. */
export const seenRecently = (list: PairAsset[] = PUMPFUN_PAIRS) => list.filter((p) => p.mint !== "native" && (p.status === "discovered" || (p.seenCount ?? 0) > 0)).sort((a, b) => (b.seenCount ?? 0) - (a.seenCount ?? 0) || (b.seenAt ?? 0) - (a.seenAt ?? 0));

/** Search by symbol (or its alias), name, issuer or mint; results grouped by category in CATEGORY_ORDER. */
export function searchPairs(q: string, list: PairAsset[] = PUMPFUN_PAIRS): Array<{ category: PairCategory; label: string; items: PairAsset[] }> {
  const s = q.trim().toLowerCase();
  const hit = (p: PairAsset) => !s || p.id.toLowerCase().includes(s) || (p.aka ?? []).some((a) => a.toLowerCase().includes(s)) || p.name.toLowerCase().includes(s) || (p.issuer ?? "").toLowerCase().includes(s) || CATEGORY_LABEL[p.category].toLowerCase().startsWith(s) || (s.length >= 6 && (p.mint ?? "").toLowerCase().startsWith(s));
  return CATEGORY_ORDER.map((c) => ({ category: c, label: CATEGORY_LABEL[c], items: list.filter((p) => p.category === c && hit(p)) })).filter((g) => g.items.length);
}

/**
 * Merge pairs learned live (discovery) into the registry: an unavailable entry with no mint and the same symbol gains the
 * mint and becomes "discovered" (keeping its category); an unknown mint is added as "discovered" under Discovered, with
 * the name and decimals read on chain (its symbol suffixed with the mint's start when a listed pair already uses it).
 * A known mint is never overwritten by a discovered one. Excluded mints (ANSEM, ALON, Cupsey) are dropped.
 */
export function mergeSeen(list: PairAsset[], seen: Array<{ mint: string; symbol?: string; name?: string; decimals?: number; at: number; count?: number }>): PairAsset[] {
  const out = list.map((p) => ({ ...p }));
  for (const s of seen) {
    if (s.mint in EXCLUDED_QUOTES) continue;
    const byMint = out.find((p) => p.mint === s.mint);
    if (byMint) { byMint.seenAt = s.at; byMint.seenCount = s.count ?? byMint.seenCount; if (byMint.decimals === undefined && s.decimals !== undefined) byMint.decimals = s.decimals; continue; }
    const sym = (s.symbol ?? "").trim();
    // only an entry with no mint at all can take a discovered one
    const pend = sym ? out.find((p) => p.status === "unavailable" && p.mint === null && p.id.toLowerCase() === sym.toLowerCase()) : undefined;
    if (pend) { Object.assign(pend, { mint: s.mint, status: "discovered" as const, decimals: s.decimals, seenAt: s.at, seenCount: s.count, source: SOURCES.discovered }); continue; }
    // v27 G: a new mint using the symbol of a pair we already list is told apart by its mint (no two rows read "WETH")
    const taken = sym && out.some((p) => p.id.toLowerCase() === sym.toLowerCase() || (p.aka ?? []).some((a) => a.toLowerCase() === sym.toLowerCase()));
    out.push({
      id: !sym ? `${s.mint.slice(0, 4)}…` : taken ? `${sym} ${s.mint.slice(0, 4)}…` : sym, name: (s.name ?? sym) || "Unnamed token", category: "other", mint: s.mint, logo: null, status: "discovered", decimals: s.decimals,
      seenAt: s.at, seenCount: s.count, source: SOURCES.discovered, verify: true,
    });
  }
  return out;
}

// --------------------------------------------------------------------------------------------- fees on custom pairs

/** A settable creator fee, in percent. */
export interface FeeRange { min: number; max: number; step: number }
/** Custom pairs: 0.05% to 1%, paid in the quote asset (press, September 2026). Verify on the first live launch. */
export const CUSTOM_PAIR_FEE: FeeRange = { min: 0.05, max: 1, step: 0.05 };
export const CUSTOM_PAIR_FEE_PRESETS = [0.05, 0.25, 0.5, 1];
/** Fee split: up to 10 recipients (press). Verify the field and its shape on the first live launch. */
export const MAX_FEE_RECIPIENTS = 10;
