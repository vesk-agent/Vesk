/**
 * v20: the fake-pump checks (early concentration, spike then dump), selling into big buys (only after their buy
 * landed, never a buy, never ahead of it), and parallel lanes (a bounded queue, and reservations so the limits hold
 * across lanes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStrategy, normalizeStrategy, applyPreset, validateStrategy, type StrategySettings } from "../src/strategy/settings.js";
import { appliesOf, fieldOf, GROUPS, setField } from "../src/strategy/fields.js";
import { earlyConcentration, fakePumpFacts, spikeDump, type SizedTick } from "../src/strategy/fakePump.js";
import { rugCheck } from "../src/strategy/rug.js";
import { afterBigBuy, bigBuyDecision } from "../src/strategy/sellIntoBuys.js";
import { checkTrade, type GuardContext } from "../src/guardrails.js";
import { QueueFull, WorkQueue } from "../src/work/queue.js";
import { Reservations } from "../src/work/reserve.js";
import { DEFAULT_LIMITS, type Limits } from "../src/types.js";
import { State } from "../src/state.js";
import { Executor, laneOf } from "../src/trade/executor.js";
import { StrategyRunner } from "../src/strategy/runner.js";
import { PulseFeed } from "../src/watch/pulseFeed.js";
import { applyPulse, type PulseMessage } from "../src/watch/pulse.js";
import { liveView, renderLive, laneOfEvents, type PipelineEvent } from "../src/ui/pipeline.js";

process.env.VESK_DEXSCREENER_URL = "http://127.0.0.1:9";
process.env.VESK_JUP_PRICE_URL = "http://127.0.0.1:9";

const ME = "7Gk2PqWm4zXc8Vb1nRt5Hy3JdLs6Ef9Ua2Ko8Ni9fQa";
const WHALE = "WhaLe1111111111111111111111111111111111111";
const T = 1_800_000_000_000;
const SUPPLY = 1_000_000_000;
const lim: Limits = { ...DEFAULT_LIMITS, perTradeMaxSol: 1, dailySpendCapSol: 1, maxOpenPositions: 10, maxBuysPerDay: 50, minSolReserve: 0, maxBuysPerMinute: 20 };
const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({ limits: lim, ownWallets: [ME], spentTodaySol: 0, buysToday: 0, openPositions: 0, recentFills: [], walletBalanceSol: 10, now: T, ...o });
const tick = (sec: number, side: "buy" | "sell", sol: number, tokens: number, wallet: string): SizedTick => ({ at: T + sec * 1000, side, sol, tokens, wallet });

// ---------------------------------------------------------------- fake pump
test("fake pump: one wallet buying a big share early is refused with who, how much and when; a cluster counts as one", () => {
  const ticks = [tick(1, "buy", 0.5, 5_000_000, "a"), tick(3, "buy", 9, 300_000_000, "whale"), tick(6, "buy", 0.4, 2_000_000, "b"), tick(30, "buy", 5, 200_000_000, "late")];
  const c = earlyConcentration(T, ticks, SUPPLY, 10)!;
  assert.equal(c.pct, 30);
  assert.match(c.who, /^one wallet \(whal…hale\)$/);
  const s = defaultStrategy();
  const r = rugCheck(s.rug, { concentration: c, spikeDump: { hit: false, spikePct: 0, dumpPct: 0, boughtPct: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "one wallet (whal…hale) bought 30% of supply in the first 3 s (max 15%)");
  // three fresh wallets, one funder: 3 × 6% = 18% as a cluster
  const split = [tick(1, "buy", 2, 60_000_000, "w1"), tick(2, "buy", 2, 60_000_000, "w2"), tick(2, "buy", 2, 60_000_000, "w3")];
  assert.equal(earlyConcentration(T, split, SUPPLY, 10)!.pct, 6, "without funding links each wallet stands alone");
  const cl = earlyConcentration(T, split, SUPPLY, 10, (w) => (w.startsWith("w") ? "Funder11111111111111111111111111111111111" : undefined))!;
  assert.equal(cl.pct, 18);
  assert.match(cl.who, /^a cluster of 3 wallets/);
  // under the line passes; switched off reads off; not watched from creation is unknown
  assert.equal(rugCheck(s.rug, { concentration: { pct: 9, who: "x", wallets: 1, sec: 2 }, spikeDump: { hit: false, spikePct: 0, dumpPct: 0, boughtPct: 0 } }).ok, true);
  assert.equal(rugCheck({ ...s.rug, earlyConcentration: { ...s.rug.earlyConcentration, on: false } }, { concentration: c }).rows.find((x) => x.key === "concentration")!.state, "off");
  assert.equal(rugCheck(s.rug, {}).rows.find((x) => x.key === "concentration")!.state, "unknown");
});

test("fake pump: spike then dump: a big early buyer sells into the buyers it pulled in", () => {
  const ticks = [
    tick(1, "buy", 3, 100_000_000, "pumper"), // 10% at 3e-8 SOL/token
    tick(4, "buy", 2, 30_000_000, "fomo1"), tick(5, "buy", 3, 40_000_000, "fomo2"), // price up to 7.5e-8 (+150%)
    tick(9, "sell", 5, 80_000_000, "pumper"), // sells 80% of its bag
  ];
  const sd = spikeDump(defaultStrategy().rug.spikeDump, T, ticks, SUPPLY);
  assert.equal(sd.hit, true);
  assert.equal(sd.reason, "fake pump: pump…mper bought 10% of supply, price +150%, then sold 80% of it in 8 s");
  const r = rugCheck(defaultStrategy().rug, { concentration: null, spikeDump: sd });
  assert.equal(r.reason, sd.reason);
  // the same buyer selling only a little isn't a dump
  assert.equal(spikeDump(defaultStrategy().rug.spikeDump, T, [...ticks.slice(0, 3), tick(9, "sell", 1, 20_000_000, "pumper")], SUPPLY).hit, false);
  // both from one call, the way the runner asks
  const f = fakePumpFacts(defaultStrategy().rug, T, ticks, SUPPLY);
  assert.equal(f.concentration!.pct, 4, "net of sells: the pumper sold most of its 10%; fomo2's 4% is now the largest");
  assert.equal(f.spikeDump.hit, true);
});

// ---------------------------------------------------------------- sell into big buys
test("sell into big buys: only after their buy landed, only big ones, only coins we hold, with a tip that rises after a miss", () => {
  const c = { ...defaultStrategy().exits.sellIntoBuys, enabled: true, minBuySol: 5, sellPct: 50, tipSol: 0.004, maxTipSol: 0.01, cooldownSec: 30 };
  const big = { txType: "buy", mint: "M", traderPublicKey: WHALE, solAmount: 8, signature: "sigWhale1", at: T };
  const ok = bigBuyDecision(c, big, { holds: true, own: [ME], now: T });
  assert.ok(ok.sell);
  if (!ok.sell) return;
  assert.equal(ok.pct, 50);
  assert.equal(ok.tipSol, 0.004);
  assert.equal(ok.reason, "sold into a 8 SOL buy by WhaL…1111 · tip 0.004 SOL");
  assert.deepEqual(ok.trigger, { kind: "big-buy", signature: "sigWhale1", wallet: WHALE, sol: 8, at: T });
  const no = (x: Parameters<typeof bigBuyDecision>[1], o: Partial<Parameters<typeof bigBuyDecision>[2]> = {}) => { const d = bigBuyDecision(c, x, { holds: true, own: [ME], now: T, ...o }); return d.sell ? "sell" : d.why; };
  assert.equal(no({ ...big, solAmount: 2 }), "buy of 2 SOL is under 5 SOL");
  assert.equal(no({ ...big, signature: undefined }), "their buy hasn't landed yet (no signature)");
  assert.equal(no({ ...big, traderPublicKey: ME }), "our own buy");
  assert.equal(no({ ...big, txType: "sell" }), "not a buy");
  assert.equal(no(big, { holds: false }), "not holding this coin");
  assert.equal(bigBuyDecision({ ...c, enabled: false }, big, { holds: true, own: [ME], now: T }).sell, false);
  // a miss doubles the tip next time, capped; a cooldown between tries
  const missed = afterBigBuy({ ok: false, tipSol: 0.004, at: T });
  assert.equal(no(big, { state: missed, now: T + 10_000 }), "cooling down (30 s between tries)");
  const d2 = bigBuyDecision(c, big, { holds: true, own: [ME], state: missed, now: T + 31_000 });
  assert.ok(d2.sell && d2.tipSol === 0.008);
  const d3 = bigBuyDecision(c, big, { holds: true, own: [ME], state: afterBigBuy({ ok: false, tipSol: 0.008, at: T }), now: T + 31_000 });
  assert.ok(d3.sell && d3.tipSol === 0.01, "capped at the max tip");
  const d4 = bigBuyDecision(c, big, { holds: true, own: [ME], state: afterBigBuy({ ok: true, tipSol: 0.008, at: T }), now: T + 31_000 });
  assert.ok(d4.sell && d4.tipSol === 0.004, "back to the starting tip after a fill");
  assert.deepEqual(validateStrategy(normalizeStrategy({ exits: { sellIntoBuys: { tipSol: 0.05, maxTipSol: 0.01 } } })).map((e) => e.field), ["exits.sellIntoBuys.maxTipSol"]);
});

test("guardrails: a trade set off by someone else's buy can only be a sell of our own position, after their buy landed", () => {
  const trig = { kind: "big-buy" as const, signature: "sigWhale1", wallet: WHALE, sol: 8, at: T };
  const fills = [{ at: T - 3_600_000, mint: "M", side: "buy" as const, wallet: ME, amountSol: 0.1 }];
  assert.equal(checkTrade({ action: "sell", wallet: ME, mint: "M", sellPct: 50, reason: "x", trigger: trig }, ctx({ recentFills: fills, holdsMint: true })).ok, true);
  const buy = checkTrade({ action: "buy", wallet: ME, mint: "M", amountSol: 0.1, reason: "x", trigger: trig }, ctx());
  assert.equal((buy as { code: string }).code, "ahead-of-trade");
  assert.match((buy as { reason: string }).reason, /never trades ahead of or around another trader's transaction/);
  assert.equal((checkTrade({ action: "sell", wallet: ME, mint: "M", sellPct: 50, reason: "x", trigger: { ...trig, signature: undefined } }, ctx()) as { code: string }).code, "ahead-of-trade");
  assert.equal((checkTrade({ action: "sell", wallet: ME, mint: "M", sellPct: 50, reason: "x", trigger: { ...trig, wallet: ME } }, ctx()) as { code: string }).code, "self-trade");
});

// ---------------------------------------------------------------- lanes
test("lanes: a bounded queue per kind of work; launches have their own pool; first in, first out; full is refused", async () => {
  let cap = { lanes: 2, launches: 1 };
  const q = new WorkQueue(() => cap, 3);
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (name: string) => () => new Promise<string>((res) => { order.push(`start ${name}`); gates.set(name, () => { order.push(`end ${name}`); res(name); }); });
  const a = q.run("trade", job("a")), b = q.run("copy", job("b")), c = q.run("trade", job("c")), l1 = q.run("launch", job("L1")), l2 = q.run("launch", job("L2"));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["start a", "start b", "start L1"], "two lanes and one launch run; c and L2 wait");
  assert.deepEqual(q.stats().inFlight, { trade: 1, copy: 1, rogue: 0, launch: 1 });
  assert.equal(q.stats().queued, 2);
  assert.equal(q.wouldWait("rogue"), true);
  const d = q.run("trade", job("d")); // the third waiting: the queue is full now
  await assert.rejects(q.run("trade", job("e")), QueueFull);
  gates.get("a")!(); await a; await new Promise((r) => setTimeout(r, 5));
  assert.ok(order.includes("start c") && !order.includes("start d"), "c starts when a lane frees, d still waits (first in, first out)");
  gates.get("L1")!(); await l1; await new Promise((r) => setTimeout(r, 5));
  assert.ok(order.includes("start L2"));
  cap = { lanes: 5, launches: 3 };
  for (const k of ["b", "c", "L2"]) gates.get(k)!();
  await Promise.all([b, c, l2]); await new Promise((r) => setTimeout(r, 5));
  gates.get("d")!(); await d;
  assert.equal(q.stats().busy, 0);
  assert.equal(laneOf({ rogue: true }), "rogue");
  assert.equal(laneOf({ origin: "copy" }), "copy");
  assert.equal(laneOf({ origin: "snipe" }), "trade");
});

test("lanes: buys in flight count against the limits, and one coin can't be bought by two lanes at once", () => {
  const r = new Reservations();
  const a = r.reserve({ mint: "A", sol: 0.4, newPosition: true });
  const b = r.reserve({ mint: "B", sol: 0.4, newPosition: true });
  const seenByB = r.others(b);
  assert.equal(r.others(a).buys, 0, "the first one counts nobody: first come, first served");
  assert.deepEqual(seenByB, { sol: 0.4, buys: 1, positions: 1, mints: ["A"] });
  // spent 0.3 of 1 SOL today; A (0.4) in flight; B (0.4) would make 1.1
  const g = checkTrade({ action: "buy", wallet: ME, mint: "B", amountSol: 0.4, reason: "x" }, ctx({ spentTodaySol: 0.3, inFlight: seenByB }));
  assert.equal((g as { code: string }).code, "daily-cap");
  assert.equal((g as { reason: string }).reason, "Daily cap: 0.3 of 1 SOL spent today and 0.4 SOL in flight.");
  assert.equal(checkTrade({ action: "buy", wallet: ME, mint: "B", amountSol: 0.2, reason: "x" }, ctx({ spentTodaySol: 0.3, inFlight: seenByB })).ok, true);
  const dup = checkTrade({ action: "buy", wallet: ME, mint: "A", amountSol: 0.1, reason: "x" }, ctx({ inFlight: seenByB }));
  assert.equal((dup as { code: string }).code, "in-flight");
  assert.equal((checkTrade({ action: "buy", wallet: ME, mint: "C", amountSol: 0.1, reason: "x" }, ctx({ openPositions: 9, inFlight: seenByB })) as { code: string }).code, "max-positions");
  r.release(a);
  assert.equal(r.others(b).buys, 0, "a finished buy is in today's spend, not in flight");
  assert.equal(r.others().buys, 1);
});

test("lanes: two buys sent at the same time through one executor: both run in parallel lanes, the daily cap holds", async () => {
  const state = await new State(await mkdtemp(join(tmpdir(), "vesk-v20-"))).load();
  let bal = 0;
  const rpc = { getBalanceSol: async () => { bal++; await new Promise((r) => setTimeout(r, 30)); return 10; }, getTokenBalances: async () => [], call: async () => null } as unknown as ConstructorParameters<typeof Executor>[0]["rpc"];
  const wallet = { publicKey: { toBase58: () => ME } } as unknown as ConstructorParameters<typeof Executor>[0]["wallet"];
  const work = new WorkQueue(() => ({ lanes: 3, launches: 1 }));
  const ex = new Executor({ rpc, wallet, state, limits: () => ({ ...lim, dailySpendCapSol: 0.5 }), defaultPriorityFeeSol: 0.0001, paper: true, work, reserve: new Reservations() });
  const [x, y, z] = await Promise.all(["A", "B", "C"].map((m) => ex.buy({ action: "buy", wallet: ME, mint: `${m}Mint111111111111111111111111111111pump`, amountSol: 0.2, reason: "test" })));
  assert.equal(bal, 3, "all three were checked at the same time");
  assert.deepEqual([x.ok, y.ok, z.ok], [true, true, false], `0.2 + 0.2 fit under 0.5; the third doesn't (${[x.error, y.error, z.error].join(" | ")})`);
  // whether A and B had landed or were still in flight when C was checked, the sum is what counts
  assert.match(z.error!, /^Daily cap: 0(\.[24])? of 0\.5 SOL (already spent today|spent today and 0\.[24] SOL in flight)\.$/);
  assert.equal(state.spentToday(), 0.4);
});

test("live: lanes from the events; vesk live shows the lanes and what each is on", () => {
  const ev: PipelineEvent[] = [
    { at: T, id: "a", stage: "watch", outcome: "pass", source: "x", symbol: "GLINT" },
    { at: T + 100, id: "b", stage: "watch", outcome: "pass", source: "wallet", symbol: "OWL" },
    { at: T + 200, id: "c", stage: "watch", outcome: "pass", source: "launch", symbol: "DIAL" },
    { at: T + 300, id: "a", stage: "check", outcome: "start", lane: "trade" },
    { at: T + 400, id: "b", stage: "execute", outcome: "start", lane: "copy" },
  ];
  const v = liveView(ev, { now: T + 1000 });
  assert.deepEqual(v.active.map((c) => [c.symbol, c.lane]), [["GLINT", "trade"], ["OWL", "copy"], ["DIAL", "launch"]]);
  assert.equal(laneOfEvents([{ at: 0, id: "r", stage: "watch", outcome: "pass", reason: "Rogue: ticker $X matches" }]), "rogue");
  const out = renderLive(v, { status: "online", mode: "paper", pnlTodaySol: 0, positions: [], work: { lanes: 3, launches: 2, busy: 3, queued: 1, inFlight: { trade: 1, copy: 1, rogue: 0, launch: 1 } } }).join("\n");
  assert.match(out, /lanes 2\/3 busy · launches 1\/2 · 1 queued/);
  assert.match(out, /copy\s+\$OWL\s+execute…/);
});

// ---------------------------------------------------------------- settings, fields, the runner
test("settings: new defaults; presets keep your lanes and sell-into-buys; every new field resolves with where it applies", () => {
  const d = defaultStrategy();
  assert.deepEqual(d.concurrency, { lanes: 3, launches: 2 });
  assert.equal(d.exits.sellIntoBuys.enabled, false);
  assert.deepEqual(normalizeStrategy({ concurrency: { lanes: 9, launches: 0 } }).concurrency, { lanes: 5, launches: 1 });
  const mine = normalizeStrategy({ concurrency: { lanes: 5, launches: 1 }, exits: { sellIntoBuys: { enabled: true, minBuySol: 9 } } });
  const p = applyPreset(mine, "safe");
  assert.deepEqual(p.concurrency, { lanes: 5, launches: 1 });
  assert.equal(p.exits.sellIntoBuys.minBuySol, 9);
  assert.equal(p.rug.earlyConcentration.maxPct, 10);
  for (const k of ["rug.earlyConcentration.maxPct", "rug.spikeDump.minDumpPct", "exits.sellIntoBuys.tipSol", "concurrency.lanes"]) assert.ok(fieldOf(k), k);
  assert.match(appliesOf(fieldOf("honeypot.enabled")!), /pump\.fun bonding-curve coins can't be honeypotted/);
  assert.match(appliesOf(fieldOf("rug.lpLocked")!), /AMM pools/);
  assert.match(appliesOf(fieldOf("rug.mintRevoked")!), /every coin/);
  assert.ok(GROUPS.every((g) => g.applies.length > 20));
  const r = setField(d, "concurrency.lanes", "4", lim);
  assert.ok(r.ok && r.strategy.concurrency.lanes === 4 && !r.limits);
  assert.equal(setField(d, "concurrency.lanes", "7", lim).ok, false);
});

async function rig(s: StrategySettings) {
  const state = await new State(await mkdtemp(join(tmpdir(), "vesk-v20r-"))).load();
  state.data.status = "online";
  let now = T;
  const rpc = { getBalanceSol: async () => 3, getTokenBalances: async () => [], call: async () => null } as unknown as ConstructorParameters<typeof Executor>[0]["rpc"];
  const wallet = { publicKey: { toBase58: () => ME } } as unknown as ConstructorParameters<typeof Executor>[0]["wallet"];
  const feed = new PulseFeed({});
  const ex = new Executor({ rpc, wallet, state, limits: () => ({ ...lim, dailySpendCapSol: 5 }), defaultPriorityFeeSol: 0.0001, paper: true });
  const sells: Array<{ at: number; pct: number; trigger?: unknown; jitoOnly?: boolean; tip?: number }> = [];
  const orig = ex.sell.bind(ex);
  ex.sell = async (i, tp) => { sells.push({ at: now, pct: i.sellPct, trigger: i.trigger, jitoOnly: i.jitoOnly, tip: i.jitoTipSol }); return orig(i, tp); };
  const runner = new StrategyRunner({
    rpc, state, executor: () => ex, address: () => ME, settings: () => s, paused: () => false, feed, now: () => now, solUsd: async () => 150,
    tradeParams: async () => ({ slippageBps: 1500, priorityFeeSol: 0.0001, jitoOnly: false, mev: "off" }), endRogue: async () => undefined,
  });
  const push = (m: PulseMessage) => { const r = applyPulse(feed.state, m, now); runner.onMessage(m, !!r.isNew); };
  return { state, runner, push, sells, at: (t: number) => { now = t; }, settle: () => new Promise((r) => setTimeout(r, 120)) };
}

test("runner: a fake pump is refused by the rug check with its pattern; a normal coin is bought", async () => {
  const s = defaultStrategy();
  s.entry.autoNewCoins = true; s.entry.earlyVolume = { ...s.entry.earlyVolume, enabled: true, windowSec: 10, minVolSol: 3, minBuys: 2, minBuyers: 2, need: "all" };
  s.entry.minMcapUsd = null; s.entry.maxMcapUsd = null; s.entry.minLiquiditySol = null;
  s.rug.enrich = false; s.rug.minHolders.on = false; s.rug.maxSnipersPct.on = false;
  const g = await rig(s);
  try {
    g.runner.sync();
    const FAKE = "FakeMint11111111111111111111111111111111pump";
    g.push({ txType: "create", mint: FAKE, name: "Fake", symbol: "FAKE", traderPublicKey: "Dev1111111111111111111111111111111111111111", initialBuy: 10_000_000, solAmount: 0.3, vSolInBondingCurve: 31, marketCapSol: 60, pool: "pump" });
    await g.settle();
    g.at(T + 2000); g.push({ txType: "buy", mint: FAKE, traderPublicKey: "Pumper111111111111111111111111111111111111", solAmount: 2.5, tokenAmount: 280_000_000, vSolInBondingCurve: 34, marketCapSol: 80 });
    g.at(T + 3000); g.push({ txType: "buy", mint: FAKE, traderPublicKey: "fomo", solAmount: 1, tokenAmount: 10_000_000, vSolInBondingCurve: 35, marketCapSol: 90 });
    await g.runner.tick(); await g.settle();
    const refused = g.state.data.pipeline.find((e) => e.mint === FAKE && e.stage === "check" && e.outcome === "fail");
    assert.equal(refused?.reason, "one wallet (Pump…1111) bought 28% of supply in the first 2 s (max 15%)");
    assert.ok(!g.state.data.positions.some((p) => p.mint === FAKE));
  } finally { g.runner.stop(); }
});

test("runner: a whale's buy lands on a coin we hold → we sell part of ours after it, as a Jito bundle with the tip; small buys and our own don't", async () => {
  const s = defaultStrategy();
  s.exits.sellIntoBuys = { enabled: true, minBuySol: 5, sellPct: 40, tipSol: 0.004, maxTipSol: 0.02, cooldownSec: 30 };
  const g = await rig(s);
  const HELD = "HeldMint11111111111111111111111111111111pump";
  g.state.recordBuy({ mint: HELD, symbol: "HELD", wallet: ME, sol: 0.1, tokens: 1_000_000 });
  try {
    g.runner.sync();
    g.at(T + 1000); g.push({ txType: "buy", mint: HELD, traderPublicKey: "small", solAmount: 1, tokenAmount: 1_000_000, signature: "s1" });
    g.at(T + 2000); g.push({ txType: "buy", mint: HELD, traderPublicKey: ME, solAmount: 9, tokenAmount: 9_000_000, signature: "s2" });
    await g.settle();
    assert.equal(g.sells.length, 0, "nothing for a small buy or our own");
    g.at(T + 3000); g.push({ txType: "buy", mint: HELD, traderPublicKey: WHALE, solAmount: 7, tokenAmount: 7_000_000, signature: "sigWhale" });
    await g.settle();
    assert.equal(g.sells.length, 1);
    assert.deepEqual(g.sells[0], { at: T + 3000, pct: 40, trigger: { kind: "big-buy", signature: "sigWhale", wallet: WHALE, sol: 7, at: T + 3000 }, jitoOnly: true, tip: 0.004 });
    const steps = g.state.data.pipeline.filter((e) => e.mint === HELD).map((e) => `${e.stage}:${e.outcome}:${e.reason ?? ""}`);
    assert.ok(steps.includes("watch:pass:a 7 SOL buy landed on $HELD"));
    assert.ok(steps.some((x) => /^exit:done:sold into a 7 SOL buy by WhaL…1111 · tip 0.004 SOL$/.test(x)), steps.join("\n"));
    // a second big buy inside the cooldown doesn't sell again
    g.at(T + 10_000); g.push({ txType: "buy", mint: HELD, traderPublicKey: WHALE, solAmount: 12, tokenAmount: 9_000_000, signature: "sigWhale2" });
    await g.settle();
    assert.equal(g.sells.length, 1);
  } finally { g.runner.stop(); }
});

test("v20 notification look: defaults, clamps, accents, the new places and styles", async () => {
  const { defaultPanelSettings, normalizePanelSettings, normalizeToastLook, defaultToastLook } = await import("../src/ui/panelSettings.js");
  const d = defaultPanelSettings().feel;
  assert.deepEqual(d.toastLook, { size: "m", bg: "solid", accents: {}, motion: "slide", speed: "normal", duration: 1, maxVisible: 3, progress: true, avatars: true });
  for (const p of ["top", "top-right", "bottom-right", "bottom-left"]) assert.equal(normalizePanelSettings({ feel: { toasts: p } }).feel.toasts, p);
  for (const s of ["list", "stacked", "compact", "minimal"]) assert.equal(normalizePanelSettings({ feel: { toastStack: s } }).feel.toastStack, s);
  const L = normalizeToastLook({ size: "xl", bg: "tinted", accents: { trade: "#FFAA00", copy: "red", nope: "#000000" }, motion: "scale", speed: "fast", duration: 9, maxVisible: 0.2, progress: false, avatars: "x" });
  assert.deepEqual(L, { ...defaultToastLook(), bg: "tinted", accents: { trade: "#ffaa00" }, motion: "scale", speed: "fast", duration: 3, maxVisible: 1, progress: false });
  assert.equal(normalizeToastLook({ duration: 0.1, maxVisible: 99 }).duration, 0.5);
  assert.equal(normalizeToastLook({ maxVisible: 99 }).maxVisible, 6);
  assert.deepEqual(normalizeToastLook(null), defaultToastLook());
});

test("v20 realized calendar: wins and losses per day, a day's trades, the colour step", async () => {
  const { dailyRealized, closedOnDay, calendarStep } = await import("../src/portfolio/stats.js");
  const now = Date.parse("2026-10-20T12:00:00Z"), H = 3_600_000;
  const C = (sym: string, pnl: number, at: number) => ({ mint: sym, symbol: sym, investedSol: 1, returnedSol: 1 + pnl, pnlSol: pnl, pnlPct: pnl * 100, openedAt: at - H, closedAt: at, origin: { kind: "manual" as const, label: "Manual" } });
  const closed = [C("A", 0.5, now - 2 * H), C("B", -0.2, now - 3 * H), C("C", 0, now - 4 * H), C("D", 0.1, now - 30 * H)];
  const d = dailyRealized(closed, now, 3);
  assert.deepEqual(d.map((x) => x.day), ["2026-10-18", "2026-10-19", "2026-10-20"]);
  assert.deepEqual(d[2], { day: "2026-10-20", sol: 0.3, n: 3, w: 1, l: 1 });
  assert.deepEqual(d[1], { day: "2026-10-19", sol: 0.1, n: 1, w: 1, l: 0 });
  assert.deepEqual(d[0], { day: "2026-10-18", sol: 0, n: 0, w: 0, l: 0 });
  assert.deepEqual(closedOnDay(closed, "2026-10-20").map((c) => c.symbol), ["A", "B", "C"]);
  assert.equal(calendarStep(0, 1), 0);
  assert.equal(calendarStep(1, 1), 4);
  assert.equal(calendarStep(-1, 1), 4);
  assert.equal(calendarStep(0.01, 1), 1);
  assert.equal(calendarStep(0.3, 1), 3);
  assert.equal(calendarStep(0.5, 0), 0);
});
