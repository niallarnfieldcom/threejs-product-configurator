"""Generate the sample product GLBs from scratch in Blender.

Every product is built from primitives in this script, so the catalogue ships
with no third-party models. Each product's parts are joined per material slot
and named after the slot ("a", "b", "black_metal", "chrome"), which is how the
configurator maps meshes to configurable finishes.

Run headless from the repo root:
    blender --background --factory-startup --python tools/generate-sample-products.py
Output: public/assets/<product-id>/model.glb
"""

import math
import os
import sys

import bpy
from mathutils import Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "public", "assets")


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    return mat


def finish(obj, slot, bevel=0.0, segments=3, smooth=True):
    """Tag a part with its slot; optional rounded edges."""
    obj["slot"] = slot
    if bevel > 0:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


def box(slot, size, loc, bevel=0.0, rot=(0, 0, 0), segments=3):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, slot, bevel, segments, smooth=bevel > 0)


def cylinder(slot, radius, depth, loc, rot=(0, 0, 0), verts=40, bevel=0.0, radius2=None):
    if radius2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=radius, radius2=radius2, depth=depth, location=loc, rotation=rot)
    return finish(bpy.context.active_object, slot, bevel)


def torus(slot, major, minor, loc):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, major_segments=64, minor_segments=16)
    return finish(bpy.context.active_object, slot)


def join_by_slot():
    """Apply modifiers, UV-unwrap and join every part into one object per slot."""
    slots = {}
    for obj in list(bpy.data.objects):
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for mod in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        # 1 UV unit per metre, so material `repeat` values mean the same on every product.
        bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        slots.setdefault(obj["slot"], []).append(obj)
    for slot, objs in slots.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objs:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        joined = bpy.context.active_object
        joined.name = slot
        joined.data.name = slot
        joined.data.materials.clear()
        joined.data.materials.append(material(slot))


def export(product_id):
    folder = os.path.join(OUT, product_id)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "model.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_draco_mesh_compression_enable=True,
        export_materials="EXPORT",
        export_yup=True,
    )
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects for p in o.data.polygons)
    print(f"exported {product_id}: {', '.join(sorted(o.name for o in bpy.data.objects))}; ~{tris} tris -> {path}")


# ---------------------------------------------------------------- products ---

def lounge_chair():
    w, d = 0.78, 0.80
    for x in (-w / 2 + 0.07, w / 2 - 0.07):
        for y in (-d / 2 + 0.08, d / 2 - 0.08):
            tilt = 0.12 if y > 0 else -0.12
            cylinder("black_metal", 0.022, 0.22, (x * 1.04, y * 1.04, 0.11), rot=(tilt, 0, 0), radius2=0.014)
    box("b", (w, d, 0.14), (0, 0, 0.29), bevel=0.03)                       # seat frame
    box("a", (w - 0.18, d - 0.12, 0.13), (0, 0.04, 0.42), bevel=0.05, segments=5)  # seat cushion
    for x in (-w / 2 + 0.06, w / 2 - 0.06):                                 # arms
        box("b", (0.12, d, 0.30), (x, 0, 0.47), bevel=0.05, segments=4)
    box("b", (w, 0.14, 0.52), (0, -d / 2 + 0.07, 0.58), bevel=0.05, rot=(-0.17, 0, 0), segments=4)  # back shell
    box("a", (w - 0.18, 0.12, 0.40), (0, -d / 2 + 0.17, 0.66), bevel=0.05, rot=(-0.2, 0, 0), segments=5)  # back cushion


def bar_stool():
    cylinder("a", 0.20, 0.08, (0, 0, 0.74), verts=64, bevel=0.03)            # seat pad
    cylinder("chrome", 0.17, 0.02, (0, 0, 0.69), verts=64)                    # seat pan
    cylinder("chrome", 0.025, 0.66, (0, 0, 0.36))                             # column
    cylinder("chrome", 0.22, 0.02, (0, 0, 0.012), verts=64, bevel=0.008)      # floor disc
    torus("chrome", 0.19, 0.011, (0, 0, 0.30))                                # foot ring
    for angle in (0, 120, 240):                                               # ring spokes
        a = math.radians(angle)
        cylinder("chrome", 0.007, 0.17, (math.cos(a) * 0.095, math.sin(a) * 0.095, 0.30), rot=(0, math.pi / 2, a), verts=12)


def sofa():
    w, d = 1.70, 0.88
    for x in (-w / 2 + 0.06, w / 2 - 0.06):
        for y in (-d / 2 + 0.08, d / 2 - 0.08):
            cylinder("black_metal", 0.02, 0.14, (x, y, 0.07), radius2=0.016)
    box("b", (w, d, 0.24), (0, 0, 0.26), bevel=0.03)                         # base
    for x in (-w / 2 + 0.08, w / 2 - 0.08):                                  # arms
        box("b", (0.16, d, 0.34), (x, 0, 0.55), bevel=0.06, segments=4)
    box("b", (w - 0.32, 0.16, 0.44), (0, -d / 2 + 0.08, 0.60), bevel=0.05)   # back
    inner = w - 0.34
    for i in (-1, 1):                                                         # seat + back cushions
        cx = i * inner / 4
        box("a", (inner / 2 - 0.02, d - 0.24, 0.14), (cx, 0.05, 0.45), bevel=0.05, segments=5)
        box("a", (inner / 2 - 0.03, 0.16, 0.42), (cx, -d / 2 + 0.22, 0.68), bevel=0.06, rot=(-0.12, 0, 0), segments=5)


def sideboard():
    w, d, h = 1.60, 0.45, 0.58
    lift = 0.17
    for x in (-w / 2 + 0.08, w / 2 - 0.08):
        for y in (-d / 2 + 0.06, d / 2 - 0.06):
            box("black_metal", (0.025, 0.025, lift), (x, y, lift / 2))
    box("a", (w, d, h), (0, 0, lift + h / 2), bevel=0.006, segments=2)       # carcass
    door = (w - 0.04) / 3
    for i in range(3):                                                        # door fronts
        cx = -w / 2 + 0.02 + door * (i + 0.5)
        box("b", (door - 0.008, 0.02, h - 0.04), (cx, d / 2 + 0.01, lift + h / 2), bevel=0.003, segments=2)
        box("chrome", (0.012, 0.025, 0.16), (cx + door / 2 - 0.05, d / 2 + 0.032, lift + h / 2), bevel=0.004)


def desk():
    w, d, top = 1.40, 0.70, 0.73
    box("a", (w, d, 0.03), (0, 0, top + 0.015), bevel=0.004, segments=2)    # top
    box("b", (0.42, d - 0.06, 0.56), (w / 2 - 0.25, 0, top - 0.29), bevel=0.004, segments=2)  # drawer pedestal
    for z in (top - 0.12, top - 0.31, top - 0.49):                            # drawer handles
        box("chrome", (0.16, 0.012, 0.012), (w / 2 - 0.25, d / 2 - 0.02, z), bevel=0.003)
    # sled frame on the open end: two uprights + a foot and a top rail
    x = -w / 2 + 0.06
    for y in (-d / 2 + 0.06, d / 2 - 0.06):
        box("black_metal", (0.03, 0.03, top), (x, y, top / 2))
    box("black_metal", (0.03, d - 0.06, 0.03), (x, 0, 0.015))
    box("black_metal", (w - 0.5, 0.03, 0.05), (-0.17, -d / 2 + 0.06, top - 0.04))  # modesty rail


PRODUCTS = {
    "lounge_chair": lounge_chair,
    "bar_stool": bar_stool,
    "sofa": sofa,
    "sideboard": sideboard,
    "desk": desk,
}

if __name__ == "__main__":
    wanted = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else list(PRODUCTS)
    turn = Matrix.Rotation(math.pi, 4, "Z")
    for pid in wanted:
        reset()
        PRODUCTS[pid]()
        # Products are modelled with the back towards -Y. Turn them so the front
        # faces Blender's -Y, which exports as the viewer's +Z (towards the camera).
        for obj in bpy.data.objects:
            obj.matrix_world = turn @ obj.matrix_world
        join_by_slot()
        export(pid)
