// Initial catalog migrated verbatim from public/facts.html.
// INSERT OR IGNORE seeding in db.js makes this safe on every boot.
module.exports = [
  {
    "id": "moldova-ssh",
    "category": "Server Access",
    "icon": "🖥️",
    "title": "Moldova Server — SSH",
    "detail": "Host: 217.156.8.100\nUser: root (old) / deploy (current)\nPort: 22 (old) / 22666 (current, key auth)\nKey path (Hostinger): /data/.ssh/moldova\nPersistent tunnel via autossh forwarding all arr ports.",
    "secret": false,
    "sort_order": 0
  },
  {
    "id": "moldova-deploy-pass",
    "category": "Server Access",
    "icon": "🔑",
    "title": "Moldova — Deploy Password",
    "detail": "Deploy user password stored in memory recall. Ask Meshmesh: 'moldova deploy user password'.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 1
  },
  {
    "id": "ssh-tunnel",
    "category": "Server Access",
    "icon": "🔗",
    "title": "SSH Tunnel",
    "detail": "ssh -L 7878:127.0.0.1:7878 -L 8989:127.0.0.1:8989 -L 9696:127.0.0.1:9696 -L 8085:127.0.0.1:8085 root@217.156.8.100\n(Use deploy@22666 for new setup)",
    "secret": false,
    "sort_order": 2
  },
  {
    "id": "arrstack-mcp",
    "category": "Server Access",
    "icon": "🔌",
    "title": "Arrstack MCP",
    "detail": "http://217.156.8.100:8000/mcp\nRestricted via UFW source IP + IPv6.",
    "secret": false,
    "sort_order": 3
  },
  {
    "id": "jellyfin",
    "category": "Media Server",
    "icon": "🎬",
    "title": "Jellyfin",
    "detail": "https://jellyfin.abdowahba.me\nAdmin: adminAW",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 4
  },
  {
    "id": "radarr",
    "category": "Media Server",
    "icon": "🎥",
    "title": "Radarr / Sonarr / Prowlarr",
    "detail": "All on Moldova (217.156.8.100).\nAPI keys in memory recall.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 5
  },
  {
    "id": "qbit",
    "category": "Media Server",
    "icon": "⬇️",
    "title": "qBittorrent",
    "detail": "Port 8085 via Gluetun VPN.\nHTTPS: https://qbt.abdowahba.me\nUser: admin\nExternal access blocked via iptables.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 6
  },
  {
    "id": "google-accounts",
    "category": "Google Workspace",
    "icon": "📧",
    "title": "Google Account Aliases",
    "detail": "4 accounts (OAuth tokens):\n• abdo — personal\n• pcb — Product Camp Berlin\n• accord — Accord Partners\n• gmail — GMail",
    "secret": false,
    "sort_order": 7
  },
  {
    "id": "coaching-invoices",
    "category": "Google Workspace",
    "icon": "📄",
    "title": "Invoices Folder",
    "detail": "Drive folder: 1JgUOOboLPSDs4eCi86Q-g6iF5FTncDy4\nUse google-workspace-intake skill.",
    "secret": false,
    "sort_order": 8
  },
  {
    "id": "asana",
    "category": "APIs & Services",
    "icon": "📋",
    "title": "Asana",
    "detail": "Personal: me@abdowahba.com\nAccord: abdo@accordpartners.ai\nAPI keys in memory recall.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 9
  },
  {
    "id": "dropbox",
    "category": "APIs & Services",
    "icon": "📦",
    "title": "Dropbox",
    "detail": "Token at dropbox-access-token.txt\nAuto-refresh enabled.\nPreferred: Invoices/YYYY/{Cat}/{Vendor}/",
    "secret": false,
    "sort_order": 10
  },
  {
    "id": "pipedrive",
    "category": "APIs & Services",
    "icon": "💼",
    "title": "Pipedrive CRM",
    "detail": "User ID: 24659421. Company: Self-employed.\nAPI token in memory recall.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 11
  },
  {
    "id": "trello",
    "category": "APIs & Services",
    "icon": "📌",
    "title": "Trello (SessionPlanner)",
    "detail": "Board ID: 69c975eede47a0d0755b7627\nAPI key + token in memory recall.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 12
  },
  {
    "id": "tito",
    "category": "APIs & Services",
    "icon": "🎟️",
    "title": "Tito (AI Camp Berlin)",
    "detail": "abdo@productcampberlin.org\nPassword in memory recall.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 13
  },
  {
    "id": "ticktick",
    "category": "APIs & Services",
    "icon": "✅",
    "title": "TickTick (Maton)",
    "detail": "Skill: skills/ticktick-api-skill/\nMaton API key in memory recall.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 14
  },
  {
    "id": "github",
    "category": "APIs & Services",
    "icon": "🐙",
    "title": "GitHub",
    "detail": "Account: abdelrahmanw (id 32943707)\nPAT token (scope: repo) stored in memory recall.\nAccess via HTTP API: Authorization: token <PAT>\nRepos with PUSH+PULL access (9 total, private unless noted):\n• abdelrahmanw/accord-openclaw-web\n• abdelrahmanw/aicamp-tests\n• abdelrahmanw/bads-ws1718-group-15\n• abdelrahmanw/book-keeping\n• abdelrahmanw/openclaw-web (public)\n• Accord-Partners/accordos_frontend\n• accordsparc/book-keeping\n• dirkbartels14050/PCBsession-2\n• Humboldt-BADS/bads-ws1718-group-15",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 15
  },
  {
    "id": "env-keys",
    "category": "APIs & Services",
    "icon": "🔐",
    "title": "Env Var Keys",
    "detail": "OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, GEMINI_API_KEY, OXYLABS_AISTUDIO_API_KEY, OPENCLAW_GATEWAY_TOKEN, MATON_API_KEY",
    "secret": false,
    "sort_order": 16
  },
  {
    "id": "namecheap",
    "category": "APIs & Services",
    "icon": "🌐",
    "title": "Namecheap API",
    "detail": "For DNS on abdowahba.me\nCredentials in memory recall.",
    "secret": true,
    "hint": "Encrypted — ask Meshmesh",
    "sort_order": 17
  },
  {
    "id": "skills",
    "category": "Config & Skills",
    "icon": "🧰",
    "title": "Available Skills",
    "detail": "1. coaching-invoice-generator\n2. feedback-form-aggregation\n3. google-workspace-intake\n4. meshmesh-market-search\n5. moldova-media-server\n6. oldtimer-deutsche-post-csv\n7. oldtimer-word-workflow\n8. product-feedback-to-sheet-and-trello\nAll in skills/ directory.",
    "secret": false,
    "sort_order": 18
  },
  {
    "id": "model-lock",
    "category": "Config & Skills",
    "icon": "🤖",
    "title": "Model Lock",
    "detail": "Default: DeepSeek Chat (deepseek/deepseek-v4-flash).\nNever switch without Abdo approval.",
    "secret": false,
    "sort_order": 19
  },
  {
    "id": "encoding",
    "category": "Config & Skills",
    "icon": "🔤",
    "title": "Character Encoding",
    "detail": "Always UTF-8. German (ä,ö,ü,ß) and Arabic must display correctly. No encoding artifacts.",
    "secret": false,
    "sort_order": 20
  },
  {
    "id": "subagent",
    "category": "Config & Skills",
    "icon": "🧩",
    "title": "Sub-Agent Strategy",
    "detail": "Spawn for: Google Drive, email, docs, data retrieval, Google Workspace, multi-step, workflows, multi-step skills, anything blocking main session.",
    "secret": false,
    "sort_order": 21
  },
  {
    "id": "backup",
    "category": "Config & Skills",
    "icon": "💾",
    "title": "Backup Schedule",
    "detail": "Tuesdays & Fridays only.\n→ Google Drive 'Meshmesh Backups' folder.\nTimestamps in folder names.",
    "secret": false,
    "sort_order": 22
  },
  {
    "id": "meshmesh-web",
    "category": "Config & Skills",
    "icon": "🌍",
    "title": "Meshmesh Web UI",
    "detail": "https://meshmesh.abdowahba.me\nTraefik + Let's Encrypt on Hostinger.\nPM2: openclaw-web",
    "secret": false,
    "sort_order": 23
  },
  {
    "id": "browser-setup",
    "category": "Config & Skills",
    "icon": "🖥️",
    "title": "Browser Setup",
    "detail": "Xvfb :99, x11vnc 5900, noVNC 6080.\nChromium at DISPLAY=:99",
    "secret": false,
    "sort_order": 24
  },
  {
    "id": "tailscale",
    "category": "Config & Skills",
    "icon": "🔒",
    "title": "Tailscale Sidecar",
    "detail": "meshmesh-hostinger (100.71.162.25).\nSOCKS5 172.18.0.5:1080 → Samsung S9 FE exit node.",
    "secret": false,
    "sort_order": 25
  },
  {
    "id": "tito-sync",
    "category": "Workflows",
    "icon": "🔄",
    "title": "Tito → Sheet Sync",
    "detail": "Trigger: 'tito sync'\nSyncs tickets + discount codes.\nSmart update (bold changed cells).",
    "secret": false,
    "sort_order": 26
  },
  {
    "id": "apartment",
    "category": "Other",
    "icon": "🏠",
    "title": "Berlin Apartment",
    "detail": "Kaiser-Wilhelm-Str. 109 A\nWarm rent: 1,683 EUR (base 1,073+utils 342+elec 96+net 62+buffer 110)\nMax 3yr. Deposit 3,219 EUR. Cost-covering.",
    "secret": false,
    "sort_order": 27
  },
  {
    "id": "audio-transcribe",
    "category": "Other",
    "icon": "🎤",
    "title": "Audio Transcription",
    "detail": "Auto-transcribe Telegram voice notes.\nPrefer DeepSeek. React after transcribing.",
    "secret": false,
    "sort_order": 28
  }
];
