/**
 * v26: launch on posts as a full rule system (triggers, velocity, hours, topic dedupe, the clash check, race reports,
 * templates, backtest, per-rule stats, chat), pump.fun Custom Pairs (the registry, fees 0.05-1%, Cashback, the split,
 * the on-chain mint check, pair discovery), and the claim without a swap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_PAIR_FEE_PRESETS, EXCLUDED_QUOTES, findPair, mergeSeen, pairCounts, pairSelectable, pairStatus, PF, PUMPFUN_PAIRS, REPORTED_TOTAL, searchPairs, seenRecently, STATUS_LABEL, tilesOf } from "../src/launch/pairs.js";
import { PUMPFUN_CAPS, unverifiedSettings } from "../src/launch/capabilities.js";
import { createParams, defaultPlan, validatePlan, type LaunchPlan } from "../src/launch/plan.js";
import { mintFactsOf, verifyQuoteMint, clearMintCache, judgeMint, mintLine, pairCheckOf } from "../src/launch/mintcheck.js";
import { cropPngSquare, decodePng, dHashOf, focalOffset, hamming, imageDims, imageHashes, imageTooSmall, prepareCoinImage, xPngVariant } from "../src/launch/imagecrop.js";
import { PairDiscovery, quoteMintOf } from "../src/launch/discovery.js";
import { checkClash, CreateFeed, renameTicker, resolveClash, sameImage, statusId, type RecentCreate } from "../src/launch/clash.js";
import { ordinal, raceLabel, raceReport } from "../src/launch/race.js";
import { backtestRule } from "../src/launch/backtest.js";
import { median, ruleStats } from "../src/launch/rulestats.js";
import { applyTemplate, LAUNCH_TEMPLATES } from "../src/launch/templates.js";
import {
  applyName, askSuggestions, confirmCardText, defaultLaunchRule, describeLaunchRule, moveHandle, normStyle, draftToken, fillTemplate, fromPost, inHours, matchLaunchPost, normalizeLaunchRule,
  parseLaunchInfoRequest, parseLaunchRuleRequest, parseNameReply, patternError, pendingText, priorityHold, priorityOf, similarity, topicClash, validateLaunchRule, velocityDecision, type LaunchOnPostRule, type LaunchRecord,
} from "../src/launch/onpost.js";
import { parseClaimRequest } from "../src/launch/claim.js";
import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from "../src/coin/supply.js";
import type { XPost } from "../src/types.js";
import { WALLET_1, WALLET_2 } from "./fixtures.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58len(s: string): number {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return -1; n = n * 58n + BigInt(i); }
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes++; }
  return bytes + (s.length - s.replace(/^1+/, "").length);
}
const post = (o: Partial<XPost> = {}): XPost => ({ id: "1850000000000000001", handle: "harbourdesk", text: "Last ferry tonight. The harbour lights are on.", urls: [], createdAt: new Date().toISOString(), media: [{ type: "photo", url: "https://pbs.mock/a.jpg" }], ...o });
const rule = (o: Partial<LaunchOnPostRule> = {}): LaunchOnPostRule => defaultLaunchRule({ id: "lp_t", enabled: true, trigger: { handles: ["harbourdesk", "lumen_wire"], requireImage: true }, ...o });

// ------------------------------------------------------------------------------------------------ custom pairs

// pump.fun's Supported Pair Assets list as of 2026-10-09 (research/logos/PAIRS-FOUND.md), by category after the v27 G mapping
const PF_COUNTS = { stable: 3, crypto: 35, stock: 64, preipo: 1, metal: 2, meme: 47 };
test("v26 → v27 G pairs: the selectable list is pump.fun's own (2026-10-09); every mint a 32-byte base58 key", () => {
  const c = pairCounts();
  assert.equal(c.native, 1, "SOL");
  assert.equal(c.listed, 152, "151 from pump.fun's list (155 less SOL and the three named after people) + USD1 (owner's report)");
  assert.equal(c.unavailable, 0, "entries pump.fun doesn't list were dropped, not kept as unavailable");
  assert.equal(c.discovered, 0, "discovered pairs only come at runtime");
  assert.equal(c.total, 153);
  assert.equal(c.selectable, 153);
  const byCat: Record<string, number> = {};
  for (const p of PUMPFUN_PAIRS) if (p.category !== "native") byCat[p.category] = (byCat[p.category] ?? 0) + 1;
  assert.deepEqual(byCat, PF_COUNTS);
  for (const id of ["USDT", "xSOL", "SPCXx", "OPENAI", "ANTHROPIC", "tOpenAI", "tKalshi", "SILV", "mSOL"]) assert.equal(findPair(id), undefined, `${id} isn't on pump.fun's list: dropped`);
  for (const id of ["ANSEM", "ALON", "Cupsey"]) assert.ok(!findPair(id), `${id} is never listed`);
  assert.equal(findPair("TRUMP")?.category, "meme", "TRUMP is listed under Memes, never a tile");
  assert.ok(PUMPFUN_PAIRS.filter((p) => p.id !== "SOL").every((p) => p.verify), "every non-SOL pair is verify-on-first-launch");
  for (const p of PUMPFUN_PAIRS) {
    if (p.mint && p.mint !== "native") assert.equal(b58len(p.mint), 32, `${p.id} mint decodes to 32 bytes`);
    if (p.mint && p.mint !== "native") assert.ok(p.mint.length >= 32 && p.mint.length <= 44, `${p.id} mint length`);
    if (pairSelectable(p)) assert.ok(p.source, `${p.id} has a source`);
    if (p.status === "listed" && p.id !== "USD1") assert.equal(p.source, PF, `${p.id} comes from pump.fun's list`);
    if (p.mint && p.mint !== "native") assert.ok(!(p.mint in EXCLUDED_QUOTES), `${p.id} isn't excluded`);
  }
  assert.equal(new Set(PUMPFUN_PAIRS.map((p) => p.id.toLowerCase())).size, PUMPFUN_PAIRS.length, "no duplicate symbols");
  assert.equal(new Set(PUMPFUN_PAIRS.filter((p) => p.mint).map((p) => p.mint)).size, PUMPFUN_PAIRS.filter((p) => p.mint).length, "no duplicate mints");
  // logos: the asset's own token picture (pair-*), named by mint; none for a picture of a real person (noImage says why)
  assert.deepEqual(Object.fromEntries(["WBTC", "WETH", "ZEC", "SOL", "COINx", "NVDAx", "AAPLx", "BA", "$WIF", "TRUMP", "GIGA", "67", "gork", "neet"].map((id) => [id, findPair(id)!.logo])),
    { WBTC: "pair-wbtc", WETH: "pair-weth", ZEC: "pair-zec", SOL: "solana", COINx: "pair-coinx", NVDAx: "pair-nvdax", AAPLx: "pair-aaplx", BA: "pair-ba", $WIF: "pair-wif", TRUMP: null, GIGA: null, "67": null, gork: null, neet: null });
  assert.ok(PUMPFUN_PAIRS.filter((p) => p.logo === null).every((p) => p.noImage), "a pair without a picture says why");
  // the SpaceX note in PAIRS-FOUND.md: pump.fun's SPCX (Backpack Securities) is offered; the SPCXx xStock (Xs3oZ…) is gone
  assert.deepEqual([findPair("SPCX")!.mint, findPair("SPCX")!.category, findPair("SPCX")!.issuer, pairSelectable(findPair("SPCX")!)],
    ["SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", "preipo", "Backpack Securities", true]);
  assert.equal(findPair("Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"), undefined);
  assert.equal(findPair("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp")?.id, "AAPLx", "found by mint");
  assert.equal(findPair("APPLX")?.id, "AAPLx", "pump.fun's spelling is an alias");
  assert.equal(findPair("ETH")?.id, "WETH", "pump.fun lists WETH as ETH");
  assert.deepEqual(["USDC", "USD1", "CHIP"].map((id) => findPair(id)!.category), ["stable", "stable", "stable"]);
  assert.equal(findPair("wif")?.id, "$WIF");
  assert.equal(findPair("lmao")?.id, "LMAO!");
  assert.equal(REPORTED_TOTAL, 155);
});

test("v26 pairs: SOL / USDC / USD1 tiles, categories, search, statuses shown (Verified on-chain only after a passing check)", () => {
  assert.deepEqual(tilesOf().map((p) => p.id), ["SOL", "USDC", "USD1"]);
  assert.deepEqual(searchPairs("").map((x) => x.label), ["Solana", "Stablecoins", "Crypto", "Stocks", "Pre-IPO", "Metals", "Memes"]);
  assert.deepEqual(searchPairs("nvda").map((x) => x.label), ["Stocks"]);
  assert.deepEqual(searchPairs("metal").map((x) => x.items.map((p) => p.id)), [["GLDx", "PAXG"]], "a category name finds its pairs");
  assert.deepEqual(searchPairs("applx").map((x) => x.items.map((p) => p.id)), [["AAPLx"]], "search knows pump.fun's spelling");
  assert.equal(findPair("nvdax")?.id, "NVDAx");
  const nv = findPair("NVDAx")!;
  assert.equal(pairStatus(nv), "listed");
  assert.equal(pairStatus(nv, { mint: nv.mint!, ok: true }), "verified");
  assert.equal(pairStatus(nv, { mint: nv.mint!, ok: false }), "listed", "a failed check never shows verified");
  assert.equal(pairStatus({ status: "unavailable", mint: null }, { mint: "x", ok: true }), "unavailable");
  assert.deepEqual([STATUS_LABEL.verified, STATUS_LABEL.listed, STATUS_LABEL.discovered, STATUS_LABEL.unavailable], ["Verified on-chain", "Listed", "Discovered", "Not available yet"]);
  const p = defaultPlan();
  const req = createParams({ ...p, token: { ...p.token, name: "Ferry", symbol: "FERRY", description: "d", quote: "NVDAx" } });
  assert.equal(req[PUMPFUN_CAPS.createParams.quote.field], nv.mint);
  assert.ok(PUMPFUN_CAPS.quoteAssets.every((q) => q.id === "SOL" || pairSelectable(findPair(q.id)!)), "only usable pairs reach the create request");
  assert.ok(!PUMPFUN_CAPS.quoteAssets.some((q) => ["USDT", "OPENAI", "SPCXx", "mSOL"].includes(q.id)), "pairs pump.fun doesn't list never do");
  assert.ok(PUMPFUN_CAPS.quoteAssets.some((q) => q.id === "BA") && PUMPFUN_CAPS.quoteAssets.some((q) => q.id === "WBTC"), "the Backpack stocks and WBTC have their mints now");
});

const NEWQ = "NEWQuoteMintForTests11111111111111111111111"; // not a real mint (WALLET_2 happens to be Buttcoin's, a pump.fun pair now)
test("v26 pairs: discovery adds a new mint as Discovered, never overwrites a known mint, never duplicates a symbol, drops ANSEM / ALON / Cupsey", () => {
  const nv = findPair("NVDAx")!;
  const m = mergeSeen(PUMPFUN_PAIRS, [{ mint: nv.mint!, symbol: "FAKE", decimals: 8, at: 5 }, { mint: NEWQ, symbol: "NEWQ", name: "New Quote", decimals: 6, at: 6 }]);
  assert.equal(m.find((p) => p.mint === nv.mint)!.id, "NVDAx", "listed mint keeps its line");
  const n = m.find((p) => p.mint === NEWQ)!;
  assert.deepEqual([n.id, n.category, n.status, n.decimals], ["NEWQ", "other", "discovered", 6]);
  const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"; // Marinade's docs; not on pump.fun's list, so not in the registry
  const withEth = mergeSeen(PUMPFUN_PAIRS, [{ mint: WALLET_1, symbol: "WETH", decimals: 8, at: 1, count: 4 }, { mint: MSOL, symbol: "mSOL", decimals: 9, at: 2, count: 2 }]);
  const weth = withEth.find((p) => p.id === "WETH")!;
  assert.deepEqual([weth.status, weth.mint], ["listed", findPair("WETH")!.mint], "a listed pair keeps its mint");
  const ms = withEth.find((p) => p.mint === MSOL)!;
  assert.deepEqual([ms.id, ms.status, ms.category, pairSelectable(ms)], ["mSOL", "discovered", "other", true], "a dropped pair seen in a live create comes back as Discovered");
  const fake = withEth.find((p) => p.mint === WALLET_1)!;
  assert.equal(fake.id, `WETH ${WALLET_1.slice(0, 4)}…`, "a second WETH is told apart by its mint");
  assert.equal(new Set(withEth.map((p) => p.id.toLowerCase())).size, withEth.length, "no duplicate symbols after discovery");
  assert.deepEqual(tilesOf(withEth).map((p) => p.id), ["SOL", "USDC", "USD1"], "discovered pairs are never tiles");
  for (const ex of Object.keys(EXCLUDED_QUOTES)) {
    const m2 = mergeSeen(PUMPFUN_PAIRS, [{ mint: ex, symbol: "X", at: 1, count: 9 }, { mint: NEWQ, symbol: "NEWQ", at: 3, count: 3 }]);
    assert.ok(!m2.some((p) => p.mint === ex), "an excluded quote is never merged");
    assert.deepEqual(seenRecently(m2).map((p) => [p.id, p.seenCount]), [["NEWQ", 3]]);
    assert.equal(searchPairs("", m2).at(-1)?.label, "Discovered");
    assert.equal(new PairDiscovery().ingest({ quoteMint: ex }), null, "discovery drops it");
  }
});

test("v26 fees: 0.05-1% presets; Cashback and the split are custom-pair settings (verify), sent as their own fields", () => {
  assert.deepEqual(CUSTOM_PAIR_FEE_PRESETS, [0.05, 0.25, 0.5, 1]);
  const p = defaultPlan();
  const tok = (o: Partial<LaunchPlan["token"]>): LaunchPlan => ({ ...p, token: { ...p.token, name: "Ferry", symbol: "FERRY", description: "d", ...o } });
  assert.match(validatePlan(tok({ creatorFees: "cashback" })).map((e) => e.message).join(), /custom pairs/, "Cashback on SOL is refused");
  assert.deepEqual(validatePlan(tok({ quote: "USDC", creatorFees: "cashback" })), []);
  assert.equal(createParams(tok({ quote: "USDC", creatorFees: "cashback" }))[PUMPFUN_CAPS.createParams.cashback!.field], true);
  const split = [{ address: WALLET_1, pct: 60 }, { address: WALLET_2, pct: 40 }];
  assert.deepEqual(validatePlan(tok({ quote: "USDC", creatorFees: "split", feeSplit: split })), []);
  assert.deepEqual(createParams(tok({ quote: "USDC", creatorFees: "split", feeSplit: split }))[PUMPFUN_CAPS.createParams.split!.field], [{ address: WALLET_1, bps: 6000 }, { address: WALLET_2, bps: 4000 }]);
  assert.match(validatePlan(tok({ quote: "USDC", creatorFees: "split", feeSplit: [{ address: WALLET_1, pct: 60 }] })).map((e) => e.message).join(), /add up to 100%/);
  assert.match(validatePlan(tok({ quote: "USDC", creatorFees: "split", feeSplit: Array.from({ length: 11 }, (_, i) => ({ address: WALLET_1.slice(0, -2) + B58[i] + B58[i + 1], pct: 100 / 11 })) })).map((e) => e.message).join(), /At most 10/);
  assert.ok(unverifiedSettings(PUMPFUN_CAPS, "USDC", "cashback").includes("Cashback"));
  assert.ok(unverifiedSettings(PUMPFUN_CAPS, "USDC", "split").includes("the fee split"));
  assert.equal(PUMPFUN_CAPS.feeSplit?.max, 10);
  assert.equal(PUMPFUN_CAPS.feesLock, true);
});

test("v26 mint check: exists, Token / Token-2022, an initialized mint, decimals match; anything else refuses; the freeze authority is reported", async () => {
  const acct = (owner: string, info: Record<string, unknown>, type = "mint") => ({ owner, data: { parsed: { type, info } } });
  assert.deepEqual(mintFactsOf(acct(SPL_TOKEN_2022_PROGRAM, { decimals: 8, isInitialized: true })), { ok: true, program: "spl-token-2022", decimals: 8, supply: undefined, freezeAuthority: null, mintAuthority: null });
  const frozen = mintFactsOf(acct(SPL_TOKEN_PROGRAM, { decimals: 6, isInitialized: true, freezeAuthority: WALLET_2 }));
  assert.equal(judgeMint(frozen, {}).ok, true, "a freeze authority is disclosed, not refused");
  assert.match(mintLine("USDC", judgeMint(frozen, { decimals: 6 })), /SPL Token, 6 decimals, the issuer can freeze it/);
  assert.equal(mintFactsOf(null).ok, false);
  assert.match((mintFactsOf(acct("11111111111111111111111111111111", { decimals: 6 })) as { reason: string }).reason, /not owned/);
  assert.match((mintFactsOf(acct(SPL_TOKEN_PROGRAM, { decimals: 6 }, "account")) as { reason: string }).reason, /isn't a token mint/);
  assert.match((mintFactsOf(acct(SPL_TOKEN_PROGRAM, { decimals: 6, isInitialized: false })) as { reason: string }).reason, /initialized/);
  assert.match((mintFactsOf(acct(SPL_TOKEN_PROGRAM, { isInitialized: true })) as { reason: string }).reason, /decimals/);
  clearMintCache();
  const rpc = { calls: 0, async getAccountInfo() { this.calls++; return { value: acct(SPL_TOKEN_PROGRAM, { decimals: 6, isInitialized: true }) }; } };
  assert.equal((await verifyQuoteMint(rpc, WALLET_1)).ok, true);
  assert.equal((await verifyQuoteMint(rpc, WALLET_1, { decimals: 8 })).ok, false, "decimals mismatch refuses");
  assert.equal(rpc.calls, 1, "cached");
  const bad = { async getAccountInfo() { throw new Error("429"); } };
  assert.match(((await verifyQuoteMint(bad, WALLET_2)) as { reason: string }).reason, /couldn't read/);
  const none = { async getAccountInfo() { return { value: null }; } };
  const c = await verifyQuoteMint(none, "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg");
  assert.match((c as { reason: string }).reason, /no account/);
  assert.deepEqual([pairCheckOf("m", c, 1).ok, pairCheckOf("m", c, 1).reason], [false, "no account at that address"]);
});

test("v26 discovery: the quote mint from a create message (any spelling), SOL and junk ignored; each new mint once", () => {
  assert.equal(quoteMintOf({ quoteMint: WALLET_1 }), WALLET_1);
  assert.equal(quoteMintOf({ quote_mint: WALLET_2 }), WALLET_2);
  assert.equal(quoteMintOf({ quoteMint: "So11111111111111111111111111111111111111112" }), null);
  assert.equal(quoteMintOf({ quoteMint: "not a key" }), null);
  const seen: string[] = [];
  const d = new PairDiscovery({ onNew: (q) => seen.push(q.mint) });
  d.ingest({ quote_mint: WALLET_1 }); d.ingest({ quote_mint: WALLET_1 }); d.ingest({ txType: "create" });
  assert.deepEqual(seen, [WALLET_1]);
  assert.equal(d.list()[0].count, 2);
  assert.equal(d.pairs().find((p) => p.mint === WALLET_1)?.status, "discovered");
});

test("v26 image: dims from PNG / GIF / JPEG headers, the minimum size, X's PNG variant, the centred square crop", async () => {
  // a 6×3 RGBA PNG: columns 0..5 coloured by x
  const w = 6, h = 3, raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([x * 40, y * 80, 7, 255], y * (w * 4 + 1) + 1 + x * 4);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const crcT = (() => { const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Uint8Array) => { const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer); v.setUint32(0, d.length); o.set(new TextEncoder().encode(t), 4); o.set(d, 8); v.setUint32(8 + d.length, crc(o.subarray(4, 8 + d.length))); return o; };
  const ih = new Uint8Array(13); new DataView(ih.buffer).setUint32(0, w); new DataView(ih.buffer).setUint32(4, h); ih[8] = 8; ih[9] = 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", z), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); { let o = 0; for (const p of parts) { png.set(p, o); o += p.length; } }
  assert.deepEqual(imageDims(png), { type: "png", width: 6, height: 3 });
  const sq = (await cropPngSquare(png, { focal: false }))!;
  assert.deepEqual(imageDims(sq), { type: "png", width: 3, height: 3 });
  // the crop keeps the middle columns (x = 1..3 → red 40, 80, 120)
  let o = 8, idat = new Uint8Array();
  while (o < sq.length) { const len = new DataView(sq.buffer).getUint32(o); const t = String.fromCharCode(...sq.subarray(o + 4, o + 8)); if (t === "IDAT") idat = sq.slice(o + 8, o + 8 + len); o += 12 + len; }
  const back = new Uint8Array(await new Response(new Blob([idat]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  assert.deepEqual([back[1], back[5], back[9]], [40, 80, 120]);
  assert.match(imageTooSmall({ type: "png", width: 120, height: 90 }, 256)!, /120×90, under the 256 px minimum/);
  assert.equal(imageTooSmall({ type: "jpeg", width: 1200, height: 675 }, 256), null);
  assert.deepEqual(imageDims(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])), { type: "gif", width: 320, height: 240 });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xa3, 0x04, 0xb0, 0x03]);
  assert.deepEqual(imageDims(jpg), { type: "jpeg", width: 1200, height: 675 });
  assert.equal(xPngVariant("https://pbs.twimg.com/media/GabcDEF123.jpg?name=small"), "https://pbs.twimg.com/media/GabcDEF123?format=png&name=large");
  assert.equal(xPngVariant("https://example.com/a.jpg"), "https://example.com/a.jpg");
  const prep = await prepareCoinImage({ bytes: png, mime: "image/png", filename: "p.png" }, { crop: true, minPx: 3, focal: false });
  assert.ok(prep.ok && /cropped to 3×3 from 6×3/.test(prep.note));
  const small = await prepareCoinImage({ bytes: png, mime: "image/png", filename: "p.png" }, { crop: true, minPx: 256 });
  assert.equal(small.ok, false);
});

/** A test PNG (8-bit RGBA) from a pixel function. */
async function pngOf(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Promise<Uint8Array> {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([...px(x, y), 255], y * (w * 4 + 1) + 1 + x * 4);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const crcT = (() => { const t: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Uint8Array) => { const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer); v.setUint32(0, d.length); o.set(new TextEncoder().encode(t), 4); o.set(d, 8); v.setUint32(8 + d.length, crc(o.subarray(4, 8 + d.length))); return o; };
  const ih = new Uint8Array(13); new DataView(ih.buffer).setUint32(0, w); new DataView(ih.buffer).setUint32(4, h); ih[8] = 8; ih[9] = 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", z), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); { let o = 0; for (const p of parts) { png.set(p, o); o += p.length; } }
  return png;
}

test("v26 image: the square crop follows the detail (focal guess); an even picture stays centred", async () => {
  // 120×40, flat grey with a checkered subject on the right (x 85..115)
  const png = await pngOf(120, 40, (x, y) => (x >= 85 && x < 115 && ((x >> 2) + (y >> 2)) % 2 ? [250, 250, 250] : [40, 40, 40]));
  const d = (await decodePng(png))!;
  const lum = new Float32Array(d.w * d.h).map((_, i) => d.px[i * 4]);
  const off = focalOffset(lum, d.w, d.h);
  assert.ok(off >= 70 && off <= 80, `the square moves right towards the subject (${off})`);
  const flat = await pngOf(120, 40, () => [90, 90, 90]);
  const fd = (await decodePng(flat))!;
  assert.equal(focalOffset(new Float32Array(fd.w * fd.h).fill(90), fd.w, fd.h), 40, "nothing to follow: centred");
  const sq = (await cropPngSquare(png))!;
  assert.deepEqual(imageDims(sq), { type: "png", width: 40, height: 40 });
  const prep = await prepareCoinImage({ bytes: png, mime: "image/png", filename: "p.png" }, { crop: true, minPx: 40 });
  assert.ok(prep.ok && /around the detail/.test(prep.note));
});

test("v26 image hashes: the same file matches by SHA-256; a re-saved PNG by its difference hash; a different picture doesn't", async () => {
  const a = await pngOf(64, 48, (x, y) => [x * 4, y * 5, 120]);
  const a2 = await pngOf(64, 48, (x, y) => [Math.min(255, x * 4 + 3), y * 5, 121]);
  const b = await pngOf(64, 48, (x, y) => [255 - x * 4, (y * 37) % 255, 10]);
  const [ha, ha2, hb] = await Promise.all([imageHashes(a), imageHashes(a2), imageHashes(b)]);
  assert.match(ha.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ha.dhash?.length, 16);
  assert.ok(sameImage(ha, { sha256: ha.sha256 }), "same file");
  assert.notEqual(ha.sha256, ha2.sha256);
  assert.ok(hamming(ha.dhash!, ha2.dhash!) <= 6 && sameImage(ha, { dhash: ha2.dhash }), "near-identical");
  assert.ok(!sameImage(ha, hb), "different picture");
  assert.equal((await imageHashes(new Uint8Array([0xff, 0xd8, 1, 2]))).dhash, undefined, "a JPEG gets only the file hash");
  assert.equal(dHashOf(new Float32Array(9 * 8).fill(1), 9, 8), "0000000000000000");
});

// ------------------------------------------------------------------------------------------------ clash and race

const now = 1_800_000_000_000;
const create = (o: Partial<RecentCreate>): RecentCreate => ({ mint: WALLET_2, name: "Other", symbol: "OTHER", at: now, ...o });
const URL = "https://x.com/harbourdesk/status/1850000000000000001";

test("v26 clash: same post link first, then image, ticker, name; rename / skip / launch anyway", () => {
  assert.equal(statusId("https://twitter.com/a/status/42?s=20"), "42");
  assert.equal(checkClash({ name: "Night Ferry", symbol: "FERRY" }, URL, [create({})]), null);
  assert.equal(checkClash({ name: "Night Ferry", symbol: "FERRY" }, URL, [create({ symbol: "ferry" })])?.kind, "ticker");
  assert.equal(checkClash({ name: "Night Ferry", symbol: "FERRY" }, URL, [create({ name: "night ferry" })])?.kind, "name");
  assert.equal(checkClash({ name: "Night Ferry", symbol: "FERRY" }, URL, [create({ symbol: "FERRY" }), create({ mint: WALLET_1, website: "https://x.com/someone/status/1850000000000000001" })])?.kind, "post", "post link wins");
  assert.equal(renameTicker("FERRY", ["FERRY", "ferry2"]), "FERRY3");
  assert.equal(renameTicker("ABCDEFGHIJ", ["ABCDEFGHIJ"]), "ABCDEFGHI2", "stays within 10 characters");
  const tick = checkClash({ name: "Night Ferry", symbol: "FERRY" }, URL, [create({ symbol: "FERRY" })]);
  assert.deepEqual(resolveClash("skip", tick, { name: "Night Ferry", symbol: "FERRY" }, [create({ symbol: "FERRY" })]).go, false);
  const ren = resolveClash("rename", tick, { name: "Night Ferry", symbol: "FERRY" }, [create({ symbol: "FERRY" })]);
  assert.ok(ren.go && ren.symbol === "FERRY2" && ren.renamedFrom === "FERRY");
  const any = resolveClash("launch", tick, { name: "Night Ferry", symbol: "FERRY" }, []);
  assert.ok(any.go && any.symbol === "FERRY" && /launching anyway/.test(any.note!));
  const post = checkClash({ name: "Night Ferry", symbol: "FERRY" }, URL, [create({ website: URL })]);
  assert.equal(resolveClash("rename", post, { name: "Night Ferry", symbol: "FERRY" }, []).go, false, "a post-link clash can't be renamed away");
  const img = { sha256: "ab".repeat(32) };
  const ic = checkClash({ name: "Night Ferry", symbol: "FERRY" }, URL, [create({ symbol: "FERRY" }), create({ mint: WALLET_1, symbol: "LAMP", image: img })], img);
  assert.equal(ic?.kind, "image", "the same image comes before the ticker");
  assert.equal(resolveClash("rename", ic, { name: "Night Ferry", symbol: "FERRY" }, []).go, false, "an image clash can't be renamed away");
  assert.match((resolveClash("skip", ic, { name: "Night Ferry", symbol: "FERRY" }, []) as { reason: string }).reason, /this image/);
  const f = new CreateFeed(60_000);
  f.add(create({ at: now - 120_000 })); f.add(create({ mint: WALLET_1, at: now }));
  assert.equal(f.size, 1, "older than the window is dropped");
});

test("v26 race report: ours among the coins for the same post / ticker / name within the window, ranked; the label", () => {
  const postAt = now;
  const creates = [
    create({ mint: "A".repeat(43) + "1", name: "Ferry", symbol: "FERRY", at: postAt + 2_400, website: URL }),
    create({ mint: "A".repeat(43) + "2", name: "Harbour Lights", symbol: "LIGHTS", at: postAt + 5_000, twitter: URL }),
    create({ mint: "A".repeat(43) + "3", name: "Night Ferry", symbol: "NFERRY", at: postAt + 9_000 }),
    create({ mint: "A".repeat(43) + "4", name: "Unrelated", symbol: "XX", at: postAt + 3_000 }),
    create({ mint: "A".repeat(43) + "5", name: "Ferry", symbol: "FERRY", at: postAt + 20 * 60_000 }),
  ];
  const r = raceReport({ mint: WALLET_1, name: "Night Ferry", symbol: "FERRY", landedAt: postAt + 1_700 }, { id: "1850000000000000001", url: URL, at: postAt }, creates, { windowMin: 10, now: postAt + 60_000 });
  assert.equal(r.total, 4, "ours + post link + ticker + name; unrelated and out-of-window left out");
  assert.equal(r.rank, 1);
  assert.equal(raceLabel(r), "1st of 4 · 1.7 s after the post");
  assert.deepEqual(r.entries.map((e) => e.mine), [true, false, false, false]);
  assert.deepEqual(r.entries[1].match, ["post", "ticker"]);
  const withImg = raceReport({ mint: WALLET_1, name: "Night Ferry", symbol: "FERRY", landedAt: postAt + 1_700 }, { id: "1850000000000000001", url: URL, at: postAt }, [...creates, create({ mint: "A".repeat(43) + "6", name: "Lamp", symbol: "LAMP", at: postAt + 4_000, image: { sha256: "cd".repeat(32) } })], { windowMin: 10, image: { sha256: "cd".repeat(32) } });
  assert.equal(withImg.total, 5, "an image match counts too");
  const late = raceReport({ mint: WALLET_1, name: "Night Ferry", symbol: "FERRY", landedAt: postAt + 6_000 }, { id: "1", url: URL, at: postAt }, creates, { windowMin: 10 });
  assert.equal(late.rank, 3);
  assert.deepEqual([ordinal(1), ordinal(2), ordinal(3), ordinal(11), ordinal(22)], ["1st", "2nd", "3rd", "11th", "22nd"]);
});

// ------------------------------------------------------------------------------------------------ triggers

test("v26 triggers: ignore toggles, include / exclude phrases, media, cashtag and contract address, language", () => {
  const r = rule();
  assert.equal(matchLaunchPost(r, post({ isReply: true })).ok, false);
  assert.equal(matchLaunchPost(rule({ trigger: { ...r.trigger, ignore: { replies: false, quotes: true, reposts: true } } }), post({ isReply: true })).ok, true, "replies allowed when the toggle is off");
  assert.equal(matchLaunchPost(r, post({ isQuote: true })).ok, false);
  const kw = rule({ trigger: { ...r.trigger, keywords: ["harbour lights"], exclude: ["giveaway"] } });
  assert.equal(matchLaunchPost(kw, post()).ok, true, "phrase match");
  assert.match((matchLaunchPost(kw, post({ text: "Harbour lights giveaway!" })) as { reason: string }).reason, /excluded/);
  const vid = rule({ trigger: { ...r.trigger, media: "video", requireImage: false } });
  assert.equal(matchLaunchPost(vid, post()).ok, false);
  assert.equal(matchLaunchPost(vid, post({ media: [{ type: "video", url: "v" }] })).ok, true);
  const noTag = rule({ trigger: { ...r.trigger, cashtag: "forbid", contract: "forbid" } });
  assert.equal(matchLaunchPost(noTag, post({ text: "Buy $FERRY now" })).ok, false);
  assert.equal(matchLaunchPost(noTag, post({ text: `CA ${WALLET_1}` })).ok, false);
  assert.equal(matchLaunchPost(rule({ trigger: { ...r.trigger, contract: "require" } }), post({ text: `CA ${WALLET_1}` })).ok, true);
  const en = rule({ trigger: { ...r.trigger, languages: ["en"] } });
  assert.equal(matchLaunchPost(en, post({ lang: "es" })).ok, false);
  const m = matchLaunchPost(en, post());
  assert.ok(m.ok && m.notes.some((n) => /language/.test(n)), "no language from the source: said, not guessed");
});

test("v26 triggers: hours (windows may cross midnight, with a UTC offset) and velocity (wait, then decide)", () => {
  const at = Date.UTC(2026, 9, 27, 23, 30);
  assert.equal(inHours({ hours: [{ from: "22:00", to: "02:00" }] }, at), true);
  assert.equal(inHours({ hours: [{ from: "09:00", to: "17:00" }] }, at), false);
  assert.equal(inHours({ hours: [{ from: "09:00", to: "17:00" }], tzOffsetMin: 600 }, at), true, "09:30 in UTC+10");
  const v = { likes: 500, withinSec: 60, waitSec: 120 };
  assert.ok(velocityDecision(v, [{ ms: 5_000, likes: 40 }], 5_000).go === false && (velocityDecision(v, [{ ms: 5_000, likes: 40 }], 5_000) as { wait: boolean }).wait);
  assert.equal(velocityDecision(v, [{ ms: 5_000, likes: 40 }, { ms: 40_000, likes: 620 }], 40_000).go, true);
  const no = velocityDecision(v, [{ ms: 5_000, likes: 40 }, { ms: 61_000, likes: 300 }], 61_000);
  assert.ok(!no.go && !("wait" in no && no.wait) && /below 500/.test((no as { reason: string }).reason));
  const blind = velocityDecision(v, [{ ms: 1_000 }], 120_000);
  assert.match((blind as { reason: string }).reason, /aren't available/);
  const r = rule({ trigger: { ...rule().trigger, velocity: v } });
  const m = matchLaunchPost(r, post());
  assert.ok(m.ok && m.wait?.likes === 500, "a match with velocity comes back with wait");
});

test("v26 topic dedupe: a similar post from another account within the window is skipped; one launch per topic", () => {
  const r = rule();
  const hist: LaunchRecord[] = [{ at: now - 5 * 60_000, ruleId: "lp_t", handle: "lumen_wire", postId: "9", status: "launched", sol: 0.2, postText: "The last ferry tonight: the harbour lights are on" }];
  assert.match(topicClash(r, post(), hist, now) ?? "", /same topic as @lumen_wire/);
  assert.equal(topicClash(r, post({ text: "Completely different news about rockets" }), hist, now), null);
  assert.equal(topicClash(r, post(), hist, now + 60 * 60_000), null, "outside the window");
  assert.ok(similarity("Last ferry tonight harbour lights", "harbour lights tonight last ferry") > 0.9);
});

// ------------------------------------------------------------------------------------------------ coin, rule, templates

test("v26 coin: naming from the post's cashtag, description variables, the post as website, the pair on the token; honesty kept", () => {
  const r = rule({ coin: { ...rule().coin, naming: "post", descriptionTemplate: "{name} (${ticker}) from {url} on {date}", links: { website: "https://mine.example" }, websiteFrom: "post" }, pair: { quote: "USDC", fees: "cashback", creatorFeePct: 0.25 } });
  const d = draftToken(r, post({ text: "Tonight: $FERRY lights the harbour", createdAt: "2026-10-27T10:00:00Z" }));
  assert.equal(d.token.symbol, "FERRY");
  assert.equal(d.token.name, "Ferry");
  assert.ok(d.token.description.startsWith("Ferry ($FERRY) from https://x.com/harbourdesk/status/1850000000000000001 on 2026-10-27"), d.token.description);
  assert.ok(d.token.description.endsWith("Inspired by a post from @harbourdesk. Not affiliated with or endorsed by them."));
  assert.equal(d.token.website, URL, "website from the post, not the preset");
  assert.deepEqual([d.token.quote, d.token.creatorFees, d.token.creatorFeePct], ["USDC", "cashback", 0.25]);
  assert.deepEqual(fromPost("no cashtag here"), null);
  assert.equal(fillTemplate("{handle}:{WORD}", post()), "harbourdesk:HARBOUR", "announcement words (tonight, introducing…) are skipped for names");
  const bad = draftToken(rule({ coin: { ...rule().coin, naming: "template", nameTemplate: "Official {Word}" } }), post());
  assert.ok(bad.errors.length, "official claims still refused");
});

test("v26 rule: old rules normalize (requireImage → media, ignore all, SOL pair, skip on clash); validation of the new settings", () => {
  const old = { ...rule(), trigger: { handles: ["a"], requireImage: false } } as LaunchOnPostRule;
  const n = normalizeLaunchRule(old);
  assert.deepEqual([n.trigger.media, n.trigger.ignore, n.pair, n.clash, n.race], ["any", { replies: true, quotes: true, reposts: true }, { quote: "SOL", fees: "creator" }, { action: "skip", windowSec: 120 }, { windowMin: 10 }]);
  assert.ok(describeLaunchRule(n).includes("Instant: no wait for likes"), "velocity is off by default: instant");
  const msg = (r: LaunchOnPostRule) => validateLaunchRule(r).map((e) => e.message).join(" | ");
  assert.match(msg(rule({ trigger: { ...rule().trigger, velocity: { likes: 100, withinSec: 60, waitSec: 30 } } })), /Wait at least/);
  assert.match(msg(rule({ trigger: { ...rule().trigger, hours: [{ from: "9am", to: "17:00" }] } })), /look like 09:00/);
  assert.match(msg(rule({ pair: { quote: "USDT", fees: "creator" } })), /isn't in the pair list/, "a pair pump.fun doesn't list can't be used");
  assert.match(msg(rule({ pair: { quote: "SOL", fees: "cashback" } })), /custom pairs/);
  assert.match(msg(rule({ pair: { quote: "USDC", fees: "split", split: [{ address: WALLET_1, pct: 50 }] } })), /add up to 100/);
  assert.match(msg(rule({ pair: { quote: "USDC", fees: "creator", creatorFeePct: 2 } })), /0.05-1%/);
  assert.equal(msg(rule({ pair: { quote: "NVDAx", fees: "creator", creatorFeePct: 0.5 }, clash: { action: "rename", windowSec: 120 } })), "");
  const lines = describeLaunchRule(rule({ trigger: { ...rule().trigger, velocity: { likes: 500, withinSec: 60, waitSec: 120 } }, pair: { quote: "NVDAx", fees: "creator", creatorFeePct: 0.5 } }));
  assert.ok(lines.some((l) => /500 likes within 60 s/.test(l)) && lines.some((l) => /Pair NVDAx, creator fee 0.5% paid in NVDAx/.test(l)) && lines.some((l) => /skip/.test(l)));
});

test("v26 templates: five tiles; applying one keeps the accounts and links, changes triggers and style", () => {
  assert.deepEqual(LAUNCH_TEMPLATES.map((t) => t.name), ["Founder announcements", "Breaking news", "Image memes", "Product launches", "Custom"]);
  assert.ok(LAUNCH_TEMPLATES.every((t) => t.sets.length > 10), "each tile says what it sets");
  assert.equal(applyTemplate(rule(), "custom").template, "custom");
  assert.deepEqual([normStyle("playful"), normStyle("deadpan"), normStyle("meme"), normStyle("punchy"), normStyle(undefined)], ["punny", "literal", "punny", "short", "short"]);
  const base = rule({ coin: { ...rule().coin, links: { telegram: "https://t.me/mine" } } });
  const b = applyTemplate(base, "breaking");
  assert.deepEqual(b.trigger.handles, ["harbourdesk", "lumen_wire"]);
  assert.equal(b.trigger.velocity?.likes, 500);
  assert.equal(b.coin.links.telegram, "https://t.me/mine");
  assert.equal(b.template, "breaking");
  assert.equal(applyTemplate(base, "memes").coin.style, "punny");
  assert.equal(applyTemplate(base, "founder").trigger.contract, "forbid", "founder posts with a CA are skipped");
  for (const t of LAUNCH_TEMPLATES) assert.deepEqual(validateLaunchRule(normalizeLaunchRule(applyTemplate(base, t.id))), [], t.id);
});

test("v26 backtest: posts replayed in time order through triggers, limits and topic dedupe; nothing spent; honest notes", () => {
  const t0 = Date.UTC(2026, 9, 20, 12);
  const posts: XPost[] = [
    post({ id: "1", createdAt: new Date(t0).toISOString() }),
    post({ id: "2", handle: "lumen_wire", text: "Harbour lights are on, last ferry tonight", createdAt: new Date(t0 + 60_000).toISOString() }),
    post({ id: "3", text: "Rockets at dawn over the bay", createdAt: new Date(t0 + 2 * 3_600_000).toISOString(), media: undefined }),
    post({ id: "4", text: "A new lighthouse opens on the point", createdAt: new Date(t0 + 3 * 3_600_000).toISOString() }),
    post({ id: "5", handle: "someone_else", createdAt: new Date(t0 + 4 * 3_600_000).toISOString() }),
    post({ id: "6", createdAt: new Date(t0 - 9 * 86_400_000).toISOString() }),
  ];
  const r = rule({ limits: { ...rule().limits, cooldownMin: 0, maxPerHour: 5 } });
  const res = backtestRule(r, posts, { now: t0 + 86_400_000, days: 7, source: "sample" });
  assert.equal(res.launches, 2, JSON.stringify(res.rows));
  assert.deepEqual(res.rows.filter((x) => x.outcome === "launch").map((x) => x.postId), ["1", "4"]);
  assert.ok(res.rows.some((x) => x.postId === "2" && /same topic/.test(x.reason!)));
  assert.ok(res.rows.some((x) => x.postId === "3" && /no image/.test(x.reason!)));
  assert.ok(!res.rows.some((x) => x.postId === "5" || x.postId === "6"), "other accounts and older posts aren't counted");
  assert.equal(res.spendSol, 0.6);
  assert.ok(res.notes.some((n) => /clash check isn't replayed/.test(n)));
  const tr = backtestRule(r, posts, { now: t0 + 86_400_000, days: 7, source: "tracker" });
  assert.match(tr.notes[0], /doesn't return post history, so this replays the 4 posts the tracker stored/);
});

test("v26 priority: the account order is the priority; a lower account waits and a same-topic post from a higher one wins (backtest)", () => {
  const r = rule({ trigger: { ...rule().trigger, priorityHoldSec: 20 }, limits: { ...rule().limits, cooldownMin: 0, maxPerHour: 5 } });
  assert.deepEqual([priorityOf(r, "harbourdesk"), priorityOf(r, "LUMEN_WIRE"), priorityOf(r, "nobody")], [1, 2, 0]);
  assert.deepEqual([priorityHold(r, "harbourdesk"), priorityHold(r, "lumen_wire")], [0, 20], "the first account never waits");
  assert.equal(priorityHold(rule(), "lumen_wire"), 0, "no hold by default: instant");
  assert.deepEqual(moveHandle(r, "lumen_wire", -1).trigger.handles, ["lumen_wire", "harbourdesk"]);
  assert.equal(moveHandle(r, "harbourdesk", -1), r, "already first");
  const t0 = Date.UTC(2026, 9, 20, 12);
  const posts = [
    post({ id: "a", handle: "lumen_wire", text: "Harbour lights are on, last ferry tonight", createdAt: new Date(t0).toISOString() }),
    post({ id: "b", createdAt: new Date(t0 + 8_000).toISOString() }),
  ];
  const res = backtestRule(r, posts, { now: t0 + 3_600_000, days: 1, source: "sample" });
  assert.deepEqual(res.rows.map((x) => [x.postId, x.outcome]), [["a", "skip"], ["b", "launch"]]);
  assert.match(res.rows[0].reason!, /@harbourdesk posted the same topic 8 s later and is higher in your list/);
  const noHold = backtestRule({ ...r, trigger: { ...r.trigger, priorityHoldSec: 0 } }, posts, { now: t0 + 3_600_000, days: 1, source: "sample" });
  assert.deepEqual(noHold.rows.map((x) => [x.postId, x.outcome]), [["a", "launch"], ["b", "skip"]], "without a hold the first post wins, one per topic");
  assert.ok(describeLaunchRule(r).some((l) => /in priority order/.test(l)) && describeLaunchRule(r).some((l) => /wait 20 s/.test(l)));
});

test("v26 triggers: regular expressions under Advanced (include OR keywords, exclude), checked before saving", () => {
  const r = rule({ trigger: { ...rule().trigger, patterns: { include: ["\\bv\\d+(\\.\\d+)?\\b"], exclude: ["giveaway|airdrop"] } } });
  assert.equal(matchLaunchPost(r, post({ text: "Dial v2.1 ships tonight" })).ok, true);
  assert.match((matchLaunchPost(r, post({ text: "Nothing versioned here" })) as { reason: string }).reason, /no pattern matched/);
  assert.match((matchLaunchPost(r, post({ text: "v3 airdrop for everyone" })) as { reason: string }).reason, /matches \/giveaway\|airdrop\//);
  const kw = rule({ trigger: { ...rule().trigger, keywords: ["lighthouse"], patterns: { include: ["\\bv\\d+\\b"] } } });
  assert.equal(matchLaunchPost(kw, post({ text: "a new lighthouse" })).ok, true, "a keyword or a pattern");
  assert.equal(matchLaunchPost(kw, post({ text: "v4 is here" })).ok, true);
  assert.equal(patternError("(a+)+$"), "nested repeats like (a+)+ aren't allowed");
  assert.match(patternError("([a-z")!, /not a valid pattern/);
  assert.equal(patternError("x".repeat(121)), "at most 120 characters");
  assert.match(validateLaunchRule(rule({ trigger: { ...rule().trigger, patterns: { include: ["(a+)+"] } } })).map((x) => x.message).join(), /nested repeats/);
});

test("v26 naming: short / literal / punny styles, and \"Ask me\" in Confirm mode with suggestions; your name goes through the honesty pass", () => {
  assert.match(validateLaunchRule(rule({ mode: "auto", coin: { ...rule().coin, naming: "ask" } })).map((x) => x.message).join(), /needs Confirm mode/);
  assert.deepEqual(validateLaunchRule(rule({ mode: "confirm", coin: { ...rule().coin, naming: "ask" } })), []);
  const r = rule({ mode: "confirm", coin: { ...rule().coin, naming: "ask", nameTemplate: "{Word}", tickerTemplate: "{WORD}" } });
  const sug = askSuggestions(r, post({ text: "The harbour gets a $LAMP tonight" }), { name: "Harbour Lamp", symbol: "HLAMP" });
  assert.deepEqual(sug, [{ name: "Harbour Lamp", symbol: "HLAMP" }, { name: "Lamp", symbol: "LAMP" }, { name: "Harbour", symbol: "HARBOUR" }]);
  assert.deepEqual(askSuggestions(r, post(), { name: "Official Ferry", symbol: "OFF" }).map((x) => x.symbol), ["HARBOUR"], "a model suggestion claiming to be official is dropped");
  assert.deepEqual(parseNameReply("Night Ferry $FERRY"), { name: "Night Ferry", symbol: "FERRY" });
  assert.deepEqual(parseNameReply("/launch ab12cd Night Ferry / ferry"), { name: "Night Ferry", symbol: "FERRY" });
  assert.deepEqual(parseNameReply("lamp"), { name: "Lamp", symbol: "LAMP" });
  assert.equal(parseNameReply(""), null);
  const d = draftToken(r, post(), null);
  const named = applyName(d.token, post(), { name: "Night Ferry", symbol: "ferry!" });
  assert.deepEqual([named.token.name, named.token.symbol, named.errors], ["Night Ferry", "FERRY", []]);
  assert.ok(named.token.description.endsWith("Not affiliated with or endorsed by them."));
  assert.ok(applyName(d.token, post(), { name: "Official Harbour", symbol: "HARB" }).errors.length, "your own name can't claim to be official either");
  const p = { id: "q1", ruleId: "lp_t", handle: "harbourdesk", postId: "1", postUrl: URL, postText: "t", token: d.token, devBuySol: 0.2, teamWallets: 0, exitSummary: [], createdAt: now, expiresAt: Date.now() + 60_000, ask: true, suggestions: sug, reason: "Matched Harbour news" };
  assert.match(confirmCardText(p), /Matched Harbour news[\s\S]*Name it: reply "Name \$TICKER", or tap a suggestion \(Harbour Lamp \$HLAMP/);
  assert.match(pendingText(p), /\/launch q1 Name \$TICKER/);
  const chat = parseLaunchRuleRequest("launch a coin when @harbourdesk posts, ask me for the name")!;
  assert.deepEqual([chat.draft.coin.naming, chat.draft.mode], ["ask", "confirm"]);
  assert.equal(parseLaunchRuleRequest("launch a coin when @harbourdesk posts, punny names")!.draft.coin.style, "punny");
});

test("v26 stats: launches, first-place rate from race reports, median post → landed, PnL and fees per asset", () => {
  const rr = (rank: number, ms: number) => ({ postId: "p", postAt: 0, landedAt: ms, rank, total: 5, msAfterPost: ms, windowMin: 10, computedAt: 0, entries: [], complete: true });
  const h: LaunchRecord[] = [
    { at: 1, ruleId: "lp_t", handle: "a", postId: "1", status: "launched", sol: 0.2, mint: "M1", race: rr(1, 1700) },
    { at: 2, ruleId: "lp_t", handle: "a", postId: "2", status: "launched", sol: 0.2, mint: "M2", race: rr(3, 2900) },
    { at: 3, ruleId: "lp_t", handle: "a", postId: "3", status: "launched", sol: 0.2, mint: "M3", timings: [{ mark: "landed", ms: 2100 }] },
    { at: 4, ruleId: "lp_t", handle: "a", postId: "4", status: "skipped", sol: 0 },
    { at: 5, ruleId: "lp_other", handle: "a", postId: "5", status: "launched", sol: 0.2, mint: "M5" },
  ];
  const s = ruleStats("lp_t", h, { pnlByMint: { M1: 0.4, M2: -0.1 }, feesByMint: { M1: [{ asset: "SOL", amount: 0.05 }], M2: [{ asset: "USDC", amount: 12 }] } });
  assert.deepEqual([s.launches, s.raced, s.firsts, s.firstRate, s.medianMs, s.pnlSol], [3, 2, 1, 0.5, 2100, 0.3]);
  assert.deepEqual(s.fees, [{ asset: "SOL", amount: 0.05 }, { asset: "USDC", amount: 12 }]);
  assert.equal(median([]), null);
});

test("v26 chat: launch rules with velocity, language and a pair; questions about backtests, stats, races and pairs; the confirm card", () => {
  const r = parseLaunchRuleRequest("launch a coin whenever @harbourdesk posts a picture with 500 likes in 60 seconds, only english, on a USDC pair, rename if the ticker is taken")!;
  assert.ok(r, "parsed");
  assert.deepEqual(r.draft.trigger.velocity, { likes: 500, withinSec: 60, waitSec: 60 });
  assert.deepEqual(r.draft.trigger.languages, ["en"]);
  assert.equal(r.draft.pair?.quote, "USDC");
  assert.equal(r.draft.clash?.action, "rename");
  assert.deepEqual(r.errors, []);
  // the brief's example, word for word
  const ex = parseLaunchRuleRequest("launch a coin when @x posts with a picture, pair it with USDC, 0.5% fee")!;
  assert.deepEqual([ex.draft.trigger.handles, ex.draft.trigger.media, ex.draft.pair], [["x"], "image", { quote: "USDC", fees: "creator", creatorFeePct: 0.5 }]);
  assert.deepEqual(ex.errors, []);
  const ex2 = parseLaunchRuleRequest("when @kilnlabs posts about launching, launch on NVDAx with 0.25% creator fee and cashback, skip if the ticker is taken, confirm first")!;
  assert.deepEqual([ex2.draft.trigger.handles, ex2.draft.pair?.quote, ex2.draft.pair?.creatorFeePct, ex2.draft.pair?.fees, ex2.draft.clash?.action, ex2.draft.mode], [["kilnlabs"], "NVDAx", 0.25, "cashback", "skip", "confirm"]);
  const ex3 = parseLaunchRuleRequest(`launch a coin when @kilnlabs posts, pair it with USDC, split fees ${WALLET_1}:70 ${WALLET_2}:30`)!;
  assert.deepEqual(ex3.draft.pair?.split, [{ address: WALLET_1, pct: 70 }, { address: WALLET_2, pct: 30 }]);
  const usdt = parseLaunchRuleRequest("launch a coin when @x posts, pair it with USDT")!;
  assert.match(usdt.summary.join(), /USDT isn't on pump\.fun's supported pairs list/);
  assert.equal(usdt.draft.pair?.quote ?? "SOL", "SOL");
  assert.equal(parseLaunchRuleRequest("launch a coin when @x posts, pair it with WBTC")!.draft.pair?.quote, "WBTC", "WBTC has its mint from pump.fun's list now");
  assert.equal(parseLaunchInfoRequest("backtest my launch rule")?.ask, "backtest");
  assert.deepEqual([parseLaunchInfoRequest("race report for $FERRY")?.ask, parseLaunchInfoRequest("race report for $FERRY")?.symbol], ["race", "FERRY"]);
  assert.equal(parseLaunchInfoRequest("how are my launch rules doing")?.ask, "stats");
  assert.deepEqual([parseLaunchInfoRequest("which stock pairs can I use?")?.ask, parseLaunchInfoRequest("which stock pairs can I use?")?.query], ["pairs", "stock"]);
  assert.equal(parseLaunchInfoRequest("buy 0.2 sol of something"), null);
  const card = confirmCardText({ id: "x", ruleId: "lp_t", handle: "harbourdesk", postId: "1", postUrl: URL, postText: "t", token: { name: "Night Ferry", symbol: "FERRY", description: "A ferry.\n\nInspired by…", quote: "USDC", creatorFees: "creator" }, devBuySol: 0.2, teamWallets: 0, exitSummary: ["Sell 50% at $100k market cap"], createdAt: now, expiresAt: Date.now() + 90_000, quote: "USDC", clashNote: "1 coin for $FERRY already launched; renamed to $FERRY2" });
  assert.match(card, /Night Ferry {2}\$FERRY {2}· {2}FERRY\/USDC/);
  assert.match(card, /Clash check: .*renamed/);
  assert.match(card, /Expires in \d+ s/);
  assert.ok(!parseClaimRequest("claim my fees")!.summary.join(" ").match(/swap/i), "claims never mention a swap");
});

test("v26 no-volume exit: engine, validation, wording, chat", async () => {
  const { evaluateExit } = await import("../src/rules/engine.js");
  const { validateExit } = await import("../src/rules/validate.js");
  const { describeLaunchExit, parseLaunchRuleRequest } = await import("../src/launch/onpost.js");
  const now = 1_000_000_000_000;
  const p = { mint: "m", symbol: "X", tokens: 100, avgEntryPriceSol: 1, highestPriceSol: 1, openedAt: now - 200_000, tpDone: [] as number[] } as unknown as Parameters<typeof evaluateExit>[0];
  const x = { noVolume: { windowSec: 120, minVolSol: 0.5 } };
  assert.equal(evaluateExit(p, x, 1, now, undefined, undefined).action, null, "no measurement, no exit");
  assert.equal(evaluateExit(p, x, 1, now, undefined, 0.9).action, null);
  const a = evaluateExit(p, x, 1, now, undefined, 0.2).action;
  assert.equal(a?.kind, "novol"); assert.equal(a?.sellPct, 100);
  assert.equal(evaluateExit({ ...p, openedAt: now - 60_000 }, x, 1, now, undefined, 0).action, null, "younger than the window");
  assert.ok(validateExit({ noVolume: { windowSec: 2, minVolSol: 0.5 } }).length > 0);
  assert.ok(validateExit({ noVolume: { windowSec: 60, minVolSol: 0 } }).length > 0);
  assert.equal(validateExit(x).length, 0);
  assert.ok(describeLaunchExit(x).includes("Sell everything if under 0.5 SOL trades in 120 s"));
  const r = parseLaunchRuleRequest("launch a coin whenever @kilnlabs posts a picture, sell half at 100k, sell if under 0.4 SOL trades in 2 min");
  assert.deepEqual(r?.draft.exit.noVolume, { minVolSol: 0.4, windowSec: 120 });
});

test("v26 CreateStream counts a tracked coin's trades only after a full window", async () => {
  const { CreateStream } = await import("../src/watch/creates.js");
  const s = new CreateStream({});
  const t0 = Date.now();
  s.trackTrades("M1");
  s.ingestTrade("M1", 0.3, t0 + 1000);
  s.ingestTrade("M1", 0.2, t0 + 2000);
  assert.equal(s.volume("M1", 60, t0 + 30_000), undefined);
  assert.equal(s.volume("M1", 60, t0 + 61_000), 0.5);
  assert.equal(s.volume("M2", 60, t0 + 61_000), undefined);
});

test("v26 chat phrases from the docs", async () => {
  const { parseLaunchInfoRequest } = await import("../src/launch/onpost.js");
  assert.equal(parseLaunchInfoRequest("how did my launch rules do")?.ask, "stats");
  const r = parseLaunchInfoRequest("race for $DIAL");
  assert.equal(r?.ask, "race"); assert.equal(r?.symbol, "DIAL");
  assert.equal(parseLaunchInfoRequest("backtest my rule")?.ask, "backtest");
});

test("v26 config: launch-on-post rules in vesk.config.yaml (the shipped example parses, validates and reads in priority order)", async () => {
  const { loadConfig, configLaunchRules } = await import("../src/config.js");
  const { fileURLToPath } = await import("node:url");
  const { config, errors } = await loadConfig(fileURLToPath(new globalThis.URL("../../../examples/vesk.config.yaml", import.meta.url)));
  assert.deepEqual(errors, []);
  const [r] = configLaunchRules(config);
  assert.deepEqual([r.id, r.trigger.handles, r.trigger.contract, r.coin.style, r.clash?.image, r.mode], ["founders", ["kilnlabs", "maraokafor"], "forbid", "literal", true, "confirm"]);
  assert.equal(matchLaunchPost({ ...r, enabled: true }, post({ handle: "kilnlabs", text: "Shipping Dial v2.1 tonight", media: undefined })).ok, true);
  assert.match(validateLaunchRule({ ...r, coin: { ...r.coin, naming: "ask" }, mode: "auto" }).map((e) => e.message).join(), /Confirm mode/);
});
