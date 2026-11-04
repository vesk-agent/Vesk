import { test } from "node:test";
import assert from "node:assert/strict";
import { activeHandles, defaultLaunchRule, describeLaunchRule, matchLaunchPost, setHandleOn, validateLaunchRule } from "../src/launch/onpost.js";
import { exportBook, importBook, mergeBook, withdrawTargets, type BookEntry } from "../src/wallet/book.js";
import { classifyHolders } from "../src/coin/holders.js";
import { planRentRecovery, CLOSE_PER_TX } from "../src/wallet/rent.js";
import { treasuryReport } from "../src/coin/treasury.js";
import { checkTrade } from "../src/guardrails.js";
import { RelayWatcher } from "../src/watch/relay.js";
import { DEFAULT_LIMITS, type XPost } from "../src/types.js";
import { MINT_A, MINT_B, MINT_C, WALLET_1, WALLET_2 } from "./fixtures.js";

const post = (handle: string, id = "1"): XPost => ({ id, handle, text: "harbour lights", urls: [], createdAt: new Date().toISOString(), media: [{ type: "photo", url: "https://x/img.jpg" }] });

test("per-account toggles: switched-off accounts stay listed but never match", () => {
  const r = defaultLaunchRule({ enabled: true, trigger: { handles: ["harbourdesk", "lumen_wire"], requireImage: true } });
  const off = setHandleOn(r, "Lumen_Wire", false);
  assert.deepEqual(activeHandles(off), ["harbourdesk"]);
  assert.deepEqual(off.trigger.handles, ["harbourdesk", "lumen_wire"]);
  assert.equal(matchLaunchPost(off, post("lumen_wire")).ok, false);
  assert.match((matchLaunchPost(off, post("lumen_wire")) as { reason: string }).reason, /switched off/);
  assert.equal(matchLaunchPost(off, post("harbourdesk")).ok, true);
  assert.match(describeLaunchRule(off)[0], /switched off: @lumen_wire/);
  const back = setHandleOn(off, "lumen_wire", true);
  assert.deepEqual(activeHandles(back), ["harbourdesk", "lumen_wire"]);
  const none = setHandleOn(off, "harbourdesk", false);
  assert.ok(validateLaunchRule(none).some((e) => /Every account is switched off/.test(e.message)));
  assert.equal(validateLaunchRule({ ...none, enabled: false }).some((e) => /switched off/.test(e.message)), false);
});

test("single account watched 24/7 works the same way", () => {
  const r = defaultLaunchRule({ enabled: true, trigger: { handles: ["harbourdesk"], requireImage: false } });
  assert.deepEqual(activeHandles(r), ["harbourdesk"]);
  assert.equal(matchLaunchPost(r, post("harbourdesk")).ok, true);
});

test("address book: CSV and JSON round-trip, bad rows reported, bookmarks first", () => {
  const book: BookEntry[] = [
    { address: WALLET_1, label: "Cold, \"main\"", marker: "ice", bookmark: false },
    { address: MINT_C, label: "Exchange", marker: "none", bookmark: true, note: "deposit" },
  ];
  const csv = exportBook(book, "csv");
  const back = importBook(csv);
  assert.deepEqual(back.errors, []);
  assert.equal(back.entries[0].label, "Cold, \"main\"");
  assert.equal(importBook(exportBook(book, "json")).entries.length, 2);
  const bad = importBook("address,label\nnot-an-address,x\n" + WALLET_1 + ",dup\n" + WALLET_1 + ",dup2");
  assert.equal(bad.entries.length, 1);
  assert.equal(bad.errors.length, 2);
  assert.equal(withdrawTargets(book)[0].label, "Exchange");
  assert.equal(mergeBook(book, [{ address: WALLET_1, label: "Renamed", marker: "red", bookmark: true }]).find((e) => e.address === WALLET_1)?.label, "Renamed");
});

test("holders: dev, disclosed team, pool and others, top 10 without pools", () => {
  const rows = [
    { owner: "pool", tokens: 700_000_000 }, { owner: WALLET_1, tokens: 50_000_000 }, { owner: WALLET_2, tokens: 20_000_000 },
    ...Array.from({ length: 12 }, (_, i) => ({ owner: `o${i}`, tokens: 10_000_000 - i })),
  ];
  const h = classifyHolders(rows, { supply: 1_000_000_000, dev: WALLET_1, team: [WALLET_2], pools: ["pool"] });
  assert.equal(h.top.length, 10);
  assert.equal(h.top[0].kind, "pool");
  assert.equal(h.byKind.dev.pct, 5);
  assert.equal(h.byKind.team.count, 1);
  assert.ok(h.top10Pct > 7 && h.top10Pct < 16);
});

test("recover rent: only empty accounts, in batches, kept mints excluded", () => {
  const accts = Array.from({ length: 45 }, (_, i) => ({ account: `a${i}`, mint: i === 0 ? MINT_A : `m${i}`, program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 2_039_280 }));
  const p = planRentRecovery(accts, { keepMints: [MINT_A] });
  assert.equal(p.accounts.length, 44);
  assert.equal(p.batches.length, Math.ceil(44 / CLOSE_PER_TX));
  assert.equal(p.totalSol, +(44 * 0.00203928).toFixed(6));
});

test("treasury report: every entry with its transaction", () => {
  const r = treasuryReport([
    { at: 1, kind: "team", mint: MINT_B, sol: 0.2, wallets: [WALLET_2], signature: "s1" },
    { at: 2, kind: "dev-sell", mint: MINT_B, sol: 0.41, tokens: 6_000_000, signature: "s2" },
    { at: 3, kind: "claim", mint: MINT_A, sol: 0.05, signature: "s3" },
  ], { [MINT_B]: "FERRY" }, MINT_B);
  assert.equal(r.length, 1);
  assert.equal(r[0].symbol, "FERRY");
  assert.match(r[0].lines[0], /Team wallets bought 0\.2000 SOL .*disclosed/);
  assert.match(r[0].lines[1], /Dev wallet sold 6M tokens for 0\.4100 SOL\. Tx: https:\/\/solscan\.io\/tx\/s2/);
  assert.equal(r[0].totals.devSoldSol, 0.41);
});

test("send tokens: launched dev supply can't be moved into your other wallets", () => {
  const base = { limits: { ...DEFAULT_LIMITS }, ownWallets: [WALLET_1], spentTodaySol: 0, buysToday: 0, openPositions: 0, recentFills: [] };
  const i = { action: "send-tokens" as const, wallet: WALLET_1, mint: MINT_A, to: WALLET_2, tokens: 10, reason: "send" };
  assert.equal(checkTrade(i, { ...base, allOwnWallets: [WALLET_1, WALLET_2], launchedMints: [MINT_A] }).ok, false);
  assert.equal(checkTrade(i, { ...base, allOwnWallets: [WALLET_1, WALLET_2], launchedMints: [] }).ok, true);
  assert.equal(checkTrade({ ...i, to: MINT_C }, { ...base, allOwnWallets: [WALLET_1, WALLET_2], launchedMints: [MINT_A] }).ok, true);
  assert.equal(checkTrade({ ...i, to: WALLET_1 }, base).ok, false);
});

test("relay watcher: joins the private channel, filters to watched accounts, reports what isn't carried", async () => {
  const sent: string[] = [];
  const sock = { readyState: 1, send: (d: string) => void sent.push(d), close() {}, onopen: null as null | ((e: unknown) => void), onmessage: null as null | ((e: { data: unknown }) => void), onclose: null as null | ((e: unknown) => void), onerror: null as null | ((e: unknown) => void) };
  const calls: string[] = [];
  const w = new RelayWatcher(async <T,>(action: string, body: Record<string, unknown>) => {
    calls.push(action);
    if (action === "relay-subscribe") return { carried: (body.handles as string[]).filter((h) => h !== "big"), notCarried: [{ handle: "big", reason: "relay is full" }], perUserMax: 25 } as T;
    return { token: "jwt", wsUrl: "wss://p.supabase.co/realtime/v1/websocket", apikey: "anon", expiresAt: Date.now() + 3_600_000, carried: [] } as T;
  }, (url) => {
    assert.match(url, /apikey=anon&vsn=1\.0\.0$/);
    return sock;
  });
  await w.setHandles(["@Harbourdesk", "big"]);
  assert.equal(w.lastSubscribe?.notCarried[0].handle, "big");
  const got: XPost[] = [];
  await w.start((p) => got.push(p));
  sock.onopen?.({});
  const join = JSON.parse(sent[0]);
  assert.equal(join.event, "phx_join");
  assert.equal(join.topic, "realtime:relay");
  assert.equal(join.payload.config.private, true);
  assert.equal(join.payload.access_token, "jwt");
  const msg = (h: string) => ({ data: JSON.stringify({ topic: "realtime:relay", event: "broadcast", ref: null, payload: { event: "post", payload: { id: "9", handle: h, text: "t" } } }) });
  sock.onmessage?.(msg("harbourdesk"));
  sock.onmessage?.(msg("stranger"));
  assert.equal(got.length, 1);
  assert.equal(got[0].handle, "harbourdesk");
  await w.stop();
  assert.deepEqual(calls, ["relay-subscribe", "relay-token"]);
});

test("relay plan: per-user cap, dedupe across users, capacity, packed rules", async () => {
  const { planRelaySubscription, packStreamRules, relayCapacity } = await import("../src/watch/relayPlan.js");
  const r = planRelaySubscription({ requested: ["@Curated1", "shared", "new1", "new2", "new3", "bad handle!"], curated: ["curated1"], everyone: ["curated1", "shared"], mine: ["old"], perUser: 3, capacity: 4 });
  assert.deepEqual(r.carried, ["curated1", "shared", "new1", "new2"]);
  assert.deepEqual(r.notCarried.map((n) => n.reason), ["over your 3-account relay limit", "not a valid X handle"]);
  assert.deepEqual(r.remove, ["old"]);
  const full = planRelaySubscription({ requested: ["x1", "x2"], curated: [], everyone: ["a", "b", "c"], mine: [], capacity: 4 });
  assert.deepEqual(full.carried, ["x1"]);
  assert.equal(full.notCarried[0].reason, "the relay is full");
  const rules = packStreamRules(Array.from({ length: 120 }, (_, i) => `account_${i}`), 512);
  assert.ok(rules.length > 1 && rules.every((x) => x.length <= 512 && x.endsWith(") -is:retweet")));
  assert.equal(rules.join(" ").match(/from:/g)?.length, 120);
  assert.ok(relayCapacity({ rules: 1000, ruleLength: 1024 }) > 30_000);
});
