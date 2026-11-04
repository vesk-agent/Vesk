import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTrade, type GuardContext } from "../src/guardrails.js";
import { DEFAULT_LIMITS, type TradeIntent } from "../src/types.js";
import { addToBlacklist, blacklistHit, emptyBlacklist, exportBlacklist, importBlacklist, indexBlacklist, normalizeBlacklist, removeFromBlacklist } from "../src/watch/blacklist.js";
import { matchMigration, mergeMigration, newMigrationOrder, normalizeMigrationOrders, settleMigration, validateMigrationOrder } from "../src/watch/migration.js";
import { Batcher, perfParams, PERF } from "../src/watch/batcher.js";
import {
  COLUMN_IDS, contrast, defaultPanelSettings, exportPanelSettings, exportTheme, fmtMcapUsd, importPanelSettings, importTheme, metricTone, moveColumn, normalizePanelSettings, qbVars,
  THEMES, themeVars, themeWarnings, tipFloor, visibleColumns, type ThemeId,
} from "../src/ui/panelSettings.js";
import { boostsFromPairs, dexPaidFromOrders, ROW_ELEMENTS, rowFacts, token2022TaxBps } from "../src/watch/facts.js";
import { detectNewPool, newPoolMint } from "../src/watch/pools.js";
import { POOL_PROGRAMS } from "../src/data/programs.js";
import { applyPulse, emptyPulse, HIST_MAX, reusedImage, withMetadata, xHandle, xLinkKind } from "../src/watch/pulse.js";
import { fundingFromTx } from "../src/watch/audits.js";
import { normalizeTradingSettings } from "../src/trade/settings.js";
import { bookSets, importBook } from "../src/wallet/book.js";
import { MINT_A, MINT_B, MINT_C, SIG, WALLET_1, WALLET_2 } from "./fixtures.js";

const W3 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhJ8HjVk";

// ---------------------------------------------------------------- settings persistence

test("panel settings: defaults round-trip through export/import unchanged", () => {
  const d = defaultPanelSettings();
  assert.deepEqual(importPanelSettings(exportPanelSettings(d)), d);
  assert.deepEqual(normalizePanelSettings(undefined), d);
});

test("panel settings: invalid values fall back, valid ones persist", () => {
  const s = normalizePanelSettings({
    layout: { order: ["migrated", "bogus"], hidden: ["final"], view: "grid", walletSwitcher: "left", headerSync: true, syncAmount: 0.25 },
    display: { imageShape: "square", progress: "bar", roundedMcap: false, imageSize: 99, spacing: "comfy" },
    qb: { size: "ultra", style: "wide-ultra", text: "not-a-colour", glow: "strong", customFont: "Inter<script>" },
    appearance: { theme: "nord", custom: { text1: "#ABCDEF", bg2: "red" } },
    perf: "full", row: { proTraders: true, xRenames: true, tax: true },
  });
  assert.deepEqual(s.layout.order, ["migrated", "new", "final"]);
  assert.deepEqual(s.layout.hidden, ["final"]);
  assert.equal(s.layout.view, "grid");
  assert.equal(s.layout.syncAmount, 0.25);
  assert.equal(s.display.imageShape, "square");
  assert.equal(s.display.progress, "bar");
  assert.equal(s.display.roundedMcap, false);
  assert.equal(s.display.imageSize, 36);
  assert.equal(s.qb.size, "ultra");
  assert.equal(s.qb.text, "#edf0f4");
  assert.equal(s.qb.customFont, "Interscript");
  assert.equal(s.appearance.theme, "nord");
  assert.equal(s.appearance.custom.text1, "#abcdef");
  assert.equal(s.appearance.custom.bg2, THEMES.dark.bg2);
  assert.equal(s.perf, "full");
  // unavailable row elements can't be switched on; available ones can
  assert.equal(s.row.proTraders, false);
  assert.equal(s.row.xRenames, false);
  assert.equal(s.row.tax, true);
  assert.throws(() => importPanelSettings("{nope"), /valid JSON/);
});

test("panel settings: all columns hidden is refused (keeps the board usable)", () => {
  assert.deepEqual(normalizePanelSettings({ layout: { hidden: COLUMN_IDS } }).layout.hidden, []);
});

// ---------------------------------------------------------------- column reorder

test("column reorder: drag Migrated to the left, then Final to the end", () => {
  const a = moveColumn(["new", "final", "migrated"], "migrated", 0);
  assert.deepEqual(a, ["migrated", "new", "final"]);
  assert.deepEqual(moveColumn(a, "final", 9), ["migrated", "new", "final"]);
  assert.deepEqual(moveColumn(a, "new", 2), ["migrated", "final", "new"]);
  const s = defaultPanelSettings();
  s.layout.order = a;
  s.layout.hidden = ["new"];
  assert.deepEqual(visibleColumns(s), ["migrated", "final"]);
  s.display.showMigrated = false;
  assert.deepEqual(visibleColumns(s), ["final"]);
});

// ---------------------------------------------------------------- blacklist

const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({
  limits: { ...DEFAULT_LIMITS, perTradeMaxSol: 0.5, dailySpendCapSol: 2, maxOpenPositions: 3, maxBuysPerDay: 5, minSolReserve: 0.05 },
  ownWallets: [WALLET_1, WALLET_2], spentTodaySol: 0, buysToday: 0, openPositions: 0, walletBalanceSol: 5, recentFills: [], now: 1_000_000_000, ...o,
});
const buy = (o: Partial<TradeIntent> = {}): TradeIntent => ({ action: "buy", mint: MINT_A, wallet: WALLET_1, amountSol: 0.3, reason: "Pulse quick buy", ...o });

test("blacklist: normalize, add, remove, import text and JSON, export", () => {
  let b = normalizeBlacklist({ mints: [MINT_A, MINT_A, "nope", { address: MINT_B, note: "fake" }], devs: [W3] });
  assert.equal(b.mints.length, 2);
  assert.equal(b.mints[1].note, "fake");
  b = addToBlacklist(b, "funders", BINANCE, "test", new Date(0));
  assert.equal(b.funders[0].addedAt, "1970-01-01T00:00:00.000Z");
  assert.throws(() => addToBlacklist(b, "devs", "xyz"), /Solana address/);
  b = removeFromBlacklist(b, "mints", MINT_B);
  assert.equal(b.mints.length, 1);
  const t = importBlacklist(`${MINT_C}\ndevs,${WALLET_2},rugger\nbad line`, b);
  assert.equal(t.added, 2);
  assert.equal(t.list.devs.find((e) => e.address === WALLET_2)?.note, "rugger");
  const j = importBlacklist(exportBlacklist(t.list), emptyBlacklist());
  assert.equal(j.added, 5);
  assert.throws(() => importBlacklist("{bad", b), /valid JSON/);
});

test("blacklist: quick buy and rule buys of a listed coin, dev or funder are refused; sells still work", () => {
  const i = indexBlacklist(normalizeBlacklist({ mints: [MINT_B], devs: [W3], funders: [BINANCE] }));
  assert.equal(blacklistHit(i, { mint: MINT_A }), null);
  const code = (r: ReturnType<typeof checkTrade>) => (r.ok ? "ok" : r.code);
  assert.equal(code(checkTrade(buy(), ctx({ blacklist: i }))), "ok");
  assert.equal(code(checkTrade(buy({ mint: MINT_B }), ctx({ blacklist: i }))), "blacklist");
  assert.equal(code(checkTrade(buy({ dev: W3, reason: "rule: new launch" }), ctx({ blacklist: i }))), "blacklist");
  assert.equal(code(checkTrade(buy({ funder: BINANCE }), ctx({ blacklist: i }))), "blacklist");
  const sell: TradeIntent = { action: "sell", mint: MINT_B, wallet: WALLET_1, sellPct: 100, reason: "manual sell" };
  assert.equal(code(checkTrade(sell, ctx({ blacklist: i, recentFills: [{ mint: MINT_B, side: "buy", at: 0, wallet: WALLET_1, amountSol: 0.1 } as never] }))), "ok");
  const r = checkTrade(buy({ mint: MINT_B }), ctx({ blacklist: i }));
  assert.ok(!r.ok && /contract address is on your blacklist/.test(r.reason));
});

// ---------------------------------------------------------------- migration orders

test("migration orders: validate, match (sells first), settle, merge without re-arming", () => {
  assert.equal(validateMigrationOrder({ mint: "x", side: "buy", amountSol: 0 }).length, 2);
  assert.equal(validateMigrationOrder({ mint: MINT_A, side: "sell", pct: 150 })[0].field, "pct");
  const b = newMigrationOrder({ mint: MINT_A, side: "buy", amountSol: 0.2, preset: "p2", symbol: "owl" }, new Date(1000));
  const s = newMigrationOrder({ mint: MINT_A, side: "sell", pct: 100 }, new Date(2000));
  const other = newMigrationOrder({ mint: MINT_B, side: "buy", amountSol: 0.1 }, new Date(3000));
  const orders = [b, s, other];
  assert.deepEqual(matchMigration(orders, { mint: MINT_A }).map((o) => o.side), ["sell", "buy"]);
  assert.equal(matchMigration(orders, { mint: MINT_C }).length, 0);
  const after = settleMigration(orders, b.id, true, SIG, new Date(5000));
  assert.equal(after[0].status, "done");
  assert.equal(after[0].firedAt, "1970-01-01T00:00:05.000Z");
  assert.equal(matchMigration(after, { mint: MINT_A }).length, 1);
  // a panel pull with the old (armed) copy keeps the fired status; a removed order disappears
  const merged = mergeMigration(after, [b, other]);
  assert.equal(merged[0].status, "done");
  assert.equal(merged.length, 2);
  assert.equal(normalizeMigrationOrders([b, { junk: 1 }, { ...s, status: "weird" }]).length, 2);
});

// ---------------------------------------------------------------- performance profile

test("performance profile: Full renders every tick, Low batches to 1 s, Auto backs off under load", () => {
  const full = new Batcher("full");
  assert.equal([0, 1, 2, 3].filter((t) => full.push(t)).length, 4);
  const low = new Batcher("low");
  const flushes = Array.from({ length: 30 }, (_, i) => i * 100).filter((t) => low.push(t)).length;
  assert.equal(flushes, 3); // at 0, 1000, 2000 ms
  assert.equal(low.pending() > 0, true);
  assert.equal(low.due(3000), true);
  const auto = new Batcher("auto");
  let n = 0;
  for (let t = 0; t < 1000; t += 10) if (auto.push(t)) n++;
  assert.ok(n <= 3, `auto under load flushed ${n} times in 1 s`);
  assert.equal(perfParams("auto", 5).flushMs, 250);
  assert.equal(perfParams("auto", 100).flushMs, PERF.low.flushMs);
  assert.equal(PERF.low.animate, false);
  assert.ok(PERF.full.overscan > PERF.low.overscan);
});

// ---------------------------------------------------------------- themes

test("themes: every built-in theme passes AA for text, PnL colours and the accent", () => {
  for (const [id, t] of Object.entries(THEMES)) assert.deepEqual(themeWarnings(t), [], `theme ${id}`);
});

test("themes: tokens apply as CSS variables; dark is the stylesheet; custom editor values are used", () => {
  const s = defaultPanelSettings().appearance;
  assert.deepEqual(themeVars(s), {});
  const nord = themeVars({ ...s, theme: "nord" });
  // v27: themes set the v27 tokens; the old names are aliases of them in styles/v27.css
  assert.equal(nord["--s1"], THEMES.nord.bg2);
  assert.equal(nord["--s0"], THEMES.nord.bg1);
  assert.equal(nord["--t1"], THEMES.nord.text1);
  assert.equal(nord["--acc"], THEMES.nord.blue);
  assert.equal(nord["--up"], THEMES.nord.inc);
  assert.equal(nord["--cc-up-body"], THEMES.nord.candleUpBody);
  const custom = themeVars({ ...s, theme: "custom", custom: { ...THEMES.dark, bg2: "#123456", candleDownWick: "#ff0000" }, font: "Space Grotesk" });
  assert.equal(custom["--s1"], "#123456");
  assert.equal(custom["--cc-dn-wick"], "#ff0000");
  assert.match(custom["--sans"], /Space Grotesk/);
  const bad = themeWarnings({ ...THEMES.dark, text3: "#2a2a2a" });
  assert.ok(bad.some((w) => w.fg === "text3" && w.need === 4.5));
  assert.equal(importTheme(exportTheme(THEMES.teal)).bg2, THEMES.teal.bg2);
  assert.equal(importTheme('{"text1":"#ffffff"}').text1, "#ffffff");
  assert.ok(contrast("#ffffff", "#000000") > 20);
  const ids: ThemeId[] = ["dark", "night", "dusk", "astro", "neo", "crimson", "blue", "nord", "teal", "orange"];
  for (const id of ids) assert.ok(THEMES[id as Exclude<ThemeId, "custom">]);
});

// ---------------------------------------------------------------- row elements and facts

test("row elements: registry is complete and unavailable ones are off by default", () => {
  const ids = ROW_ELEMENTS.map((e) => e.id);
  for (const want of ["socials", "quote", "xRenames", "communities", "pumpLive", "feeSplit", "boosts", "imageReuse", "xFollowers", "volume", "proTraders", "kols", "devMigrations", "top10", "trackDev", "fundingAmount", "fundedExchange", "fundingTime", "flagged", "bundlers", "tax", "dexPaid"]) assert.ok(ids.includes(want), want);
  const d = defaultPanelSettings().row;
  for (const e of ROW_ELEMENTS) if (e.avail === "unavailable") assert.equal(d[e.id], false, e.id);
});

test("row facts: funding exchange label, funding time, tax, KOLs, tracked dev, flagged funder", () => {
  const s = emptyPulse();
  applyPulse(s, { txType: "create", mint: MINT_A, name: "Owl", symbol: "OWL", traderPublicKey: WALLET_1, initialBuy: 50_000_000, marketCapSol: 30 }, 100_000);
  applyPulse(s, { txType: "buy", mint: MINT_A, traderPublicKey: WALLET_2, tokenAmount: 10_000_000, solAmount: 0.3, marketCapSol: 31 }, 105_000);
  const t = s.tokens[MINT_A];
  const f = rowFacts(s, t, { devFunding: { from: BINANCE, sol: 1.5, at: 40_000 }, taxBps: 0, dexPaid: true }, { kols: new Set([WALLET_2]), trackedDevs: new Set([WALLET_1]), blacklist: indexBlacklist(normalizeBlacklist({ funders: [BINANCE] })) });
  assert.equal(f.funding?.exchange, "Binance");
  assert.equal(f.funding?.beforeCreateMs, 60_000);
  assert.equal(f.taxBps, 0);
  assert.equal(f.dexPaid, true);
  assert.equal(f.kols, 1);
  assert.equal(f.trackedDev, true);
  assert.equal(f.flagged, "funder on your blacklist");
  const none = rowFacts(s, t, undefined);
  assert.equal(none.funding, null);
  assert.equal(none.kols, null);
  assert.equal(none.taxBps, null);
  assert.equal(none.boosts, null);
});

test("Token-2022 tax, DexScreener paid and boosts, Jito tip floor parsers", () => {
  assert.equal(token2022TaxBps({ value: { data: { parsed: { info: { extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 250 } } }] } } } } }), 250);
  assert.equal(token2022TaxBps({ value: { data: { parsed: { info: { decimals: 6 } } } } }), 0);
  assert.equal(token2022TaxBps(null), undefined);
  assert.equal(dexPaidFromOrders([{ type: "tokenProfile", status: "approved" }]), true);
  assert.equal(dexPaidFromOrders([{ type: "tokenProfile", status: "processing" }]), false);
  assert.equal(dexPaidFromOrders({ error: 1 }), undefined);
  assert.equal(boostsFromPairs([{ boosts: { active: 10 } }, { boosts: { active: 30 } }, {}]), 30);
  assert.deepEqual(tipFloor([{ landed_tips_50th_percentile: 0.00001, landed_tips_75th_percentile: 0.0000365 }]), { p50: 0.00001, p75: 0.0000365 });
  assert.equal(tipFloor({}), null);
});

test("metric colours, rounded market caps, quick-buy styling", () => {
  const r = defaultPanelSettings().colors.metrics;
  assert.equal(metricTone(r.devPct, 3), "good");
  assert.equal(metricTone(r.devPct, 7), "neutral");
  assert.equal(metricTone(r.devPct, 12), "bad");
  assert.equal(metricTone(r.holders, 80), "good");
  assert.equal(metricTone(r.holders, 4), "bad");
  assert.equal(metricTone(r.insidersPct, null), "neutral");
  assert.equal(fmtMcapUsd(63_712, true), "$63.7K");
  assert.equal(fmtMcapUsd(63_712, false), "$63,712");
  assert.equal(fmtMcapUsd(1_250_000, true), "$1.25M");
  const q = qbVars({ ...defaultPanelSettings().qb, size: "ultra", style: "ultra", ultraWider: true, glow: "strong", gradient: true });
  assert.match(q.cls, /qb-ultra/);
  assert.match(q.cls, /qb-wider/);
  assert.match(q.cls, /qb-grad/);
  assert.match(q.vars["--qb-glow"], /22px/);
  assert.equal(qbVars(defaultPanelSettings().qb).vars["--qb-glow"], "none");
});

// ---------------------------------------------------------------- reducer additions

test("pulse: market-cap history for the sparkline, X link kinds and handle, image reuse", () => {
  const s = emptyPulse();
  applyPulse(s, { txType: "create", mint: MINT_A, symbol: "A", traderPublicKey: WALLET_1 }, 0);
  for (let i = 0; i < 60; i++) applyPulse(s, { txType: "buy", mint: MINT_A, traderPublicKey: WALLET_2, tokenAmount: 1, marketCapSol: 30 + i }, i);
  assert.equal(s.tokens[MINT_A].hist?.length, HIST_MAX);
  assert.equal(s.tokens[MINT_A].hist?.at(-1), 89);
  assert.equal(xLinkKind("https://x.com/i/communities/1234567"), "community");
  assert.equal(xLinkKind("https://x.com/owl_coin/status/99"), "post");
  assert.equal(xLinkKind("https://twitter.com/owl_coin"), "account");
  assert.equal(xHandle("https://x.com/owl_coin/status/99"), "owl_coin");
  assert.equal(xHandle("https://x.com/i/communities/1"), undefined);
  applyPulse(s, { txType: "create", mint: MINT_B, symbol: "B", traderPublicKey: W3 }, 0);
  withMetadata(s.tokens[MINT_A], { image: "https://ipfs.io/ipfs/abc" }, s);
  withMetadata(s.tokens[MINT_B], { image: "https://ipfs.io/ipfs/abc", twitter: "https://x.com/i/communities/5" }, s);
  assert.equal(reusedImage(s, s.tokens[MINT_A]), false);
  assert.equal(reusedImage(s, s.tokens[MINT_B]), true);
  assert.equal(s.tokens[MINT_B].xKind, "community");
});

test("funding transfer: sender, SOL and time", () => {
  const tx = { blockTime: 1700, transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: BINANCE, destination: WALLET_1, lamports: 2_500_000_000 } } }] } } };
  assert.deepEqual(fundingFromTx(tx, WALLET_1), { from: BINANCE, sol: 2.5, at: 1_700_000 });
  assert.equal(fundingFromTx(tx, WALLET_2), undefined);
});

// ---------------------------------------------------------------- new-pool detection (hand-written log fixtures)

// These follow the programs' log format ("Program <id> invoke [n]", "Program log: Instruction: <Name>"). They are
// hand-written from that format, not recorded from mainnet; docs/26-data-sources.md says so.
const DBC = POOL_PROGRAMS.find((p) => p.protocol === "meteora-dbc")!.id;
const RAY4 = POOL_PROGRAMS.find((p) => p.name === "Raydium AMM v4")!.id;
const ORCA = POOL_PROGRAMS.find((p) => p.protocol === "orca")!.id;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

test("new pools: detect the create log line of the executing program only", () => {
  const dbc = [`Program ComputeBudget111111111111111111111111111111 invoke [1]`, `Program ComputeBudget111111111111111111111111111111 success`, `Program ${DBC} invoke [1]`, `Program log: Instruction: InitializeVirtualPoolWithSplToken`, `Program ${TOKEN} invoke [2]`, `Program log: Instruction: InitializeMint2`, `Program ${TOKEN} success`, `Program ${DBC} success`];
  assert.equal(detectNewPool(dbc)?.program.protocol, "meteora-dbc");
  const ray = [`Program ${RAY4} invoke [1]`, `Program log: initialize2: InitializeInstruction2 { nonce: 254, open_time: 0 }`, `Program ${RAY4} success`];
  assert.equal(detectNewPool(ray)?.program.name, "Raydium AMM v4");
  const orcaSwap = [`Program ${ORCA} invoke [1]`, `Program log: Instruction: Swap`, `Program ${ORCA} success`];
  assert.equal(detectNewPool(orcaSwap), null);
  // a create line printed by a different (inner) program doesn't count for the outer one
  const inner = [`Program ${ORCA} invoke [1]`, `Program ${TOKEN} invoke [2]`, `Program log: Instruction: InitializePool`, `Program ${TOKEN} success`, `Program ${ORCA} success`];
  assert.equal(detectNewPool(inner), null);
  const orcaNew = [`Program ${ORCA} invoke [1]`, `Program log: Instruction: InitializePoolV2`, `Program ${ORCA} success`];
  assert.equal(detectNewPool(orcaNew)?.program.protocol, "orca");
});

test("new pools: the coin is the non-quote mint in the post balances", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  assert.deepEqual(newPoolMint({ meta: { postTokenBalances: [{ mint: SOL }, { mint: MINT_A }, { mint: MINT_A }] } }), { mint: MINT_A, quote: "SOL" });
  assert.equal(newPoolMint({ meta: { postTokenBalances: [{ mint: MINT_A }, { mint: MINT_B }] } }), null);
  assert.equal(newPoolMint(null), null);
});

// ---------------------------------------------------------------- misc

test("hotkey mode and address-book KOL / tracked flags persist", () => {
  assert.equal(normalizeTradingSettings({ hotkeyMode: "space" }).hotkeyMode, "space");
  assert.equal(normalizeTradingSettings({}).hotkeyMode, "single");
  const r = importBook(JSON.stringify({ entries: [{ address: WALLET_1, label: "a", track: true }, { address: WALLET_2, label: "b", kol: true }] }));
  const sets = bookSets(r.entries);
  assert.ok(sets.tracked.has(WALLET_1) && sets.kols.has(WALLET_2) && !sets.kols.has(WALLET_1));
});

test("wallet tracker: average-cost PnL from tracked wallets' trades", async () => {
  const { applyWalletTrade, emptyWalletBook, walletPnl } = await import("../src/watch/walletTrades.js");
  const b = emptyWalletBook();
  applyWalletTrade(b, { txType: "buy", mint: MINT_A, traderPublicKey: WALLET_1, solAmount: 1, tokenAmount: 1000 }, 1);
  applyWalletTrade(b, { txType: "buy", mint: MINT_A, traderPublicKey: WALLET_1, solAmount: 3, tokenAmount: 1000 }, 2);
  applyWalletTrade(b, { txType: "sell", mint: MINT_A, traderPublicKey: WALLET_1, solAmount: 3, tokenAmount: 1000 }, 3);
  assert.equal(applyWalletTrade(b, { txType: "create", mint: MINT_B, traderPublicKey: WALLET_1 }), null);
  const [w] = walletPnl(b);
  assert.equal(w.realizedSol, 1); // sold half (cost 2) for 3
  assert.equal(w.open, 1);
  assert.equal(w.trades, 3);
  assert.equal(b.trades[0].side, "sell");
  // a sell of tokens bought before tracking started has an unknown cost: no realized PnL
  applyWalletTrade(b, { txType: "sell", mint: MINT_C, traderPublicKey: WALLET_2, solAmount: 5, tokenAmount: 100 }, 4);
  assert.equal(walletPnl(b).find((x) => x.wallet === WALLET_2)?.realizedSol, 0);
});
