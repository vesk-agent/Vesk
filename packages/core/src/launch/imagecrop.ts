/**
 * v26: the post's picture as a coin image: its size read from the file header (PNG, JPEG, GIF, WebP), a minimum-size
 * check, and a square crop around a focal guess (the stretch of the long side with the most detail, nudged towards the
 * centre). Also the image hashes the clash check compares (SHA-256 of the file; a 64-bit difference hash of a PNG). The crop is a small PNG decoder / encoder on the platform's own deflate streams
 * (CompressionStream, in Node 22 and Deno), so the agent and the hosted backend share it with no image library.
 *
 * X's media CDN serves a PNG of any post photo (`?format=png`), so a post photo is fetched as PNG and cropped here.
 * Anything that can't be decoded (an interlaced or 16-bit PNG, a JPEG from elsewhere) is uploaded uncropped; pump.fun
 * shows coin images centred in a square, and the log says the crop was skipped.
 */

export interface ImageDims { width: number; height: number; type: "png" | "jpeg" | "gif" | "webp" }

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

/** Width and height from an image's header, or null when it isn't one we know. */
export function imageDims(b: Uint8Array): ImageDims | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "png", width: u32(b, 16), height: u32(b, 20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: "gif", width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return { type: "webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (kind === "VP8 ") return { type: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (kind === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { type: "webp", width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = u16be(b, o + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "jpeg", height: u16be(b, o + 5), width: u16be(b, o + 7) };
      o += 2 + len;
    }
  }
  return null;
}

/** The minimum-size check: the short side must be at least `min` px. Returns the refusal, or null. */
export function imageTooSmall(d: ImageDims | null, min: number): string | null {
  if (!d) return "the image's size couldn't be read";
  const s = Math.min(d.width, d.height);
  return s < min ? `the post image is ${d.width}×${d.height}, under the ${min} px minimum` : null;
}

/** X's CDN: the same photo as PNG (pbs.twimg.com/media/ID?format=png&name=large). Other URLs are returned unchanged. */
export function xPngVariant(url: string): string {
  const m = url.match(/^https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)(?:\.(?:jpg|jpeg|png|webp))?(?:\?.*)?$/);
  return m ? `https://pbs.twimg.com/media/${m[1]}?format=png&name=large` : url;
}

// ------------------------------------------------------------------------------------------------ PNG crop

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
async function pipe(data: Uint8Array, s: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(s as unknown as ReadableWritablePair<Uint8Array, Uint8Array>));
  return new Uint8Array(await out.arrayBuffer());
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parts: Uint8Array[]): number { let c = 0xffffffff; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(t, 4); out.set(data, 8); dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}
const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

interface Decoded { w: number; h: number; bpp: number; color: number; px: Uint8Array; keep: Array<{ type: string; data: Uint8Array }> }

/** Decode an 8-bit, non-interlaced PNG (grey, RGB, palette, grey+alpha, RGBA) to unfiltered rows; null for other kinds. */
export async function decodePng(png: Uint8Array): Promise<Decoded | null> {
  if (!SIG.every((v, i) => png[i] === v)) return null;
  let o = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  const keep: Array<{ type: string; data: Uint8Array }> = [];
  while (o + 8 <= png.length) {
    const len = u32(png, o), type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = u32(data, 0); h = u32(data, 4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE" || type === "tRNS" || type === "gAMA" || type === "sRGB" || type === "cHRM" || type === "iCCP") keep.push({ type, data });
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const bpp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!w || !h || depth !== 8 || !bpp || interlace) return null;
  const all = new Uint8Array(idat.reduce((a, c) => a + c.length, 0));
  { let p = 0; for (const c of idat) { all.set(c, p); p += c.length; } }
  const raw = await pipe(all, new DecompressionStream("deflate"));
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) return null;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      px[dst + x] = (v + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 0xff;
    }
  }
  return { w, h, bpp, color, px, keep };
}

/** Luminance of every pixel (palette images use their index, which is enough for detail and hashing). */
function luma(d: Decoded): Float32Array {
  const { w, h, bpp, px } = d;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * bpp;
    out[i] = bpp >= 3 ? 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2] : px[o];
  }
  return out;
}

/**
 * v26: where to put the square on the long side. Detail (the local contrast) is summed across the short side for each
 * position along the long side; the square goes where its window holds the most, with a gentle pull to the centre so
 * an even picture still crops centred. Returns the offset along the long side.
 */
export function focalOffset(lum: Float32Array, w: number, h: number): number {
  const s = Math.min(w, h), long = Math.max(w, h), span = long - s;
  if (span <= 0) return 0;
  const prof = new Float64Array(long);
  for (let y = 1; y < h; y++) for (let x = 1; x < w; x++) {
    const i = y * w + x;
    const g = Math.abs(lum[i] - lum[i - 1]) + Math.abs(lum[i] - lum[i - w]);
    prof[w >= h ? x : y] += g;
  }
  const centre = span >> 1;
  let win = 0;
  for (let i = 0; i < s; i++) win += prof[i];
  const wins = new Float64Array(span + 1);
  for (let o = 0; o <= span; o++) { if (o) win += prof[o + s - 1] - prof[o - 1]; wins[o] = win; }
  // ties (and an even picture) stay centred: a window must beat the centre's by more than rounding
  let at = centre, best = wins[centre];
  for (let o = 0; o <= span; o++) {
    const score = wins[o] * (1 - 0.25 * Math.abs(o - centre) / (centre || 1));
    if (score > best * (1 + 1e-6) + 1e-9) { best = score; at = o; }
  }
  return at;
}

/**
 * v26: a 64-bit difference hash (hex) of a decoded image: the luminance shrunk to 9×8, each bit one pixel brighter than
 * its right neighbour. Near-identical pictures (re-saved, resized) differ in a few bits.
 */
export function dHashOf(lum: Float32Array, w: number, h: number): string {
  const W = 9, H = 8, cells = new Float64Array(W * H), n = new Float64Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = Math.min(H - 1, Math.floor((y * H) / h)) * W + Math.min(W - 1, Math.floor((x * W) / w)); cells[c] += lum[y * w + x]; n[c]++; }
  let bits = "";
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) bits += cells[y * W + x] / (n[y * W + x] || 1) > cells[y * W + x + 1] / (n[y * W + x + 1] || 1) ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
/** Bits that differ between two hex hashes of the same length. */
export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d + Math.abs(a.length - b.length) * 4;
}

/** v26: the hashes the clash check compares: SHA-256 of the file always, a difference hash when it is a PNG we can decode. */
export async function imageHashes(bytes: Uint8Array): Promise<{ sha256: string; dhash?: string }> {
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const sha256 = [...sha].map((b) => b.toString(16).padStart(2, "0")).join("");
  const d = await decodePng(bytes).catch(() => null);
  return d ? { sha256, dhash: dHashOf(luma(d), d.w, d.h) } : { sha256 };
}

/**
 * Crop a PNG to a square around its focal guess (centred with `focal: false`). 8-bit greyscale, RGB, palette,
 * grey+alpha and RGBA, not interlaced. Returns null when the PNG is one of the other kinds (the caller uploads it as it is).
 */
export async function cropPngSquare(png: Uint8Array, o: { focal?: boolean } = {}): Promise<Uint8Array | null> {
  const d = await decodePng(png);
  if (!d) return null;
  const { w, h, bpp, color, px, keep } = d;
  if (w === h) return png;
  const stride = w * bpp;
  const off = o.focal === false ? (Math.max(w, h) - Math.min(w, h)) >> 1 : focalOffset(luma(d), w, h);
  const s = Math.min(w, h), x0 = w > h ? off : 0, y0 = h > w ? off : 0;
  const out = new Uint8Array(s * (s * bpp + 1));
  for (let y = 0; y < s; y++) { out[y * (s * bpp + 1)] = 0; out.set(px.subarray((y0 + y) * stride + x0 * bpp, (y0 + y) * stride + (x0 + s) * bpp), y * (s * bpp + 1) + 1); }
  const z = await pipe(out, new CompressionStream("deflate"));
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, s); dv.setUint32(4, s); ihdr[8] = 8; ihdr[9] = color; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array(SIG), chunk("IHDR", ihdr), ...keep.map((k) => chunk(k.type, k.data)), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const res = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  { let p = 0; for (const c of parts) { res.set(c, p); p += c.length; } }
  return res;
}

/**
 * The post photo as the coin image: the size check first, then the square crop when asked. `note` says what happened
 * (for the log and the launch's steps).
 */
export async function prepareCoinImage(img: { bytes: Uint8Array; mime: string; filename: string }, o: { crop: boolean; minPx: number; focal?: boolean }): Promise<{ ok: true; image: typeof img; note: string } | { ok: false; reason: string }> {
  const d = imageDims(img.bytes);
  const small = imageTooSmall(d, o.minPx);
  if (small) return { ok: false, reason: small };
  if (!o.crop || (d && d.width === d.height)) return { ok: true, image: img, note: `${d!.width}×${d!.height}` };
  if (d?.type === "png") {
    const c = await cropPngSquare(img.bytes, { focal: o.focal !== false }).catch(() => null);
    if (c) { const s = Math.min(d.width, d.height); return { ok: true, image: { bytes: c, mime: "image/png", filename: "post-square.png" }, note: `cropped to ${s}×${s} from ${d.width}×${d.height}${o.focal !== false ? " around the detail" : ""}` }; }
  }
  return { ok: true, image: img, note: `${d!.width}×${d!.height}, not cropped (${d!.type === "png" ? "PNG kind not supported" : d!.type.toUpperCase()}); pump.fun shows it centred` };
}
