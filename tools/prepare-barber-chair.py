"""Turn Poly Haven's CC0 "Barber Shop Chair 01" into a configurable product.

Source: https://polyhaven.com/a/BarberShopChair_01 (CC0, by Fernando Quinn).
The download is one mesh with one texture atlas. This script splits it into
configurator slots by sampling the atlas under each face:

  a      leather upholstery  → customer-selectable fabric
  b      wood panels         → customer-selectable laminate / veneer
  trim   brass and carving   → keeps the original PBR atlas

The `a` and `b` parts get box-projected UVs (1 unit per metre) so tiling
materials sit at a consistent scale; `trim` keeps the atlas UVs.

Run headless (download the 2K glTF first):
    blender --background --factory-startup --python tools/prepare-barber-chair.py -- <path-to-BarberShopChair_01.gltf>
Output: public/assets/barber_chair/model.glb
"""

import os
import sys

import bmesh
import bpy

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "public", "assets", "barber_chair", "model.glb")
SRC = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
obj = next(o for o in bpy.data.objects if o.type == "MESH")
mat = obj.data.materials[0]

nodes = mat.node_tree.nodes
bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")


def image_for(socket_name):
    """Follow a BSDF input back to its image texture."""
    stack = [l.from_node for l in bsdf.inputs[socket_name].links]
    while stack:
        node = stack.pop()
        if node.type == "TEX_IMAGE":
            return node.image
        for inp in node.inputs:
            stack.extend(l.from_node for l in inp.links)
    return None


def sampler(image):
    w, h = image.size
    px = list(image.pixels)
    def sample(u, v):
        x = min(w - 1, max(0, int((u % 1.0) * w)))
        y = min(h - 1, max(0, int((v % 1.0) * h)))
        i = (y * w + x) * 4
        return px[i], px[i + 1], px[i + 2]
    return sample


diffuse = sampler(image_for("Base Color"))
metal_img = image_for("Metallic")
metal = sampler(metal_img) if metal_img else None


def classify(r, g, b, m):
    # Calibrated on the 2K atlas: leather is dark and neutral-to-blue,
    # wood is mid-brown, and everything light or metallic is brass/carving.
    if m > 0.5:
        return "trim"
    if max(r, g, b) < 0.28 and (r - b) < 0.05:
        return "a"
    if (r - b) > 0.2 and r < 0.65:
        return "b"
    return "trim"


bm = bmesh.new()
bm.from_mesh(obj.data)
uv = bm.loops.layers.uv.active
labels = {}
for face in bm.faces:
    us = [l[uv].uv for l in face.loops]
    cu = sum(p.x for p in us) / len(us)
    cv = sum(p.y for p in us) / len(us)
    # Sample the centre and points two thirds of the way to each corner, then vote.
    points = [(cu, cv)] + [(cu + (p.x - cu) * 0.66, cv + (p.y - cv) * 0.66) for p in us]
    votes = {}
    for u, v in points:
        r, g, b = diffuse(u, v)
        m = metal(u, v)[2] if metal else 0.0   # ARM map: metalness in blue
        label = classify(r, g, b, m)
        votes[label] = votes.get(label, 0) + 1
    labels[face.index] = max(votes, key=votes.get)

# Smooth out single-face speckle: a face takes its neighbours' majority label.
for _ in range(3):
    new = {}
    for face in bm.faces:
        votes = {}
        for edge in face.edges:
            for other in edge.link_faces:
                if other is not face:
                    votes[labels[other.index]] = votes.get(labels[other.index], 0) + 1
        best = max(votes, key=votes.get) if votes else labels[face.index]
        new[face.index] = best if votes.get(best, 0) >= 3 else labels[face.index]
    labels = new
bm.free()

counts = {}
for label in labels.values():
    counts[label] = counts.get(label, 0) + 1
print("face labels:", counts)

# Assign material slots per label, then separate by material.
slot_mats = {}
for label in ("a", "b", "trim"):
    m = mat if label == "trim" else bpy.data.materials.new(label)
    if label != "trim":
        m.use_nodes = True
    if m.name not in [x.name for x in obj.data.materials]:
        obj.data.materials.append(m)
    slot_mats[label] = [x.name for x in obj.data.materials].index(m.name)
for poly in obj.data.polygons:
    poly.material_index = slot_mats[labels[poly.index]]

bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="MATERIAL")
bpy.ops.object.mode_set(mode="OBJECT")

for part in [o for o in bpy.data.objects if o.type == "MESH"]:
    used = {part.data.materials[p.material_index].name for p in part.data.polygons}
    label = "trim" if mat.name in used else next(iter(used))
    part.name = label
    part.data.name = label
    # Keep only the material this part uses.
    keep = part.data.materials[part.data.polygons[0].material_index]
    part.data.materials.clear()
    part.data.materials.append(keep)
    for p in part.data.polygons:
        p.material_index = 0
    if label in ("a", "b"):
        bpy.ops.object.select_all(action="DESELECT")
        part.select_set(True)
        bpy.context.view_layer.objects.active = part
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")

dims = [max(v) - min(v) for v in zip(*[ (o.matrix_world @ c)[:] for o in bpy.data.objects if o.type == "MESH" for c in [__import__("mathutils").Vector(b) for b in o.bound_box]])]
print("parts:", sorted(o.name for o in bpy.data.objects if o.type == "MESH"), "size xyz (m):", [round(d, 3) for d in dims])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_draco_mesh_compression_enable=True,
    export_image_format="JPEG",
    export_yup=True,
)
print("exported", OUT, os.path.getsize(OUT))
