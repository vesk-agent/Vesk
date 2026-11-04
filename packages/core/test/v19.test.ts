import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockedStages, eventsFromActivity, liveView, missing, normalizeEvent, pushEvent, readiness, reasonClass, renderLive, STAGES,
  type PipelineEvent, type ReadyInput,
} from "../src/ui/pipeline.js";
import { State } from "../src/state.js";
import { Executor } from "../src/trade/executor.js";
import type { Limits } from "../src/types.js";

const MINT = "Borqy3dEjw9az7Uj9nW69A9ZDansFGHWEggUx7tkpump";
const ME = "7Gk2PqWm4zXc8Vb1nRt5Hy3JdLs6Ef9Ua2Ko8Ni9fQa";
const T = 1_800_000_000_000;
const ev = (o: Partial<PipelineEvent> & Pick<PipelineEvent, "id" | "stage" | "outcome">, dt = 0): PipelineEvent => ({ at: T + dt, ...o });

test("pipeline: six stages in order, each with a one-line role", () => {
  assert.deepEqual(STAGES, ["watch", "check", "size", "execute", "exit", "log"]);
});

test("liveView: a candidate filtered at Check lands in the filtered lane with its reason, and counts once", () => {
  const e = [
    ev({ id: "a", stage: "watch", outcome: "pass", symbol: "GLINT", source: "pulse" }, 0),
    ev({ id: "a", stage: "check", outcome: "fail", symbol: "GLINT", reason: "mcap $81K is above $50K" }, 40),
    ev({ id: "b", stage: "watch", outcome: "pass", symbol: "DIAL", source: "x" }, 100),
    ev({ id: "b", stage: "check", outcome: "fail", reason: "mcap $95K is above $50K" }, 150),
    ev({ id: "c", stage: "watch", outcome: "pass", symbol: "OWL" }, 200),
    ev({ id: "c", stage: "check", outcome: "fail", reason: "Kill switch is on. Buying is stopped." }, 230),
  ];
  const v = liveView(e, { now: T + 300 });
  assert.equal(v.counters.watched, 3);
  assert.equal(v.counters.checked, 3);
  assert.equal(v.counters.filtered, 3);
  assert.equal(v.counters.topReason?.n, 2, "the two mcap refusals are one reason class");
  assert.match(v.counters.topReason!.reason, /mcap/);
  assert.equal(v.filtered.length, 3);
  assert.equal(v.filtered[0].symbol, "OWL", "newest first");
  assert.equal(v.nodes.find((n) => n.stage === "check")!.state, "fail");
  assert.equal(v.decisions[0].action, "filtered");
  assert.equal(v.decisions[0].reason, "Kill switch is on. Buying is stopped.");
});

test("liveView: a guardrail refusal after sizing still ends the candidate at Check", () => {
  const e = [
    ev({ id: "a", stage: "watch", outcome: "pass", symbol: "OWL", source: "wallet" }, 0),
    ev({ id: "a", stage: "size", outcome: "pass", amountSol: 0.05 }, 10),
    ev({ id: "a", stage: "check", outcome: "fail", reason: "Another of your wallets bought this coin recently. Vesk buys from one wallet per coin." }, 20),
  ];
  const v = liveView(e, { now: T + 30 });
  assert.equal(v.current?.stage, "check");
  assert.equal(v.current?.outcome, "fail");
  assert.equal(v.filtered.length, 1);
});

test("liveView: the Log line written after a decision marks the candidate done, it doesn't hide it", () => {
  const e = [
    ev({ id: "a", stage: "watch", outcome: "pass", symbol: "NOIR" }, 0),
    ev({ id: "a", stage: "check", outcome: "fail", reason: "dev holds 12.4% (max 5%)" }, 40),
    ev({ id: "a", stage: "log", outcome: "done", reason: "line #219" }, 45),
    ev({ id: "b", stage: "watch", outcome: "pass", symbol: "KITE" }, 100),
  ];
  const v = liveView(e, { now: T + 120 });
  assert.equal(v.filtered.length, 1, "still in the filtered lane after its log line");
  assert.equal(v.filtered[0].stage, "check");
  assert.equal(v.filtered[0].done, true);
  assert.equal(v.current?.symbol, "KITE");
  assert.equal(v.current?.done, undefined);
  assert.equal(v.recent.length, 2);
});

test("liveView: an executed candidate reports landing time; Execute is 'working' only while it's fresh", () => {
  const e = [
    ev({ id: "x", stage: "watch", outcome: "pass", symbol: "GLINT" }, 0),
    ev({ id: "x", stage: "check", outcome: "pass" }, 30),
    ev({ id: "x", stage: "size", outcome: "pass", preset: "p1", amountSol: 0.25 }, 35),
    ev({ id: "x", stage: "execute", outcome: "start" }, 40),
  ];
  assert.equal(liveView(e, { now: T + 500 }).nodes.find((n) => n.stage === "execute")!.state, "working");
  assert.equal(liveView(e, { now: T + 5000 }).nodes.find((n) => n.stage === "execute")!.state, "idle", "a start that never finished doesn't spin forever");
  const done = [...e, ev({ id: "x", stage: "execute", outcome: "done", ms: 212, amountSol: 0.25, reason: "dev 3% · P1" }, 252)];
  const v = liveView(done, { now: T + 300 });
  assert.equal(v.counters.executed, 1);
  assert.equal(v.counters.avgLandingMs, 212);
  assert.deepEqual(v.counters.sized, { preset: "p1", amountSol: 0.25 });
  assert.match(v.nodes.find((n) => n.stage === "execute")!.last!, /landed in 212 ms · \$GLINT/);
  assert.equal(v.current?.id, "x");
  assert.equal(v.current?.stage, "execute");
  assert.equal(v.decisions[0].action, "enter");
  assert.equal(v.decisions[0].result, "212 ms");
});

test("liveView: blocked stages show why, and the order of events doesn't matter", () => {
  const e = [ev({ id: "a", stage: "check", outcome: "fail", reason: "r" }, 50), ev({ id: "a", stage: "watch", outcome: "pass" }, 0)];
  const v = liveView(e, { now: T + 100, blocked: { execute: "needs RPC" } });
  assert.equal(v.nodes.find((n) => n.stage === "execute")!.state, "blocked");
  assert.equal(v.nodes.find((n) => n.stage === "execute")!.blocked, "needs RPC");
  assert.equal(v.filtered.length, 1);
});

test("reasonClass: numbers and amounts don't split a reason", () => {
  assert.equal(reasonClass("dev holds 12.4% (max 5%)"), reasonClass("dev holds 9.1% (max 5%)"));
  assert.notEqual(reasonClass("dev holds 12.4% (max 5%)"), reasonClass("top 10 hold 61%"));
});

test("eventsFromActivity: activity rows read as candidates (signal + skip = one filtered candidate)", () => {
  const rows = [
    { at: T, kind: "signal" as const, message: "New launch HUSH passed filters", mint: MINT },
    { at: T + 50, kind: "skip" as const, message: "HUSH: rule hit its 4 buys for today", mint: MINT },
    { at: T + 900, kind: "buy" as const, message: "Bought 0.25 SOL of GLINT via pumpfun in 212 ms", mint: "Mint2", solDelta: -0.25, latencyMs: 212 },
    { at: T + 2000, kind: "tp" as const, message: "GLINT: take-profit 2x hit, selling 50%", mint: "Mint2" },
  ];
  const e = eventsFromActivity(rows);
  const v = liveView(e, { now: T + 3000 });
  assert.equal(v.filtered.length, 1);
  assert.equal(v.filtered[0].reason, "HUSH: rule hit its 4 buys for today");
  assert.equal(v.counters.executed, 1);
  assert.equal(v.counters.avgLandingMs, 212);
  assert.deepEqual(v.decisions.map((d) => d.action), ["exit", "enter", "skipped"]);
});

test("normalizeEvent: drops junk, trims strings, keeps known fields only", () => {
  assert.equal(normalizeEvent({ at: 1, id: "a", stage: "nope", outcome: "pass" }), null);
  assert.equal(normalizeEvent({ id: "a", stage: "watch", outcome: "pass" }), null, "needs a time");
  const n = normalizeEvent({ at: 5, id: "a", stage: "check", outcome: "fail", reason: "x".repeat(500), evil: "<script>", action: "rug" })!;
  assert.equal(n.reason!.length, 240);
  assert.equal(n.action, undefined);
  assert.equal((n as unknown as Record<string, unknown>).evil, undefined);
  const list: PipelineEvent[] = [];
  for (let i = 0; i < 400; i++) pushEvent(list, ev({ id: String(i), stage: "watch", outcome: "pass" }, i));
  assert.equal(list.length, 300, "the ring buffer keeps the newest 300");
  assert.equal(list[0].id, "100");
});

const ready = (o: Partial<ReadyInput> = {}): ReadyInput => ({
  wallet: { address: ME, balanceSol: 2 }, rpc: { url: "https://rpc.example", kind: "helius", p50: 38 }, model: { provider: "anthropic", keySet: true },
  x: { source: "relay" }, agent: { mode: "self", state: "online" }, telegram: { linked: false }, access: { enabled: true, ok: true }, ...o,
});
test("readiness: all connected; Telegram is optional and never counts as missing", () => {
  const r = readiness(ready());
  assert.equal(r.length, 7);
  assert.equal(missing(r).length, 0);
  assert.equal(r.find((x) => x.key === "telegram")!.state, "optional");
  assert.match(r.find((x) => x.key === "rpc")!.detail, /helius · 38 ms/);
  assert.deepEqual(blockedStages(r), {});
});

test("readiness: missing pieces say what's missing, link to the fix, and block the right stages", () => {
  const r = readiness(ready({ rpc: { url: null }, model: { provider: "anthropic", keySet: false } }));
  const m = missing(r);
  assert.deepEqual(m.map((x) => x.key), ["rpc", "model"]);
  assert.equal(m[0].href, "/app/connections#rpc");
  const b = blockedStages(r);
  assert.equal(b.execute, "needs RPC");
  assert.equal(b.check, "needs RPC");
  assert.equal(b.watch, undefined);
  const off = readiness(ready({ agent: { mode: "self", state: "stopped" } }));
  assert.equal(off.find((x) => x.key === "agent")!.state, "error");
  assert.equal(blockedStages(off).watch, "agent offline", "an offline agent blocks every stage");
  assert.equal(readiness(ready({ wallet: { address: ME, balanceSol: 0 } })).find((x) => x.key === "wallet")!.state, "error");
  assert.equal(readiness(ready({ x: { source: "official-api", keySaved: false } })).find((x) => x.key === "x")!.state, "setup");
});

test("renderLive: the terminal view has the stages, the decisions and nothing undefined", () => {
  const v = liveView([ev({ id: "x", stage: "watch", outcome: "pass", symbol: "GLINT" }), ev({ id: "x", stage: "check", outcome: "fail", reason: "top 10 hold 61%", symbol: "GLINT" }, 20)], { now: T + 100 });
  const s = renderLive(v, { status: "online", mode: "paper", pnlTodaySol: 0.4, positions: [{ symbol: "OWL", costSol: 0.25, pnlPct: 12.5, reason: "dev 3%", exits: "TP 2x" }] }).join("\n");
  for (const w of ["Watch", "Check", "Size", "Execute", "Exit", "Log", "FILTERED", "$GLINT", "top 10 hold 61%", "$OWL", "+12.5%", "paper"]) assert.ok(s.includes(w), w);
  assert.ok(!/undefined|NaN/.test(s));
});

test("agent: State.stage keeps events, adds a Log line for terminal steps; the executor reports Check and Execute", async () => {
  const s = await new State(await mkdtemp(join(tmpdir(), "vesk-v19-"))).load();
  assert.equal(s.data.pipeline.length, 0);
  const seen: PipelineEvent[] = [];
  s.onStage((e) => seen.push(e));
  const limits: Limits = { perTradeMaxSol: 1, dailySpendCapSol: 5, maxOpenPositions: 5, maxBuysPerDay: 10, minSolReserve: 0.01, killSwitch: false };
  let lim = limits;
  const rpc = { getBalanceSol: async () => 3, getTokenBalances: async () => [] } as unknown as ConstructorParameters<typeof Executor>[0]["rpc"];
  const wallet = { publicKey: { toBase58: () => ME } } as unknown as ConstructorParameters<typeof Executor>[0]["wallet"];
  const ex = new Executor({ rpc, wallet, state: s, limits: () => lim, defaultPriorityFeeSol: 0.0001, paper: true });
  const ok = await ex.buy({ action: "buy", wallet: ME, mint: MINT, amountSol: 0.25, reason: "dev 3% · P1", trace: { id: "t1", symbol: "GLINT", source: "pulse" } }, "GLINT");
  assert.equal(ok.ok, true);
  const t1 = s.data.pipeline.filter((e) => e.id === "t1").map((e) => `${e.stage}:${e.outcome}`);
  assert.deepEqual(t1, ["check:pass", "execute:start", "execute:done", "log:done"]);
  const done = s.data.pipeline.find((e) => e.id === "t1" && e.stage === "execute" && e.outcome === "done")!;
  assert.equal(done.paper, true);
  assert.equal(done.action, "enter");
  lim = { ...limits, killSwitch: true };
  const no = await ex.buy({ action: "buy", wallet: ME, mint: "So11111111111111111111111111111111111111112", amountSol: 0.25, reason: "x", trace: { id: "t2" } });
  assert.equal(no.ok, false);
  const f = s.data.pipeline.find((e) => e.id === "t2" && e.stage === "check")!;
  assert.equal(f.outcome, "fail");
  assert.equal(f.reason, "Kill switch is on. Buying is stopped.", "the guardrail's own words");
  assert.equal(f.action, "filtered");
  assert.equal(seen.length, s.data.pipeline.length, "listeners see every event (the report path and vesk live)");
  // an untraced buy (an order, a panel trade) adds no pipeline noise
  const n = s.data.pipeline.length;
  lim = limits;
  await ex.buy({ action: "buy", wallet: ME, mint: "Mint3333333333333333333333333333333333333333", amountSol: 0.1, reason: "manual" });
  assert.equal(s.data.pipeline.length, n);
});
