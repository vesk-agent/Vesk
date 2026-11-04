#!/usr/bin/env node
/** vesk: the command-line agent. `vesk help` for commands. */
import { parseArgs } from "node:util";
import { init, keys, pair, rpc, wallet } from "./commands/setup.js";
import { kill, live, pause, pending, positions, resume, status, stop, summon } from "./commands/run.js";
import { order, orders } from "./commands/orders.js";
import { trading } from "./commands/trading.js";
import { pulse } from "./commands/pulse.js";
import { migration } from "./commands/migration.js";
import { blacklist } from "./commands/blacklist.js";
import { rogue, strategy } from "./commands/strategy.js";
import { copy } from "./commands/copy.js";
import { doctor } from "./commands/doctor.js";
import { chat, rules, snipe, watch } from "./commands/rules.js";
import { buy, launch, sell } from "./commands/trade.js";
import { wallets, WALLETS_HELP } from "./commands/wallets.js";
import { access, deploy, presets, tracker } from "./commands/v5.js";
import { book, BOOK_HELP, folders, rent, treasury } from "./commands/v6.js";
import { claim } from "./commands/claim.js";
import { pairs, races } from "./commands/launchpost.js";
import { burn, lock } from "./commands/supply.js";
import { BANNER, bold, dim, fail, setJson } from "./ui.js";

const HELP = `${BANNER}
${bold("Run")}
  vesk init [--import] [--yes]  wallet, RPC (latency test), model + key, Telegram (optional), paper mode
  vesk summon [--live|--paper] [--stream]
                                 start the agent; paper (the default after init) decides but never signs
  vesk status                   mode, today's spend, open positions, recent activity
  vesk live [--once]            watch the agent work: watch → check → size → execute → exit → log, live
  vesk positions                open positions and recently closed ones
  vesk doctor                   check node, config, keystore, RPC (+ websocket), model key, X source
  vesk pause | resume | stop    control a running agent
  vesk kill [on|off]            kill switch: no new buys

${bold("Strategy & safety")}
  vesk strategy [show | set <key> <value> | preset safe|balanced|degen|rogue | explain <words> | export | import <file>]
                                 entry filters (early-volume trigger), rug check, can-sell check, exits, hard limits
  vesk rogue start --ticker X [--keywords a,b] [--sol 0.05] [--coins 10] [--budget 0.5] [--window 10] [--stall 20]
                   [--leaders 90 --keep 2] [--creator <wallet>] [--x handle] [--yes]   ${dim("one hyped launch: buy every match small, cut the losers")}
  vesk rogue [status | stop]

${bold("Snipe & rules")}
  vesk snipe @handle --sol 0.25 [--max-mcap 50k] [--tp 3x:50] [--sl 30] [--per-day 3] [--keyword launch] [--jito 0.001]
  vesk snipe --launches --sol 0.1 [--max-dev 5] [--socials] [--min-liq 10] [--block cat,dog]
  vesk watch [list | add @h | rm @h]
  vesk rules [list | show <id> | add "<plain English>" | enable <id> | disable <id> | rm <id>]
  vesk rules add --launch-on-post @a,@b --dev-buy 0.5 --sell 50%@100k,100%@250k [--stop 5k] [--sell-after 5:100] [--no-volume 0.5/120s] [--trail 25]
                 [--preset <id>] [--auto]   ${dim("launch a coin when a watched account posts; Confirm unless --auto")}
  vesk rules account <id> @handle on|off   switch one watched account without removing it
  vesk pending [launch <id> | skip <id>]   launch-on-post drafts waiting for you
  vesk chat ["message"]         talk to your agent; every rule is shown for you to confirm

${bold("Trade & launch")}
  vesk buy <mint> <sol> [--preset p1|p2|p3] [--slippage 15] [--jito 0.001] [--yes]
  vesk sell <mint> <percent|all> [--yes]
  vesk order buy|sell|stop <mint> <amount> --below|--above <price> | --mcap <usd>   limit and stop-loss orders
  vesk order trail <mint> <pct> --trail <pct>      trailing stop
  vesk order dca <mint> <sol> --every <min> --times <n> [--min-mcap --max-mcap]   (--every-sec, --total --slices)
  vesk order twap <mint> <total> --over 30m --slices <n> | --weights 50,30,20
  vesk order dev-sell <mint> <sol> --dev <wallet>  buy the moment the dev sells (--side sell: sell pct)
  vesk orders [list | cancel <id>]   your orders (prices in SOL per token, market caps in USD)
  vesk trading [show | export | import <file> | active <p1|p2|p3> [--sell]]   buy/sell presets, MEV protection, hotkeys
  vesk pulse [--column new|final|migrated] [--filter f.json] [--buy <sol> --preset p2 --max 1] [--for 60] [--pools all|meteora-dbc,orca]
  vesk migration [list | buy <mint> <sol> | sell <mint> <pct> | rm <id> | watch] [--preset p2]   buy or sell when a coin migrates
  vesk blacklist [list | add <mint|dev|funder|wallet> <address> | rm … | import <file> | export]   never buy these
                                 live new coins with audits; optionally quick-buy matches (limits apply)
  vesk launch --name "Night Owl" --ticker OWL --image ./owl.png [--mode standard|manual] [--dev-buy 0.5]
               [--team-wallets N --team-sol 0.2] [--quote SOL|USDC|NVDAx|…] [--creator-fee 0.05-1]
               [--creator-fees creator|holders|cashback|split --split <addr>:60,<addr>:40]
               [--jito 0.001] [--x url] [--tg url] [--web url]
               ${dim("standard = create + dev buy in one transaction; team wallets are always disclosed")}

${bold("Copy trading")}
  vesk copy add <address> --label x --sol 0.2 --max-mcap 300k --tp 2x:50,5x:100 --sl 30 --mode auto
  vesk copy [list | edit <addr|label> … | show | on|off <addr|label|all> | rm | import <file> | export | feed | watch]
  vesk copy defaults [settings…] | templates | template <name> <addr|label|all> | sources pumpportal,rpc | decide <id> copy|skip
                                 ${dim("copies land after their transaction (same or next few slots); never ahead of it")}

${bold("Tracker, presets, deploy")}
  vesk tracker [groups | group add "Founders" @a,@b [--sound] [--notify] | group rm <id>]
  vesk tracker source [relay | official-api | provider | off]   where posts come from (relay: free for holders)
  vesk presets [list | add --name "Free" --dev-buy 0 [--sell 50%@100k] [--sell-after 5:100] | default <id> | rm <id>]
  vesk deploy <post url> [--preset <id>]   launch a coin on that post with a preset (agent must be running)
  vesk rules add --launch-on-post @a,@b [--template breaking] [--pair NVDAx] [--clash skip|rename|launch] [--velocity 500/60s] …
  vesk rules [backtest <id> | stats [<id>] | templates]   replay 7 days of posts (nothing spent), per-rule results
  vesk races [<mint|$TICKER>]     race reports: who launched for the same post first ("1st of 14 · 1.7 s after the post")
  vesk pairs [--search nvda] [--category stock] [--seen]   pump.fun custom pairs by category and status
  vesk pairs --check NVDAx        read a pair's mint on chain now (exists, token program, decimals, freeze authority)
  vesk access sign "<message>"             sign the panel's holder-access message with your wallet, locally

${bold("Wallets")}
${WALLETS_HELP}
${BOOK_HELP}
  vesk claim [<mint|$TICKER>] [--all] [--yes]
                                 creator fees from coins you launched: one claim per asset, paid in that asset
  vesk rent [--yes]             close empty token accounts, get the rent back
  vesk burn <mint|$TICKER> <amount|N%|all> [--yes]
                                 burn supply of a coin you launched: plan first, "gone forever" confirm, disclosed
  vesk lock <mint|$TICKER> <amount|N%> --days 90
                                 lock supply ${dim("(Soon: shows the plan; nothing is sent until the lock venue is verified)")}
  vesk treasury [<mint>]        team buys, dev sells, fees, buybacks and burns, with transactions

${bold("Setup")}
  vesk keys [list | set NAME | rm NAME]   API keys, stored in the encrypted keystore
  vesk rpc test [url]           latency test (p50/p95)
  vesk wallet [export]          address, balance, holdings
  vesk pair <CODE> --panel <url>  link to the web panel (status, Launch/Skip, relay; keys stay here)
  vesk mcp                      run the MCP server (OpenClaw, Hermes, Claude Code…)
  vesk telegram                 run your Telegram bot

${dim("Every read-only command takes --json. NO_COLOR=1 turns colour off.")}
${dim("Memecoins are extremely risky. Sniping can lose everything. Not financial advice.")}
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    config: { type: "string", short: "c" }, paper: { type: "boolean" }, stream: { type: "boolean" }, yes: { type: "boolean", short: "y" },
    import: { type: "boolean" }, panel: { type: "string" }, sol: { type: "string" }, "max-mcap": { type: "string" }, tp: { type: "string" },
    sl: { type: "string" }, "per-day": { type: "string" }, keyword: { type: "string" }, jito: { type: "string" }, priority: { type: "string" },
    slippage: { type: "string" }, launches: { type: "boolean" }, "max-dev": { type: "string" }, socials: { type: "boolean" }, "min-liq": { type: "string" },
    block: { type: "string" }, name: { type: "string" }, ticker: { type: "string" }, image: { type: "string" }, desc: { type: "string" },
    x: { type: "string" }, tg: { type: "string" }, web: { type: "string" }, "dev-buy": { type: "string" }, launchpad: { type: "string" }, mode: { type: "string" },
    "team-wallets": { type: "string" }, "team-sol": { type: "string" }, total: { type: "string" }, each: { type: "string" }, to: { type: "string" },
    inactive: { type: "boolean" }, "launch-on-post": { type: "string" }, sell: { type: "string" }, stop: { type: "string" }, timeout: { type: "string" },
    auto: { type: "boolean" }, manual: { type: "boolean" }, "confirm-ttl": { type: "string" }, "any-post": { type: "boolean" }, "min-likes": { type: "string" },
    "min-views": { type: "string" }, "default-image": { type: "string" }, naming: { type: "string" }, "per-hour": { type: "string" },
    "max-sol": { type: "string" }, "sell-after": { type: "string" }, "no-volume": { type: "string" }, preset: { type: "string" }, notify: { type: "boolean" }, sound: { type: "boolean" }, "max-sol-day": { type: "string" }, cooldown: { type: "string" },
    live: { type: "boolean" }, rpc: { type: "string" }, model: { type: "string" }, "model-url": { type: "string" }, telegram: { type: "string" },
    "telegram-chat": { type: "string" }, format: { type: "string" }, out: { type: "string" }, marker: { type: "string" }, bookmark: { type: "boolean" }, note: { type: "string" },
    filter: { type: "string" }, column: { type: "string" }, kind: { type: "string" }, pools: { type: "string" }, buy: { type: "string" }, max: { type: "string" }, for: { type: "string" },
    json: { type: "boolean" }, below: { type: "string" }, above: { type: "string" }, every: { type: "string" }, times: { type: "string" },
    label: { type: "string" }, pct: { type: "string" }, mult: { type: "string" }, "min-sol": { type: "string" }, "min-mcap": { type: "string" }, "min-age": { type: "string" },
    "max-age": { type: "string" }, "min-buy": { type: "string" }, "max-top10": { type: "string" }, "max-bundled": { type: "string" }, venues: { type: "string" },
    include: { type: "string" }, exclude: { type: "string" }, "first-only": { type: "boolean" }, "every-buy": { type: "boolean" }, "allow-missing": { type: "boolean" },
    trail: { type: "string" }, sells: { type: "string" }, group: { type: "string" }, tag: { type: "string" }, template: { type: "string" }, mev: { type: "string" },
    delay: { type: "string" }, limit: { type: "string" }, wallet: { type: "string" }, "max-trade": { type: "string" }, "max-sol-total": { type: "string" },
    "max-open": { type: "string" }, off: { type: "boolean" }, "no-buys": { type: "boolean" }, commitment: { type: "string" },
    mcap: { type: "string" }, "every-sec": { type: "string" }, slices: { type: "string" }, over: { type: "string" }, weights: { type: "string" }, dev: { type: "string" },
    min: { type: "string" }, side: { type: "string" }, gen: { type: "string" }, seed: { type: "string" }, clear: { type: "boolean" },
    window: { type: "string" }, coins: { type: "string" }, budget: { type: "string" }, stall: { type: "string" }, "stall-vol": { type: "string" },
    leaders: { type: "string" }, keep: { type: "string" }, keywords: { type: "string" }, creator: { type: "string" },
    "no-honeypot": { type: "boolean" }, "i-understand": { type: "boolean" },
    // v23: vesk claim, and the launch pair flags (v22's --quote and --creator-fees weren't registered, so they parsed as booleans)
    all: { type: "boolean" }, split: { type: "string" }, quote: { type: "string" }, "creator-fees": { type: "string" }, "creator-fee": { type: "string" },
    // v25: vesk lock
    days: { type: "string" },
    // v26: launch on post, races, pairs
    media: { type: "string" }, cashtag: { type: "string" }, ca: { type: "string" }, lang: { type: "string" }, velocity: { type: "string" }, hours: { type: "string" },
    tz: { type: "string" }, "allow-replies": { type: "boolean" }, "allow-quotes": { type: "boolean" }, "allow-reposts": { type: "boolean" }, style: { type: "string" },
    "no-crop": { type: "boolean" }, website: { type: "string" }, pair: { type: "string" }, fees: { type: "string" }, clash: { type: "string" },
    "clash-window": { type: "string" }, "race-window": { type: "string" }, search: { type: "string" }, category: { type: "string" }, seen: { type: "boolean" },
    // v26 second pass: the on-chain pair check, image size, dev buy in the pair asset, accounts kept but switched off, tracker groups
    check: { type: "string" }, "min-image": { type: "string" }, "dev-buy-in": { type: "string" }, "watch-off": { type: "string" }, groups: { type: "string" },
    once: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
const f = values as Record<string, string | boolean | undefined>;
setJson(!!f.json);
const cfg = { config: f.config as string | undefined };
const [cmd, ...args] = positionals;

const run: Record<string, () => Promise<unknown>> = {
  init: () => init(f as Parameters<typeof init>[0]),
  summon: () => summon({ ...cfg, paper: !!f.paper, live: !!f.live, stream: !!f.stream }),
  treasury: () => treasury(args, f),
  rent: () => rent(args, f),
  claim: () => claim(args, f),
  races: () => races(args[0], f),
  pairs: () => pairs(f),
  burn: () => burn(args, f),
  lock: () => lock(args, f),
  book: () => book(args, f),
  folders: () => folders(args, f),
  status: () => status(cfg),
  live: () => live({ ...cfg, once: !!f.once }),
  positions: () => positions(cfg),
  doctor: () => doctor(cfg),
  stop: () => stop(cfg),
  pause: () => pause(cfg),
  resume: () => resume(cfg),
  kill: () => kill(args, cfg),
  snipe: () => snipe(args, f),
  watch: () => watch(args, cfg),
  rules: () => rules(args, f),
  pending: () => pending(args, cfg),
  presets: () => presets(args, f),
  tracker: () => tracker(args, f),
  deploy: () => deploy(args, f),
  access: () => access(args, f),
  chat: () => chat(args, { ...cfg, yes: !!f.yes }),
  buy: () => buy(args, f),
  order: () => order(args, f),
  trading: () => trading(args, f),
  pulse: () => pulse(args, f),
  migration: () => migration(args, f),
  blacklist: () => blacklist(args, f),
  strategy: () => strategy(args, f),
  rogue: () => rogue(args, f),
  copy: () => copy(args, f),
  orders: () => orders(args, f),
  sell: () => sell(args, f),
  launch: () => launch(f),
  keys: () => keys(args, cfg),
  rpc: () => rpc(args, cfg),
  wallet: () => wallet(args, cfg),
  wallets: () => wallets(args, f),
  pair: () => pair(args, { ...cfg, panel: f.panel as string | undefined }),
  mcp: async () => (await import("@vesk-agent/mcp")).runStdio(cfg.config),
  telegram: async () => (await import("@vesk-agent/telegram")).runBot(cfg.config),
};

const near = (c: string) => Object.keys(run).find((k) => k.startsWith(c.slice(0, 3)) || (c.length > 3 && k.includes(c.slice(0, 4))));
if (!cmd || cmd === "help" || f.help) console.log(HELP);
else if (!run[cmd]) fail(`Unknown command "${cmd}".${near(cmd) ? ` Did you mean \`vesk ${near(cmd)}\`?` : ""} Run \`vesk help\` for the list.`);
else run[cmd]().catch((e: Error) => fail(e.message));
