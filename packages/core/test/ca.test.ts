import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMints, detectInText, normalizePostText, shortMint } from "../src/ca.js";
import { MINT_A, MINT_B, MINT_C, SIG } from "./fixtures.js";

test("finds a CA on its own line", () => {
  const m = detectMints(`new one\n\n${MINT_A}\n\nlfg`);
  assert.equal(m.length, 1);
  assert.equal(m[0].mint, MINT_A);
  assert.equal(m[0].source, "text");
});

test("CA label raises confidence, wallet context lowers it", () => {
  const ca = detectInText(`CA: ${MINT_C}`)[0];
  const wallet = detectInText(`send donations to my wallet ${MINT_C}`)[0];
  assert.ok(ca.confidence > 0.8);
  assert.ok(wallet.confidence < 0.4);
});

test("ignores truncated addresses", () => {
  assert.equal(detectMints(`CA: Hq4A...pump`).length, 0);
  assert.equal(detectMints(`CA: ${MINT_A.slice(0, 20)}…${MINT_A.slice(-4)}`).length, 0);
  assert.equal(detectMints(`${MINT_A.slice(0, 40)}...`).length, 0);
});

test("ignores transaction signatures and over-long runs", () => {
  assert.equal(detectMints(`tx ${SIG}`).length, 0);
  assert.equal(detectMints(MINT_A + MINT_B).length, 0);
});

test("ignores EVM addresses and strings with non-base58 characters", () => {
  assert.equal(detectMints("0x6982508145454Ce325dDbE47a25d4ec3d2311933").length, 0);
  assert.equal(detectMints("HqOAe2xXbTZ7nRkd9WcYp3mVfL8sJ6uG1oEt5BvNpump").length, 0); // O is not base58: splits into short runs
  assert.equal(detectMints("Hq4Ae2xXbTZ7nRkd9WcYp3mVfL8sJ6uGloEt5BvNpump").length, 0); // l
});

test("ignores system and program addresses", () => {
  assert.equal(detectMints("So11111111111111111111111111111111111111112").length, 0);
  assert.equal(detectMints("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").length, 0);
  assert.equal(detectMints("11111111111111111111111111111111").length, 0);
});

test("ignores single-class look-alikes", () => {
  assert.equal(detectMints("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").length, 0);
  assert.equal(detectMints("ABCDEFGHJKLMNPQRSTUVWXYZABCDEFGHJKLMNPQRSTU").length, 0);
});

test("strips zero-width characters used to dodge bots", () => {
  const hidden = MINT_A.slice(0, 10) + "​" + MINT_A.slice(10);
  assert.equal(normalizePostText(hidden), MINT_A);
  assert.equal(detectMints(`CA ${hidden}`)[0]?.mint, MINT_A);
});

test("reads mints from launchpad and explorer links", () => {
  const m = detectMints("live now", [`https://pump.fun/coin/${MINT_A}`, `https://birdeye.so/token/${MINT_B}?chain=solana`]);
  assert.deepEqual(m.map((x) => x.mint).sort(), [MINT_A, MINT_B].sort());
  assert.ok(m.every((x) => x.source === "url"));
});

test("marks dexscreener links as pairs that need resolving", () => {
  const m = detectMints("chart", [`https://dexscreener.com/solana/${MINT_C}`]);
  assert.equal(m[0].isPair, true);
});

test("a mint in both text and link is reported once", () => {
  const m = detectMints(`CA ${MINT_A} https://pump.fun/coin/${MINT_A}`);
  assert.equal(m.length, 1);
  assert.equal(m[0].source, "text");
});

test("does not treat words next to the address as part of it", () => {
  const m = detectMints(`($ABC)${MINT_B}!`);
  assert.equal(m[0]?.mint, MINT_B);
});

test("shortMint", () => assert.equal(shortMint(MINT_A), "Hq4A…pump"));
