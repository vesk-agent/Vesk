import { test } from "node:test";
import assert from "node:assert/strict";
import { ageLabel, applyPulse, curvePct, emptyPulse, protocolOf, pulseColumn, prunePulse, reusedX, tradeSubscribe, withMetadata, xKey } from "../src/watch/pulse.js";
import {
  auditFlags, cleanFilter, countHolders, funderFromTx, holderScanParams, DEFAULT_THRESHOLDS, defaultPulseSettings, exportPulseSettings, filterCount, importPulseSettings, pulseAudits, pulseColumnView, pulseFails,
} from "../src/watch/audits.js";
import { defaultTradingSettings, execParams, needsConfirm, normalizeTradingSettings, validateTradingSettings } from "../src/trade/settings.js";
import { MINT_A, MINT_B, MINT_C, WALLET_1, WALLET_2 } from "./fixtures.js";
import { b58decode, b58encode } from "../src/base58.js";

const T0 = 1_700_000_000_000;
const W3 = "3xQ8vR6sWnZ4yJm2KpLc9TbFhD7gNa5Ue1oXiYtVrS2q";
const W4 = "4yR9wS7tXoA5zKn3LqMd1UcGiE8hPb6Vf2pYjZuWsT3r";

test("curve progress from virtual SOL: 30 → 0 %, 115 → 100 %, clamped", () => {
  assert.equal(curvePct(30), 0);
  assert.equal(curvePct(115), 100);
  assert.equal(curvePct(98), 80);
  assert.equal(curvePct(10), 0);
  assert.equal(curvePct(500), 100);
  assert.equal(curvePct(Number.NaN), 0);
});

test("creates land in New pairs, trades move a coin to Final stretch, migration to Migrated", () => {
  const s = emptyPulse();
  const r = applyPulse(s, { txType: "create", mint: MINT_A, name: "Night Owl", symbol: "OWL", traderPublicKey: WALLET_1, solAmount: 1, initialBuy: 30_000_000, vSolInBondingCurve: 31, marketCapSol: 29, pool: "pump" }, T0);
  assert.equal(r.isNew, true);
  assert.equal(pulseColumn(s.tokens[MINT_A]), "new");
  assert.equal(s.tokens[MINT_A].protocol, "pumpfun");
  assert.equal(applyPulse(s, { txType: "create", mint: MINT_A, name: "dup" }, T0).changed, undefined, "duplicate create ignored");
  applyPulse(s, { txType: "buy", mint: MINT_A, traderPublicKey: WALLET_2, solAmount: 40, tokenAmount: 100_000_000, vSolInBondingCurve: 100, marketCapSol: 300 }, T0 + 1000);
  applyPulse(s, { txType: "buy", mint: MINT_A, traderPublicKey: WALLET_2, solAmount: 1, tokenAmount: 1_000_000, vSolInBondingCurve: 101, marketCapSol: 310 }, T0 + 2000);
  const t = s.tokens[MINT_A];
  assert.equal(pulseColumn(t), "final");
  assert.equal(t.buys, 3);
  assert.equal(t.traders, 2, "distinct traders, not trades");
  assert.equal(t.volSol, 42);
  assert.equal(s.bal[MINT_A][WALLET_2], 101_000_000);
  assert.equal(t.liquiditySol, 71);
  applyPulse(s, { txType: "migrate", mint: MINT_A, pool: "pump-amm" }, T0 + 3000);
  assert.equal(pulseColumn(t), "migrated");
  assert.equal(s.devs[WALLET_1].migrated, 1);
  applyPulse(s, { txType: "sell", mint: MINT_A, traderPublicKey: WALLET_2, tokenAmount: 1_000_000, vSolInBondingCurve: 50, marketCapSol: 200 }, T0 + 4000);
  assert.equal(t.curvePct, 100, "trades after migration don't move the curve");
  assert.equal(s.bal[MINT_A][WALLET_2], 100_000_000);
  assert.equal(applyPulse(s, { txType: "buy", mint: MINT_B, solAmount: 1 }).changed, undefined, "trades for unknown coins ignored");
  assert.equal(protocolOf("bonk"), "letsbonk");
  assert.equal(protocolOf("something-new"), "other");
});

test("audits: dev %, top 10, snipers (3 s), creation-block bundled, insiders from funding sources", () => {
  const s = emptyPulse();
  applyPulse(s, { txType: "create", mint: MINT_A, name: "Fog", symbol: "FOG", traderPublicKey: WALLET_1, initialBuy: 50_000_000, solAmount: 1.5, vSolInBondingCurve: 31.5, marketCapSol: 31 }, T0);
  applyPulse(s, { txType: "buy", mint: MINT_A, traderPublicKey: WALLET_2, tokenAmount: 80_000_000, solAmount: 3, vSolInBondingCurve: 35 }, T0 + 300); // same block
  applyPulse(s, { txType: "buy", mint: MINT_A, traderPublicKey: W3, tokenAmount: 20_000_000, solAmount: 1, vSolInBondingCurve: 36 }, T0 + 2000); // sniper, not bundled
  applyPulse(s, { txType: "buy", mint: MINT_A, traderPublicKey: W4, tokenAmount: 10_000_000, solAmount: 0.5, vSolInBondingCurve: 36.5 }, T0 + 60_000); // late
  const t = s.tokens[MINT_A];
  const a = pulseAudits(s, t);
  assert.equal(a.devPct, 5);
  assert.equal(a.top10Pct, 16);
  assert.equal(a.snipersPct, 10, "WALLET_2 + W3 within 3 s, dev excluded");
  assert.equal(a.bundledPct, 13, "without funding data: every creation-block buy (dev 5% + 8%)");
  assert.equal(a.insidersPct, null, "unknown without funding sources");
  assert.equal(a.holders, 4);
  assert.equal(a.source, "stream");
  // funding: WALLET_2 was funded by the dev → bundled together and an insider; W3 and W4 share a funder → insiders
  const e = { funding: { [WALLET_2]: WALLET_1, [W3]: MINT_C, [W4]: MINT_C } };
  const b = pulseAudits(s, t, e);
  assert.equal(b.bundledPct, 13);
  assert.equal(b.insidersPct, 11);
  const c = pulseAudits(s, t, { funding: { [WALLET_2]: MINT_B } });
  assert.equal(c.bundledPct, 5, "an unrelated creation-block buyer isn't 'bundled' once funding is known");
  const flags = auditFlags(a, DEFAULT_THRESHOLDS);
  assert.equal(flags.top10Pct, false);
  assert.equal(flags.holders, true, "fewer holders than the threshold is flagged");
  assert.equal(auditFlags({ ...a, devPct: 25 }, DEFAULT_THRESHOLDS).devPct, true);
});

test("filters: keywords, exclude, protocol, audit and metric ranges, socials, reused X, CA ends in pump; counts per filter", () => {
  const s = emptyPulse();
  applyPulse(s, { txType: "create", mint: MINT_A, name: "Night Owl", symbol: "OWL", traderPublicKey: WALLET_1, initialBuy: 200_000_000, vSolInBondingCurve: 32, marketCapSol: 30 }, T0);
  applyPulse(s, { txType: "create", mint: MINT_B, name: "Harbour", symbol: "HRB", traderPublicKey: WALLET_2, initialBuy: 10_000_000, vSolInBondingCurve: 33, marketCapSol: 60, pool: "bonk" }, T0 + 60_000);
  applyPulse(s, { txType: "create", mint: MINT_C, name: "Owl Copy", symbol: "OWLC", traderPublicKey: W3, vSolInBondingCurve: 34, marketCapSol: 40 }, T0 + 90_000);
  withMetadata(s.tokens[MINT_A], { twitter: "https://x.com/nightowl", image: "javascript:alert(1)" }, s);
  withMetadata(s.tokens[MINT_C], { twitter: "https://twitter.com/NightOwl" }, s);
  assert.equal(s.tokens[MINT_A].image, undefined, "only https images");
  assert.equal(reusedX(s, s.tokens[MINT_C]), true, "same X account, written differently");
  assert.equal(reusedX(s, s.tokens[MINT_A]), false, "the first coin to use it isn't 'reused'");
  assert.equal(xKey("https://x.com/NightOwl/status/1"), "nightowl/1");
  const ctx = { solUsd: 150, now: T0 + 120_000 };
  const all = pulseColumnView(s, "new", {}, ctx);
  assert.deepEqual(all.rows.map((r) => r.t.symbol), ["OWLC", "HRB", "OWL"]);
  const v = pulseColumnView(s, "new", { keywords: ["owl"], exclude: ["copy"], audits: { devPct: { max: 10 } } }, ctx);
  assert.deepEqual(v.rows.map((r) => r.t.symbol), []);
  assert.equal(v.hiddenBy.keywords, 1);
  assert.equal(v.hiddenBy.exclude, 1);
  assert.equal(v.hiddenBy["audit.devPct"], 1, "OWL's dev holds 20%");
  assert.deepEqual(pulseColumnView(s, "new", { protocols: ["letsbonk"] }, ctx).rows.map((r) => r.t.symbol), ["HRB"]);
  assert.deepEqual(pulseColumnView(s, "new", { metrics: { mcapUsd: { min: 6001 } } }, ctx).rows.map((r) => r.t.symbol), ["HRB"]);
  assert.deepEqual(pulseColumnView(s, "new", { metrics: { ageSec: { max: 70 } } }, ctx).rows.map((r) => r.t.symbol), ["OWLC", "HRB"]);
  assert.deepEqual(pulseColumnView(s, "new", { socials: { x: true, excludeReusedX: true } }, ctx).rows.map((r) => r.t.symbol), ["OWL"]);
  assert.deepEqual(pulseFails(s, s.tokens[MINT_C], { pumpSuffix: true }, ctx), ["pumpSuffix"]);
  assert.deepEqual(pulseFails(s, s.tokens[MINT_A], { pumpSuffix: true }, ctx), [], "MINT_A ends in pump");
  assert.deepEqual(pulseColumnView(s, "new", { audits: { insidersPct: { max: 5 } } }, ctx).rows.length, 3, "unknown audits pass by default");
  assert.deepEqual(pulseColumnView(s, "new", { audits: { insidersPct: { max: 5 } }, hideUnknown: true }, ctx).rows.length, 0);
  assert.deepEqual(pulseColumnView(s, "new", {}, ctx, { hidden: [MINT_A], hiddenDevs: [WALLET_2] }).rows.map((r) => r.t.symbol), ["OWLC"]);
});

test("settings import/export round trip; bad JSON and junk values are rejected or dropped", () => {
  const st = defaultPulseSettings();
  st.columns.new.filter = { keywords: ["owl"], audits: { devPct: { max: 10 } }, socials: { x: true } };
  st.columns.final.preset = "p3";
  const back = importPulseSettings(exportPulseSettings(st));
  assert.deepEqual(back.columns.new.filter.keywords, ["owl"]);
  assert.deepEqual(back.columns.new.filter.audits, { devPct: { max: 10 } });
  assert.equal(back.columns.final.preset, "p3");
  assert.equal(filterCount(back.columns.new.filter), 3);
  assert.throws(() => importPulseSettings("{nope"), /valid JSON/);
  const bare = importPulseSettings(JSON.stringify({ keywords: ["cat"], audits: { top10Pct: { max: "a lot" } }, evil: true }));
  assert.deepEqual(bare.columns.migrated.filter.keywords, ["cat"]);
  assert.deepEqual(bare.columns.migrated.filter.audits, {}, "non-numbers dropped");
  assert.deepEqual(cleanFilter({ protocols: ["pumpfun", "nope"] }).protocols, ["pumpfun"]);
});

test("funding source from a parsed transaction", () => {
  const tx = { transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: WALLET_1, destination: WALLET_2, lamports: 1e9 } } }] } } };
  assert.equal(funderFromTx(tx, WALLET_2), WALLET_1);
  assert.equal(funderFromTx(tx, W3), undefined);
});

test("trading presets: validation, MEV modes, auto fee cap, confirmation", () => {
  const d = defaultTradingSettings();
  assert.deepEqual(validateTradingSettings(d), []);
  const bad = normalizeTradingSettings({ buy: { p1: { slippagePct: 80, mev: "secure", jitoTipSol: 0 } } } as never);
  const msgs = validateTradingSettings(bad).map((e) => e.message).join(" ");
  assert.match(msgs, /slippage must be/);
  assert.match(msgs, /needs a tip/);
  const sec = execParams({ ...d.buy.p2, mev: "secure", slippagePct: 30 });
  assert.equal(sec.slippageBps, 1000, "secure caps slippage at 10%");
  assert.equal(sec.jitoOnly, true);
  assert.equal(execParams(d.buy.p1).jitoOnly, false);
  assert.equal(execParams({ ...d.buy.p3, priorityFeeSol: 0.001, maxFeeSol: 0.004 }, 0.02).priorityFeeSol, 0.004, "auto fee capped");
  assert.equal(execParams({ ...d.buy.p3, priorityFeeSol: 0.001, maxFeeSol: 0.004 }, 0.0002).priorityFeeSol, 0.001, "fixed fee is the floor");
  assert.equal(needsConfirm(d, 2), true);
  assert.equal(needsConfirm(d, 0.5), false);
  const dup = { ...d, hotkeys: [{ key: "b", action: "buy-active" as const }, { key: "B", action: "sell-50" as const }] };
  assert.match(validateTradingSettings(dup).map((e) => e.message).join(" "), /used twice/);
});

test("prune drops quiet coins early on the curve, keeps the final stretch", () => {
  const s = emptyPulse();
  applyPulse(s, { txType: "create", mint: MINT_A, name: "A", symbol: "A", vSolInBondingCurve: 31 }, T0);
  applyPulse(s, { txType: "create", mint: MINT_B, name: "B", symbol: "B", vSolInBondingCurve: 110 }, T0);
  assert.deepEqual(prunePulse(s, T0 + 30 * 60_000), [MINT_A]);
  assert.ok(s.tokens[MINT_B]);
  assert.deepEqual(tradeSubscribe([MINT_B]), { method: "subscribeTokenTrade", keys: [MINT_B] });
});

test("age labels", () => {
  assert.equal(ageLabel(T0, T0 + 4000), "4s");
  assert.equal(ageLabel(T0, T0 + 5 * 60_000), "5m");
  assert.equal(ageLabel(T0, T0 + 3 * 3_600_000), "3h");
  assert.equal(ageLabel(T0, T0 + 2 * 86_400_000), "2d");
});

test("holder count from getProgramAccounts: non-zero amounts, unique owners, curve removed", () => {
  const row = (owner: string, amount: bigint) => {
    const b = new Uint8Array(40);
    b.set(b58decode(owner)!, 0);
    new DataView(b.buffer).setBigUint64(32, amount, true);
    return { account: { data: [btoa(String.fromCharCode(...b)), "base64"] as [string, string] } };
  };
  const rows = [row(WALLET_1, 5n), row(WALLET_1, 7n), row(WALLET_2, 0n), row(MINT_B, 9n), row(MINT_C, 1n)];
  assert.equal(countHolders(rows, new Set([MINT_C]), b58encode), 2); // WALLET_1 once, WALLET_2 empty, MINT_C is the curve
  const p = holderScanParams("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", MINT_A) as [string, { dataSlice: { offset: number; length: number }; filters: unknown[] }];
  assert.equal(p[0], "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  assert.deepEqual(p[1].dataSlice, { offset: 32, length: 40 });
  assert.deepEqual(p[1].filters, [{ memcmp: { offset: 0, bytes: MINT_A } }]);
});
