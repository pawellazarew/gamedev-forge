#!/usr/bin/env bash
# Install the BlenderMCP add-on (socket on localhost:9876) for interactive
# modeling with Claude. Headless asset builds do not require it.
set -euo pipefail

BLENDER_APP="${BLENDER_APP:-/Applications/Blender.app/Contents/MacOS/Blender}"
# The add-on executes inside Blender with full privileges, so its revision is
# pinned to a commit and its contents verified against a known checksum.
# Update explicitly with: ADDON_REF=<sha> ADDON_SHA256=<sum> ./install_mcp_addon.sh
ADDON_REF="${ADDON_REF:-da4e16d2069ce5154eaa2535bf995e843caf5c73}"
EXPECTED_SHA="${ADDON_SHA256:-ca6955bb584d78e229f020a8b9d7011440adc6e94dab0ac8e01ab2794db19dc0}"
ADDON_URL="https://raw.githubusercontent.com/ahujasid/blender-mcp/${ADDON_REF}/addon.py"

[ -x "$BLENDER_APP" ] || { echo "Blender not found: $BLENDER_APP"; exit 1; }

VER=$("$BLENDER_APP" --version | head -1 | awk '{print $2}' | cut -d. -f1,2)
ADDON_DIR="$HOME/Library/Application Support/Blender/$VER/scripts/addons"
mkdir -p "$ADDON_DIR"

echo "→ Blender $VER, add-on directory: $ADDON_DIR"
TMP_ADDON="$(mktemp)"
curl -fsSL "$ADDON_URL" -o "$TMP_ADDON"
SHA=$(shasum -a 256 "$TMP_ADDON" | awk '{print $1}')

echo "  revision:  $ADDON_REF"
echo "  sha256:   $SHA"

if [ "$SHA" != "$EXPECTED_SHA" ]; then
  cat <<ERR

✗ Checksum mismatch.
    expected: $EXPECTED_SHA
    received:  $SHA

The remote file has changed. Review the diff and, if the changes are expected,
confirm explicitly with: ADDON_SHA256=$SHA ./install_mcp_addon.sh
Downloaded file kept for inspection: $TMP_ADDON
ERR
  exit 1
fi

if [ "${FORGE_ASSUME_YES:-}" != "1" ]; then
  printf 'Checksums match. Install? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|Yes) ;;
    *) echo "Cancelled. File kept at: $TMP_ADDON"; exit 1 ;;
  esac
fi

mv "$TMP_ADDON" "$ADDON_DIR/blender_mcp_addon.py"
echo "✓ installed at $ADDON_DIR/blender_mcp_addon.py"

ENABLE_LOG=$("$BLENDER_APP" -b --python-expr "
import bpy
try:
    bpy.ops.preferences.addon_enable(module='blender_mcp_addon')
    bpy.ops.wm.save_userpref()
    print('FORGE_ADDON_OK')
except Exception as e:
    print('FORGE_ADDON_FAIL', e)
" 2>&1) || true

echo "$ENABLE_LOG" | grep -E "FORGE_ADDON_(OK|FAIL)" || true

# Without this check, FORGE_ADDON_FAIL was lost in /dev/null: the script
# reported success while the add-on remained disabled
if ! echo "$ENABLE_LOG" | grep -q FORGE_ADDON_OK; then
  echo "✗ Blender could not enable the add-on; see the output above"
  exit 1
fi

cat <<'EOF'

Next, complete two manual steps (the socket opens only in the GUI):
  1. Open Blender, N-panel → BlenderMCP tab → "Connect to Claude".
  2. Register the MCP server:
       claude mcp add blender -- uvx blender-mcp
     (uvx is already installed at: ~/.local/bin/uvx)

None of this is required for sprite and preview builds:
  ./blend.sh render_preview.py -- --help
EOF
