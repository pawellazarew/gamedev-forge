#!/usr/bin/env bash
# Ставит агентов-критиков и скиллы в рабочий проект:
#   ./install.sh /path/to/project
# Файлы копируются, а не симлинкуются: проект должен переживать перенос репо.
set -euo pipefail

TARGET="${1:?укажи путь к проекту: ./install.sh /path/to/project}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$TARGET" ] || { echo "Нет каталога $TARGET"; exit 1; }

mkdir -p "$TARGET/.claude/agents" "$TARGET/.claude/skills"
cp "$HERE"/claude/agents/*.md "$TARGET/.claude/agents/"
cp -R "$HERE"/claude/skills/* "$TARGET/.claude/skills/"

echo "✓ агенты:  $(ls "$HERE"/claude/agents/*.md | wc -l | tr -d ' ') шт → $TARGET/.claude/agents/"
echo "✓ скиллы:  $(ls -d "$HERE"/claude/skills/*/ | wc -l | tr -d ' ') шт → $TARGET/.claude/skills/"
cat <<INFO

Дальше:
  cd "$HERE/game-forge" && npm install
  node bin/forge.mjs init <папка игры>

Скиллы ссылаются на инструменты по пути tools/game-forge — либо положи репо
туда, либо поставь симлинк:
  ln -s "$HERE/game-forge"  "$TARGET/tools/game-forge"
  ln -s "$HERE/blender-kit" "$TARGET/tools/blender-kit"
INFO
