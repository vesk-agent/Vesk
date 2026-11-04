/**
 * Optional Jito path: send the signed trade plus a small tip transaction as a bundle to a Jito block engine.
 * Tips go to one of Jito's published tip accounts (fetched live, with a fallback list).
 */
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Rpc } from "../rpc.js";

const FALLBACK_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

async function jitoRpc<T>(engine: string, path: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(`${engine.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (!r.ok || j.error) throw new Error(`Jito ${method} failed: ${j.error?.message ?? r.status}`);
  return j.result as T;
}

export async function tipAccounts(engine: string): Promise<string[]> {
  try {
    const a = await jitoRpc<string[]>(engine, "/api/v1/bundles", "getTipAccounts", []);
    return a.length ? a : FALLBACK_TIP_ACCOUNTS;
  } catch {
    return FALLBACK_TIP_ACCOUNTS;
  }
}

/** Sends [signedTradeTx, tipTx] as one bundle. Returns the bundle id. Signatures are tracked by the caller. */
export async function sendWithTip(p: { engine: string; rpc: Rpc; payer: Keypair; signedTxBase64: string; tipSol: number }): Promise<string> {
  const accts = await tipAccounts(p.engine);
  const to = new PublicKey(accts[Math.floor(Math.random() * accts.length)]);
  const { blockhash, lastValidBlockHeight } = await p.rpc.getLatestBlockhash();
  const tip = new Transaction({ feePayer: p.payer.publicKey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: p.payer.publicKey, toPubkey: to, lamports: Math.round(p.tipSol * 1e9) }),
  );
  tip.sign(p.payer);
  const tipB64 = Buffer.from(tip.serialize()).toString("base64");
  return jitoRpc<string>(p.engine, "/api/v1/bundles", "sendBundle", [[p.signedTxBase64, tipB64], { encoding: "base64" }]);
}

/** Sends already-signed transactions (base58) as one bundle. Max 5. Returns the bundle id. */
export async function sendBundle(engine: string, signedBase58: string[]): Promise<string> {
  if (signedBase58.length < 1 || signedBase58.length > 5) throw new Error("A Jito bundle holds 1-5 transactions.");
  return jitoRpc<string>(engine, "/api/v1/bundles", "sendBundle", [signedBase58]);
}

/** Landed status of a bundle, or null while unknown. */
export async function bundleStatus(engine: string, bundleId: string): Promise<{ slot: number; status: string } | null> {
  const r = await jitoRpc<{ value: Array<{ slot: number; confirmation_status: string } | null> }>(engine, "/api/v1/bundles", "getBundleStatuses", [[bundleId]]);
  const v = r?.value?.[0];
  return v ? { slot: v.slot, status: v.confirmation_status } : null;
}
