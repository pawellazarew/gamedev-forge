#!/usr/bin/env bash
# Обёртка над headless-Blender: ./blend.sh <script.py> [--blend файл.blend] -- <аргументы скрипта>
#
# Headless-режим детерминирован и повторяем — именно им собираются ассеты,
# тогда как BlenderMCP нужен для интерактивной лепки.
set -euo pipefail

if [ -n "${BLENDER_APP:-}" ]; then
  BLENDER="$BLENDER_APP"
elif command -v blender >/dev/null 2>&1; then
  BLENDER="$(command -v blender)"
else
  BLENDER="/Applications/Blender.app/Contents/MacOS/Blender"
fi
[ -x "$BLENDER" ] || { echo "Blender not found. Set BLENDER_APP to its executable." >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCRIPT="${1:?укажи скрипт: ./blend.sh render_preview.py -- --help}"
shift

BLEND_FILE=""
if [ "${1:-}" = "--blend" ]; then
  [ -n "${2:-}" ] || { echo "--blend requires a file path" >&2; exit 1; }
  BLEND_FILE="$2"
  shift 2
  [ -f "$BLEND_FILE" ] || { echo "Blend file not found: $BLEND_FILE" >&2; exit 1; }
fi
[ "${1:-}" = "--" ] && shift

[ -f "$SCRIPT" ] || SCRIPT="$HERE/$SCRIPT"
[ -f "$SCRIPT" ] || { echo "Script not found: $SCRIPT" >&2; exit 1; }

if [ -n "$BLEND_FILE" ]; then
  exec "$BLENDER" -b "$BLEND_FILE" -P "$SCRIPT" -- "$@"
else
  exec "$BLENDER" -b -P "$SCRIPT" -- "$@"
fi
