#!/bin/bash
# =============================================================================
# openclaw-web — one-shot setup
# Runs on the same server where your OpenClaw agent is installed.
# =============================================================================
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HOME/.openclaw/.env"

echo ""
echo "=== openclaw-web setup ==="
echo ""

# --- 1. npm install -----------------------------------------------------------
echo "[1/5] Installing dependencies..."
cd "$REPO_DIR"
npm install --omit=dev
echo "      Done."

# --- 2. Fix OpenClaw device pairing scopes -----------------------------------
echo "[2/5] Patching OpenClaw device scopes..."
PAIRED="$HOME/.openclaw/devices/paired.json"
PENDING="$HOME/.openclaw/devices/pending.json"
REQUIRED_SCOPES='["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing","operator.talk.secrets"]'

if [ -f "$PAIRED" ]; then
  node - <<EOF
const fs = require('fs');
const path = '$PAIRED';
let data = JSON.parse(fs.readFileSync(path, 'utf8'));
const scopes = $REQUIRED_SCOPES;
let patched = 0;
if (Array.isArray(data)) {
  data = data.map(d => { if (!d.scopes || d.scopes.length < 6) { d.scopes = scopes; patched++; } return d; });
} else if (data && data.scopes) {
  if (data.scopes.length < 6) { data.scopes = scopes; patched++; }
}
fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('      Patched ' + patched + ' device(s).');
EOF
else
  echo "      WARNING: $PAIRED not found. Patch manually after OpenClaw pairing."
fi

[ -f "$PENDING" ] && echo "[]" > "$PENDING" && echo "      Cleared pending.json"

# --- 3. Install cloudflared if missing (optional, only if using CF tunnel) ---
if ! command -v cloudflared &>/dev/null && [ ! -f "$HOME/.local/bin/cloudflared" ]; then
  echo "[3/5] Installing cloudflared..."
  mkdir -p "$HOME/.local/bin"
  curl -sL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" \
    -o "$HOME/.local/bin/cloudflared"
  chmod +x "$HOME/.local/bin/cloudflared"
  echo "      Installed."
else
  echo "[3/5] cloudflared already present. Skipping."
fi
CLOUDFLARED_BIN="$HOME/.local/bin/cloudflared"
[ ! -f "$CLOUDFLARED_BIN" ] && CLOUDFLARED_BIN="$(command -v cloudflared)"

# --- 4. Domain / access setup ------------------------------------------------
echo ""
echo "[4/5] How do you want to access the web UI?"
echo ""
echo "  1) I have a domain/subdomain (e.g. agent.example.com) and Cloudflare"
echo "  2) I have a domain/subdomain but NOT on Cloudflare (I'll set DNS myself)"
echo "  3) No domain — just use http://IP:8080"
echo ""
read -rp "Enter choice [1/2/3]: " DOMAIN_CHOICE

if [ "$DOMAIN_CHOICE" = "1" ]; then
  echo ""
  read -rp "Enter your Cloudflare API token (needs Zone:DNS Edit + Account:Cloudflare Tunnel Edit): " CF_TOKEN
  read -rp "Enter your full subdomain (e.g. agent.example.com): " DOMAIN

  SUBDOMAIN="${DOMAIN%%.*}"
  BASE_DOMAIN="${DOMAIN#*.}"

  echo ""
  echo "  Creating Cloudflare tunnel..."

  ACCOUNT_ID=$(curl -s "https://api.cloudflare.com/client/v4/accounts" \
    -H "Authorization: Bearer $CF_TOKEN" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
process.stdout.write(d.result?.[0]?.id||'');
")

  [ -z "$ACCOUNT_ID" ] && echo "ERROR: Could not get CF account ID. Check token." && exit 1

  TUNNEL_RESP=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"openclaw-web-${SUBDOMAIN}\",\"tunnel_secret\":\"$(openssl rand -base64 32)\"}")

  TUNNEL_ID=$(echo "$TUNNEL_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.result?.id||'');")
  TUNNEL_TOKEN_VALUE=$(echo "$TUNNEL_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.result?.token||'');")

  [ -z "$TUNNEL_ID" ] && echo "ERROR: Tunnel creation failed." && exit 1

  ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=${BASE_DOMAIN}" \
    -H "Authorization: Bearer $CF_TOKEN" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
process.stdout.write(d.result?.[0]?.id||'');
")

  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"CNAME\",\"name\":\"$SUBDOMAIN\",\"content\":\"${TUNNEL_ID}.cfargotunnel.com\",\"proxied\":true}" > /dev/null

  grep -q "^TUNNEL_TOKEN=" "$ENV_FILE" 2>/dev/null \
    && sed -i "s|^TUNNEL_TOKEN=.*|TUNNEL_TOKEN=$TUNNEL_TOKEN_VALUE|" "$ENV_FILE" \
    || echo "TUNNEL_TOKEN=$TUNNEL_TOKEN_VALUE" >> "$ENV_FILE"

  cat > "$REPO_DIR/tunnel.sh" <<TUNNELSH
#!/bin/bash
TUNNEL_TOKEN=\$(grep TUNNEL_TOKEN "$ENV_FILE" | cut -d= -f2-)
exec $CLOUDFLARED_BIN tunnel --no-autoupdate run --token "\${TUNNEL_TOKEN}"
TUNNELSH
  chmod +x "$REPO_DIR/tunnel.sh"

  ACCESS_URL="https://$DOMAIN"
  USE_TUNNEL=true
  echo "  Tunnel created. DNS CNAME set: $DOMAIN"

elif [ "$DOMAIN_CHOICE" = "2" ]; then
  read -rp "Enter your full subdomain (e.g. agent.example.com): " DOMAIN
  SERVER_IP=$(curl -s https://api.ipify.org)
  echo ""
  echo "  Add this A record in your DNS provider:"
  echo ""
  echo "    Type:  A"
  echo "    Name:  ${DOMAIN%%.*}"
  echo "    Value: $SERVER_IP"
  echo "    TTL:   Auto"
  echo ""
  read -rp "Press Enter once you've set the DNS record (propagation may take a few minutes)..."
  ACCESS_URL="http://$DOMAIN:8080"
  USE_TUNNEL=false

else
  SERVER_IP=$(curl -s https://api.ipify.org)
  ACCESS_URL="http://$SERVER_IP:8080"
  DOMAIN=""
  USE_TUNNEL=false
  echo "  Will be accessible at: $ACCESS_URL"
  echo "  Make sure port 8080 is open in your server firewall."
fi

# --- 5. Start with PM2 -------------------------------------------------------
echo ""
echo "[5/5] Starting with PM2..."

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

cd "$REPO_DIR"
pm2 delete openclaw-web 2>/dev/null || true
pm2 delete openclaw-cf  2>/dev/null || true

pm2 start server.js --name openclaw-web

if [ "$USE_TUNNEL" = "true" ]; then
  pm2 start tunnel.sh --name openclaw-cf --interpreter bash
fi

pm2 save

# Watchdog cron (every 3 min)
CRON_CMD="*/3 * * * * pm2 ping > /dev/null 2>&1 || (pm2 resurrect && echo \"\$(date): resurrected\" >> /tmp/pm2-resurrect.log)"
(crontab -l 2>/dev/null | grep -v "pm2 resurrect"; echo "$CRON_CMD") | crontab -

echo ""
echo "======================================"
echo " Setup complete"
echo "======================================"
echo ""
echo " URL:      $ACCESS_URL"
echo " Password: changeme123"
echo ""
echo " ⚠️  Change the password immediately via Settings in the UI."
echo ""
pm2 list
