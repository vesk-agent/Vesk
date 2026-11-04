/**
 * Chat → copy rule draft: "copy @degen with 0.2 SOL, skip above 300k mcap, TP 2x 50%, SL 30%".
 * Deterministic (no model). The draft names a wallet by address or by the label of a wallet you already track;
 * nothing is saved until you confirm it.
 */
import { isPubkey } from "../base58.js";
import type { ExitSpec } from "../types.js";
import { describeProfile, effectiveProfile, usdShort, parseUsdAmount, type CopyConfig, type CopyOverrides, type CopyProfile, type CopyWallet } from "./settings.js";

export interface CopyDraft {
  /** A full address, when the message had one. */
  address?: string;
  /** "@degen" / "degen": the label of a tracked wallet (or the label for a new one when an address is given too). */
  label?: string;
  overrides: CopyOverrides;
}

export const COPY_REQUEST = /^\s*(?:please\s+)?(?:copy(?:[\s-]?trade)?|mirror|copytrade)\s+(?!that\b|this\b|it\b)/i;

export function parseCopyRequest(t: string, exitSpec: (t: string) => ExitSpec): { draft: CopyDraft; summary: string[]; assumptions: string[]; errors: Array<{ field: string; message: string }> } | null {
  if (!COPY_REQUEST.test(t)) return null;
  const body = t.replace(COPY_REQUEST, "");
  const errors: Array<{ field: string; message: string }> = [];
  const assumptions: string[] = [];
  const tokens = body.split(/[\s,]+/).filter(Boolean);
  const address = tokens.find((x) => isPubkey(x.replace(/[.;]$/, "")))?.replace(/[.;]$/, "");
  const at = /(?:^|\s)@([A-Za-z0-9_.-]{1,32})/.exec(body)?.[1];
  const named = /\b(?:as|label(?:led)?|call(?:ed)?(?:\s+it)?)\s+["']?([A-Za-z0-9_.-]{1,32})["']?/i.exec(body)?.[1];
  const first = !address && !at ? /^["']?([A-Za-z0-9_.-]{1,32})["']?(?:\s|,|$)/.exec(body)?.[1] : undefined;
  const label = named ?? at ?? (first && !/^(with|wallet|the|my)$/i.test(first) ? first : undefined);
  if (!address && !label) errors.push({ field: "wallet", message: "Name the wallet: its address, or @label of a wallet you track." });

  const o: CopyOverrides = {};
  const NUM = String.raw`(\d+(?:\.\d+)?)`;
  const pct = new RegExp(String.raw`\b${NUM}\s*%\s*of\s+(?:their|its|his|her)\s+(?:buy|buys|size|amount)`, "i").exec(body);
  const mult = new RegExp(String.raw`\b${NUM}\s*x\s+(?:their|its|his|her)\s+(?:buy|buys|size|amount)`, "i").exec(body) ?? (/\bhalf\s+(?:their|its|his|her)\s+(?:buy|size|amount)/i.test(body) ? ["", "0.5"] : null) ?? (/\bsame\s+(?:size|amount)\b/i.test(body) ? ["", "1"] : null);
  const stripped = body.replace(new RegExp(String.raw`(?:liquidity[^,]*?|(?:max|cap|up\s+to|at\s+most|least|over|above|than|buys?)\s+)${NUM}\s*sol\b`, "gi"), " ");
  const fixed = new RegExp(String.raw`(?:with|for|using|size|spend|ape)\s+${NUM}\s*(?:sol|◎)\b`, "i").exec(body) ?? new RegExp(String.raw`\b${NUM}\s*(?:sol|◎)\b`, "i").exec(stripped);
  if (pct) o.amount = { mode: "pct", value: Number(pct[1]) };
  else if (mult) o.amount = { mode: "multiple", value: Number(mult[1]) };
  else if (fixed) o.amount = { mode: "fixed", value: Number(fixed[1]), maxSol: Math.max(Number(fixed[1]), 0.0001), minSol: Math.min(Number(fixed[1]), 0.01) };
  const capMax = new RegExp(String.raw`(?:max|cap|up\s+to|at\s+most)\s+${NUM}\s*sol\b`, "i").exec(body);
  if (capMax && o.amount && o.amount.mode !== "fixed") o.amount.maxSol = Number(capMax[1]);

  const f: NonNullable<CopyOverrides["filters"]> = {};
  const AMT = String.raw`\$?\s?(\d+(?:\.\d+)?\s?[kKmMbB]?)`;
  const above = new RegExp(String.raw`(?:skip|ignore|not)\s+(?:if\s+)?(?:it'?s\s+)?(?:above|over|>)\s*${AMT}`, "i").exec(body)
    ?? new RegExp(String.raw`(?:under|below|<|max(?:imum)?)\s*${AMT}\s*(?:mc|mcap|market\s?cap)`, "i").exec(body)
    ?? new RegExp(String.raw`(?:mc|mcap|market\s?cap)\s*(?:under|below|<|max|up\s+to)\s*${AMT}`, "i").exec(body);
  if (above) f.maxMcapUsd = parseUsdAmount(above[1].replace(/\s/g, ""));
  // Blank out the phrase already read as the maximum, so "skip above 300k mcap" isn't read again as "above 300k mcap" (a minimum).
  const rest = above ? body.slice(0, above.index) + " ".repeat(above[0].length) + body.slice(above.index + above[0].length) : body;
  const below = new RegExp(String.raw`(?:skip|ignore)\s+(?:if\s+)?(?:it'?s\s+)?(?:below|under|<)\s*${AMT}`, "i").exec(rest) ?? new RegExp(String.raw`(?:min(?:imum)?|above|over)\s*${AMT}\s*(?:mc|mcap|market\s?cap)`, "i").exec(rest);
  if (below) f.minMcapUsd = parseUsdAmount(below[1].replace(/\s/g, ""));
  const liq = new RegExp(String.raw`liquidity\s*(?:of|above|over|at\s+least|>|≥)?\s*${NUM}\s*sol`, "i").exec(body) ?? new RegExp(String.raw`${NUM}\s*sol\s+(?:min\s+)?liquidity`, "i").exec(body);
  if (liq) f.minLiquiditySol = Number(liq[1]);
  const theirMin = new RegExp(String.raw`(?:if|when|only\s+if)\s+(?:they|it)\s+buy[s]?\s+(?:at\s+least|over|above|>)?\s*${NUM}\s*sol`, "i").exec(body);
  if (theirMin) f.minTargetBuySol = Number(theirMin[1]);
  const dev = /dev\s*(?:holds?|holding)?\s*(?:under|below|<|max|at\s+most)?\s*(\d{1,2}(?:\.\d+)?)\s*%/i.exec(body);
  if (dev) f.maxDevPct = Number(dev[1]);
  const top10 = /top\s*10\s*(?:under|below|<|max|at\s+most)?\s*(\d{1,2}(?:\.\d+)?)\s*%/i.exec(body);
  if (top10) f.maxTop10Pct = Number(top10[1]);
  if (/\bfirst\s+buys?\s+only\b|\bonly\s+(?:their\s+)?first\s+buy/i.test(body)) f.firstBuyOnly = true;
  if (/\bevery\s+buy\b|\badds?\s+too\b|\ball\s+(?:their\s+)?buys\b/i.test(body)) f.firstBuyOnly = false;
  if (/\bwith\s+socials\b|\bsocials\s+required\b/i.test(body)) f.requireSocials = ["x"];
  if (Object.keys(f).length) o.filters = f;

  if (/\b(?:auto(?:matically)?|auto[\s-]?copy|no\s+confirm)\b/i.test(body)) o.mode = "auto";
  else if (/\b(?:alert|notify|tell\s+me)\s*(?:only)?\b/i.test(body) && !/\bauto\b/i.test(body)) o.mode = "alert";
  else if (/\bconfirm\b|\bask\s+(?:me\s+)?first\b/i.test(body)) o.mode = "confirm";
  if (/\bsell\s+(?:all|everything)\s+when\s+they\s+sell\b/i.test(body)) o.sells = "all";
  else if (/\b(?:mirror|copy)\s+(?:their\s+)?sells?\b|\bsell\s+when\s+they\s+sell\b/i.test(body)) o.sells = "mirror";
  else if (/\b(?:don'?t|do\s+not|no)\s+(?:copy\s+)?sells?\b|\bbuys?\s+only\b/i.test(body)) o.sells = "off";
  const delay = /\bdelay\s*(?:of)?\s*(\d{1,5})\s*ms\b/i.exec(body);
  if (delay) o.delayMs = Number(delay[1]);
  const preset = /\b(p[123])\b/i.exec(body);
  if (preset) o.preset = preset[1].toLowerCase() as CopyProfile["preset"];
  const exit = exitSpec(body);
  if (Object.keys(exit).length) o.exit = exit;

  if (!o.amount) assumptions.push("No size given: your default copy size");
  if (!o.mode) assumptions.push("No mode given: your default mode");
  const who = address ? `${label ? `${label} ` : ""}(${address.slice(0, 4)}…${address.slice(-4)})` : `@${label ?? "?"}`;
  const summary = [`Copy ${who}`, ...summaryOf(o)];
  return { draft: { address, label, overrides: o }, summary, assumptions, errors };
}

function summaryOf(o: CopyOverrides): string[] {
  const s: string[] = [];
  if (o.mode) s.push(`Mode: ${o.mode === "auto" ? "Auto copy" : o.mode === "confirm" ? "Confirm each copy" : "Alert only"}`);
  if (o.amount) s.push(o.amount.mode === "fixed" ? `Buy ${o.amount.value} SOL per copy` : o.amount.mode === "pct" ? `Buy ${o.amount.value}% of their buy${o.amount.maxSol ? ` (max ${o.amount.maxSol} SOL)` : ""}` : `Buy ${o.amount.value}× their buy${o.amount.maxSol ? ` (max ${o.amount.maxSol} SOL)` : ""}`);
  const f = o.filters ?? {};
  if (f.maxMcapUsd != null) s.push(`Skip above ${usdShort(f.maxMcapUsd)} market cap (at their buy)`);
  if (f.minMcapUsd != null) s.push(`Skip below ${usdShort(f.minMcapUsd)} market cap`);
  if (f.minLiquiditySol !== undefined) s.push(`Liquidity at least ${f.minLiquiditySol} SOL`);
  if (f.minTargetBuySol !== undefined) s.push(`Only when they buy at least ${f.minTargetBuySol} SOL`);
  if (f.maxDevPct !== undefined) s.push(`Dev holds at most ${f.maxDevPct}%`);
  if (f.maxTop10Pct !== undefined) s.push(`Top 10 hold at most ${f.maxTop10Pct}%`);
  if (f.firstBuyOnly !== undefined) s.push(f.firstBuyOnly ? "First buy only" : "Copy every buy");
  if (o.sells) s.push(`Sells: ${o.sells === "off" ? "not copied" : o.sells === "mirror" ? "mirror their sell %" : "sell all when they sell"}`);
  for (const t of o.exit?.takeProfit ?? []) s.push(`Take profit: sell ${t.sellPct}% at ${t.atMultiple}x`);
  if (o.exit?.stopLossPct !== undefined) s.push(`Stop-loss at -${o.exit.stopLossPct}%`);
  if (o.exit?.trailingStopPct !== undefined) s.push(`Trailing stop ${o.exit.trailingStopPct}%`);
  if (o.delayMs !== undefined) s.push(`Delay ${o.delayMs} ms`);
  if (o.preset) s.push(`Preset ${o.preset.toUpperCase()}`);
  return s;
}

/** Resolve a draft against your tracked wallets: the wallet it changes (or adds) and the resulting profile. */
export function resolveCopyDraft(c: CopyConfig, d: CopyDraft): { wallet: Partial<CopyWallet> & { address: string }; isNew: boolean; profile: string[] } | { error: string } {
  const byLabel = d.label ? c.wallets.filter((w) => w.label.toLowerCase() === d.label!.toLowerCase()) : [];
  const existing = d.address ? c.wallets.find((w) => w.address === d.address) : byLabel[0];
  if (!d.address && !byLabel.length) return { error: `No tracked wallet labelled "${d.label}". Say it with the address: copy <address> as ${d.label ?? "name"} …` };
  if (!d.address && byLabel.length > 1) return { error: `${byLabel.length} wallets are labelled "${d.label}". Use the address.` };
  const address = d.address ?? existing!.address;
  const overrides = { ...(existing?.overrides ?? {}), ...d.overrides, ...(d.overrides.amount || existing?.overrides?.amount ? { amount: { ...(existing?.overrides?.amount ?? {}), ...(d.overrides.amount ?? {}) } } : {}), ...(d.overrides.filters || existing?.overrides?.filters ? { filters: { ...(existing?.overrides?.filters ?? {}), ...(d.overrides.filters ?? {}) } } : {}) };
  const wallet = { address, label: d.address && d.label ? d.label : existing?.label, overrides, enabled: true, template: "custom" as const };
  const p = effectiveProfile(c.defaults, wallet);
  const notes: string[] = [];
  if (p.amount.mode === "fixed" && p.amount.value > p.limits.maxSolPerTrade) notes.push(`Your copy max per trade is ${p.limits.maxSolPerTrade} SOL, so each copy is capped there. Raise it under Limits if you mean it.`);
  return { wallet, isNew: !existing, profile: [...describeProfile(p), ...notes] };
}
