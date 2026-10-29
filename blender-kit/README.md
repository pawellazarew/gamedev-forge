# blender-kit

**English** | [Русский](README.ru.md)

Headless Blender helpers for model previews and 3D-to-2D sprite baking.
Requires **Blender 5.x** (developed with 5.1.1), including its bundled Python
and NumPy. No separate Python environment or AI account is needed.

## Quick start

Run from this directory:

```bash
./blend.sh demo_robot.py -- --out /tmp/robot.blend
./blend.sh render_preview.py --blend /tmp/robot.blend -- --out /tmp/preview.png
./blend.sh bake_sprites.py --blend /tmp/robot.blend -- \
  --out /tmp/robot-sprites --anim walk --dirs 8 --frames 1-24 --step 3 --size 96
```

The wrapper uses `BLENDER_APP` if set, then `blender` on `PATH`, then the standard
macOS application path. For a custom installation:

```bash
BLENDER_APP=/opt/blender/blender ./blend.sh demo_robot.py -- --out /tmp/robot.blend
```

macOS is used for development. The wrapper supports Linux installations;
headless rendering still requires graphics drivers appropriate for Blender.
Windows users can invoke Blender directly with `-b -P script.py -- ...`.

## Tools

| Script | Output / purpose |
| --- | --- |
| `blend.sh` | Run a Python script in background Blender, optionally loading a `.blend` |
| `demo_robot.py` | Animated example model saved as `.blend` |
| `render_preview.py` | Four views arranged in one PNG |
| `bake_sprites.py` | Transparent PNG atlas + Phaser-compatible JSON |
| `forge_bpy.py` | Shared camera, lighting, rendering, image and atlas helpers |
| `export_glb.py` | Opinionated GLB exporter for Ocean Echo hero assets |
| `install_mcp_addon.sh` | Optional BlenderMCP add-on installer for macOS |

## Sprite options

```bash
./blend.sh bake_sprites.py -- --import /path/to/model.glb \
  --out /tmp/model --dirs 8 --frames 1-24 --step 2 --size 96 \
  --elevation 30 --anim walk
```

- `--dirs`: views around the model (default 8).
- `--frames`: one frame or an inclusive range (default `1`).
- `--step`: frame interval (default 1).
- `--size`: final square frame size (default 128).
- `--ss`: supersampling factor before downsampling (default 4).
- `--anim`: frame-name label in the atlas, not an action selector.
- `--object`: optional object filter.
- `--keep-frames`: retain individual PNGs in `<out>_frames/`.

Outputs are `<out>.png` and `<out>.json`. The input scene's animation is
sampled at the requested frames. Lighting and camera helpers fit the model;
inspect the results at the intended in-game size.

For previews, `--size` sets each tile size (default 512), and
`--background transparent` preserves transparency instead of the dark backdrop.

## GLB export

`export_glb.py` enforces project-specific conventions: selected mesh names use
`hero_` by default, vertex colors use `Col`, and geometry is checked against a
triangle budget. It applies transforms/modifiers and changes the scene for
export. Run it on a saved copy; it is not a generic scene-preserving exporter.

```bash
./blend.sh export_glb.py --blend /path/to/hero.blend -- \
  --out /tmp/hero.glb --budget 3000 --select hero_
```

## Optional interactive BlenderMCP

The headless tools do not need MCP. On macOS, `./install_mcp_addon.sh` downloads
a pinned BlenderMCP revision, verifies SHA-256 and asks before installing and
enabling it in Blender's user preferences. It requires `curl` and `shasum`.
The GUI connection and MCP client must be configured separately; follow the
installer's output. Only enable this local code-execution service for clients
you trust.

## Limitations

Render appearance depends on Blender version, renderer and graphics hardware;
headless execution does not guarantee bit-identical images across machines.
Alpha-aware downsampling avoids dark sprite fringes. Blender image pixels use
bottom-up coordinates; use the shared image helpers when adding tools.

Blender rendering is not exercised by the GitHub CI workflow. Include your
Blender version and a small reproduction when reporting rendering problems.

[MIT license](../LICENSE) · [Contributing](../CONTRIBUTING.md)
