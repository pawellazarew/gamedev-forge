"""
Build a simple robot from primitives with a walk animation as a test model
for bake_sprites.py and render_preview.py.

    ./blend.sh demo_robot.py -- --out /tmp/robot.blend
"""
import os
import sys
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Vector
from forge_bpy import argv, parse

DEFAULTS = {'out': 'robot.blend', 'frames': 24}


def mat(name, rgb, metallic=0.8, rough=0.35, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = rough
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emit
    return m


def box(name, size, loc, material):
    # primitive_cube_add(size=1) creates a unit cube, so scale equals dimensions
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = Vector(size)
    o.data.materials.append(material)
    return o


def main():
    a = parse(argv(), DEFAULTS)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    steel = mat('steel', (0.42, 0.45, 0.5))
    accent = mat('accent', (0.85, 0.35, 0.12), metallic=0.3, rough=0.5)
    glow = mat('glow', (0.2, 0.9, 1.0), metallic=0.0, rough=0.2, emit=6.0)

    root = bpy.data.objects.new('robot', None)
    bpy.context.scene.collection.objects.link(root)

    parts = [
        box('torso', (0.7, 0.45, 0.9), (0, 0, 1.25), steel),
        box('head', (0.42, 0.4, 0.36), (0, 0, 1.9), steel),
        box('visor', (0.3, 0.05, 0.12), (0, -0.2, 1.93), glow),
        box('pack', (0.5, 0.2, 0.6), (0, 0.3, 1.35), accent),
    ]
    arms = [box('arm_l', (0.18, 0.18, 0.75), (-0.48, 0, 1.3), accent),
            box('arm_r', (0.18, 0.18, 0.75), (0.48, 0, 1.3), accent)]
    legs = [box('leg_l', (0.22, 0.24, 0.85), (-0.2, 0, 0.42), steel),
            box('leg_r', (0.22, 0.24, 0.85), (0.2, 0, 0.42), steel)]

    for o in parts + arms + legs:
        o.parent = root

    # walk: legs and arms swing in opposite phases
    n = int(a['frames'])
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, n
    for f in range(1, n + 1):
        phase = 2 * math.pi * (f - 1) / n
        scene.frame_set(f)
        for i, leg in enumerate(legs):
            leg.rotation_euler.x = math.sin(phase + i * math.pi) * 0.5
            leg.keyframe_insert('rotation_euler')
        for i, arm in enumerate(arms):
            arm.rotation_euler.x = -math.sin(phase + i * math.pi) * 0.4
            arm.keyframe_insert('rotation_euler')
        root.location.z = abs(math.sin(phase * 2)) * 0.05
        root.keyframe_insert('location')

    scene.frame_set(1)
    out = os.path.abspath(a['out'])
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out)
    print(f'[forge] saved: {out} ({n} animation frames)')


main()
