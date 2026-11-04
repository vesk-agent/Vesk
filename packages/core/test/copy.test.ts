import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { classifyTx, fromPumpPortal, venueOf, type TargetTrade } from "../src/copy/classify.js";
import {
  copyAmount, copySpentToday, copyStats, decideCopy, decideSell, factsNeeded, feedLine, latencyOf, SigDedupe, type CopyCounters, type CopyFacts, type CopyFeedItem,
} from "../src/copy/engine.js";
import {
  bulkEdit, copyWalletsToBook, defaultCopyConfig, describeProfile, effectiveProfile, exportCopyWallets, importCopyWallets, normalizeCopyConfig, parseTpLadder, parseUsdAmount,
  parseWalletList, TEMPLATES, upsertCopyWallet, validateProfile, type CopyConfig, type CopyWallet,
} from "../src/copy/settings.js";
import { resolveCopyDraft } from "../src/copy/parse.js";
import { parseIntent } from "../src/rules/parse.js";
import { CopyDetector, HeliusSource } from "../src/copy/detect.js";
import { parseMetaplex, socialsOf } from "../src/copy/facts.js";
import { blacklistHit, indexBlacklist, normalizeBlacklist } from "../src/watch/blacklist.js";
import { COIN, COIN2, FAILED_BUY, JUPITER_BUY, PUMP_BUY, PUMP_SELL, PUMP_SELL_ALL_CLOSE, PUMPSWAP_BUY, TARGET, USDC_SWAP } from "./copyFixtures.js";
import { MINT_C, WALLET_2 } from "./fixtures.js";
// @ts-expect-error plain JS helper shared with the e2e mocks
import { acceptWebSocket } from "../../../e2e/ws.mjs";

const NOW = Date.parse("2026-10-15T12:00:00Z");

// ---------------------------------------------------------------- classification (fixtures)

test("classify: pump.fun buy → buy 0.5 SOL (fee and new account rent excluded), venue pump.fun, block time", () => {
  const c = classifyTx(PUMP_BUY, TARGET, NOW);
  assert.ok(c.ok);
  const t = c.trade;
  assert.equal(t.side, "buy"); assert.equal(t.mint, COIN); assert.equal(t.sol, 0.5); assert.equal(t.tokens, 17_500_000);
  assert.equal(t.venue, "pumpfun"); assert.equal(t.tokensBefore, 0); assert.equal(t.blockTimeMs, 1_760_000_000_000); assert.equal(t.slot, 312_000_000);
  assert.ok(Math.abs(t.priceSol! - 0.5 / 17_500_000) < 1e-15);
});

test("classify: pump.fun sell of half → sell 50%, 0.31 SOL", () => {
  const c = classifyTx(PUMP_SELL, TARGET);
  assert.ok(c.ok);
  assert.equal(c.trade.side, "sell"); assert.equal(c.trade.sellPct, 50); assert.equal(c.trade.sol, 0.31); assert.equal(c.trade.tokensAfter, 8_750_000);
});

test("classify: sell everything and close the account → 100%, rent not counted as proceeds", () => {
  const c = classifyTx(PUMP_SELL_ALL_CLOSE, TARGET);
  assert.ok(c.ok);
  assert.equal(c.trade.sellPct, 100); assert.equal(c.trade.sol, 0.4);
});

test("classify: PumpSwap buy paid in wrapped SOL counts the WSOL spent; an earlier balance means not their first buy", () => {
  const c = classifyTx(PUMPSWAP_BUY, TARGET);
  assert.ok(c.ok);
  assert.equal(c.trade.venue, "pumpswap"); assert.equal(c.trade.mint, COIN2); assert.equal(c.trade.sol, 0.2); assert.equal(c.trade.tokensBefore, 1000);
});

test("classify: Jupiter route → venue jupiter with the hops (Raydium, Meteora)", () => {
  const c = classifyTx(JUPITER_BUY, TARGET);
  assert.ok(c.ok);
  assert.equal(c.trade.venue, "jupiter"); assert.deepEqual(c.trade.route, ["raydium", "meteora"]); assert.equal(c.trade.sol, 1.2);
  assert.deepEqual(venueOf(PUMP_BUY), { venue: "pumpfun" });
});

test("classify: stablecoin swaps, failed transactions and other wallets are not trades", () => {
  const u = classifyTx(USDC_SWAP, TARGET);
  assert.ok(!u.ok && /stablecoin/.test(u.reason));
  const f = classifyTx(FAILED_BUY, TARGET);
  assert.ok(!f.ok && /failed/.test(f.reason));
  const o = classifyTx(PUMP_BUY, WALLET_2);
  assert.ok(!o.ok);
  assert.ok(!classifyTx(null, TARGET).ok);
});

test("PumpPortal account trade → trade with sell % from the new balance; bonk / pump-amm venues", () => {
  const b = fromPumpPortal({ signature: "s1", mint: COIN, traderPublicKey: TARGET, txType: "buy", tokenAmount: 1000, solAmount: 0.3, newTokenBalance: 1000, marketCapSol: 80, pool: "pump" }, NOW)!;
  assert.equal(b.side, "buy"); assert.equal(b.tokensBefore, 0); assert.equal(b.mcapSol, 80); assert.equal(b.venue, "pumpfun"); assert.equal(b.source, "pumpportal");
  const s = fromPumpPortal({ signature: "s2", mint: COIN, traderPublicKey: TARGET, txType: "sell", tokenAmount: 300, solAmount: 0.1, newTokenBalance: 700, pool: "pump-amm" }, NOW)!;
  assert.equal(s.sellPct, 30); assert.equal(s.venue, "pumpswap");
  assert.equal(fromPumpPortal({ signature: "s3", mint: COIN, traderPublicKey: TARGET, txType: "buy", pool: "bonk" })!.venue, "launchlab");
  assert.equal(fromPumpPortal({ mint: COIN, traderPublicKey: TARGET, txType: "create" }), null);
});

// ---------------------------------------------------------------- settings

const W: CopyWallet = { address: TARGET, label: "degen", tag: "ice", enabled: true, addedAt: "2026-10-01T00:00:00Z" };
const cfgWith = (w: Partial<CopyWallet> = {}): CopyConfig => upsertCopyWallet(defaultCopyConfig(), { ...W, ...w });

test("settings: templates validate, overrides merge field by field, exits replace", () => {
  for (const t of Object.values(TEMPLATES)) assert.deepEqual(validateProfile(t.profile), [], t.label);
  const c = cfgWith({ overrides: { amount: { value: 0.3, mode: "fixed" }, filters: { maxMcapUsd: 300_000 }, exit: { stopLossPct: 20 } } });
  const p = effectiveProfile(c.defaults, c.wallets[0]);
  assert.equal(p.amount.value, 0.3); assert.equal(p.amount.maxSol, c.defaults.amount.maxSol);
  assert.equal(p.filters.maxMcapUsd, 300_000); assert.equal(p.filters.minLiquiditySol, c.defaults.filters.minLiquiditySol);
  assert.deepEqual(p.exit, { stopLossPct: 20 });
  assert.ok(describeProfile(p).some((l) => /skip above \$300k mcap/.test(l)));
});

test("settings: validation catches bad numbers and bad wallets", () => {
  const p = { ...TEMPLATES.balanced.profile, amount: { mode: "pct" as const, value: 2000, minSol: 0.5, maxSol: 0.1 }, delayMs: 999_999 };
  const e = validateProfile(p).map((x) => x.field);
  assert.ok(e.includes("amount.value") && e.includes("amount.minSol") && e.includes("delayMs"));
  assert.throws(() => upsertCopyWallet(defaultCopyConfig(), { address: "nope" }), /address/);
  assert.equal(normalizeCopyConfig({ wallets: [{ address: "bad" }, W, W] }).wallets.length, 1);
});

test("settings: CLI helpers parse 300k, $1.2m and a TP ladder", () => {
  assert.equal(parseUsdAmount("300k"), 300_000); assert.equal(parseUsdAmount("$1.2m"), 1_200_000); assert.ok(Number.isNaN(parseUsdAmount("lots")));
  assert.deepEqual(parseTpLadder("5x:100,2x:50"), [{ atMultiple: 2, sellPct: 50 }, { atMultiple: 5, sellPct: 100 }]);
  assert.throws(() => parseTpLadder("2x"), /take-profit/);
});

test("settings: paste many, CSV / JSON / address-book import, export round trip", () => {
  const l = parseWalletList(`${TARGET} degen\n${WALLET_2}, ${MINT_C}\nnot an address\n${TARGET}`);
  assert.equal(l.items.length, 3); assert.equal(l.items[0].label, "degen"); assert.equal(l.errors.length, 1);
  const c = cfgWith({ group: "KOLs", overrides: { mode: "auto", filters: { maxMcapUsd: 250_000 } } });
  const csv = exportCopyWallets(c, "csv");
  const back = importCopyWallets(csv, c.defaults);
  assert.deepEqual(back.errors, []);
  assert.equal(back.wallets[0].group, "KOLs"); assert.equal(back.wallets[0].overrides?.mode, "auto"); assert.equal(back.wallets[0].overrides?.filters?.maxMcapUsd, 250_000);
  const j = importCopyWallets(exportCopyWallets(c, "json"), c.defaults);
  assert.deepEqual(j.wallets[0].overrides, c.wallets[0].overrides);
  const book = importCopyWallets(`address,label,marker,bookmark,note\n${WALLET_2},Whale,ice,no,from book`, c.defaults);
  assert.equal(book.wallets[0].label, "Whale"); assert.equal(book.wallets[0].notes, "from book");
  const bad = importCopyWallets(`address,label,mode\nxyz,Bad,auto`, c.defaults);
  assert.equal(bad.wallets.length, 0); assert.match(bad.errors[0], /Row 1/);
  assert.equal(copyWalletsToBook(c)[0].track, true);
});

test("settings: bulk edit applies a template, a group and a switch to many wallets", () => {
  let c = cfgWith();
  c = upsertCopyWallet(c, { address: WALLET_2, label: "two" });
  c = bulkEdit(c, [TARGET, WALLET_2], { template: "conservative", group: "Night", enabled: false });
  assert.ok(c.wallets.every((w) => w.template === "conservative" && w.group === "Night" && !w.enabled));
  assert.equal(effectiveProfile(c.defaults, c.wallets[1]).mode, "confirm");
  c = bulkEdit(c, [WALLET_2], { overrides: { filters: { maxMcapUsd: 99_000 } } });
  assert.equal(effectiveProfile(c.defaults, c.wallets[1]).filters.maxMcapUsd, 99_000);
  assert.equal(effectiveProfile(c.defaults, c.wallets[1]).filters.maxDevPct, TEMPLATES.conservative.profile.filters.maxDevPct);
  assert.ok(c.groups.includes("Night"));
});

// ---------------------------------------------------------------- decisions

const buy = (o: Partial<TargetTrade> = {}): TargetTrade => ({ signature: "sigA", wallet: TARGET, side: "buy", mint: COIN, sol: 1, tokens: 1e6, tokensBefore: 0, venue: "pumpfun", source: "pumpportal", detectedAt: NOW, ...o });
const counters = (o: Partial<CopyCounters> = {}): CopyCounters => ({ spentWalletTodaySol: 0, spentTotalTodaySol: 0, openCopies: 0, targetBoughtBefore: false, holding: false, blacklist: null, now: NOW, ...o });
const facts: CopyFacts = { mcapUsd: 120_000, mcapSource: "their-trade", liquiditySol: 30, ageSec: 400, devPct: 3, top10Pct: 20, bundledPct: 5, socials: { x: true, telegram: false, website: true }, name: "Night Owl", symbol: "OWL", mintRevoked: true, freezeRevoked: true };
const strict = (filters: Partial<CopyConfig["defaults"]["filters"]> = {}, rest: Partial<CopyConfig["defaults"]> = {}) => {
  const c = defaultCopyConfig();
  c.defaults = { ...c.defaults, mode: "auto", ...rest, filters: { firstBuyOnly: true, missingData: "skip", ...filters } };
  return c;
};

test("decide: max market cap skips with the reason (\"mcap $412k > max $250k\")", () => {
  const d = decideCopy(strict({ maxMcapUsd: 250_000 }), W, buy(), { ...facts, mcapUsd: 412_000 }, counters());
  assert.deepEqual(d, { ok: false, code: "mcap-max", reason: "mcap $412k > max $250k" });
  const ok = decideCopy(strict({ maxMcapUsd: 250_000 }), W, buy(), facts, counters());
  assert.ok(ok.ok && ok.action === "copy");
  const now = decideCopy(strict({ maxMcapUsd: 250_000 }), W, buy(), { ...facts, mcapUsd: 300_000, mcapSource: "now" }, counters());
  assert.ok(!now.ok && now.reason === "mcap $300k (now) > max $250k");
});

test("decide: every entry filter skips with its own reason", () => {
  const cases: Array<[Partial<CopyConfig["defaults"]["filters"]>, Partial<CopyFacts> | null, Partial<TargetTrade> | null, RegExp]> = [
    [{ minMcapUsd: 200_000 }, null, null, /mcap \$120k < min \$200k/],
    [{ minLiquiditySol: 50 }, null, null, /liquidity 30 SOL < min 50 SOL/],
    [{ minAgeSec: 600 }, null, null, /age 400 s < min 600 s/],
    [{ maxAgeSec: 60 }, null, null, /age 400 s > max 60 s/],
    [{ minTargetBuySol: 2 }, null, null, /their buy 1 SOL < min 2 SOL/],
    [{ maxDevPct: 2 }, null, null, /dev holds 3% > max 2%/],
    [{ maxTop10Pct: 10 }, null, null, /top 10 20% > max 10%/],
    [{ maxBundledPct: 4 }, null, null, /bundled 5% > max 4%/],
    [{ requireSocials: ["x", "telegram"] }, null, null, /no telegram link/],
    [{ venues: ["pumpswap"] }, null, null, /venue pump\.fun curve not in your list/],
    [{ include: ["cat"] }, null, null, /none of cat/],
    [{ exclude: ["owl"] }, null, null, /contains "owl"/],
    [{ mintRevoked: true }, { mintRevoked: false }, null, /mint authority not revoked/],
    [{}, null, { tokensBefore: 5 }, null as unknown as RegExp],
  ];
  for (const [f, x, t, re] of cases) {
    const d = decideCopy(strict(f), W, buy(t ?? {}), { ...facts, ...(x ?? {}) }, counters({ targetBoughtBefore: (t?.tokensBefore ?? 0) > 0 }));
    if (!re) { assert.ok(!d.ok && d.code === "first-buy", JSON.stringify(d)); continue; }
    assert.ok(!d.ok && re.test(d.reason), `${JSON.stringify(f)} → ${JSON.stringify(d)}`);
  }
  // every buy (not first-only) copies adds
  const every = decideCopy(strict({ firstBuyOnly: false }), W, buy({ tokensBefore: 5 }), facts, counters({ targetBoughtBefore: true, holding: true }));
  assert.ok(every.ok);
});

test("decide: missing data skips by default, or passes when you allow it", () => {
  const skip = decideCopy(strict({ maxDevPct: 5 }), W, buy(), { mcapUsd: 1 }, counters());
  assert.ok(!skip.ok && skip.code === "data" && /dev holds unavailable/.test(skip.reason));
  const allow = decideCopy(strict({ maxDevPct: 5, missingData: "allow" }), W, buy(), {}, counters());
  assert.ok(allow.ok);
  assert.deepEqual(factsNeeded({ firstBuyOnly: true, missingData: "skip", maxMcapUsd: 1, maxBundledPct: 1, exclude: ["x"] }).sort(), ["bundledPct", "mcapUsd", "name", "symbol"]);
});

test("decide: amount modes with min/max caps and the per-trade cap", () => {
  const p = (amount: CopyConfig["defaults"]["amount"], maxSolPerTrade = 1) => ({ ...TEMPLATES.balanced.profile, amount, limits: { ...TEMPLATES.balanced.profile.limits, maxSolPerTrade } });
  assert.equal(copyAmount(p({ mode: "fixed", value: 0.2, minSol: 0.01, maxSol: 0.5 }), 3), 0.2);
  assert.equal(copyAmount(p({ mode: "pct", value: 10, minSol: 0.01, maxSol: 0.5 }), 3), 0.3);
  assert.equal(copyAmount(p({ mode: "pct", value: 10, minSol: 0.05, maxSol: 0.5 }), 0.1), 0.05);
  assert.equal(copyAmount(p({ mode: "multiple", value: 2, minSol: 0.01, maxSol: 0.5 }), 1), 0.5);
  assert.equal(copyAmount(p({ mode: "multiple", value: 2, minSol: 0.01, maxSol: 5 }, 0.25), 1), 0.25);
});

test("decide: limits per wallet per day, total per day, open copies, cooldown; modes", () => {
  const c = strict({}, { limits: { maxSolPerTrade: 0.5, maxSolPerWalletDay: 0.3, maxSolTotalDay: 1, maxOpenCopies: 2, tokenCooldownSec: 300 }, amount: { mode: "fixed", value: 0.2, minSol: 0.01, maxSol: 0.5 } });
  assert.match((decideCopy(c, W, buy(), facts, counters({ spentWalletTodaySol: 0.2 })) as { reason: string }).reason, /0\.2 SOL copied from degen today \(max 0\.3 SOL\)/);
  assert.match((decideCopy(c, W, buy(), facts, counters({ spentTotalTodaySol: 0.9 })) as { reason: string }).reason, /copied today \(max 1 SOL\)/);
  assert.match((decideCopy(c, W, buy(), facts, counters({ openCopies: 2 })) as { reason: string }).reason, /2 copied positions open/);
  assert.match((decideCopy(c, W, buy(), facts, counters({ lastCopyOfMintAt: NOW - 60_000 })) as { reason: string }).reason, /cooldown 300 s/);
  c.defaults.mode = "confirm";
  assert.ok((decideCopy(c, W, buy(), facts, counters()) as { action: string }).action === "confirm");
  c.defaults.mode = "alert";
  assert.ok((decideCopy(c, W, buy(), facts, counters()) as { action: string }).action === "alert");
  assert.equal((decideCopy({ ...c, enabled: false }, W, buy(), facts, counters()) as { code: string }).code, "off");
  assert.equal((decideCopy(c, { ...W, enabled: false }, buy(), facts, counters()) as { code: string }).code, "wallet-off");
  assert.equal((decideCopy(strict({}, { buys: false }), W, buy(), facts, counters()) as { code: string }).code, "buys-off");
});

test("decide: the blacklist (coin, dev or the tracked wallet itself) skips the copy", () => {
  const bl = indexBlacklist(normalizeBlacklist({ mints: [{ address: COIN }], wallets: [{ address: WALLET_2 }] }));
  const d = decideCopy(strict(), W, buy(), facts, counters({ blacklist: blacklistHit(bl, { mint: COIN }) }));
  assert.ok(!d.ok && d.code === "blacklist" && /blacklist/.test(d.reason));
  assert.ok(blacklistHit(bl, { mint: COIN2, wallet: WALLET_2 }));
});

test("sells: mirror their %, sell all, off, and nothing to sell", () => {
  const sell = { ...buy(), side: "sell" as const, sellPct: 50, tokensAfter: 10 };
  const c = defaultCopyConfig();
  c.defaults.sells = "mirror";
  assert.deepEqual(decideSell(c, W, sell, { tokens: 100 }), { ok: true, pct: 50, why: "degen sold 50%: mirroring 50%" });
  c.defaults.sells = "all";
  assert.equal((decideSell(c, W, sell, { tokens: 100 }) as { pct: number }).pct, 100);
  c.defaults.sells = "off";
  assert.ok(!decideSell(c, W, sell, { tokens: 100 }).ok);
  c.defaults.sells = "mirror";
  assert.match((decideSell(c, W, sell, undefined) as { reason: string }).reason, /no position copied/);
  assert.equal((decideSell(c, W, { ...sell, sellPct: undefined, tokensAfter: 0 }, { tokens: 1 }) as { pct: number }).pct, 100);
  assert.ok(!decideSell(c, W, { ...sell, sellPct: undefined, tokensAfter: undefined }, { tokens: 1 }).ok);
});

test("dedupe: a signature is handled once, the window is bounded; the detector dedupes across sources", () => {
  const d = new SigDedupe(3);
  assert.ok(d.first("a")); assert.ok(!d.first("a")); d.first("b"); d.first("c"); d.first("d");
  assert.ok(!d.has("a") && d.has("d")); assert.ok(!d.first(""));
  const got: TargetTrade[] = [];
  const det = new CopyDetector({ rpc: {} as never, pumpportal: false, rpcLogs: false, onTrade: (t) => got.push(t) });
  det.start([TARGET]);
  det.push(buy({ source: "pumpportal" })); det.push(buy({ source: "rpc" })); det.push(buy({ signature: "other" }));
  assert.equal(got.length, 2); assert.equal(got[0].source, "pumpportal"); assert.equal(det.firsts.pumpportal, 2);
  det.stop();
});

// ---------------------------------------------------------------- feed, stats, latency

test("feed: lines, latency parts, spend today and per-wallet stats", () => {
  const base: CopyFeedItem = { id: "1", at: NOW, wallet: TARGET, label: "degen", side: "buy", mint: COIN, theirSol: 1, theirSig: "x", venue: "pumpfun", source: "pumpportal", status: "copied", reason: "", amountSol: 0.1, latency: { detectedAt: NOW, landedAt: NOW + 180, blockTimeMs: NOW - 400, targetSlot: 10, ourSlot: 11 } };
  assert.equal(feedLine(base), "copied 0.1 SOL in 180 ms");
  assert.equal(feedLine({ ...base, status: "skipped", reason: "mcap $412k > max $250k" }), "skipped: mcap $412k > max $250k");
  assert.deepEqual(latencyOf(base.latency), { detectToLandMs: 180, blockToDetectMs: 400, slotsBehind: 1 });
  const feed = [base, { ...base, id: "2", amountSol: 0.2, wallet: WALLET_2 }, { ...base, id: "3", status: "skipped" as const, amountSol: 5 }];
  assert.equal(copySpentToday(feed, NOW), 0.3); assert.equal(copySpentToday(feed, NOW, TARGET), 0.1);
  const s = copyStats(feed, [{ mint: COIN, tokens: 10, costSol: 0.1, realizedSol: 0, copiedFrom: { wallet: TARGET } }], [{ mint: COIN2, tokens: 0, costSol: 0.1, realizedSol: 0.25, copiedFrom: { wallet: TARGET } }], NOW, () => 0.05);
  assert.equal(s[TARGET].copiesToday, 1); assert.equal(s[TARGET].skippedToday, 1); assert.equal(s[TARGET].winRate, 1);
  assert.equal(s[TARGET].pnlSol, 0.1); assert.equal(s[TARGET].p50LatencyMs, 180);
});

// ---------------------------------------------------------------- chat

test("chat: \"copy @label with 0.2 SOL, skip above 300k mcap, TP 2x 50%, SL 30%\" → copy draft, resolved by label", () => {
  const r = parseIntent("copy @degen with 0.2 SOL, skip above 300k mcap, TP 2x 50%, SL 30%");
  assert.equal(r.kind, "copy");
  if (r.kind !== "copy") return;
  assert.equal(r.draft.label, "degen");
  assert.equal(r.draft.overrides.amount?.mode, "fixed"); assert.equal(r.draft.overrides.amount?.value, 0.2);
  assert.equal(r.draft.overrides.filters?.maxMcapUsd, 300_000);
  assert.deepEqual(r.draft.overrides.exit, { takeProfit: [{ atMultiple: 2, sellPct: 50 }], stopLossPct: 30 });
  assert.ok(r.summary.includes("Skip above $300k market cap (at their buy)"));
  // "skip above 300k mcap" is a maximum only; it must not also be read as a 300k minimum.
  assert.equal(r.draft.overrides.filters?.minMcapUsd, undefined);
  assert.ok(!r.summary.some((l) => l.startsWith("Skip below")));
  const both = parseIntent("copy @degen with 0.1 SOL, skip above 1m mcap, skip below 20k");
  assert.ok(both.kind === "copy" && both.draft.overrides.filters?.maxMcapUsd === 1_000_000 && both.draft.overrides.filters?.minMcapUsd === 20_000);
  const res = resolveCopyDraft(cfgWith(), r.draft);
  assert.ok("wallet" in res && res.wallet.address === TARGET && !res.isNew);
  const unknown = resolveCopyDraft(cfgWith(), { label: "nobody", overrides: {} });
  assert.ok("error" in unknown);
  const addr = parseIntent(`copy ${WALLET_2} as whale with 25% of their buy, auto, mirror sells`);
  assert.ok(addr.kind === "copy" && addr.draft.address === WALLET_2 && addr.draft.label === "whale" && addr.draft.overrides.amount?.mode === "pct" && addr.draft.overrides.mode === "auto" && addr.draft.overrides.sells === "mirror");
  const n = resolveCopyDraft(cfgWith(), (addr as Extract<typeof addr, { kind: "copy" }>).draft);
  assert.ok("wallet" in n && n.isNew);
  assert.equal(parseIntent("copy trade volume bot").kind, "refuse");
});

// ---------------------------------------------------------------- metadata

test("facts: Metaplex metadata and socials parse", () => {
  const enc = (s: string) => { const b = new TextEncoder().encode(s); const n = new Uint8Array(4 + b.length); new DataView(n.buffer).setUint32(0, b.length, true); n.set(b, 4); return n; };
  const data = new Uint8Array([4, ...new Uint8Array(64), ...enc("Night Owl\0\0"), ...enc("OWL"), ...enc("https://x.test/m.json")]);
  assert.deepEqual(parseMetaplex(data), { name: "Night Owl", symbol: "OWL", uri: "https://x.test/m.json" });
  assert.deepEqual(socialsOf({ twitter: "https://x.com/owl", website: "https://owl.fun" }), { x: true, telegram: false, website: true });
});

// ---------------------------------------------------------------- Helius adapter against a mock socket

test("Helius adapter: subscribes with accountInclude and classifies pushed transactions without getTransaction", async () => {
  const sent: string[] = [];
  const srv = createServer();
  srv.on("upgrade", (req, socket) => {
    const ws = acceptWebSocket(req, socket);
    ws.onText = (t: string) => {
      sent.push(t);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "transactionNotification", params: { subscription: 7, result: { signature: "jupRoute444", slot: 312000001, transaction: JUPITER_BUY } } }));
    };
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const got: TargetTrade[] = [];
  const h = new HeliusSource(`ws://127.0.0.1:${port}/?api-key=test`, (t) => got.push(t));
  h.start([TARGET]);
  const t0 = Date.now();
  while (!got.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  h.stop();
  srv.closeAllConnections?.(); srv.close();
  const sub = JSON.parse(sent[0]);
  assert.equal(sub.method, "transactionSubscribe"); assert.deepEqual(sub.params[0].accountInclude, [TARGET]);
  assert.equal(got[0].venue, "jupiter"); assert.equal(got[0].source, "helius"); assert.equal(got[0].slot, 312000001);
});
