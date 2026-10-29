"""
Shared helpers for headless Blender scripts: arguments after `--`,
scene setup, orbiting orthographic camera, lighting, rendering and atlas packing.

Uses only bpy/numpy/mathutils bundled with Blender; no external Python
packages need to be installed in its Python environment.
"""
import sys
import os
import json
import math

import bpy
import numpy as np
from mathutils import Vector


def argv():
    """Arguments after `--`; Blender consumes everything before it."""
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def parse(args, defaults):
    """Parse `--key value` / `--flag` arguments over a defaults dictionary."""
    out = dict(defaults)
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith('--'):
            key = a[2:].replace('-', '_')
            nxt = args[i + 1] if i + 1 < len(args) else None
            if nxt is None or nxt.startswith('--'):
                out[key] = True
                i += 1
            else:
                cur = defaults.get(key)
                out[key] = type(cur)(nxt) if isinstance(cur, (int, float)) and not isinstance(cur, bool) else nxt
                i += 2
        else:
            i += 1
    return out


# --- scene ---

def import_asset(path):
    """Import .glb/.gltf/.fbx/.obj into the current scene."""
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        raise SystemExit(f'Unsupported import format: {ext}')


def target_objects(name=None):
    """Render a named object/collection or all meshes in the scene."""
    if name:
        if name in bpy.data.collections:
            return [o for o in bpy.data.collections[name].all_objects if o.type == 'MESH']
        if name in bpy.data.objects:
            obj = bpy.data.objects[name]
            return [obj] + [c for c in obj.children_recursive if c.type == 'MESH']
        raise SystemExit(f'Object or collection not found: "{name}"')
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def bounds(objects):
    """Center and radius of the bounding sphere in world coordinates."""
    if not objects:
        raise SystemExit('The scene has no meshes to render')
    pts = []
    for o in objects:
        for corner in o.bound_box:
            pts.append(o.matrix_world @ Vector(corner))
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    lo = Vector((min(xs), min(ys), min(zs)))
    hi = Vector((max(xs), max(ys), max(zs)))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 1e-4)
    return center, radius, lo, hi


def setup_camera(center, radius, azimuth_deg, elevation_deg, margin=1.08):
    """Orthographic camera looking at the object center from an azimuth and elevation.

    Orthographic projection keeps sprite sizes consistent across directions;
    perspective makes the object appear to expand and shrink as it turns.
    """
    cam_data = bpy.data.cameras.get('forge_cam') or bpy.data.cameras.new('forge_cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = radius * 2 * margin
    cam_data.clip_start = 0.01
    cam_data.clip_end = radius * 20

    cam = bpy.data.objects.get('forge_cam')
    if cam is None:
        cam = bpy.data.objects.new('forge_cam', cam_data)
        bpy.context.scene.collection.objects.link(cam)
    cam.data = cam_data

    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    direction = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
    cam.location = center + direction * (radius * 6)
    cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()

    bpy.context.scene.camera = cam
    return cam


def ensure_lights(center, radius, strength=1.0):
    """Three-point lighting when the artist has not provided lights.

    An unlit sprite is a black silhouette, leading reviewers to diagnose the wrong defect.
    """
    if any(o.type == 'LIGHT' for o in bpy.context.scene.objects):
        return False
    specs = [
        ('key', (1.2, -1.4, 1.6), 'AREA', 900 * strength),
        ('fill', (-1.6, -0.6, 0.7), 'AREA', 260 * strength),
        ('rim', (-0.4, 1.7, 1.2), 'AREA', 500 * strength),
    ]
    for name, offset, kind, power in specs:
        data = bpy.data.lights.new(f'forge_{name}', type=kind)
        data.energy = power * (radius ** 2)
        if kind == 'AREA':
            data.size = radius * 2
        obj = bpy.data.objects.new(f'forge_{name}', data)
        obj.location = center + Vector(offset) * radius * 3
        obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.scene.collection.objects.link(obj)
    return True


def setup_render(size, samples=32, transparent=True, engine=None):
    scene = bpy.context.scene
    # Engine names changed between versions; choose one that exists.
    available = [i.identifier for i in scene.bl_rna.properties['render'].fixed_type.bl_rna
                 .properties['engine'].enum_items]
    if engine and engine in available:
        scene.render.engine = engine
    else:
        for candidate in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
            if candidate in available:
                scene.render.engine = candidate
                break

    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = transparent
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'

    if scene.render.engine == 'CYCLES':
        scene.cycles.samples = samples
    else:
        try:
            scene.eevee.taa_render_samples = samples
        except AttributeError:
            pass
    return scene.render.engine


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


# --- pixel operations ---

def load_rgba(path):
    """PNG to an (h, w, 4) float array in 0..1, rows from top to bottom."""
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(h, w, 4)[::-1]  # Blender stores rows from bottom to top


def save_rgba(arr, path):
    h, w, _ = arr.shape
    img = bpy.data.images.new('forge_out', width=w, height=h, alpha=True)
    img.pixels.foreach_set(arr[::-1].reshape(-1).astype(np.float32))
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    return path


def downsample(arr, factor):
    """Box filter with premultiplied alpha.

    Without premultiplication, transparent pixel colors bleed into visible
    pixels and create halos around sprite edges.
    """
    if factor <= 1:
        return arr
    h, w, _ = arr.shape
    h2, w2 = h // factor, w // factor
    a = arr[:h2 * factor, :w2 * factor].astype(np.float32)
    alpha = a[..., 3:4]
    rgb = a[..., :3] * alpha
    block = lambda x: x.reshape(h2, factor, w2, factor, x.shape[-1]).mean(axis=(1, 3))
    rgb_s = block(rgb)
    a_s = block(alpha)
    out = np.concatenate([np.divide(rgb_s, a_s, out=np.zeros_like(rgb_s), where=a_s > 1e-5), a_s], axis=-1)
    return np.clip(out, 0, 1)


def quantize(arr, levels):
    """Stepped color quantization: a rough but usable pixel-art effect."""
    if not levels or levels <= 1:
        return arr
    rgb = np.round(arr[..., :3] * (levels - 1)) / (levels - 1)
    alpha = (arr[..., 3:4] > 0.5).astype(np.float32)  # binary alpha, no partial transparency
    return np.concatenate([rgb, alpha], axis=-1)


def pack_atlas(frames, cols=None):
    """Equal-sized frame grid to (atlas, frame coordinates)."""
    n = len(frames)
    fh, fw, _ = frames[0][1].shape
    cols = cols or math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    atlas = np.zeros((rows * fh, cols * fw, 4), dtype=np.float32)
    coords = {}
    for i, (name, img) in enumerate(frames):
        r, c = divmod(i, cols)
        atlas[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw] = img
        coords[name] = {'x': c * fw, 'y': r * fh, 'w': fw, 'h': fh}
    return atlas, coords, (cols * fw, rows * fh)


def write_phaser_atlas(json_path, image_name, coords, size, extra=None):
    """Phaser 3 `this.load.atlas()` format (JSON Hash)."""
    data = {
        'frames': {
            name: {
                'frame': box,
                'rotated': False,
                'trimmed': False,
                'spriteSourceSize': {'x': 0, 'y': 0, 'w': box['w'], 'h': box['h']},
                'sourceSize': {'w': box['w'], 'h': box['h']},
            } for name, box in coords.items()
        },
        'meta': {
            'app': 'blender-kit/bake_sprites',
            'image': image_name,
            'format': 'RGBA8888',
            'size': {'w': size[0], 'h': size[1]},
            'scale': '1',
            'forge': extra or {},
        },
    }
    with open(json_path, 'w') as f:
        json.dump(data, f, indent=1)
    return json_path
