/**
 * A small stand-in for the parts of @solana/web3.js 1.98 that Vesk uses, for the end-to-end test only.
 * It is used ONLY when the real package can't be resolved (an offline machine without `pnpm install`);
 * the e2e runner prints which one it used. It implements real ed25519 keys (node:crypto), base58,
 * PDA derivation with the on-curve check, and the legacy / v0 transaction wire format, so the mock RPC
 * can verify every signature the agent produces.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";

// ---------- base58 ----------
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58enc(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
export function b58dec(s) {
  let n = 0n;
  for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error("Invalid base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

// ---------- ed25519 helpers ----------
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const privOf = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: "der", type: "pkcs8" });
const pubOfSeed = (seed) => Uint8Array.from(Buffer.from(createPublicKey(privOf(seed)).export({ format: "jwk" }).x, "base64url"));
export const signBytes = (seed, msg) => Uint8Array.from(edSign(null, Buffer.from(msg), privOf(seed)));

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);
export function isOnCurve(bytes) {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  const v3 = (v * v * v) % P, v7 = (v3 * v3 * v) % P;
  let x = (u * v3 % P) * pow(u * v7, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) { x = (x * SQRT_M1) % P; return true; }
  return false;
}

// ---------- PublicKey / Keypair ----------
export class PublicKey {
  constructor(v) {
    if (v instanceof PublicKey) this._b = v._b;
    else if (typeof v === "string") this._b = b58dec(v);
    else this._b = Uint8Array.from(v);
    if (this._b.length !== 32) throw new Error("Invalid public key input");
  }
  toBase58() { return b58enc(this._b); }
  toString() { return this.toBase58(); }
  toJSON() { return this.toBase58(); }
  toBytes() { return Uint8Array.from(this._b); }
  toBuffer() { return Buffer.from(this._b); }
  equals(o) { return Buffer.compare(Buffer.from(this._b), Buffer.from(o._b)) === 0; }
  static isOnCurve(b) { return isOnCurve(b instanceof PublicKey ? b._b : b); }
  static createProgramAddressSync(seeds, program) {
    const h = createHash("sha256");
    for (const s of seeds) { if (s.length > 32) throw new Error("Max seed length exceeded"); h.update(Buffer.from(s)); }
    h.update(Buffer.from(program.toBytes())).update("ProgramDerivedAddress");
    const out = Uint8Array.from(h.digest());
    if (isOnCurve(out)) throw new Error("Invalid seeds, address must fall off the curve");
    return new PublicKey(out);
  }
  static findProgramAddressSync(seeds, program) {
    for (let bump = 255; bump >= 0; bump--) {
      try { return [PublicKey.createProgramAddressSync([...seeds, Uint8Array.of(bump)], program), bump]; } catch { /* next bump */ }
    }
    throw new Error("Unable to find a viable program address nonce");
  }
}
PublicKey.default = new PublicKey(new Uint8Array(32));

export class Keypair {
  constructor(secretKey) { this.secretKey = secretKey; this.publicKey = new PublicKey(secretKey.slice(32)); }
  static generate() {
    const { privateKey } = generateKeyPairSync("ed25519");
    const seed = Uint8Array.from(Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url"));
    return Keypair.fromSeed(seed);
  }
  static fromSeed(seed) {
    const sk = new Uint8Array(64);
    sk.set(seed.slice(0, 32)); sk.set(pubOfSeed(seed.slice(0, 32)), 32);
    return new Keypair(sk);
  }
  static fromSecretKey(sk) {
    const b = Uint8Array.from(sk);
    if (b.length !== 64) throw new Error("bad secret key size");
    const pub = pubOfSeed(b.slice(0, 32));
    if (Buffer.compare(Buffer.from(pub), Buffer.from(b.slice(32))) !== 0) throw new Error("provided secretKey is invalid");
    return new Keypair(b);
  }
}

// ---------- wire format ----------
export function shortvec(n) { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); if (!n) return out; } }
function readShortvec(buf, o) { let n = 0, s = 0; for (;;) { const b = buf[o.i++]; n |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) return n; } }

/** Parse a message (legacy or v0) far enough to know its signers and instructions. */
export function parseMessage(msg) {
  const o = { i: 0 };
  let version = "legacy";
  if (msg[0] & 0x80) { version = msg[0] & 0x7f; o.i = 1; }
  const header = { numRequiredSignatures: msg[o.i++], numReadonlySignedAccounts: msg[o.i++], numReadonlyUnsignedAccounts: msg[o.i++] };
  const nKeys = readShortvec(msg, o);
  const keys = [];
  for (let k = 0; k < nKeys; k++) { keys.push(new PublicKey(msg.slice(o.i, o.i + 32))); o.i += 32; }
  const blockhash = b58enc(msg.slice(o.i, o.i + 32)); o.i += 32;
  const nIx = readShortvec(msg, o);
  const instructions = [];
  for (let k = 0; k < nIx; k++) {
    const programIdIndex = msg[o.i++];
    const na = readShortvec(msg, o); const accounts = [...msg.slice(o.i, o.i + na)]; o.i += na;
    const nd = readShortvec(msg, o); const data = msg.slice(o.i, o.i + nd); o.i += nd;
    instructions.push({ programIdIndex, accounts, data });
  }
  return { version, header, staticAccountKeys: keys, recentBlockhash: blockhash, compiledInstructions: instructions };
}

export class VersionedTransaction {
  constructor(messageBytes, signatures) {
    this._msg = Uint8Array.from(messageBytes);
    this.message = parseMessage(this._msg);
    this.signatures = signatures ?? Array.from({ length: this.message.header.numRequiredSignatures }, () => new Uint8Array(64));
  }
  static deserialize(bytes) {
    const b = Uint8Array.from(bytes);
    const o = { i: 0 };
    const n = readShortvec(b, o);
    const sigs = [];
    for (let k = 0; k < n; k++) { sigs.push(b.slice(o.i, o.i + 64)); o.i += 64; }
    return new VersionedTransaction(b.slice(o.i), sigs);
  }
  sign(signers) {
    const req = this.message.staticAccountKeys.slice(0, this.message.header.numRequiredSignatures);
    for (const s of signers) {
      const i = req.findIndex((k) => k.equals(s.publicKey));
      if (i < 0) throw new Error(`Cannot sign with non signer key ${s.publicKey.toBase58()}`);
      this.signatures[i] = signBytes(s.secretKey.slice(0, 32), this._msg);
    }
  }
  serialize() {
    return Uint8Array.from([...shortvec(this.signatures.length), ...this.signatures.flatMap((s) => [...s]), ...this._msg]);
  }
}

export class TransactionInstruction {
  constructor(o) { this.programId = o.programId; this.keys = o.keys; this.data = Uint8Array.from(o.data ?? []); }
}

export class Transaction {
  constructor(o = {}) { this.feePayer = o.feePayer; this.recentBlockhash = o.blockhash; this.lastValidBlockHeight = o.lastValidBlockHeight; this.instructions = []; this.signatures = []; }
  add(...ixs) { this.instructions.push(...ixs); return this; }
  compileMessage() {
    const metas = new Map();
    const put = (pk, s, w) => { const k = pk.toBase58(); const m = metas.get(k) ?? { pk, s: false, w: false }; m.s ||= s; m.w ||= w; metas.set(k, m); };
    put(this.feePayer, true, true);
    for (const ix of this.instructions) { for (const k of ix.keys) put(k.pubkey, k.isSigner, k.isWritable); put(ix.programId, false, false); }
    const payer = this.feePayer.toBase58();
    const rank = (m) => (m.pk.toBase58() === payer ? -1 : m.s && m.w ? 0 : m.s ? 1 : m.w ? 2 : 3);
    const list = [...metas.values()].sort((a, b) => rank(a) - rank(b));
    const header = [list.filter((m) => m.s).length, list.filter((m) => m.s && !m.w).length, list.filter((m) => !m.s && !m.w).length];
    const idx = (pk) => list.findIndex((m) => m.pk.equals(pk));
    const bytes = [...header, ...shortvec(list.length), ...list.flatMap((m) => [...m.pk.toBytes()]), ...b58dec(this.recentBlockhash)];
    bytes.push(...shortvec(this.instructions.length));
    for (const ix of this.instructions) {
      bytes.push(idx(ix.programId), ...shortvec(ix.keys.length), ...ix.keys.map((k) => idx(k.pubkey)), ...shortvec(ix.data.length), ...ix.data);
    }
    this._signers = list.filter((m) => m.s).map((m) => m.pk);
    return Uint8Array.from(bytes);
  }
  sign(...signers) {
    const msg = this.compileMessage();
    this._msgBytes = msg;
    this.signatures = this._signers.map((pk) => {
      const s = signers.find((k) => k.publicKey.equals(pk));
      return { publicKey: pk, signature: s ? signBytes(s.secretKey.slice(0, 32), msg) : null };
    });
  }
  get signature() { return this.signatures[0]?.signature ?? null; }
  serialize() {
    if (!this._msgBytes || this.signatures.some((s) => !s.signature)) throw new Error("Signature verification failed");
    return Uint8Array.from([...shortvec(this.signatures.length), ...this.signatures.flatMap((s) => [...s.signature]), ...this._msgBytes]);
  }
}

export const SystemProgram = {
  programId: new PublicKey(new Uint8Array(32)),
  transfer({ fromPubkey, toPubkey, lamports }) {
    const data = new Uint8Array(12);
    const v = new DataView(data.buffer);
    v.setUint32(0, 2, true);
    v.setBigUint64(4, BigInt(lamports), true);
    return new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: fromPubkey, isSigner: true, isWritable: true }, { pubkey: toPubkey, isSigner: false, isWritable: true }], data });
  },
};
