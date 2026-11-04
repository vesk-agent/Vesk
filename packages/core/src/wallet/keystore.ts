/**
 * Encrypted local keystore. Your wallet key and API keys live in one file on your machine,
 * encrypted with AES-256-GCM under a key derived from your passphrase with scrypt.
 * Nothing in here is ever sent anywhere: not to the panel, not to a model, not to Vesk.
 *
 * File format (JSON):
 *   { version: 1, publicKey, kdf: { name: "scrypt", N, r, p, salt }, cipher: "aes-256-gcm", iv, tag, ciphertext, createdAt }
 * Plaintext (inside ciphertext): { secretKey: <base58, 64 bytes>, secrets: { NAME: value }, wallets?: [{ address, label, secretKey, active, addedAt }] }
 *
 * `wallets` holds extra wallets you imported (`vesk wallets import`). They're encrypted in the same file,
 * under the same passphrase, and never printed or logged.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import { b58decode, b58encode } from "../base58.js";
import type { WalletImportEntry } from "./multi.js";

export interface KeystoreFile {
  version: 1;
  publicKey: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
}

interface StoredWallet {
  address: string;
  label: string;
  secretKey: string;
  active: boolean;
  addedAt: string;
}

interface Plain {
  secretKey: string;
  secrets: Record<string, string>;
  wallets?: StoredWallet[];
}

/** Public view of a wallet in the keystore. Never includes key material. */
export interface WalletInfo {
  address: string;
  label: string;
  active: boolean;
  main: boolean;
  addedAt?: string;
}

export const KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

function deriveKey(pass: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((res, rej) =>
    scryptCb(pass.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? rej(err) : res(key))),
  );
}

export async function encryptKeystore(plain: Plain, publicKey: string, pass: string): Promise<KeystoreFile> {
  if (pass.length < 10) throw new Error("Use a passphrase of at least 10 characters.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(pass, salt, KDF.N, KDF.r, KDF.p);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`vesk-keystore-v1:${publicKey}`));
  const ct = Buffer.concat([c.update(JSON.stringify(plain), "utf8"), c.final()]);
  return {
    version: 1, publicKey,
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64") },
    cipher: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: ct.toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

export async function decryptKeystore(f: KeystoreFile, pass: string): Promise<Plain> {
  if (f.version !== 1 || f.cipher !== "aes-256-gcm" || f.kdf.name !== "scrypt") throw new Error("Unsupported keystore format.");
  const key = await deriveKey(pass, Buffer.from(f.kdf.salt, "base64"), f.kdf.N, f.kdf.r, f.kdf.p);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
  d.setAAD(Buffer.from(`vesk-keystore-v1:${f.publicKey}`));
  d.setAuthTag(Buffer.from(f.tag, "base64"));
  let text: string;
  try {
    text = Buffer.concat([d.update(Buffer.from(f.ciphertext, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new Error("Wrong passphrase (or the keystore file was changed).");
  }
  return JSON.parse(text) as Plain;
}

/** An unlocked keystore held in memory for the life of the process. */
export class Keystore {
  private constructor(private path: string, private file: KeystoreFile, private plain: Plain, private pass: string) {}

  static async create(path: string, pass: string, importSecretKey?: string): Promise<Keystore> {
    const kp = importSecretKey ? keypairFromSecret(importSecretKey) : Keypair.generate();
    const plain: Plain = { secretKey: b58encode(kp.secretKey), secrets: {} };
    const file = await encryptKeystore(plain, kp.publicKey.toBase58(), pass);
    const ks = new Keystore(path, file, plain, pass);
    await ks.save();
    return ks;
  }

  static async open(path: string, pass: string): Promise<Keystore> {
    const file = JSON.parse(await readFile(path, "utf8")) as KeystoreFile;
    const plain = await decryptKeystore(file, pass);
    const kp = keypairFromSecret(plain.secretKey);
    if (kp.publicKey.toBase58() !== file.publicKey) throw new Error("Keystore public key does not match its secret key.");
    return new Keystore(path, file, plain, pass);
  }

  static async publicKeyOf(path: string): Promise<string> {
    return (JSON.parse(await readFile(path, "utf8")) as KeystoreFile).publicKey;
  }

  get publicKey(): string {
    return this.file.publicKey;
  }

  keypair(): Keypair {
    return keypairFromSecret(this.plain.secretKey);
  }

  secrets(): Record<string, string> {
    return { ...this.plain.secrets };
  }

  async setSecret(name: string, value: string | null): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("Secret names look like ANTHROPIC_API_KEY.");
    if (value === null) delete this.plain.secrets[name];
    else this.plain.secrets[name] = value;
    await this.persist();
  }

  // ---------- extra wallets ----------

  /** Main wallet first, then imported wallets. Public data only. */
  wallets(): WalletInfo[] {
    return [
      { address: this.publicKey, label: "Main", active: true, main: true },
      ...(this.plain.wallets ?? []).map((w) => ({ address: w.address, label: w.label, active: w.active, main: false, addedAt: w.addedAt })),
    ];
  }

  /** Encrypts and stores many wallets at once. Secrets in `entries` are zeroed afterwards. */
  async importWallets(entries: WalletImportEntry[], activate = true): Promise<{ added: WalletInfo[]; skipped: Array<{ where: string; reason: string }> }> {
    const list = (this.plain.wallets ??= []);
    const added: WalletInfo[] = [];
    const skipped: Array<{ where: string; reason: string }> = [];
    for (const e of entries) {
      try {
        const kp = Keypair.fromSecretKey(e.secret);
        const address = kp.publicKey.toBase58();
        if (address === this.publicKey) skipped.push({ where: e.where, reason: "That's your main wallet." });
        else if (list.some((w) => w.address === address)) skipped.push({ where: e.where, reason: "Already imported." });
        else {
          const w: StoredWallet = { address, label: e.label ?? `Wallet ${list.length + 1}`, secretKey: b58encode(kp.secretKey), active: activate, addedAt: new Date().toISOString() };
          list.push(w);
          added.push({ address, label: w.label, active: w.active, main: false, addedAt: w.addedAt });
        }
      } catch {
        skipped.push({ where: e.where, reason: "Not a valid Solana keypair." });
      } finally {
        e.secret.fill(0);
      }
    }
    if (added.length) await this.persist();
    return { added, skipped };
  }

  async setWalletActive(address: string, active: boolean): Promise<void> {
    const w = (this.plain.wallets ?? []).find((x) => x.address === address);
    if (!w) throw new Error("No imported wallet with that address.");
    w.active = active;
    await this.persist();
  }

  async setWalletLabel(address: string, label: string): Promise<void> {
    const w = (this.plain.wallets ?? []).find((x) => x.address === address);
    if (!w) throw new Error("No imported wallet with that address.");
    w.label = label.trim().slice(0, 32) || w.label;
    await this.persist();
  }

  async removeWallet(address: string): Promise<void> {
    this.plain.wallets = (this.plain.wallets ?? []).filter((x) => x.address !== address);
    await this.persist();
  }

  /** Keypair for the main wallet or an imported one. Stays in memory only. */
  keypairOf(address: string): Keypair {
    if (address === this.publicKey) return this.keypair();
    const w = (this.plain.wallets ?? []).find((x) => x.address === address);
    if (!w) throw new Error("No wallet with that address in your keystore.");
    return keypairFromSecret(w.secretKey);
  }

  private async persist(): Promise<void> {
    this.file = await encryptKeystore(this.plain, this.file.publicKey, this.pass);
    await this.save();
  }

  /** Base58 secret key, for `vesk wallet export` after an explicit confirmation. */
  exportSecretKey(confirmPass: string): string {
    const a = Buffer.from(confirmPass), b = Buffer.from(this.pass);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Passphrase does not match.");
    return this.plain.secretKey;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

/** Accepts a base58 64-byte secret key or a JSON byte array (Solana CLI / Phantom export formats). */
export function keypairFromSecret(s: string): Keypair {
  const t = s.trim();
  let bytes: Uint8Array | null = null;
  if (t.startsWith("[")) bytes = Uint8Array.from(JSON.parse(t) as number[]);
  else bytes = b58decode(t);
  if (!bytes || bytes.length !== 64) throw new Error("Secret key must be 64 bytes (base58 or a JSON array).");
  return Keypair.fromSecretKey(bytes);
}
