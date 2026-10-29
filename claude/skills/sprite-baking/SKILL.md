---
name: sprite-baking
description: "Bake 2D sprites and sprite sheets from Blender 3D models: isometric views, 8/16 directions, animation frames, transparent backgrounds and a Phaser 3 atlas with JSON. Use for 2D game characters, buildings, vehicles, walk animations, isometric tiles or assets without an artist, when building primitives is cheaper than drawing by hand. Tool: tools/blender-kit."
---

# Sprite Baking

3D model → sprite atlas. Build a model once to get consistent assets across
all directions, frames and views without redrawing them.

Tool: `tools/blender-kit/`. Blender 5.1.1 is installed at `/Applications/Blender.app`.

## Quick start

```bash
cd tools/blender-kit

# Demo model: a primitive robot with a walk animation
./blend.sh demo_robot.py -- --out /tmp/robot.blend

# 8 directions × 8 frames, isometric, 96px
./blend.sh bake_sprites.py --blend /tmp/robot.blend -- \
  --out assets/robot --anim walk --dirs 8 --frames 1-24 --step 3 --size 96 --elevation 30

# Inspect the model: four views in one PNG
./blend.sh render_preview.py --blend /tmp/robot.blend -- --out /tmp/preview.png
```

Output: `assets/robot.png` + `assets/robot.json` (`this.load.atlas()` format).

## bake_sprites.py options

| Option | Meaning |
|---|---|
| `--import file.glb` | import GLB/FBX/OBJ instead of loading a `.blend` |
| `--object Name` | render one object or collection |
| `--dirs 8` | directions around the model; `1` means one view |
| `--elevation 30` | 30 = isometric, 0 = side view, 90 = top view |
| `--frames 1-24 --step 3` | animation frames to sample |
| `--size 96 --ss 3` | final frame size and supersampling factor |
| `--quantize 8` | pixel-art effect: color levels per channel and binary alpha |
| `--anim walk` | atlas frame-name prefix |
| `--keep-frames` | retain individual PNGs |

## Important details

- **Use an orthographic camera** (the script creates one). Perspective makes
  sprite dimensions inconsistent between directions, so a turning character
  appears to expand and shrink.
- **Supersampling cleans up edges.** Rendering at 3–4× and applying a box filter
  produces a clean outline; direct 96px rendering looks jagged. Downsampling
  premultiplies alpha to avoid glowing edge halos.
- **Direction 0 puts the camera on +X.** Subsequent directions advance clockwise
  through `--start-angle`. In-game:
  `frame = Math.round(angle / (2π/dirs)) % dirs`.
- **Lights are added automatically** when the scene has none, avoiding a black
  silhouette.
- **Use at least 8 directions for movement**, or 16 for a large character whose
  turning is conspicuous. One direction can be enough for top or side views.
- Strict pixel art does not emerge automatically from 3D. `--quantize` gives
  stylization, but genuine pixel art requires manual cleanup. Clean low-poly
  and isometric renders can be ready to use directly.

## Phaser 3 integration

```js
this.load.atlas('robot', 'assets/robot.png', 'assets/robot.json');

// meta.forge.animations already groups frame lists by direction
const meta = this.cache.json.get('robot').meta.forge;
Object.entries(meta.animations).forEach(([key, frames]) => {
  this.anims.create({ key, frames: frames.map(f => ({ key: 'robot', frame: f })), frameRate: 12, repeat: -1 });
});
sprite.play('walk_d2');
```

## When to choose another approach

- For one static icon, drawing or generating it is quicker (`imagen` skill).
- A hand-drawn 2D game may clash visually with a 3D render.
- If an asset is needed immediately and quality is unimportant, setting up a
  Blender scene costs more than a one-off drawing.

## Related tools

- Blender modeling and 5.x API pitfalls → `blender-hardsurface` skill
- In-game asset inspection → `game-forge` (`forge shots` + `game-art-critic`)
- Raster generation without 3D → `imagen` skill
