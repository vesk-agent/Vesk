/** v13: the one-sentence refusal and the Vesk brand fields. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntent, REFUSAL } from "../src/rules/parse.js";
import { checkTrade } from "../src/guardrails.js";
import { BRAND } from "../src/brand.js";

test("prohibited requests: one plain sentence, nothing drafted; the guardrails still refuse in code", () => {
  for (const s of ["run a volume bot on my coin", "can you run a volume bot for launch day", "spin up sockpuppets", "stealth launch my coin", "buy followers for launch"]) {
    const r = parseIntent(s);
    assert.equal(r.kind, "refuse", s);
    assert.equal(r.kind === "refuse" && r.reason, REFUSAL, s);
  }
  assert.equal(REFUSAL, "I can't do that one.");
  assert.ok(!/guardrail|why|refused/i.test(REFUSAL));
  assert.equal(typeof checkTrade, "function");
});

test("brand: Vesk Agent, $VESK, @vesk_agent, the vesk CLI, the veskagent.com domain", () => {
  assert.equal(BRAND.name, "Vesk");
  assert.equal(BRAND.product, "Vesk Agent");
  assert.equal(BRAND.token, "$VESK");
  assert.equal(BRAND.xHandle, "vesk_agent");
  assert.equal(BRAND.xHandleBackup, "veskagent");
  assert.equal(BRAND.cli, "vesk");
  assert.equal(BRAND.domain, "veskagent.com");
});
