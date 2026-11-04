# Security model

## Self-hosted (default)

- **Your key stays on your machine.** It's stored in `~/.vesk/keystore.json`, encrypted with AES-256-GCM under a key derived from your passphrase with scrypt (N=2^17, r=8, p=1). The file is written with `0600` permissions.
- **API keys** (model, X, Telegram) can live in the same encrypted keystore (`vesk keys set`) or in your environment.
- **Transactions are built remotely, signed locally.** PumpPortal and Jupiter return unsigned transactions. Vesk signs them on your machine and sends them through your RPC.
- **The panel link is one-way and public-data only.** After `vesk pair`, the agent reports status, positions and activity lines. The panel can pause the agent or flip the kill switch. It can't sign, trade, or see keys.
- **No telemetry.** Vesk talks only to the services you configure: your RPC, PumpPortal, Jupiter, DexScreener, your model provider, the X API with your token, Telegram, and your panel if you paired one.

Automated actions are no exception: launches from a post, Deploy and Instant deploy, timed dev sells and every other exit are signed on your machine, the same way as a manual trade.

## Hosted agent (optional)

- The panel creates a **separate trading wallet** for you. It is not your main wallet.
- Its secret key is encrypted with **envelope encryption**: a random data key per wallet (AES-256-GCM) wrapped by the server secret `VESK_KMS_SECRET`. The database only stores ciphertext.
- **Limits are enforced on the server**: per-trade max, daily spend cap, kill switch.
- **Withdraw any time** to any address. **Export the key** after re-entering your login phrase.
- Only fund it with small amounts you can afford to lose.

## Login phrase

The panel signs you in with a **12-word login phrase**. It is not a wallet seed phrase and can't hold or move crypto. The server stores only a salted scrypt hash of it. Vesk can't recover it for you.

## Your part

- Use a fresh wallet for the agent. Keep your main wallet elsewhere.
- Use a long passphrase. If you set `VESK_PASSPHRASE` for services, protect that environment.
- Read `install.sh` before piping it to bash.

Found a vulnerability? See `SECURITY.md`.

## Holder access

The hosted panel checks $VESK holdings by **signed message** (ed25519, verified server-side), never by importing a key. See [Holder access](09-holder-access.md).
