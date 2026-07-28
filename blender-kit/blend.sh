#!/usr/bin/env bash
# Обёртка над headless-Blender: ./blend.sh <script.py> [--blend файл.blend] -- <аргументы скрипта>
#
# Headless-режим детерминирован и повторяем — именно им собираются ассеты,
# тогда как BlenderMCP нужен для интерактивной лепки.
set -euo pipefail

BLENDER="${BLENDER_APP:-/Applications/Blender.app/Contents/MacOS/Blender}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCRIPT="${1:?укажи скрипт: ./blend.sh render_preview.py -- --help}"
shift

BLEND_FILE=""
if [ "${1:-}" = "--blend" ]; then BLEND_FILE="$2"; shift 2; fi
[ "${1:-}" = "--" ] && shift

[ -f "$SCRIPT" ] || SCRIPT="$HERE/$SCRIPT"

if [ -n "$BLEND_FILE" ]; then
  exec "$BLENDER" -b "$BLEND_FILE" -P "$SCRIPT" -- "$@"
else
  exec "$BLENDER" -b -P "$SCRIPT" -- "$@"
fi
