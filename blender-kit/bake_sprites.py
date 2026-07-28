"""
3D-модель → спрайтшит для 2D-игры.

    ./blend.sh bake_sprites.py --blend ship.blend -- --out assets/ship --dirs 8 --size 128
    ./blend.sh bake_sprites.py -- --import robot.glb --out assets/robot \
        --dirs 8 --frames 1-24 --step 2 --size 96 --elevation 30 --anim walk

Выход: <out>.png (атлас) + <out>.json (Phaser atlas) + <out>/frames/*.png (сырьё).
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
    'anim': 'idle',      # имя анимации в атласе
    'dirs': 8,           # направлений по кругу; 1 = один ракурс
    'start_angle': 0.0,  # 0° = камера со стороны +X
    'elevation': 30.0,   # 30 — изометрия, 0 — вид сбоку, 90 — сверху
    'frames': '1',       # '1' или '1-24'
    'step': 1,
    'size': 128,         # итоговый размер кадра
    'ss': 4,             # суперсэмплинг: рендер в size*ss, потом даунсемпл
    'samples': 32,
    'quantize': 0,       # уровней цвета на канал; 0 = выкл
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

    print(f'[forge] движок {engine}, объектов {len(objects)}, радиус {radius:.3f}, '
          f'свет {"добавлен" if lit else "из сцены"}')
    print(f'[forge] {dirs} направлений × {len(frames)} кадров = {dirs * len(frames)} рендеров')

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

    print(f'[forge] атлас: {png} ({size[0]}×{size[1]})')
    print(f'[forge] мета:  {out_base}.json — {len(animations)} анимаций, {len(tiles)} кадров')
    print('[forge] Phaser: this.load.atlas("%s", "%s.png", "%s.json")'
          % (os.path.basename(out_base), os.path.basename(out_base), os.path.basename(out_base)))


main()
