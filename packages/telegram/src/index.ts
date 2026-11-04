/**
 * Your own Telegram bot for your own agent. Runs the agent in the same process.
 * Only chat ids in `telegram.allowedChatIds` are answered; everyone else is ignored.
 *
 *   /status  /positions  /rules  /pause  /resume  /kill on|off  /buy <mint> <sol>  /sell <mint> <pct>
 *   /copy [feed | on|off <label|all>]   copy trading; Confirm-mode copies arrive with [Copy] [Skip] buttons
 *   anything else → chat → rule draft with [Confirm] [Discard] buttons ("copy @label with 0.2 SOL, skip above 300k mcap")
 */
import { Agent, describeRule, Keystore, loadConfig, positionPnl, secret, snapshot, type ParseResult, type Rule } from "@vesk-agent/core";
import { confirmCardText, fmtGap, pairCounts, parseNameReply, pendingText, raceLabel, REPORTED_TOTAL, type LaunchOnPostRule } from "@vesk-agent/core";
import { bulkEdit, copyStats, feedLine, normalizeCopyConfig, pendingCopyText, resolveCopyDraft, shortAddr, upsertCopyWallet, type CopyWallet } from "@vesk-agent/core";
import { applyStrategyChat, BRAND, validateStrategy, type StrategyChat } from "@vesk-agent/core";
import { claimGroups, fmtTokens, type ClaimChat, type SupplyChat } from "@vesk-agent/core";

type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { id: number } };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
};

export class Bot {
  private offset = 0;
  private drafts = new Map<string, Rule>();
  private launchDrafts = new Map<string, LaunchOnPostRule>();
  private copyDrafts = new Map<string, Partial<CopyWallet> & { address: string }>();
  /** v19: Strategy & safety and Rogue mode from chat; "ok2" is the second confirm for Rogue without the can-sell check. */
  private strategyDrafts = new Map<string, StrategyChat>();
  /** v23, v26: "claim my fees" waiting for Claim. */
  private claimDrafts = new Map<string, ClaimChat>();
  /** v25: a burn waiting for "Burn" after its plan was shown. */
  private burnDrafts = new Map<string, SupplyChat>();
  constructor(private token: string, private allowed: number[], private agent: Agent) {}

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
    return j.result;
  }

  /** v26: the confirm card: the post's picture with the coin preview as its caption, and the buttons. */
  sendPhoto(chat: number, photo: string, caption: string, buttons?: Array<Array<{ text: string; callback_data: string }>>) {
    return this.api("sendPhoto", { chat_id: chat, photo, caption: caption.slice(0, 1000), ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  }

  send(chat: number, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>) {
    return this.api("sendMessage", { chat_id: chat, text, disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  }

  /** Forward the interesting activity to every allowed chat. */
  notify() {
    // Launch-on-post drafts in Confirm mode: one message with Launch / Skip buttons.
    let seen = new Set<string>();
    setInterval(() => {
      for (const p of this.agent.state.data.pendingLaunches) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        // v26 naming "ask": one key per suggestion (launch with that name), then Skip; or reply "Name $TICKER"
        const kb = p.ask
          ? [...(p.suggestions ?? []).map((x, i) => [{ text: `Launch ${x.name} $${x.symbol}`, callback_data: `pn:${p.id}:${i}` }]), [{ text: "Skip", callback_data: `ps:${p.id}` }]]
          : [[{ text: `Launch $${p.token.symbol}`, callback_data: `pl:${p.id}` }, { text: "Skip", callback_data: `ps:${p.id}` }]];
        // v26: with the post's picture when it has one (falls back to text if Telegram can't fetch it)
        for (const c of this.allowed) void (p.imageUrl ? this.sendPhoto(c, p.imageUrl, confirmCardText(p), kb).catch(() => this.send(c, pendingText(p), kb)) : this.send(c, pendingText(p), kb)).catch(() => undefined);
      }
      // Copy trading in Confirm mode: Copy / Skip buttons (they expire after a minute; the price moves on).
      for (const p of this.agent.state.data.copyPending) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        for (const c of this.allowed) void this.send(c, pendingCopyText(p), [[{ text: `Copy ${p.amountSol} SOL`, callback_data: `cc:${p.id}` }, { text: "Skip", callback_data: `cs:${p.id}` }]]).catch(() => undefined);
      }
      if (seen.size > 500) seen = new Set([...seen].slice(-200));
    }, 1500);
    // Copies that went through (or failed), and alert-only matches. Skips stay in the feed (/copy feed), not your chat.
    this.agent.copy.subscribe((i) => {
      if (!(i.status === "copied" || i.status === "failed" || i.status === "alert")) return;
      const k = `${i.id}:${i.status}`;
      if (seen.has(k)) return;
      seen.add(k);
      const coin = i.symbol ? `$${i.symbol}` : shortAddr(i.mint);
      for (const c of this.allowed) void this.send(c, `COPY  ${i.label} ${i.side === "buy" ? "bought" : "sold"} ${coin} → ${feedLine(i)}${i.ourSig ? `\nhttps://solscan.io/tx/${i.ourSig}` : ""}`).catch(() => undefined);
    });
    this.agent.state.onActivity((a) => {
      if (!["buy", "sell", "tp", "sl", "trail", "guardrail", "launch", "error"].includes(a.kind)) return;
      for (const c of this.allowed) void this.send(c, `${a.kind.toUpperCase()}  ${a.message}${a.signature ? `\nhttps://solscan.io/tx/${a.signature}` : ""}`).catch(() => undefined);
    });
  }

  async handle(u: Update) {
    if (u.callback_query) {
      const chat = u.callback_query.message?.chat.id;
      if (!chat || !this.allowed.includes(chat)) return;
      const [act, id, idx] = (u.callback_query.data ?? "").split(":");
      await this.api("answerCallbackQuery", { callback_query_id: u.callback_query.id });
      if (act === "pl" || act === "ps") return this.send(chat, await this.agent.decidePending(id, act === "pl"));
      if (act === "pn") {
        const p = this.agent.state.data.pendingLaunches.find((x) => x.id === id);
        const s = p?.suggestions?.[Number(idx)];
        return this.send(chat, s ? await this.agent.decidePending(id, true, s) : "That draft expired.");
      }
      if (act === "cc" || act === "cs") return this.send(chat, await this.agent.copy.decide(id, act === "cc"));
      const bd = this.burnDrafts.get(id);
      if (bd) {
        this.burnDrafts.delete(id);
        if (act !== "ok") return this.send(chat, "Nothing was burned.");
        const r = await this.agent.burnSupply({ mint: bd.mint, symbol: bd.symbol, tokens: bd.tokens, pct: bd.pct, confirm: true });
        return this.send(chat, r.ok ? `Burned ${fmtTokens(r.plan!.tokens)} $${r.coin!.symbol}. ${r.signature && r.signature !== "paper" ? `Tx: https://solscan.io/tx/${r.signature}` : ""}`.trim() : `Not burned: ${r.error}`);
      }
      const cl = this.claimDrafts.get(id);
      if (cl) {
        this.claimDrafts.delete(id);
        if (act !== "ok") return this.send(chat, "Discarded.");
        const done = await this.agent.claimFees({ symbol: cl.symbol });
        const lines = done.map((r) => (r.ok ? `Claimed ${r.asset === "SOL" ? `${r.amount.toFixed(4)} SOL` : `${r.amount.toFixed(2)} ${r.asset}`}` : `${r.asset}: ${r.error}`));
        return this.send(chat, lines.join("\n") || "Nothing to claim.");
      }
      const sd = this.strategyDrafts.get(id);
      if (sd) {
        if (act === "no") { this.strategyDrafts.delete(id); return this.send(chat, "Discarded."); }
        const res = applyStrategyChat(this.agent.strategy(), sd, this.agent.limits());
        if (!res.ok) { this.strategyDrafts.delete(id); return this.send(chat, res.error); }
        if (act === "ok" && sd.kind === "rogue" && sd.start && !res.strategy.rogue.honeypot)
          return this.send(chat, "The can-sell check would be OFF for this Rogue session. Fakes of a hyped launch are where honeypots live. Really?", [[{ text: "Yes, without it", callback_data: `ok2:${id}` }, { text: "Cancel", callback_data: `no:${id}` }]]);
        this.strategyDrafts.delete(id);
        const errs = validateStrategy(res.strategy, this.agent.limits());
        if (errs.length) return this.send(chat, errs[0].message);
        this.agent.store.data.strategy = res.strategy;
        if (res.limits) this.agent.store.data.limits = { ...(this.agent.store.data.limits ?? {}), ...res.limits };
        await this.agent.store.save();
        this.agent.runner.sync();
        return this.send(chat, `Saved:\n${res.lines.join("\n")}`);
      }
      const cd = this.copyDrafts.get(id);
      if (cd) {
        this.copyDrafts.delete(id);
        if (act !== "ok") return this.send(chat, "Discarded.");
        this.agent.store.data.copy = upsertCopyWallet(normalizeCopyConfig(this.agent.store.data.copy), cd);
        await this.agent.store.save();
        this.agent.copy.sync();
        return this.send(chat, `Saved. Copying ${cd.label ?? shortAddr(cd.address)}.`);
      }
      const ld = this.launchDrafts.get(id);
      if (ld) {
        this.launchDrafts.delete(id);
        if (act !== "ok") return this.send(chat, "Discarded.");
        await this.agent.store.upsertLaunchRule({ ...ld, enabled: true });
        return this.send(chat, `Saved and on: ${ld.name} (${ld.id}, ${ld.mode === "auto" ? "Auto" : "Confirm"} mode)`);
      }
      const d = this.drafts.get(id);
      if (!d) return this.send(chat, "That draft expired. Send it again.");
      this.drafts.delete(id);
      if (act === "ok") {
        await this.agent.store.upsert({ ...d, enabled: true }, this.agent.limits());
        return this.send(chat, `Saved and on: ${d.name} (${d.id})`);
      }
      return this.send(chat, "Discarded.");
    }
    const m = u.message;
    if (!m?.text) return;
    const chat = m.chat.id;
    if (!this.allowed.includes(chat)) return; // silent for strangers
    const [cmd, ...args] = m.text.trim().split(/\s+/);
    const a = this.agent;
    switch (cmd.split("@")[0]) {
      case "/launch":
      case "/skip": {
        // v26: "/launch <id> Night Ferry $FERRY" names the coin (naming "ask", or to change the drafted name)
        const named = cmd.startsWith("/launch") && args.length > 1 ? parseNameReply(args.slice(1).join(" ")) : null;
        if (cmd.startsWith("/launch") && args.length > 1 && !named) return this.send(chat, "Name it like: /launch <id> Night Ferry $FERRY");
        return this.send(chat, args[0] ? await a.decidePending(args[0], cmd.startsWith("/launch"), named ?? undefined) : `Usage: ${cmd} <draft id> [Name $TICKER]`);
      }
      case "/start":
      case "/help":
        return this.send(chat, `${BRAND.name} is listening.\n/status /positions /rules /pause /resume /kill on|off\n/buy <mint> <sol>  /sell <mint> <pct>  /copy\nOr just say what you want, e.g. snipe anything @x posts under 50k mcap with 0.5 SOL`);
      case "/copy": {
        const cfg = normalizeCopyConfig(a.store.data.copy);
        if (args[0] === "feed") return this.send(chat, a.copy.feed.slice(-10).map((i) => `${i.label} ${i.side} ${i.symbol ? "$" + i.symbol : shortAddr(i.mint)}: ${feedLine(i)}`).join("\n") || "No trades seen yet.");
        if (args[0] === "on" || args[0] === "off") {
          const ref = (args[1] ?? "").replace(/^@/, "").toLowerCase();
          if (ref === "all") a.store.data.copy = { ...cfg, enabled: args[0] === "on" };
          else {
            const w = cfg.wallets.find((x) => x.address === args[1] || x.label.toLowerCase() === ref);
            if (!w) return this.send(chat, "No tracked wallet with that label. /copy lists them.");
            a.store.data.copy = bulkEdit(cfg, [w.address], { enabled: args[0] === "on" });
          }
          await a.store.save();
          a.copy.sync();
          return this.send(chat, `Copy ${args[1] ?? ""} ${args[0]}.`);
        }
        const st = copyStats(a.copy.feed, a.state.data.positions, a.state.data.closed);
        const lines = cfg.wallets.slice(0, 40).map((w) => `${w.enabled ? "on " : "off"}  ${w.label}  ${st[w.address]?.copiesToday ?? 0} today  ${(st[w.address]?.pnlSol ?? 0).toFixed(3)} SOL`);
        return this.send(chat, `${cfg.enabled ? "Copy trading on" : "Copy trading OFF"} · ${cfg.wallets.length} wallets\n${lines.join("\n") || "None yet. Say: copy <address> as name with 0.1 SOL, skip above 300k mcap"}\n/copy feed  /copy on|off <label|all>`);
      }
      case "/status":
        return this.send(chat, `${a.status.toUpperCase()} · spent ${a.state.spentToday().toFixed(3)}/${a.limits().dailySpendCapSol} SOL today · ${a.state.data.positions.length} open · kill switch ${a.limits().killSwitch ? "ON" : "off"}`);
      case "/positions": {
        const lines = await Promise.all(a.state.data.positions.map(async (p) => {
          const s = await snapshot(a.rpc, p.mint).catch(() => null);
          const pnl = positionPnl(p, s?.priceSol ?? p.avgEntryPriceSol);
          return `${p.symbol}  ${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct.toFixed(0)}%  (${p.costSol.toFixed(3)} SOL in)`;
        }));
        return this.send(chat, lines.join("\n") || "No open positions.");
      }
      case "/rules":
        return this.send(chat, a.rules().map((r) => `${r.enabled ? "on " : "off"}  ${r.name}  ·  ${r.buy.amountSol} SOL`).join("\n") || "No rules yet.");
      case "/pause":
        a.setPaused(true);
        return this.send(chat, "Paused. Exits keep running.");
      case "/resume":
        a.setPaused(false);
        return this.send(chat, "Resumed.");
      case "/kill":
        await a.setKillSwitch(args[0] !== "off");
        return this.send(chat, args[0] === "off" ? "Kill switch off." : "Kill switch ON. No new buys.");
      case "/buy": {
        const r = await a.executor.buy({ action: "buy", wallet: a.address, mint: args[0], amountSol: Number(args[1]), venue: "auto", slippageBps: 1500, reason: "telegram buy" });
        return this.send(chat, r.ok ? `Bought in ${r.latencyMs} ms` : `Not bought: ${r.error}`);
      }
      case "/sell": {
        const r = await a.executor.sell({ action: "sell", wallet: a.address, mint: args[0], sellPct: Number(args[1] ?? 100), reason: "telegram sell" });
        return this.send(chat, r.ok ? `Sold for ${(r.solDelta ?? 0).toFixed(4)} SOL` : `Not sold: ${r.error}`);
      }
      default: {
        // v26: a short "Name $TICKER" reply names the one draft that is waiting for a name
        const asking = a.state.data.pendingLaunches.filter((x) => x.ask && x.expiresAt > Date.now());
        const named = asking.length === 1 && m.text.length <= 48 && /\$[A-Za-z0-9]{2,10}\b/.test(m.text) ? parseNameReply(m.text) : null;
        if (named) return this.send(chat, await a.decidePending(asking[0].id, true, named));
        return this.replyChat(chat, await a.chat(m.text));
      }
    }
  }

  private async replyChat(chat: number, r: ParseResult) {
    if (r.kind === "refuse") return this.send(chat, r.reason);
    if (r.kind === "unknown") return this.send(chat, r.hint);
    if (r.kind === "rule") {
      const id = r.draft.id;
      this.drafts.set(id, r.draft);
      const body = [...describeRule(r.draft), ...r.assumptions.map((x) => `(${x})`), ...r.errors.map((e) => `! ${e.message}`)].join("\n");
      return this.send(chat, `Here's the rule:\n${body}`, r.errors.length ? undefined : [[{ text: "Confirm", callback_data: `ok:${id}` }, { text: "Discard", callback_data: `no:${id}` }]]);
    }
    if (r.kind === "launch-info") {
      if (r.ask === "stats") {
        const st = this.agent.launchRuleStats();
        return this.send(chat, st.length ? st.map((x) => `${this.agent.launchRules().find((y) => y.id === x.ruleId)?.name ?? x.ruleId}: ${x.launches} launches · first ${x.firstRate === null ? "–" : `${Math.round(x.firstRate * 100)}%`} · median ${x.medianMs === null ? "–" : fmtGap(x.medianMs)} · ${x.pnlSol >= 0 ? "+" : ""}${x.pnlSol.toFixed(3)} SOL`).join("\n") : "No launch-on-post rules yet.");
      }
      if (r.ask === "race") {
        const list = this.agent.raceReports().filter((x) => !r.symbol || x.symbol?.toUpperCase() === r.symbol);
        return this.send(chat, list.length ? list.slice(0, 8).map((x) => `$${x.symbol}: ${raceLabel(x.race!)}`).join("\n") : "No race reports yet.");
      }
      if (r.ask === "pairs") { const c = pairCounts(this.agent.pairs()); return this.send(chat, `${c.selectable} pump.fun pairs usable (${c.listed} from pump.fun's supported list of ${REPORTED_TOTAL}${c.discovered ? `, ${c.discovered} discovered live` : ""}). Every mint is checked on chain before a create. Run \`vesk pairs\` for the list.`); }
      const rule = this.agent.launchRules()[0];
      if (!rule) return this.send(chat, "No launch-on-post rules yet.");
      const res = await this.agent.backtestLaunchRule(rule.id).catch(() => null);
      return this.send(chat, res ? [`Backtest · ${rule.name}: ${res.launches} launches from ${res.posts} posts (nothing spent)`, ...res.rows.filter((x) => x.outcome === "launch").slice(-5).map((x) => `· @${x.handle}: ${x.name} $${x.symbol}`), ...res.notes.slice(0, 1)].join("\n") : "Backtest failed.");
    }
    if (r.kind === "launch-rule") {
      this.launchDrafts.set(r.draft.id, r.draft);
      const body = [...r.summary, ...r.errors.map((e) => `! ${e.message}`), "Images from posts may be owned by someone else. You're responsible for what you launch."].join("\n");
      return this.send(chat, `Here's the launch-on-post rule:\n${body}`, r.errors.length ? undefined : [[{ text: "Confirm", callback_data: `ok:${r.draft.id}` }, { text: "Discard", callback_data: `no:${r.draft.id}` }]]);
    }
    if (r.kind === "copy") {
      const res = r.errors.length ? null : resolveCopyDraft(normalizeCopyConfig(this.agent.store.data.copy), r.draft);
      if (!res || "error" in res) return this.send(chat, [...r.summary, ...r.errors.map((e) => `! ${e.message}`), ...(res && "error" in res ? [`! ${res.error}`] : [])].join("\n"));
      const id = Math.random().toString(36).slice(2, 8);
      this.copyDrafts.set(id, res.wallet);
      return this.send(chat, `${res.isNew ? "New copy wallet" : "Copy settings"}:\n${res.profile.join("\n")}\nCopies land after their transaction (same or next few slots).`, [[{ text: "Confirm", callback_data: `ok:${id}` }, { text: "Discard", callback_data: `no:${id}` }]]);
    }
    if (r.kind === "strategy" || r.kind === "rogue") {
      if (r.errors.length) return this.send(chat, [...r.summary, ...r.errors.map((e) => `! ${e}`)].join("\n"));
      const id = Math.random().toString(36).slice(2, 8);
      this.strategyDrafts.set(id, r);
      return this.send(chat, `${r.kind === "rogue" ? "Rogue mode" : "Strategy & safety"}:\n${r.summary.join("\n")}`, [[{ text: r.kind === "rogue" ? (r.start ? "Start" : "Turn off") : "Save", callback_data: `ok:${id}` }, { text: "Discard", callback_data: `no:${id}` }]]);
    }
    if (r.kind === "claim") {
      const groups = claimGroups(this.agent.creatorFeeRows(), r.symbol ? (x) => x.symbol.toUpperCase() === r.symbol : undefined);
      if (!groups.length) return this.send(chat, "Nothing to claim: no coins launched by this agent with fees to the creator.");
      const id = Math.random().toString(36).slice(2, 8);
      this.claimDrafts.set(id, r);
      return this.send(chat, [...r.summary, ...groups.map((g) => `${g.asset}: ${g.symbols.map((x) => "$" + x).join(", ")}`)].join("\n"), [[{ text: "Claim", callback_data: `ok:${id}` }, { text: "Discard", callback_data: `no:${id}` }]]);
    }
    if (r.kind === "burn") {
      const p = await this.agent.burnSupply({ mint: r.mint, symbol: r.symbol, tokens: r.tokens, pct: r.pct, confirm: false, planOnly: true });
      if (!p.ok || !p.plan) return this.send(chat, `Can't burn: ${p.error}`);
      const id = Math.random().toString(36).slice(2, 8);
      this.burnDrafts.set(id, r);
      return this.send(chat, `Burn ${fmtTokens(p.plan.tokens)} $${p.coin!.symbol} (${p.plan.pctOfHolding.toFixed(2)}% of what you hold; ${fmtTokens(p.plan.remaining)} left).\nBurned tokens are gone forever. Disclosed in the treasury report.`, [[{ text: "Burn", callback_data: `ok:${id}` }, { text: "Cancel", callback_data: `no:${id}` }]]);
    }
    if (r.kind === "lock") {
      const l = await this.agent.lockSupply({ mint: r.mint, symbol: r.symbol, tokens: r.tokens, pct: r.pct, days: r.days ?? 90 });
      return this.send(chat, `${r.summary[0]}\n${l.error}`);
    }
    if (r.kind === "launch") return this.send(chat, r.summary.join("\n") + "\nLaunches need your image and a final review: open the panel's Launch page, or run `vesk launch` on your machine.");
    return this.send(chat, r.summary.join("\n") + (r.kind === "trade" ? `\nSend /${r.action} ${r.mint} ${r.action === "buy" ? r.amountSol : r.sellPct} to do it.` : ""));
  }

  async poll() {
    for (;;) {
      try {
        const ups = await this.api<Update[]>("getUpdates", { offset: this.offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
        for (const u of ups) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((e: Error) => console.error("telegram:", e.message));
        }
      } catch (e) {
        console.error("telegram:", (e as Error).message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

export async function runBot(configPath?: string) {
  const { config } = await loadConfig(configPath);
  const pass = process.env.VESK_PASSPHRASE;
  if (!pass) throw new Error("Set VESK_PASSPHRASE to run the bot unattended.");
  const ks = await Keystore.open(config.wallet.keystore, pass);
  const token = secret(config.telegram.botTokenEnv, ks.secrets());
  if (!token) throw new Error(`Missing ${config.telegram.botTokenEnv}. Create a bot with @BotFather, then \`vesk keys set ${config.telegram.botTokenEnv}\`.`);
  if (!config.telegram.allowedChatIds.length) throw new Error("Add your chat id to telegram.allowedChatIds (message @userinfobot to find it).");
  const agent = await new Agent({ config, keystore: ks }).init();
  await agent.start();
  const bot = new Bot(token, config.telegram.allowedChatIds, agent);
  bot.notify();
  console.log(`Telegram bot running for ${config.telegram.allowedChatIds.length} chat(s).`);
  await bot.poll();
}
