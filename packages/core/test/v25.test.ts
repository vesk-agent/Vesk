/**
 * v25: burn and lock supply (coin/supply.ts). The plan (amounts, percentages, rounding, refusals), the BurnChecked
 * instruction bytes and account order, the executor's burn against a mock RPC (the transaction it sends is decoded
 * and checked), the agent's burnSupply (launched coins only, confirmation, treasury, disclosure), chat parsing, and the
 * lock scaffold (never a guessed program ID; refuses until verified; a mock adapter shows the seam).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  BURN_CHECKED, BURN_CONFIRM_TEXT, burnCheckedData, burnCheckedKeys, burnDisclosure, burnPlan, lockDisclosure, lockPlan, LockUnavailable,
  parseSupplyAmount, parseSupplyRequest, SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM, STREAMFLOW, streamflowLock, tokenProgramOf, toRaw,
  type LockAdapter,
} from "../src/coin/supply.js";
import { parseIntent } from "../src/rules/parse.js";
import { Executor } from "../src/trade/executor.js";
import { State } from "../src/state.js";
import { DEFAULT_LIMITS } from "../src/types.js";

test("burn plan: tokens or a percentage of what you hold, rounded down, never past the holding", () => {
  const p = burnPlan({ holding: 1_000_000, decimals: 6, pct: 25 });
  assert.ok(p.ok);
  assert.equal(p.tokens, 250_000);
  assert.equal(p.raw, 250_000_000_000n);
  assert.equal(p.remaining, 750_000);
  assert.equal(p.pctOfHolding, 25);
  const all = burnPlan({ holding: 123.456789, decimals: 6, pct: 100 });
  assert.equal(all.raw, 123_456_789n, "100% burns the exact holding (no dust left)");
  assert.equal(burnPlan({ holding: 10, decimals: 6, tokens: 3.3333339 }).raw, 3_333_333n, "rounds down at the mint's decimals");
  assert.match(burnPlan({ holding: 10, decimals: 6, tokens: 11 }).error!, /more than you hold/);
  assert.match(burnPlan({ holding: 10, decimals: 6, pct: 0 }).error!, /above 0/);
  assert.match(burnPlan({ holding: 10, decimals: 6, pct: 120 }).error!, /at most 100/);
  assert.match(burnPlan({ holding: 0, decimals: 6, pct: 10 }).error!, /don't hold any/);
  assert.match(burnPlan({ holding: 10, decimals: 0, tokens: 0.4 }).error!, /rounds to nothing/);
  assert.match(burnPlan({ holding: 10, decimals: 6 }).error!, /amount or a percentage/);
  assert.equal(toRaw(1e9, 6), 1_000_000_000_000_000n, "a whole pump.fun supply fits");
});

test("BurnChecked: [15, u64 LE amount, decimals]; accounts in the program's order; Token or Token-2022 only", () => {
  const d = burnCheckedData(250_000_000_000n, 6);
  assert.equal(d.length, 10);
  assert.equal(d[0], BURN_CHECKED);
  assert.equal(new DataView(d.buffer).getBigUint64(1, true), 250_000_000_000n);
  assert.equal(d[9], 6);
  assert.throws(() => burnCheckedData(0n, 6), /out of range/);
  const k = burnCheckedKeys("ATA", "MINT", "OWNER");
  assert.deepEqual(k.map((x) => [x.pubkey, x.isSigner, x.isWritable]), [["ATA", false, true], ["MINT", false, true], ["OWNER", true, false]]);
  assert.equal(tokenProgramOf(SPL_TOKEN_PROGRAM), SPL_TOKEN_PROGRAM);
  assert.equal(tokenProgramOf(SPL_TOKEN_2022_PROGRAM), SPL_TOKEN_2022_PROGRAM);
  assert.throws(() => tokenProgramOf("11111111111111111111111111111111"), /isn't owned by the SPL Token program/);
});

test("disclosure lines for the treasury report and the coin's updates", () => {
  const l = burnDisclosure("$DIAL", 250_000, "5ig");
  assert.match(l, /^Burned 250K \$DIAL from the dev wallet\. Burned tokens are gone for good\. Tx: https:\/\/solscan\.io\/tx\/5ig$/);
  assert.doesNotMatch(burnDisclosure("DIAL", 1, "paper"), /solscan/, "a paper burn has no transaction to link");
  assert.match(lockDisclosure("DIAL", 2e6, Date.UTC(2027, 0, 31), "Streamflow"), /Locked 2M \$DIAL with Streamflow until 2027-01-31/);
});

test("amounts and chat: \"burn 10% of $DIAL\", \"burn 5M $DIAL\", \"lock 20% of $DIAL for 90 days\"", () => {
  assert.deepEqual(parseSupplyAmount("25%"), { pct: 25 });
  assert.deepEqual(parseSupplyAmount("1,500,000"), { tokens: 1_500_000 });
  assert.deepEqual(parseSupplyAmount("1.5M"), { tokens: 1_500_000 });
  assert.deepEqual(parseSupplyAmount("all"), { pct: 100 });
  assert.equal(parseSupplyAmount("lots"), null);
  const b = parseSupplyRequest("burn 10% of $DIAL")!;
  assert.equal(b.kind, "burn"); assert.equal(b.symbol, "DIAL"); assert.equal(b.pct, 10);
  assert.match(b.summary.join(" "), new RegExp(BURN_CONFIRM_TEXT));
  assert.equal(parseSupplyRequest("burn 5M $DIAL")!.tokens, 5e6);
  assert.equal(parseSupplyRequest("burn all of my $DIAL")!.pct, 100);
  const l = parseSupplyRequest("lock 20% of $DIAL for 90 days")!;
  assert.equal(l.kind, "lock"); assert.equal(l.days, 90); assert.match(l.summary[1], /isn't available yet/);
  assert.equal(parseSupplyRequest("lock 20% of $DIAL for 6 months")!.days, 180);
  assert.equal(parseSupplyRequest("burn 10%"), null, "no coin named: not a burn");
  assert.equal(parseSupplyRequest("snipe anything @x posts and burn 10% of $DIAL"), null);
  assert.equal(parseIntent("burn 10% of $DIAL").kind, "burn", "the chat parser routes it");
});

test("lock: a plan with an unlock date; Streamflow is a scaffold that never guesses its program ID and refuses", async () => {
  const now = Date.UTC(2026, 9, 27);
  const p = lockPlan({ holding: 1e6, decimals: 6, pct: 20, days: 90, now });
  assert.ok(p.ok); assert.equal(p.tokens, 200_000); assert.equal(p.unlockAt, now + 90 * 86_400_000);
  assert.match(lockPlan({ holding: 1e6, decimals: 6, pct: 20, days: 0, now }).error!, /1 day and 10 years/);
  assert.equal(STREAMFLOW.programId, null, "no program ID from memory");
  assert.equal(STREAMFLOW.verified, false);
  assert.equal(streamflowLock.available, false);
  await assert.rejects(streamflowLock.build({ owner: "O", mint: "M", tokenProgram: SPL_TOKEN_PROGRAM, plan: p }), (e: unknown) => e instanceof LockUnavailable && /isn't available yet/.test((e as Error).message));
  // the seam: a verified adapter returns a transaction to sign; a mock shows the shape
  const mock: LockAdapter = { venue: "Mock", available: true, async build({ plan }) { return { txBase64: Buffer.from(`lock:${plan.raw}`).toString("base64"), lockId: "L1" }; } };
  const r = await mock.build({ owner: "O", mint: "M", tokenProgram: SPL_TOKEN_PROGRAM, plan: p });
  assert.equal(Buffer.from(r.txBase64, "base64").toString(), "lock:200000000000");
});

/** A mock RPC that records the raw transaction the executor sends. */
function mockRpc(mintOwner = SPL_TOKEN_PROGRAM, held = 1_000_000) {
  const sent: string[] = [];
  const rpc = {
    getAccountInfo: async () => ({ owner: mintOwner, lamports: 1, data: { parsed: { info: { decimals: 6 } }, program: "spl-token" } }),
    getTokenBalances: async () => [{ mint: MINT, amount: held, decimals: 6 }],
    getLatestBlockhash: async () => ({ blockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: async (b64: string) => { sent.push(b64); return "SIG" + sent.length; },
    confirm: async () => ({ ok: true }),
    getBalanceSol: async () => 1,
    call: async () => null,
  } as unknown as ConstructorParameters<typeof Executor>[0]["rpc"];
  return { rpc, sent };
}
const MINT = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const limits = () => ({ ...DEFAULT_LIMITS, killSwitch: false });

test("executor.burn: one signed BurnChecked from the owner's ATA (decoded from what was sent); Token-2022 mints use their program", async () => {
  for (const program of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
    const state = await new State(await mkdtemp(join(tmpdir(), "vesk-v25-"))).load();
    const wallet = Keypair.generate();
    const { rpc, sent } = mockRpc(program);
    const ex = new Executor({ rpc, wallet, state, limits, defaultPriorityFeeSol: 0 });
    const r = await ex.burn(MINT, 250_000, true, 250_000_000_000n);
    assert.ok(r.ok, r.error ?? "");
    assert.equal(sent.length, 1);
    const tx = VersionedTransaction.deserialize(Buffer.from(sent[0], "base64"));
    const m = tx.message;
    const keys = m.staticAccountKeys.map((k) => k.toBase58());
    assert.equal(m.compiledInstructions.length, 1);
    const ix = m.compiledInstructions[0];
    const data = Buffer.from(ix.data);
    assert.equal(keys[ix.programIdIndex], program);
    assert.equal(data[0], 15);
    assert.equal(data.readBigUInt64LE(1), 250_000_000_000n);
    assert.equal(data[9], 6);
    const [ata] = PublicKey.findProgramAddressSync([wallet.publicKey.toBytes(), new PublicKey(program).toBytes(), new PublicKey(MINT).toBytes()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
    assert.deepEqual(((ix as unknown as { accountKeyIndexes?: number[]; accounts?: number[] }).accountKeyIndexes ?? (ix as unknown as { accounts: number[] }).accounts).map((i: number) => keys[i]), [ata.toBase58(), MINT, wallet.publicKey.toBase58()]);
    assert.equal((m as unknown as { header: { numRequiredSignatures: number } }).header.numRequiredSignatures, 1);
    assert.equal(keys[0], wallet.publicKey.toBase58(), "the owner pays and signs");
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(wallet.publicKey.toBytes()).toString("base64url") }, format: "jwk" });
    assert.ok(verify(null, Buffer.from((m as unknown as { serialize?: () => Uint8Array }).serialize ? (m as unknown as { serialize: () => Uint8Array }).serialize() : (tx as unknown as { _msg: Uint8Array })._msg), pub, Buffer.from(tx.signatures[0])), "signed by the owner");
    assert.ok(state.data.activity.some((l) => l.kind === "burn"));
  }
});

test("executor.burn: undisclosed burns and non-SPL mints are refused; nothing is sent", async () => {
  const state = await new State(await mkdtemp(join(tmpdir(), "vesk-v25b-"))).load();
  const { rpc, sent } = mockRpc("11111111111111111111111111111111");
  const ex = new Executor({ rpc, wallet: Keypair.generate(), state, limits, defaultPriorityFeeSol: 0 });
  const undisclosed = await ex.burn(MINT, 1, false);
  assert.equal(undisclosed.ok, false);
  const notSpl = await ex.burn(MINT, 1, true);
  assert.match(notSpl.error!, /isn't owned by the SPL Token program/);
  assert.equal(sent.length, 0);
  assert.deepEqual(await ex.holding(MINT), { tokens: 1_000_000, decimals: 6 });
});

// ---------------------------------------------------------------- v25.1: the pump.fun pair list (v26: superseded by pairs.ts)
import { mintOf, pairSelectable, PUMPFUN_CAPS, PUMPFUN_PAIRS } from "../src/launch/capabilities.js";
import { QUOTE_MINTS } from "../src/data/programs.js";

test("v25.1 → v26: on-disk mints still come from QUOTE_MINTS; an unavailable pair is never picked", () => {
  for (const id of ["USDC", "USD1"]) { // v27 G: USDT is off the list (pump.fun doesn't offer it)
     const p = PUMPFUN_PAIRS.find((x) => x.id === id)!; assert.equal(QUOTE_MINTS[p.mint!], id, id); }
  assert.equal(mintOf("NOPE"), null);
  assert.equal(pairSelectable({ status: "unavailable", mint: null }), false);
  assert.ok(PUMPFUN_CAPS.quoteAssets.every((q) => q.id === "SOL" ? q.mint === null : !!q.mint));
});
