// Applies finishes to the configurable slots.
//
// Each slot keeps the material it was authored with (roughness, clearcoat and
// texture all come from the model). The "original" finish restores it exactly.
// A colour finish swaps the texture for a neutral grain map made from the
// authored one, then tints it, so a new leather colour still has the hide's
// mottling and a new timber still has the board's figure.

import * as THREE from "three";

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Reduce a colour texture to a tint-ready grain map (luminance, normalised to its highlights). */
function makeGrainMap(source) {
  const image = source?.image;
  if (!image) return null;
  const size = Math.min(1024, image.width || 1024);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);
  const pixels = ctx.getImageData(0, 0, size, size);
  const d = pixels.data;
  const lum = new Float32Array(size * size);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < lum.length; i++) {
    const o = i * 4;
    const l = 0.2126 * srgbToLinear(d[o] / 255) + 0.7152 * srgbToLinear(d[o + 1] / 255) + 0.0722 * srgbToLinear(d[o + 2] / 255);
    lum[i] = l;
    histogram[Math.min(255, Math.round(linearToSrgb(l) * 255))]++;
  }
  // Normalise to the 85th percentile so the tint colour reads as chosen and
  // only the darker grain and creases pull it down.
  let seen = 0, level = 255;
  for (let v = 0; v < 256; v++) { seen += histogram[v]; if (seen >= lum.length * 0.85) { level = v; break; } }
  const white = Math.max(1e-4, srgbToLinear(level / 255));
  for (let i = 0; i < lum.length; i++) {
    const v = Math.round(linearToSrgb(Math.min(1, lum[i] / white)) * 255);
    const o = i * 4;
    d[o] = d[o + 1] = d[o + 2] = v;
    d[o + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  const grain = new THREE.CanvasTexture(canvas);
  grain.colorSpace = THREE.SRGBColorSpace;
  grain.flipY = source.flipY;
  grain.wrapS = source.wrapS;
  grain.wrapT = source.wrapT;
  grain.repeat.copy(source.repeat);
  grain.offset.copy(source.offset);
  grain.channel = source.channel;
  grain.anisotropy = source.anisotropy;
  grain.name = `${source.name || "texture"}-grain`;
  return grain;
}

/**
 * Take over the configurable slots of a loaded model.
 * `slotMeshes` maps slot id → the mesh whose material is that slot.
 */
export function createFinishes(slotMeshes, { anisotropy = 8 } = {}) {
  const slots = new Map();
  for (const [id, mesh] of Object.entries(slotMeshes)) {
    if (!mesh) continue;
    const material = mesh.material;
    if (material.map) material.map.anisotropy = anisotropy;
    slots.set(id, {
      material,
      grain: null,
      authored: {
        map: material.map,
        color: material.color.clone(),
        roughness: material.roughness,
        clearcoat: material.clearcoat ?? 0,
        sheen: material.sheen ?? 0,
      },
    });
  }

  return {
    has: (slotId) => slots.has(slotId),
    /** Apply a finish from scene-config. Returns false if the slot is unknown. */
    apply(slotId, finish) {
      const slot = slots.get(slotId);
      if (!slot || !finish) return false;
      const { material, authored } = slot;
      if (finish.original) {
        material.map = authored.map;
        material.color.copy(authored.color);
      } else {
        if (!slot.grain && authored.map) slot.grain = makeGrainMap(authored.map);
        material.map = slot.grain;
        material.color.set(finish.color);
      }
      material.roughness = finish.roughness ?? authored.roughness;
      if ("clearcoat" in material) material.clearcoat = finish.clearcoat ?? authored.clearcoat;
      if ("sheen" in material) material.sheen = finish.sheen ?? authored.sheen;
      material.needsUpdate = true;
      return true;
    },
  };
}
