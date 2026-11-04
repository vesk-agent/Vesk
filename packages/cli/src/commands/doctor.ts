/**
 * vesk doctor [--json]: checks the things that make an agent slow or broken, without changing anything.
 * Node version, config, keystore (file mode, unlock if VESK_PASSPHRASE is set), RPC latency over HTTP and the
 * websocket, model key, X source, Telegram and paper mode.
 */
import { existsSync, statSync } from "node:fs";
import { findConfig, KEY_ENV, Keystore, loadConfig, Rpc, RPC_NOTES, rpcKind, secret, wsUrlFor } from "@vesk-agent/core";
import { dim, down, ice, json, spinner, up, warn } from "../ui.js";
import { BRAND } from "@vesk-agent/core";

type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string };

async function wsReachable(url: string, ms = 4000): Promise<number | null> {
  const WS = (globalThis as { WebSocket?: new (u: string) => { close(): void; onopen: unknown; onerror: unknown; onclose: unknown } }).WebSocket;
  if (!WS) return null;
  const t0 = Date.now();
  return new Promise((res) => {
    let done = false;
    const end = (v: number | null) => { if (!done) { done = true; clearTimeout(t); try { ws.close(); } catch { /* closed */ } res(v); } };
    const t = setTimeout(() => end(null), ms);
    let ws: InstanceType<typeof WS>;
    try { ws = new WS(url); } catch { return end(null); }
    ws.onopen = () => end(Date.now() - t0);
    ws.onerror = () => end(null);
    ws.onclose = () => end(null);
  });
}

export async function doctor(flags: { config?: string }) {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 22 ? "ok" : "fail", `v${process.versions.node}${major >= 22 ? "" : ` (${BRAND.name} needs 22+)`}`);

  const path = flags.config ?? findConfig();
  const { config: c, errors } = await loadConfig(path);
  if (!path) add("config", "warn", "no vesk.config.yaml found; using defaults (run `vesk init`)");
  else add("config", errors.length ? "fail" : "ok", errors.length ? errors.map((e) => `${e.field}: ${e.message}`).join("; ") : path);
  add("mode", c.paper === true ? "ok" : "warn", c.paper === true ? "paper: decisions are real, nothing is signed (`vesk summon --live` to sign)" : "live: `vesk summon` signs real transactions");

  let secrets: Record<string, string> = {};
  if (!existsSync(c.wallet.keystore)) add("keystore", "fail", `none at ${c.wallet.keystore} (run \`vesk init\`)`);
  else {
    const mode = statSync(c.wallet.keystore).mode & 0o777;
    const pub = await Keystore.publicKeyOf(c.wallet.keystore).catch(() => "?");
    if (process.env.VESK_PASSPHRASE) {
      try {
        const ks = await Keystore.open(c.wallet.keystore, process.env.VESK_PASSPHRASE);
        secrets = ks.secrets();
        add("keystore", mode & 0o077 ? "warn" : "ok", `${pub} · unlocked with VESK_PASSPHRASE${mode & 0o077 ? ` · file mode ${mode.toString(8)}, should be 600` : ""}`);
      } catch {
        add("keystore", "fail", `${pub} · VESK_PASSPHRASE doesn't unlock it`);
      }
    } else add("keystore", mode & 0o077 ? "warn" : "ok", `${pub} · locked (set VESK_PASSPHRASE to check stored keys)${mode & 0o077 ? ` · file mode ${mode.toString(8)}, should be 600` : ""}`);
  }

  const sp = spinner("Testing your RPC");
  const lat = await new Rpc(c.rpc.url).latencyTest(5);
  sp.stop();
  const kind = rpcKind(c.rpc.url);
  add("rpc", lat.verdict === "down" ? "fail" : kind === "public" || lat.verdict === "slow" ? "warn" : "ok",
    lat.verdict === "down" ? `unreachable (${lat.url})` : `${kind} · p50 ${lat.p50} ms · p95 ${lat.p95} ms${kind === "public" ? ` · ${RPC_NOTES.public}` : ""}`);
  const ws = c.rpc.wsUrl ?? wsUrlFor(c.rpc.url);
  if (ws) {
    const t = await wsReachable(ws);
    add("rpc websocket", t === null ? "warn" : "ok", t === null ? "couldn't open; confirmations fall back to polling (slower)" : `connected in ${t} ms · confirmations arrive as a push`);
  }

  const m = c.model;
  if (m.provider === "none") add("model", "ok", "none (chat understands common phrasings without one)");
  else if (m.provider === "ollama") add("model", "ok", `ollama at ${m.baseUrl ?? "http://127.0.0.1:11434"}`);
  else {
    const name = m.apiKeyEnv ?? KEY_ENV[m.provider] ?? "";
    const have = !!secret(name, secrets);
    add("model", have ? "ok" : process.env.VESK_PASSPHRASE ? "fail" : "warn", have ? `${m.provider} · ${name} found` : `${m.provider} · ${name} not in env${process.env.VESK_PASSPHRASE ? " or keystore" : " (keystore not checked: locked)"}`);
  }

  const xs = c.x.source;
  if (xs === "off") add("x source", "warn", "off: X accounts aren't watched");
  else if (xs === "relay") add("x source", c.panel?.url && secret("VESK_AGENT_TOKEN", secrets) ? "ok" : c.panel?.url ? "warn" : "fail", c.panel?.url ? `${BRAND.name} Relay via ${c.panel.url}${secret("VESK_AGENT_TOKEN", secrets) ? "" : " (pairing token not checked: keystore locked)"}` : "relay needs `vesk pair <CODE> --panel <url>`");
  else if (xs === "official-api") add("x source", secret(c.x.bearerTokenEnv, secrets) ? "ok" : "fail", secret(c.x.bearerTokenEnv, secrets) ? `your X API key (${c.x.bearerTokenEnv})` : `${c.x.bearerTokenEnv} not set`);
  else add("x source", c.x.provider ? "ok" : "fail", c.x.provider ? `provider webhook on 127.0.0.1:${c.x.provider.listenPort}` : "provider selected but x.provider isn't configured");

  if (c.telegram.enabled) add("telegram", secret(c.telegram.botTokenEnv, secrets) ? (c.telegram.allowedChatIds.length ? "ok" : "warn") : "fail", secret(c.telegram.botTokenEnv, secrets) ? (c.telegram.allowedChatIds.length ? "bot token set" : "no allowedChatIds: the bot ignores everyone") : `${c.telegram.botTokenEnv} not set`);

  const bad = checks.filter((x) => x.status === "fail").length;
  if (bad) process.exitCode = 1;
  if (json({ ok: bad === 0, checks })) return;
  const w = Math.max(...checks.map((x) => x.name.length));
  for (const x of checks) console.log(`  ${x.status === "ok" ? up("ok  ") : x.status === "warn" ? warn("warn") : down("fail")}  ${ice(x.name.padEnd(w))}  ${x.detail}`);
  console.log(`\n  ${bad ? down(`${bad} problem${bad === 1 ? "" : "s"} to fix.`) : up("Ready.")} ${dim("vesk doctor changes nothing.")}`);
}
