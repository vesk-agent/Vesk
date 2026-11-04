/** vesk presets | tracker | deploy | access */
import { createPrivateKey, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  b58encode, defaultPreset, describeLaunchExit, parseSellLadder, parseUsd, presetCost, RuleStore, validatePreset, type ControlFile, type LaunchPreset, type TrackerGroup,
} from "@vesk-agent/core";
import { config, unlock } from "../context.js";
import { trackerSource } from "./v6.js";
import { bold, confirm, dim, fail, ice, json, table, up, warn } from "../ui.js";
import { BRAND } from "@vesk-agent/core";

type Flags = Record<string, string | boolean | undefined>;
const num = (f: Flags, k: string) => (f[k] !== undefined ? Number(f[k]) : undefined);

/** vesk presets [list | add --name "Free" --dev-buy 0 [--sell 50%@100k] [--sell-after 5:100] ... | default <id> | rm <id>] */
export async function presets(args: string[], f: Flags) {
  const c = await config(f.config as string | undefined);
  const s = await new RuleStore(c.dataDir).load();
  const [sub, id] = args;
  const list = s.data.presets ?? [];
  if (!sub || sub === "list") {
    if (json({ presets: list, defaultId: s.data.defaultPresetId ?? null })) return;
    if (!list.length) return console.log(dim("  No presets yet. Try: vesk presets add --name \"Standard\" --dev-buy 0.3 --sell 50%@100k,100%@250k"));
    table(list.map((p) => ({ id: p.id, name: p.name + (p.id === s.data.defaultPresetId ? " (default)" : ""), dev: p.devBuySol ? `${p.devBuySol} SOL` : "free", exits: describeLaunchExit(p.exit).slice(0, 2).join("; ") || "none" })));
    return;
  }
  if (sub === "default" && id) {
    if (!list.some((p) => p.id === id)) fail(`No preset ${id}`);
    s.data.defaultPresetId = id;
    await s.save();
    return console.log(`  Instant deploy now uses ${ice(id)}.`);
  }
  if (sub === "rm" && id) return s.remove(id).then(() => console.log(`  Removed ${id}`));
  if (sub === "add") {
    const dev = num(f, "dev-buy") ?? 0.3;
    const ladder = f.sell ? parseSellLadder(String(f.sell)) : undefined;
    if (f.sell && !ladder) fail('--sell looks like "50%@100k,100%@250k".');
    const after = f["sell-after"] ? String(f["sell-after"]).split(",").map((x) => { const [sec, pct] = x.split(":"); return { afterSec: Number(sec.replace(/s$/, "")), sellPct: Number(pct ?? 100) }; }) : undefined;
    const p: LaunchPreset = defaultPreset({
      name: String(f.name ?? "Preset"), devBuySol: dev, mode: dev === 0 && !num(f, "team-wallets") ? "manual" : "standard",
      jitoTipSol: num(f, "jito") ?? 0, priorityFeeSol: num(f, "priority") ?? 0, slippagePct: num(f, "slippage") ?? 10,
      teamWallets: num(f, "team-wallets") ?? 0, teamSolEach: num(f, "team-sol") ?? 0.1,
      links: { website: f.web as string | undefined, telegram: f.tg as string | undefined, twitter: f.x as string | undefined },
      image: (["post", "generate", "mine"].includes(String(f.image)) ? f.image : "post") as LaunchPreset["image"], defaultImage: f["default-image"] as string | undefined,
      naming: f.naming === "model" ? "model" : "template",
      exit: { ...(ladder ? { mcapTargets: ladder } : {}), ...(after ? { timeSells: after } : {}), ...(f.stop ? { stopBelowMcapUsd: parseUsd(String(f.stop)) ?? undefined } : {}) },
    });
    const e = validatePreset(p);
    if (e.length) fail(e.map((x) => `${x.field}: ${x.message}`).join("\n"));
    console.log(`\n  ${bold(p.name)}  ${dim(presetCost(p).line)}`);
    for (const l of describeLaunchExit(p.exit)) console.log(`  ${ice("·")} ${l}`);
    if (p.exit.timeSells?.length) console.log(dim("  Many buyers prefer coins where the dev holds no supply. Every dev sell is listed in your treasury report."));
    if (f.yes || (await confirm("  Save preset?"))) {
      await s.upsertPreset(p);
      console.log(`  Saved ${ice(p.id)}.`);
    }
    return;
  }
  fail("Usage: vesk presets [list | add --name ... | default <id> | rm <id>]");
}

/** vesk tracker [groups | group add <name> @a,@b [--sound] [--notify] | group rm <id>] */
export async function tracker(args: string[], f: Flags) {
  const c = await config(f.config as string | undefined);
  const s = await new RuleStore(c.dataDir).load();
  const groups = s.data.trackerGroups ?? [];
  const [sub, act, name, handles] = args;
  if (sub === "source") return trackerSource(args.slice(1), f);
  if (!sub || sub === "groups") {
    if (json(groups)) return;
    if (!groups.length) return console.log(dim('  No groups. Try: vesk tracker group add "Founders" @a,@b'));
    return table(groups.map((g) => ({ id: g.id, name: g.name, accounts: g.handles.map((h) => "@" + h).join(" "), sound: g.sound ? "on" : "off", notify: g.notify ? "on" : "off" })));
  }
  if (sub === "group" && act === "add" && name && handles) {
    const g: TrackerGroup = { id: `g_${Math.random().toString(36).slice(2, 7)}`, name, handles: handles.split(",").map((h) => h.trim().replace(/^@/, "").toLowerCase()).filter(Boolean), sound: !!f.sound, notify: !!f.notify };
    await s.setGroups([...groups, g]);
    return console.log(`  ${up("added")} ${g.name} (${g.handles.length} accounts). The running agent starts watching them within 2 s.`);
  }
  if (sub === "group" && act === "rm" && name) {
    await s.setGroups(groups.filter((g) => g.id !== name));
    return console.log(`  Removed ${name}.`);
  }
  fail('Usage: vesk tracker [groups | group add "<name>" @a,@b [--sound] [--notify] | group rm <id>]');
}

/** vesk deploy <post url or id> [--preset id]: the running agent launches a coin on that post with a preset. */
export async function deploy(args: string[], f: Flags) {
  const ref = args[0];
  const id = ref?.match(/status\/(\d+)/)?.[1] ?? (ref && /^\d+$/.test(ref) ? ref : null);
  if (!id) fail("Usage: vesk deploy <https://x.com/user/status/123…|post id> [--preset <id>]");
  const c = await config(f.config as string | undefined);
  const file = join(c.dataDir, "control.json");
  const cur = existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as ControlFile) : {};
  await writeFile(file, JSON.stringify({ ...cur, deploys: [...(cur.deploys ?? []), { postId: id, presetId: f.preset as string | undefined }], at: Date.now() }));
  console.log("  Sent to the running agent. Guardrails, the honesty rules and your limits apply. Watch `vesk status`.");
}

/** vesk access sign "<message from the panel>": signs the panel's sign-in message with your main wallet, locally. */
export async function access(args: string[], f: Flags) {
  if (args[0] !== "sign" || !args[1]) fail('Usage: vesk access sign "<the full message shown in the panel>"');
  const msg = args.slice(1).join(" ").replace(/\\n/g, "\n");
  if (!/wants you to sign in with your Solana account/.test(msg) || !/Nonce: /.test(msg)) fail(`That doesn't look like a ${BRAND.name} sign-in message. Copy it from Access in the panel.`);
  const ks = await unlock(await config(f.config as string | undefined));
  if (!msg.includes(ks.publicKey)) fail(`The message is for another address. This keystore is ${ks.publicKey}.`);
  console.log(warn("  This signs a text message only. It can't move funds."));
  if (!f.yes && !(await confirm("  Sign it?"))) return;
  const seed = ks.keypair().secretKey.slice(0, 32);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]), format: "der", type: "pkcs8" });
  seed.fill(0);
  console.log(`\n  ${bold("Signature")} ${ice(b58encode(new Uint8Array(sign(null, Buffer.from(msg, "utf8"), key))))}\n  ${dim("Paste it back into the panel.")}`);
}
