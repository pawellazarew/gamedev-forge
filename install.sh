#!/usr/bin/env bash
# Install critic agents and skills into a working project:
#   ./install.sh /path/to/project
# Files are copied, not symlinked, so the project survives repository moves.
set -euo pipefail

TARGET="${1:?provide a project path: ./install.sh /path/to/project}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$TARGET" ] || { echo "Directory not found: $TARGET"; exit 1; }

mkdir -p "$TARGET/.claude/agents" "$TARGET/.claude/skills"
cp "$HERE"/claude/agents/*.md "$TARGET/.claude/agents/"
cp -R "$HERE"/claude/skills/* "$TARGET/.claude/skills/"

echo "✓ agents:  $(ls "$HERE"/claude/agents/*.md | wc -l | tr -d ' ') files → $TARGET/.claude/agents/"
echo "✓ skills:  $(ls -d "$HERE"/claude/skills/*/ | wc -l | tr -d ' ') files → $TARGET/.claude/skills/"
cat <<INFO

Next:
  cd "$HERE/game-forge" && npm install
  node bin/forge.mjs init <game directory>

Skills refer to tools at tools/game-forge. Place the repository there
or create symlinks:
  ln -s "$HERE/game-forge"  "$TARGET/tools/game-forge"
  ln -s "$HERE/blender-kit" "$TARGET/tools/blender-kit"
INFO
