/**
 * vesk wallets: many wallets in one encrypted keystore.
 *   list | import <file> | activate <addr…> | deactivate <addr…> | label <addr|n> "<name>" | rm <addr>
 *   fund --total 1 [--to addr,addr] | fund --each 0.2 | return
 * Keys are read from a file (or pasted, hidden), encrypted into the keystore and never printed or logged.
 * Funding and returns are plain, direct on-chain transfers between your own wallets.
 */
import { readFile } from "node:fs/promises";
import { loadBookFile, parseWalletImport, resolveWalletRef, saveBookFile, setOwnLabel, withOwnLabels } from "@vesk-agent/core";
import { agent, config, unlock } from "../context.js";
import { askHidden, confirm, dim, fail, ice, json, sol, table, up, warn } from "../ui.js";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export async function wallets(args: string[], flags: Record<string, string | boolean | undefined>) {
  const [sub, ...rest] = args;
  const cfgPath = flags.config as string | undefined;

  if (!sub || sub === "list") {
    const a = await agent({ config: cfgPath });
    const ws = await a.wallets();
    if (json(ws.map(({ address, label, active, main, balanceSol }) => ({ address, label, active, main, balanceSol })))) return;
    table(ws.map((w) => ({ label: w.label, address: w.address, balance: sol(w.balanceSol), active: w.main ? "main" : w.active ? "yes" : "no" })));
    console.log(dim(`  Rename: vesk wallets label <address|number> "<name>"  (number = the n in "Wallet n"; main = Main)`));
    const n = ws.filter((w) => !w.main && w.active).length;
    console.log(dim(`  ${n} active wallet${n === 1 ? "" : "s"} available as disclosed team wallets at launch.`));
    return;
  }

  if (sub === "import") {
    const file = rest[0];
    const text = file ? await readFile(file, "utf8") : await askHidden("Paste keys (one per line), then Enter: ");
    const parsed = parseWalletImport(text);
    for (const e of parsed.errors) console.log(`  ${warn(e.where)}  ${e.reason}`);
    if (!parsed.entries.length) fail("No valid keys found.");
    const ks = await unlock(await config(cfgPath));
    const r = await ks.importWallets(parsed.entries, !flags.inactive);
    for (const s of r.skipped) console.log(`  ${warn(s.where)}  ${s.reason}`);
    console.log(`  ${up("imported")} ${r.added.length} wallet${r.added.length === 1 ? "" : "s"} ${dim("(encrypted with scrypt + AES-256-GCM in your keystore)")}`);
    table(r.added.map((w) => ({ label: w.label, address: w.address })));
    if (file) console.log(warn(`  Delete ${file} now. Your keys are in the keystore.`));
    return;
  }

  if (sub === "label") {
    // Names live in the address book (book.json), the same registry the panel uses; no keystore unlock needed.
    const c = await config(cfgPath);
    const a = await agent({ config: cfgPath });
    const ws = (await a.wallets()).map(({ address, main }) => ({ address, main }));
    const ref = rest[0] ?? "";
    const address = resolveWalletRef(ws, ref);
    if (!address) fail(`No wallet "${ref}". Use an address, a number from "Wallet n", or main.`);
    const book = await loadBookFile(c.dataDir);
    try {
      const entries = setOwnLabel(book.entries, ws, address, rest.slice(1).join(" "));
      await saveBookFile(c.dataDir, { ...book, entries });
      const now = withOwnLabels(ws, entries).find((w) => w.address === address)!;
      return console.log(`  ${up("saved")} ${short(address)} is now ${ice(now.label)}${dim(" (private: launch disclosures publish addresses, never names)")}`);
    } catch (e) { fail((e as Error).message); }
  }

  if (sub === "activate" || sub === "deactivate" || sub === "rm") {
    const ks = await unlock(await config(cfgPath));
    for (const addr of rest) {
      if (sub === "rm") {
        if (!(await confirm(warn(`  Remove ${short(addr)} from the keystore? Export or empty it first.`)))) continue;
        await ks.removeWallet(addr);
      } else await ks.setWalletActive(addr, sub === "activate");
      console.log(`  ${sub === "rm" ? "removed" : sub + "d"} ${short(addr)}`);
    }
    return;
  }

  if (sub === "fund") {
    const a = await agent({ config: cfgPath });
    const ws = (await a.wallets()).filter((w) => !w.main);
    const targets = flags.to ? String(flags.to).split(",").map((s) => s.trim()) : ws.filter((w) => w.active).map((w) => w.address);
    const each = flags.each ? Number(flags.each) : undefined;
    const total = flags.total ? Number(flags.total) : undefined;
    if (!each && !total) fail("Usage: vesk wallets fund --total 1 [--to a,b] | --each 0.2");
    const mode = each ? "custom" : "even";
    const amounts = each ? Object.fromEntries(targets.map((t) => [t, each])) : undefined;
    console.log(`  Direct transfers from ${ice(short(a.address))} to ${targets.length} wallet${targets.length === 1 ? "" : "s"}: ${each ? `${each} SOL each` : `${total} SOL split evenly`}`);
    console.log(dim("  Plain System Program transfers, visible on-chain. Nothing is routed through exchanges."));
    if (!flags.yes && !(await confirm("  Send?"))) return;
    const r = await a.fundWallets({ targets, mode, totalSol: total, amounts });
    for (const s of r) console.log(`  ${s.ok ? up("sent") : warn("failed")} ${dim(s.signature)}`);
    return;
  }

  if (sub === "return") {
    const a = await agent({ config: cfgPath });
    if (!flags.yes && !(await confirm(`  Send all SOL from your imported wallets back to ${short(a.address)}?`))) return;
    const r = await a.returnAll();
    if (!r.length) console.log(dim("  Nothing to return."));
    for (const s of r) console.log(`  ${s.ok ? up("returned") : warn("failed")} ${dim(s.signature)}`);
    return;
  }

  fail(`Unknown: vesk wallets ${sub}. Try list, import, activate, deactivate, label, rm, fund, return.`);
}

export const WALLETS_HELP = `  vesk wallets [list]           main + imported wallets, balances, active flag
  vesk wallets import <file>    many keys at once: one per line, CSV (label,key) or JSON
  vesk wallets label <addr|n|main> "<name>"   rename (empty name = back to the default)
  vesk wallets activate|deactivate <addr…> | rm <addr>
  vesk wallets fund --total 1 [--to a,b] | --each 0.2   direct transfers from main
  vesk wallets return           send everything back to main`;
