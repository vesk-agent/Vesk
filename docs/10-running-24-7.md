# Running 24/7

Launch on post and the tracker only help while the agent is running. Run it on a small always-on machine near your RPC.

## Where

- A VPS in the same region as your RPC (most Solana RPCs are in Frankfurt, Amsterdam, New York or Tokyo). 1 vCPU and 1 GB RAM is plenty.
- Use a private RPC (Helius, QuickNode, Triton). The public RPC is rate-limited.

## Unlocking without typing

The agent needs your keystore passphrase to start. On a server, put it in the environment of the service (readable by your user only):

```bash
# /etc/vesk.env (chmod 600)
VESK_PASSPHRASE=your-passphrase
```

Anyone who can read that file and the keystore can use the wallet, so keep the server locked down and fund the wallet with what you can lose.

## systemd

```ini
# /etc/systemd/system/vesk.service
[Unit]
Description=Vesk agent
After=network-online.target

[Service]
User=vesk
EnvironmentFile=/etc/vesk.env
ExecStart=/usr/bin/env vesk summon --stream
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now vesk
journalctl -u vesk -f
```

## pm2

```bash
VESK_PASSPHRASE=… pm2 start "vesk summon --stream" --name vesk
pm2 save && pm2 startup
```

## Docker

The repo ships a `Dockerfile` (builds from source, runs as the `node` user) and a `docker-compose.yml`. Your keystore, config and state live in the `./vesk` volume, never in the image.

```bash
git clone https://github.com/vesk-agent/vesk.git && cd vesk
docker compose run --rm vesk init          # one time: wallet, RPC, model (interactive)
printf 'VESK_PASSPHRASE=…\n' > vesk.env && chmod 600 vesk.env
docker compose up -d
docker compose logs -f
docker compose run --rm vesk doctor        # health check at any time
```

The container restarts unless you stop it. It starts in paper mode unless your config says otherwise; change the compose `command` to `["summon", "--live", "--stream"]` only when you mean it.

## Keep the model funded

If you use a hosted model (Claude, GPT, OpenRouter) for naming coins or chat, keep its account funded. If a model call fails, Vesk falls back to your name and ticker templates, so launches still happen, just with template names. Use **Template** naming in presets if you want zero model dependency, which is also the fastest.

## What happens on restart

- State (positions, fills, limits used today, launch history and dedupe) is saved to `~/.vesk/state.json` and reloaded.
- Exits resume on the next 3 s tick. Timed sells that came due while the agent was down run right away.
- The X watcher picks up where it left off, but **never acts on posts from before it started**, so a restart can't launch a coin on an old post.
- Confirm-mode drafts that expired while it was down stay expired.
- Rules, presets and tracker groups changed in the panel are pulled on the next report (if `panel.syncRules` is on).

## Health

- `vesk status` (or `--json`): mode, today's spend, open positions, recent activity. `vesk positions` for open and recently closed.
- `vesk doctor` (or `--json`, exit code 1 on a failed check): node, config, keystore, RPC latency and websocket, model key, X source.
- The panel's status bar shows the agent's last check-in and RPC latency.
- Telegram alerts for buys, sells, launches, guardrail blocks and errors.
