"""Prepare the Fern Room salon scene as a configurable product.

Input is the scene's static presentation export ("Fern Room - Game.glb").
Every mesh is split by material, then regrouped by configurator slot:

  a        oxblood leather and its welt (both chairs)   → selectable upholstery
  b        oiled walnut (station, armrests, brush)      → selectable veneer
  mirror, tube_light  given the configurator's mirror and emissive materials
  keep_NN  everything else, one object per material, keeping the authored
           glass, steel, ceramic, foliage and lighting materials untouched

Run headless from the repo root:
    blender --background --factory-startup --python tools/prepare-scene.py -- "<path>/Fern Room - Game.glb"
Output: public/assets/fern_room/model.glb
"""

import os
import re
import sys

import bpy

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "public", "assets", "fern_room", "model.glb")
SRC = sys.argv[sys.argv.index("--") + 1]

# Parts the configurator gives a dedicated material by name: a true planar-style
# mirror and an emissive tube light. Everything else keeps its authored material.
PART_NAMES = [
    (re.compile(r"silvered optical glass", re.I), "mirror"),
    (re.compile(r"opaline tube", re.I), "tube_light"),
]

SLOT_RULES = [
    (re.compile(r"oxblood leather|leather welt", re.I), "a"),
    (re.compile(r"oiled american walnut", re.I), "b"),
]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for obj in meshes:
    # Instanced chairs share mesh data; give each its own copy before splitting.
    obj.data = obj.data.copy()
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")

groups = {}
keep_ids = {}
for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
    used = sorted({obj.data.materials[p.material_index].name for p in obj.data.polygons})
    if not used:
        continue
    name = used[0]
    slot = next((s for rx, s in SLOT_RULES if rx.search(name)), None)
    if slot is None:
        slot = next((n for rx, n in PART_NAMES if rx.search(name)), None)
    if slot is None:
        slot = keep_ids.setdefault(name, f"keep_{len(keep_ids) + 1:02d}")
    groups.setdefault(slot, []).append(obj)

# Flatten parents so joins keep world transforms.
for obj in bpy.data.objects:
    if obj.parent:
        mw = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = mw

for slot, objs in groups.items():
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    joined = bpy.context.active_object
    joined.name = slot
    joined.data.name = slot
    # Joined parts may carry several material slots; keep one material per part.
    mats = {joined.data.materials[p.material_index].name for p in joined.data.polygons}
    if slot in ("a", "b"):
        # Prefer the textured material (the leather, not its plain welt).
        used_mats = [joined.data.materials[i] for i in sorted({p.material_index for p in joined.data.polygons})]
        textured = [m for m in used_mats if m.use_nodes and any(n.type == "TEX_IMAGE" for n in m.node_tree.nodes)]
        keep = (textured or used_mats)[0]
        joined.data.materials.clear()
        joined.data.materials.append(keep)
        for p in joined.data.polygons:
            p.material_index = 0
    print(f"{slot}: {len(objs)} pieces, {len(joined.data.polygons)} faces, materials {sorted(mats)}")

for obj in [o for o in bpy.data.objects if o.type != "MESH"]:
    bpy.data.objects.remove(obj)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_draco_mesh_compression_enable=True,
    export_image_format="AUTO",
    export_yup=True,
)
print("exported", OUT, os.path.getsize(OUT))
