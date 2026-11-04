/** vesk treasury | rent | book | folders | tracker source (v6) */
import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import {
  avatarToString, exportBook, loadBookFile, saveBookFile, findConfig, GEN_SEEDS, GEN_STYLES, hash32, importBook, isAddress, mergeBook, MARKERS, planRentRecovery, pruneLocalAvatars, RELAY_MAX_PER_USER,
  saveLocalAvatar, State, treasuryReport, validateEntry, withdrawTargets, type BookEntry, type GenStyle, type Marker, type WalletFolder,
} from "@vesk-agent/core";
import { agent, config } from "../context.js";
import { bold, confirm, dim, fail, ice, json, sol, table, up, warn } from "../ui.js";
import { BRAND } from "@vesk-agent/core";

type Flags = Record<string, string | boolean | undefined>;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Change one value in the YAML config without losing its comments. */
export async function setConfigValue(cfgPath: string | undefined, path: string[], value: unknown): Promise<string> {
  const p = cfgPath ?? findConfig();
  if (!p) fail("No vesk.config.yaml found. Run `vesk init` first.");
  if (!/\.ya?ml$/.test(p)) fail(`${p} isn't YAML. Edit ${path.join(".")} there by hand.`);
  const doc = parseDocument(await readFile(p, "utf8"));
  doc.setIn(path, value);
  await writeFile(p, doc.toString(), { mode: 0o600 });
  return p;
}

/** vesk treasury [<mint>]: every team buy, dev sell, claim, buyback and burn, with transactions. */
export async function treasury(args: string[], f: Flags) {
  const c = await config(f.config as string | undefined);
  const s = await new State(c.dataDir).load();
  const symbols = Object.fromEntries([...s.data.positions, ...s.data.closed].map((p) => [p.mint, p.symbol]));
  // your private wallet names next to team addresses, in this terminal only (posted reports carry addresses only)
  const book = await loadBookFile(c.dataDir).catch(() => ({ entries: [] as BookEntry[] }));
  const names = new Map(book.entries.filter((e) => e.own).map((e) => [e.address, e.label]));
  const reports = treasuryReport(s.data.treasury, symbols, args[0], f.json ? undefined : names);
  if (json(reports)) return;
  if (!reports.length) return console.log(dim("  Nothing to report yet. Team buys, dev sells, fee claims, buybacks and burns of coins you launch show here."));
  for (const r of reports) {
    console.log(`\n  ${bold(`Treasury report for $${r.symbol}`)}  ${dim(r.mint)}`);
    for (const l of r.lines) console.log(`  ${ice("·")} ${l}`);
    const t = r.totals;
    console.log(dim(`  Totals: team ${t.teamSol.toFixed(4)} SOL · dev sold ${t.devSoldSol.toFixed(4)} SOL · fees ${t.claimedSol.toFixed(4)} SOL · buybacks ${t.buybackSol.toFixed(4)} SOL`));
  }
}

/** vesk rent [--yes]: close empty token accounts and get their rent back. */
export async function rent(_args: string[], f: Flags) {
  const a = await agent({ config: f.config as string | undefined, paper: false });
  const empty = await a.executor.emptyTokenAccounts();
  const keep = a.state.data.positions.map((p) => p.mint);
  const plan = planRentRecovery(empty, { keepMints: keep });
  if (!f.yes && json(plan)) return;
  if (!plan.accounts.length) return console.log(dim("  No empty token accounts. Nothing to recover."));
  table(plan.accounts.map((x) => ({ account: short(x.account), mint: short(x.mint), program: x.program.startsWith("Tokenz") ? "Token-2022" : "Token", rent: sol(x.lamports / 1e9) })));
  console.log(`  ${plan.accounts.length} empty account${plan.accounts.length === 1 ? "" : "s"}, ${ice(sol(plan.totalSol))} back to ${short(a.address)} in ${plan.batches.length} transaction${plan.batches.length === 1 ? "" : "s"}.`);
  console.log(dim("  Only accounts with a zero balance. Closing one doesn't touch any coin you hold."));
  if (!(f.yes || (await confirm("  Close them?")))) return;
  const done = await a.executor.recoverRent(plan);
  await a.state.save();
  for (const d of done) console.log(`  ${up("closed")} ${d.closed} · ${sol(d.sol)} ${dim(d.signature)}`);
}

const loadBook = loadBookFile;
const saveBook = saveBookFile;

export const BOOK_HELP = `  vesk book [list]                                   address book (public addresses only)
  vesk book add <address> "<label>" [--marker ice] [--bookmark]
  vesk book rm <address> | bookmark <address> [off] | track <address> [off]
  vesk book avatar <address> <image.png|.jpg> | --gen ${GEN_STYLES.join("|")} [--seed 0-${GEN_SEEDS - 1}] | --clear
                                                      images live in ~/.vesk/avatars/ (metadata stripped)
  vesk book import <file.json|file.csv> | export [--format csv] [--out file]
  vesk folders [list | add "<name>" <addr,addr> | rm <id>]   group your own wallets`;

/** vesk book: labels, markers and bookmarks for addresses you send to. */
export async function book(args: string[], f: Flags) {
  const c = await config(f.config as string | undefined);
  const b = await loadBook(c.dataDir);
  const [sub, x, label] = args;
  if (!sub || sub === "list") {
    if (json(b.entries)) return;
    if (!b.entries.length) return console.log(dim(`  Empty. Try: vesk book add <address> "Exchange deposit" --bookmark`));
    return table(withdrawTargets(b.entries).map((e) => ({ label: e.label, address: e.address, marker: e.marker === "none" ? "" : e.marker, bookmark: e.bookmark ? "yes" : "", track: e.track ? "yes" : "", image: avatarToString(e.avatar), note: e.note ?? "" })));
  }
  if (sub === "add") {
    const e: BookEntry = { address: x ?? "", label: label ?? "", marker: (f.marker as Marker) ?? "none", bookmark: !!f.bookmark, note: f.note as string | undefined, addedAt: new Date().toISOString() };
    const bad = validateEntry(e);
    if (bad.length) fail(bad.join(" "));
    await saveBook(c.dataDir, { ...b, entries: mergeBook(b.entries, [e]) });
    return console.log(`  ${up("saved")} ${e.label} ${dim(short(e.address))}${e.bookmark ? dim(" · bookmarked, offered first in withdraw") : ""}`);
  }
  if (sub === "rm" && x) {
    if (!b.entries.some((e) => e.address === x)) fail(`${x} isn't in your address book.`);
    await saveBook(c.dataDir, { ...b, entries: b.entries.filter((e) => e.address !== x) });
    return console.log(`  Removed ${short(x)}.`);
  }
  if (sub === "bookmark" && x) {
    const e = b.entries.find((y) => y.address === x);
    if (!e) fail(`${x} isn't in your address book. Add it first: vesk book add ${x} "<label>"`);
    e.bookmark = label !== "off";
    await saveBook(c.dataDir, b);
    return console.log(`  ${e.label}: ${e.bookmark ? "bookmarked" : "bookmark removed"}.`);
  }
  if (sub === "track" && x) {
    const e = b.entries.find((y) => y.address === x);
    if (!e) fail(`${x} isn't in your address book. Add it first: vesk book add ${x} "<label>"`);
    e.track = label !== "off";
    await saveBook(c.dataDir, b);
    return console.log(`  ${e.label}: ${e.track ? "tracked" : "not tracked"}.`);
  }
  if (sub === "avatar" && x) {
    const e = b.entries.find((y) => y.address === x);
    if (!e) fail(`${x} isn't in your address book. Add it first: vesk book add ${x} "<label>"`);
    if (f.clear) delete e.avatar;
    else if (f.gen) {
      const style = String(f.gen) as GenStyle;
      if (!(GEN_STYLES as readonly string[]).includes(style)) fail(`--gen is one of ${GEN_STYLES.join(", ")}.`);
      const seed = f.seed !== undefined ? Number(f.seed) : hash32(x) % GEN_SEEDS;
      if (!Number.isInteger(seed) || seed < 0 || seed >= GEN_SEEDS) fail(`--seed is 0 to ${GEN_SEEDS - 1}.`);
      e.avatar = { kind: "gen", style, seed };
    } else if (label) {
      try {
        const r = await saveLocalAvatar(c.dataDir, new Uint8Array(await readFile(label)));
        e.avatar = r.ref;
        console.log(dim(`  stored ${r.file}${r.removedBytes ? ` (${r.removedBytes} bytes of metadata removed)` : ""}`));
      } catch (err) { fail((err as Error).message); }
    } else fail("Give an image file, --gen <style> or --clear.");
    await saveBook(c.dataDir, b);
    const pruned = await pruneLocalAvatars(c.dataDir, new Set(b.entries.flatMap((y) => (y.avatar?.kind === "upload" ? [y.avatar.id] : []))));
    return console.log(`  ${up("saved")} ${e.label}: ${e.avatar ? avatarToString(e.avatar) : "identicon"}${pruned ? dim(` · ${pruned} unused image${pruned === 1 ? "" : "s"} removed`) : ""}`);
  }
  if (sub === "import" && x) {
    const r = importBook(await readFile(x, "utf8"));
    for (const e of r.errors) console.log(`  ${warn("skipped")} ${e}`);
    await saveBook(c.dataDir, { ...b, entries: mergeBook(b.entries, r.entries) });
    return console.log(`  ${up("imported")} ${r.entries.length} address${r.entries.length === 1 ? "" : "es"}.`);
  }
  if (sub === "export") {
    const text = exportBook(b.entries, f.format === "csv" ? "csv" : "json");
    if (f.out) {
      await writeFile(String(f.out), text);
      return console.log(`  Wrote ${b.entries.length} entries to ${f.out}.`);
    }
    return console.log(text);
  }
  fail(`Usage:\n${BOOK_HELP}\n  Markers: ${MARKERS.join(", ")}`);
}

/** vesk folders: name groups of your own wallets (Launch team, Snipers, Cold). */
export async function folders(args: string[], f: Flags) {
  const c = await config(f.config as string | undefined);
  const b = await loadBook(c.dataDir);
  const [sub, name, list] = args;
  if (!sub || sub === "list") {
    if (json(b.folders)) return;
    if (!b.folders.length) return console.log(dim('  No folders. Try: vesk folders add "Launch team" <addr>,<addr>'));
    return table(b.folders.map((x) => ({ id: x.id, name: x.name, wallets: x.wallets.map(short).join(" ") })));
  }
  if (sub === "add" && name && list) {
    const wallets = list.split(",").map((a) => a.trim()).filter(Boolean);
    const bad = wallets.filter((a) => !isAddress(a));
    if (bad.length) fail(`Not Solana addresses: ${bad.join(", ")}`);
    const folder: WalletFolder = { id: `f_${Math.random().toString(36).slice(2, 7)}`, name: name.slice(0, 40), wallets };
    await saveBook(c.dataDir, { ...b, folders: [...b.folders, folder] });
    return console.log(`  ${up("added")} ${folder.name} (${wallets.length} wallets) as ${ice(folder.id)}`);
  }
  if (sub === "rm" && name) {
    await saveBook(c.dataDir, { ...b, folders: b.folders.filter((x) => x.id !== name) });
    return console.log(`  Removed ${name}.`);
  }
  fail('Usage: vesk folders [list | add "<name>" <addr,addr> | rm <id>]');
}

const SOURCES = ["relay", "official-api", "provider", "off"] as const;
const SOURCE_NOTES: Record<(typeof SOURCES)[number], string> = {
  relay: `${BRAND.name} Relay: one stream ${BRAND.name} runs with its own X key, free for ${BRAND.token} holders. Curated popular accounts plus up to ${RELAY_MAX_PER_USER} you ask for. Needs \`vesk pair\`.`,
  "official-api": "Your own X developer token (X_BEARER_TOKEN). Your plan's limits apply. `vesk summon --stream` uses the filtered stream.",
  provider: "A data provider you pay for posts to http://127.0.0.1:<port>/x with an HMAC signature.",
  off: "No X watching.",
};

/** vesk tracker source [relay|official-api|provider|off] */
export async function trackerSource(args: string[], f: Flags) {
  const c = await config(f.config as string | undefined);
  const want = args[0] as (typeof SOURCES)[number] | undefined;
  if (!want) {
    console.log(`  ${bold("X source")} ${ice(c.x.source)}`);
    for (const s of SOURCES) console.log(`  ${s === c.x.source ? ice("›") : " "} ${s.padEnd(13)} ${dim(SOURCE_NOTES[s])}`);
    return;
  }
  if (!SOURCES.includes(want)) fail(`Unknown source "${want}". Pick one of: ${SOURCES.join(", ")}.`);
  if (want === "relay" && !c.panel?.url) fail("The relay needs a paired panel. In the panel: Settings → Self-hosted → Pair, then run `vesk pair <CODE> --panel <url>`.");
  const p = await setConfigValue(f.config as string | undefined, ["x", "source"], want);
  console.log(`  X source is now ${ice(want)} ${dim(`(${p})`)}`);
  console.log(dim(`  ${SOURCE_NOTES[want]}`));
  if (want === "official-api" && !process.env[c.x.bearerTokenEnv]) console.log(warn(`  Set ${c.x.bearerTokenEnv} or run \`vesk keys set ${c.x.bearerTokenEnv}\`.`));
  console.log(dim("  Restart the agent (vesk stop, then vesk summon) to switch."));
}
