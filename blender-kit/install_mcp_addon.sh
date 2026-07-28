#!/usr/bin/env bash
# Ставит аддон BlenderMCP (сокет на localhost:9876), через который Claude
# лепит модели интерактивно. Для сборки ассетов он не нужен — она headless.
set -euo pipefail

BLENDER_APP="${BLENDER_APP:-/Applications/Blender.app/Contents/MacOS/Blender}"
# Пин на ревизию: по умолчанию main, но это исполняемый код в твоём Blender —
# лучше подставить конкретный коммит: ADDON_REF=<sha> ./install_mcp_addon.sh
ADDON_REF="${ADDON_REF:-main}"
ADDON_URL="https://raw.githubusercontent.com/ahujasid/blender-mcp/${ADDON_REF}/addon.py"

[ -x "$BLENDER_APP" ] || { echo "Blender не найден: $BLENDER_APP"; exit 1; }

VER=$("$BLENDER_APP" --version | head -1 | awk '{print $2}' | cut -d. -f1,2)
ADDON_DIR="$HOME/Library/Application Support/Blender/$VER/scripts/addons"
mkdir -p "$ADDON_DIR"

echo "→ Blender $VER, каталог аддонов: $ADDON_DIR"
TMP_ADDON="$(mktemp)"
curl -fsSL "$ADDON_URL" -o "$TMP_ADDON"
SHA=$(shasum -a 256 "$TMP_ADDON" | awk '{print $1}')

cat <<INFO

Скачан addon.py (ревизия «$ADDON_REF», $(wc -c < "$TMP_ADDON") байт)
  sha256: $SHA
  источник: $ADDON_URL

Это код, который будет исполняться внутри Blender с полными правами.
Проверь его перед установкой:  less "$TMP_ADDON"

INFO

if [ "${FORGE_ASSUME_YES:-}" != "1" ]; then
  printf 'Установить? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|Yes) ;;
    *) echo "Отменено. Файл остался: $TMP_ADDON"; exit 1 ;;
  esac
fi

mv "$TMP_ADDON" "$ADDON_DIR/blender_mcp_addon.py"
echo "✓ установлен в $ADDON_DIR/blender_mcp_addon.py"

"$BLENDER_APP" -b --python-expr "
import bpy
try:
    bpy.ops.preferences.addon_enable(module='blender_mcp_addon')
    bpy.ops.wm.save_userpref()
    print('FORGE_ADDON_OK')
except Exception as e:
    print('FORGE_ADDON_FAIL', e)
" 2>&1 | grep -E "FORGE_ADDON_(OK|FAIL)" || true

cat <<'EOF'

Дальше — два шага руками (сокет открывается только в GUI):
  1. Открыть Blender, N-панель → вкладка BlenderMCP → «Connect to Claude».
  2. Прописать MCP-сервер:
       claude mcp add blender -- uvx blender-mcp
     (uvx уже установлен: ~/.local/bin/uvx)

Для сборки спрайтов и превью ничего из этого не нужно:
  ./blend.sh render_preview.py -- --help
EOF
