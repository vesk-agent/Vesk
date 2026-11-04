#!/usr/bin/env node
/**
 * End-to-end simulation: the real CLI, the real agent loop, local mock servers for every third party.
 *
 *   pnpm test:e2e            (or: node e2e/run.mjs)
 *
 * Flow: help and errors → vesk init (paper by default) → presets, a launch-on-post rule with a switched-off
 * account, chat-to-rule through a mock model → vesk summon (paper) → a post arrives on the X filtered stream →
 * "[paper] would launch" → vesk summon --live → the same flow signs and sends a Jito bundle (signatures are
 * verified by the mock) → timed dev sell → vesk treasury → vesk status → Vesk Relay over a Realtime
 * websocket → recover rent → address book.
 *
 * Nothing leaves the machine. A temporary VESK_HOME is used and removed afterwards (keep it with E2E_KEEP=1). E2E_CAPTURE=<dir> saves the Rogue step's `vesk live --once` in colour for the docs shot.
 * If @solana/web3.js isn't installed (offline), a small shim with real ed25519 is used and the run says so.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMocks } from "./mocks.mjs";

/** VESK_E2E_TRANSCRIPT=<file>: append the real terminal output of each summon run (used for the site's terminal demo). */
const transcript = (title, out) => process.env.VESK_E2E_TRANSCRIPT && appendFileSync(process.env.VESK_E2E_TRANSCRIPT, `### ${title}\n${out}\n`);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/src/index.ts");
const REGISTER = pathToFileURL(join(ROOT, "e2e/register.mjs")).href;
const extraPaths = (process.env.VESK_E2E_NODE_PATH ?? "").split(":").filter(Boolean);

function findTsx() {
  for (const base of [join(ROOT, "package.json"), join(ROOT, "packages/core/package.json"), ...extraPaths.map((p) => join(p, "_"))]) {
    try { return pathToFileURL(createRequire(base).resolve("tsx")).href; } catch { /* next */ }
  }
  console.error("tsx not found. Run `pnpm install` (or set VESK_E2E_NODE_PATH to a node_modules that has tsx).");
  process.exit(2);
}
function web3Kind() {
  try { createRequire(join(ROOT, "packages/core/package.json")).resolve("@solana/web3.js"); return "real @solana/web3.js"; } catch { return "offline shim (e2e/web3-shim.mjs, real ed25519)"; }
}
const TSX = findTsx();

const home = mkdtempSync(join(tmpdir(), "vesk-e2e-"));
const results = [];
let failed = 0;
const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[38;5;114m${s}\x1b[0m`, bad: (s) => `\x1b[38;5;210m${s}\x1b[0m`, ice: (s) => `\x1b[38;5;159m${s}\x1b[0m` };

const m = await startMocks();
const env = {
  ...process.env,
  VESK_RACE_DELAY_MS: "2500",
  HOME: home, VESK_HOME: join(home, ".vesk"), NO_COLOR: "1",
  VESK_PASSPHRASE: "e2e-passphrase-long-enough", X_BEARER_TOKEN: "e2e-x-token",
  VESK_X_API_BASE: `${m.urls.x}/2`, VESK_PUMPPORTAL_URL: `${m.urls.pump}/api/trade-local`, VESK_PUMP_IPFS_URL: `${m.urls.pump}/api/ipfs`,
  VESK_PUMPPORTAL_DATA_WS: `${m.urls.pump.replace(/^http/, "ws")}/api/data`,
  VESK_JUP_PRICE_URL: `${m.urls.price}/price/v3`, VESK_DEXSCREENER_URL: `${m.urls.price}/dex`, JUPITER_API_URL: `${m.urls.price}/swap/v1`,
  VESK_TELEGRAM_API: "http://127.0.0.1:9", VESK_ANTHROPIC_URL: "http://127.0.0.1:9", VESK_OPENAI_IMAGES_URL: "http://127.0.0.1:9",
};
delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.TELEGRAM_BOT_TOKEN;

function vesk(args, o = {}) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["--import", TSX, "--import", REGISTER, CLI, ...args], { env: { ...env, ...o.env }, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    if (o.input) p.stdin.end(o.input); else p.stdin.end();
    const t = setTimeout(() => p.kill("SIGKILL"), o.timeout ?? 60_000);
    p.on("close", (code) => (clearTimeout(t), res({ code, out })));
  });
}

/** A long-running agent with a live output buffer. */
function agent(args) {
  const p = spawn(process.execPath, ["--import", TSX, "--import", REGISTER, CLI, ...args], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  const a = { out: "", exited: null, p };
  p.stdout.on("data", (d) => (a.out += d));
  p.stderr.on("data", (d) => (a.out += d));
  p.on("close", (code) => (a.exited = code));
  a.waitFor = (re, ms = 20_000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = a.out.match(re);
      if (hit) return res(hit);
      if (a.exited !== null) return rej(new Error(`agent exited (${a.exited}) before ${re}\n${a.out.slice(-1500)}`));
      if (Date.now() - t0 > ms) return rej(new Error(`timed out after ${ms} ms waiting for ${re}\n--- agent output (tail) ---\n${a.out.slice(-1500)}`));
      setTimeout(tick, 100);
    };
    tick();
  });
  a.waitExit = (ms = 10_000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => (a.exited !== null ? res(a.exited) : Date.now() - t0 > ms ? (p.kill("SIGKILL"), rej(new Error("agent didn't exit after `vesk stop`"))) : setTimeout(tick, 100));
    tick();
  });
  return a;
}

const until = (f, ms = 15_000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => (f() ? res() : Date.now() - t0 > ms ? rej(new Error("condition not met in time")) : setTimeout(tick, 100)); tick(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, what, detail = "") {
  if (!cond) throw new Error(`${what}${detail ? `\n${String(detail).slice(-1500)}` : ""}`);
}
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note });
    console.log(`  ${C.ok("pass")}  ${name} ${C.dim(`${Date.now() - t0} ms`)}${note ? C.dim(`  ${note}`) : ""}`);
  } catch (e) {
    failed++;
    results.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log(`  ${C.bad("FAIL")}  ${name}\n${e.message.split("\n").map((l) => "        " + l).join("\n")}`);
  }
}

console.log(`\n  ${C.ice("Vesk end-to-end")} ${C.dim(`web3: ${web3Kind()} · home ${home}`)}\n`);
const S = { wallet: "", preset: "", rule: "", mint: "" };
const png = join(home, "coin.png");
// 1x1 PNG
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

// ---------------------------------------------------------------- CLI basics
await step("help lists every command group", async () => {
  const r = await vesk(["help"]);
  check(r.code === 0, "exit 0", r.out);
  for (const s of ["vesk init", "vesk summon", "launch-on-post", "tracker source", "vesk rent", "vesk treasury", "vesk book"]) check(r.out.includes(s), `help mentions "${s}"`, r.out);
});
await step("unknown command suggests the right one", async () => {
  const r = await vesk(["lauch"]);
  check(r.code === 1 && /Did you mean `vesk launch`/.test(r.out), "suggestion", r.out);
});
await step("init refuses a short passphrase and creates nothing", async () => {
  const r = await vesk(["init", "--yes", "--rpc", m.urls.rpc], { env: { VESK_PASSPHRASE: "short", VESK_HOME: join(home, "other") } });
  check(r.code === 1 && /10 or more characters/.test(r.out), "clear error", r.out);
  check(!existsSync(join(home, "other", "keystore.json")), "no keystore written");
});

// ---------------------------------------------------------------- init
await step("vesk init: wallet, RPC latency, model, Telegram skipped, paper default", async () => {
  const r = await vesk(["init", "--yes", "--rpc", m.urls.rpc, "--model", "ollama", "--model-url", m.urls.model]);
  check(r.code === 0, "exit 0", r.out);
  for (const s of ["1. Wallet", "2. RPC", "3. Model", "4. Telegram", "5. Mode"]) check(r.out.includes(s), `wizard step "${s}"`, r.out);
  check(/p50 \d+ ms/.test(r.out), "latency test printed", r.out);
  check(/paper/.test(r.out) && /Skipped\./.test(r.out), "paper default + Telegram skipped", r.out);
  S.wallet = r.out.match(/Wallet ([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1] ?? "";
  check(S.wallet, "wallet address printed", r.out);
  const cfg = readFileSync(join(home, ".vesk", "vesk.config.yaml"), "utf8");
  check(/^paper: true/m.test(cfg) && cfg.includes(m.urls.model), "config has paper: true and the model URL", cfg);
  check(!readFileSync(join(home, ".vesk", "keystore.json"), "utf8").includes(S.wallet.slice(0, 0) + "secretKey\""), "keystore is encrypted");
  // Point Jito at the mock (a user would put their block engine URL here).
  writeFileSync(join(home, ".vesk", "vesk.config.yaml"), cfg.replace("https://mainnet.block-engine.jito.wtf", m.urls.jito));
  m.fund(S.wallet, 2);
  return S.wallet;
});
await step("vesk doctor checks node, config, keystore, RPC + websocket, model and X source", async () => {
  const r = await vesk(["doctor", "--json"]);
  const j = JSON.parse(r.out.slice(r.out.indexOf("{")));
  const by = Object.fromEntries(j.checks.map((c) => [c.name, c]));
  for (const k of ["node", "config", "mode", "keystore", "rpc", "rpc websocket", "model", "x source"]) check(by[k], `doctor checks ${k}`, r.out);
  check(by.keystore.status === "ok" && /unlocked/.test(by.keystore.detail), "keystore unlocks", by.keystore.detail);
  check(by["rpc websocket"].status === "ok", "websocket RPC reachable", by["rpc websocket"].detail);
  check(by.mode.detail.startsWith("paper"), "paper mode reported");
  const human = await vesk(["doctor"]);
  check(/ok\s+node/.test(human.out) && /rpc websocket/.test(human.out), "readable checklist", human.out);
});
await step("hard limits from the CLI: buys per minute is checked (this run raises it and the open-position cap: it trades a lot)", async () => {
  const bad = await vesk(["strategy", "set", "limits.maxBuysPerMinute", "0"]);
  check(bad.code === 1 && /at least 1/.test(bad.out), "0 refused", bad.out);
  const r = await vesk(["strategy", "set", "limits.maxBuysPerMinute", "60"]);
  check(r.code === 0 && /Max buys per minute: 60 per min/.test(r.out), "saved", r.out);
  const j = JSON.parse((await vesk(["strategy", "--json"])).out);
  check(j.limits.maxBuysPerMinute === 60, "in force", JSON.stringify(j.limits));
  // the later steps open many positions; the cap is raised the same way (any hard limit can be set here)
  const op = await vesk(["strategy", "set", "limits.maxOpenPositions", "30"]);
  check(op.code === 0 && /Max open positions: 30/.test(op.out), "max open positions raised", op.out);
  const bd = await vesk(["strategy", "set", "limits.maxBuysPerDay", "100"]);
  check(bd.code === 0 && /Max buys per day: 100/.test(bd.out), "max buys per day raised", bd.out);
  return "0 refused · 60 per minute saved · 30 open positions · 100 buys a day";
});
await step("vesk wallet shows the funded balance", async () => {
  const r = await vesk(["wallet"]);
  check(r.code === 0 && /2\.000 SOL/.test(r.out), "2 SOL", r.out);
});
await step("tracker source: official X API", async () => {
  const r = await vesk(["tracker", "source", "official-api"]);
  check(r.code === 0 && /X source is now official-api/.test(r.out), "switched", r.out);
  const bad = await vesk(["tracker", "source", "scrape"]);
  check(bad.code === 1 && /Pick one of: relay, official-api, provider, off/.test(bad.out), "unknown source error", bad.out);
});

// ---------------------------------------------------------------- rules
await step("preset: 0.2 SOL dev buy, model naming, dev sells 100% after 5 s", async () => {
  const r = await vesk(["presets", "add", "--name", "Dev sells at 5 s", "--dev-buy", "0.2", "--sell-after", "5:100", "--image", "mine", "--default-image", png, "--naming", "model", "--yes"]);
  S.preset = r.out.match(/Saved (pr_\w+)/)?.[1] ?? "";
  check(r.code === 0 && S.preset, "saved", r.out);
  check(/treasury report/.test(r.out), "dev-sell disclosure note shown", r.out);
  return S.preset;
});
await step("launch-on-post rule on two accounts, one switched off", async () => {
  const r = await vesk(["rules", "add", "--launch-on-post", "@harbourdesk,@lumen_wire", "--preset", S.preset, "--auto", "--cooldown", "0", "--per-hour", "5", "--max-sol", "0.5", "--yes"]);
  S.rule = r.out.match(/Saved as (lp_\w+)/)?.[1] ?? "";
  check(r.code === 0 && S.rule, "saved", r.out);
  const off = await vesk(["rules", "account", S.rule, "@lumen_wire", "off"]);
  check(off.code === 0 && /Watching: @harbourdesk$/m.test(off.out), "lumen_wire off", off.out);
  const all = await vesk(["rules", "account", S.rule, "@harbourdesk", "off"]);
  check(all.code === 1 && /Every account is switched off/.test(all.out), "can't switch every account off while the rule is on", all.out);
  const list = await vesk(["rules"]);
  check(/@lumen_wire \(off\)/.test(list.out), "list shows the switched-off account", list.out);
  return S.rule;
});
await step("chat-to-rule through the (mock) model", async () => {
  const r = await vesk(["rules", "add", "whenever harbourdesk drops a contract put a fifth of a sol in", "--yes"]);
  check(r.code === 0 && /Drafted by your model/.test(r.out) && /Saved as/.test(r.out), "drafted and saved", r.out);
  check(m.modelCalls.some((c) => c.kind.startsWith("You turn a trader")), "model was asked");
  const refuse = await vesk(["rules", "add", "run a volume bot on my coin with 5 wallets", "--yes"]);
  check(/I can't do that one\./.test(refuse.out) && !/Saved as|guardrail|Why/i.test(refuse.out), "volume bot refused with one plain sentence", refuse.out);
});

// ---------------------------------------------------------------- paper run
await step("summon (paper by default): post on the X stream → would launch", async () => {
  const a = agent(["summon", "--stream"]);
  try {
    await a.waitFor(/paper mode/);
    await a.waitFor(/Watching 1 X account via x-filtered-stream/);
    await until(() => m.streamCount() > 0);
    const offDelivered = m.pushPost({ id: "1001", handle: "lumen_wire", text: "Quiet morning on the wire.", image: "https://pbs.mock/a.jpg" });
    check(offDelivered === 0, "switched-off account isn't in the stream rules");
    m.pushPost({ id: "1002", handle: "harbourdesk", text: "Last ferry tonight. The harbour lights are on.", image: "https://pbs.mock/ferry.jpg" });
    const hit = await a.waitFor(/\[paper\] Would launch (.+?) \(\$(\w+)\) from @harbourdesk's post/);
    check(hit[1] === "Night Ferry" && hit[2] === "FERRY", "model named it", hit[0]);
    check(!m.log.some((l) => l.svc === "jito" || (l.svc === "rpc" && l.what === "landed")), "nothing signed or sent in paper mode");
    await vesk(["stop"]);
    await a.waitExit();
    transcript("summon --stream (paper)", a.out);
    return "named by the model, nothing sent";
  } finally { a.p.kill(); }
});

// ---------------------------------------------------------------- live run
await step("summon --live: post → create + dev buy as one transaction, no tip (signatures verified) → timed dev sell", async () => {
  const a = agent(["summon", "--live", "--stream"]);
  try {
    await a.waitFor(/live/);
    await a.waitFor(/Watching 1 X account/);
    await until(() => m.streamCount() > 0);
    const before = m.balance(S.wallet);
    const t0 = Date.now();
    m.pushPost({ id: "1003", handle: "harbourdesk", text: "Fog over the harbour. Ferries still running.", image: "https://pbs.mock/fog.jpg" });
    const jitoBefore = m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length;
    const landed = await a.waitFor(/\$FERRY: post received → landed in (\d+) ms/);
    // v22: the dev buy is part of the create transaction, so it goes through the RPC with no Jito tip
    const build = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "create").pop();
    check(build && build.amount === 0.2 && build.priorityFee === 0, "one create + dev buy transaction, priority fee 0 (no tip)", JSON.stringify(build));
    check(m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length === jitoBefore, "no Jito bundle for a solo launch", JSON.stringify(m.log.slice(-6)));
    const created = m.log.find((l) => l.svc === "rpc" && l.what === "landed" && l.effect === "create");
    check(created && created.signers.length === 2 && created.signers[0] === S.wallet, "create signed by the wallet and the fresh mint key (both verified)");
    const up = m.uploads[m.uploads.length - 1];
    check(up.description.includes("Inspired by a post from @harbourdesk. Not affiliated with or endorsed by them."), "disclaimer in the description", up.description);
    check(!up.twitter || !/harbourdesk/i.test(up.twitter), "X link is never the watched account");
    S.mint = created.signers[1];
    await a.waitFor(/5 s after launch, selling 100%/, 12_000);
    const sold = await a.waitFor(/Sold 100% of FERRY for ([\d.]+) SOL/);
    const elapsed = Date.now() - t0;
    check(elapsed >= 5000, `timed sell fired after 5 s (${elapsed} ms)`);
    await a.waitFor(/Dev position in \$FERRY fully sold/, 8000);
    check(m.tokenBalance(S.wallet, S.mint) === 0, "no tokens left in the dev wallet");
    check(m.wsConfirms() > 0, `confirmations arrived over the RPC websocket (${m.wsConfirms()})`);
    // Mock economics: 0.02 SOL launch cost, flat price, 1% sell fee. Dev buy 0.2 SOL comes back as ~0.198.
    const net = before - m.balance(S.wallet);
    check(Number(sold[1]) > 0.19 && Number(sold[1]) < 0.2, `sell proceeds recorded from the chain (${sold[1]} SOL)`);
    check(net > 0.02 && net < 0.03, `net cost = launch cost + sell fee, got ${net.toFixed(4)} SOL`);
    await vesk(["stop"]);
    await a.waitExit();
    transcript("summon --live --stream", a.out);
    return `landed in ${landed[1]} ms, sold for ${sold[1]} SOL after ${(elapsed / 1000).toFixed(1)} s`;
  } finally { a.p.kill(); }
});
await step("vesk treasury lists the dev sell with its transaction", async () => {
  const r = await vesk(["treasury"]);
  check(r.code === 0 && /Treasury report for \$FERRY/.test(r.out) && /Dev wallet sold .* SOL\. Tx: https:\/\/solscan\.io\/tx\//.test(r.out), "report", r.out);
});
await step("vesk status / positions, human and --json", async () => {
  const r = await vesk(["status"]);
  check(r.code === 0 && /status\s+stopped/.test(r.out) && /open\s+0 positions/.test(r.out), "stopped, no open positions", r.out);
  const j = JSON.parse((await vesk(["status", "--json"])).out);
  check(j.status === "stopped" && Array.isArray(j.positions) && j.recent.length > 0, "status --json", JSON.stringify(j).slice(0, 300));
  const pos = await vesk(["positions"]);
  check(/RECENTLY CLOSED/.test(pos.out) && /FERRY/.test(pos.out), "positions shows the closed dev position", pos.out);
  const t = JSON.parse((await vesk(["treasury", "--json"])).out);
  check(t[0]?.totals?.devSoldSol > 0, "treasury --json has the dev sell");
  check(/Dev position in \$FERRY fully sold/.test(r.out) || /sell/.test(r.out), "recent activity", r.out);
});

// ---------------------------------------------------------------- relay
await step("relay: needs pairing, then posts arrive over the Realtime websocket", async () => {
  const pre = await vesk(["tracker", "source", "relay"]);
  check(pre.code === 1 && /needs a paired panel/.test(pre.out), "clear error before pairing", pre.out);
  const bad = await vesk(["pair", "WRONG1", "--panel", m.urls.panel]);
  check(bad.code === 1 && /expired or doesn't exist/.test(bad.out), "bad code error", bad.out);
  const ok = await vesk(["pair", "E2EPAIR", "--panel", m.urls.panel]);
  check(ok.code === 0 && /Paired as agent ag_e2e/.test(ok.out) && /Saved panel\.url/.test(ok.out), "paired", ok.out);
  const src = await vesk(["tracker", "source", "relay"]);
  check(src.code === 0 && /X source is now relay/.test(src.out), "switched", src.out);
  const a = agent(["summon"]);
  try {
    await a.waitFor(/via vesk-relay/);
    await until(() => m.relayCount() > 0);
    check(m.log.some((l) => l.svc === "relay" && l.what === "join" && l.ok), "joined the private channel with the relay token");
    m.relayBroadcast({ id: "1004", handle: "harbourdesk", text: "Night shift at the harbour.", image: "https://pbs.mock/night.jpg" });
    await a.waitFor(/\[paper\] Would launch .* from @harbourdesk's post/);
    m.relayBroadcast({ id: "1005", handle: "someone_else", text: "Not watched." });
    await sleep(800);
    check(!/someone_else/.test(a.out), "posts from accounts you don't watch are filtered out");
    await vesk(["stop"]);
    await a.waitExit();
  } finally { a.p.kill(); }
});

await step("panel orders reach the agent and the guardrails still decide", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const fresh = m.newKeypair().publicKey.toBase58();
    m.queueOp({ op: "trade", mint: fresh, side: "buy", wallets: [S.wallet], amountSol: 0.05 });
    await a.waitFor(/Bought 0\.05 SOL of .* via pumpfun/, 10_000);
    check(m.tokenBalance(S.wallet, fresh) > 0, "tokens landed in the wallet");
    m.queueOp({ op: "trade", mint: S.mint, side: "buy", wallets: [S.wallet], amountSol: 0.05 });
    await a.waitFor(/Sold this coin in the last 10 minutes/, 10_000);
    m.queueOp({ op: "trade", mint: fresh, side: "buy", wallets: [S.wallet, m.newKeypair().publicKey.toBase58()], amountSol: 0.05 });
    await a.waitFor(/Panel: buys run from one wallet per coin/, 10_000);
    // v19: the steps reached the panel on the 2 s poll (not only the 10 s report), with the guardrail's own reason
    await until(() => m.pipeline().some((e) => e.stage === "check" && e.outcome === "fail" && e.mint === S.mint), 6_000);
    const pl = m.pipeline();
    const landed = pl.find((e) => e.stage === "execute" && e.outcome === "done" && e.mint === fresh);
    check(!!landed && typeof landed.ms === "number" && !!landed.signature, "Live: the panel got the landed buy with its landing time and signature", JSON.stringify(landed));
    const refused = pl.find((e) => e.stage === "check" && e.outcome === "fail" && e.mint === S.mint);
    check(/Sold this coin in the last 10 minutes/.test(refused?.reason ?? "") && refused.action === "filtered", "Live: the re-buy shows as filtered with the guardrail's reason", JSON.stringify(refused));
    check(pl.some((e) => e.via === "agent-poll"), "Live: steps arrive on the 2 s poll");
    await vesk(["stop"]);
    await a.waitExit();
    return "buy landed · wash-trade re-buy refused · multi-wallet buy refused · Live steps reached the panel";
  } finally { a.p.kill(); }
});

await step("vesk live: the pipeline in the terminal, and as JSON", async () => {
  const once = await vesk(["live", "--once"]);
  check(once.code === 0, "vesk live --once exits 0", once.out);
  for (const w of ["Watch", "Check", "Size", "Execute", "Exit", "Log", "DECISIONS"]) check(once.out.includes(w), `shows ${w}`, once.out);
  check(/ENTER/.test(once.out) && /FILTERED/.test(once.out), "an entry and a refusal in the decisions", once.out);
  check(!/undefined|NaN/.test(once.out), "nothing undefined", once.out);
  const j = JSON.parse((await vesk(["live", "--json"])).out);
  check(j.nodes.length === 6 && j.counters.executed >= 1 && j.counters.filtered >= 1, "JSON: six stages, executed and filtered counted", JSON.stringify(j.counters));
  check(j.decisions.some((d) => d.action === "filtered" && /Sold this coin in the last 10 minutes/.test(d.reason)), "JSON: the refusal's reason", JSON.stringify(j.decisions.slice(0, 4)));
  return `${j.counters.executed} executed · ${j.counters.filtered} filtered · ${j.decisions.length} decisions`;
});

await step("Launch page → hand to the agent: queued launch signed by the agent, then run by it", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const plan = { launchpad: "pumpfun", mode: "standard", token: { name: "Glow Worm", symbol: "GLOW", description: "e2e launch from the panel", quote: "SOL", creatorFees: "creator" }, devBuySol: 0.1, jitoTipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 10, team: null };
    const bundles = m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length;
    m.queueOp({ op: "launch", plan, imageDataUrl: png, exit: { timeSells: [{ afterSec: 3, sellPct: 100 }] }, run: { updates: false, claimFees: true, buybackPct: 0, burnBuybacks: false } });
    await a.waitFor(/Launched Glow Worm \(\$GLOW\) from the panel on pump\.fun/, 15_000);
    check(m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length === bundles + 1, "one Jito bundle, signed by the agent");
    await a.waitFor(/Running \$GLOW: fee claims/, 5_000);
    const sold = await a.waitFor(/Sold 100% of GLOW for ([\d.]+) SOL/, 15_000);
    await vesk(["stop"]);
    await a.waitExit();
    return `launched, run settings applied, timed sell after 3 s (${sold[1]} SOL)`;
  } finally { a.p.kill(); }
});

await step("Launch page, v22 settings: USDC quote pair and holder rewards reach the create request; no tip, no bundle", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    // v26: the agent reads a custom pair's mint on chain before building; the mock chain knows USDC as an SPL mint
    m.addSpecialMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", { program: "spl" });
    const plan = { launchpad: "pumpfun", mode: "standard", token: { name: "Tide Pool", symbol: "TIDE", description: "e2e v22 launch params", quote: "USDC", creatorFees: "holders", creatorFeePct: 0.25 }, devBuySol: 0.05, jitoTipSol: 0, priorityFeeSol: 0, slippagePct: 10, team: null };
    const bundles = m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length;
    m.queueOp({ op: "launch", plan, imageDataUrl: png });
    await a.waitFor(/Launched Tide Pool \(\$TIDE\) from the panel on pump\.fun/, 15_000);
    const build = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "create").pop();
    const f = build?.fields ?? {};
    // the field names come from core/src/launch/capabilities.ts (TODO-verify against PumpPortal on the first live launch)
    check(f.quoteMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "the create request carries the USDC quote mint", JSON.stringify(f));
    check(f.creatorFeeRecipient === "holders", "the create request carries holder rewards", JSON.stringify(f));
    check(f.creatorFeeBps === "25", "v26: the create request carries the 0.25% creator fee as basis points", JSON.stringify(f));
    check(/USDC quote mint checked on chain: SPL Token, 6 decimals/.test(a.out), "v26: the USDC mint was read on chain first", a.out.slice(-800));
    check(build.amount === 0.05 && build.priorityFee === 0, "create + dev buy in one request, priority fee 0", JSON.stringify(build));
    check(m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length === bundles, "sent through the RPC, no Jito bundle");
    await vesk(["stop"]);
    await a.waitExit();
    return "USDC quote + holder rewards on the create request · one transaction · no tip";
  } finally { a.p.kill(); }
});
await step("Claim page: SOL creator fees claimed; USDC creator fees claimed with the quote field and kept in USDC (v26: no swap)", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    m.setCreatorFees(S.wallet, { sol: 0.3, tokens: { [USDC]: 25 } });
    const sol0 = m.balance(S.wallet);
    m.queueOp({ op: "claim-fees", mint: S.mint, quote: "SOL" });
    await a.waitFor(/claimed 0\.3\d* SOL creator fees/, 15_000);
    const solClaim = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "collectCreatorFee").pop();
    check(solClaim && solClaim.fields.quoteMint === undefined, "SOL claim: plain collectCreatorFee (the tested path)", JSON.stringify(solClaim?.fields));
    check(m.balance(S.wallet) - sol0 > 0.29, `0.3 SOL arrived (${(m.balance(S.wallet) - sol0).toFixed(4)})`);
    const sol1 = m.balance(S.wallet);
    m.queueOp({ op: "claim-fees", mint: S.mint, quote: "USDC" });
    await a.waitFor(/claimed 25\.00 USDC creator fees/, 15_000);
    const usdcClaim = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "collectCreatorFee").pop();
    // the quote field name comes from core/src/launch/capabilities.ts (TODO-verify on the first live claim)
    check(usdcClaim.fields.quoteMint === USDC, "USDC claim: the quote field carries the USDC mint", JSON.stringify(usdcClaim.fields));
    check(!m.log.some((l) => l.svc === "jup" && l.what === "swap" && l.inputMint === USDC), "nothing is swapped");
    check(m.tokenBalance(S.wallet, USDC) === 25 && m.balance(S.wallet) <= sol1, `the 25 USDC stay in the wallet (${m.tokenBalance(S.wallet, USDC)})`);
    await vesk(["stop"]);
    await a.waitExit();
    return "SOL claim 0.3 · USDC claim 25, kept in USDC";
  } finally { a.p.kill(); }
});
await step("v26 creator fee range: vesk launch --quote USDC --creator-fee 0.25 sends 25 bps; SOL refuses a fee, 0.07% and 1.5% are refused", async () => {
  writeFileSync(join(home, "kelp.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const base = ["launch", "--name", "Kelp Bed", "--ticker", "KELP", "--image", "./kelp.png", "--dev-buy", "0.05", "--yes"];
  const sol = await vesk([...base, "--creator-fee", "0.25"]);
  check(sol.code !== 0 && /fixed by pump\.fun/.test(sol.out), "SOL pair: --creator-fee is refused (pump.fun fixes it)", sol.out);
  for (const bad of ["0.07", "1.5"]) {
    const r = await vesk([...base, "--quote", "USDC", "--creator-fee", bad]);
    check(r.code !== 0 && /0\.05-1% in 0\.05% steps/.test(r.out), `${bad}% is refused`, r.out);
  }
  const creates = () => m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "create").length;
  const n0 = creates();
  const r = await vesk([...base, "--quote", "USDC", "--creator-fee", "0.25"]);
  check(r.code === 0 && /launched/.test(r.out), "launched with a USDC pair", r.out);
  check(/creator fee 0\.25% \(0\.05-1%, paid in USDC\)/.test(r.out) && /Not yet verified on a live launch: USDC quote pair, the USDC creator fee/.test(r.out) && /lock once the coin is set up/.test(r.out), "the CLI shows the fee, says it's unverified and that it locks", r.out);
  const f = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "create").pop()?.fields ?? {};
  check(creates() === n0 + 1 && f.quoteMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && f.creatorFeeBps === "25", "the create request carries the USDC mint and 25 bps (TODO-verify field names)", JSON.stringify(f));
  check(f.creatorFeeRecipient === undefined, "fees to the creator: no holder-rewards field");
  return "SOL: no fee · USDC 0.25% → creatorFeeBps 25 · 0.07 / 1.5 refused";
});
await step("v23/v26 vesk claim --all: one claim per asset (SOL plain, USDC with its quote field), kept in that asset; holder coin skipped", async () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const list = await vesk(["claim", "--json"]);
  const j = JSON.parse(list.out.slice(list.out.indexOf("{")));
  const by = Object.fromEntries(j.rows.map((x) => [x.symbol, x]));
  check(by.KELP?.quote === "USDC" && by.TIDE?.mode === "holders" && by.GLOW?.quote === "SOL", "rows: every coin this agent launched, with its pair and where rewards go", JSON.stringify(j.rows.map((x) => [x.symbol, x.quote, x.mode])));
  check(j.rows.every((x) => x.unclaimed === null), "unclaimed isn't guessed (the venue doesn't report it to the agent)");
  check(JSON.stringify(j.groups.map((g) => g.asset)) === '["SOL","USDC"]' && !j.groups.some((g) => g.symbols.includes("TIDE")), "two claims, SOL then USDC; the holder-rewards coin isn't one", JSON.stringify(j.groups));
  m.setCreatorFees(S.wallet, { sol: 0.25, tokens: { [USDC]: 18 } });
  const mark = m.log.length;
  const sol0 = m.balance(S.wallet);
  const usdc0 = m.tokenBalance(S.wallet, USDC);
  const r = await vesk(["claim", "--all", "--yes"]);
  const builds = m.log.slice(mark).filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "collectCreatorFee");
  check(builds.length === 2 && builds[0].fields.quoteMint === undefined && builds[1].fields.quoteMint === USDC, "SOL claim is plain collectCreatorFee; the USDC claim carries the quote mint", JSON.stringify(builds.map((b) => b.fields)));
  check(/claimed 0\.2\d* SOL/.test(r.out) && /claimed 18\.00 USDC/.test(r.out), "both claims landed", r.out);
  check(!/swap|Jupiter/i.test(r.out) && !m.log.slice(mark).some((l) => l.svc === "jup" && (l.what === "swap" || l.what === "quote")), "no swap, no Jupiter quote", r.out);
  check(Math.abs(m.tokenBalance(S.wallet, USDC) - usdc0 - 18) < 1e-6 && m.balance(S.wallet) - sol0 > 0.24, `18 USDC arrived and stay in USDC; SOL up ${(m.balance(S.wallet) - sol0).toFixed(4)}`, r.out);
  const t = await vesk(["treasury"]);
  check(/Claimed 18\.00 USDC in creator fees/.test(t.out), "the treasury report lists the USDC claim in USDC", t.out);
  return "SOL 0.25 + USDC 18, each in its own asset";
});
await step("v23 chat: \"claim my fees\" runs the same grouped claim after a confirm", async () => {
  m.setCreatorFees(S.wallet, { sol: 0.05, tokens: {} });
  const mark = m.log.length;
  const r = await vesk(["chat", "claim my fees", "--yes"]);
  check(/understood/.test(r.out) && /Claim: creator fees from every coin you launched/.test(r.out), "chat shows what it understood", r.out);
  check(/claimed 0\.05\d* SOL/.test(r.out), "and claims", r.out);
  check(m.log.slice(mark).filter((l) => l.svc === "pump" && l.action === "collectCreatorFee").length === 2, "one claim per asset (SOL, USDC)");
  return "chat → 2 claims";
});
await step("v25 vesk burn: the plan, the gone-forever confirm, one BurnChecked from the dev wallet (checked by the mock chain), in the treasury report; chat burn; more than held refused; vesk lock says Soon and sends nothing", async () => {
  const list = JSON.parse((await vesk(["claim", "--json"])).out.replace(/^[^{]*/, ""));
  const kelp = list.rows.find((x) => x.symbol === "KELP");
  check(!!kelp, "KELP is one of the coins this agent launched");
  const held0 = m.tokenBalance(S.wallet, kelp.mint);
  check(held0 > 0, `the dev wallet holds KELP from its dev buy (${held0})`);
  const burns = () => m.log.filter((l) => l.svc === "rpc" && l.what === "burn");
  const sends = () => m.log.filter((l) => l.svc === "rpc" && l.what === "sendTransaction").length;
  const noYes = await vesk(["burn", "$KELP", "10%", "--json"]);
  check(noYes.code !== 0 && /needs --yes/.test(noYes.out) && burns().length === 0, "--json without --yes burns nothing (it's permanent)", noYes.out);
  const over = await vesk(["burn", "$KELP", String(Math.ceil(held0 * 10)), "--yes"]);
  check(over.code !== 0 && /more than you hold/.test(over.out) && burns().length === 0, "more than you hold is refused before anything is built", over.out);
  const r = await vesk(["burn", "$KELP", "25%", "--yes"]);
  check(r.code === 0 && /Burn \$KELP/.test(r.out) && /25\.00% of your holding/.test(r.out) && /burned/.test(r.out), "the plan, then burned", r.out);
  const b = burns().pop();
  check(b && b.mint === kelp.mint && b.owner === S.wallet && b.decimals === 6 && b.program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "one BurnChecked: the owner's ATA, the mint, decimals 6, the SPL Token program, signed by the owner", JSON.stringify(b));
  check(Math.abs(b.amount - Math.floor(held0 * 1e6 * 0.25)) <= 1, `25% of the holding in base units (${b.amount})`);
  const held1 = m.tokenBalance(S.wallet, kelp.mint);
  check(Math.abs(held1 - held0 * 0.75) < 1e-5, `the mock chain holds 75% after (${held0} → ${held1})`);
  const t = await vesk(["treasury"]);
  check(/Burned [\d.,]+[kKmMbB]? tokens\. Tx: https:\/\/solscan\.io\/tx\/\w+/.test(t.out), "the treasury report lists the burn with its transaction", t.out);
  const c = await vesk(["chat", "burn 10% of $KELP", "--yes"]);
  check(/understood/.test(c.out) && /Burn: 10% of what you hold of \$KELP/.test(c.out) && /Burned tokens are gone forever/.test(c.out) && /burned/.test(c.out), "chat: \"burn 10% of $KELP\" shows the plan and burns after the confirm", c.out);
  check(burns().length === 2, "two burns in all");
  const s0 = sends();
  const l = await vesk(["lock", "$KELP", "20%", "--days", "90"]);
  check(l.code === 2 && /Lock \$KELP/.test(l.out) && /Soon/.test(l.out) && /isn't available yet/.test(l.out) && sends() === s0, "vesk lock shows the plan, says it isn't available yet and sends nothing", l.out);
  return `burned 25% then 10% of ${held0.toFixed(0)} KELP; lock: Soon`;
});
await step("v26 launch on post: a post → triggers → the ticker clash check (renamed) → the NVDAx mint read on chain → create with the custom pair and its fee → race report; stats, races, pairs, backtest", async () => {
  const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
  m.addSpecialMint(NVDAX, { program: "t22" });
  const pairs = await vesk(["pairs", "--search", "nvda"]);
  check(pairs.code === 0 && /NVDAx/.test(pairs.out) && /Listed/.test(pairs.out), "vesk pairs lists NVDAx: Listed", pairs.out);
  const pend = await vesk(["pairs", "--json", "--category", "stock"]);
  check(/"id":"BA"[^}]*"mint":"BArimz1PcKZr8PcPh3tcZ2dg4S7FJLk3cw6R5F8GsHKg"[^}]*"status":"listed"/.test(pend.out.replace(/\s+/g, "")) && !/"status":"unavailable"/.test(pend.out.replace(/\s+/g, "")), "every stock on pump.fun's list has its mint (BA: Listed); none is Not available yet", pend.out.slice(0, 400));
  const add = await vesk(["rules", "add", "--launch-on-post", "@tidewatch", "--dev-buy", "0.1", "--image", "mine", "--default-image", png, "--naming", "template", "--name", "{Word}", "--ticker", "{WORD}",
    "--pair", "NVDAx", "--creator-fee", "0.25", "--clash", "rename", "--exclude", "giveaway", "--auto", "--cooldown", "0", "--per-hour", "5", "--max-sol", "0.5", "--race-window", "2", "--yes"]);
  const rid = add.out.match(/Saved as (lp_\w+)/)?.[1];
  check(add.code === 0 && rid && /Pair NVDAx, creator fee 0\.25% paid in NVDAx/.test(add.out) && /rename the ticker/.test(add.out), "the rule: NVDAx pair at 0.25%, rename on a clash", add.out);
  const refused = await vesk(["rules", "add", "--launch-on-post", "@tidewatch", "--pair", "NOTAPAIR", "--yes"]);
  check(refused.code !== 0 && /isn't in the pair list/.test(refused.out), "a pair that isn't on the list is refused", refused.out);
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/Watching pump\.fun creates/);
    await a.waitFor(/Watching \d+ X accounts? via vesk-relay/);
    await until(() => m.relayCount() > 0 && m.pumpDataCount() > 0);
    // someone already launched $LIGHTHOUSE: the rule renames ours
    m.pushPumpData({ txType: "create", mint: m.newKeypair().publicKey.toBase58(), name: "Other Light", symbol: "LIGHTHOUSE", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 0, solAmount: 0, vTokensInBondingCurve: 1, vSolInBondingCurve: 30, marketCapSol: 28 }, { name: "Other Light", symbol: "LIGHTHOUSE" });
    await sleep(400);
    m.relayBroadcast({ id: "2001", handle: "tidewatch", text: "A new lighthouse opens on the point tonight.", image: "https://pbs.mock/light.jpg" });
    await a.waitFor(/renamed to \$LIGHTHOUS2/, 15_000);
    await a.waitFor(/NVDAx quote mint checked on chain: Token-2022, 6 decimals/, 15_000);
    const landed = await a.waitFor(/\$LIGHTHOUS2: post received → landed in (\d+) ms/, 20_000);
    const build = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "create").pop();
    check(build?.fields?.quoteMint === NVDAX && build.fields.creatorFeeBps === "25" && build.fields.creatorFeeRecipient === undefined, "the create carries the NVDAx mint and 25 bps (TODO-verify field names)", JSON.stringify(build?.fields));
    const up = m.uploads[m.uploads.length - 1];
    check(up.symbol === "LIGHTHOUS2" && up.description.includes("Inspired by a post from @tidewatch. Not affiliated with or endorsed by them.") && /x\.com\/tidewatch\/status\/2001/.test(up.website ?? ""), "renamed ticker, the disclaimer, the post as the source link", JSON.stringify(up));
    // two more coins for the same post land after ours: one links the post, one copies the name
    m.pushPumpData({ txType: "create", mint: m.newKeypair().publicKey.toBase58(), name: "Point Light", symbol: "POINT", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 0, solAmount: 0, vTokensInBondingCurve: 1, vSolInBondingCurve: 30, marketCapSol: 28 }, { name: "Point Light", symbol: "POINT", website: "https://x.com/tidewatch/status/2001" });
    m.pushPumpData({ txType: "create", mint: m.newKeypair().publicKey.toBase58(), name: "Lighthouse", symbol: "LHOUSE", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 0, solAmount: 0, vTokensInBondingCurve: 1, vSolInBondingCurve: 30, marketCapSol: 28 }, { name: "Lighthouse", symbol: "LHOUSE" });
    const race = await a.waitFor(/Race report \$LIGHTHOUS2: 1st of 3 · ([\d.]+ (?:s|ms)) after the post/, 15_000);
    // an excluded word never launches
    m.relayBroadcast({ id: "2002", handle: "tidewatch", text: "Lighthouse giveaway tonight!", image: "https://pbs.mock/g.jpg" });
    await sleep(2000);
    await vesk(["stop"]);
    await a.waitExit();
    check(!/LIGHTHOUS3|Giveaway/.test(a.out), "the excluded post didn't launch", a.out.slice(-600));
    const rr = await vesk(["races", "$LIGHTHOUS2"]);
    check(/1st of 3/.test(rr.out) && /Point Light \$POINT/.test(rr.out) && /post/.test(rr.out), "vesk races shows the ranking and how each one matched", rr.out);
    const st = JSON.parse((await vesk(["rules", "stats", rid, "--json"])).out.replace(/^[^[]*/, ""));
    check(st[0].launches === 1 && st[0].firsts === 1 && st[0].firstRate === 1 && st[0].medianMs > 0, "per-rule stats: 1 launch, first place, a median time", JSON.stringify(st));
    const bt = await vesk(["rules", "backtest", rid]);
    check(bt.code === 0 && /Backtest/.test(bt.out) && /nothing was spent/.test(bt.out), "backtest runs on the X history and spends nothing", bt.out);
    const ex = await vesk(["chat", "launch a coin when @tidewatch posts with a picture, pair it with USDC, 0.5% fee"]);
    check(/Pair USDC, creator fee 0\.5% paid in USDC/.test(ex.out) && /picture/.test(ex.out), "chat: \"launch a coin when @x posts with a picture, pair it with USDC, 0.5% fee\" drafts the rule", ex.out);
    const chat = await vesk(["chat", "race report for $LIGHTHOUS2"]);
    check(/1st of 3/.test(chat.out), "chat: \"race report for $LIGHTHOUS2\"", chat.out);
    return `renamed to $LIGHTHOUS2 · NVDAx pair at 25 bps · landed in ${landed[1]} ms · race: 1st of 3, ${race[1]} after the post`;
  } finally { a.p.kill(); }
});
await step("v26 pair mint validation: NVDAx verified on chain (and shown so); ZEC verified with its freeze authority disclosed; HYPE (no account) and TSLAx (not a mint) refused with the reason; a symbol not on the list is refused; a launch on a bad mint builds nothing", async () => {
  const ZEC = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
  m.addSpecialMint(ZEC, { program: "spl", freeze: m.newKeypair().publicKey.toBase58() });
  m.addSpecialMint(TSLAX, { program: "spl", kind: "account" });
  const ok = await vesk(["pairs", "--check", "NVDAx"]);
  check(ok.code === 0 && /Verified on-chain/.test(ok.out) && /Token-2022, 6 decimals/.test(ok.out), "vesk pairs --check NVDAx: verified on chain (Token-2022, 6 decimals)", ok.out);
  const shown = await vesk(["pairs", "--seen", "--search", "nvda"]);
  check(/NVDAx[^\n]*Verified on-chain/.test(shown.out), "the list now shows NVDAx as Verified on-chain (the check is remembered)", shown.out);
  const z = await vesk(["pairs", "--check", "ZEC"]);
  check(z.code === 0 && /Verified on-chain/.test(z.out) && /the issuer can freeze it/.test(z.out), "ZEC: verified, its freeze authority disclosed (not refused)", z.out);
  const h = await vesk(["pairs", "--check", "HYPE"]);
  check(h.code === 2 && /Refused/.test(h.out) && /no account at that address/.test(h.out), "HYPE: refused, no account at that address on this chain", h.out);
  const x = await vesk(["pairs", "--check", "TSLAx"]);
  check(x.code === 2 && /isn't a token mint/.test(x.out), "TSLAx: refused, the account at that address isn't a mint", x.out);
  // a wrong-decimals mint is refused too: covered by packages/core/test/v26.test.ts (only USDC has fixed decimals, and later steps use it)
  const unk = await vesk(["pairs", "--check", "NOTAPAIR"]);
  check(unk.code !== 0 && /isn't in the pair list/.test(unk.out), "a symbol not on the list: refused, nothing guessed", unk.out);
  const creates = () => m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.action === "create").length;
  const n0 = creates();
  const r = await vesk(["launch", "--name", "Quay", "--ticker", "QUAY", "--image", "./kelp.png", "--dev-buy", "0.05", "--quote", "TSLAx", "--creator-fee", "0.25", "--yes"]);
  check(r.code !== 0 && /failed its on-chain check/.test(r.out) && /isn't a token mint/.test(r.out), "a launch on TSLAx (not a mint here) is refused with the reason", r.out);
  check(creates() === n0, "nothing was built or sent");
  return "NVDAx verified · ZEC verified, freeze disclosed · HYPE / TSLAx refused (no account / not a mint) · unknown symbol refused · launch refused, nothing built";
});
await step("v26 clash skip (same ticker launched first) · \"Ask me\" naming: the draft waits for your name, then launches · race report · backtest from the tracker's stored posts (no X history)", async () => {
  const add = await vesk(["rules", "add", "--launch-on-post", "@quaywatch", "--dev-buy", "0.05", "--image", "mine", "--default-image", png, "--naming", "template", "--name", "{Word}", "--ticker", "{WORD}",
    "--pair", "USDC", "--creator-fee", "0.1", "--clash", "skip", "--auto", "--cooldown", "0", "--per-hour", "5", "--max-sol", "0.5", "--yes"]);
  const skipRule = add.out.match(/Saved as (lp_\w+)/)?.[1];
  check(add.code === 0 && skipRule && /launched in the last 120 s: skip/.test(add.out), "rule 1: USDC pair, skip on a clash", add.out);
  const askAdd = await vesk(["rules", "add", "--launch-on-post", "@pierlight", "--dev-buy", "0.05", "--image", "mine", "--default-image", png, "--naming", "ask", "--confirm-ttl", "120", "--cooldown", "0", "--per-hour", "5", "--max-sol", "0.5", "--race-window", "2", "--yes"]);
  const askRule = askAdd.out.match(/Saved as (lp_\w+)/)?.[1];
  check(askAdd.code === 0 && askRule && /you name it on the draft card/.test(askAdd.out), "rule 2: \"Ask me\" naming in Confirm mode", askAdd.out);
  const autoAsk = await vesk(["rules", "add", "--launch-on-post", "@pierlight", "--naming", "ask", "--auto", "--yes"]);
  check(autoAsk.code !== 0 && /needs Confirm mode/.test(autoAsk.out), "\"Ask me\" with Auto is refused", autoAsk.out);
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/Watching pump\.fun creates/);
    await until(() => m.relayCount() > 0 && m.pumpDataCount() > 0);
    // someone already launched $BEACON: the clash rule skips
    m.pushPumpData({ txType: "create", mint: m.newKeypair().publicKey.toBase58(), name: "Beacon", symbol: "BEACON", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 0, solAmount: 0, vTokensInBondingCurve: 1, vSolInBondingCurve: 30, marketCapSol: 28 }, { name: "Beacon", symbol: "BEACON" });
    await sleep(400);
    const before = m.uploads.length;
    m.relayBroadcast({ id: "3001", handle: "quaywatch", text: "Beacon lit at the quay.", image: "https://pbs.mock/beacon.jpg" });
    await a.waitFor(/Launch on @quaywatch post skipped: 1 coin for \$BEACON already launched \(Beacon \$BEACON\); skipped/, 15_000);
    check(m.uploads.length === before, "the clash skip uploaded and built nothing");
    // the ask rule: a draft that waits for a name
    m.relayBroadcast({ id: "3002", handle: "pierlight", text: "Lanterns along the old pier tonight.", image: "https://pbs.mock/pier.jpg" });
    const d = await a.waitFor(/Name it: \/launch (\w+) Name \$TICKER/, 15_000);
    const pl = await vesk(["pending", "--json"]);
    check(/"ask":true/.test(pl.out.replace(/\s+/g, "")) && /"suggestions":\[/.test(pl.out.replace(/\s+/g, "")), "vesk pending shows the draft asking for a name, with suggestions", pl.out.slice(0, 600));
    await vesk(["pending", "launch", d[1]]);
    await a.waitFor(/Name it first: \/launch/, 8_000);
    await vesk(["pending", "launch", d[1], "Pier Lantern", "$PLANT"]);
    await a.waitFor(/\$PLANT: post received → landed in \d+ ms/, 20_000);
    const up = m.uploads[m.uploads.length - 1];
    check(up.symbol === "PLANT" && up.name === "Pier Lantern" && up.description.includes("Inspired by a post from @pierlight. Not affiliated with or endorsed by them."), "launched with your name and ticker, the disclaimer kept", JSON.stringify(up));
    m.pushPumpData({ txType: "create", mint: m.newKeypair().publicKey.toBase58(), name: "Plant", symbol: "PLANT", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 0, solAmount: 0, vTokensInBondingCurve: 1, vSolInBondingCurve: 30, marketCapSol: 28 }, { name: "Plant", symbol: "PLANT" });
    const race = await a.waitFor(/Race report \$PLANT: 1st of 2 · ([\d.]+ (?:s|ms)) after the post/, 15_000);
    await vesk(["stop"]);
    await a.waitExit();
    // no X history (no X API key): the backtest replays what the tracker stored, and says so
    const bt = await vesk(["rules", "backtest", skipRule], { env: { X_BEARER_TOKEN: "" } });
    check(bt.code === 0 && /the tracker's stored posts/.test(bt.out) && /doesn't return post history, so this replays the 1 post the tracker stored/.test(bt.out) && /1 launch from 1 post/.test(bt.out) && /nothing was spent/.test(bt.out), "backtest falls back to the tracker's posts and says so", bt.out);
    return `$BEACON clash skipped · Ask me → named $PLANT, launched · race 1st of 2, ${race[1]} after the post · backtest from 1 stored post`;
  } finally { a.p.kill(); }
});
await step("vesk order: DCA and limit orders reach the running agent; fills pass the guardrails", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const coin = m.newKeypair().publicKey.toBase58();
    const bad = await vesk(["order", "sell", coin, "150", "--above", "0.1"]);
    check(bad.code === 1 && /Sell percent must be 1-100/.test(bad.out), "invalid order refused", bad.out);
    const r = await vesk(["order", "dca", coin, "0.01", "--every", "60", "--times", "2"]);
    check(r.code === 0 && /queued o_/.test(r.out) && /DCA 0\.01 SOL every 60 min, 2 more/.test(r.out), "queued", r.out);
    await a.waitFor(/Order o_\w+ added: DCA/, 8_000);
    await a.waitFor(/Bought 0\.01 SOL of .* via pumpfun/, 12_000);
    const list = await vesk(["orders", "--json"]);
    const o = JSON.parse(list.out.slice(list.out.indexOf("["))).find((x) => x.mint === coin);
    check(o && o.status === "open" && o.remaining === 1, "one DCA buy done, one left", list.out);
    await vesk(["orders", "cancel", o.id]);
    await a.waitFor(new RegExp(`Order ${o.id} cancelled`), 8_000);
    await vesk(["stop"]);
    await a.waitExit();
    return "DCA bought once, cancelled the rest";
  } finally { a.p.kill(); }
});

// The order steps below make 7 buys on 3 new coins; give them their own headroom under the daily limits and put
// the original limits back afterwards, so later steps see exactly the limits they always did.
const CFG = join(home, ".vesk", "vesk.config.yaml");
const cfgBefore = readFileSync(CFG, "utf8");
const STATE = join(home, ".vesk", "state.json");
const stateBefore = JSON.parse(readFileSync(STATE, "utf8"));
/** Put today's buy / spend counters and the open positions back to what they were before the order steps. */
function resetBuysToday() {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  st.buys = stateBefore.buys; st.spentSol = stateBefore.spentSol;
  st.positions = st.positions.filter((p) => stateBefore.positions.some((q) => q.mint === p.mint));
  writeFileSync(STATE, JSON.stringify(st));
}
writeFileSync(CFG, cfgBefore.replace(/maxBuysPerDay: \d+/, "maxBuysPerDay: 40").replace(/maxOpenPositions: \d+/, "maxOpenPositions: 20").replace(/dailySpendCapSol: [\d.]+/, "dailySpendCapSol: 5"));

await step("dev-sell order: the dev sells → our dev-sell buy fires (and only then)", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const coin = m.newKeypair().publicKey.toBase58();
    const dev = m.newKeypair().publicKey.toBase58();
    const bad = await vesk(["order", "dev-sell", coin, "0.02", "--dev", "nope"]);
    check(bad.code === 1 && /dev's wallet address/.test(bad.out), "a dev-sell order without a valid dev wallet is refused", bad.out);
    const r = await vesk(["order", "dev-sell", coin, "0.02", "--dev", dev, "--min", "0.5"]);
    check(r.code === 0 && /when the dev \(\w{4}…\w{4}\) sells ≥ 0\.5 SOL: buy 0\.02 SOL/.test(r.out), "queued", r.out);
    await a.waitFor(/Order o_\w+ added: when the dev/, 8_000);
    await a.waitFor(/Watching dev sells on 1 coin/, 8_000);
    await until(() => m.tradeSubs(coin) > 0, 10_000);
    const sendsBefore = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coin).length;
    m.pushPumpData({ txType: "buy", mint: coin, traderPublicKey: dev, solAmount: 2, tokenAmount: 1e6, signature: "devbuy" + Date.now() });
    m.pushPumpData({ txType: "sell", mint: coin, traderPublicKey: m.newKeypair().publicKey.toBase58(), solAmount: 3, tokenAmount: 1e6, signature: "other" + Date.now() });
    m.pushPumpData({ txType: "sell", mint: coin, traderPublicKey: dev, solAmount: 0.1, tokenAmount: 1e5, signature: "devsmall" + Date.now() });
    await new Promise((res) => setTimeout(res, 1500));
    check(m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coin).length === sendsBefore, "a dev buy, someone else's sell and a dev sell under the minimum don't fire it");
    m.pushPumpData({ txType: "sell", mint: coin, traderPublicKey: dev, solAmount: 1.2, tokenAmount: 4e6, signature: "devsell" + Date.now() });
    await a.waitFor(/Dev \w{4}… sold 1\.200 SOL: order o_\w+ fires/, 8_000);
    await a.waitFor(new RegExp(`Bought 0\\.02 SOL of .* via pumpfun`), 12_000);
    const list = await vesk(["orders", "--json"]);
    const o = JSON.parse(list.out.slice(list.out.indexOf("["))).find((x) => x.mint === coin);
    check(o && o.status === "filled" && o.fills === 1, "order filled once", list.out);
    await until(() => m.tradeSubs(coin) === 0, 8_000).catch(() => undefined);
    check(m.tradeSubs(coin) === 0, "the trade stream for the coin is closed when no dev-sell order is left");
    await vesk(["stop"]);
    await a.waitExit();
    return "dev sold 1.2 SOL → bought 0.02 SOL · ignored a dev buy, a stranger's sell and a dev sell under the minimum";
  } finally { a.p.kill(); }
});

await step("DCA order runs 3 slices on its interval", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const coin = m.newKeypair().publicKey.toBase58();
    const r = await vesk(["order", "dca", coin, "0", "--total", "0.03", "--slices", "3", "--every-sec", "2", "--json"]);
    const q = JSON.parse(r.out).queued;
    check(r.code === 0 && q.amountSol === 0.01 && q.remaining === 3 && q.intervalSec === 2, "0.03 SOL split into 3 slices of 0.01 every 2 s", r.out);
    const t0 = Date.now();
    await a.waitFor(/Order o_\w+ filled \(slice 1\/3\)/, 12_000);
    await a.waitFor(/Order o_\w+ filled \(slice 2\/3\)/, 12_000);
    await a.waitFor(/Order o_\w+ filled \(slice 3\/3\)/, 12_000);
    const took = Date.now() - t0;
    const builds = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coin);
    check(builds.length === 3, `3 buys built (${builds.length})`);
    const list = await vesk(["orders", "--json"]);
    const o = JSON.parse(list.out.slice(list.out.indexOf("["))).find((x) => x.mint === coin);
    check(o && o.status === "filled" && o.fills === 3 && o.remaining === 0, "order filled after 3 slices", list.out);
    check(took >= 3_500, `slices were spaced out (${took} ms for 3)`);
    await vesk(["stop"]);
    await a.waitExit();
    return `3 slices of 0.01 SOL in ${(took / 1000).toFixed(1)} s`;
  } finally { a.p.kill(); }
});

await step("TWAP order schedules its slices and fills them on time", async () => {
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const coin = m.newKeypair().publicKey.toBase58();
    const bad = await vesk(["order", "twap", coin, "0.03", "--over", "3s", "--slices", "3"]);
    check(bad.code === 1 && /10 s to 7 days/.test(bad.out), "a TWAP shorter than 10 s is refused", bad.out);
    const r = await vesk(["order", "twap", coin, "0.03", "--over", "10s", "--weights", "50,30,20"]);
    check(r.code === 0 && /TWAP buy 0\.03 SOL over 10 s in 3 slices, 3 left/.test(r.out), "queued", r.out);
    check((r.out.match(/slice \d/g) ?? []).length === 3 && /0\.015 SOL/.test(r.out) && /0\.009 SOL/.test(r.out) && /0\.006 SOL/.test(r.out), "schedule printed: 50/30/20 split", r.out);
    const t0 = Date.now();
    await a.waitFor(/Order o_\w+ filled \(slice 1\/3\)/, 10_000);
    await a.waitFor(/Order o_\w+ filled \(slice 2\/3\)/, 12_000);
    const mid = Date.now() - t0;
    await a.waitFor(/Order o_\w+ filled \(slice 3\/3\)/, 12_000);
    const took = Date.now() - t0;
    const amounts = m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coin).map((l) => l.amount);
    check(amounts.length === 3, `3 buys built (${amounts.join(", ")})`);
    check(mid >= 3_000 && took >= 8_000, `slices followed the schedule (2nd at ${mid} ms, 3rd at ${took} ms)`);
    await vesk(["stop"]);
    await a.waitExit();
    return `slices at +0 / +${(mid / 1000).toFixed(0)} / +${(took / 1000).toFixed(0)} s (0.015 / 0.009 / 0.006 SOL)`;
  } finally { a.p.kill(); }
});

writeFileSync(CFG, cfgBefore);
// The order steps' buys count toward today's buys; the steps after them were written for the original count.
resetBuysToday();

await step("Pulse: a column filter matches a new coin, quick buy with P2 lands as a Jito bundle only", async () => {
  const dir = join(home, "pulse-e2e");
  mkdirSync(dir, { recursive: true });
  const trading = { buy: { p2: { slippagePct: 22, priorityFeeSol: 0.0015, jitoTipSol: 0.002, autoFee: false, maxFeeSol: 0.01, mev: "reduced" } } };
  writeFileSync(join(dir, "trading.json"), JSON.stringify(trading));
  const imp = await vesk(["trading", "import", join(dir, "trading.json")]);
  check(imp.code === 0 && /imported/.test(imp.out), "trading settings imported", imp.out);
  const bad = { buy: { p1: { slippagePct: 22, priorityFeeSol: 0.001, jitoTipSol: 0, mev: "secure" } } };
  writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
  const refused = await vesk(["trading", "import", join(dir, "bad.json")]);
  check(refused.code === 1 && /Jito only, so it needs a tip/.test(refused.out), "MEV protection without a tip refused", refused.out);
  writeFileSync(join(dir, "filter.json"), JSON.stringify({ keywords: ["glass"], audits: { devPct: { max: 10 } }, socials: { x: true } }));
  const tipAcct = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
  const tipBefore = m.balance(tipAcct);
  const a = agent(["pulse", "--filter", join(dir, "filter.json"), "--buy", "0.05", "--preset", "p2", "--max", "1", "--for", "30"]);
  try {
    await until(() => m.pumpDataCount() > 0);
    const dull = m.newKeypair().publicKey.toBase58();
    const glass = m.newKeypair().publicKey.toBase58();
    const dev = m.newKeypair().publicKey.toBase58();
    // a coin whose dev holds 40% and has no X: filtered out
    m.pushPumpData({ txType: "create", mint: dull, name: "Glass Dull", symbol: "DULL", traderPublicKey: dev, initialBuy: 400_000_000, solAmount: 12, vSolInBondingCurve: 42, marketCapSol: 55, pool: "pump" }, { twitter: "" });
    // a coin that matches: keyword, dev 2%, X link in its metadata
    m.pushPumpData({ txType: "create", mint: glass, name: "Glasshouse", symbol: "GLASS", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 20_000_000, solAmount: 0.6, vSolInBondingCurve: 30.6, marketCapSol: 28.6, pool: "pump" }, { twitter: "https://x.com/glasshouse_e2e", image: "https://ipfs.mock/glass.png" });
    const sendsBefore = m.log.filter((l) => l.svc === "rpc" && l.what === "sendTransaction").length;
    await a.waitFor(/Pulse quick buy: 0\.05 SOL of GLASS · Jito bundle only/, 20_000);
    const build = m.log.find((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === glass);
    check(build && build.priorityFee === 0.0015 && build.slippage === 22, "built with P2 priority fee and slippage", JSON.stringify(build));
    check(m.log.some((l) => l.svc === "jito" && l.what === "bundle" && l.size === 2), "trade + tip sent as one Jito bundle");
    check(m.log.filter((l) => l.svc === "rpc" && l.what === "sendTransaction").length === sendsBefore, "nothing sent through the RPC (no public mempool fallback)");
    check(Math.abs(m.balance(tipAcct) - tipBefore - 0.002) < 1e-9, `P2 Jito tip paid (${(m.balance(tipAcct) - tipBefore).toFixed(4)} SOL)`);
    check(m.tokenBalance(S.wallet, glass) > 0 && m.tokenBalance(S.wallet, dull) === 0, "only the matching coin was bought");
    check(/DULL/.test(a.out) === false, "the 40%-dev coin never showed in the filtered column", a.out);
    await a.waitExit();
    return "filtered 1 of 2 · P2 fees · Jito-only bundle with a 0.002 SOL tip";
  } finally { a.p.kill(); }
});

await step("migration snipe: a migration event fires an armed P2 buy as a Jito bundle; a blacklisted coin is refused", async () => {
  const coin = m.newKeypair().publicKey.toBase58();
  const banned = m.newKeypair().publicKey.toBase58();
  const bl = await vesk(["blacklist", "add", "mint", banned, "--note", "e2e fake"]);
  check(bl.code === 0 && /Added to contract addresses/.test(bl.out), "blacklisted a coin", bl.out);
  const o1 = await vesk(["migration", "buy", coin, "0.07", "--preset", "p2"]);
  check(o1.code === 0 && /armed/.test(o1.out), "armed a buy on migration", o1.out);
  const o2 = await vesk(["migration", "buy", banned, "0.05"]);
  check(o2.code === 0, "armed a buy on the blacklisted coin (refused at fire time)", o2.out);
  const bad = await vesk(["migration", "sell", coin, "150"]);
  check(bad.code === 1 && /1-100%/.test(bad.out), "bad sell % rejected", bad.out);
  const tipAcct = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
  const tipBefore = m.balance(tipAcct);
  const bundlesBefore = m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length;
  const a = agent(["migration", "watch", "--for", "30"]);
  try {
    await until(() => m.migrationSubs() > 0);
    // an unrelated migration does nothing
    m.pushPumpData({ txType: "migrate", mint: m.newKeypair().publicKey.toBase58(), pool: "pump-amm" });
    m.pushPumpData({ txType: "migrate", mint: coin, pool: "pump-amm", signature: "mig1" });
    m.pushPumpData({ txType: "migrate", mint: banned, pool: "pump-amm", signature: "mig2" });
    await a.waitFor(/On migration: buy 0\.07 SOL .* · done/, 20_000);
    await a.waitFor(/refused: Not bought: the contract address is on your blacklist/, 20_000);
    await a.waitExit();
    const build = m.log.find((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coin);
    check(build && build.priorityFee === 0.0015 && build.slippage === 22, "built with P2 fees", JSON.stringify(build));
    check(m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length === bundlesBefore + 1, "exactly one Jito bundle (the banned coin never got built)");
    check(Math.abs(m.balance(tipAcct) - tipBefore - 0.002) < 1e-9, "P2 tip paid");
    check(m.tokenBalance(S.wallet, coin) > 0 && m.tokenBalance(S.wallet, banned) === 0, "bought the migrated coin, not the blacklisted one");
    check(!m.log.some((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === banned), "no transaction built for the blacklisted coin");
    const list = JSON.parse((await vesk(["migration", "--json"])).out);
    const st = Object.fromEntries(list.map((o) => [o.mint, o.status]));
    check(st[coin] === "done" && st[banned] === "failed", "orders settled: done / failed (never re-armed)", JSON.stringify(st));
    return "migrate event → P2 buy via Jito bundle · blacklist refused the other";
  } finally { a.p.kill(); }
});

// ---------------------------------------------------------------- copy trading
await step("copy trading: a tracked wallet's buy is copied via Jito, one above max mcap is skipped with the reason, a Jupiter-route buy arrives over the RPC, a 50% sell is mirrored", async () => {
  const target = m.newKeypair().publicKey.toBase58();
  const [coinA, coinB, coinC] = [0, 1, 2].map(() => m.newKeypair().publicKey.toBase58());
  const add = await vesk(["copy", "add", target, "--label", "degen", "--sol", "0.05", "--max-mcap", "300k", "--min-liq", "1", "--max-dev", "off", "--max-top10", "off", "--tp", "2x:50,5x:100", "--sl", "30", "--mode", "auto", "--preset", "p2", "--sells", "mirror"]);
  check(add.code === 0 && /Tracking degen/.test(add.out) && /skip above \$300k mcap/.test(add.out), "tracked a wallet with its settings", add.out);
  const bad = await vesk(["copy", "add", "not-an-address"]);
  check(bad.code === 1 && /isn't a Solana address/.test(bad.out), "bad address rejected", bad.out);
  const builds = (mint, action) => m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === mint && l.action === action).length;
  const bundlesBefore = m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length;
  const a = agent(["copy", "watch", "--for", "40"]);
  try {
    await until(() => m.accountSubs(target) > 0 && m.logSubs(target) > 0, 20_000);
    // 1) their pump.fun buy at $45k mcap (0.3 SOL × $150) → copied 0.05 SOL with P2 through Jito. Delivered twice: copied once.
    const buyA = { txType: "buy", traderPublicKey: target, mint: coinA, solAmount: 1.2, tokenAmount: 40_000_000, newTokenBalance: 40_000_000, marketCapSol: 300, pool: "pump", signature: "tgtBuyA1" };
    m.pushPumpData(buyA);
    m.pushPumpData(buyA);
    await a.waitFor(/degen bought 1\.2 SOL of .* → copied 0\.05 SOL in \d+ ms/, 20_000);
    // 2) a buy at $412k mcap → skipped with the reason, nothing built
    m.pushPumpData({ txType: "buy", traderPublicKey: target, mint: coinB, solAmount: 2, tokenAmount: 5_000_000, newTokenBalance: 5_000_000, marketCapSol: 412_000 / 150, pool: "pump", signature: "tgtBuyB1" });
    await a.waitFor(/skipped: mcap \$412k > max \$300k/, 20_000);
    // 3) a Jupiter-route buy PumpPortal doesn't carry: logsSubscribe → getTransaction → classified → copied
    const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
    const ui = (n) => ({ amount: String(n * 1e6), decimals: 6, uiAmount: n, uiAmountString: String(n) });
    m.pushLogs(target, "tgtJupC1", {
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err: null, fee: 5000, preBalances: [3e9, 1, 1], postBalances: [3e9 - 0.8e9 - 5000 - 2039280, 1, 1], preTokenBalances: [], postTokenBalances: [{ accountIndex: 3, mint: coinC, owner: target, uiTokenAmount: ui(20_000_000) }], innerInstructions: [{ index: 0, instructions: [{ programId: CPMM }] }], logMessages: [`Program ${JUP} invoke [1]`, `Program ${CPMM} invoke [2]`] },
      transaction: { signatures: ["tgtJupC1"], message: { accountKeys: [{ pubkey: target, signer: true, writable: true }, { pubkey: JUP, signer: false, writable: false }, { pubkey: CPMM, signer: false, writable: false }], instructions: [{ programId: JUP }] } },
    });
    await a.waitFor(/degen bought 0\.8 SOL of .* → copied 0\.05 SOL/, 20_000);
    // 4) they sell 50% of coin A → we mirror 50%
    const ourA = m.tokenBalance(S.wallet, coinA);
    m.pushPumpData({ txType: "sell", traderPublicKey: target, mint: coinA, solAmount: 0.7, tokenAmount: 20_000_000, newTokenBalance: 20_000_000, marketCapSol: 320, pool: "pump", signature: "tgtSellA1" });
    await a.waitFor(/degen sold 50% of .* → sold 50% in \d+ ms/, 20_000);
    // an unrelated wallet's trade is never delivered or copied
    m.pushPumpData({ txType: "buy", traderPublicKey: m.newKeypair().publicKey.toBase58(), mint: m.newKeypair().publicKey.toBase58(), solAmount: 1, tokenAmount: 1, marketCapSol: 10, signature: "other1" });
    await sleep(800);
    check(builds(coinA, "buy") === 1, "their buy delivered twice was copied once (dedupe by signature)");
    check(builds(coinB, "buy") === 0, "nothing built for the coin above max mcap");
    check(builds(coinC, "buy") === 1, "the Jupiter-route buy from the RPC path was copied");
    const build = m.log.find((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coinA && l.action === "buy");
    check(build.amount === 0.05 && build.priorityFee === 0.0015 && build.slippage === 22, "built with the copy size and P2 fees", JSON.stringify(build));
    check(m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length >= bundlesBefore + 3, "buys and the mirrored sell went as Jito bundles (P2 = MEV protection)");
    const afterA = m.tokenBalance(S.wallet, coinA);
    check(ourA > 0 && Math.abs(afterA - ourA / 2) / ourA < 0.01, `mirrored half of our coin A position (${ourA} → ${afterA})`);
    await a.waitExit(15_000).catch(() => undefined);
  } finally { a.p.kill(); }
  const feed = JSON.parse((await vesk(["copy", "feed", "--json"])).out);
  const by = (sig) => feed.find((i) => i.theirSig === sig);
  check(by("tgtBuyA1")?.status === "copied" && by("tgtBuyA1").source === "pumpportal" && by("tgtBuyA1").amountSol === 0.05, "feed: buy A copied from PumpPortal", JSON.stringify(by("tgtBuyA1")));
  check(by("tgtBuyB1")?.status === "skipped" && by("tgtBuyB1").reason === "mcap $412k > max $300k", "feed: buy B skipped with the reason", JSON.stringify(by("tgtBuyB1")));
  check(by("tgtJupC1")?.status === "copied" && by("tgtJupC1").source === "rpc" && by("tgtJupC1").venue === "jupiter", "feed: the RPC-path buy classified as a Jupiter route and copied", JSON.stringify(by("tgtJupC1")));
  check(by("tgtSellA1")?.status === "copied" && by("tgtSellA1").ourPct === 50, "feed: their 50% sell mirrored", JSON.stringify(by("tgtSellA1")));
  const lat = by("tgtBuyA1").latency;
  check(lat.landedAt >= lat.detectedAt && lat.ourSlot > lat.targetSlot, "latency recorded: detected → landed in ms, our slot after theirs", JSON.stringify(lat));
  check(feed.filter((i) => i.theirSig === "tgtBuyA1").length === 1, "one feed line per trade");
  const pos = JSON.parse((await vesk(["positions", "--json"])).out);
  const open = (pos.open ?? pos.positions ?? pos).find?.((p) => p.mint === coinA);
  check(open?.copiedFrom?.label === "degen" && open.exit?.stopLossPct === 30, "the copied position carries 'copied from degen' and its exits", JSON.stringify(open));
  const list = await vesk(["copy", "list"]);
  check(/degen/.test(list.out) && /auto/.test(list.out), "copy list shows the wallet", list.out);
  const off = await vesk(["copy", "off", "degen"]);
  check(off.code === 0 && /copying off/.test(off.out), "switched off", off.out);
  const ex = await vesk(["copy", "export", "--format", "csv"]);
  check(ex.out.includes(target) && /^address,label,tag/m.test(ex.out), "exported as CSV", ex.out);
  return `copied 2 buys (PumpPortal + RPC/Jupiter) in ${lat.landedAt - lat.detectedAt} ms · skipped above max mcap · mirrored a 50% sell · ${lat.ourSlot - lat.targetSlot} slot(s) after theirs`;
});

// ---------------------------------------------------------------- v19.1: trading sources
await step("trading sources: Copy trade switched off, a tracked wallet's buy is refused by the guardrails; on again, it copies", async () => {
  const target = m.newKeypair().publicKey.toBase58();
  const [coinD, coinE] = [0, 1].map(() => m.newKeypair().publicKey.toBase58());
  const add = await vesk(["copy", "add", target, "--label", "night", "--sol", "0.02", "--max-mcap", "off", "--min-liq", "off", "--max-dev", "off", "--max-top10", "off", "--mode", "auto"]);
  check(add.code === 0, "tracked a wallet", add.out);
  const off = await vesk(["strategy", "set", "sources.copy", "off"]);
  check(off.code === 0, "vesk strategy set sources.copy off", off.out);
  const lv = await vesk(["live", "--once"]);
  check(/trading from Snipe on · Copy off · Pulse (on|off) · Launch on post on/.test(lv.out), "vesk live shows the sources", lv.out.slice(0, 400));
  const builds = (mint) => m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === mint && l.action === "buy").length;
  const a = agent(["copy", "watch", "--for", "30"]);
  try {
    await until(() => m.accountSubs(target) > 0, 20_000);
    m.pushPumpData({ txType: "buy", traderPublicKey: target, mint: coinD, solAmount: 1, tokenAmount: 30_000_000, newTokenBalance: 30_000_000, marketCapSol: 200, pool: "pump", signature: "srcOffD1" });
    await a.waitFor(/Copy trade is off: buys from it are paused\./, 15_000);
    check(builds(coinD) === 0, "nothing was built for the refused copy");
    const on = await vesk(["strategy", "set", "sources.copy", "on"]);
    check(on.code === 0, "vesk strategy set sources.copy on", on.out);
    await sleep(2600); // the running agent re-reads rules.json every 2 s
    m.pushPumpData({ txType: "buy", traderPublicKey: target, mint: coinE, solAmount: 1, tokenAmount: 30_000_000, newTokenBalance: 30_000_000, marketCapSol: 200, pool: "pump", signature: "srcOnE1" });
    await a.waitFor(/night bought 1 SOL of .* → copied 0\.02 SOL/, 15_000);
    check(builds(coinE) === 1, "on again: the next buy is copied");
    await a.waitExit(35_000).catch(() => undefined);
  } finally { a.p.kill(); }
  await vesk(["copy", "off", "night"]);
  return "Copy trade off → refused with the guardrail's reason, nothing built · on → copied";
});

// ---------------------------------------------------------------- wallet tools
// ---------------------------------------------------------------- v19: Strategy & safety
await step("strategy: the early-volume trigger buys a coin that reaches it; a quiet coin is filtered with its numbers", async () => {
  for (const [k, v] of [["entry.autoNewCoins", "on"], ["entry.earlyVolume.windowSec", "6"], ["entry.earlyVolume.minVolSol", "2"], ["entry.earlyVolume.minBuys", "3"], ["entry.earlyVolume.minBuyers", "3"],
    ["entry.minMcapUsd", "off"], ["entry.maxMcapUsd", "off"], ["entry.minLiquiditySol", "off"], ["entry.size.sol", "0.02"], ["rug.enrich", "off"], ["rug.minHolders", "off"], ["rug.maxSnipersPct", "off"], ["exits.noVolume.enabled", "off"]]) {
    const r = await vesk(["strategy", "set", k, v]);
    check(r.code === 0, `vesk strategy set ${k} ${v}`, r.out);
  }
  const show = await vesk(["strategy", "--json"]);
  const sj = JSON.parse(show.out);
  check(sj.strategy.entry.earlyVolume.windowSec === 6 && sj.strategy.entry.autoNewCoins === true && sj.strategy.preset === "custom", "settings saved to rules.json", show.out.slice(0, 300));
  const bad = await vesk(["strategy", "set", "entry.earlyVolume.windowSec", "9000"]);
  check(bad.code === 1 && /at most 600/.test(bad.out), "out-of-range value refused", bad.out);
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/Strategy: watching new coins \(early volume 6 s\)/, 15_000);
    await until(() => m.pumpDataCount() > 0);
    const hot = m.newKeypair().publicKey.toBase58(), cold = m.newKeypair().publicKey.toBase58();
    const dev = m.newKeypair().publicKey.toBase58();
    m.pushPumpData({ txType: "create", mint: hot, name: "Harbour Light", symbol: "HLIGHT", traderPublicKey: dev, initialBuy: 10_000_000, solAmount: 0.3, vSolInBondingCurve: 30.3, marketCapSol: 30, pool: "pump" }, { twitter: "https://x.com/harbour_e2e" });
    m.pushPumpData({ txType: "create", mint: cold, name: "Quiet Pier", symbol: "QPIER", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 10_000_000, solAmount: 0.3, vSolInBondingCurve: 30.3, marketCapSol: 30, pool: "pump" }, {});
    await until(() => m.tradeSubs(hot) > 0 && m.tradeSubs(cold) > 0, 8_000);
    const buyer = () => m.newKeypair().publicKey.toBase58();
    m.pushPumpData({ txType: "buy", mint: cold, traderPublicKey: buyer(), solAmount: 0.2, tokenAmount: 5_000_000, vSolInBondingCurve: 30.5, marketCapSol: 30 });
    for (const sol of [0.7, 0.8, 0.9]) { m.pushPumpData({ txType: "buy", mint: hot, traderPublicKey: buyer(), solAmount: sol, tokenAmount: 20_000_000, vSolInBondingCurve: 31, marketCapSol: 30 }); await sleep(150); }
    await a.waitFor(/Strategy: HLIGHT early volume: 2\.4 SOL, 3 buys, 3 buyers in \d+ s/, 10_000);
    await a.waitFor(/Bought 0\.02 SOL of HLIGHT via pumpfun/, 10_000);
    check(m.tokenBalance(S.wallet, hot) > 0, "the coin that reached early volume was bought");
    // the quiet coin's window ends: filtered with what it reached (Live's decision log)
    await sleep(7_000);
    const lv = JSON.parse((await vesk(["live", "--json"])).out);
    const miss = lv.decisions.find((d) => d.mint === cold);
    check(miss && miss.action === "filtered" && /^early volume: 0\.2 SOL, 1 buy, 1 buyer in 6 s \(needs 2 SOL and 3 buys and 3 buyers\)$/.test(miss.reason), "the quiet coin is filtered with its numbers", JSON.stringify(miss ?? lv.decisions.slice(0, 4)));
    check(m.tokenBalance(S.wallet, cold) === 0, "the quiet coin wasn't bought");
    await vesk(["strategy", "set", "entry.autoNewCoins", "off"]);
    await vesk(["stop"]);
    await a.waitExit();
    return "fired at 2.4 SOL / 3 buys / 3 buyers → bought 0.02 SOL · quiet coin filtered with its numbers";
  } finally { a.p.kill(); }
});

await step("honeypot: a Token-2022 coin with a transfer hook and a coin whose holder can't sell are refused before anything is built", async () => {
  const hook = m.newKeypair().publicKey.toBase58(), frozen = m.newKeypair().publicKey.toBase58(), fine = m.newKeypair().publicKey.toBase58();
  const hookProgram = m.newKeypair().publicKey.toBase58();
  m.addSpecialMint(hook, { program: "t22", ext: [{ extension: "transferHook", state: { authority: m.newKeypair().publicKey.toBase58(), programId: hookProgram } }] });
  m.addSpecialMint(frozen, { program: "spl", holder: { owner: m.newKeypair().publicKey.toBase58(), amount: 50_000_000_000 }, simErr: "AccountFrozen" });
  m.addSpecialMint(fine, { program: "t22", ext: [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 100 } } }], holder: { owner: m.newKeypair().publicKey.toBase58(), amount: 50_000_000_000 } });
  const builds = () => m.log.filter((l) => (l.svc === "pump" && l.what === "trade-build") || (l.svc === "jup" && l.what === "swap" && l.user === S.wallet)).length;
  const before = builds();
  const r1 = await vesk(["buy", hook, "0.02", "--yes"]);
  check(new RegExp(`Not bought: transfer hook \\(program ${hookProgram.slice(0, 4)}…${hookProgram.slice(-4)}\\) can block sells\\.`).test(r1.out), "transfer hook refused with its reason", r1.out);
  const r2 = await vesk(["buy", frozen, "0.02", "--yes"]);
  check(/Not bought: can't sell: a holder's sell failed in simulation \(Error: AccountFrozen\)\./.test(r2.out), "a failing sell simulation refused", r2.out);
  check(m.log.some((l) => l.svc === "rpc" && l.what === "simulate" && l.mint === frozen), "the sell was simulated through the RPC (simulateTransaction)");
  check(builds() === before, "nothing was built or signed for either coin");
  check(m.tokenBalance(S.wallet, hook) === 0 && m.tokenBalance(S.wallet, frozen) === 0, "nothing bought");
  // switched off, the same coin goes on to the swap (which the mock can't fill: it's only here to show the check is what refused)
  await vesk(["strategy", "set", "honeypot.enabled", "off"]);
  const r3 = await vesk(["buy", hook, "0.02", "--yes"]);
  check(!/transfer hook/.test(r3.out), "with the check off the transfer-hook refusal is gone", r3.out);
  await vesk(["strategy", "set", "honeypot.enabled", "on"]);
  // a 1% transfer tax and a holder who can sell: the check passes and the buy goes on to be built (Jupiter)
  const swaps = () => m.log.filter((l) => l.svc === "jup" && l.what === "swap" && l.user === S.wallet).length;
  const s0 = swaps();
  const r4 = await vesk(["buy", fine, "0.02", "--yes"]);
  check(!/Not bought/.test(r4.out) && swaps() === s0 + 1, "a 1% tax coin whose holder can sell passes and is built", r4.out);
  return "transfer hook refused · AccountFrozen in simulation refused · nothing built · 1% tax passes · check off = refusal gone";
});

await step("rogue mode: buys every match small up to the budget, sells the stalled one, keeps the active one", async () => {
  const start = await vesk(["rogue", "start", "--ticker", "MOON", "--sol", "0.02", "--budget", "0.04", "--coins", "5", "--window", "2", "--stall", "4", "--stall-vol", "0.5", "--leaders", "off", "--yes"]);
  check(start.code === 0 && /Rogue mode on · \$MOON · 0\/5 coins · budget 0\/0\.04 SOL · 2:00 left/.test(start.out), "vesk rogue start", start.out);
  check(/Still enforced: your per-trade max/.test(start.out), "the confirm says what still applies", start.out);
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/Rogue mode on: \$MOON for 2 min, 5 coins at 0\.02 SOL, budget 0\.04 SOL/, 15_000);
    await until(() => m.pumpDataCount() > 0);
    const coins = [0, 1, 2].map(() => m.newKeypair().publicKey.toBase58()), sun = m.newKeypair().publicKey.toBase58();
    // copies of a hyped launch: a heavy dev bag that the rug check would refuse; Rogue mode skips the soft filters
    for (const c of coins) { m.pushPumpData({ txType: "create", mint: c, name: "Moon", symbol: "MOON", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 400_000_000, solAmount: 12, vSolInBondingCurve: 42, marketCapSol: 30, pool: "pump" }, {}); await sleep(400); }
    m.pushPumpData({ txType: "create", mint: sun, name: "Sun", symbol: "SUN", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 10_000_000, solAmount: 0.3, vSolInBondingCurve: 30.3, marketCapSol: 30, pool: "pump" }, {});
    await a.waitFor(/Rogue skipped MOON: Rogue budget: 0\.04 of 0\.04 SOL spent/, 12_000);
    const held = coins.filter((c) => m.tokenBalance(S.wallet, c) > 0);
    check(held.length === 2 && held.includes(coins[0]) && held.includes(coins[1]), `two matches bought at 0.02 SOL each (${held.length})`);
    check(m.tokenBalance(S.wallet, sun) === 0, "the non-matching coin isn't touched");
    // coin 1 keeps trading; coin 2 goes quiet and is sold once it has stalled for 4 s
    const t0 = Date.now();
    while (Date.now() - t0 < 6_500) { m.pushPumpData({ txType: "buy", mint: coins[0], traderPublicKey: m.newKeypair().publicKey.toBase58(), solAmount: 0.4, tokenAmount: 1_000_000, vSolInBondingCurve: 31, marketCapSol: 30 }); await sleep(700); }
    await a.waitFor(/MOON: volume stalled: 0 SOL in 4 s/, 6_000);
    await until(() => m.tokenBalance(S.wallet, coins[1]) === 0, 6_000);
    check(m.tokenBalance(S.wallet, coins[0]) > 0, "the active coin is kept");
    const status = JSON.parse((await vesk(["rogue", "status", "--json"])).out);
    check(status.active && status.session.spentSol === 0.04 && status.session.coins.length === 2 && status.session.coins.filter((c) => c.sold).length === 1, "vesk rogue status: 2 coins, 0.04 SOL, one sold", JSON.stringify(status.session));
    const lv = await vesk(["live", "--once"]);
    check(/◇ Rogue mode · \$MOON · 2\/5 coins · budget 0\.04\/0\.04 SOL/.test(lv.out), "vesk live shows the Rogue line", lv.out.slice(0, 400));
    if (process.env.E2E_CAPTURE) writeFileSync(join(process.env.E2E_CAPTURE, "live-rogue.ansi"), (await vesk(["live", "--once"], { env: { NO_COLOR: "", FORCE_COLOR: "1", COLUMNS: "116" } })).out.split("\n").filter((l) => !/^\(node:\d+\)|^\(Use `node/.test(l)).join("\n"));
    const stop = await vesk(["rogue", "stop"]);
    check(/Rogue mode off/.test(stop.out), "vesk rogue stop", stop.out);
    await vesk(["stop"]);
    await a.waitExit();
    return "bought 2 of 3 matches (0.04 SOL budget) · skipped the soft filters · sold the stalled one, kept the active one";
  } finally { a.p.kill(); }
});

// ---------------------------------------------------------------- v20
await step("fake pump: one wallet buying 28% of a new coin in its first seconds is refused by the rug check with the pattern", async () => {
  for (const [k, v] of [["entry.autoNewCoins", "on"], ["rug.earlyConcentration.on", "on"], ["rug.earlyConcentration.maxPct", "15"], ["rug.earlyConcentration.windowSec", "10"]]) {
    const r = await vesk(["strategy", "set", k, v]);
    check(r.code === 0, `vesk strategy set ${k} ${v}`, r.out);
  }
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/Strategy: watching new coins/, 15_000);
    await until(() => m.pumpDataCount() > 0);
    const fake = m.newKeypair().publicKey.toBase58(), pumper = m.newKeypair().publicKey.toBase58();
    m.pushPumpData({ txType: "create", mint: fake, name: "Fake Moon", symbol: "FAKEM", traderPublicKey: m.newKeypair().publicKey.toBase58(), initialBuy: 10_000_000, solAmount: 0.3, vSolInBondingCurve: 30.3, marketCapSol: 30, pool: "pump" }, {});
    await until(() => m.tradeSubs(fake) > 0, 8_000);
    m.pushPumpData({ txType: "buy", mint: fake, traderPublicKey: pumper, solAmount: 1.6, tokenAmount: 280_000_000, vSolInBondingCurve: 32, marketCapSol: 60, signature: "fakeBig1" });
    await sleep(150);
    for (const sol of [0.4, 0.3]) { m.pushPumpData({ txType: "buy", mint: fake, traderPublicKey: m.newKeypair().publicKey.toBase58(), solAmount: sol, tokenAmount: 5_000_000, vSolInBondingCurve: 33, marketCapSol: 70 }); await sleep(150); }
    const r = await a.waitFor(/Strategy skipped FAKEM: (one wallet \(\S+\) bought 28% of supply in the first \d+ s \(max 15%\))/, 12_000);
    check(m.tokenBalance(S.wallet, fake) === 0, "nothing bought");
    const lv = JSON.parse((await vesk(["live", "--json"])).out);
    check(lv.decisions.some((d) => d.mint === fake && d.action === "filtered" && /bought 28% of supply/.test(d.reason)), "Live shows the refusal with its reason", JSON.stringify(lv.decisions.slice(0, 3)));
    await vesk(["strategy", "set", "entry.autoNewCoins", "off"]);
    await vesk(["stop"]);
    await a.waitExit();
    return r[1];
  } finally { a.p.kill(); }
});

await step("sell into big buys: a whale's buy lands on a coin we hold → our sell goes after it, as a Jito bundle with the tip; never before, never a buy", async () => {
  for (const [k, v] of [["exits.sellIntoBuys.enabled", "on"], ["exits.sellIntoBuys.minBuySol", "3"], ["exits.sellIntoBuys.sellPct", "50"], ["exits.sellIntoBuys.tipSol", "0.002"], ["exits.sellIntoBuys.cooldownSec", "5"]]) {
    const r = await vesk(["strategy", "set", k, v]);
    check(r.code === 0, `vesk strategy set ${k} ${v}`, r.out);
  }
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    const coin = m.newKeypair().publicKey.toBase58(), whale = m.newKeypair().publicKey.toBase58();
    m.queueOp({ op: "trade", mint: coin, side: "buy", wallets: [S.wallet], amountSol: 0.05 });
    await a.waitFor(/Bought 0\.05 SOL of .* via pumpfun/, 10_000);
    const held = m.tokenBalance(S.wallet, coin);
    check(held > 0, "holding the coin");
    await until(() => m.tradeSubs(coin) > 0, 8_000); // the agent follows trades on what it holds
    const sells = () => m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coin && l.action === "sell");
    const buys = () => m.log.filter((l) => l.svc === "pump" && l.what === "trade-build" && l.mint === coin && l.action === "buy");
    // a small buy: nothing
    m.pushPumpData({ txType: "buy", mint: coin, traderPublicKey: m.newKeypair().publicKey.toBase58(), solAmount: 1, tokenAmount: 3_000_000, signature: "smallBuy1", marketCapSol: 40 });
    await sleep(1200);
    check(sells().length === 0, "a small buy doesn't trigger a sell");
    const bundles = m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length;
    const tPush = Date.now();
    m.pushPumpData({ txType: "buy", mint: coin, traderPublicKey: whale, solAmount: 6, tokenAmount: 20_000_000, signature: "whaleBuy1", marketCapSol: 60 });
    const hit = await a.waitFor(/sold into a 6 SOL buy by \S+ · tip 0\.002 SOL → sold 50% in (\d+) ms/, 10_000);
    check(sells().length === 1 && sells()[0].at >= tPush, "exactly one sell, built after the whale's buy landed");
    check(sells()[0].amount === "50%", "50% of our position", JSON.stringify(sells()[0]));
    check(buys().length === 1, "no buy besides ours from before (nothing placed ahead of or around theirs)");
    check(m.log.filter((l) => l.svc === "jito" && l.what === "bundle").length === bundles + 1, "sent as a Jito bundle");
    check(Math.abs(m.tokenBalance(S.wallet, coin) - held / 2) / held < 0.01, "half the position sold");
    const lv = JSON.parse((await vesk(["live", "--json"])).out);
    check(lv.decisions.some((d) => d.mint === coin && d.action === "exit" && /sold into a 6 SOL buy/.test(d.reason)), "the attempt is in Live with its result", JSON.stringify(lv.decisions.slice(0, 3)));
    await vesk(["strategy", "set", "exits.sellIntoBuys.enabled", "off"]);
    await vesk(["stop"]);
    await a.waitExit();
    return `sold 50% ${hit[1]} ms after seeing a 6 SOL buy · small buy ignored · no buy placed`;
  } finally { a.p.kill(); }
});

await step("parallel lanes: 2 launches and 3 buys at once run side by side; the daily cap holds across lanes", async () => {
  for (const [k, v] of [["concurrency.lanes", "3"], ["concurrency.launches", "2"]]) {
    const r = await vesk(["strategy", "set", k, v]);
    check(r.code === 0, `vesk strategy set ${k} ${v}`, r.out);
  }
  const st0 = JSON.parse((await vesk(["status", "--json"])).out);
  const cap0 = JSON.parse((await vesk(["strategy", "--json"])).out).limits.dailySpendCapSol;
  const cap = Math.round((st0.spentTodaySol + 0.2) * 1000) / 1000;
  const set = await vesk(["strategy", "set", "limits.dailySpendCapSol", String(cap)]);
  check(set.code === 0, `daily cap set to ${cap} SOL (0.2 SOL left)`, set.out);
  const a = agent(["summon", "--live"]);
  try {
    await a.waitFor(/via vesk-relay/);
    m.setBuildDelay(700);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const plan = (name, symbol) => ({ launchpad: "pumpfun", mode: "standard", token: { name, symbol, description: "e2e parallel launch", quote: "SOL", creatorFees: "creator" }, devBuySol: 0.05, jitoTipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 10, team: null });
    const mark = m.log.length;
    m.queueOp({ op: "launch", plan: plan("Lane One", "LONE"), imageDataUrl: png });
    m.queueOp({ op: "launch", plan: plan("Lane Two", "LTWO"), imageDataUrl: png });
    const coins = [0, 1, 2].map(() => m.newKeypair().publicKey.toBase58());
    for (const c of coins) m.queueOp({ op: "trade", mint: c, side: "buy", wallets: [S.wallet], amountSol: 0.05 });
    await a.waitFor(/Launched Lane One/, 20_000);
    await a.waitFor(/Launched Lane Two/, 20_000);
    await until(() => coins.filter((c) => m.tokenBalance(S.wallet, c) > 0).length >= 2, 15_000);
    await sleep(1500);
    const starts = m.log.slice(mark).filter((l) => l.svc === "pump" && l.what === "build-start");
    const launches = starts.filter((l) => l.actions.includes("create"));
    check(launches.length === 2 && Math.abs(launches[1].at - launches[0].at) < 700, `the two launches were built at the same time (${launches.map((l) => l.at - launches[0].at).join(", ")} ms)`);
    const buys = starts.filter((l) => l.actions[0] === "buy");
    check(buys.length === 2 && Math.abs(buys[1].at - buys[0].at) < 700, `two buys ran side by side (${buys.map((l) => l.at - buys[0].at).join(", ")} ms)`);
    const bought = coins.filter((c) => m.tokenBalance(S.wallet, c) > 0).length;
    check(bought === 2, `two of the three buys fit (${bought})`);
    check(/Daily cap: .* SOL spent today and 0\.2 SOL in flight\.|Daily cap: .* already spent today\./.test(a.out), "the third was refused by the daily cap, counting what was in flight");
    const st1 = JSON.parse((await vesk(["status", "--json"])).out);
    check(st1.spentTodaySol <= cap + 1e-9, `spend stayed under the cap (${st1.spentTodaySol} ≤ ${cap})`);
    m.setBuildDelay(0);
    await vesk(["stop"]);
    await a.waitExit();
    return `2 launches overlapped · 2 buys in parallel · 3rd refused at the cap · spent ${Math.round((st1.spentTodaySol - st0.spentTodaySol) * 1000) / 1000} of 0.2 SOL`;
  } finally {
    m.setBuildDelay(0);
    a.p.kill();
    await vesk(["strategy", "set", "limits.dailySpendCapSol", String(cap0)]);
  }
});

await step("recover rent: closes 3 empty token accounts", async () => {
  m.addEmptyAccounts(S.wallet, 3);
  const before = m.balance(S.wallet);
  const r = await vesk(["rent", "--yes"]);
  check(r.code === 0 && /3 empty accounts/.test(r.out) && /closed 3/.test(r.out), "closed", r.out);
  check(m.emptyCount(S.wallet) === 0, "accounts gone on the mock chain");
  const got = m.balance(S.wallet) - before;
  check(Math.abs(got - 3 * 0.00203928) < 1e-6, `rent back: ${got.toFixed(6)} SOL`);
  const again = await vesk(["rent", "--yes"]);
  check(/Nothing to recover/.test(again.out), "second run has nothing to do", again.out);
});
await step("address book: add, bookmark, export CSV, reject a bad address", async () => {
  const k = m.newKeypair().publicKey.toBase58();
  const add = await vesk(["book", "add", k, "Exchange deposit", "--bookmark", "--marker", "ice"]);
  check(add.code === 0 && /saved/.test(add.out), "added", add.out);
  const csv = await vesk(["book", "export", "--format", "csv"]);
  check(csv.out.includes("address,label,marker,bookmark,note") && csv.out.includes(`${k},Exchange deposit,ice,yes,`), "csv", csv.out);
  const bad = await vesk(["book", "add", "not-an-address", "x"]);
  check(bad.code === 1 && /isn't a Solana address/.test(bad.out), "rejected", bad.out);
});

await m.stop();
if (!process.env.E2E_KEEP) rmSync(home, { recursive: true, force: true });
const ms = results.reduce((s, r) => s + r.ms, 0);
console.log(`\n  ${failed ? C.bad(`${failed} failed`) : C.ok("all passed")} · ${results.length - failed}/${results.length} steps · ${(ms / 1000).toFixed(1)} s\n`);
process.exit(failed ? 1 : 0);
