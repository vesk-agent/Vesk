import { test } from "node:test";
import assert from "node:assert/strict";
import { b58encode } from "../src/base58.js";
import { normalizeSecret, parseWalletImport, planFunding, planReturn } from "../src/wallet/multi.js";
import { WALLET_1, WALLET_2, MINT_A, MINT_B } from "./fixtures.js";

const key = (seed: number) => Uint8Array.from({ length: 64 }, (_, i) => (seed * 31 + i * 7 + 1) % 256);
const k58 = (seed: number) => b58encode(key(seed));

test("import: one key per line, CSV with labels, JSON arrays and objects", () => {
  const lines = parseWalletImport(`# my wallets\n${k58(1)}\n\n${k58(2)}\n`);
  assert.equal(lines.entries.length, 2);
  assert.deepEqual(lines.errors, []);
  const csv = parseWalletImport(`label,private_key\nTeam A,${k58(3)}\n${k58(4)},Team B\n`);
  assert.deepEqual(csv.entries.map((e) => e.label), ["Team A", "Team B"]);
  const arr = parseWalletImport(JSON.stringify([Array.from(key(5)), k58(6), { label: "Ops", secretKey: k58(7) }]));
  assert.equal(arr.entries.length, 3);
  assert.equal(arr.entries[2].label, "Ops");
  const single = parseWalletImport(JSON.stringify(Array.from(key(8))));
  assert.equal(single.entries.length, 1);
});

test("import errors point at lines and never echo key material; duplicates are skipped", () => {
  const bad = "3vQB7B6MrGQZaxCuFg4oh" + "x".repeat(60);
  const r = parseWalletImport(`${k58(1)}\n${k58(1)}\n${bad}\nnot a key\n`);
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.errors.map((e) => e.where), ["line 2", "line 3", "line 4"]);
  const msgs = JSON.stringify(r.errors);
  assert.ok(!msgs.includes(k58(1)) && !msgs.includes("3vQB7B6"), "no key material in errors");
  assert.equal(normalizeSecret("[1,2,3]"), null);
  assert.equal(normalizeSecret(k58(9))?.length, 64);
});

test("funding: even split, custom amounts, reserve respected", () => {
  const even = planFunding({ main: WALLET_1, targets: [WALLET_2, MINT_A, MINT_B], mode: "even", totalSol: 1, mainBalanceSol: 2, reserveSol: 0.05 });
  assert.deepEqual(even.errors, []);
  assert.equal(even.transfers.length, 3);
  assert.ok(even.transfers.every((t) => t.from === WALLET_1 && Math.abs(t.sol - 0.333333333) < 1e-12));
  assert.ok(even.totalSol <= 1);
  const custom = planFunding({ main: WALLET_1, targets: [WALLET_2, MINT_A], mode: "custom", amounts: { [WALLET_2]: 0.3, [MINT_A]: 0.2 }, mainBalanceSol: 1, reserveSol: 0.05 });
  assert.deepEqual(custom.transfers.map((t) => t.sol), [0.3, 0.2]);
  const poor = planFunding({ main: WALLET_1, targets: [WALLET_2], mode: "even", totalSol: 1, mainBalanceSol: 1, reserveSol: 0.05 });
  assert.match(poor.errors.join(), /reserve/);
  const self = planFunding({ main: WALLET_1, targets: [WALLET_1], mode: "even", totalSol: 1, mainBalanceSol: 5, reserveSol: 0 });
  assert.match(self.errors.join(), /at least one wallet/);
});

test("return all: everything back to main, minus each wallet's own fee", () => {
  const r = planReturn(WALLET_1, [{ address: WALLET_1, balanceSol: 3 }, { address: WALLET_2, balanceSol: 0.5 }, { address: MINT_A, balanceSol: 0.000001 }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].to, WALLET_1);
  assert.ok(Math.abs(r[0].sol - 0.499995) < 1e-12);
});
