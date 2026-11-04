# Security

## Reporting a vulnerability

Please don't open a public issue. Email **security@veskagent.com** with steps to reproduce. We aim to reply within 72 hours and to ship a fix for anything that can move funds as fast as possible. Please give us reasonable time before disclosure.

In scope: anything that could leak a key or passphrase, sign a transaction the user didn't intend, bypass a guardrail or limit, or let the panel do more than report and pause.

## How Vesk handles secrets

- The wallet key and API keys are stored in `~/.vesk/keystore.json`, encrypted with AES-256-GCM under a scrypt-derived key (N=2^17, r=8, p=1), file mode 0600.
- Transactions are built by PumpPortal/Jupiter, then **signed locally** and sent through your RPC.
- The optional panel link only receives public data (status, positions, activity). It can pause the agent and toggle the kill switch. It cannot sign or read keys.
- No telemetry.

## Hosted agent

The hosted panel creates a separate trading wallet per user. Keys are envelope-encrypted (per-wallet AES-256-GCM data key wrapped with `VESK_KMS_SECRET`). Limits are enforced server-side. Users can withdraw and export at any time. Treat it as hot-wallet custody for small amounts.

## Supported versions

Only the latest release gets fixes during 0.x.
