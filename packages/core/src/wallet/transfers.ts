/**
 * Sends the transfers planned by planFunding / planReturn. Plain System Program transfers, signed locally,
 * sent through your RPC. Nothing is routed through exchanges or intermediate wallets: A pays B, on-chain.
 */
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Rpc } from "../rpc.js";
import type { Transfer } from "./multi.js";

export async function sendTransfers(rpc: Rpc, signerOf: (address: string) => Keypair, transfers: Transfer[], perTx = 8): Promise<Array<{ from: string; signature: string; count: number; ok: boolean }>> {
  const byFrom = new Map<string, Transfer[]>();
  for (const t of transfers) if (t.sol > 0) byFrom.set(t.from, [...(byFrom.get(t.from) ?? []), t]);
  const out: Array<{ from: string; signature: string; count: number; ok: boolean }> = [];
  for (const [from, list] of byFrom) {
    const kp = signerOf(from);
    for (let i = 0; i < list.length; i += perTx) {
      const chunk = list.slice(i, i + perTx);
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
      const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight });
      for (const t of chunk) tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(t.to), lamports: Math.round(t.sol * 1e9) }));
      tx.sign(kp);
      const signature = await rpc.sendRawTransaction(Buffer.from(tx.serialize()).toString("base64"));
      const c = await rpc.confirm(signature);
      out.push({ from, signature, count: chunk.length, ok: c.ok });
    }
  }
  return out;
}
