/**
 * Launch a coin on pump.fun: upload image + metadata to pump.fun's IPFS endpoint, then build the
 * create (+ dev buy) transaction with PumpPortal, sign it locally with your wallet and a fresh mint key.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { b58decode, b58encode } from "../base58.js";
import type { Rpc } from "../rpc.js";
import { bundleStatus, sendBundle } from "../trade/jito.js";
import { pumpPortalTx, pumpPortalUrl, type PumpPortalRequest } from "../trade/pumpportal.js";
import { bundleRequests, effectiveTip, finalDescription, launchRoute, validatePlan, type LaunchPlan } from "./plan.js";
import { endpoints } from "../endpoints.js";

export interface LaunchInput {
  name: string;
  symbol: string;
  description: string;
  image: { bytes: Uint8Array; mime: string; filename: string };
  twitter?: string;
  telegram?: string;
  website?: string;
  /** SOL spent on the creator's first buy in the same transaction (0 allowed). */
  devBuySol: number;
  slippagePct?: number;
  priorityFeeSol?: number;
}

export function validateLaunch(i: Partial<LaunchInput>): string[] {
  const e: string[] = [];
  if (!i.name || i.name.trim().length < 2 || i.name.length > 32) e.push("Name must be 2-32 characters.");
  if (!i.symbol || !/^[A-Za-z0-9$]{2,10}$/.test(i.symbol)) e.push("Ticker must be 2-10 letters or digits.");
  if ((i.description ?? "").length > 500) e.push("Description must be under 500 characters.");
  if (!i.image || i.image.bytes.length === 0) e.push("Add an image.");
  else if (i.image.bytes.length > 4_500_000) e.push("Image must be under 4.5 MB.");
  else if (!/^image\/(png|jpeg|gif|webp)$/.test(i.image.mime)) e.push("Image must be PNG, JPG, GIF or WebP.");
  for (const [k, v] of [["X link", i.twitter], ["Telegram link", i.telegram], ["Website", i.website]] as const)
    if (v && !/^https:\/\/\S+$/.test(v)) e.push(`${k} must start with https://`);
  if (i.devBuySol === undefined || i.devBuySol < 0 || i.devBuySol > 50) e.push("Dev buy must be 0-50 SOL.");
  return e;
}

export async function uploadPumpMetadata(i: LaunchInput): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([i.image.bytes.slice().buffer as ArrayBuffer], { type: i.image.mime }), i.image.filename);
  form.append("name", i.name);
  form.append("symbol", i.symbol);
  form.append("description", i.description);
  if (i.twitter) form.append("twitter", i.twitter);
  if (i.telegram) form.append("telegram", i.telegram);
  if (i.website) form.append("website", i.website);
  form.append("showName", "true");
  const r = await fetch(endpoints.pumpIpfs(), { method: "POST", body: form });
  if (!r.ok) throw new Error(`pump.fun metadata upload failed (${r.status})`);
  const j = (await r.json()) as { metadataUri?: string };
  if (!j.metadataUri) throw new Error("pump.fun returned no metadata URI");
  return j.metadataUri;
}

export async function launchOnPump(p: { rpc: Rpc; creator: Keypair; input: LaunchInput }): Promise<{ mint: string; signature: string }> {
  const errors = validateLaunch(p.input);
  if (errors.length) throw new Error(errors.join(" "));
  const uri = await uploadPumpMetadata(p.input);
  const mint = Keypair.generate();
  const raw = await pumpPortalTx({
    publicKey: p.creator.publicKey.toBase58(), action: "create",
    tokenMetadata: { name: p.input.name, symbol: p.input.symbol, uri },
    mint: mint.publicKey.toBase58(), denominatedInSol: "true", amount: p.input.devBuySol,
    slippage: p.input.slippagePct ?? 10, priorityFee: p.input.priorityFeeSol ?? 0.0005, pool: "pump",
  });
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([mint, p.creator]);
  const signature = await p.rpc.sendRawTransaction(Buffer.from(tx.serialize()).toString("base64"));
  const c = await p.rpc.confirm(signature, 60_000);
  if (!c.ok) throw new Error(`Launch transaction failed: ${JSON.stringify(c.err)}`);
  return { mint: mint.publicKey.toBase58(), signature };
}

export type LaunchStep = "metadata" | "build" | "bundle" | "landed" | "done";
export interface LaunchProgress {
  step: LaunchStep;
  detail: string;
}

export interface LaunchPlanResult {
  mint: string;
  /** Create transaction signature. */
  signature: string;
  /** Signatures of the team-wallet buys, in order. */
  teamSignatures: string[];
  bundleId?: string;
  slot?: number;
  metadataUri: string;
  description: string;
}

/** PumpPortal bundle endpoint: POST an array of requests, get back an array of base58 unsigned transactions. */
export async function pumpPortalBundle(reqs: PumpPortalRequest[]): Promise<Uint8Array[]> {
  const r = await fetch(pumpPortalUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqs) });
  if (r.status !== 200) throw new Error(`PumpPortal bundle failed (${r.status}) ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const list = (await r.json()) as string[];
  if (!Array.isArray(list) || list.length !== reqs.length) throw new Error("PumpPortal returned an unexpected bundle.");
  return list.map((t) => {
    const b = b58decode(t);
    if (!b) throw new Error("PumpPortal returned an invalid transaction.");
    return b;
  });
}

/**
 * Launch from a plan.
 *  - create + dev buy is one transaction, sent through your RPC (no tip needed; v22);
 *  - with disclosed team buys (or a tip you set): [create + dev buy, ...team buys] as one Jito bundle, one block;
 *  - manual: create only, sent through your RPC.
 * `signerOf` returns keypairs from your keystore (main or imported). Keys never leave this process.
 */
export async function launchPlanOnPump(p: {
  rpc: Rpc;
  plan: LaunchPlan;
  creator: Keypair;
  signerOf: (address: string) => Keypair;
  image: LaunchInput["image"];
  jitoEngine: string;
  onProgress?: (e: LaunchProgress) => void;
}): Promise<LaunchPlanResult> {
  const errors = validatePlan(p.plan);
  if (errors.length) throw new Error(errors.map((e) => e.message).join(" "));
  const say = (step: LaunchStep, detail: string) => p.onProgress?.({ step, detail });
  const t = p.plan.token;
  const description = finalDescription(p.plan);

  say("metadata", "Uploading image and metadata");
  const uri = await uploadPumpMetadata({ name: t.name.trim(), symbol: t.symbol.toUpperCase(), description, image: p.image, twitter: t.twitter, telegram: t.telegram, website: t.website, devBuySol: 0 });
  const mint = Keypair.generate();
  const reqs = bundleRequests(p.plan, { creator: p.creator.publicKey.toBase58(), mint: mint.publicKey.toBase58(), metadataUri: uri });

  if (launchRoute(p.plan) === "rpc") {
    say("build", p.plan.mode === "manual" ? "Building the create transaction" : "Building the create + dev buy transaction");
    const tx = VersionedTransaction.deserialize(await pumpPortalTx(reqs[0]));
    tx.sign([mint, p.creator]);
    const signature = await p.rpc.sendRawTransaction(Buffer.from(tx.serialize()).toString("base64"));
    const c = await p.rpc.confirm(signature, 60_000);
    if (!c.ok) throw new Error(`Launch transaction failed: ${JSON.stringify(c.err)}`);
    say("bundle", "Sent through your RPC");
    say("landed", "Create confirmed");
    say("done", `https://pump.fun/coin/${mint.publicKey.toBase58()}`);
    return { mint: mint.publicKey.toBase58(), signature, teamSignatures: [], metadataUri: uri, description };
  }

  say("build", `Building ${reqs.length} transaction${reqs.length === 1 ? "" : "s"}`);
  const raws = await pumpPortalBundle(reqs);
  const signed = raws.map((raw, i) => {
    const tx = VersionedTransaction.deserialize(raw);
    tx.sign(i === 0 ? [mint, p.creator] : [p.signerOf(reqs[i].publicKey)]);
    return tx;
  });
  const sigs = signed.map((tx) => b58encode(tx.signatures[0]));
  say("bundle", `Sending the bundle to Jito · tip ${effectiveTip(p.plan)} SOL`);
  const bundleId = await sendBundle(p.jitoEngine, signed.map((tx) => b58encode(tx.serialize())));
  const c = await p.rpc.confirm(sigs[0], 60_000);
  if (!c.ok) throw new Error(`Bundle did not land (${JSON.stringify(c.err ?? "timeout")}). Nothing was spent if the create didn't land.`);
  const st = await bundleStatus(p.jitoEngine, bundleId).catch(() => null);
  say("landed", st ? `Landed in slot ${st.slot}` : "Landed");
  say("done", `https://pump.fun/coin/${mint.publicKey.toBase58()}`);
  return { mint: mint.publicKey.toBase58(), signature: sigs[0], teamSignatures: sigs.slice(1), bundleId, slot: st?.slot, metadataUri: uri, description };
}
