"""
3D model to a sprite sheet for a 2D game.

    ./blend.sh bake_sprites.py --blend ship.blend -- --out assets/ship --dirs 8 --size 128
    ./blend.sh bake_sprites.py -- --import robot.glb --out assets/robot \
        --dirs 8 --frames 1-24 --step 2 --size 96 --elevation 30 --anim walk

Output: <out>.png (atlas) + <out>.json (Phaser atlas); optional raw PNGs in <out>_frames/.
"""
import os
import sys
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from forge_bpy import (argv, parse, import_asset, target_objects, bounds, setup_camera,
                       ensure_lights, setup_render, render_to, load_rgba, save_rgba,
                       downsample, quantize, pack_atlas, write_phaser_atlas)

DEFAULTS = {
    'out': 'sprites',
    'import': '',
    'object': '',
    'anim': 'idle',      # animation label in the atlas
    'dirs': 8,           # directions around the model; 1 = one view
    'start_angle': 0.0,  # 0 degrees = camera on the +X side
    'elevation': 30.0,   # 30 = isometric, 0 = side view, 90 = top view
    'frames': '1',       # '1' or '1-24'
    'step': 1,
    'size': 128,         # final frame size
    'ss': 4,             # supersampling: render at size*ss, then downsample
    'samples': 32,
    'quantize': 0,       # color levels per channel; 0 = disabled
    'cols': 0,
    'keep_frames': False,
}


def frame_range(spec, step):
    if '-' in str(spec):
        a, b = str(spec).split('-')
        return list(range(int(a), int(b) + 1, step))
    return [int(spec)]


def main():
    a = parse(argv(), DEFAULTS)
    out_base = os.path.abspath(a['out'])
    os.makedirs(os.path.dirname(out_base) or '.', exist_ok=True)
    frames_dir = out_base + '_frames'
    os.makedirs(frames_dir, exist_ok=True)

    if a['import']:
        import_asset(os.path.abspath(a['import']))

    objects = target_objects(a['object'] or None)
    center, radius, lo, hi = bounds(objects)
    lit = ensure_lights(center, radius)
    engine = setup_render(int(a['size']) * int(a['ss']), samples=int(a['samples']))

    frames = frame_range(a['frames'], int(a['step']))
    dirs = int(a['dirs'])
    scene = bpy.context.scene

    print(f'[forge] engine {engine}, objects {len(objects)}, radius {radius:.3f}, '
          f'lights {"added" if lit else "from scene"}')
    print(f'[forge] {dirs} directions × {len(frames)} frames = {dirs * len(frames)} renders')

    tiles = []
    for d in range(dirs):
        azimuth = float(a['start_angle']) + (360.0 / dirs) * d
        setup_camera(center, radius, azimuth, float(a['elevation']))
        for fi, f in enumerate(frames):
            scene.frame_set(f)
            name = f"{a['anim']}_d{d}_{fi:03d}" if dirs > 1 else f"{a['anim']}_{fi:03d}"
            path = os.path.join(frames_dir, name + '.png')
            render_to(path)
            img = load_rgba(path)
            img = downsample(img, int(a['ss']))
            img = quantize(img, int(a['quantize']))
            tiles.append((name, img))
            print(f'[forge] {name} ✓')

    atlas, coords, size = pack_atlas(tiles, cols=int(a['cols']) or None)
    png = save_rgba(atlas, out_base + '.png')

    animations = {}
    for name, _ in tiles:
        key = name.rsplit('_', 1)[0]
        animations.setdefault(key, []).append(name)

    write_phaser_atlas(out_base + '.json', os.path.basename(png), coords, size, extra={
        'animations': animations,
        'dirs': dirs,
        'elevation': float(a['elevation']),
        'frameSize': int(a['size']),
        'source': a['import'] or bpy.data.filepath,
    })

    if not a['keep_frames']:
        for name, _ in tiles:
            try:
                os.remove(os.path.join(frames_dir, name + '.png'))
            except OSError:
                pass
        try:
            os.rmdir(frames_dir)
        except OSError:
            pass

    print(f'[forge] atlas: {png} ({size[0]}×{size[1]})')
    print(f'[forge] metadata:  {out_base}.json — {len(animations)} animations, {len(tiles)} frames')
    print('[forge] Phaser: this.load.atlas("%s", "%s.png", "%s.json")'
          % (os.path.basename(out_base), os.path.basename(out_base), os.path.basename(out_base)))


main()
