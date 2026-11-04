/**
 * v12.2: your wallets' names (one registry, defaults, the "Team" role isn't a name, the migration, rename, refs),
 * the treasury report keeping names local, and the Instant Trade panel's settings and floating-position maths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultWalletLabels, isLegacyRoleLabel, migrateOwnLabels, ownWalletLabels, resolveWalletRef, setOwnLabel, withOwnLabels, withRole } from "../src/wallet/naming.js";
import { exportBook, importBook, type BookEntry } from "../src/wallet/book.js";
import { treasuryReport } from "../src/coin/treasury.js";
import { defaultInstantTrade, normalizeInstantTrade, placeAt, settle, spotFor, toSpot, validateInstantTrade, withSpot, IT_MAX_COINS } from "../src/ui/instantTrade.js";
import { normalizePanelSettings } from "../src/ui/panelSettings.js";

const M = "MainWa11et1111111111111111111111111111111";
const A = "AWa11et11111111111111111111111111111111111";
const B = "BWa11et11111111111111111111111111111111111";
const C = "CWa11et11111111111111111111111111111111111";
const ws = [{ address: M, main: true, label: "Main" }, { address: A, main: false, label: "Team A" }, { address: B, main: false, label: "Team 2 (disclosed)" }, { address: C, main: false, label: "Sniper desk" }];

test("default names: Main, then Wallet 1, Wallet 2, … in registry order", () => {
  assert.deepEqual([...defaultWalletLabels(ws).values()], ["Main", "Wallet 1", "Wallet 2", "Wallet 3"]);
});

test("Team is a role, not a name: legacy names fall back to the default; custom stored names survive", () => {
  for (const s of ["Team", "Team A", "team b", "Team 1", "Team 12", "Team A (disclosed)"]) assert.ok(isLegacyRoleLabel(s), s);
  for (const s of ["Teamwork fund", "Team desk", "My team wallet"]) assert.ok(!isLegacyRoleLabel(s), s);
  const m = ownWalletLabels(ws);
  assert.deepEqual([...m.values()].map((x) => `${x.label}:${x.source}`), ["Main:default", "Wallet 1:default", "Wallet 2:default", "Sniper desk:stored"]);
});

test("the address book wins; the migration moves custom names into it and leaves roles behind", () => {
  const book: BookEntry[] = [{ address: A, label: "Fast hands", marker: "none", bookmark: false, own: true }];
  assert.equal(ownWalletLabels(ws, book).get(A)!.label, "Fast hands");
  const add = migrateOwnLabels(ws, book);
  assert.deepEqual(add.map((e) => [e.address, e.label, e.own]), [[C, "Sniper desk", true]]);
  assert.deepEqual(withOwnLabels(ws, [...book, ...add]).map((w) => w.label), ["Main", "Fast hands", "Wallet 2", "Sniper desk"]);
});

test("rename: sets the name everywhere; empty or the default name goes back to the default", () => {
  let book = setOwnLabel([], ws, B, "  Desk two ");
  assert.equal(withOwnLabels(ws, book).find((w) => w.address === B)!.label, "Desk two");
  book = setOwnLabel(book, ws, B, "");
  assert.equal(book.length, 0, "a name-only entry is dropped");
  const kept = setOwnLabel([{ address: B, label: "X", marker: "violet", bookmark: false, own: true }], ws, B, "Wallet 2");
  assert.equal(kept[0].label, "Wallet 2", "an entry with a colour tag is kept, with the default name");
  assert.throws(() => setOwnLabel([], ws, "NotMine1111111111111111111111111111111111", "x"), /isn't one of your wallets/);
  assert.throws(() => setOwnLabel([], ws, A, "x".repeat(41)), /40 characters/);
});

test("wallet refs for the CLI: address, number from \"Wallet n\", main / 0", () => {
  assert.equal(resolveWalletRef(ws, "2"), B);
  assert.equal(resolveWalletRef(ws, "main"), M);
  assert.equal(resolveWalletRef(ws, "0"), M);
  assert.equal(resolveWalletRef(ws, C), C);
  assert.equal(resolveWalletRef(ws, "9"), null);
  assert.equal(withRole("Wallet 2", "team"), "Wallet 2 · Team");
});

test("own flag survives export / import (JSON and CSV)", () => {
  const book: BookEntry[] = [{ address: "7Gk2xUqUmvFc3T1rB8e2Lq4y5n6Zp9wHs3K1cVd9fQa", label: "Desk two", marker: "none", bookmark: false, own: true }];
  for (const f of ["json", "csv"] as const) assert.equal(importBook(exportBook(book, f)).entries[0].own, true, f);
});

test("treasury reports carry addresses; names only when asked (local display)", () => {
  const recs = [{ at: 1, kind: "team" as const, mint: "Mint11111111111111111111111111111111111111", sol: 0.5, wallets: [A, B] }];
  const pub = treasuryReport(recs, {}, undefined)[0].lines.join(" ");
  assert.ok(pub.includes(A) && !pub.includes("Wallet") && !pub.includes("Desk"));
  const local = treasuryReport(recs, {}, undefined, new Map([[A, "Wallet 1"]]))[0].lines.join(" ");
  assert.ok(local.includes(`${A} (Wallet 1 · Team)`));
});

test("Instant Trade settings: defaults, normalizing bad saves, validation", () => {
  const d = defaultInstantTrade();
  assert.deepEqual(d.buyRows, [[0.1, 0.25, 0.5, 1]]);
  assert.deepEqual(d.sellRows, [[10, 25, 50, 100]]);
  const n = normalizeInstantTrade({ buyRows: [[0.1, -1, "x", 2, 3, 4, 5, 6], [9], [7]], sellRows: [[0, 150]], preset: "p9", confirmAboveSol: 5000, size: "huge", posByMint: { bad: { x: 0.5, y: 0.5 } }, pos: { x: 2, y: 0 } });
  assert.deepEqual(n.buyRows, [[0.1, 2, 3, 4, 5], [9]], "≤ 2 rows, ≤ 5 chips, bad values dropped");
  assert.deepEqual(n.sellRows, d.sellRows, "nothing valid → defaults");
  assert.equal(n.preset, "active"); assert.equal(n.confirmAboveSol, null); assert.equal(n.size, "normal"); assert.deepEqual(n.posByMint, {}); assert.equal(n.pos, null);
  assert.deepEqual(validateInstantTrade({ buyRows: [[0.1], [1, 2, 3, 4, 5, 6]], sellRows: [[101]], confirmAboveSol: null }), ["Each buy row has 1 to 5 chips.", "Sell chips are 1 to 100 %."]);
  assert.deepEqual(validateInstantTrade({ buyRows: [[0.1, 0.5], [2, 3]], sellRows: [[15, 33, 75], [25, 50, 100]], confirmAboveSol: 2 }), []);
  assert.deepEqual(normalizePanelSettings({}).instantTrade, d, "panel settings carry it");
});

test("floating panel: docked bottom right, stays inside, snaps to edges, spots survive a resize", () => {
  const panel = { w: 360, h: 400 }, view = { w: 1440, h: 870 };
  assert.deepEqual(placeAt(null, panel, view), { left: 1440 - 360 - 12, top: 870 - 400 - 12 });
  assert.deepEqual(settle(-200, 5000, panel, view), { left: 12, top: 870 - 400 - 12 }, "kept inside");
  assert.deepEqual(settle(30, 300, panel, view), { left: 12, top: 300 }, "within 28 px of the left edge → snaps");
  assert.deepEqual(settle(500, 300, panel, view), { left: 500, top: 300 }, "free in the middle");
  const spot = toSpot(12, 12, panel, view);
  assert.deepEqual(spot, { x: 0, y: 0 });
  assert.deepEqual(placeAt(spot, panel, { w: 800, h: 600 }), { left: 12, top: 12 }, "top-left stays top-left in a smaller window");
  assert.deepEqual(placeAt({ x: 1, y: 1 }, panel, { w: 300, h: 300 }), { left: 12, top: 12 }, "a window smaller than the panel: pinned to the margin, never negative");
});

test("floating panel: one spot everywhere, or one per coin page (last 50 kept)", () => {
  let s = defaultInstantTrade();
  s = withSpot(s, { x: 0, y: 0 }, "Mint1");
  assert.deepEqual(spotFor(s, "Mint2"), { x: 0, y: 0 }, "global");
  s = { ...s, remember: "per-coin" };
  s = withSpot(s, { x: 1, y: 0 }, "Mint1");
  assert.deepEqual(spotFor(s, "Mint1"), { x: 1, y: 0 });
  assert.deepEqual(spotFor(s, "Mint2"), { x: 0, y: 0 }, "falls back to the global spot");
  s = withSpot(s, null, "Mint1");
  assert.equal(s.posByMint.Mint1, undefined, "double-click docks this coin's panel");
  for (let i = 0; i < 60; i++) s = withSpot(s, { x: 0.5, y: 0.5 }, `M${i}`);
  assert.equal(Object.keys(s.posByMint).length, IT_MAX_COINS);
});
