"""
Deterministic Ocean Echo hero export: .blend to .glb.

    ./blend.sh export_glb.py --blend assets/heroes/boat/boat.blend -- \
        --out assets/heroes/boat/boat.raw.glb --budget 1000 [--select hero_]

Applies transforms and modifiers, uses flat shading, centers the origin at the
base, checks for one material and vertex colors, joins by material and exports
GLB (+Y up, COLOR_0 from the active Color Attribute, underscore-prefixed attributes).
Exits nonzero when conventions are violated (section 2 of echo-blender-prop).
"""
import sys
import bpy
from mathutils import Vector

PALETTE_MAT = 'EchoVertex'
COLOR_ATTR = 'Col'


def argv():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else []


def parse(args):
    opts = {'out': 'hero.glb', 'budget': 3000, 'select': 'hero_'}
    it = iter(args)
    for k in it:
        if k.startswith('--'):
            opts[k[2:]] = next(it, '')
    opts['budget'] = int(opts['budget'])
    return opts


def fail(msg):
    print(f'[export_glb] FAIL: {msg}', file=sys.stderr)
    sys.exit(2)


def mesh_objects(prefix):
    objs = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith(prefix)]
    if not objs:
        fail(f'no MESH objects with prefix {prefix!r}')
    return objs


def ensure_material(objs):
    mat = bpy.data.materials.get(PALETTE_MAT) or bpy.data.materials.new(PALETTE_MAT)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf and not any(n.type == 'VERTEX_COLOR' for n in nt.nodes):
        vc = nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = COLOR_ATTR
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)


def ensure_vertex_colors(objs):
    for o in objs:
        attrs = o.data.color_attributes
        if COLOR_ATTR not in attrs:
            fail(f'{o.name}: missing Color Attribute {COLOR_ATTR!r} (CORNER/BYTE_COLOR)')
        attrs.active_color = attrs[COLOR_ATTR]
        attrs.render_color_index = attrs.find(COLOR_ATTR)


def apply_all(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)
        o.data.shade_flat()


def join(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def origin_to_base(o):
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    base = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for v in o.data.vertices:
        v.co -= base
    o.location = (0, 0, 0)
    return hi - lo


def main():
    a = parse(argv())
    objs = mesh_objects(a['select'])
    apply_all(objs)
    ensure_vertex_colors(objs)
    ensure_material(objs)
    hero = join(objs)
    hero.name = 'hero'
    size = origin_to_base(hero)
    hero.data.calc_loop_triangles()
    tris = len(hero.data.loop_triangles)
    if tris > a['budget']:
        fail(f'{tris} tris > budget {a["budget"]}')
    if len(hero.data.materials) != 1:
        fail(f'{len(hero.data.materials)} materials; exactly one required')
    bpy.ops.object.select_all(action='DESELECT')
    hero.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=a['out'],
        export_format='GLB',
        use_selection=True,
        export_apply=True,           # apply remaining modifiers
        export_yup=True,             # +Y up for three.js
        export_vertex_color='ACTIVE',  # COLOR_0 from the active Color Attribute (Blender >= 4.2)
        export_all_vertex_colors=False,
        export_attributes=True,      # custom attributes prefixed with '_'
        export_normals=True,
        export_texcoords=False,
        export_materials='EXPORT',
        export_animations=False,
        export_skins=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
    )
    print(f'[export_glb] OK {a["out"]} tris={tris} '
          f'size={size.x:.2f}x{size.y:.2f}x{size.z:.2f} m')


if __name__ == '__main__':
    main()
