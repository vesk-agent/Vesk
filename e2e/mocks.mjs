/**
 * Local mock servers for the end-to-end run. Each one speaks the real wire format of the service it stands in for:
 *   rpc        Solana JSON-RPC (balances, token accounts, blockhash, sendTransaction with ed25519 signature checks)
 *   jito       block engine bundles API (sendBundle, getBundleStatuses, getTipAccounts)
 *   pumpportal trade-local (single request -> raw tx bytes; array -> base58 txs) and pump.fun IPFS upload
 *   x          X API v2: filtered stream rules + a chunked stream, recent search, single post
 *   model      Ollama /api/chat (name suggestions and chat-to-rule)
 *   price      Jupiter price v3 + DexScreener tokens
 *   panel      the panel function (pair, report, poll, relay-token, relay-subscribe) + a Phoenix/Realtime websocket
 * Nothing here talks to the internet.
 */
import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import { createServer } from "node:http";
import { b58dec, b58enc, Keypair, parseMessage, PublicKey, shortvec, VersionedTransaction } from "./web3-shim.mjs";
import { acceptWebSocket } from "./ws.mjs";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const SOL_USD = 150;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Mock curve price: SOL per whole token, constant (keeps the arithmetic easy to check). */
const PRICE_SOL = 0.00000003;

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const verifySig = (pub, msg, sig) => edVerify(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: "der", type: "spki" }), Buffer.from(sig));

function body(req) {
  return new Promise((res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
}
function json(res, code, v) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); }
function listen(handler, onUpgrade) {
  return new Promise((r) => {
    const s = createServer((req, res) => handler(req, res).catch((e) => { console.error("mock error", e); json(res, 500, { error: String(e) }); }));
    if (onUpgrade) s.on("upgrade", onUpgrade);
    s.listen(0, "127.0.0.1", () => r({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

export async function startMocks() {
  const log = [];
  const note = (svc, what, extra = {}) => log.push({ at: Date.now(), svc, what, ...extra });

  // ---------------- ledger ----------------
  const lamports = new Map();
  /** owner -> mint -> raw token units (6 decimals) */
  const tokens = new Map();
  const mints = new Set();
  const sigs = new Map(); // signature -> { slot, err }
  const sigWaiters = []; // websocket signatureSubscribe
  let wsConfirms = 0;
  const effects = new Map(); // sha256(message) -> effect
  const emptyAccounts = new Map(); // owner -> [{ pubkey, mint }]
  const creatorFees = new Map(); // v22.1: owner -> { sol (lamports), tokens: { mint: raw units } } waiting to be claimed
  let slot = 300_000_000;
  const bal = (a) => lamports.get(a) ?? 0;
  const addSol = (a, l) => lamports.set(a, Math.max(0, bal(a) + Math.round(l)));
  const tok = (o, m) => tokens.get(o)?.get(m) ?? 0;
  const addTok = (o, m, n) => { if (!tokens.has(o)) tokens.set(o, new Map()); tokens.get(o).set(m, Math.max(0, tok(o, m) + Math.round(n))); };
  const hashMsg = (m) => createHash("sha256").update(m).digest("hex");

  /** Build an unsigned legacy transaction whose first `signers` keys must sign, and remember what it does. */
  function makeTx(signers, effect) {
    const programs = [new Uint8Array(b58dec(PUMP_PROGRAM))];
    const keys = [...signers.map((s) => b58dec(s)), ...programs];
    const data = Buffer.from(JSON.stringify({ e: effect.kind, n: randomBytes(4).toString("hex") }));
    const msg = Uint8Array.from([
      signers.length, 0, 1, ...shortvec(keys.length), ...keys.flatMap((k) => [...k]), ...randomBytes(32),
      ...shortvec(1), keys.length - 1, ...shortvec(signers.length), ...signers.map((_, i) => i), ...shortvec(data.length), ...data,
    ]);
    effects.set(hashMsg(msg), effect);
    return Uint8Array.from([...shortvec(signers.length), ...new Uint8Array(64 * signers.length), ...msg]);
  }

  /** Verify every signature, then apply the transaction's effect. Returns the first signature (base58). */
  function landTx(raw) {
    const tx = VersionedTransaction.deserialize(raw);
    const m = tx.message;
    const msg = tx._msg;
    for (let i = 0; i < m.header.numRequiredSignatures; i++) {
      const sig = tx.signatures[i];
      if (!sig || sig.every((b) => b === 0)) throw new Error(`missing signature for ${m.staticAccountKeys[i].toBase58()}`);
      if (!verifySig(m.staticAccountKeys[i].toBytes(), msg, sig)) throw new Error(`bad signature for ${m.staticAccountKeys[i].toBase58()}`);
    }
    const signature = b58enc(tx.signatures[0]);
    const eff = effects.get(hashMsg(msg));
    if (eff) applyEffect(eff);
    else applyInstructions(m);
    sigs.set(signature, { slot: ++slot, err: null });
    for (const w of sigWaiters.filter((x) => x.sig === signature)) w.notify();
    note("rpc", "landed", { signature, effect: eff?.kind ?? "instructions", signers: m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58()) });
    return signature;
  }

  function applyEffect(e) {
    if (e.kind === "create") {
      mints.add(e.mint);
      addSol(e.payer, -(e.sol * 1e9 + 0.02 * 1e9));
      if (e.sol > 0) addTok(e.payer, e.mint, (e.sol / PRICE_SOL) * 1e6);
    } else if (e.kind === "buy") {
      addSol(e.payer, -e.sol * 1e9);
      addTok(e.payer, e.mint, (e.sol / PRICE_SOL) * 1e6);
    } else if (e.kind === "claim") {
      // v22.1: pump.fun pays a creator's fees per wallet; a quote-token claim pays that token
      const f = creatorFees.get(e.payer) ?? { sol: 0, tokens: {} };
      if (e.mint) { addTok(e.payer, e.mint, f.tokens[e.mint] ?? 0); f.tokens[e.mint] = 0; }
      else { addSol(e.payer, f.sol); f.sol = 0; }
      creatorFees.set(e.payer, f);
    } else if (e.kind === "swap") {
      const n = tok(e.payer, e.mint);
      addTok(e.payer, e.mint, -n);
      addSol(e.payer, (n / 1e6 / SOL_USD) * 1e9 * 0.997);
    } else if (e.kind === "sell") {
      const have = tok(e.payer, e.mint);
      const n = Math.floor(have * (e.pct / 100));
      addTok(e.payer, e.mint, -n);
      addSol(e.payer, (n / 1e6) * PRICE_SOL * 1e9 * 0.99);
    }
  }

  function applyInstructions(m) {
    const keys = m.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of m.compiledInstructions) {
      const prog = keys[ix.programIdIndex];
      const d = ix.data;
      if (prog === SYSTEM && d[0] === 2) {
        const l = Number(new DataView(d.buffer, d.byteOffset).getBigUint64(4, true));
        addSol(keys[ix.accounts[0]], -l); addSol(keys[ix.accounts[1]], l);
      } else if ((prog === TOKEN_PROGRAM || prog === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") && d[0] === 15) {
        // v25: SPL BurnChecked [15, amount u64 LE, decimals u8]; accounts: token account (w), mint (w), owner (signer)
        const amount = Number(new DataView(d.buffer, d.byteOffset).getBigUint64(1, true));
        const decimals = d[9];
        const acct = keys[ix.accounts[0]], mint = keys[ix.accounts[1]], owner = keys[ix.accounts[2]];
        const ata = PublicKey.findProgramAddressSync([b58dec(owner), b58dec(prog), b58dec(mint)], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0].toBase58();
        if (d.length !== 10) throw new Error("BurnChecked: bad data length");
        if (decimals !== 6) throw new Error(`BurnChecked: decimals ${decimals} don't match the mint (6)`);
        if (acct !== ata) throw new Error("BurnChecked: not the owner's associated token account");
        if (ix.accounts[2] >= m.header.numRequiredSignatures) throw new Error("BurnChecked: the owner didn't sign");
        if (amount > tok(owner, mint)) throw new Error("BurnChecked: insufficient funds");
        addTok(owner, mint, -amount);
        note("rpc", "burn", { mint, owner, amount, decimals, program: prog });
      } else if ((prog === TOKEN_PROGRAM) && d[0] === 9) {
        const acct = keys[ix.accounts[0]], dest = keys[ix.accounts[1]];
        for (const [owner, list] of emptyAccounts) {
          const i = list.findIndex((a) => a.pubkey === acct);
          if (i >= 0) { list.splice(i, 1); addSol(dest, 2_039_280); note("rpc", "closed-account", { account: acct, owner }); }
        }
      }
    }
  }

  // ---------------- RPC ----------------
  const curveData = () => {
    const b = Buffer.alloc(49);
    const vTok = 1_000_000_000n * 10n ** 6n, vSol = BigInt(Math.round(PRICE_SOL * 1e9 * 1e9)) ; // price = vSol/1e9 / (vTok/1e6)
    b.writeBigUInt64LE(vTok, 8); b.writeBigUInt64LE(vSol, 16); b.writeBigUInt64LE(800_000_000n * 10n ** 6n, 24); b.writeBigUInt64LE(5n * 10n ** 9n, 32); b.writeBigUInt64LE(10n ** 15n, 40); b[48] = 0;
    return b.toString("base64");
  };
  const txStore = new Map(); // signature -> jsonParsed transaction (copy trading: the RPC path)
  // v19 can-sell check: mints that aren't pump.fun curve coins (Token-2022 extensions, a freeze authority, a holder whose
  // sell fails in simulation). Their bonding-curve PDA has no account, so the agent sees "not on a curve".
  const special = new Map(); // mint -> { program, ext, freeze, decimals, kind, holder: { owner, amount }, simErr }
  const specialCurves = new Set();
  const specialAccts = new Map(); // token account -> { owner, amount }
  const SPL = TOKEN_PROGRAM, T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const logSubs = []; // { ws, wallet, id }
  let logSubId = 100;
  const rpcMethods = {
    getSlot: () => slot,
    getBalance: ([a]) => ({ context: { slot }, value: bal(a) }),
    getLatestBlockhash: () => ({ context: { slot }, value: { blockhash: b58enc(randomBytes(32)), lastValidBlockHeight: slot + 150 } }),
    getAccountInfo: ([a, o]) => {
      if (special.has(a) && o?.encoding === "jsonParsed") {
        const x = special.get(a);
        // v26: `kind: "account"` is a token account sitting at that address (not a mint); `decimals` overrides 6
        if (x.kind === "account") return { context: { slot }, value: { owner: SPL, lamports: 2_039_280, data: { program: "spl-token", parsed: { type: "account", info: { mint: a, owner: a, tokenAmount: { amount: "0", decimals: 6 } } } } } };
        return { context: { slot }, value: { owner: x.program === "t22" ? T22 : SPL, lamports: 1_461_600, data: { program: x.program === "t22" ? "spl-token-2022" : "spl-token", parsed: { type: "mint", info: { decimals: x.decimals ?? 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: x.freeze ?? null, ...(x.ext ? { extensions: x.ext } : {}) } } } } };
      }
      if (specialCurves.has(a)) return { context: { slot }, value: null };
      if (o?.encoding === "jsonParsed") {
        if (mints.has(a)) return { context: { slot }, value: { owner: TOKEN_PROGRAM, lamports: 1_461_600, data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6, supply: "1000000000000000" } } } } };
        return { context: { slot }, value: null };
      }
      // Any other base64 read is a bonding-curve lookup.
      return { context: { slot }, value: { owner: PUMP_PROGRAM, lamports: 1_000_000, data: [curveData(), "base64"] } };
    },
    getTokenAccountsByOwner: ([owner, { programId }]) => {
      if (programId !== TOKEN_PROGRAM) return { context: { slot }, value: [] };
      const held = [...(tokens.get(owner) ?? new Map()).entries()].filter(([, n]) => n > 0).map(([mint, n]) => ({
        pubkey: b58enc(createHash("sha256").update(owner + mint).digest()),
        account: { lamports: 2_039_280, data: { parsed: { info: { mint, tokenAmount: { amount: String(n), uiAmount: n / 1e6, decimals: 6 } } } } },
      }));
      const empty = (emptyAccounts.get(owner) ?? []).map((e) => ({ pubkey: e.pubkey, account: { lamports: 2_039_280, data: { parsed: { info: { mint: e.mint, tokenAmount: { amount: "0", uiAmount: 0, decimals: 6 } } } } } }));
      return { context: { slot }, value: [...held, ...empty] };
    },
    sendTransaction: ([b64]) => { note("rpc", "sendTransaction"); return landTx(Buffer.from(b64, "base64")); },
    getRecentPrioritizationFees: () => [{ slot, prioritizationFee: 5000 }, { slot: slot - 1, prioritizationFee: 15000 }, { slot: slot - 2, prioritizationFee: 25000 }],
    getTransaction: ([sig]) => txStore.get(sig) ?? null,
    getTokenSupply: ([mint]) => ({ context: { slot }, value: { amount: "1000000000000000", decimals: 6, uiAmount: 1e9, uiAmountString: "1000000000" } }),
    getTokenLargestAccounts: ([mint]) => {
      const x = special.get(mint);
      if (!x?.holder) return { context: { slot }, value: [] };
      const acct = b58enc(createHash("sha256").update(`acct${mint}`).digest());
      specialAccts.set(acct, x.holder);
      return { context: { slot }, value: [{ address: acct, amount: String(x.holder.amount), decimals: 6, uiAmount: x.holder.amount / 1e6 }] };
    },
    getMultipleAccounts: ([list, o]) => ({ context: { slot }, value: list.map((a) => {
      if (o?.encoding === "jsonParsed") { const h = specialAccts.get(a); return h ? { owner: SPL, lamports: 2_039_280, data: { parsed: { info: { owner: h.owner, tokenAmount: { amount: String(h.amount) } } } } } : null; }
      return { owner: SYSTEM, lamports: 1_000_000_000, data: ["", "base64"] };
    }) }),
    simulateTransaction: ([b64]) => {
      let mint;
      try { mint = JSON.parse(Buffer.from(b64, "base64").toString()).mint; } catch { /* not ours */ }
      const x = special.get(mint);
      note("rpc", "simulate", { mint, err: x?.simErr ?? null });
      return { context: { slot }, value: { err: x?.simErr ? { InstructionError: [2, { Custom: 6001 }] } : null, logs: x?.simErr ? ["Program log: Instruction: Swap", `Program log: Error: ${x.simErr}`] : ["Program log: Instruction: Swap"] } };
    },
    getSignatureStatuses: ([list]) => ({ context: { slot }, value: list.map((s) => (sigs.has(s) ? { slot: sigs.get(s).slot, err: null, confirmationStatus: "confirmed", confirmations: 1 } : null)) }),
  };
  const rpc = await listen(async (req, res) => {
    const raw = (await body(req)).toString();
    if (!raw) return json(res, 400, { error: "empty" });
    const j = JSON.parse(raw);
    const f = rpcMethods[j.method];
    if (!f) return json(res, 200, { jsonrpc: "2.0", id: j.id, error: { code: -32601, message: `mock: ${j.method} not implemented` } });
    try { json(res, 200, { jsonrpc: "2.0", id: j.id, result: f(j.params ?? []) }); }
    catch (e) { note("rpc", "rejected", { error: e.message }); json(res, 200, { jsonrpc: "2.0", id: j.id, error: { code: -32003, message: e.message } }); }
  }, (req, socket) => {
    // websocket RPC: signatureSubscribe → signatureNotification when the transaction lands
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    ws.onText = (t) => {
      const m = JSON.parse(t);
      if (m.method === "logsSubscribe") {
        const id = ++logSubId;
        const wallet = m.params?.[0]?.mentions?.[0];
        logSubs.push({ ws, wallet, id });
        ws.onClose = () => { for (let i = logSubs.length - 1; i >= 0; i--) if (logSubs[i].ws === ws) logSubs.splice(i, 1); };
        note("rpcws", "logsSubscribe", { wallet });
        return ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: id }));
      }
      if (m.method !== "signatureSubscribe") return;
      const sig = m.params[0];
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: 1 }));
      const notify = () => { wsConfirms++; ws.send(JSON.stringify({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: 1, result: { context: { slot }, value: { err: null } } } })); };
      if (sigs.has(sig)) notify(); else sigWaiters.push({ sig, notify });
    };
  });

  // ---------------- Jito ----------------
  const bundles = new Map();
  const jito = await listen(async (req, res) => {
    const j = JSON.parse((await body(req)).toString() || "{}");
    if (j.method === "getTipAccounts") return json(res, 200, { jsonrpc: "2.0", id: j.id, result: ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"] });
    if (j.method === "sendBundle") {
      const [txs, opts] = j.params;
      try {
        const landed = txs.map((t) => landTx(opts?.encoding === "base64" ? Buffer.from(t, "base64") : b58dec(t)));
        const id = randomBytes(16).toString("hex");
        bundles.set(id, { slot, landed });
        note("jito", "bundle", { id, size: txs.length, signatures: landed });
        return json(res, 200, { jsonrpc: "2.0", id: j.id, result: id });
      } catch (e) {
        note("jito", "rejected", { error: e.message });
        return json(res, 200, { jsonrpc: "2.0", id: j.id, error: { message: e.message } });
      }
    }
    if (j.method === "getBundleStatuses") {
      const v = j.params[0].map((id) => (bundles.has(id) ? { bundle_id: id, slot: bundles.get(id).slot, confirmation_status: "confirmed", err: { Ok: null } } : null));
      return json(res, 200, { jsonrpc: "2.0", id: j.id, result: { context: { slot }, value: v } });
    }
    json(res, 200, { jsonrpc: "2.0", id: j.id, error: { message: "unknown" } });
  });

  // ---------------- PumpPortal + pump IPFS ----------------
  const uploads = [];
  const pumpData = new Set();
  let buildDelay = 0;
  const coinMeta = new Map();
  const pump = await listen(async (req, res) => {
    const raw = await body(req);
    if (req.url.startsWith("/meta/")) {
      const m = coinMeta.get(req.url.slice(6).replace(/\.json$/, ""));
      return m ? json(res, 200, m) : json(res, 404, {});
    }
    if (req.url.startsWith("/api/ipfs")) {
      const text = raw.toString("latin1");
      // multipart fields end at the next boundary; FormData sends line breaks inside values as CRLF
      const field = (n) => text.match(new RegExp(`name="${n}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1]?.replace(/\r\n/g, "\n");
      const hasFile = /name="file"; filename="[^"]+"\r\nContent-Type: image\//.test(text);
      const u = { name: field("name"), symbol: field("symbol"), description: field("description"), twitter: field("twitter"), website: field("website"), hasFile };
      uploads.push(u);
      note("pump", "ipfs", u);
      if (!u.name || !u.symbol || !hasFile) return json(res, 400, { error: "missing fields" });
      return json(res, 200, { metadataUri: `https://ipfs.mock/${randomBytes(8).toString("hex")}.json` });
    }
    if (!req.url.startsWith("/api/trade-local")) return json(res, 404, {});
    if (!raw.length) return json(res, 400, { error: "empty body" }); // keep-warm pings
    const j = JSON.parse(raw.toString());
    // v20: a slow builder, so parallel lanes show as overlapping requests
    if (buildDelay) { note("pump", "build-start", { actions: Array.isArray(j) ? j.map((r) => r.action) : [j.action], mint: Array.isArray(j) ? j[0]?.mint : j.mint }); await new Promise((r) => setTimeout(r, buildDelay)); }
    const one = (r) => {
      if (r.action === "create") return makeTx([r.publicKey, r.mint], { kind: "create", payer: r.publicKey, mint: r.mint, sol: Number(r.amount ?? 0), meta: r.tokenMetadata });
      if (r.action === "buy") return makeTx([r.publicKey], { kind: "buy", payer: r.publicKey, mint: r.mint, sol: Number(r.amount) });
      if (r.action === "sell") return makeTx([r.publicKey], { kind: "sell", payer: r.publicKey, mint: r.mint, pct: String(r.amount).endsWith("%") ? Number(String(r.amount).slice(0, -1)) : 100 });
      if (r.action === "collectCreatorFee") return makeTx([r.publicKey], { kind: "claim", payer: r.publicKey, mint: r.quoteMint });
      throw new Error(`unknown action ${r.action}`);
    };
    if (Array.isArray(j)) {
      note("pump", "bundle-build", { actions: j.map((r) => r.action), wallets: j.map((r) => r.publicKey) });
      return json(res, 200, j.map((r) => b58enc(one(r))));
    }
    note("pump", "trade-build", { action: j.action, amount: j.amount, priorityFee: j.priorityFee, slippage: j.slippage, mint: j.mint, ...(j.action === "create" || j.action === "collectCreatorFee" ? { fields: j } : {}) });
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.from(one(j)));
  }, (req, socket) => {
    // PumpPortal data websocket (wss://pumpportal.fun/api/data): subscriptions, then pushed creates and trades
    if (!req.url.startsWith("/api/data")) return socket.destroy();
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    const subs = { creates: false, migrations: false, trades: new Set(), accounts: new Set() };
    const entry = { ws, subs };
    pumpData.add(entry);
    ws.onClose = () => pumpData.delete(entry);
    ws.onText = (t) => {
      const m = JSON.parse(t);
      if (m.method === "subscribeNewToken") subs.creates = true;
      if (m.method === "subscribeMigration") subs.migrations = true;
      if (m.method === "subscribeTokenTrade") for (const k of m.keys ?? []) subs.trades.add(k);
      if (m.method === "subscribeAccountTrade") for (const k of m.keys ?? []) subs.accounts.add(k);
      if (m.method === "unsubscribeAccountTrade") for (const k of m.keys ?? []) subs.accounts.delete(k);
      if (m.method === "unsubscribeTokenTrade") for (const k of m.keys ?? []) subs.trades.delete(k);
      note("pumpdata", m.method, { keys: m.keys?.length ?? 0 });
      ws.send(JSON.stringify({ message: `Successfully subscribed (${m.method}).` }));
    };
  });

  // ---------------- X API ----------------
  let rules = [];
  const streams = new Set();
  const xPosts = new Map();
  const x = await listen(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== "Bearer e2e-x-token") return json(res, 401, { title: "Unauthorized" });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/2/tweets/search/stream/rules") {
      if (req.method === "GET") return json(res, 200, { data: rules, meta: { result_count: rules.length } });
      const j = JSON.parse((await body(req)).toString());
      if (j.delete) rules = rules.filter((r) => !j.delete.ids.includes(r.id));
      if (j.add) rules.push(...j.add.map((r) => ({ id: randomBytes(6).toString("hex"), ...r })));
      note("x", "rules", { rules: rules.map((r) => r.value) });
      return json(res, 200, { meta: { summary: { created: j.add?.length ?? 0 } } });
    }
    if (u.pathname === "/2/tweets/search/stream") {
      res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
      res.write("\r\n");
      streams.add(res);
      note("x", "stream-open");
      req.on("close", () => streams.delete(res));
      return;
    }
    const m = u.pathname.match(/^\/2\/tweets\/(\d+)$/);
    if (m) return xPosts.has(m[1]) ? json(res, 200, xPosts.get(m[1])) : json(res, 404, {});
    if (u.pathname === "/2/tweets/search/recent") return json(res, 200, { data: [], meta: {} });
    json(res, 404, {});
  });
  /** Push a post into every open stream connection, as X does: one JSON object per line, CRLF-separated. */
  function pushPost(p) {
    const id = p.id;
    const env = {
      data: { id, text: p.text, author_id: `u_${p.handle}`, created_at: new Date().toISOString(), attachments: p.image ? { media_keys: [`m_${id}`] } : undefined, public_metrics: { like_count: p.likes ?? 120, impression_count: 9800, retweet_count: 14 } },
      includes: { users: [{ id: `u_${p.handle}`, username: p.handle }], media: p.image ? [{ media_key: `m_${id}`, type: "photo", url: p.image }] : [] },
    };
    xPosts.set(id, env);
    const matches = rules.some((r) => r.value.startsWith(`from:${p.handle} `));
    for (const s of streams) if (matches) s.write(JSON.stringify(env) + "\r\n");
    note("x", "push", { id, handle: p.handle, delivered: matches ? streams.size : 0 });
    return matches ? streams.size : 0;
  }

  // ---------------- model (Ollama) ----------------
  const modelCalls = [];
  const model = await listen(async (req, res) => {
    const j = JSON.parse((await body(req)).toString());
    const sys = j.messages.find((m) => m.role === "system")?.content ?? "";
    const user = j.messages.find((m) => m.role === "user")?.content ?? "";
    let content;
    if (sys.startsWith("You name a memecoin")) content = JSON.stringify({ name: "Night Ferry", symbol: "FERRY", description: "A coin about the last ferry across the harbour." });
    else if (sys.startsWith("You turn a trader's message")) {
      const h = (user.match(/@?([a-z0-9_]{3,15}) (?:drops|posts)/i) ?? [])[1] ?? "harbourdesk";
      content = JSON.stringify({ name: `Snipe @${h} contracts`, trigger: { kind: "x-post", handles: [h.toLowerCase()], mode: "ca-in-post" }, buy: { amountSol: 0.2, maxMcapUsd: 60000, slippageBps: 1500, venue: "auto" }, exit: { takeProfit: [{ atMultiple: 2, sellPct: 50 }], stopLossPct: 30 }, maxBuysPerDay: 3 });
    } else content = JSON.stringify({ unknown: true });
    modelCalls.push({ kind: sys.slice(0, 24), user: user.slice(0, 80) });
    note("model", "chat", { kind: sys.slice(0, 24) });
    json(res, 200, { model: j.model, message: { role: "assistant", content }, done: true });
  });

  // ---------------- price ----------------
  const price = await listen(async (req, res) => {
    if (req.url.startsWith("/price")) return json(res, 200, { [WSOL]: { usdPrice: SOL_USD } });
    // Jupiter swap API (quote + swap build), for the can-sell check's sell simulation
    if (req.url.startsWith("/swap/v1/quote")) {
      const u = new URL(req.url, "http://x");
      note("jup", "quote", { inputMint: u.searchParams.get("inputMint"), slippageBps: u.searchParams.get("slippageBps") });
      // v23: claimed USDC → SOL gets a priced quote (the same rate the swap effect pays), for the quote shown before a swap
      if (u.searchParams.get("inputMint") === USDC_MINT) {
        const out = Math.floor((Number(u.searchParams.get("amount")) / 1e6 / SOL_USD) * 1e9 * 0.997);
        const slip = Number(u.searchParams.get("slippageBps") ?? 100);
        return json(res, 200, { inputMint: USDC_MINT, outputMint: u.searchParams.get("outputMint"), inAmount: u.searchParams.get("amount"), outAmount: String(out), otherAmountThreshold: String(Math.floor(out * (1 - slip / 10_000))), priceImpactPct: "0.0004", routePlan: [{ swapInfo: { label: "Mock AMM" } }] });
      }
      return json(res, 200, { inputMint: u.searchParams.get("inputMint"), outputMint: u.searchParams.get("outputMint"), inAmount: u.searchParams.get("amount"), outAmount: "5000", otherAmountThreshold: "2500", priceImpactPct: "0.01", routePlan: [] });
    }
    if (req.url.startsWith("/swap/v1/swap")) {
      const j = JSON.parse((await body(req)).toString());
      note("jup", "swap", { user: j.userPublicKey, inputMint: j.quoteResponse.inputMint });
      // v22.1: claimed USDC swapped to SOL is a real (mock) transaction the wallet signs
      if (j.quoteResponse.inputMint === USDC_MINT) return json(res, 200, { swapTransaction: Buffer.from(makeTx([j.userPublicKey], { kind: "swap", payer: j.userPublicKey, mint: USDC_MINT })).toString("base64") });
      return json(res, 200, { swapTransaction: Buffer.from(JSON.stringify({ mint: j.quoteResponse.inputMint, user: j.userPublicKey })).toString("base64") });
    }
    if (req.url.startsWith("/dex/tokens")) return json(res, 200, []);
    json(res, 404, {});
  });

  // ---------------- panel function + Realtime websocket ----------------
  const relaySockets = new Set();
  const panelCalls = [];
  const panelOps = [];
  const panelPipeline = []; // v19: pipeline steps the agent sent (2 s poll and report)
  const panelUrl = { v: "" };
  const panel = await listen(async (req, res) => {
    const j = JSON.parse((await body(req)).toString() || "{}");
    panelCalls.push(j.action);
    const tokenOk = req.headers["x-agent-token"] === "agt_e2e";
    if (j.action === "agent-pair") return j.code === "E2EPAIR" ? json(res, 200, { agentToken: "agt_e2e", agentId: "ag_e2e" }) : json(res, 400, { error: "That code expired or doesn't exist." });
    if (!tokenOk) return json(res, 401, { error: "agent token required" });
    if (j.action === "relay-token") return json(res, 200, { token: "jwt_e2e", wsUrl: `${panelUrl.v.replace("http", "ws")}/realtime/v1/websocket`, apikey: "anon_e2e", expiresAt: Date.now() + 3_600_000, carried: ["harbourdesk", "lumen_wire"] });
    if (j.action === "relay-subscribe") {
      const carried = j.handles.filter((h) => h !== "toolong_account");
      note("panel", "relay-subscribe", { handles: j.handles });
      return json(res, 200, { carried, notCarried: j.handles.filter((h) => !carried.includes(h)).map((h) => ({ handle: h, reason: "relay is full" })), perUserMax: 25 });
    }
    if ((j.action === "agent-report" || j.action === "agent-poll") && Array.isArray(j.pipeline)) panelPipeline.push(...j.pipeline.map((e) => ({ ...e, via: j.action })));
    if (j.action === "agent-report") return json(res, 200, { killSwitch: false, paused: false, rulesVersion: 0 });
    if (j.action === "agent-poll") { const ops = panelOps.splice(0); return json(res, 200, { decisions: [], deploys: [], ops }); }
    json(res, 200, {});
  }, (req, socket) => {
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    const u = new URL(req.url, "http://x");
    note("relay", "ws-open", { apikey: u.searchParams.get("apikey"), vsn: u.searchParams.get("vsn") });
    ws.onText = (t) => {
      const m = JSON.parse(t);
      if (m.event === "phx_join") {
        const ok = m.payload?.access_token === "jwt_e2e" && m.payload?.config?.private === true;
        note("relay", "join", { topic: m.topic, ok });
        ws.send(JSON.stringify({ topic: m.topic, event: "phx_reply", ref: m.ref, payload: ok ? { status: "ok", response: {} } : { status: "error", response: { reason: "unauthorized" } } }));
        if (ok) relaySockets.add(ws);
      } else if (m.event === "heartbeat") ws.send(JSON.stringify({ topic: "phoenix", event: "phx_reply", ref: m.ref, payload: { status: "ok", response: {} } }));
    };
    ws.onClose = () => relaySockets.delete(ws);
  });
  panelUrl.v = panel.url;
  function relayBroadcast(p) {
    const post = { id: p.id, handle: p.handle, text: p.text, urls: [], createdAt: new Date().toISOString(), media: p.image ? [{ type: "photo", url: p.image }] : undefined };
    for (const s of relaySockets) s.send(JSON.stringify({ topic: "realtime:relay", event: "broadcast", ref: null, payload: { type: "broadcast", event: "post", payload: post } }));
    note("relay", "broadcast", { id: p.id, to: relaySockets.size });
    return relaySockets.size;
  }

  const servers = [rpc, jito, pump, x, model, price, panel];
  return {
    urls: { rpc: rpc.url, jito: jito.url, pump: pump.url, x: x.url, model: model.url, price: price.url, panel: panel.url },
    log, uploads, modelCalls, panelCalls,
    fund: (a, sol) => addSol(a, sol * 1e9),
    wsConfirms: () => wsConfirms,
    balance: (a) => bal(a) / 1e9,
    tokenBalance: (o, m) => tok(o, m) / 1e6,
    setCreatorFees: (o, f) => creatorFees.set(o, { sol: Math.round((f.sol ?? 0) * 1e9), tokens: Object.fromEntries(Object.entries(f.tokens ?? {}).map(([k, v]) => [k, Math.round(v * 1e6)])) }),
    addEmptyAccounts: (owner, n) => emptyAccounts.set(owner, Array.from({ length: n }, (_, i) => ({ pubkey: b58enc(createHash("sha256").update(`empty${owner}${i}`).digest()), mint: b58enc(createHash("sha256").update(`mint${i}`).digest()) }))),
    emptyCount: (owner) => (emptyAccounts.get(owner) ?? []).length,
    pushPost, relayBroadcast,
    /** v19: a mint that isn't a pump.fun curve coin, for the can-sell check (see `special` above). */
    addSpecialMint: (mint, spec) => {
      special.set(mint, spec);
      specialCurves.add(PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), b58dec(mint)], new PublicKey(PUMP_PROGRAM))[0].toBase58());
    },
    /** PumpPortal data stream: a create (with metadata served at uri) or a trade, to every subscriber. */
    pushPumpData: (msg, meta) => {
      if (meta) { coinMeta.set(msg.mint, meta); msg = { ...msg, uri: `${pump.url}/meta/${msg.mint}.json` }; }
      let n = 0;
      for (const c of pumpData) if (msg.txType === "create" ? c.subs.creates : msg.txType === "migrate" ? c.subs.migrations : c.subs.trades.has(msg.mint) || c.subs.accounts.has(msg.traderPublicKey)) { c.ws.send(JSON.stringify(msg)); n++; }
      // The trade "landed" on chain (so getSignatureStatuses can report its slot).
      if (msg.signature && (msg.txType === "buy" || msg.txType === "sell") && !sigs.has(msg.signature)) sigs.set(msg.signature, { slot: ++slot, err: null });
      return n;
    },
    /** Dev-sell orders: how many sockets subscribed to this coin's trades. */
    tradeSubs: (mint) => [...pumpData].filter((c) => c.subs.trades.has(mint)).length,
    /** Copy trading: wallets PumpPortal account-trade subscribers asked for. */
    accountSubs: (w) => [...pumpData].filter((c) => c.subs.accounts.has(w)).length,
    /** Copy trading over the RPC: a transaction that mentions `wallet` lands; logsSubscribe subscribers get a notification, getTransaction returns `tx`. */
    pushLogs: (wallet, signature, tx) => {
      const s0 = ++slot;
      sigs.set(signature, { slot: s0, err: null });
      txStore.set(signature, { ...tx, slot: s0 });
      let n = 0;
      for (const l of logSubs.filter((x) => x.wallet === wallet)) { l.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: l.id, result: { context: { slot: s0 }, value: { signature, err: null, logs: [] } } } })); n++; }
      return n;
    },
    logSubs: (w) => logSubs.filter((x) => x.wallet === w).length,
    pumpDataCount: () => [...pumpData].filter((c) => c.subs.creates).length,
    migrationSubs: () => [...pumpData].filter((c) => c.subs.migrations).length,
    queueOp: (op) => panelOps.push({ id: randomBytes(4).toString("hex"), ...op }),
    setBuildDelay: (ms) => { buildDelay = ms; },
    pipeline: () => panelPipeline,
    opsLeft: () => panelOps.length,
    streamCount: () => streams.size,
    relayCount: () => relaySockets.size,
    stop: () => Promise.all(servers.map((s) => new Promise((r) => { s.server.closeAllConnections?.(); s.server.close(() => r()); }))),
    newKeypair: () => Keypair.generate(),
  };
}
