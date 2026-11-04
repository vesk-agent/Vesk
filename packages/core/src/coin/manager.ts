/**
 * "Run your coin": after you launch, the agent can keep your community informed and your treasury
 * transparent, inside hard rules:
 *  - posts only to your own linked accounts, rate-limited, never promising returns (checkPost)
 *  - answers questions from a FAQ you write, labelled as automated, no price talk
 *  - claims creator fees; optional buybacks/burns are always disclosed in a public treasury report
 *  - no volume, no wash trades, no sockpuppets, no coordinated anything (checkTrade / checkPost)
 */
import type { CoinConfig } from "../config.js";
import { checkPost } from "../guardrails.js";
import { snapshot } from "../market.js";
import type { ModelClient } from "../models/providers.js";
import { fmtK } from "../rules/engine.js";
import type { Rpc } from "../rpc.js";
import type { State } from "../state.js";
import type { Executor } from "../trade/executor.js";
import type { Poster } from "./posters.js";
import { BRAND } from "../brand.js";

export const AUTOMATED_TAG = `Automated update by the project's ${BRAND.name} agent.`;

export class CoinManager {
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private posts: Array<{ at: number; account: string; text: string }> = [];
  private lastMcap = 0;
  /** Set once the dev position is fully sold: promotional updates stop for good. */
  private devExited = false;

  constructor(
    private cfg: CoinConfig,
    private d: { rpc: Rpc; state: State; executor: Executor; posters: Poster[]; model: ModelClient | null },
  ) {}

  start() {
    if (this.cfg.updates.enabled) this.timers.push(setInterval(() => void this.postUpdate(), this.cfg.updates.everyMin * 60_000));
    if (this.cfg.treasury.claimFees) this.timers.push(setInterval(() => void this.claimAndReport(), this.cfg.treasury.claimEveryMin * 60_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Post to every linked account, through the posting guardrails. */
  async publish(text: string): Promise<string[]> {
    const links: string[] = [];
    const body = `${text}\n\n${AUTOMATED_TAG}`;
    for (const p of this.d.posters) {
      const g = checkPost(p.account, body, { ownAccounts: this.d.posters.map((x) => x.account), recentPosts: this.posts });
      if (!g.ok) {
        this.d.state.log({ kind: "guardrail", message: `Post blocked: ${g.reason}` });
        continue;
      }
      try {
        const r = await p.post(body);
        this.posts.push({ at: Date.now(), account: p.account, text: body });
        this.posts = this.posts.filter((x) => Date.now() - x.at < 3_600_000);
        if (r.url) links.push(r.url);
        this.d.state.log({ kind: "post", message: `Posted to ${p.kind}:${p.account}` });
      } catch (e) {
        this.d.state.log({ kind: "error", message: (e as Error).message });
      }
    }
    return links;
  }

  get mint() {
    return this.cfg.mint;
  }

  /**
   * The dev wallet sold everything. Always recorded in the treasury; if posting is on, say so publicly
   * with the transaction link, then stop promotional updates for this coin.
   */
  async announceDevExit(signature: string, solOut: number): Promise<void> {
    if (this.devExited) return;
    this.devExited = true;
    await this.publish(`The dev wallet ${short(this.d.executor.address)} sold its full $${this.cfg.symbol} position (${solOut.toFixed(4)} SOL). Tx: https://solscan.io/tx/${signature}\nAutomated updates for $${this.cfg.symbol} stop here.`);
  }

  async postUpdate(): Promise<void> {
    if (this.devExited) return;
    const m = await snapshot(this.d.rpc, this.cfg.mint).catch(() => null);
    if (!m) return;
    const milestone = this.cfg.updates.onMilestones && crossed(this.lastMcap, m.mcapUsd);
    this.lastMcap = m.mcapUsd;
    const lines = [`$${this.cfg.symbol} status`, `Market cap: $${fmtK(m.mcapUsd)}`, m.onCurve ? "Still on the pump.fun curve." : "Trading on DEX pools."];
    if (milestone) lines.unshift(`Milestone: $${fmtK(milestone)} market cap.`);
    const t = this.treasuryTotals();
    if (t.claimed > 0) lines.push(`Treasury: ${t.claimed.toFixed(3)} SOL claimed in creator fees, ${t.bought.toFixed(3)} SOL used for disclosed buybacks.`);
    await this.publish(lines.join("\n"));
  }

  treasuryTotals() {
    const tr = this.d.state.data.treasury.filter((x) => x.mint === this.cfg.mint);
    return {
      claimed: tr.filter((x) => x.kind === "claim").reduce((s, x) => s + (x.sol ?? 0), 0),
      bought: tr.filter((x) => x.kind === "buyback").reduce((s, x) => s + (x.sol ?? 0), 0),
      burned: tr.filter((x) => x.kind === "burn").reduce((s, x) => s + (x.tokens ?? 0), 0),
    };
  }

  /** Claim creator fees, optionally run a disclosed buyback (+ burn), then post the treasury report. */
  async claimAndReport(): Promise<void> {
    const c = await this.d.executor.claimCreatorFees(this.cfg.mint);
    if (!c.ok || !c.solDelta || c.solDelta <= 0.001) return;
    const entry = { at: Date.now(), kind: "claim" as const, mint: this.cfg.mint, sol: c.solDelta, signature: c.signature };
    this.d.state.data.treasury.push(entry);
    this.d.state.log({ kind: "claim", message: `Claimed ${c.solDelta.toFixed(4)} SOL creator fees`, mint: this.cfg.mint, signature: c.signature, solDelta: c.solDelta });
    const lines = [`Treasury report for $${this.cfg.symbol}`, `Claimed ${c.solDelta.toFixed(4)} SOL in creator fees. Tx: https://solscan.io/tx/${c.signature}`];
    const team = this.d.state.data.treasury.find((x) => x.kind === "team" && x.mint === this.cfg.mint);
    for (const ds of this.d.state.data.treasury.filter((x) => x.kind === "dev-sell" && x.mint === this.cfg.mint && !x.disclosedAt)) {
      lines.push(`Dev wallet sold ${ds.tokens ? `${fmtK(ds.tokens)} tokens ` : ""}for ${(ds.sol ?? 0).toFixed(4)} SOL. Tx: https://solscan.io/tx/${ds.signature}`);
      ds.disclosedAt = new Date().toISOString();
    }
    if (team?.wallets?.length) lines.push(`Team wallets (disclosed at launch, ${team.sol ?? 0} SOL total): ${team.wallets.join(", ")}`);
    const bbSol = +(c.solDelta * (this.cfg.treasury.buybackPct / 100)).toFixed(4);
    if (bbSol >= 0.01) {
      const r = await this.d.executor.buy({ action: "buyback", wallet: this.d.executor.address, mint: this.cfg.mint, amountSol: bbSol, disclosed: true, reason: "disclosed buyback", slippageBps: 1500 }, this.cfg.symbol);
      if (r.ok) {
        this.d.state.data.treasury.push({ at: Date.now(), kind: "buyback", mint: this.cfg.mint, sol: bbSol, tokens: r.tokens, signature: r.signature });
        lines.push(`Bought back ${bbSol} SOL of $${this.cfg.symbol} from the disclosed project wallet ${short(this.d.executor.address)}. Tx: https://solscan.io/tx/${r.signature}`);
        if (this.cfg.treasury.burnBuybacks && r.tokens) {
          const sig = await this.burn(r.tokens).catch((e: Error) => (this.d.state.log({ kind: "error", message: `Burn failed: ${e.message}` }), null));
          if (sig) {
            this.d.state.data.treasury.push({ at: Date.now(), kind: "burn", mint: this.cfg.mint, tokens: r.tokens, signature: sig });
            lines.push(`Burned ${fmtK(r.tokens)} tokens. Tx: https://solscan.io/tx/${sig}`);
          }
        }
      }
    }
    await this.d.state.save();
    await this.publish(lines.join("\n"));
  }

  /** Burn bought-back tokens (disclosed). The executor builds, guards and signs the BurnChecked instruction. */
  async burn(tokens: number): Promise<string> {
    const r = await this.d.executor.burn(this.cfg.mint, tokens, true);
    if (!r.ok || !r.signature) throw new Error(r.error ?? "burn failed");
    return r.signature;
  }

  /** Answer a community question from the owner's FAQ. Labelled, no price talk, never financial advice. */
  async answer(question: string): Promise<string> {
    if (/\b(price|pump|moon|100x|10x|when\s+(binance|cex)|wen|buy now|should i buy|prediction)\b/i.test(question))
      return "I can't talk about price or tell anyone what to buy. Here's what I can help with: what the project is, how it works, and where the treasury reports are.";
    if (!this.d.model) return "I'm the project's automated helper. The team will answer this one soon.";
    const text = await this.d.model.chat([
      { role: "system", content: `You are the automated helper for the $${this.cfg.symbol} community. Answer ONLY from this FAQ. If the FAQ doesn't cover it, say the team will answer. Never discuss price, never predict, never give financial advice, never claim to be a person. Keep it under 80 words.\n\nFAQ:\n${this.cfg.community.faq}` },
      { role: "user", content: question },
    ], { maxTokens: 200 });
    return `${text.trim()}\n\n(automated reply)`;
  }
}

function crossed(prev: number, now: number): number | null {
  for (const m of [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000, 10_000_000]) if (prev < m && now >= m) return m;
  return null;
}
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
