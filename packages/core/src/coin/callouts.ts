/**
 * Callouts: a short plain-text note a holder posts on a coin's page. It shows as a marker on the chart (with the
 * text and author on hover) and in the Callouts tab.
 *
 *  - Only holders: the author's wallets (the hosted wallet and wallets linked by a signed message) must hold at
 *    least `minHoldUsd` of the coin when they post. The server reads the balances; the panel never decides.
 *  - Plain text, short, no links and no contract addresses (callouts are not a way to shill another coin or send
 *    people to a phishing page).
 *  - Rate-limited per author per coin, per author overall, and per coin.
 *  - Anyone signed in can flag one; at `hideAtFlags` distinct flags it's hidden. Authors can't flag their own.
 * Pure: the edge function and the agent's tests use these.
 */
export interface CalloutRules {
  minHoldUsd: number;
  maxLen: number;
  /** One callout per author per coin in this window. */
  perCoinCooldownMs: number;
  /** At most this many callouts per author per hour, across coins. */
  perAuthorPerHour: number;
  /** At most this many callouts per coin per hour (all authors). */
  perCoinPerHour: number;
  hideAtFlags: number;
}
export const CALLOUT_RULES: CalloutRules = { minHoldUsd: 100, maxLen: 140, perCoinCooldownMs: 10 * 60_000, perAuthorPerHour: 6, perCoinPerHour: 30, hideAtFlags: 3 };

export interface Callout {
  id: string;
  mint: string;
  /** Account id of the author (server side) and the wallet shown as the author. */
  author: string;
  wallet: string;
  handle?: string;
  text: string;
  at: number;
  /** Market cap (USD) when posted, and how much the author held (USD). */
  mcapUsd?: number;
  holdUsd: number;
  flags: string[];
  hidden?: boolean;
}

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|fun|app|net|org|gg|me|so|co|ai|lol|site|link)\b|t\.me\/|discord\.(gg|com)|bit\.ly)/i;
const ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
// control characters and zero-width / bidi marks (they can hide or reorder text)
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g;

export type CalloutTextResult = { ok: true; text: string } | { ok: false; error: string };
/** Clean and check callout text: plain, short, no links or addresses. */
export function cleanCalloutText(raw: unknown, rules: CalloutRules = CALLOUT_RULES): CalloutTextResult {
  if (typeof raw !== "string") return { ok: false, error: "Write something first." };
  const text = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "Write something first." };
  if (text.length > rules.maxLen) return { ok: false, error: `Keep it under ${rules.maxLen} characters (${text.length} now).` };
  if (LINK.test(text)) return { ok: false, error: "Links aren't allowed in callouts." };
  if (ADDRESS.test(text)) return { ok: false, error: "Contract addresses and wallets aren't allowed in callouts." };
  return { ok: true, text };
}

export interface HolderCheck { ok: boolean; holdUsd: number; needUsd: number; reason?: string }
/**
 * Does the author hold enough? `tokens` is the sum over their wallets, `priceUsd` the coin's price now.
 * Unknown price = refused (we never guess).
 */
export function holderCheck(tokens: number, priceUsd: number | undefined, rules: Pick<CalloutRules, "minHoldUsd"> = CALLOUT_RULES): HolderCheck {
  const needUsd = rules.minHoldUsd;
  if (!(priceUsd !== undefined && priceUsd > 0)) return { ok: false, holdUsd: 0, needUsd, reason: "Couldn't read the coin's price, so holdings can't be checked. Try again in a moment." };
  const holdUsd = Math.max(0, tokens) * priceUsd;
  if (holdUsd + 1e-9 < needUsd) return { ok: false, holdUsd, needUsd, reason: `Callouts need at least $${needUsd} of this coin in your wallets. You hold $${holdUsd.toFixed(2)}.` };
  return { ok: true, holdUsd, needUsd };
}

export interface RateCheck { ok: boolean; retryInMs?: number; reason?: string }
/** Rate limits over the recent callouts (any order). */
export function rateCheck(recent: Array<Pick<Callout, "author" | "mint" | "at">>, author: string, mint: string, now = Date.now(), rules: CalloutRules = CALLOUT_RULES): RateCheck {
  const hour = now - 3_600_000;
  const mine = recent.filter((c) => c.author === author);
  const sameCoin = mine.filter((c) => c.mint === mint && c.at > now - rules.perCoinCooldownMs).sort((a, b) => b.at - a.at)[0];
  if (sameCoin) {
    const retryInMs = sameCoin.at + rules.perCoinCooldownMs - now;
    return { ok: false, retryInMs, reason: `One callout per coin every ${Math.round(rules.perCoinCooldownMs / 60_000)} minutes. Try again in ${Math.ceil(retryInMs / 60_000)} min.` };
  }
  if (mine.filter((c) => c.at > hour).length >= rules.perAuthorPerHour) return { ok: false, reason: `At most ${rules.perAuthorPerHour} callouts an hour.` };
  if (recent.filter((c) => c.mint === mint && c.at > hour).length >= rules.perCoinPerHour) return { ok: false, reason: "This coin has had a lot of callouts in the last hour. Try again later." };
  return { ok: true };
}

/** Flag a callout. Each flagger counts once; authors can't flag their own; enough flags hide it. */
export function flagCallout(c: Callout, flagger: string, rules: Pick<CalloutRules, "hideAtFlags"> = CALLOUT_RULES): Callout {
  if (flagger === c.author || c.flags.includes(flagger)) return c;
  const flags = [...c.flags, flagger];
  return { ...c, flags, hidden: c.hidden || flags.length >= rules.hideAtFlags };
}

/** What the page shows: not hidden, newest first. Flaggers' ids are never sent to the page. */
export function visibleCallouts(list: Callout[], limit = 100): Array<Omit<Callout, "flags" | "author"> & { flagCount: number }> {
  return list.filter((c) => !c.hidden).sort((a, b) => b.at - a.at).slice(0, limit)
    .map(({ flags, author: _author, ...c }) => ({ ...c, flagCount: flags.length }));
}
