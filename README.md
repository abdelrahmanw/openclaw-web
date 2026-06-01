# openclaw-web

A Claude.ai-style web chat interface for your [OpenClaw](https://openclaw.ai) agent. Self-hosted, password-protected, runs on the same server as your agent.

**Same brain as your other channels** — web chats route through `openclaw agent` CLI, so the web UI shares the same memory, skills, tools, and session context as Telegram or any other channel you have configured.

![screenshot placeholder](https://raw.githubusercontent.com/abdelrahmanw/openclaw-web/main/docs/screenshot.png)

## Features

- Multi-chat, multi-project organization
- File and image upload support
- Voice message transcription (Whisper via OpenClaw)
- Markdown + code rendering with syntax highlighting
- Artifact panel for code/documents
- Skills and Workflows browser
- Shareable chat links
- Full-text chat search
- Dark/light mode
- Optional Telegram session linking (share context across channels)

## Requirements

- A server running [OpenClaw](https://openclaw.ai) with an agent configured
- Node.js v18+
- `pm2` (installed automatically by setup)
- `cloudflared` (installed automatically if you choose Cloudflare tunnel)

## Quick setup

```bash
git clone https://github.com/abdelrahmanw/openclaw-web.git
cd openclaw-web
chmod +x setup.sh
./setup.sh
```

The setup script will ask you one question: how do you want to access the UI?

- **Option 1 — Cloudflare tunnel** (recommended): you have a domain on Cloudflare. Provide your CF API token and subdomain. Setup creates the tunnel, DNS CNAME, and wires everything automatically. Result: `https://yourname.yourdomain.com`
- **Option 2 — Custom domain, other DNS**: you have a domain not on Cloudflare. Setup gives you an A record to add manually. Result: `http://yourname.yourdomain.com:8080`
- **Option 3 — IP only**: no domain. Result: `http://your-server-ip:8080` (make sure port 8080 is open)

When setup finishes, you'll see your URL and the default password (`changeme123`). **Change it immediately** via Settings in the UI.

## Updating

```bash
cd openclaw-web
./update.sh
```

Pulls latest, reinstalls deps, restarts the server. Done.

## Troubleshooting

### Site shows Cloudflare error 1033
PM2 died. Run:
```bash
pm2 resurrect
pm2 list
```
If still down:
```bash
cd openclaw-web
pm2 start server.js --name openclaw-web
pm2 start tunnel.sh --name openclaw-cf --interpreter bash
pm2 save
```

### Agent not responding (just spins)
The OpenClaw agent CLI is failing. Check:
```bash
openclaw gateway status
openclaw agent --session-id test-ping --message "ping" --json
```
If you get a scope error, edit `~/.openclaw/devices/paired.json` and ensure the device has all 6 scopes:
```
operator.admin, operator.read, operator.write, operator.approvals, operator.pairing, operator.talk.secrets
```
Also set `~/.openclaw/devices/pending.json` to `[]` and restart the gateway.

### PM2 watchdog log
```bash
cat /tmp/pm2-resurrect.log
```

## How it works

Each web chat maps to an OpenClaw session key (`web-<chatId>`). Every message is sent through:

```
openclaw agent --session-id web-<chatId> --message <text> --json
```

You can optionally link a web chat to a Telegram session by setting `telegram_session_key` on the chat — both channels then share full agent context and history.

## File structure

| File | Purpose |
|---|---|
| `server.js` | Express API server |
| `db.js` | SQLite schema and helpers |
| `gateway-client.js` | OpenClaw gateway WebSocket client |
| `public/` | Frontend (HTML, JS, CSS) |
| `setup.sh` | One-time setup |
| `update.sh` | Pull latest + restart |
| `tunnel.sh` | Cloudflare tunnel launcher (created by setup) |

## License

MIT
