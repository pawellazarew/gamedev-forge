#!/usr/bin/env bash
# Ставит аддон BlenderMCP (сокет на localhost:9876), через который Claude
# лепит модели интерактивно. Для сборки ассетов он не нужен — она headless.
set -euo pipefail

BLENDER_APP="${BLENDER_APP:-/Applications/Blender.app/Contents/MacOS/Blender}"
# Аддон исполняется внутри Blender с полными правами, поэтому ревизия
# закреплена коммитом, а содержимое сверяется с известной контрольной суммой.
# Обновление — осознанный шаг: ADDON_REF=<sha> ADDON_SHA256=<sum> ./install_mcp_addon.sh
ADDON_REF="${ADDON_REF:-da4e16d2069ce5154eaa2535bf995e843caf5c73}"
EXPECTED_SHA="${ADDON_SHA256:-ca6955bb584d78e229f020a8b9d7011440adc6e94dab0ac8e01ab2794db19dc0}"
ADDON_URL="https://raw.githubusercontent.com/ahujasid/blender-mcp/${ADDON_REF}/addon.py"

[ -x "$BLENDER_APP" ] || { echo "Blender не найден: $BLENDER_APP"; exit 1; }

VER=$("$BLENDER_APP" --version | head -1 | awk '{print $2}' | cut -d. -f1,2)
ADDON_DIR="$HOME/Library/Application Support/Blender/$VER/scripts/addons"
mkdir -p "$ADDON_DIR"

echo "→ Blender $VER, каталог аддонов: $ADDON_DIR"
TMP_ADDON="$(mktemp)"
curl -fsSL "$ADDON_URL" -o "$TMP_ADDON"
SHA=$(shasum -a 256 "$TMP_ADDON" | awk '{print $1}')

echo "  ревизия:  $ADDON_REF"
echo "  sha256:   $SHA"

if [ "$SHA" != "$EXPECTED_SHA" ]; then
  cat <<ERR

✗ Контрольная сумма не совпала.
    ожидалась: $EXPECTED_SHA
    получена:  $SHA

Удалённый файл изменился. Проверь диф и, если изменения ожидаемы, запусти с
явным подтверждением: ADDON_SHA256=$SHA ./install_mcp_addon.sh
Скачанный файл оставлен для проверки: $TMP_ADDON
ERR
  exit 1
fi

if [ "${FORGE_ASSUME_YES:-}" != "1" ]; then
  printf 'Суммы совпали. Установить? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|Yes) ;;
    *) echo "Отменено. Файл остался: $TMP_ADDON"; exit 1 ;;
  esac
fi

mv "$TMP_ADDON" "$ADDON_DIR/blender_mcp_addon.py"
echo "✓ установлен в $ADDON_DIR/blender_mcp_addon.py"

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

# Без этой проверки FORGE_ADDON_FAIL уходил в /dev/null: скрипт «успешно»
# завершался, а аддон оставался выключенным
if ! echo "$ENABLE_LOG" | grep -q FORGE_ADDON_OK; then
  echo "✗ Blender не включил аддон — смотри вывод выше"
  exit 1
fi

cat <<'EOF'

Дальше — два шага руками (сокет открывается только в GUI):
  1. Открыть Blender, N-панель → вкладка BlenderMCP → «Connect to Claude».
  2. Прописать MCP-сервер:
       claude mcp add blender -- uvx blender-mcp
     (uvx уже установлен: ~/.local/bin/uvx)

Для сборки спрайтов и превью ничего из этого не нужно:
  ./blend.sh render_preview.py -- --help
EOF
