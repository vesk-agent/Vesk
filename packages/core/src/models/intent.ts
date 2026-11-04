/**
 * Chat → rule, with a model. The deterministic parser runs first (fast, offline). If it doesn't
 * understand the message and a model is configured, the model is asked to fill the same JSON shape.
 * Guardrail refusals always win, and every result is validated and shown to the user to confirm.
 */
import { parseLaunchRequest, validateToken } from "../launch/plan.js";
import { forbiddenIntent } from "../guardrails.js";
import { describeRule, parseIntent, REFUSAL, type ParseResult } from "../rules/parse.js";
import { defaultRule, validateRule } from "../rules/validate.js";
import type { Rule } from "../types.js";
import type { ModelClient } from "./providers.js";
import { BRAND } from "../brand.js";

export const RULE_SYSTEM_PROMPT = `You turn a trader's message into ONE ${BRAND.name} rule as JSON. Reply with JSON only.
Shape: {"name": string, "trigger": {"kind":"x-post","handles":[string],"mode":"ca-in-post"|"keyword-link","keywords"?:[string]}
 | {"kind":"new-launch","launchpad":"pumpfun","filters":{"maxDevHoldingPct"?:number,"requireSocials"?:["x"|"telegram"|"website"],"minLiquiditySol"?:number,"maxMcapUsd"?:number,"blocklist"?:[string]}},
 "buy": {"amountSol": number, "maxMcapUsd"?: number, "slippageBps": number, "priorityFeeSol"?: number, "jitoTipSol"?: number, "venue": "auto"},
 "exit": {"takeProfit"?: [{"atMultiple": number, "sellPct": number}], "stopLossPct"?: number, "trailingStopPct"?: number, "timeoutMin"?: number},
 "maxBuysPerDay": number}
If the message asks for wash trading, volume bots, fake engagement, sockpuppets, impersonation, multi-wallet or coordinated buying, reply {"refuse": "<short reason>"}.
If it is not about a trading rule, reply {"unknown": true}.`;

export const LAUNCH_SYSTEM_PROMPT = `You help a creator fill in a memecoin launch form. Reply with JSON only:
{"name": string (2-32 chars), "symbol": string (2-10 letters/digits, no $), "description": string (under 280 chars, plain, no price talk)}
Use what the user said; only invent what is missing. Never copy an existing project's name or ticker, never promise returns or price moves,
never mention other people's accounts. If the request is for anything deceptive (fake volume, hidden wallets, impersonation), reply {"refuse": true}.`;

/** Fills missing name / ticker / description in a launch draft with the model. Everything is still shown for review. */
async function completeLaunch(r: Extract<ParseResult, { kind: "launch" }>, text: string, model: ModelClient): Promise<ParseResult> {
  const d = r.draft;
  if (d.name && d.symbol && d.description) return r;
  try {
    const raw = await model.chat([{ role: "system", content: LAUNCH_SYSTEM_PROMPT }, { role: "user", content: text }], { json: true, maxTokens: 300, temperature: 0.7 });
    const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as { name?: string; symbol?: string; description?: string; refuse?: boolean };
    if (j.refuse) return { kind: "refuse", reason: REFUSAL };
    const next = { ...d, name: d.name ?? j.name?.slice(0, 32), symbol: d.symbol ?? j.symbol?.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase(), description: d.description ?? j.description?.slice(0, 280) };
    const errs = validateToken({ name: next.name, symbol: next.symbol, description: next.description });
    if (errs.some((e) => /^Refused/.test(e.message))) return { kind: "refuse", reason: REFUSAL };
    const filled = parseLaunchRequest(text);
    return { kind: "launch", draft: next, summary: [...(filled?.summary ?? r.summary).filter((l) => !l.startsWith("Token:")), `Token: ${next.name} $${next.symbol} (suggested, edit anything)`, ...(next.description ? [`Description: ${next.description}`] : [])] };
  } catch {
    return r;
  }
}

export async function parseWithModel(text: string, model: ModelClient | null): Promise<ParseResult> {
  const local = parseIntent(text);
  if (local.kind === "launch" && model) return completeLaunch(local, text, model);
  if (local.kind !== "unknown" || !model) return local;
  if (forbiddenIntent(text)) return parseIntent(text);
  let raw: string;
  try {
    raw = await model.chat([{ role: "system", content: RULE_SYSTEM_PROMPT }, { role: "user", content: text }], { json: true, maxTokens: 600, temperature: 0 });
  } catch (e) {
    return { kind: "unknown", hint: `Model error: ${(e as Error).message}` };
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as Record<string, unknown>;
  } catch {
    return { kind: "unknown", hint: "The model didn't return a rule. Try rephrasing." };
  }
  if (j.refuse) return { kind: "refuse", reason: REFUSAL };
  if (j.unknown) return local;
  const draft: Rule = defaultRule({ ...(j as Partial<Rule>), enabled: false });
  return { kind: "rule", draft, summary: describeRule(draft), assumptions: ["Drafted by your model. Check every line before confirming."], errors: validateRule(draft) };
}
