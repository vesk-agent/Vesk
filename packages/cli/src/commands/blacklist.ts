/**
 * vesk blacklist [list | add <mint|dev|funder|wallet> <address> [--note "..."] | rm <kind> <address> | import <file> [--kind mint] | export [--out file]] [--json]
 * Coins, devs, funding wallets and wallets you never buy. Buys are refused by the guardrails; rules skip them;
 * Pulse and the tracker hide them. The panel edits the same list.
 */
import { readFile, writeFile } from "node:fs/promises";
import { addToBlacklist, BLACKLIST_KINDS, BLACKLIST_LABEL, exportBlacklist, importBlacklist, normalizeBlacklist, removeFromBlacklist, RuleStore, type BlacklistKind } from "@vesk-agent/core";
import { config } from "../context.js";
import { dim, fail, json, table } from "../ui.js";

const KIND: Record<string, BlacklistKind> = { mint: "mints", mints: "mints", ca: "mints", dev: "devs", devs: "devs", funder: "funders", funders: "funders", wallet: "wallets", wallets: "wallets" };

export async function blacklist(args: string[], f: Record<string, unknown>) {
  const c = await config(f.config as string | undefined);
  const s = await new RuleStore(c.dataDir).load();
  let b = normalizeBlacklist(s.data.blacklist);
  const [sub, k, addr] = args;
  const kind = KIND[String(k ?? "")];
  if (sub === "add" || sub === "rm") {
    if (!kind || !addr) fail(`Usage: vesk blacklist ${sub} <mint|dev|funder|wallet> <address>`);
    try { b = sub === "add" ? addToBlacklist(b, kind, addr, typeof f.note === "string" ? f.note : undefined) : removeFromBlacklist(b, kind, addr); } catch (e) { return fail((e as Error).message); }
    s.data.blacklist = b;
    await s.save();
    return console.log(`  ${sub === "add" ? "Added to" : "Removed from"} ${BLACKLIST_LABEL[kind].toLowerCase()}: ${addr}`);
  }
  if (sub === "import") {
    if (!k) fail("Usage: vesk blacklist import <file> [--kind mint]");
    const def = KIND[String(f.kind ?? "mint")] ?? "mints";
    try { const r = importBlacklist(await readFile(k, "utf8"), b, def); s.data.blacklist = r.list; await s.save(); return console.log(`  Imported ${r.added} new address${r.added === 1 ? "" : "es"}.`); } catch (e) { return fail((e as Error).message); }
  }
  if (sub === "export") {
    const text = exportBlacklist(b);
    if (typeof f.out === "string") { await writeFile(f.out, text); return console.log(`  Wrote ${f.out}`); }
    return console.log(text);
  }
  if (json(b)) return;
  const rows = BLACKLIST_KINDS.flatMap((x) => b[x].map((e) => ({ kind: BLACKLIST_LABEL[x], address: e.address, note: e.note ?? "" })));
  if (!rows.length) return console.log(dim("  Your blacklist is empty. Add one: vesk blacklist add dev <address> --note \"rugged twice\""));
  table(rows);
}
