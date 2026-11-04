/**
 * Contract-address (mint) detection in post text.
 *
 * Finds full Solana mint addresses in a post and in its links, and ignores look-alikes:
 *  - truncated addresses ("7xKX...pump", "7xKX…pump")
 *  - transaction signatures and other base58 runs longer than 44 characters
 *  - strings with non-base58 characters (0, O, I, l) or EVM addresses (0x…)
 *  - well-known program and system addresses (System, Token, wrapped SOL, pump.fun, …)
 *  - single-class strings ("aaaaaaaa…", "ABCDEFGH…") that happen to decode to 32 bytes
 *  - addresses hidden with zero-width characters are normalised first, so they ARE found
 *    (a watched account posting with invisible characters still means that address)
 *
 * A match only says "this string is a well-formed public key that was presented as a coin".
 * Before buying, the executor still verifies on-chain that the account is an SPL mint
 * (see `verifyMint` in trade/executor.ts).
 */
import { isPubkey } from "./base58.js";

export type CaSource = "text" | "url";
export interface CaMatch {
  mint: string;
  source: CaSource;
  /** Where in the normalised text it was found (text matches only). */
  index: number;
  /** 0..1. Raised by "CA:"/"mint"/"contract" labels and a "pump" suffix, lowered by "wallet"/"send"/"donate". */
  confidence: number;
  /** For URL matches: which site the link pointed to. */
  host?: string;
  /** dexscreener links point at a pair (pool), not a mint: the executor must resolve it first. */
  isPair?: boolean;
}

const B58 = "1-9A-HJ-NP-Za-km-z";
/** A base58 run bounded by non-base58 characters. Length is validated afterwards so we can reject long runs. */
const RUN = new RegExp(`(?<![${B58}])[${B58}]{32,}(?![${B58}])`, "g");

/** Accounts that are never a coin someone is announcing. */
export const IGNORED_ADDRESSES = new Set<string>([
  "11111111111111111111111111111111", // System program
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account program
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun program
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap AMM
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "ComputeBudget111111111111111111111111111111", // Compute budget
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // Metaplex metadata
]);

/** Hosts whose URL path carries a mint (or a pair) we can read. */
const URL_PATTERNS: Array<{ host: RegExp; path: RegExp; isPair?: boolean }> = [
  { host: /(^|\.)pump\.fun$/, path: /^\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/ },
  { host: /(^|\.)letsbonk\.fun$/, path: /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/ },
  { host: /(^|\.)bonk\.fun$/, path: /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/ },
  { host: /(^|\.)birdeye\.so$/, path: /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/ },
  { host: /(^|\.)solscan\.io$/, path: /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/ },
  { host: /(^|\.)jup\.ag$/, path: /^\/(?:swap|tokens)\/(?:SOL-)?([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#-]|$)/ },
  { host: /(^|\.)gmgn\.ai$/, path: /^\/sol\/token\/(?:[A-Za-z0-9]+_)?([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/ },
  { host: /(^|\.)dexscreener\.com$/, path: /^\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/, isPair: true },
];

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

/** Strip invisible characters that are sometimes inserted to dodge bots. */
export function normalizePostText(text: string): string {
  return text.normalize("NFC").replace(ZERO_WIDTH, "");
}

/** Mixed character classes: real keys almost always mix upper, lower and digits. */
function looksRandom(s: string): boolean {
  const classes = Number(/[A-Z]/.test(s)) + Number(/[a-z]/.test(s)) + Number(/[0-9]/.test(s));
  if (classes < 2) return false;
  // reject long single-character repeats like "1111111111111111" inside otherwise mixed strings
  return !/(.)\1{7,}/.test(s);
}

function contextConfidence(text: string, index: number, mint: string): number {
  const before = text.slice(Math.max(0, index - 24), index).toLowerCase();
  let c = 0.6;
  if (/\b(ca|contract|mint|token address|address)\b\s*[:=\-–>]*\s*$/.test(before)) c += 0.3;
  if (/(^|[\s$])\$?[a-z]{2,10}\s*[:\-–]\s*$/.test(before)) c += 0.05;
  if (mint.endsWith("pump") || mint.endsWith("bonk")) c += 0.1;
  if (/\b(wallet|send|donat\w*|tip|address for|pay)\b[^.]*$/.test(before)) c -= 0.35;
  return Math.max(0, Math.min(1, c));
}

/** Truncated forms like "7xKX...pump" or "7xKX…pump" are not addresses. */
function isTruncatedAt(text: string, index: number, length: number): boolean {
  const after = text.slice(index + length, index + length + 3);
  const before = text.slice(Math.max(0, index - 3), index);
  return /^(\.\.\.|…)/.test(after) || /(\.\.\.|…)$/.test(before);
}

export function detectInText(raw: string): CaMatch[] {
  const text = normalizePostText(raw);
  const out: CaMatch[] = [];
  for (const m of text.matchAll(RUN)) {
    const s = m[0];
    const index = m.index ?? 0;
    if (s.length > 44) continue; // signatures, hashes, concatenations
    if (isTruncatedAt(text, index, s.length)) continue;
    // URLs are handled by detectInUrls with their own context
    const lineStart = Math.max(text.lastIndexOf(" ", index), text.lastIndexOf("\n", index), text.lastIndexOf("\t", index)) + 1;
    if (/^https?:\/\//i.test(text.slice(lineStart, index)) || /\/\S*$/.test(text.slice(lineStart, index))) continue;
    if (IGNORED_ADDRESSES.has(s)) continue;
    if (!looksRandom(s)) continue;
    if (!isPubkey(s)) continue;
    out.push({ mint: s, source: "text", index, confidence: contextConfidence(text, index, s) });
  }
  return out;
}

export function detectInUrls(urls: string[]): CaMatch[] {
  const out: CaMatch[] = [];
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    for (const p of URL_PATTERNS) {
      if (!p.host.test(host)) continue;
      const m = url.pathname.match(p.path);
      if (!m) continue;
      const mint = m[1];
      if (IGNORED_ADDRESSES.has(mint) || !looksRandom(mint) || !isPubkey(mint)) continue;
      out.push({ mint, source: "url", index: -1, confidence: p.isPair ? 0.5 : 0.85, host, isPair: p.isPair });
    }
  }
  return out;
}

/** Inline URLs written in the text itself (when the platform did not expand them into entities). */
export function urlsInText(text: string): string[] {
  return [...normalizePostText(text).matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0]);
}

/**
 * All distinct mints in a post, text matches first, then URL matches.
 * Duplicates (same mint in text and link) are merged, keeping the highest confidence.
 */
export function detectMints(text: string, urls: string[] = []): CaMatch[] {
  const all = [...detectInText(text), ...detectInUrls([...urls, ...urlsInText(text)])];
  const best = new Map<string, CaMatch>();
  for (const m of all) {
    const prev = best.get(m.mint);
    if (!prev || m.confidence > prev.confidence) best.set(m.mint, prev ? { ...m, source: prev.source, index: prev.index } : m);
  }
  return [...best.values()];
}

/** Display helper: "7xKX…pump". */
export function shortMint(mint: string, head = 4, tail = 4): string {
  return mint.length <= head + tail + 1 ? mint : `${mint.slice(0, head)}…${mint.slice(-tail)}`;
}
