/**
 * vesk migration [list | buy <mint> <sol> [--preset p2] | sell <mint> <pct> [--preset p1] | rm <id> | watch [--for sec] [--paper]] [--json]
 * Migration orders: buy a coin the moment it migrates, or sell what you hold when it does. A running agent
 * (`vesk summon`) watches migrations by itself while any order is armed; `watch` runs the same thing in the
 * foreground. Every order goes through the executor's guardrails, limits and blacklist, with your preset.
 */
import { describeMigrationOrder, isPresetId, MigrationWatcher, newMigrationOrder, normalizeMigrationOrders, RuleStore, type MigrationOrder } from "@vesk-agent/core";
import { agent, config } from "../context.js";
import { dim, fail, ice, json, line, table, up } from "../ui.js";

export async function migration(args: string[], f: Record<string, unknown>) {
  const [sub, a1, a2] = args;
  if (f.preset !== undefined && !isPresetId(f.preset)) fail("--preset is p1, p2 or p3.");
  if (sub === "watch") return watchMigrations(f);
  const c = await config(f.config as string | undefined);
  const s = await new RuleStore(c.dataDir).load();
  const orders = normalizeMigrationOrders(s.data.migration);
  if (sub === "buy" || sub === "sell") {
    if (!a1 || !a2) fail(`Usage: vesk migration ${sub} <mint> <${sub === "buy" ? "sol" : "percent"}> [--preset p2]`);
    let o: MigrationOrder;
    try { o = newMigrationOrder({ mint: a1, side: sub, ...(sub === "buy" ? { amountSol: Number(a2) } : { pct: Number(String(a2).replace("%", "")) }), preset: isPresetId(f.preset) ? f.preset : undefined }); } catch (e) { return fail((e as Error).message); }
    s.data.migration = [...orders, o];
    await s.save();
    if (json(o)) return;
    return console.log(`  ${describeMigrationOrder(o)} · armed (${ice(o.id)}). A running agent starts watching within 2 s.`);
  }
  if (sub === "rm") {
    if (!a1) fail("Usage: vesk migration rm <id>");
    if (!orders.some((o) => o.id === a1)) fail(`No migration order ${a1}.`);
    s.data.migration = orders.map((o) => (o.id === a1 && o.status === "armed" ? { ...o, status: "cancelled" as const } : o));
    await s.save();
    return console.log(`  Cancelled ${a1}.`);
  }
  if (json(orders)) return;
  if (!orders.length) return console.log(dim("  No migration orders. Add one: vesk migration buy <mint> 0.1 --preset p2"));
  table(orders.map((o) => ({ id: o.id, coin: o.symbol ?? `${o.mint.slice(0, 4)}…${o.mint.slice(-4)}`, order: o.side === "buy" ? `buy ${o.amountSol} SOL` : `sell ${o.pct}%`, preset: (o.preset ?? "active").toUpperCase(), status: o.status, result: (o.result ?? "").slice(0, 24) })));
}

async function watchMigrations(f: Record<string, unknown>) {
  const a = await agent({ config: f.config as string | undefined, paper: !!f.paper });
  const armed = a.migrationOrders().filter((o) => o.status === "armed");
  if (!armed.length) fail("No armed migration orders. Add one with `vesk migration buy <mint> <sol>`.");
  console.log(dim(`  Watching migrations for ${armed.length} order${armed.length === 1 ? "" : "s"} · ctrl-c stops`));
  let busy = Promise.resolve();
  const w = new MigrationWatcher((e) => {
    busy = busy.then(async () => {
      const before = a.migrationOrders();
      await a.onMigration(e);
      for (const o of a.migrationOrders()) {
        const was = before.find((x) => x.id === o.id);
        if (was?.status === "armed" && o.status !== "armed") line(o.status === "done" ? (o.side === "buy" ? "buy" : "sell") : "guardrail", `${describeMigrationOrder(o)} · ${o.status === "done" ? "done" : `refused: ${o.result}`}`, o.status === "done" ? up : undefined);
      }
      if (!a.migrationOrders().some((o) => o.status === "armed")) stop();
    });
  }, (e) => line("error", e.message));
  const stop = () => { w.stop(); void a.state.save().then(() => process.exit(0)); };
  w.start();
  process.on("SIGINT", stop);
  if (f.for) setTimeout(stop, Number(f.for) * 1000);
}
