/**
 * The strategy runner (v19): the agent's loop for Strategy & safety and Rogue mode.
 *
 *   PumpPortal data stream ─▶ new coin ─▶ Rogue target?  ─yes─▶ Rogue: size, buy (soft filters skipped)
 *                                     └─▶ new coins on?  ─yes─▶ early-volume trigger ─▶ bounds ─▶ rug check ─▶ size ─▶ buy
 *   every second: early-volume windows, no-volume exits, scale-in adds, Rogue exits (stall, stop-loss, not a leader)
 *   v20: the rug check also runs the fake-pump checks (fakePump.ts); a big buy that lands on a coin we hold can trigger
 *   a sell of our own position (sellIntoBuys.ts) when that exit is on
 *
 * Every buy goes through the executor: guardrails and limits first (with the Rogue budget for Rogue buys), then the
 * can-sell check, then signing. Every step is a pipeline event, so Live and `vesk live` show it. The stream only runs
 * while it's needed (new coins on, a Rogue session, or open strategy positions to watch).
 */
import { PULSE_SUPPLY, xHandle, type PulseMessage } from "../watch/pulse.js";
import { PulseFeed } from "../watch/pulseFeed.js";
import { enrichCoin } from "../watch/enrich.js";
import { linkableFunding, linkCtxOf, pulseAudits, type PulseEnrichment } from "../watch/audits.js";
import type { Rpc } from "../rpc.js";
import type { State } from "../state.js";
import type { Executor } from "../trade/executor.js";
import type { ExecParams } from "../trade/settings.js";
import { solUsd as fetchSolUsd } from "../market.js";
import { earlyVolume, entryBounds, noVolumeDue, scaleInDue, sizeFor, volumeSince, type TradeTick } from "./entry.js";
import { isDevRug, rugCheck, rugFactsFromAudits } from "./rug.js";
import { exitSpecOf, type StrategySettings } from "./settings.js";
import { fakePumpFacts, type SizedTick } from "./fakePump.js";
import { afterBigBuy, bigBuyDecision, type BigBuyState } from "./sellIntoBuys.js";
import { newRogueSession, rogueActive, rogueBought, rogueCanBuy, rogueExits, rogueMatch, rogueSold, type RogueSession } from "./rogue.js";

export interface RunnerDeps {
  rpc: Rpc;
  state: State;
  executor: () => Executor;
  address: () => string;
  settings: () => StrategySettings;
  tradeParams: (side: "buy" | "sell") => Promise<ExecParams>;
  paused: () => boolean;
  /** The Rogue window ended: put the strategy back to normal mode (saves rules.json). */
  endRogue: () => Promise<void>;
  /** For tests: a feed you drive yourself, and a clock. */
  feed?: PulseFeed;
  now?: () => number;
  solUsd?: () => Promise<number>;
}

interface Candidate { id: string; mint: string; symbol: string; createdAt: number; dev?: string; pump: boolean }
/** Per open strategy position: how it was opened (for scale-in and the right exits). */
export interface StrategyPos { mint: string; kind: "strategy" | "rogue"; firstSol: number; adds: number; openedAt: number }

const MISS_EVERY_MS = 1500;

export class StrategyRunner {
  private feed?: PulseFeed;
  private ticks = new Map<string, TradeTick[]>();
  private waiting = new Map<string, Candidate>();
  private devInit = new Map<string, { dev: string; tokens: number; at: number; sells: Array<{ at: number; tokens: number }> }>();
  private devRugs = new Map<string, Set<string>>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = new Set<string>();
  private lastMiss = 0;
  private usd = 150;
  private ending = false;
  private bigBuys = new Map<string, BigBuyState>();
  constructor(private d: RunnerDeps) {}

  private now() { return this.d.now?.() ?? Date.now(); }
  get positions(): StrategyPos[] { return (this.d.state.data.strategyPos ??= []); }
  get session(): RogueSession | null { return this.d.state.data.rogue ?? null; }
  /** The feed's protocol for a coin, when it saw its create ("pumpfun", "letsbonk", …). */
  protocolOf(mint: string): string | undefined { return this.feed?.state.tokens[mint]?.protocol; }

  /** Start or stop the stream and the clock to match the settings (call after every settings change). */
  sync(): void {
    const s = this.d.settings();
    const now = this.now();
    // a Rogue session starts when the mode says so (a new start time is a new session)
    if (rogueActive(s, now) && this.session?.startedAt !== s.rogueStartedAt) {
      this.d.state.data.rogue = newRogueSession(s.rogue, s.rogueStartedAt!);
      this.d.state.log({ kind: "status", message: `Rogue mode on: ${s.rogue.ticker ? `$${s.rogue.ticker}` : `"${s.rogue.keywords.join('", "')}"`} for ${s.rogue.windowMin} min, ${s.rogue.maxCoins} coins at ${s.rogue.perCoinSol} SOL, budget ${s.rogue.budgetSol} SOL` });
    }
    const held = this.d.state.data.positions.filter((p) => p.wallet === this.d.address() && p.tokens > 0);
    const need = s.entry.autoNewCoins || rogueActive(s, now) || this.positions.length > 0 || this.waiting.size > 0 || (s.exits.sellIntoBuys.enabled && held.length > 0);
    if (need && !this.feed) {
      this.feed = this.d.feed ?? new PulseFeed({ onMessage: (m, isNew) => this.onMessage(m, isNew), onError: (e) => this.d.state.log({ kind: "error", message: `Strategy stream: ${e.message}` }), metadata: true });
      if (!this.d.feed) this.feed.start();
      this.timer = setInterval(() => void this.tick(), 1000);
      void (this.d.solUsd ?? fetchSolUsd)().then((v) => { if (v > 0) this.usd = v; }).catch(() => undefined);
      this.d.state.log({ kind: "status", message: `Strategy: watching new coins${s.entry.autoNewCoins ? ` (${s.entry.earlyVolume.enabled ? `early volume ${s.entry.earlyVolume.windowSec} s` : "no early-volume trigger"})` : ""}${rogueActive(s, now) ? " · Rogue mode" : ""}` });
    } else if (!need && this.feed) this.stop();
    // v20: follow trades on every coin we hold, so a big buy on one can be sold into
    if (this.feed && s.exits.sellIntoBuys.enabled && held.length) this.feed.watchMints(held.map((p) => p.mint));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.d.feed) this.feed?.stop();
    this.feed = undefined;
  }

  /** Feed a message by hand (tests, or another stream). */
  onMessage(m: PulseMessage, isNew: boolean): void {
    if (!m.mint) return;
    const now = this.now();
    if ((m.txType === "buy" || m.txType === "sell") && m.traderPublicKey) {
      const l = this.ticks.get(m.mint) ?? [];
      l.push({ at: now, side: m.txType, sol: Number(m.solAmount ?? 0), wallet: m.traderPublicKey, tokens: Number(m.tokenAmount ?? 0) });
      if (l.length > 3000) l.splice(0, l.length - 3000);
      this.ticks.set(m.mint, l);
      const di = this.devInit.get(m.mint);
      if (di && m.txType === "sell" && m.traderPublicKey === di.dev) {
        di.sells.push({ at: now, tokens: Number(m.tokenAmount ?? 0) });
        if (isDevRug(di.at, di.tokens, di.sells)) { const set = this.devRugs.get(di.dev) ?? new Set(); set.add(m.mint); this.devRugs.set(di.dev, set); }
      }
      if (m.txType === "buy") this.onBigBuy(m, now);
    }
    if (m.txType === "create" && isNew) {
      if (m.traderPublicKey) this.devInit.set(m.mint, { dev: m.traderPublicKey, tokens: Number(m.initialBuy ?? 0), at: now, sells: [] });
      void this.onCreate(m.mint).catch((e: Error) => this.d.state.log({ kind: "error", message: `Strategy: ${e.message}`, mint: m.mint }));
    }
  }

  private async onCreate(mint: string): Promise<void> {
    const s = this.d.settings();
    const t = this.feed?.state.tokens[mint];
    if (!t) return;
    const now = this.now();
    const c: Candidate = { id: `s-${mint.slice(0, 6)}-${now.toString(36)}`, mint, symbol: t.symbol || mint.slice(0, 4), createdAt: t.createdAt, dev: t.creator, pump: t.protocol === "pumpfun" };
    if (rogueActive(s, now) && this.session) {
      // metadata (the X link) may still be loading; the ticker and name are in the create itself
      const r = rogueMatch(s.rogue, { symbol: t.symbol, name: t.name, creator: t.creator, xHandle: xHandle(t.socials.x) });
      if (r.match) return this.rogueBuy(c, r.why, r.expected);
    }
    if (!s.entry.autoNewCoins || this.d.paused()) return;
    if (s.entry.earlyVolume.enabled) {
      this.waiting.set(mint, c);
      this.d.state.stage({ id: c.id, stage: "watch", outcome: "start", source: "pulse", mint, symbol: c.symbol, reason: `new pair ${c.symbol} · early volume over ${s.entry.earlyVolume.windowSec} s` });
      return;
    }
    this.d.state.stage({ id: c.id, stage: "watch", outcome: "pass", source: "pulse", mint, symbol: c.symbol, reason: `new pair ${c.symbol}` });
    await this.check(c, null);
  }

  /** The early-volume trigger fired (or there is none): bounds, rug check, size, buy. */
  private async check(c: Candidate, fired: string | null): Promise<void> {
    const s = this.d.settings();
    const t = this.feed?.state.tokens[c.mint];
    if (!t || this.busy.has(c.mint)) return;
    const now = this.now();
    const stage = (e: Parameters<State["stage"]>[0]) => this.d.state.stage({ ...e, mint: c.mint, symbol: c.symbol, source: "pulse" });
    const refuse = (reason: string) => {
      stage({ id: c.id, stage: "check", outcome: "fail", reason, action: "filtered", result: "not traded" });
      this.d.state.log({ kind: "skip", message: `Strategy skipped ${c.symbol}: ${reason}`, mint: c.mint });
    };
    if (fired) {
      stage({ id: c.id, stage: "watch", outcome: "pass", reason: fired });
      this.d.state.log({ kind: "signal", message: `Strategy: ${c.symbol} ${fired}`, mint: c.mint });
    }
    stage({ id: c.id, stage: "check", outcome: "start" });
    const bound = entryBounds(s.entry, { mcapUsd: t.mcapSol * this.usd, liquiditySol: t.liquiditySol, ageSec: (now - t.createdAt) / 1000 });
    if (bound) return refuse(bound);
    if (this.d.state.data.positions.some((p) => p.mint === c.mint)) return refuse("already holding this coin");
    if (s.rug.enabled) {
      let e: PulseEnrichment | undefined;
      if (s.rug.enrich) e = await enrichCoin(this.d.rpc, c.mint, { dev: c.dev, countHolders: true }).catch(() => undefined);
      const a = pulseAudits(this.feed!.state, t, e);
      const devRugs = c.dev ? [...(this.devRugs.get(c.dev) ?? [])].filter((m) => m !== c.mint).length : 0;
      // pump.fun mints are created with mint and freeze authority revoked; others: the can-sell check reads the mint
      const facts = rugFactsFromAudits(a, { bundledExact: !!e?.funding, devRugs, mintRevoked: c.pump ? true : null, freezeRevoked: c.pump ? true : null, onCurve: !t.migrated, lpLocked: t.migrated ? null : undefined });
      // v20: the fake-pump checks, from the trades seen since the create (clusters through funding links, when read)
      if (this.devInit.has(c.mint)) {
        const links = linkableFunding(e?.funding, linkCtxOf(e)).funding;
        const fp = fakePumpFacts(s.rug, c.createdAt, (this.ticks.get(c.mint) ?? []).filter((x): x is SizedTick => x.tokens !== undefined), PULSE_SUPPLY, links ? (w) => links[w] : undefined);
        facts.concentration = fp.concentration;
        facts.spikeDump = fp.spikeDump;
      }
      const r = rugCheck(s.rug, facts);
      if (!r.ok) return refuse(r.reason!);
    }
    await this.buy(c, "strategy", false, `Strategy: ${fired ?? "passed the checks"}`);
  }

  private async rogueBuy(c: Candidate, why: string, expected: boolean): Promise<void> {
    const s = this.d.settings();
    const stage = (e: Parameters<State["stage"]>[0]) => this.d.state.stage({ ...e, mint: c.mint, symbol: c.symbol, source: "pulse" });
    stage({ id: c.id, stage: "watch", outcome: "pass", reason: `Rogue: ${why}${expected ? " (expected)" : ""}` });
    this.d.state.log({ kind: "signal", message: `Rogue: ${c.symbol} ${why}${expected ? " (expected)" : ""}`, mint: c.mint });
    const can = rogueCanBuy(s.rogue, this.session!, c.mint, this.now());
    if (!can.ok) {
      stage({ id: c.id, stage: "check", outcome: "fail", reason: can.reason, action: "skipped", result: "not traded" });
      this.d.state.log({ kind: "skip", message: `Rogue skipped ${c.symbol}: ${can.reason}`, mint: c.mint });
      return;
    }
    await this.buy(c, "rogue", expected, `Rogue: ${why}${expected ? " (expected)" : ""}`);
  }

  private async buy(c: Candidate, kind: "strategy" | "rogue", expected = false, note?: string): Promise<void> {
    if (this.busy.has(c.mint)) return;
    this.busy.add(c.mint);
    try {
      const s = this.d.settings();
      const stage = (e: Parameters<State["stage"]>[0]) => this.d.state.stage({ ...e, mint: c.mint, symbol: c.symbol, source: "pulse" });
      let amountSol: number, why: string;
      if (kind === "rogue") { amountSol = s.rogue.perCoinSol; why = `Rogue · ${amountSol} SOL per coin`; }
      else {
        const wal = s.entry.size.mode === "pct" ? await this.d.rpc.getBalanceSol(this.d.address()).catch(() => undefined) : undefined;
        const z = sizeFor(s.entry.size, wal);
        amountSol = z.amountSol; why = z.reason;
        if (!(amountSol > 0)) {
          stage({ id: c.id, stage: "check", outcome: "fail", reason: z.reason, action: "skipped", result: "not traded" });
          return;
        }
      }
      const x = await this.d.tradeParams("buy");
      stage({ id: c.id, stage: "size", outcome: "pass", amountSol, reason: why });
      const r = await this.d.executor().buy({
        action: "buy", wallet: this.d.address(), mint: c.mint, dev: c.dev, amountSol, slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly,
        venue: "auto", reason: note ?? (kind === "rogue" ? `Rogue: ${c.symbol}` : `Strategy: ${c.symbol}`), rogue: kind === "rogue" || undefined, ...(kind === "strategy" ? { origin: "pulse" as const } : {}), trace: { id: c.id, symbol: c.symbol, source: "pulse" },
      }, c.symbol);
      if (!r.ok) return;
      const p = this.d.state.data.positions.find((q) => q.mint === c.mint && q.wallet === this.d.address());
      if (p) p.exit = exitSpecOf(s.exits);
      this.positions.push({ mint: c.mint, kind, firstSol: amountSol, adds: 0, openedAt: this.now() });
      if (kind === "rogue") this.d.state.data.rogue = rogueBought(this.session!, { mint: c.mint, symbol: c.symbol, boughtAt: this.now(), sol: amountSol, expected });
      const ex = exitSpecOf(s.exits);
      stage({ id: c.id, stage: "exit", outcome: "pass", reason: `armed: ${[ex.takeProfit?.length ? `TP ${ex.takeProfit.map((t) => `${t.atMultiple}x`).join("/")}` : "", ex.stopLossPct ? `SL -${ex.stopLossPct}%` : "", kind === "rogue" ? `stall ${s.rogue.stallSec} s` : s.exits.noVolume.enabled ? `no volume ${s.exits.noVolume.windowSec} s` : ""].filter(Boolean).join(" · ") || "none"}` });
      await this.d.state.save();
    } finally {
      this.busy.delete(c.mint);
    }
  }

  /**
   * v20: someone else's buy landed on a coin we hold. If it's big enough (exits.sellIntoBuys), sell part of OUR position
   * now, as a Jito bundle with a tip. Never a buy, never placed ahead of their transaction (the guardrails check the
   * trigger too). Every attempt is a step in Live with its result.
   */
  private onBigBuy(m: PulseMessage, at: number): void {
    const s = this.d.settings();
    if (!s.exits.sellIntoBuys.enabled || !m.mint) return;
    const mint = m.mint;
    const pos = this.d.state.data.positions.find((p) => p.mint === mint && p.wallet === this.d.address() && p.tokens > 0);
    if (!pos || this.busy.has(mint)) return;
    const own = [this.d.address()];
    const d = bigBuyDecision(s.exits.sellIntoBuys, { ...m, at }, { holds: true, own, state: this.bigBuys.get(mint), now: at });
    if (!d.sell) return;
    this.busy.add(mint);
    this.bigBuys.set(mint, { ...this.bigBuys.get(mint), lastAt: at });
    const id = `b-${mint.slice(0, 6)}-${at.toString(36)}`;
    const stage = (e: Omit<Parameters<State["stage"]>[0], "id" | "mint" | "symbol">) => this.d.state.stage({ ...e, id, mint, symbol: pos.symbol, source: "pulse" });
    stage({ stage: "watch", outcome: "pass", reason: `a ${Math.round(d.trigger.sol * 1000) / 1000} SOL buy landed on $${pos.symbol}` });
    stage({ stage: "exit", outcome: "start", reason: `selling ${d.pct}% into it · tip ${d.tipSol} SOL` });
    void (async () => {
      const t0 = this.now();
      try {
        const x = await this.d.tradeParams("sell");
        const r = await this.d.executor().sell({ action: "sell", wallet: this.d.address(), mint, sellPct: d.pct, reason: d.reason, slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: d.tipSol, jitoOnly: true, trigger: d.trigger });
        const ms = this.now() - t0;
        this.bigBuys.set(mint, afterBigBuy({ ok: r.ok, tipSol: d.tipSol, at }));
        if (r.ok) {
          this.d.state.log({ kind: "sell", message: `${pos.symbol}: ${d.reason} → sold ${d.pct}% in ${ms} ms`, mint, signature: r.signature });
          stage({ stage: "exit", outcome: "done", reason: d.reason, action: "exit", ms, result: `sold ${d.pct}% in ${ms} ms` });
        } else {
          this.d.state.log({ kind: "skip", message: `${pos.symbol}: sell into a big buy missed (${r.error}). Next try tips up to ${s.exits.sellIntoBuys.maxTipSol} SOL.`, mint });
          stage({ stage: "exit", outcome: "fail", reason: `sell into a big buy missed: ${r.error}`, action: "skipped", result: "missed" });
        }
        stage({ stage: "log", outcome: "done", reason: "written" });
      } finally {
        this.busy.delete(mint);
      }
    })();
  }

  private priceSol(mint: string): number | undefined {
    const t = this.feed?.state.tokens[mint];
    return t && t.mcapSol > 0 ? t.mcapSol / PULSE_SUPPLY : undefined;
  }

  /** Every second: early-volume windows, exits, scale-in, Rogue. */
  async tick(): Promise<void> {
    const s = this.d.settings();
    const now = this.now();
    // early-volume windows
    for (const [mint, c] of [...this.waiting]) {
      const ev = earlyVolume(s.entry.earlyVolume, c.createdAt, this.ticks.get(mint) ?? [], now);
      if (ev.status === "fired") { this.waiting.delete(mint); void this.check(c, ev.reason).catch(() => undefined); }
      else if (ev.status === "missed") {
        this.waiting.delete(mint);
        // a busy stream misses most coins: show one every 1.5 s in Live (the rest are dropped quietly)
        if (now - this.lastMiss >= MISS_EVERY_MS) {
          this.lastMiss = now;
          this.d.state.stage({ id: c.id, stage: "check", outcome: "fail", mint, symbol: c.symbol, source: "pulse", reason: ev.reason, action: "filtered", result: "not traded" });
        }
      }
    }
    // open strategy positions: gone (sold elsewhere), no-volume, scale-in
    const held = new Set(this.d.state.data.positions.map((p) => p.mint));
    this.d.state.data.strategyPos = this.positions.filter((p) => held.has(p.mint));
    for (const sp of this.positions) {
      if (this.busy.has(sp.mint)) continue;
      const p = this.d.state.data.positions.find((q) => q.mint === sp.mint);
      if (!p) continue;
      if (sp.kind === "strategy") {
        const nv = noVolumeDue(s.exits.noVolume, sp.openedAt, this.ticks.get(sp.mint) ?? [], now);
        if (nv) { await this.sell(sp.mint, p.symbol, nv); continue; }
        const price = this.priceSol(sp.mint);
        const add = price !== undefined ? scaleInDue(s.entry.scaleIn, { avgEntryPriceSol: p.avgEntryPriceSol, firstSol: sp.firstSol, adds: sp.adds }, price) : null;
        if (add && !this.d.paused()) {
          sp.adds++;
          const x = await this.d.tradeParams("buy");
          await this.d.executor().buy({ action: "buy", wallet: this.d.address(), mint: sp.mint, amountSol: add.addSol, slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly, venue: "auto", reason: add.reason }, p.symbol);
        }
      }
    }
    // Rogue: cut the losers, end the session
    const ses = this.session;
    if (ses) {
      const live: Record<string, { mint: string; mcapUsd?: number; priceMult?: number; volSol?: number }> = {};
      for (const c of ses.coins.filter((x) => !x.sold)) {
        const t = this.feed?.state.tokens[c.mint];
        const p = this.d.state.data.positions.find((q) => q.mint === c.mint);
        const price = this.priceSol(c.mint);
        live[c.mint] = { mint: c.mint, mcapUsd: t ? t.mcapSol * this.usd : undefined, priceMult: price !== undefined && p && p.avgEntryPriceSol > 0 ? price / p.avgEntryPriceSol : undefined, volSol: volumeSince(this.ticks.get(c.mint) ?? [], now, s.rogue.stallSec) };
        if (!p) this.d.state.data.rogue = rogueSold(this.session!, c.mint, "sold elsewhere", now);
      }
      for (const x of rogueExits(s.rogue, this.session!, live, now)) {
        if (this.busy.has(x.mint)) continue;
        const ok = await this.sell(x.mint, x.symbol, x.reason);
        if (ok) this.d.state.data.rogue = rogueSold(this.session!, x.mint, x.reason, now);
      }
      if (now >= ses.endsAt && s.mode === "rogue" && !this.ending) {
        this.ending = true;
        const open = this.session!.coins.filter((c) => !c.sold).length;
        this.d.state.log({ kind: "status", message: `Rogue window over: bought ${ses.coins.length} coin${ses.coins.length === 1 ? "" : "s"} for ${ses.spentSol} SOL${open ? `, ${open} still open (exits keep running)` : ""}` });
        await this.d.endRogue().catch(() => undefined);
        this.ending = false;
      }
      if (now >= ses.endsAt && !this.session!.coins.some((c) => !c.sold)) this.d.state.data.rogue = null;
    }
    this.sync();
  }

  private async sell(mint: string, symbol: string, reason: string): Promise<boolean> {
    this.busy.add(mint);
    try {
      this.d.state.log({ kind: "sl", message: `${symbol}: ${reason}`, mint });
      this.d.state.stage({ id: `x-${mint.slice(0, 6)}-${this.now().toString(36)}`, stage: "exit", outcome: "done", mint, symbol, reason, action: "exit", result: "sell 100%" });
      const x = await this.d.tradeParams("sell");
      const r = await this.d.executor().sell({ action: "sell", wallet: this.d.address(), mint, sellPct: 100, reason, slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly });
      return r.ok;
    } finally {
      this.busy.delete(mint);
    }
  }
}

