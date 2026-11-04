/** vesk rules | snipe | watch | chat */
import { claim } from "./claim.js";
import { pairs as listPairs, races as listRaces, ruleBacktest, ruleStatsCmd, ruleTemplates } from "./launchpost.js";
import { burn, lock } from "./supply.js";
import { createInterface } from "node:readline";
import {
  activeHandles, allRules, applyTemplate, findPair, isPresetId, LAUNCH_TEMPLATES, normalizeLaunchRule, defaultLaunchRule, defaultRule, describeLaunchRule, describeRule, parseAmount, parseSellLadder, parseUsd, RuleStore, setHandleOn, validateLaunchRule, normalizeCopyConfig, resolveCopyDraft, upsertCopyWallet,
  type LaunchOnPostRule, type LaunchTemplateId, type ParseResult, type TakeProfitStep, type WatchEntry,
} from "@vesk-agent/core";
import { agent, config } from "../context.js";
import { bold, confirm, dim, down, fail, ice, json, table, up, warn } from "../ui.js";
import { applyStrategyChat, BRAND, validateStrategy } from "@vesk-agent/core";

async function store(flags: { config?: string }) {
  const c = await config(flags.config);
  return { c, s: await new RuleStore(c.dataDir).load() };
}

/** "3x:50,5x:100" → steps */
export function parseTp(s?: string): TakeProfitStep[] | undefined {
  if (!s) return undefined;
  return s.split(",").map((p) => {
    const [x, pct] = p.split(":");
    return { atMultiple: Number(x.replace(/x$/i, "")), sellPct: Number(pct ?? 100) };
  });
}

function show(r: ParseResult) {
  if (r.kind === "refuse") return console.log(`  ${r.reason}`);
  if (r.kind === "unknown") return console.log(dim(r.hint));
  console.log(bold(`\n  ${BRAND.name} understood:`));
  for (const l of r.summary) console.log(`  ${ice("·")} ${l}`);
  if (r.kind === "launch-rule") for (const e of r.errors) console.log(`  ${down("· " + e.field + ": " + e.message)}`);
  if (r.kind === "rule" || r.kind === "copy") {
    for (const a of r.assumptions) console.log(`  ${dim("· " + a)}`);
    for (const e of r.errors) console.log(`  ${down("· " + e.field + ": " + e.message)}`);
  }
}

export async function rules(args: string[], flags: Record<string, string | boolean | undefined>) {
  const [sub, ...rest] = args;
  const { c, s } = await store(flags as { config?: string });
  if (!sub || sub === "list") {
    const all = [...allRules(c), ...s.data.rules, ...allRules({ ...c, rules: [], watchlist: s.data.watchlist })];
    if (json({ rules: all, launchRules: s.data.launchRules ?? [] })) return;
    table(all.map((r) => ({ id: r.id, on: r.enabled ? up("on") : dim("off"), name: r.name, size: `${r.buy.amountSol} SOL`, "max/day": r.maxBuysPerDay })));
    const lr = s.data.launchRules ?? [];
    if (lr.length) {
      console.log(`\n  ${bold("Launch on post")}`);
      table(lr.map((r) => ({ id: r.id, on: r.enabled ? up("on") : dim("off"), accounts: r.trigger.handles.map((h) => (r.trigger.off ?? []).includes(h.toLowerCase()) ? dim("@" + h + " (off)") : "@" + h).join(" "), dev: `${r.plan.devBuySol} SOL`, mode: r.mode, "max/day": r.limits.maxPerDay })));
    }
    return;
  }
  if (sub === "show") {
    const l = (s.data.launchRules ?? []).find((x) => x.id === rest[0]);
    if (l) return void describeLaunchRule(l).forEach((x) => console.log(`  ${ice("·")} ${x}`));
    const r = [...allRules(c), ...s.data.rules].find((x) => x.id === rest[0]);
    if (!r) fail(`No rule ${rest[0]}`);
    for (const l of describeRule(r)) console.log(`  ${ice("·")} ${l}`);
    return;
  }
  if (sub === "account") {
    // vesk rules account <rule-id> @handle on|off   (switch one watched account without removing it)
    const [id, handle, state] = rest;
    const l = (s.data.launchRules ?? []).find((x) => x.id === id);
    if (!l || !handle || !/^(on|off)$/.test(state ?? "")) fail("Usage: vesk rules account <launch-rule-id> @handle on|off");
    const h = handle.replace(/^@/, "");
    if (!l.trigger.handles.some((x) => x.toLowerCase() === h.toLowerCase())) fail(`@${h} isn't in ${id}. Accounts: ${l.trigger.handles.map((x) => "@" + x).join(" ")}`);
    const next = setHandleOn(l, h, state === "on");
    const errs = validateLaunchRule(next);
    if (errs.length) fail(errs.map((e) => e.message).join("\n"));
    await s.upsertLaunchRule(next);
    return console.log(`  @${h} ${state === "on" ? up("on") : dim("off")} in ${id}. Watching: ${activeHandles(next).map((x) => "@" + x).join(" ") || "none"}`);
  }
  if (sub === "backtest") return ruleBacktest(rest[0], flags);
  if (sub === "stats") return ruleStatsCmd(rest[0], flags);
  if (sub === "templates") return ruleTemplates();
  if (sub === "enable" || sub === "disable") return s.setEnabled(rest[0], sub === "enable").then(() => console.log(`${rest[0]} ${sub}d`));
  if (sub === "rm") return s.remove(rest[0]).then(() => console.log(`Removed ${rest[0]}`));
  if (sub === "add" && flags["launch-on-post"]) return addLaunchRule(s, String(flags["launch-on-post"]), rest, flags);
  if (sub === "add") {
    const a = await agent(flags as { config?: string });
    const r = await a.chat(rest.join(" "));
    show(r);
    if (r.kind === "launch-rule" && !r.errors.length && (flags.yes || (await confirm("\n  Save and turn this rule on?")))) {
      await s.upsertLaunchRule({ ...r.draft, enabled: true });
      return console.log(`  Saved as ${ice(r.draft.id)}.`);
    }
    if (r.kind !== "rule" || r.errors.length) return;
    if (flags.yes || (await confirm("\n  Save and turn this rule on?"))) {
      await s.upsert({ ...r.draft, enabled: true }, c.limits);
      console.log(`  Saved as ${ice(r.draft.id)}.`);
    }
    return;
  }
  fail("Usage: vesk rules [list|show <id>|add \"<plain English>\"|add --launch-on-post @handle ...|account <id> @handle on|off|backtest <id>|stats [<id>]|templates|enable <id>|disable <id>|rm <id>]");
}

/**
 * vesk rules add --launch-on-post @handle[,@other] [--dev-buy 0.5 | --manual] [--sell 50%@100k,100%@250k] [--stop 5k] [--timeout 720]
 *   [--auto | --confirm-ttl 120] [--keyword moon] [--any-post] [--min-likes 500] [--image post|generate|mine] [--default-image ./coin.png]
 *   [--naming model|template] [--name "{Word}"] [--ticker "{WORD}"] [--web url] [--tg url] [--x url]
 *   [--per-hour 2] [--per-day 5] [--max-sol 1] [--max-sol-day 3] [--cooldown 60] [--team-wallets N --team-sol 0.1]
 *   v26: [--template founder|breaking|memes|product|custom] [--exclude giveaway,airdrop] [--media any|image|video|image-or-video]
 *   [--cashtag require|forbid] [--ca forbid|any] [--lang en,es] [--velocity 500/60s[/120s]] [--hours 09:00-17:00,20:00-23:00]
 *   [--tz +2] [--allow-replies] [--allow-quotes] [--allow-reposts] [--naming model|template|ask] [--style short|literal|punny]
 *   [--pattern "\bv\d+\b"] [--exclude-pattern "giveaway|airdrop"] [--priority-hold 20] [--no-clash-image]
 *   [--no-crop] [--min-image 256] [--dev-buy-in sol|quote] [--watch-off @a,@b] [--groups Founders,News] [--website post|preset] [--pair NVDAx] [--creator-fee 0.25] [--fees creator|holders|cashback|split]
 *   [--split <addr>:60,<addr>:40] [--clash skip|rename|launch] [--clash-window 120] [--race-window 10] [--max-open 3]
 */
async function addLaunchRule(s: RuleStore, handlesArg: string, _rest: string[], f: Record<string, string | boolean | undefined>) {
  const handles = handlesArg.split(",").map((h) => h.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
  const num = (k: string) => (f[k] !== undefined ? Number(f[k]) : undefined);
  const base = defaultLaunchRule({ name: `Launch on ${handles.map((h) => "@" + h).join(", ")} posts` });
  const ladder = f.sell ? parseSellLadder(String(f.sell)) : null;
  if (f.sell && !ladder) fail('--sell looks like "50%@100k,100%@250k".');
  const after = f["sell-after"] ? String(f["sell-after"]).split(",").map((x) => { const [sec, pct] = x.split(":"); return { afterSec: Number(sec.replace(/s$/, "")), sellPct: Number(pct ?? 100) }; }) : undefined;
  if (after?.some((t) => !(t.afterSec > 0) || !(t.sellPct > 0 && t.sellPct <= 100))) fail('--sell-after looks like "5:100" (seconds:percent), comma-separated for more.');
  if (f.preset) {
    const p = (s.data.presets ?? []).find((x) => x.id === f.preset);
    if (!p) fail(`No preset ${f.preset}. See \`vesk presets\`.`);
  }
  const manual = !!f.manual;
  const list = (k: string) => (f[k] ? String(f[k]).split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const vel = f.velocity ? String(f.velocity).match(/^(\d+)\/(\d+)s?(?:\/(\d+)s?)?$/) : null;
  if (f.velocity && !vel) fail('--velocity looks like "500/60s" (likes/seconds) or "500/60s/120s" (…/wait up to).');
  const nov = f["no-volume"] ? String(f["no-volume"]).match(/^(\d+(?:\.\d+)?)\/(\d+)s?$/) : null;
  if (f["no-volume"] && !nov) fail('--no-volume looks like "0.5/120s" (SOL / seconds): sell everything if less than 0.5 SOL trades in 120 s.');
  const hours = list("hours")?.map((x) => { const [from, to] = x.split("-"); return { from, to }; });
  const pairQ = f.pair ? findPair(String(f.pair)) : undefined;
  if (f.pair && !pairQ) fail(`--pair: ${f.pair} isn't in the pair list. \`vesk pairs\` lists them.`);
  const split = f.split ? String(f.split).split(",").map((x) => { const [address, pct] = x.split(":"); return { address: address.trim(), pct: Number(pct) }; }) : undefined;
  // v26: --split alone means "to you, split among these wallets"
  const fees = (["holders", "cashback", "split"].includes(String(f.fees)) ? f.fees : split ? "split" : "creator") as NonNullable<LaunchOnPostRule["pair"]>["fees"];
  if (f.style && !["short", "literal", "punny", "punchy", "meme", "playful", "deadpan"].includes(String(f.style))) fail("--style: short, literal or punny.");
  if (f.naming && !["model", "template", "ask", "post"].includes(String(f.naming))) fail("--naming: model, template or ask (Confirm mode: you name it on the draft card).");
  const r0: LaunchOnPostRule = {
    ...base,
    trigger: { handles, requireImage: !f["any-post"], keywords: f.keyword ? String(f.keyword).split(",") : undefined, minLikes: num("min-likes"), minViews: num("min-views") },
    coin: {
      ...base.coin, naming: f.naming === "template" ? "template" : "model", nameTemplate: (f.name as string) ?? base.coin.nameTemplate, tickerTemplate: (f.ticker as string) ?? base.coin.tickerTemplate,
      image: (["post", "generate", "mine"].includes(String(f.image)) ? f.image : "post") as LaunchOnPostRule["coin"]["image"], defaultImage: f["default-image"] as string | undefined,
      links: { website: f.web as string | undefined, telegram: f.tg as string | undefined, twitter: f.x as string | undefined },
    },
    plan: { ...base.plan, mode: manual ? "manual" : "standard", devBuySol: manual ? 0 : num("dev-buy") ?? base.plan.devBuySol, teamWallets: num("team-wallets") ?? 0, teamSolEach: num("team-sol") ?? base.plan.teamSolEach, jitoTipSol: num("jito") ?? base.plan.jitoTipSol },
    ...(f.preset ? { presetId: String(f.preset) } : {}),
    exit: { ...(ladder ? { mcapTargets: ladder } : base.exit), ...(after ? { timeSells: after } : {}), ...(f.stop ? { stopBelowMcapUsd: parseUsd(String(f.stop)) ?? undefined } : {}), ...(f.timeout ? { timeoutMin: Number(f.timeout) } : {}), ...(nov ? { noVolume: { minVolSol: Number(nov[1]), windowSec: Number(nov[2]) } } : {}), ...(num("trail") !== undefined ? { trailingStopPct: num("trail") } : {}), ...(num("sl") !== undefined ? { stopLossPct: num("sl") } : {}) },
    mode: f.auto ? "auto" : "confirm",
    confirmTtlSec: num("confirm-ttl") ?? base.confirmTtlSec,
    limits: { maxPerHour: num("per-hour") ?? base.limits.maxPerHour, maxPerDay: num("per-day") ?? base.limits.maxPerDay, maxSolPerLaunch: num("max-sol") ?? Math.max(base.limits.maxSolPerLaunch, num("dev-buy") ?? 0), maxSolPerDay: num("max-sol-day") ?? base.limits.maxSolPerDay, cooldownMin: num("cooldown") ?? base.limits.cooldownMin, ...(num("max-open") !== undefined ? { maxOpenCoins: num("max-open") } : {}) },
  };
  // v26: a template first, then every explicit flag on top
  const tpl = f.template === "blank" ? "custom" : f.template;
  const t = tpl ? applyTemplate(r0, String(tpl) as LaunchTemplateId) : r0;
  if (tpl && !LAUNCH_TEMPLATES.some((x) => x.id === tpl)) fail(`--template: one of ${LAUNCH_TEMPLATES.map((x) => x.id).join(", ")}.`);
  // v26: regular expressions can't be comma-split; repeat the flag or separate with " ;; "
  const pats = (k: string) => (f[k] ? String(f[k]).split(/\s;;\s/).map((x) => x.trim()).filter(Boolean) : undefined);
  const media = (f.media ?? (f["any-post"] ? "any" : undefined)) as LaunchOnPostRule["trigger"]["media"] | undefined;
  const r: LaunchOnPostRule = normalizeLaunchRule({
    ...t,
    trigger: {
      ...t.trigger,
      ...(f.keyword ? { keywords: list("keyword") } : {}), ...(f.exclude ? { exclude: list("exclude") } : {}),
      ...(media ? { media, requireImage: media === "image" } : {}),
      ...(f.cashtag ? { cashtag: f.cashtag as "require" | "forbid" } : {}), ...(f.ca ? { contract: (f.ca === "skip" ? "forbid" : f.ca === "allow" ? "any" : f.ca) as "require" | "forbid" | "any" } : {}),
      ...(f.lang ? { languages: list("lang") } : {}),
      ...(vel ? { velocity: { likes: Number(vel[1]), withinSec: Number(vel[2]), waitSec: Number(vel[3] ?? vel[2]) } } : {}),
      ...(hours ? { hours, tzOffsetMin: f.tz ? Math.round(Number(f.tz) * 60) : 0 } : {}),
      ignore: { replies: !f["allow-replies"], quotes: !f["allow-quotes"], reposts: !f["allow-reposts"] },
      ...(f["watch-off"] ? { off: list("watch-off")!.map((h) => h.replace(/^@/, "").toLowerCase()) } : {}),
      ...(f.groups ? { groups: list("groups") } : {}),
      ...(f.pattern || f["exclude-pattern"] ? { patterns: { include: pats("pattern") ?? [], exclude: pats("exclude-pattern") ?? [] } } : {}),
      ...(num("priority-hold") !== undefined ? { priorityHoldSec: num("priority-hold") } : {}),
    },
    coin: {
      ...t.coin,
      ...(f.naming ? { naming: f.naming as LaunchOnPostRule["coin"]["naming"] } : {}),
      ...(f.style ? { style: f.style as LaunchOnPostRule["coin"]["style"] } : {}),
      ...(f["no-crop"] ? { crop: false } : {}), ...(f.website ? { websiteFrom: f.website === "preset" ? "preset" : "post" } : {}),
      ...(num("min-image") !== undefined ? { minImagePx: num("min-image") } : {}),
    },
    plan: { ...t.plan, ...(f["dev-buy-in"] ? { devBuyIn: String(f["dev-buy-in"]).toLowerCase() === "quote" ? "quote" as const : "SOL" as const } : {}) },
    ...(pairQ ? { pair: { quote: pairQ.id, fees, ...(pairQ.id !== "SOL" ? { creatorFeePct: num("creator-fee") ?? 0.05 } : {}), ...(split ? { split } : {}) } } : f.fees ? { pair: { quote: "SOL", fees } } : {}),
    clash: { action: (["skip", "rename", "launch"].includes(String(f.clash)) ? f.clash : "skip") as "skip" | "rename" | "launch", windowSec: num("clash-window") ?? 120, image: !f["no-clash-image"] },
    race: { windowMin: num("race-window") ?? 10 },
  });
  const errors = validateLaunchRule(r);
  console.log(bold("\n  Launch on post"));
  for (const l of describeLaunchRule(r)) console.log(`  ${ice("·")} ${l}`);
  if (errors.length) fail(errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
  console.log(warn("  Images from posts may be owned by someone else. You're responsible for what you launch."));
  if (r.mode === "auto") console.log(warn("  Auto mode launches without asking, inside the limits above. Try `vesk summon --paper` first."));
  if (f.yes || (await confirm("  Save and turn this rule on?"))) {
    await s.upsertLaunchRule({ ...r, enabled: true });
    console.log(`  Saved as ${ice(r.id)}. Drafts and launches show in \`vesk status\` and \`vesk pending\`.`);
  }
}

export async function snipe(args: string[], flags: Record<string, string | boolean | undefined>) {
  const { c, s } = await store({ config: flags.config as string | undefined });
  const amountSol = Number(flags.sol ?? 0.1);
  if (flags.launches) {
    const r = defaultRule({
      name: "New launch snipe", enabled: true,
      trigger: { kind: "new-launch", launchpad: "pumpfun", filters: {
        maxDevHoldingPct: flags["max-dev"] ? Number(flags["max-dev"]) : 5,
        requireSocials: flags.socials ? ["x", "telegram", "website"] : undefined,
        minLiquiditySol: flags["min-liq"] ? Number(flags["min-liq"]) : undefined,
        blocklist: typeof flags.block === "string" ? flags.block.split(",") : undefined,
        rugChecks: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxTop10Pct: 30 },
      } },
      buy: { amountSol, slippageBps: 1500, venue: "auto", ...(isPresetId(flags.preset) ? { preset: flags.preset } : {}) },
      exit: { takeProfit: parseTp(flags.tp as string) ?? [{ atMultiple: 2, sellPct: 50 }], stopLossPct: Number(flags.sl ?? 35) },
      maxBuysPerDay: Number(flags["per-day"] ?? 5),
    });
    await s.upsert(r, c.limits);
    for (const l of describeRule(r)) console.log(`  ${ice("·")} ${l}`);
    if (!c.launches.enabled) console.log(warn("  Set launches.enabled: true in your config so the agent watches new launches."));
    return;
  }
  const handle = args[0]?.replace(/^@/, "");
  if (!handle) fail("Usage: vesk snipe @handle --sol 0.25 [--max-mcap 50k] [--tp 3x:50] [--sl 30] [--per-day 3] [--keyword launch] | vesk snipe --launches --sol 0.1 [--max-dev 5] [--socials]");
  const w: WatchEntry = {
    handle, enabled: true,
    mode: flags.keyword ? "keyword-link" : "ca-in-post",
    keywords: typeof flags.keyword === "string" ? flags.keyword.split(",") : undefined,
    amountSol,
    maxMcapUsd: flags["max-mcap"] ? parseAmount(String(flags["max-mcap"])) ?? undefined : undefined,
    slippageBps: Math.round(Number(flags.slippage ?? 15) * 100),
    priorityFeeSol: flags.priority ? Number(flags.priority) : undefined,
    jitoTipSol: flags.jito ? Number(flags.jito) : undefined,
    takeProfit: parseTp(flags.tp as string) ?? [{ atMultiple: 2, sellPct: 50 }],
    stopLossPct: Number(flags.sl ?? 35),
    maxBuysPerDay: Number(flags["per-day"] ?? 3),
    ...(isPresetId(flags.preset) ? { preset: flags.preset } : {}),
  };
  await s.watch(w);
  console.log(`Watching ${ice("@" + handle)} · ${amountSol} SOL per buy · ${w.mode === "ca-in-post" ? "CA must be in the post" : `keyword ${w.keywords?.join("/")} + link`}`);
  if (c.x.source === "off") console.log(warn("X watching is off. Set x.source: official-api and `vesk keys set X_BEARER_TOKEN` (your own X developer token)."));
}

export async function watch(args: string[], flags: { config?: string }) {
  const [sub, h] = args;
  const { s } = await store(flags);
  if (sub === "rm" && h) return s.remove(`w_${h.replace(/^@/, "").toLowerCase()}`).then(() => console.log(`Stopped watching @${h.replace(/^@/, "")}`));
  if (sub === "add" && h) return snipe([h], flags);
  table(s.data.watchlist.map((w) => ({ handle: "@" + w.handle, on: w.enabled ? "on" : "off", mode: w.mode, size: `${w.amountSol} SOL`, "max mcap": w.maxMcapUsd ?? "-", "max/day": w.maxBuysPerDay })));
}

export async function chat(args: string[], flags: { config?: string; yes?: boolean }) {
  const a = await agent(flags);
  const handle = async (text: string) => {
    const r = await a.chat(text);
    show(r);
    if (r.kind === "rule" && !r.errors.length && (flags.yes || (await confirm("\n  Save and turn on?")))) {
      await a.store.upsert({ ...r.draft, enabled: true }, a.limits());
      console.log(`  Saved ${ice(r.draft.id)}.`);
    }
    if (r.kind === "launch-rule" && !r.errors.length && (flags.yes || (await confirm(`\n  Save and turn on (${r.draft.mode === "auto" ? "Auto" : "Confirm"} mode)?`)))) {
      await a.store.upsertLaunchRule({ ...r.draft, enabled: true });
      console.log(`  Saved ${ice(r.draft.id)}.`);
    }
    if (r.kind === "copy" && !r.errors.length) {
      const cfg = normalizeCopyConfig(a.store.data.copy);
      const res = resolveCopyDraft(cfg, r.draft);
      if ("error" in res) console.log(`  ${down("· " + res.error)}`);
      else {
        console.log(bold(`\n  ${res.isNew ? "New tracked wallet" : "Updated settings"}:`));
        for (const l of res.profile) console.log(`  ${ice("·")} ${l}`);
        console.log(dim("  Copies land after their transaction (same or next few slots). Guardrails and limits still apply."));
        if (flags.yes || (await confirm("\n  Save this copy rule?"))) {
          try {
            a.store.data.copy = upsertCopyWallet(cfg, res.wallet);
            await a.store.save();
            console.log(`  Saved. A running agent picks it up within 2 s.`);
          } catch (e) { console.log(`  ${down((e as Error).message)}`); }
        }
      }
    }
    if ((r.kind === "strategy" || r.kind === "rogue") && !r.errors.length) {
      // v19: Strategy & safety from chat. Rogue mode always asks; switching its can-sell check off asks twice.
      const res = applyStrategyChat(a.strategy(), r, a.limits());
      if (!res.ok) console.log(`  ${down("· " + res.error)}`);
      else {
        const offHoneypot = r.kind === "rogue" && r.start && !res.strategy.rogue.honeypot;
        if (offHoneypot) console.log(down("  The can-sell check would be OFF: fakes of a hyped launch are where honeypots live."));
        const q = r.kind === "rogue" ? (r.start ? "\n  Start Rogue mode?" : "\n  Turn Rogue mode off?") : "\n  Save these settings?";
        if ((r.kind === "strategy" && flags.yes) || ((await confirm(q)) && (!offHoneypot || (await confirm("  Really buy without the can-sell check?"))))) {
          const errs = validateStrategy(res.strategy, a.limits());
          if (errs.length) console.log(`  ${down("· " + errs[0].message)}`);
          else {
            a.store.data.strategy = res.strategy;
            if (res.limits) a.store.data.limits = { ...(a.store.data.limits ?? {}), ...res.limits };
            await a.store.save();
            for (const l of res.lines) console.log(`  ${ice("·")} ${l}`);
            console.log(dim("  Saved. A running agent picks it up within 2 s."));
          }
        }
      }
    }
    if ((r.kind === "strategy" || r.kind === "rogue") && r.errors.length) for (const e of r.errors) console.log(`  ${down("· " + e)}`);
    // v26: "backtest my launch rule", "race report for $X", "launch rule stats", "which stock pairs"
    if (r.kind === "launch-info") {
      if (r.ask === "backtest") await ruleBacktest(undefined, { yes: flags.yes }, a);
      if (r.ask === "stats") await ruleStatsCmd(undefined, { config: flags.config });
      if (r.ask === "race") await listRaces(r.symbol, { config: flags.config });
      if (r.ask === "pairs") await listPairs({ category: r.query });
    }
    // v23: "claim my fees": the same flow as `vesk claim` (groups by asset, asks before claiming)
    if (r.kind === "claim") await claim(r.symbol ? [r.symbol] : [], { all: r.all, yes: flags.yes }, a);
    // v25: "burn 10% of $DIAL" / "lock 20% of $DIAL for 90 days": the same flow as `vesk burn` / `vesk lock` (plan, then the confirm)
    if (r.kind === "burn") await burn([r.mint ?? `$${r.symbol}`, r.pct !== undefined ? `${r.pct}%` : String(r.tokens)], { yes: flags.yes }, a);
    if (r.kind === "lock") await lock([r.mint ?? `$${r.symbol}`, r.pct !== undefined ? `${r.pct}%` : String(r.tokens)], { days: String(r.days ?? 90) }, a);
    if (r.kind === "trade") console.log(dim(`  Run: vesk ${r.action} ${r.mint} ${r.action === "buy" ? r.amountSol : r.sellPct + "%"}`));
    if (r.kind === "control") console.log(dim(`  Run: vesk ${r.action === "kill" ? "kill on" : r.action}`));
    if (r.kind === "launch") {
      const d = r.draft;
      const q = (v?: string) => (v ? JSON.stringify(v) : "<…>");
      console.log(dim(`  Run: vesk launch --name ${q(d.name)} --ticker ${d.symbol ?? "<TICKER>"} --image ./coin.png --mode ${d.mode ?? "standard"}` +
        (d.mode !== "manual" ? ` --dev-buy ${d.devBuySol ?? 0}` : "") + (d.teamWallets ? ` --team-wallets ${d.teamWallets} --team-sol 0.1` : "") + (d.description ? ` --desc ${q(d.description)}` : "")));
    }
  };
  if (args.length) return handle(args.join(" "));
  console.log(dim('Talk to your agent. Try "snipe anything @handle posts under 50k mcap with 0.5 SOL". Ctrl-D to exit.'));
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: ice("vesk › ") });
  rl.prompt();
  for await (const l of rl) {
    if (l.trim()) {
      rl.pause();
      await handle(l);
      rl.resume();
    }
    rl.prompt();
  }
}
