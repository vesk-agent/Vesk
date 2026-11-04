/**
 * v26: the ticker clash check. Before a launch-on-post coin is created, recent pump.fun creates (PumpPortal's
 * new-token stream, kept for a few minutes in a CreateFeed) are scanned for the same post link (in the coin's website or
 * X field), the same image (the post's picture: the same file by SHA-256, or a near-identical PNG by difference hash),
 * the same ticker, or the same name. What happens on a clash is the rule's choice: skip, rename the ticker, or launch
 * anyway. A post or image clash can't be fixed by a new ticker (it's the same post), so "rename" skips those.
 * Only what the stream saw counts: a create missed while it was disconnected isn't caught. Pure logic plus a small ring
 * buffer; no I/O.
 */
import { hamming } from "./imagecrop.js";

export type ClashAction = "skip" | "rename" | "launch";

/** v26: an image's hashes (launch/imagecrop.ts imageHashes). */
export interface ImageHash { sha256?: string; dhash?: string }

/** A create seen on the stream. `website` / `twitter` / `image` come from the metadata JSON (and its image) when they were read. */
export interface RecentCreate { mint: string; name: string; symbol: string; at: number; website?: string; twitter?: string; creator?: string; quoteMint?: string; /** the coin's image (from its metadata) and, once read, its hashes */ imageUrl?: string; image?: ImageHash }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Two images are the same: the same file, or difference hashes at most 6 bits apart. */
export const sameImage = (a?: ImageHash, b?: ImageHash) => !!a && !!b && ((!!a.sha256 && a.sha256 === b.sha256) || (!!a.dhash && !!b.dhash && hamming(a.dhash, b.dhash) <= 6));
/** The status id in an x.com / twitter.com post link, or null. */
export const statusId = (url?: string) => url?.match(/(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i)?.[1] ?? null;

/** Recent creates, newest last, trimmed to `windowMs` and `max`. */
export class CreateFeed {
  private list: RecentCreate[] = [];
  constructor(private windowMs = 30 * 60_000, private max = 5000) {}
  add(c: RecentCreate) {
    if (this.list.some((x) => x.mint === c.mint)) return this.update(c.mint, c);
    this.list.push(c);
    this.trim(c.at);
  }
  /** Fill in metadata read later (website / twitter from the uri JSON). */
  update(mint: string, p: Partial<RecentCreate>) {
    const x = this.list.find((y) => y.mint === mint);
    if (x) Object.assign(x, p);
  }
  private trim(now: number) {
    const cut = now - this.windowMs;
    while (this.list.length && (this.list[0].at < cut || this.list.length > this.max)) this.list.shift();
  }
  /** Creates between `from` and `to` (ms). */
  between(from: number, to = Number.MAX_SAFE_INTEGER): RecentCreate[] { return this.list.filter((c) => c.at >= from && c.at <= to); }
  all(): RecentCreate[] { return [...this.list]; }
  get size() { return this.list.length; }
}

export interface Clash { kind: "ticker" | "name" | "post" | "image"; matches: RecentCreate[] }

/** Same post link first (the strongest signal), then the same image, the same ticker, the same name. Null when clear. */
export function checkClash(token: { name: string; symbol: string }, postUrl: string, creates: RecentCreate[], image?: ImageHash | null): Clash | null {
  const id = statusId(postUrl);
  const post = id ? creates.filter((c) => statusId(c.website) === id || statusId(c.twitter) === id) : [];
  if (post.length) return { kind: "post", matches: post };
  const img = image ? creates.filter((c) => sameImage(image, c.image)) : [];
  if (img.length) return { kind: "image", matches: img };
  const sym = creates.filter((c) => norm(c.symbol) === norm(token.symbol));
  if (sym.length) return { kind: "ticker", matches: sym };
  const name = creates.filter((c) => norm(c.name) === norm(token.name));
  if (name.length) return { kind: "name", matches: name };
  return null;
}

/** A free ticker: FERRY → FERRY2, FERRY3… (kept within 10 characters). */
export function renameTicker(symbol: string, taken: Iterable<string>): string {
  const t = new Set([...taken].map(norm));
  for (let n = 2; n < 100; n++) {
    const suf = String(n);
    const s = symbol.slice(0, 10 - suf.length) + suf;
    if (!t.has(norm(s))) return s;
  }
  return symbol;
}

/**
 * Apply the rule's choice. A post-link clash can't be fixed by renaming (it's the same post), so "rename" skips it;
 * "launch" goes ahead either way and the clash is recorded.
 */
export function resolveClash(action: ClashAction, clash: Clash | null, token: { name: string; symbol: string }, creates: RecentCreate[]): { go: true; symbol: string; note?: string; renamedFrom?: string } | { go: false; reason: string } {
  if (!clash) return { go: true, symbol: token.symbol };
  const what = clash.kind === "post" ? "this post" : clash.kind === "image" ? "this image" : clash.kind === "ticker" ? `$${token.symbol}` : `"${token.name}"`;
  const first = clash.matches[0];
  const note = `${clash.matches.length} coin${clash.matches.length === 1 ? "" : "s"} for ${what} already launched (${first.name} $${first.symbol})`;
  if (action === "launch") return { go: true, symbol: token.symbol, note: `${note}; launching anyway` };
  if (action === "rename" && clash.kind !== "post" && clash.kind !== "image") {
    const s = renameTicker(token.symbol, creates.map((c) => c.symbol));
    return { go: true, symbol: s, renamedFrom: token.symbol, note: `${note}; renamed to $${s}` };
  }
  return { go: false, reason: `${note}; skipped` };
}
