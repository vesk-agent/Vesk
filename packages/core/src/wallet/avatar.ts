/**
 * Wallet images for the address book. Pure functions shared by the panel, the edge function and the agent:
 *
 * - AvatarRef: what a book entry stores. Either an uploaded image (an id; the files are a 64 px and a 128 px square
 *   the panel re-encoded through a canvas) or a generated avatar (monogram or pattern, from a seed).
 * - Byte checks: what type a file really is (from its first bytes, never the name or the browser's MIME type), its
 *   pixel size from the header, and the rules for an upload (PNG / JPEG / WebP / GIF, at most 512 KB, never SVG) and
 *   for a stored file (WebP or PNG, exactly 64 or 128 px square, at most 64 KB).
 * - Metadata stripping for PNG and JPEG (the agent can't re-encode images, so `vesk book avatar` keeps only the
 *   chunks / segments needed to draw the picture).
 * - The identicon every unlabelled wallet gets: deterministic from the address.
 */

export type AvatarRef = { kind: "upload"; id: string } | { kind: "gen"; style: GenStyle; seed: number };
export const GEN_STYLES = ["monogram", "rings", "grid", "stripes"] as const;
export type GenStyle = (typeof GEN_STYLES)[number];
export const GEN_SEEDS = 8;

export const UPLOAD_MAX_BYTES = 512 * 1024;
export const STORED_MAX_BYTES = 64 * 1024;
export const AVATAR_SIZES = [64, 128] as const;
export type ImageType = "png" | "jpeg" | "webp" | "gif" | "svg";
export const UPLOAD_TYPES: readonly ImageType[] = ["png", "jpeg", "webp", "gif"];

export const isAvatarId = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{16,32}$/.test(s);

export function validAvatar(a: unknown): a is AvatarRef {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  if (r.kind === "upload") return isAvatarId(r.id);
  if (r.kind === "gen") return (GEN_STYLES as readonly string[]).includes(String(r.style)) && Number.isInteger(r.seed) && (r.seed as number) >= 0 && (r.seed as number) < GEN_SEEDS;
  return false;
}

/** "upload:<id>" or "gen:<style>:<seed>", for CSV. */
export const avatarToString = (a: AvatarRef | undefined): string => (!a ? "" : a.kind === "upload" ? `upload:${a.id}` : `gen:${a.style}:${a.seed}`);
export function avatarFromString(s: string | undefined): AvatarRef | undefined {
  const t = (s ?? "").trim();
  if (!t) return undefined;
  const [k, a, b] = t.split(":");
  const r: unknown = k === "upload" ? { kind: "upload", id: a } : k === "gen" ? { kind: "gen", style: a, seed: Number(b) } : null;
  return validAvatar(r) ? r : undefined;
}

/** Storage path of an uploaded image: one folder per account, so the bucket's RLS can match the folder to the user. */
export const avatarPath = (account: string, id: string, size: 64 | 128, ext: "webp" | "png" = "webp") => `${account}/${id}-${size}.${ext}`;

// ---------------------------------------------------------------- bytes

const at = (b: Uint8Array, i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/** The file type from its first bytes. SVG is detected so it can be refused (it's markup, not a picture). */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && at(b, 1, "PNG\r\n\x1a\n")) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && at(b, 0, "RIFF") && at(b, 8, "WEBP")) return "webp";
  if (b.length >= 6 && (at(b, 0, "GIF87a") || at(b, 0, "GIF89a"))) return "gif";
  const head = new TextDecoder().decode(b.subarray(0, 512)).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) || head.startsWith("<!doctype svg")) return "svg";
  return null;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/** Width and height from the header (PNG IHDR, JPEG SOF, WebP VP8 / VP8L / VP8X, GIF screen). null if unreadable. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const t = sniffImage(b);
  if (t === "png" && b.length >= 24 && at(b, 12, "IHDR")) return { w: u32be(b, 16), h: u32be(b, 20) };
  if (t === "gif" && b.length >= 10) return { w: u16le(b, 6), h: u16le(b, 8) };
  if (t === "webp" && b.length >= 30) {
    if (at(b, 12, "VP8X")) return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
    if (at(b, 12, "VP8L") && b[20] === 0x2f) { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
    if (at(b, 12, "VP8 ")) return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    return null;
  }
  if (t === "jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      const len = u16be(b, i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16be(b, i + 7), h: u16be(b, i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** An upload, before the panel crops and re-encodes it. */
export function checkUpload(b: Uint8Array): { ok: true; type: ImageType } | { ok: false; reason: string } {
  if (b.length > UPLOAD_MAX_BYTES) return { ok: false, reason: `That image is ${Math.ceil(b.length / 1024)} KB; the limit is 512 KB.` };
  const t = sniffImage(b);
  if (t === "svg") return { ok: false, reason: "SVG files aren't accepted (they can carry scripts). Use PNG, JPG, WebP or GIF." };
  if (!t) return { ok: false, reason: "That isn't a PNG, JPG, WebP or GIF image." };
  const s = imageSize(b);
  if (!s || s.w < 16 || s.h < 16 || s.w > 8192 || s.h > 8192) return { ok: false, reason: "That image's size can't be read, or it's under 16 px or over 8192 px." };
  return { ok: true, type: t };
}

/** A file the server stores: re-encoded by the panel's canvas to a WebP (or PNG) square of exactly `size` px. */
export function checkStored(b: Uint8Array, size: 64 | 128): { ok: true; type: "webp" | "png" } | { ok: false; reason: string } {
  if (b.length > STORED_MAX_BYTES) return { ok: false, reason: `The ${size} px image is over 64 KB.` };
  const t = sniffImage(b);
  if (t !== "webp" && t !== "png") return { ok: false, reason: `The ${size} px image must be WebP or PNG.` };
  const s = imageSize(b);
  if (!s || s.w !== size || s.h !== size) return { ok: false, reason: `The ${size} px image is ${s ? `${s.w}×${s.h}` : "unreadable"}.` };
  return { ok: true, type: t };
}

const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "gAMA", "sRGB"]);
/** PNG with only the chunks needed to draw it (drops tEXt / iTXt / zTXt / eXIf / tIME / iCCP …). */
export function stripPng(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) break;
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return concat(out);
}

/** JPEG without APPn (EXIF, XMP, ICC, maker notes) and COM segments; JFIF (APP0) is kept. */
export function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1];
    if (m === 0xda) { out.push(b.subarray(i)); return concat(out); } // start of scan: the rest is image data
    const len = u16be(b, i + 2);
    const drop = (m >= 0xe1 && m <= 0xef) || m === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return concat(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let k = 0;
  for (const p of parts) { o.set(p, k); k += p.length; }
  return o;
}

// ---------------------------------------------------------------- identicon and generated avatars

/** FNV-1a over the string: a stable 32-bit number. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 5×5 mirrored grid and a hue from the address: the same wallet always gets the same picture. */
export function identicon(address: string): { cells: boolean[]; hue: number } {
  const h = hash32(address), h2 = hash32(address + "#");
  const cells: boolean[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const cx = x < 3 ? x : 4 - x; // mirror left-right
    cells.push(((cx * 5 + y) < 15 ? (h >>> (cx * 5 + y)) & 1 : (h2 >>> (cx * 5 + y - 15)) & 1) === 1);
  }
  if (!cells.some(Boolean)) cells[12] = true;
  return { cells, hue: h2 % 360 };
}

/** Up to two letters for a monogram: initials of the first two words, or the first two characters. */
export function monogram(label: string): string {
  const w = label.trim().split(/[\s._-]+/).filter(Boolean);
  if (!w.length) return "?";
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
}

/** Hue for a generated avatar's seed (8 calm hues, no pure green or red: those mean money). */
export const GEN_HUES = [192, 222, 258, 288, 318, 32, 48, 176];
