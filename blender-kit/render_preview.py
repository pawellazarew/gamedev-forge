"""
Модель → один PNG с четырьмя ракурсами, чтобы агент открыл его через Read
и оценил силуэт, пропорции и детализацию.

    ./blend.sh render_preview.py -- --import ship.glb --out .forge/ship-preview.png
    ./blend.sh render_preview.py --blend ship.blend -- --out preview.png --size 512
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from forge_bpy import (argv, parse, import_asset, target_objects, bounds, setup_camera,
                       ensure_lights, setup_render, render_to, load_rgba, save_rgba, downsample)

DEFAULTS = {
    'out': 'preview.png',
    'import': '',
    'object': '',
    'size': 512,
    'ss': 2,
    'samples': 48,
    'elevation': 20.0,
    'background': 'dark',   # dark | transparent
}

VIEWS = [
    ('3/4 спереди', 35.0, None),
    ('сбоку', 90.0, 0.0),
    ('сверху', 0.0, 85.0),
    ('3/4 сзади', 215.0, None),
]


def main():
    a = parse(argv(), DEFAULTS)
    out = os.path.abspath(a['out'])
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)

    if a['import']:
        import_asset(os.path.abspath(a['import']))

    objects = target_objects(a['object'] or None)
    center, radius, lo, hi = bounds(objects)
    ensure_lights(center, radius)
    setup_render(int(a['size']) * int(a['ss']), samples=int(a['samples']), transparent=True)

    tiles = []
    tmp = out + '.tmp.png'
    for label, az, el in VIEWS:
        setup_camera(center, radius, az, float(a['elevation']) if el is None else el)
        render_to(tmp)
        tiles.append(downsample(load_rgba(tmp), int(a['ss'])))
    try:
        os.remove(tmp)
    except OSError:
        pass

    h, w, _ = tiles[0].shape
    sheet = np.zeros((h * 2, w * 2, 4), dtype=np.float32)
    for i, img in enumerate(tiles):
        r, c = divmod(i, 2)
        sheet[r * h:(r + 1) * h, c * w:(c + 1) * w] = img

    if a['background'] == 'dark':
        # Прозрачный фон на тёмной теме читается как «дыра» — подкладываем холст,
        # иначе критик оценивает не модель, а шахматку вьюера.
        bg = np.zeros_like(sheet)
        bg[..., :3] = 0.06
        bg[..., 3] = 1.0
        alpha = sheet[..., 3:4]
        sheet = np.concatenate([sheet[..., :3] * alpha + bg[..., :3] * (1 - alpha),
                                np.ones_like(alpha)], axis=-1)

    save_rgba(sheet, out)
    size_m = (hi - lo)
    print(f'[forge] превью: {out} ({w * 2}×{h * 2})')
    print(f'[forge] габариты модели: {size_m.x:.2f} × {size_m.y:.2f} × {size_m.z:.2f}')
    print(f'[forge] ракурсы: {", ".join(v[0] for v in VIEWS)}')


main()
