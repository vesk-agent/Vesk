/**
 * v12.1: wallet tag icons (tooltip text for every icon, colour rules) and address-book images (types from bytes,
 * sizes from headers, upload and stored-file rules, metadata stripping, references in import / export, the agent's
 * local store in ~/.vesk/avatars, the identicon).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOLD_STATUSES, orderTags, tagTone, tagTooltip, WALLET_TAGS } from "../src/coin/walletTags.js";
import {
  avatarFromString, avatarToString, checkStored, checkUpload, identicon, imageSize, monogram, sniffImage, stripJpeg, stripPng, validAvatar,
} from "../src/wallet/avatar.js";
import { pruneLocalAvatars, saveLocalAvatar } from "../src/wallet/avatarStore.js";
import { exportBook, importBook, type BookEntry } from "../src/wallet/book.js";

// ---------------------------------------------------------------- tiny images built byte by byte

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
const be32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const chunk = (type: string, data: Uint8Array) => cat(be32(data.length), enc(type), data, Uint8Array.of(0, 0, 0, 0));
const png = (w: number, h: number, extra: Uint8Array[] = []) =>
  cat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", cat(be32(w), be32(h), Uint8Array.of(8, 6, 0, 0, 0))), ...extra, chunk("IDAT", Uint8Array.of(1, 2, 3)), chunk("IEND", new Uint8Array()));
const seg = (m: number, data: Uint8Array) => cat(Uint8Array.of(0xff, m, (data.length + 2) >> 8, (data.length + 2) & 255), data);
const jpeg = (w: number, h: number) => cat(Uint8Array.of(0xff, 0xd8), seg(0xe0, enc("JFIF\0\x01\x01")), seg(0xe1, enc("Exif\0\0GPS 51.5N 0.12W camera=SECRET")), seg(0xfe, enc("comment")),
  seg(0xc0, Uint8Array.of(8, h >> 8, h & 255, w >> 8, w & 255, 3)), seg(0xda, Uint8Array.of(0, 1)), Uint8Array.of(9, 9, 9, 0xff, 0xd9));
const webp = (w: number, h: number) => { const b = cat(enc("RIFF"), Uint8Array.of(30, 0, 0, 0), enc("WEBPVP8X"), Uint8Array.of(10, 0, 0, 0, 0, 0, 0, 0), Uint8Array.of((w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0)); return b; };
const gif = (w: number, h: number) => cat(enc("GIF89a"), Uint8Array.of(w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0));

// ---------------------------------------------------------------- tags

test("tooltip text for every icon (snapshot)", () => {
  const snap = Object.fromEntries([...WALLET_TAGS, ...HOLD_STATUSES].map((t) => [t, tagTooltip(t)]));
  assert.deepEqual(snap, {
    you: { label: "You", desc: "One of your wallets.", how: "Your hosted, imported or signed-linked wallets." },
    dev: { label: "Dev", desc: "Created this coin.", how: "The wallet that signed the coin's create transaction." },
    team: { label: "Team (disclosed)", desc: "A team wallet disclosed at launch.", how: "Listed in the coin's description and treasury report; Vesk launches always disclose them." },
    tracked: { label: "Tracked", desc: "In your address book with Track on.", how: "Your list in Wallets → Address book; its label and image show here." },
    sniper: { label: "Sniper", desc: "Bought right at launch, usually a bot.", how: "First buy within 3 seconds of the coin's creation, and not the dev." },
    bundled: { label: "Bundled", desc: "Bought in the creation block together with linked wallets.", how: "In the creation block, and the dev, funded by the dev or the dev's funder, or funded by the same wallet as another block buyer (first SOL transfer, read through your RPC)." },
    insider: { label: "Insider", desc: "Funded by someone close to the coin.", how: "Its first SOL came from the dev, the dev's funder, or the same wallet as another early buyer (read through your RPC)." },
    holding: { label: "Holding", desc: "Still holds what it bought.", how: "The largest holder accounts when it's among them, otherwise bought minus sold in the loaded trades." },
    "sold some": { label: "Sold part", desc: "Sold some, still holds the rest.", how: "Holds less than 98% of what it bought: the largest holder accounts, or bought minus sold in the loaded trades." },
    "sold all": { label: "Sold all", desc: "Sold everything it bought.", how: "Holds 2% or less of what it bought: the largest holder accounts, or bought minus sold in the loaded trades." },
  });
  assert.equal(tagTooltip("bundled", { approx: true }).how, "No funding data: every creation-block buyer counts, so it's approximate (an upper bound).");
  assert.equal(tagTooltip("insider", { approx: true }).how, "Unknown without funding data, so not shown.");
  assert.equal(tagTooltip("sniper", { approx: true }).how, tagTooltip("sniper").how, "no approximate rule → the exact one");
});

test("tag colours: risk tags amber on other wallets, neutral on yours; you and tracked in the accent", () => {
  assert.equal(tagTone("sniper", ["sniper"]), "risk");
  assert.equal(tagTone("bundled", ["you", "bundled"]), "neutral");
  assert.equal(tagTone("insider", ["team", "insider"]), "neutral");
  assert.equal(tagTone("tracked", ["tracked", "sniper"]), "accent");
  assert.equal(tagTone("dev", ["dev"]), "neutral");
  assert.deepEqual(orderTags(["insider", "dev", "you"]), ["you", "dev", "insider"]);
});

// ---------------------------------------------------------------- images

test("image type comes from the bytes; SVG is recognised (to refuse it)", () => {
  assert.equal(sniffImage(png(4, 4)), "png");
  assert.equal(sniffImage(jpeg(4, 4)), "jpeg");
  assert.equal(sniffImage(webp(64, 64)), "webp");
  assert.equal(sniffImage(gif(4, 4)), "gif");
  assert.equal(sniffImage(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), "svg");
  assert.equal(sniffImage(enc("  <svg onload=alert(1)>")), "svg");
  assert.equal(sniffImage(enc("hello")), null);
});

test("pixel size from the header", () => {
  assert.deepEqual(imageSize(png(640, 480)), { w: 640, h: 480 });
  assert.deepEqual(imageSize(jpeg(300, 200)), { w: 300, h: 200 });
  assert.deepEqual(imageSize(webp(128, 128)), { w: 128, h: 128 });
  assert.deepEqual(imageSize(gif(33, 17)), { w: 33, h: 17 });
});

test("upload rules: PNG / JPEG / WebP / GIF up to 512 KB, never SVG", () => {
  assert.deepEqual(checkUpload(png(200, 200)), { ok: true, type: "png" });
  assert.deepEqual(checkUpload(gif(64, 64)), { ok: true, type: "gif" });
  const svg = checkUpload(enc("<svg xmlns='http://www.w3.org/2000/svg'/>"));
  assert.equal(svg.ok, false); assert.match((svg as { reason: string }).reason, /SVG/);
  const big = checkUpload(cat(png(200, 200), new Uint8Array(512 * 1024)));
  assert.equal(big.ok, false); assert.match((big as { reason: string }).reason, /512 KB/);
  assert.equal(checkUpload(png(8, 8)).ok, false, "too small to be a picture");
  assert.equal(checkUpload(enc("GIF8 not really")).ok, false);
});

test("stored files: WebP or PNG, exactly 64 or 128 px square, at most 64 KB", () => {
  assert.deepEqual(checkStored(webp(64, 64), 64), { ok: true, type: "webp" });
  assert.deepEqual(checkStored(png(128, 128), 128), { ok: true, type: "png" });
  assert.equal(checkStored(webp(64, 64), 128).ok, false);
  assert.equal(checkStored(jpeg(64, 64), 64).ok, false, "JPEG isn't a re-encoded canvas output");
  assert.equal(checkStored(cat(png(64, 64), new Uint8Array(70_000)), 64).ok, false);
});

test("metadata stripping: PNG text / EXIF / time chunks and JPEG APPn / comments are removed", () => {
  const dirty = png(100, 100, [chunk("tEXt", enc("Author\0Alice at 12 Main St")), chunk("eXIf", enc("GPS")), chunk("tIME", Uint8Array.of(7, 230, 1, 1, 0, 0, 0))]);
  const clean = stripPng(dirty);
  const s = new TextDecoder("latin1").decode(clean);
  assert.ok(!s.includes("Alice") && !s.includes("tEXt") && !s.includes("eXIf") && !s.includes("tIME"));
  assert.ok(s.includes("IHDR") && s.includes("IDAT") && s.includes("IEND"));
  assert.deepEqual(imageSize(clean), { w: 100, h: 100 });
  const j = stripJpeg(jpeg(50, 40));
  const js = new TextDecoder("latin1").decode(j);
  assert.ok(!js.includes("Exif") && !js.includes("SECRET") && !js.includes("comment") && js.includes("JFIF"));
  assert.deepEqual(imageSize(j), { w: 50, h: 40 });
});

test("image references: validation and the CSV form", () => {
  assert.ok(validAvatar({ kind: "upload", id: "0123456789abcdef" }));
  assert.ok(validAvatar({ kind: "gen", style: "rings", seed: 3 }));
  assert.ok(!validAvatar({ kind: "upload", id: "../../etc/passwd" }));
  assert.ok(!validAvatar({ kind: "gen", style: "rings", seed: 99 }));
  assert.ok(!validAvatar({ kind: "url", href: "https://evil.example/x.svg" }));
  assert.deepEqual(avatarFromString("gen:monogram:2"), { kind: "gen", style: "monogram", seed: 2 });
  assert.equal(avatarToString({ kind: "upload", id: "00ff00ff00ff00ff" }), "upload:00ff00ff00ff00ff");
  assert.equal(avatarFromString("upload:nothex"), undefined);
});

const A1 = "7Gk2xUqUmvFc3T1rB8e2Lq4y5n6Zp9wHs3K1cVd9fQa";
const A2 = "Dxf4wN1a2q7HnC6vU5mT8rK3pL9yBz2sJe4gW6hRk1M";

test("bulk export / import keep labels, tags, notes, track, KOL and image references (JSON and CSV)", () => {
  const book: BookEntry[] = [
    { address: A1, label: "Early bird", marker: "violet", bookmark: false, note: "fast, sells in 5 min", track: true, avatar: { kind: "upload", id: "a1b2c3d4e5f60718" } },
    { address: A2, label: "Fund, desk", marker: "amber", bookmark: true, kol: true, avatar: { kind: "gen", style: "grid", seed: 5 } },
  ];
  for (const fmt of ["json", "csv"] as const) {
    const r = importBook(exportBook(book, fmt));
    assert.deepEqual(r.errors, [], fmt);
    assert.equal(r.entries.length, 2);
    assert.deepEqual(r.entries[0].avatar, book[0].avatar, fmt);
    assert.deepEqual(r.entries[1].avatar, book[1].avatar, fmt);
    assert.equal(r.entries[0].track, true, fmt);
    assert.equal(r.entries[1].kol, true, fmt);
    assert.equal(r.entries[1].label, "Fund, desk", fmt);
    assert.equal(r.entries[0].note, "fast, sells in 5 min", fmt);
    assert.equal(r.entries[0].marker, "violet", fmt);
  }
  const bad = importBook(JSON.stringify([{ address: A1, label: "x", avatar: { kind: "url", href: "javascript:alert(1)" } }]));
  assert.equal(bad.entries.length, 1);
  assert.equal(bad.entries[0].avatar, undefined);
  assert.match(bad.errors[0], /image reference ignored/);
});

test("agent's local store: metadata stripped, SVG / WebP / GIF refused, unused files pruned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vesk-av-"));
  const r = await saveLocalAvatar(dir, png(120, 120, [chunk("tEXt", enc("Comment\0home address"))]));
  assert.equal(r.ref.kind, "upload");
  assert.ok(r.removedBytes > 0);
  const stored = new TextDecoder("latin1").decode(await readFile(r.file));
  assert.ok(!stored.includes("home address"));
  await assert.rejects(saveLocalAvatar(dir, enc("<svg xmlns='http://www.w3.org/2000/svg'/>")), /SVG/);
  await assert.rejects(saveLocalAvatar(dir, gif(64, 64)), /PNG and JPG/);
  const j = await saveLocalAvatar(dir, jpeg(64, 64));
  assert.ok(j.file.endsWith(".jpg"));
  assert.equal(await pruneLocalAvatars(dir, new Set([r.ref.kind === "upload" ? r.ref.id : ""])), 1);
  assert.equal((await readdir(join(dir, "avatars"))).length, 1);
});

test("identicon: same address → same picture, mirrored; monogram letters", () => {
  const a = identicon(A1), b = identicon(A1), c = identicon(A2);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (let y = 0; y < 5; y++) { assert.equal(a.cells[y * 5], a.cells[y * 5 + 4]); assert.equal(a.cells[y * 5 + 1], a.cells[y * 5 + 3]); }
  assert.equal(monogram("Early bird"), "EB");
  assert.equal(monogram("ansem"), "AN");
  assert.equal(monogram("  "), "?");
});
