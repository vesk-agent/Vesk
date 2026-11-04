/**
 * The executor: the only code path that signs and sends transactions.
 * Every call goes through `checkTrade` (guardrails + limits) first.
 *
 * Venues:
 *  - pump.fun bonding curve and PumpSwap: PumpPortal local transactions (pool "auto")
 *  - everything else: Jupiter
 * Optional Jito bundle with a tip when `jitoTipSol` is set.
 */
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { b58encode } from "../base58.js";
import { checkTrade, type GuardContext, type GuardResult } from "../guardrails.js";
import type { BlacklistIndex } from "../watch/blacklist.js";
import { snapshot } from "../market.js";
import type { Rpc } from "../rpc.js";
import type { State } from "../state.js";
import type { Limits, TradeIntent, TradeResult, Venue } from "../types.js";
import { launchOnPump, type LaunchInput } from "../launch/pumpfun.js";
import { sendWithTip } from "./jito.js";
import { jupQuote, jupSwapTx, WSOL } from "./jupiter.js";
import { pumpPortalTx } from "./pumpportal.js";
import { launchpad, type QuoteAsset } from "../launch/launchpads.js";
import { rewardAsset } from "../launch/capabilities.js";
import { claimRequest, claimVerified } from "../launch/claim.js";
import { CLOSE_ACCOUNT_DATA, TOKEN_2022, TOKEN_PROGRAM, type EmptyAccount, type RentPlan } from "../wallet/rent.js";
import { burnCheckedData, burnCheckedKeys, tokenProgramOf, toRaw } from "../coin/supply.js";
import { QueueFull, type LaneKind, type WorkQueue } from "../work/queue.js";
import type { Reservations } from "../work/reserve.js";

/** Which lane a buy runs in (v20). */
export const laneOf = (i: Pick<TradeIntent, "rogue" | "origin" | "trace">): LaneKind => (i.rogue ? "rogue" : i.origin === "copy" || i.trace?.action === "copied" ? "copy" : "trade");

export interface ExecutorDeps {
  rpc: Rpc;
  wallet: Keypair;
  state: State;
  limits: () => Limits;
  defaultPriorityFeeSol: number;
  jito?: { enabled: boolean; blockEngineUrl: string; tipSol: number };
  /** All wallets in the keystore (main + imported), for token-send guardrails. */
  allWallets?: () => string[];
  /** Dry run: everything except signing and sending. `vesk summon --paper`. */
  paper?: boolean;
  /** Your blacklist, checked on every buy. */
  blacklist?: () => BlacklistIndex;
  /** v19: the running Rogue session's limits (strategy/rogue.ts rogueGuard), for the guardrails on Rogue buys. */
  rogue?: () => GuardContext["rogue"];
  /** v19.1: automatic sources switched off; their buys are refused. */
  sourcesOff?: () => GuardContext["sourcesOff"];
  /**
   * v19: checks after the guardrails and before anything is built or signed (the can-sell check, strategy/canSell.ts).
   * `onCurve`: the coin is on a pump.fun bonding curve right now.
   */
  preBuy?: (i: TradeIntent & { mint: string }, ctx: { onCurve?: boolean }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** v20: parallel lanes (shared by every executor of this agent) and the in-flight budget they reserve. */
  work?: WorkQueue;
  reserve?: Reservations;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export class Executor {
  constructor(private d: ExecutorDeps) {}

  get address() {
    return this.d.wallet.publicKey.toBase58();
  }

  async guard(i: TradeIntent, inFlight?: () => GuardContext["inFlight"]): Promise<GuardResult> {
    const s = this.d.state;
    let walletBalanceSol: number | undefined;
    if (i.action === "buy" || i.action === "buyback") walletBalanceSol = await this.d.rpc.getBalanceSol(this.address).catch(() => undefined);
    return checkTrade(i, {
      limits: this.d.limits(),
      // All of the owner's wallets, so the multi-wallet check sees a buy from any of them.
      ownWallets: [this.address, ...(this.d.allWallets?.() ?? []).filter((a) => a !== this.address)],
      spentTodaySol: s.spentToday(),
      buysToday: s.buysToday(),
      openPositions: s.data.positions.length,
      holdsMint: i.mint ? s.holding(i.mint) : false,
      walletBalanceSol,
      recentFills: s.data.fills,
      allOwnWallets: this.d.allWallets?.() ?? [this.address],
      launchedMints: [...s.data.positions, ...s.data.closed].filter((p) => p.launched).map((p) => p.mint),
      lastBuybackAt: [...s.data.treasury].reverse().find((t) => t.kind === "buyback" && t.mint === i.mint)?.at,
      blacklist: this.d.blacklist?.(),
      rogue: this.d.rogue?.(),
      sourcesOff: this.d.sourcesOff?.(),
      // read after the balance call: what earlier lanes still have in flight right now
      inFlight: inFlight?.(),
    });
  }

  /** Sign and send a serialized VersionedTransaction (optionally through Jito). */
  private async signAndSend(raw: Uint8Array, tipSol?: number, jitoOnly = false): Promise<{ signature: string; ms: number }> {
    const tx = VersionedTransaction.deserialize(raw);
    tx.sign([this.d.wallet]);
    const signed = b64(tx.serialize());
    const t0 = Date.now();
    let signature: string;
    if (jitoOnly) {
      // MEV protection: a Jito bundle only. No RPC send, no fallback to the public mempool.
      if (!this.d.jito?.blockEngineUrl) throw new Error("MEV protection needs a Jito block engine (rpc.jito.blockEngineUrl).");
      await sendWithTip({ engine: this.d.jito.blockEngineUrl, rpc: this.d.rpc, payer: this.d.wallet, signedTxBase64: signed, tipSol: Math.max(tipSol ?? 0, 0.0001) });
      signature = b58encode(tx.signatures[0]);
    } else if (tipSol && this.d.jito?.enabled) {
      await sendWithTip({ engine: this.d.jito.blockEngineUrl, rpc: this.d.rpc, payer: this.d.wallet, signedTxBase64: signed, tipSol });
      signature = b58encode(tx.signatures[0]);
    } else {
      signature = await this.d.rpc.sendRawTransaction(signed);
    }
    const c = await this.d.rpc.confirm(signature);
    if (!c.ok) throw new Error(`Transaction ${signature.slice(0, 8)}… failed: ${JSON.stringify(c.err)}`);
    return { signature, ms: Date.now() - t0 };
  }

  /**
   * A buy. v20: it runs in a lane (work/queue.ts) and reserves its spend before it awaits anything, so buys in other
   * lanes count it (work/reserve.ts) and the guardrails stay exact under concurrency.
   */
  async buy(i: TradeIntent & { action: "buy" | "buyback"; mint: string; amountSol: number }, symbol = "?"): Promise<TradeResult> {
    const w = this.d.work;
    if (!w || i.action !== "buy") return this.buyNow(i, symbol);
    const lane = laneOf(i);
    if (w.wouldWait(lane) && i.trace) this.d.state.stage({ id: i.trace.id, stage: "check", outcome: "start", mint: i.mint, symbol: i.trace.symbol, lane, reason: "waiting for a free lane" });
    try { return await w.run(lane, () => this.buyNow(i, symbol)); }
    catch (e) {
      if (!(e instanceof QueueFull)) throw e;
      this.d.state.log({ kind: "guardrail", message: `Not bought: ${e.message}`, mint: i.mint, ruleId: i.ruleId });
      if (i.trace) this.d.state.stage({ id: i.trace.id, stage: "check", outcome: "fail", mint: i.mint, symbol: i.trace.symbol, lane, reason: e.message, action: "skipped", result: "not traded" });
      return { ok: false, error: e.message };
    }
  }

  private async buyNow(i: TradeIntent & { action: "buy" | "buyback"; mint: string; amountSol: number }, symbol = "?"): Promise<TradeResult> {
    const tr = i.trace;
    const sym = tr?.symbol ?? (symbol !== "?" ? symbol : undefined);
    const lane = laneOf(i);
    // reserve first, synchronously: the other lanes' reservations are what this buy is checked against
    const rv = this.d.reserve;
    const rid = rv?.reserve({ mint: i.mint, sol: i.amountSol, newPosition: !this.d.state.holding(i.mint) });
    try {
      return await this.buyChecked(i, symbol, tr, sym, lane, rv ? () => rv.others(rid) : undefined);
    } finally {
      rv?.release(rid);
    }
  }

  private async buyChecked(i: TradeIntent & { action: "buy" | "buyback"; mint: string; amountSol: number }, symbol: string, tr: TradeIntent["trace"], sym: string | undefined, lane: LaneKind, others?: () => GuardContext["inFlight"]): Promise<TradeResult> {
    const g = await this.guard(i, others);
    if (!g.ok) {
      this.d.state.log({ kind: "guardrail", message: g.reason, mint: i.mint, ruleId: i.ruleId });
      if (tr) this.d.state.stage({ id: tr.id, stage: "check", outcome: "fail", mint: i.mint, symbol: sym, lane, reason: g.reason, action: "filtered", result: "not traded" });
      return { ok: false, error: g.reason };
    }
    let t0 = Date.now();
    const m = await snapshot(this.d.rpc, i.mint).catch(() => null);
    if (this.d.preBuy) {
      // the check's own time isn't landing time: the clock skips it
      const c0 = Date.now();
      const pb = await this.d.preBuy(i, { onCurve: m?.onCurve });
      t0 += Date.now() - c0;
      if (!pb.ok) {
        this.d.state.log({ kind: "guardrail", message: pb.reason, mint: i.mint, ruleId: i.ruleId });
        if (tr) this.d.state.stage({ id: tr.id, stage: "check", outcome: "fail", mint: i.mint, symbol: sym, lane, reason: pb.reason, action: "filtered", result: "not traded" });
        return { ok: false, error: pb.reason };
      }
    }
    if (tr) {
      this.d.state.stage({ id: tr.id, stage: "check", outcome: "pass", mint: i.mint, symbol: sym, lane, reason: "inside your limits" });
      this.d.state.stage({ id: tr.id, stage: "execute", outcome: "start", mint: i.mint, symbol: sym, lane, amountSol: i.amountSol, paper: this.d.paper || undefined });
    }
    const landed = (r: TradeResult) => {
      if (!tr) return r;
      if (r.ok) this.d.state.stage({ id: tr.id, stage: "execute", outcome: "done", mint: i.mint, symbol: sym, lane, ms: r.latencyMs, amountSol: i.amountSol, signature: r.signature, paper: this.d.paper || undefined, reason: i.reason, action: tr.action ?? "enter", result: `${i.amountSol} SOL` });
      else this.d.state.stage({ id: tr.id, stage: "execute", outcome: "fail", mint: i.mint, symbol: sym, lane, reason: r.error, action: tr.action ?? "enter", result: "failed" });
      return r;
    };
    const venue = this.pickVenue(i.venue ?? "auto", i.mint, m?.onCurve);
    const prio = i.priorityFeeSol ?? this.d.defaultPriorityFeeSol;
    const slip = i.slippageBps ?? 1500;
    if (this.d.paper) {
      const tokens = m && m.priceSol > 0 ? i.amountSol / m.priceSol : 0;
      this.d.state.recordBuy({ mint: i.mint, symbol, wallet: this.address, sol: i.amountSol, tokens, ruleId: i.ruleId });
      this.d.state.log({ kind: "buy", message: `[paper] bought ${i.amountSol} SOL of ${symbol} via ${venue}`, mint: i.mint, ruleId: i.ruleId, solDelta: -i.amountSol, latencyMs: Date.now() - t0 });
      return landed({ ok: true, venue, tokens, solDelta: -i.amountSol, latencyMs: Date.now() - t0 });
    }
    try {
      const before = await this.tokenBalance(i.mint);
      let raw: Uint8Array;
      if (venue === "pumpfun") {
        raw = await pumpPortalTx({ publicKey: this.address, action: "buy", mint: i.mint, amount: i.amountSol, denominatedInSol: "true", slippage: slip / 100, priorityFee: prio, pool: "auto" });
      } else {
        const quote = await jupQuote({ inputMint: WSOL, outputMint: i.mint, amount: BigInt(Math.round(i.amountSol * 1e9)), slippageBps: slip });
        raw = Uint8Array.from(Buffer.from(await jupSwapTx({ quote, userPublicKey: this.address, priorityFeeSol: prio }), "base64"));
      }
      const sent = await this.signAndSend(raw, i.jitoTipSol, i.jitoOnly);
      const tokens = Math.max(0, (await this.tokenBalance(i.mint)) - before);
      this.d.state.recordBuy({ mint: i.mint, symbol, wallet: this.address, sol: i.amountSol, tokens, ruleId: i.ruleId });
      const latencyMs = Date.now() - t0;
      this.d.state.log({ kind: i.action === "buyback" ? "buyback" : "buy", message: `Bought ${i.amountSol} SOL of ${symbol} via ${venue} in ${latencyMs} ms`, mint: i.mint, ruleId: i.ruleId, signature: sent.signature, solDelta: -i.amountSol, latencyMs });
      return landed({ ok: true, signature: sent.signature, venue, tokens, solDelta: -i.amountSol, latencyMs });
    } catch (e) {
      const msg = (e as Error).message;
      this.d.state.log({ kind: "error", message: `Buy failed: ${msg}`, mint: i.mint, ruleId: i.ruleId });
      return landed({ ok: false, error: msg });
    }
  }

  async sell(i: TradeIntent & { action: "sell"; mint: string; sellPct: number }, tpStep?: number): Promise<TradeResult> {
    const g = await this.guard(i);
    if (!g.ok) {
      this.d.state.log({ kind: "guardrail", message: g.reason, mint: i.mint });
      return { ok: false, error: g.reason };
    }
    const pct = Math.max(1, Math.min(100, i.sellPct));
    const t0 = Date.now();
    const pos = this.d.state.data.positions.find((p) => p.mint === i.mint);
    if (this.d.paper) {
      const m = await snapshot(this.d.rpc, i.mint).catch(() => null);
      const tokens = (pos?.tokens ?? 0) * (pct / 100);
      const solOut = tokens * (m?.priceSol ?? 0);
      this.d.state.recordSell({ mint: i.mint, wallet: this.address, tokensSold: tokens, solOut, tpStep });
      this.d.state.log({ kind: "sell", message: `[paper] sold ${pct}% of ${pos?.symbol ?? "?"} for ${solOut.toFixed(4)} SOL (${i.reason})`, mint: i.mint, solDelta: solOut });
      return { ok: true, tokens, solDelta: solOut, latencyMs: Date.now() - t0 };
    }
    try {
      const balBefore = await this.tokenBalance(i.mint);
      const solBefore = await this.d.rpc.getBalanceSol(this.address);
      let raw: Uint8Array;
      let venue: Venue = "pumpfun";
      try {
        raw = await pumpPortalTx({ publicKey: this.address, action: "sell", mint: i.mint, amount: `${pct}%`, denominatedInSol: "false", slippage: (i.slippageBps ?? 1500) / 100, priorityFee: i.priorityFeeSol ?? this.d.defaultPriorityFeeSol, pool: "auto" });
      } catch {
        venue = "jupiter";
        const dec = (await this.d.rpc.getTokenBalances(this.address)).find((b) => b.mint === i.mint)?.decimals ?? 6;
        const amount = BigInt(Math.floor(balBefore * (pct / 100) * 10 ** dec));
        const quote = await jupQuote({ inputMint: i.mint, outputMint: WSOL, amount, slippageBps: i.slippageBps ?? 1500 });
        raw = Uint8Array.from(Buffer.from(await jupSwapTx({ quote, userPublicKey: this.address, priorityFeeSol: i.priorityFeeSol }), "base64"));
      }
      const sent = await this.signAndSend(raw, i.jitoTipSol, i.jitoOnly);
      const balAfter = await this.tokenBalance(i.mint);
      // Sold everything on chain: close the position in full (the recorded size can differ from the chain by rounding).
      const tokensSold = balAfter <= 0 ? Math.max(balBefore, pos?.tokens ?? 0) : Math.max(0, balBefore - balAfter);
      const solOut = Math.max(0, (await this.d.rpc.getBalanceSol(this.address)) - solBefore);
      this.d.state.recordSell({ mint: i.mint, wallet: this.address, tokensSold, solOut, tpStep, signature: sent.signature });
      this.d.state.log({ kind: "sell", message: `Sold ${pct}% of ${pos?.symbol ?? "position"} for ${solOut.toFixed(4)} SOL via ${venue} (${i.reason})`, mint: i.mint, signature: sent.signature, solDelta: solOut, latencyMs: Date.now() - t0 });
      return { ok: true, signature: sent.signature, venue, tokens: tokensSold, solDelta: solOut, latencyMs: Date.now() - t0 };
    } catch (e) {
      const msg = (e as Error).message;
      this.d.state.log({ kind: "error", message: `Sell failed: ${msg}`, mint: i.mint });
      return { ok: false, error: msg };
    }
  }

  /**
   * Creator fees via PumpPortal collectCreatorFee (collects all of this wallet's pump.fun creator fees for the pair's
   * reward asset). v22.1: a custom pair adds the quote field from the capability config (not yet verified on a live
   * claim). v26: fees are paid in the quote asset and stay in it; Vesk doesn't swap them.
   */
  async claimCreatorFees(mint: string, o: { quote?: QuoteAsset } = {}): Promise<TradeResult & { asset?: string; amount?: number }> {
    const i: TradeIntent = { action: "claim-fees", wallet: this.address, mint, reason: "claim creator fees" };
    const g = await this.guard(i);
    if (!g.ok) return { ok: false, error: g.reason };
    if (this.d.paper) return { ok: true, solDelta: 0 };
    const quote = o.quote ?? "SOL";
    const caps = launchpad("pumpfun").caps;
    const asset = rewardAsset(caps, quote);
    const before = await this.d.rpc.getBalanceSol(this.address);
    const tokBefore = asset.mint ? await this.tokenBalance(asset.mint) : 0;
    const raw = await pumpPortalTx(claimRequest(this.address, quote, caps));
    const sent = await this.signAndSend(raw);
    const solDelta = (await this.d.rpc.getBalanceSol(this.address)) - before;
    if (quote === "SOL") return { ok: true, signature: sent.signature, solDelta, asset: "SOL", amount: Math.max(0, solDelta) };
    const amount = asset.mint ? Math.max(0, (await this.tokenBalance(asset.mint)) - tokBefore) : 0;
    this.d.state.log({ kind: "claim", message: `Claimed ${amount.toFixed(2)} ${asset.label} creator fees${claimVerified(quote, caps) ? "" : " (custom-pair claim not yet verified live)"}`, mint, signature: sent.signature });
    return { ok: true, signature: sent.signature, solDelta, asset: asset.label, amount };
  }


  /**
   * SPL BurnChecked from this wallet's token account (Token or Token-2022, read from the mint's owner). Must be
   * disclosed. v25: the instruction comes from coin/supply.ts (`burnCheckedData` / `burnCheckedKeys`); `raw` (base
   * units) is used as given when the caller already planned it, so a 100% burn leaves no dust.
   */
  async burn(mint: string, tokens: number, disclosed: boolean, raw?: bigint): Promise<TradeResult> {
    const g = await this.guard({ action: "burn", wallet: this.address, mint, tokens, disclosed, reason: "disclosed burn" });
    if (!g.ok) return { ok: false, error: g.reason };
    if (this.d.paper) return { ok: true, tokens, signature: "paper" };
    const info = await this.d.rpc.getAccountInfo(mint, "jsonParsed");
    if (!info) return { ok: false, error: "mint not found" };
    let programId: string;
    try { programId = tokenProgramOf(info.owner); } catch (e) { return { ok: false, error: (e as Error).message }; }
    const program = new PublicKey(programId);
    const decimals = (info.data as { parsed?: { info?: { decimals?: number } } }).parsed?.info?.decimals ?? 6;
    const owner = this.d.wallet.publicKey;
    const mintKey = new PublicKey(mint);
    const [ata] = PublicKey.findProgramAddressSync([owner.toBytes(), program.toBytes(), mintKey.toBytes()], new PublicKey(ATA_PROGRAM));
    const amount = raw ?? toRaw(tokens, decimals);
    const ix = new TransactionInstruction({
      programId: program,
      keys: burnCheckedKeys(ata.toBase58(), mint, owner.toBase58()).map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
      data: Buffer.from(burnCheckedData(amount, decimals)),
    });
    const { blockhash, lastValidBlockHeight } = await this.d.rpc.getLatestBlockhash();
    const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(ix);
    tx.sign(this.d.wallet);
    let signature: string;
    try {
      signature = await this.d.rpc.sendRawTransaction(b64(tx.serialize()));
      const c = await this.d.rpc.confirm(signature);
      if (!c.ok) return { ok: false, error: `burn failed: ${JSON.stringify(c.err)}` };
    } catch (e) { return { ok: false, error: `burn failed: ${(e as Error).message}` }; }
    this.d.state.log({ kind: "burn", message: `Burned ${tokens} tokens (disclosed)`, mint, signature });
    return { ok: true, signature, tokens };
  }

  /** v25: what this wallet holds of a mint (UI amount and decimals; 0 when it has no account). */
  async holding(mint: string): Promise<{ tokens: number; decimals: number }> {
    const b = (await this.d.rpc.getTokenBalances(this.address)).find((x) => x.mint === mint);
    if (b) return { tokens: b.amount, decimals: b.decimals };
    const info = await this.d.rpc.getAccountInfo(mint, "jsonParsed").catch(() => null);
    return { tokens: 0, decimals: (info?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals ?? 6 };
  }

  /** Launch a coin on pump.fun from this wallet (create + optional dev buy, one transaction). */
  async launch(input: LaunchInput): Promise<{ mint: string; signature: string }> {
    if (this.d.limits().killSwitch && input.devBuySol > 0) throw new Error("Kill switch is on. Launch without a dev buy, or turn it off.");
    const r = await launchOnPump({ rpc: this.d.rpc, creator: this.d.wallet, input });
    this.d.state.log({ kind: "launch", message: `Launched ${input.name} ($${input.symbol}) on pump.fun`, mint: r.mint, signature: r.signature, solDelta: -input.devBuySol });
    return r;
  }

  /** Send SOL out of this wallet (withdraw). */
  async withdraw(to: string, amountSol: number): Promise<TradeResult> {
    const g = await this.guard({ action: "withdraw", wallet: this.address, to, amountSol, reason: "withdraw" });
    if (!g.ok) return { ok: false, error: g.reason };
    const { blockhash, lastValidBlockHeight } = await this.d.rpc.getLatestBlockhash();
    const tx = new Transaction({ feePayer: this.d.wallet.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: this.d.wallet.publicKey, toPubkey: new PublicKey(to), lamports: Math.round(amountSol * 1e9) }),
    );
    tx.sign(this.d.wallet);
    const signature = await this.d.rpc.sendRawTransaction(b64(tx.serialize()));
    const c = await this.d.rpc.confirm(signature);
    if (!c.ok) return { ok: false, error: `withdraw failed: ${JSON.stringify(c.err)}` };
    this.d.state.log({ kind: "withdraw", message: `Withdrew ${amountSol} SOL to ${to.slice(0, 4)}…${to.slice(-4)}`, signature, solDelta: -amountSol });
    return { ok: true, signature, solDelta: -amountSol };
  }

  /** Send SPL tokens to an address (creates the recipient's token account if needed). Guarded like a withdraw. */
  async sendTokens(mint: string, to: string, tokens: number): Promise<TradeResult> {
    const g = await this.guard({ action: "send-tokens", wallet: this.address, mint, to, tokens, reason: "send tokens" });
    if (!g.ok) return { ok: false, error: g.reason };
    if (this.d.paper) return { ok: true, tokens };
    const info = await this.d.rpc.getAccountInfo(mint, "jsonParsed");
    if (!info) return { ok: false, error: "mint not found" };
    const program = new PublicKey(info.owner);
    const decimals = (info.data as { parsed?: { info?: { decimals?: number } } }).parsed?.info?.decimals ?? 6;
    const owner = this.d.wallet.publicKey;
    const mintKey = new PublicKey(mint);
    const dest = new PublicKey(to);
    const ataOf = (o: PublicKey) => PublicKey.findProgramAddressSync([o.toBytes(), program.toBytes(), mintKey.toBytes()], new PublicKey(ATA_PROGRAM))[0];
    const from = ataOf(owner), toAta = ataOf(dest);
    // Associated Token Account program: CreateIdempotent (1).
    const createIx = new TransactionInstruction({
      programId: new PublicKey(ATA_PROGRAM),
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: toAta, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: false },
        { pubkey: mintKey, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: program, isSigner: false, isWritable: false },
      ],
      data: Uint8Array.of(1),
    });
    const data = new Uint8Array(10);
    data[0] = 12; // TransferChecked
    new DataView(data.buffer).setBigUint64(1, BigInt(Math.floor(tokens * 10 ** decimals)), true);
    data[9] = decimals;
    const transferIx = new TransactionInstruction({
      programId: program,
      keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: mintKey, isSigner: false, isWritable: false }, { pubkey: toAta, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
      data,
    });
    const signature = await this.sendLegacy([createIx, transferIx]);
    this.d.state.log({ kind: "withdraw", message: `Sent ${tokens} tokens to ${to.slice(0, 4)}…${to.slice(-4)}`, mint, signature });
    return { ok: true, signature, tokens };
  }

  /** Empty token accounts of this wallet (balance 0), with their rent deposit. */
  async emptyTokenAccounts(): Promise<EmptyAccount[]> {
    const out: EmptyAccount[] = [];
    for (const program of [TOKEN_PROGRAM, TOKEN_2022]) {
      const r = await this.d.rpc.call<{ value: Array<{ pubkey: string; account: { lamports: number; data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }> }>(
        "getTokenAccountsByOwner", [this.address, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const a of r.value) if (a.account.data.parsed.info.tokenAmount.amount === "0") out.push({ account: a.pubkey, mint: a.account.data.parsed.info.mint, program, lamports: a.account.lamports });
    }
    return out;
  }

  /** Close empty token accounts and return their rent to this wallet. One transaction per batch. */
  async recoverRent(plan: RentPlan): Promise<Array<{ signature: string; closed: number; sol: number }>> {
    const g = await this.guard({ action: "close-accounts", wallet: this.address, reason: "recover rent" });
    if (!g.ok) throw new Error(g.reason);
    if (this.d.paper) return plan.batches.map((b) => ({ signature: "paper", closed: b.length, sol: b.reduce((s, a) => s + a.lamports, 0) / 1e9 }));
    const owner = this.d.wallet.publicKey;
    const out: Array<{ signature: string; closed: number; sol: number }> = [];
    for (const b of plan.batches) {
      const ixs = b.map((a) => new TransactionInstruction({
        programId: new PublicKey(a.program),
        keys: [{ pubkey: new PublicKey(a.account), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
        data: CLOSE_ACCOUNT_DATA,
      }));
      const signature = await this.sendLegacy(ixs);
      const sol = b.reduce((s, a) => s + a.lamports, 0) / 1e9;
      out.push({ signature, closed: b.length, sol });
      this.d.state.log({ kind: "withdraw", message: `Closed ${b.length} empty token account${b.length === 1 ? "" : "s"}, recovered ${sol.toFixed(5)} SOL rent`, signature, solDelta: sol });
    }
    return out;
  }

  private async sendLegacy(ixs: TransactionInstruction[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.d.rpc.getLatestBlockhash();
    const tx = new Transaction({ feePayer: this.d.wallet.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(this.d.wallet);
    const signature = await this.d.rpc.sendRawTransaction(b64(tx.serialize()));
    const c = await this.d.rpc.confirm(signature);
    if (!c.ok) throw new Error(`Transaction failed: ${JSON.stringify(c.err)}`);
    return signature;
  }

  private async tokenBalance(mint: string): Promise<number> {
    const all = await this.d.rpc.getTokenBalances(this.address).catch(() => []);
    return all.find((b) => b.mint === mint)?.amount ?? 0;
  }

  /**
   * pump.fun coins (on the curve, or graduated to PumpSwap) go through PumpPortal's "auto" pool.
   * Everything else goes through Jupiter.
   */
  private pickVenue(pref: TradeIntent["venue"], mint: string, onCurve: boolean | undefined): Venue {
    if (pref === "jupiter" || pref === "pumpfun") return pref;
    return onCurve || mint.endsWith("pump") ? "pumpfun" : "jupiter";
  }
}
