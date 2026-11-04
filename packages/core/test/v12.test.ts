/**
 * v12: the per-wallet labels shared by the Pulse audits and the coin page's Early buyers (sniper, bundled, insider),
 * and one wallet's trade summary for "View trades".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundledWallets, insiderWallets, isSniper, pulseAudits, SNIPER_WINDOW_MS } from "../src/watch/audits.js";
import { applyPulse, emptyPulse } from "../src/watch/pulse.js";
import { earlyBuyerLabels, earlyBuyers, walletSummary, type TradeLite } from "../src/coin/traders.js";

const DEV = "DEVwa11et111111111111111111111111111111111";
const A = "Abuyer11111111111111111111111111111111111";
const B = "Bbuyer11111111111111111111111111111111111";
const C = "Cbuyer11111111111111111111111111111111111";
const D = "Dbuyer11111111111111111111111111111111111";
const FUNDER = "Funder1111111111111111111111111111111111";

test("isSniper: within the window and not the dev", () => {
  assert.equal(isSniper(A, 1_000 + SNIPER_WINDOW_MS, 1_000, DEV), true);
  assert.equal(isSniper(A, 1_001 + SNIPER_WINDOW_MS, 1_000, DEV), false);
  assert.equal(isSniper(DEV, 1_000, 1_000, DEV), false);
});

test("bundledWallets: with funding only wallets funded together; without funding every block buyer, not exact", () => {
  const funding = { [DEV]: FUNDER, [A]: DEV, [B]: FUNDER, [C]: "Other111111111111111111111111111111111111" };
  const r = bundledWallets([DEV, A, B, C], DEV, funding);
  assert.equal(r.exact, true);
  assert.deepEqual([...r.wallets].sort(), [A, B, DEV].sort());
  const u = bundledWallets([A, C], DEV);
  assert.equal(u.exact, false);
  assert.deepEqual([...u.wallets].sort(), [A, C].sort());
});

test("insiderWallets: funded by the dev, the dev's funder or a shared source; null without funding", () => {
  const S = "Shared11111111111111111111111111111111111";
  const funding = { [DEV]: FUNDER, [A]: DEV, [B]: FUNDER, [C]: S, [D]: S };
  assert.deepEqual([...insiderWallets([DEV, A, B, C, D], DEV, funding)!].sort(), [A, B, C, D].sort());
  assert.deepEqual([...insiderWallets([C], DEV, funding)!], []);
  assert.equal(insiderWallets([A], DEV), null);
});

test("pulseAudits still gives the same snipers / bundled / insiders through the shared predicates", () => {
  const s = emptyPulse();
  const mint = "Mint1111111111111111111111111111111111pump";
  applyPulse(s, { txType: "create", mint, traderPublicKey: DEV, name: "T", symbol: "T", initialBuy: 30_000_000, vSolInBondingCurve: 31, marketCapSol: 32, timestamp: 10_000 } as never);
  applyPulse(s, { txType: "buy", mint, traderPublicKey: A, tokenAmount: 20_000_000, vSolInBondingCurve: 32, marketCapSol: 33, timestamp: 10_200 } as never);
  applyPulse(s, { txType: "buy", mint, traderPublicKey: B, tokenAmount: 10_000_000, vSolInBondingCurve: 33, marketCapSol: 34, timestamp: 20_000 } as never);
  const t = s.tokens[mint];
  const a = pulseAudits(s, t, { funding: { [A]: DEV, [B]: "Elsewhere1111111111111111111111111111111" } });
  // A is a sniper (first buy in the window); B isn't. A is an insider (funded by the dev).
  assert.ok(a.snipersPct > 0);
  assert.equal(a.insidersPct, +((20_000_000 / 1e9) * 100).toFixed(2));
});

test("earlyBuyerLabels: dev, team, you, tracked, sniper, bundled, insider, with exactness flags", () => {
  const t0 = 1_000_000;
  const tr: TradeLite[] = [
    { at: t0 + 100, side: "buy", wallet: DEV, sol: 1, tokens: 30 },
    { at: t0 + 300, side: "buy", wallet: A, sol: 0.5, tokens: 10 },
    { at: t0 + 2_000, side: "buy", wallet: B, sol: 0.5, tokens: 10 },
    { at: t0 + 60_000, side: "buy", wallet: C, sol: 0.2, tokens: 2 },
    { at: t0 + 90_000, side: "sell", wallet: B, sol: 0.6, tokens: 10 },
  ];
  const early = earlyBuyers(tr, 10);
  const L = earlyBuyerLabels(early, { createdAt: t0, dev: DEV, team: [C], own: [A], tracked: [B], funding: { [A]: DEV, [B]: FUNDER, [DEV]: FUNDER, [C]: "Q1111111111111111111111111111111111111111" } });
  assert.deepEqual(L.get(DEV)!.labels, ["dev"]);
  assert.deepEqual(L.get(A)!.labels, ["you", "sniper", "bundled", "insider"]);
  assert.deepEqual(L.get(B)!.labels, ["tracked", "sniper", "insider"]);
  assert.deepEqual(L.get(C)!.labels, ["team"]);
  assert.equal(L.get(A)!.bundledExact, true);
  const noFund = earlyBuyerLabels(early, { createdAt: t0, dev: DEV });
  assert.equal(noFund.get(A)!.insiderKnown, false);
  assert.equal(noFund.get(A)!.bundledExact, false);
  assert.ok(noFund.get(A)!.labels.includes("bundled"));
});

test("walletSummary: first buy, last sell, totals, average entry, realized PnL, still holding", () => {
  const tr: TradeLite[] = [
    { at: 1, side: "buy", wallet: A, sol: 1, tokens: 100 },
    { at: 2, side: "buy", wallet: A, sol: 3, tokens: 100 },
    { at: 3, side: "sell", wallet: A, sol: 3, tokens: 100 },
    { at: 4, side: "buy", wallet: B, sol: 9, tokens: 9 },
  ];
  const s = walletSummary(tr, A);
  assert.equal(s.firstBuyAt, 1);
  assert.equal(s.lastSellAt, 3);
  assert.equal(s.boughtSol, 4);
  assert.equal(s.soldSol, 3);
  assert.equal(s.avgEntrySol, 0.02);
  assert.equal(s.realizedSol, 1); // sold 100 at 0.03 against an average cost of 0.02
  assert.equal(s.holdingTokens, 100);
  assert.equal(s.partial, false);
  assert.equal(walletSummary([{ at: 1, side: "sell", wallet: C, sol: 1, tokens: 5 }], C).partial, true);
});
