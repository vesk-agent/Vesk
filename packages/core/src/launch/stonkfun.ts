/**
 * StonkFun (stonks.fun) launchpad adapter: SCAFFOLD, not enabled.
 *
 * Nothing about StonkFun's on-chain program or its create interface could be confirmed where this was built (no
 * network, no docs or SDK on disk), and Vesk never guesses program IDs or endpoints. So:
 *
 *   TODO(program-id)       StonkFun's program ID, from its own docs, SDK or verified explorer label.
 *   TODO(create)           How a create transaction is built: a local-transaction API (like PumpPortal's: POST a
 *                          request, get an unsigned transaction back) or an instruction layout from a published IDL.
 *   TODO(metadata)         Where the image and metadata go, and which fields it takes.
 *   TODO(dev-buy, bundle)  Whether the create can include the creator's buy, and whether team buys can share a Jito
 *                          bundle (Vesk only does team buys when they're disclosed and land with the create).
 *   TODO(fees)             The create fee and any creator-fee setting.
 *
 * Until those are confirmed, `stonkFunAdapter` has status "soon" and `launch()` throws LaunchpadNotReady. The flow
 * below is the generic local-transaction flow (metadata → unsigned transaction → check it only calls the expected
 * program → sign locally → send → confirm). `makeStonkFunAdapter(config)` takes the confirmed values; it's tested
 * against local mocks only (test/v19_strategy.test.ts), to check Vesk's side: validation, the program check, signing, errors.
 * It has never run against StonkFun.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { b58encode } from "../base58.js";
import { finalDescription, type LaunchPlan } from "./plan.js";
import { LaunchpadNotReady, registerAdapter, type AdapterLaunchArgs, type LaunchpadAdapter } from "./adapter.js";
import type { LaunchPlanResult } from "./pumpfun.js";

export interface StonkFunConfig {
  /** TODO(program-id): no default on purpose. The built transaction must call this program. */
  programId: string;
  /** TODO(metadata): takes multipart (file, name, symbol, description, socials), returns { metadataUri }. */
  metadataUrl: string;
  /** TODO(create): takes a StonkFunCreateRequest (JSON), returns { transaction: base64 unsigned VersionedTransaction }. */
  createUrl: string;
}

/** What Vesk would send to build a create. The real field names are TODO(create) until the interface is known. */
export interface StonkFunCreateRequest {
  creator: string;
  mint: string;
  name: string;
  symbol: string;
  metadataUri: string;
  devBuySol: number;
  slippagePct: number;
  priorityFeeSol: number;
}

export const STONKFUN_NEEDS = [
  "its program ID (from StonkFun's docs, SDK or a verified explorer label)",
  "a confirmed way to build the create transaction (API or IDL)",
  "the metadata upload endpoint and fields",
  "an end-to-end test against devnet or a tiny mainnet launch",
];

export function stonkFunCreateRequest(plan: LaunchPlan, ctx: { creator: string; mint: string; metadataUri: string }): StonkFunCreateRequest {
  return {
    creator: ctx.creator, mint: ctx.mint, name: plan.token.name.trim(), symbol: plan.token.symbol.toUpperCase(), metadataUri: ctx.metadataUri,
    devBuySol: plan.mode === "standard" ? plan.devBuySol : 0, slippagePct: plan.slippagePct, priorityFeeSol: plan.priorityFeeSol,
  };
}

export function validateStonkFunPlan(plan: LaunchPlan): string[] {
  const e: string[] = [];
  if (plan.launchpad !== "stonkfun") e.push("Not a StonkFun plan.");
  // TODO(dev-buy, bundle): until confirmed, no disclosed team bundle on StonkFun
  if (plan.team?.wallets.length) e.push("Team wallets aren't supported on StonkFun yet.");
  if (plan.token.quote !== "SOL") e.push("StonkFun launches use SOL as the quote here.");
  if (!plan.token.name.trim() || !plan.token.symbol.trim()) e.push("Name and ticker are required.");
  return e;
}

/** The scaffold with confirmed values injected. Without them (the default) it's "soon" and never runs. */
export function makeStonkFunAdapter(cfg?: StonkFunConfig, opts: { fetch?: typeof fetch } = {}): LaunchpadAdapter {
  const f = opts.fetch ?? fetch;
  const ready = !!(cfg?.programId && cfg.metadataUrl && cfg.createUrl);
  return {
    id: "stonkfun", name: "StonkFun", status: ready ? "ready" : "soon", needs: ready ? [] : STONKFUN_NEEDS,
    can: { devBuy: true, teamBundle: false },
    validate: validateStonkFunPlan,
    coinUrl: (mint) => `https://stonks.fun/coin/${mint}`, // TODO(create): confirm the coin page path
    async launch(a: AdapterLaunchArgs): Promise<LaunchPlanResult> {
      if (!ready || !cfg) throw new LaunchpadNotReady("stonkfun", STONKFUN_NEEDS);
      const errs = validateStonkFunPlan(a.plan);
      if (errs.length) throw new Error(errs.join(" "));
      const say = (step: "metadata" | "build" | "landed" | "done", detail: string) => a.onProgress?.({ step, detail });
      const t = a.plan.token;
      const description = finalDescription(a.plan);
      say("metadata", "Uploading image and metadata");
      const form = new FormData();
      form.append("file", new Blob([a.image.bytes.slice().buffer as ArrayBuffer], { type: a.image.mime }), a.image.filename);
      for (const [k, v] of [["name", t.name.trim()], ["symbol", t.symbol.toUpperCase()], ["description", description], ["twitter", t.twitter], ["telegram", t.telegram], ["website", t.website]] as const) if (v) form.append(k, v);
      const mr = await f(cfg.metadataUrl, { method: "POST", body: form });
      if (!mr.ok) throw new Error(`StonkFun metadata upload failed (${mr.status})`);
      const metadataUri = ((await mr.json()) as { metadataUri?: string }).metadataUri;
      if (!metadataUri) throw new Error("StonkFun returned no metadata URI");
      const mint = Keypair.generate();
      say("build", "Building the create transaction");
      const cr = await f(cfg.createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stonkFunCreateRequest(a.plan, { creator: a.creator.publicKey.toBase58(), mint: mint.publicKey.toBase58(), metadataUri })) });
      if (!cr.ok) throw new Error(`StonkFun create build failed (${cr.status})`);
      const b64 = ((await cr.json()) as { transaction?: string }).transaction;
      if (!b64) throw new Error("StonkFun returned no transaction");
      const tx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(b64, "base64")));
      // never sign a transaction that doesn't call the program we expect
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
      if (!programs.includes(cfg.programId)) throw new Error("The create transaction doesn't call the StonkFun program. Nothing was signed.");
      tx.sign([mint, a.creator]);
      const signature = await a.rpc.sendRawTransaction(Buffer.from(tx.serialize()).toString("base64"));
      const c = await a.rpc.confirm(signature, 60_000);
      if (!c.ok) throw new Error(`StonkFun launch failed: ${JSON.stringify(c.err)}`);
      say("landed", "Create confirmed");
      say("done", `stonks.fun · ${mint.publicKey.toBase58()}`);
      return { mint: mint.publicKey.toBase58(), signature: signature || b58encode(tx.signatures[0]), teamSignatures: [], metadataUri, description };
    },
  };
}

/** The adapter Vesk ships: "soon", with what's needed. */
export const stonkFunAdapter = makeStonkFunAdapter();
registerAdapter(stonkFunAdapter);
