/** vesk init | keys | rpc | pair | wallet */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KEY_ENV, Keystore, PanelLink, PUBLIC_RPC, RPC_NOTES, Rpc, redactUrl, rpcKind, veskHome } from "@vesk-agent/core";
import { config, unlock } from "../context.js";
import { setConfigValue } from "./v6.js";
import { ask, askHidden, banner, bold, confirm, dim, down, fail, ice, json, kv, sol, spinner, table, up, warn } from "../ui.js";
import { BRAND } from "@vesk-agent/core";

interface TemplateOpts { rpc: string; provider: string; modelUrl?: string; telegram: boolean; chatId?: number; paper: boolean; dataDir: string }

const TEMPLATE = (o: TemplateOpts) => `# ${BRAND.name} config. Secrets are NOT stored here: use env vars or \`vesk keys set NAME\`.
dataDir: ${o.dataDir}
paper: ${o.paper}             # true = decide but never sign. \`vesk summon --live\` signs real transactions.

rpc:
  url: ${o.rpc}
  priorityFeeSol: 0.0005
  jito: { enabled: false, blockEngineUrl: https://mainnet.block-engine.jito.wtf, tipSol: 0.001 }

model:
  provider: ${o.provider}   # anthropic | openai | openrouter | ollama | none
  model: ""               # empty = provider default${o.modelUrl ? `\n  baseUrl: ${o.modelUrl}` : ""}

x:
  source: off             # relay (free for ${BRAND.token} holders, needs \`vesk pair\`) | official-api (your own X token) | provider | off
  bearerTokenEnv: X_BEARER_TOKEN
  pollIntervalSec: 15

launches:
  enabled: false          # watch new pump.fun launches for new-launch rules

telegram:
  enabled: ${o.telegram}
  botTokenEnv: TELEGRAM_BOT_TOKEN
  allowedChatIds: [${o.chatId ?? ""}]      # your own chat id(s). The bot ignores everyone else.

limits:
  perTradeMaxSol: 0.25
  dailySpendCapSol: 1
  maxOpenPositions: 6
  maxBuysPerDay: 10
  minSolReserve: 0.02
  killSwitch: false

watchlist: []             # add with: vesk snipe @handle --sol 0.25 --max-mcap 50k
rules: []                 # add with: vesk rules add "snipe anything @x posts under 50k mcap with 0.5 SOL"
`;

const PROVIDERS = ["anthropic", "openai", "openrouter", "ollama", "none"] as const;

export interface InitFlags {
  import?: boolean;
  /** Non-interactive: take flags, env vars and defaults, never prompt. Also used when stdin isn't a terminal. */
  yes?: boolean;
  rpc?: string;
  model?: string;
  "model-url"?: string;
  telegram?: string;
  "telegram-chat"?: string;
  live?: boolean;
}

/**
 * vesk init: wallet, RPC (with a latency test), model and key, Telegram (optional), paper mode (default).
 * Interactive by default; `--yes` (or a non-terminal stdin) uses flags and env vars instead of prompts:
 *   VESK_PASSPHRASE, --rpc <url>, --model <provider> [--model-url <url>], model key from its env var,
 *   --telegram <skip|env> with TELEGRAM_BOT_TOKEN and --telegram-chat <id>, --live to start outside paper mode.
 */
export async function init(flags: InitFlags) {
  banner();
  const auto = !!flags.yes || !process.stdin.isTTY;
  const q = async (question: string, fallback = "") => (auto ? fallback : (await ask(question)) || fallback);
  const dir = veskHome();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ksPath = join(dir, "keystore.json");
  let ks: Keystore | null = null;
  const passEnv = process.env.VESK_PASSPHRASE;

  // 1. Wallet
  console.log(`${bold("1. Wallet")}  ${dim("Use a fresh wallet just for the agent. Fund it with what you can afford to lose.")}`);
  if (existsSync(ksPath)) {
    console.log(dim(`   Keystore already exists at ${ksPath}. Keeping it.`));
    console.log(`   Wallet ${ice(await Keystore.publicKeyOf(ksPath))}`);
    if (passEnv) ks = await Keystore.open(ksPath, passEnv).catch(() => null);
  } else {
    const secretKey = flags.import ? (auto ? process.env.VESK_IMPORT_SECRET : await askHidden("Paste the secret key to import (base58 or JSON array): ")) : undefined;
    if (flags.import && !secretKey) fail("--import with --yes reads the secret key from VESK_IMPORT_SECRET.");
    let pass = passEnv;
    if (pass) console.log(dim("   Using the passphrase from VESK_PASSPHRASE."));
    else if (auto) fail("Set VESK_PASSPHRASE (10+ characters) to create the keystore without prompts.");
    else {
      pass = await askHidden("New keystore passphrase (10+ characters): ");
      if (pass !== (await askHidden("Repeat passphrase: "))) fail("Passphrases don't match. Nothing was created.");
    }
    if (pass!.length < 10) fail("The passphrase needs 10 or more characters. Nothing was created.");
    ks = await Keystore.create(ksPath, pass!, secretKey);
    console.log(`   Wallet ${ice(ks.publicKey)}`);
    console.log(dim(`   Encrypted with scrypt + AES-256-GCM at ${ksPath}. It never leaves this machine.`));
  }

  // 2. RPC, with a latency test (and a second chance if it's unreachable)
  console.log(`\n${bold("2. RPC")}  ${dim("Helius, QuickNode, Triton or any URL. Enter to use the public RPC (slower).")}`);
  let rpc = flags.rpc || (await q("RPC URL: ", PUBLIC_RPC));
  for (let attempt = 0; ; attempt++) {
    if (!/^https?:\/\//.test(rpc)) {
      if (auto) fail(`"${rpc}" isn't a URL. Use --rpc https://…`);
      rpc = (await ask(`   ${warn("That isn't a URL.")} RPC URL: `)) || PUBLIC_RPC;
      continue;
    }
    const sp = spinner(`Testing ${redactUrl(rpc)}`);
    const lat = await new Rpc(rpc).latencyTest(3);
    sp.stop();
    console.log(`   ${lat.verdict === "down" ? warn("unreachable") : `p50 ${lat.p50} ms, p95 ${lat.p95} ms (${lat.verdict})`} · ${RPC_NOTES[lat.kind]}`);
    if (lat.verdict !== "down" || auto || attempt > 0) {
      if (lat.verdict === "down") console.log(warn("   Saved anyway. Fix it later in the config, then run `vesk rpc test`."));
      break;
    }
    const again = await ask("   Try another URL (Enter keeps this one): ");
    if (!again) break;
    rpc = again;
  }

  // 3. Model + key
  console.log(`\n${bold("3. Model")}  ${dim("anthropic, openai, openrouter, ollama or none. Chat works without one for common phrasings.")}`);
  let provider = (flags.model || (await q("Provider [none]: ", "none"))).toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    console.log(warn(`   "${provider}" isn't one of ${PROVIDERS.join(", ")}. Using none; change model.provider later.`));
    provider = "none";
  }
  const modelUrl = flags["model-url"] || (provider === "ollama" ? (await q("Ollama URL [http://127.0.0.1:11434]: ", "")) || undefined : undefined);
  const keyName = KEY_ENV[provider];
  if (keyName) {
    if (process.env[keyName]) console.log(dim(`   ${keyName} found in the environment. The agent reads it from there.`));
    else if (ks && !auto) {
      const v = await askHidden(`   Paste your ${keyName} (stored encrypted in the keystore; Enter to skip): `);
      if (v) (await ks.setSecret(keyName, v), console.log(dim(`   Stored ${keyName} in the encrypted keystore.`)));
      else console.log(dim(`   Skipped. Later: vesk keys set ${keyName}`));
    } else console.log(dim(`   Later: vesk keys set ${keyName}`));
  }

  // 4. Telegram (optional)
  console.log(`\n${bold("4. Telegram")}  ${dim("Optional. Your own bot: alerts, Launch / Skip buttons, kill switch. Enter to skip.")}`);
  let telegram = false;
  let chatId: number | undefined;
  const tgEnv = process.env.TELEGRAM_BOT_TOKEN;
  const tgToken = auto ? (flags.telegram === "env" ? tgEnv : undefined) : await askHidden("   Bot token from @BotFather (Enter to skip): ");
  if (tgToken) {
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(tgToken)) console.log(warn("   That doesn't look like a bot token (123456:ABC…). Skipped; run `vesk init` again or set telegram in the config."));
    else {
      if (ks && tgToken !== tgEnv) await ks.setSecret("TELEGRAM_BOT_TOKEN", tgToken);
      telegram = true;
      const raw = flags["telegram-chat"] ?? (await q("   Your chat id (message @userinfobot to get it): ", ""));
      chatId = /^-?\d+$/.test(raw) ? Number(raw) : undefined;
      if (!chatId) console.log(warn("   No chat id: the bot will ignore everyone until you add yours to telegram.allowedChatIds."));
      console.log(dim("   Run it with: vesk telegram"));
    }
  } else console.log(dim("   Skipped."));

  // 5. Paper mode
  console.log(`\n${bold("5. Mode")}  ${dim("Paper mode makes every decision for real but never signs. Recommended until your rules look right.")}`);
  const paper = flags.live ? false : auto ? true : !/^n(o)?$/i.test(await ask(`   Start in paper mode? ${dim("[Y/n]")} `));
  console.log(`   ${paper ? `${ice("paper")} ${dim("(vesk summon --live signs real transactions)")}` : warn("live: vesk summon signs real transactions")}`);

  const cfgPath = join(dir, "vesk.config.yaml");
  const write = !existsSync(cfgPath) || (auto ? true : await confirm(`\nOverwrite ${cfgPath}?`));
  if (write) await writeFile(cfgPath, TEMPLATE({ rpc, provider, modelUrl, telegram, chatId, paper, dataDir: dir }), { mode: 0o600 });
  console.log(`\n${ice("Ready.")} ${write ? dim(`Config at ${cfgPath}.`) : dim("Kept your config.")}`);
  console.log(`  Next: fund ${dim("the wallet above")}, add a rule (${bold("vesk snipe @handle --sol 0.1")} or ${bold('vesk chat')}), then ${bold("vesk summon")}${paper ? dim(" (paper)") : ""}.`);
}

export async function keys(args: string[], flags: { config?: string }) {
  const [sub, name] = args;
  const c = await config(flags.config);
  const ks = await unlock(c);
  if (sub === "set" && name) {
    const v = await askHidden(`Value for ${name}: `);
    await ks.setSecret(name.toUpperCase(), v);
    console.log(`Stored ${name.toUpperCase()} in the encrypted keystore.`);
  } else if (sub === "rm" && name) {
    await ks.setSecret(name.toUpperCase(), null);
    console.log(`Removed ${name.toUpperCase()}.`);
  } else {
    table(Object.keys(ks.secrets()).map((k) => ({ name: k, value: "•••••••• (encrypted)" })));
  }
}

export async function rpc(args: string[], flags: { config?: string }) {
  const url = args[1] ?? (await config(flags.config)).rpc.url;
  const sp = spinner(`Testing ${redactUrl(url)}`);
  const r = await new Rpc(url).latencyTest(8);
  sp.stop();
  if (json(r)) return;
  table([{ rpc: redactUrl(url), kind: r.kind, p50: `${r.p50} ms`, p95: `${r.p95} ms`, errors: r.errors, verdict: r.verdict === "down" ? down(r.verdict) : r.verdict === "fast" ? up(r.verdict) : r.verdict }]);
  console.log(dim(RPC_NOTES[rpcKind(url)]));
}

export async function pair(args: string[], flags: { config?: string; panel?: string }) {
  const code = args[0];
  if (!code) fail("Usage: vesk pair <CODE> --panel <panel function url>. Get the code in the panel under Wallets → Self-hosted.");
  const c = await config(flags.config);
  const url = flags.panel ?? c.panel?.url;
  if (!url) fail("Pass --panel <url> or set panel.url in your config.");
  const ks = await unlock(c);
  const sp = spinner("Pairing with the panel");
  const r = await new PanelLink(url).pair(code, ks.publicKey).catch((e: Error) => { sp.stop(); return fail(e.message); });
  sp.stop();
  await ks.setSecret("VESK_AGENT_TOKEN", r.agentToken);
  const p = await setConfigValue(flags.config, ["panel"], { url, report: true, syncRules: c.panel?.syncRules ?? false }).catch(() => null);
  console.log(`Paired as agent ${ice(r.agentId)}.${p ? ` Saved panel.url in ${p}.` : ` Set ${bold("panel: { url, report: true }")} in your config to start reporting.`}`);
  console.log(dim("The panel sees status, positions and activity. It can pause the agent. It never sees or uses your keys."));
}

export async function wallet(args: string[], flags: { config?: string }) {
  const c = await config(flags.config);
  if (args[0] === "export") {
    const ks = await unlock(c);
    if (!(await confirm(warn("This prints your secret key. Anyone who sees it can take your funds. Continue?")))) return;
    console.log(ks.exportSecretKey(await askHidden("Passphrase again: ")));
    return;
  }
  const pub = await Keystore.publicKeyOf(c.wallet.keystore);
  const r = new Rpc(c.rpc.url);
  const [bal, tokens] = await Promise.all([r.getBalanceSol(pub), r.getTokenBalances(pub).catch(() => [])]);
  if (json({ address: pub, balanceSol: bal, tokens })) return;
  kv([["wallet", ice(pub)], ["balance", sol(bal)]]);
  if (tokens.length) { console.log(); table(tokens.map((t) => ({ mint: t.mint, amount: t.amount }))); }
}
