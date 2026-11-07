#!/bin/sh
# Registers the native messaging host with Chrome. Run it again when node or claude moves.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
NAME="com.insanely_good_ai.host"
# The extension ID comes from the "key" in manifest.json, so it is the same on each load.
EXT_ID="$("$NODE" -e '
const { createHash } = require("crypto")
const key = require(process.argv[1]).key
const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)
console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(""))
' "$ROOT/extension/manifest.json")"

# Chrome starts the host with a short PATH, so keep the PATH and node path of this shell.
cat > "$ROOT/host/host.sh" <<EOF
#!/bin/sh
# Written by install.sh.
export PATH="$PATH"
exec "$NODE" "$ROOT/host/host.mjs" "\$@"
EOF
chmod +x "$ROOT/host/host.sh"

DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$DIR"
cat > "$DIR/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Insanely Good AI: Claude Code for the Chrome side panel",
  "path": "$ROOT/host/host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "Installed $DIR/$NAME.json"
echo "Extension ID: $EXT_ID"
