// Material library. Two kinds of entry share one shape:
//
// 1. Textured PBR sets. `maps` values are STEMS: the renderer appends `.ktx2`
//    under `base`; AR export appends `.jpg` under `arBase`.
//      albedo    → map            (sRGB albedo)
//      normal    → normalMap      (OpenGL normals)
//      roughness → roughnessMap   (standalone, linear)
//      arm       → roughnessMap(G) + metalnessMap(B), packed
//      spec      → specularIntensityMap (optional)
// 2. Colour-only finishes: `color`, `roughness`, `metalness`, `sheen`, no maps.
//    Useful when a catalogue specifies finishes as exact colours.
//
// `category` decides which slots a material can go on: "upholstery" for fabric
// slots, "laminate" for hard surfaces.

import { ACG_MATERIALS } from "./pbr-materials-acg.js";

const DIR = "assets/materials";

// Textured sets from Poly Haven (CC0, https://polyhaven.com).
const POLY_HAVEN = [
  {
    id: "pbr_velour", name: "Velour Velvet", category: "upholstery",
    thumb: `${DIR}/velour_velvet/thumb.jpg`,
    base: `${DIR}/velour_velvet/ktx2`,
    arBase: `${DIR}/velour_velvet/2k`,
    maps: { albedo: "velour_velvet_diff_2k", normal: "velour_velvet_nor_gl_2k", arm: "velour_velvet_arm_2k", spec: "velour_velvet_spec_ior_2k" },
    repeat: 2.4, normalScale: 0.9, sheen: 0.6, sheenRoughness: 0.45,
  },
  {
    id: "pbr_leather", name: "Leather 02", category: "upholstery",
    thumb: `${DIR}/fabric_leather_02/thumb.jpg`,
    base: `${DIR}/fabric_leather_02/ktx2`,
    arBase: `${DIR}/fabric_leather_02/2k`,
    maps: { albedo: "fabric_leather_02_diff_2k", normal: "fabric_leather_02_nor_gl_2k", roughness: "fabric_leather_02_rough_2k" },
    repeat: 2.4, normalScale: 1.0, metalness: 0,
  },
];

// Colour-only sample finishes. Thumbnails reuse a neutral texture; the swatch
// UI tints from `color`.
const colour = (id, name, category, color, roughness, sheen = 0) => ({
  id, name, category, thumb: `${DIR}/velour_velvet/thumb.jpg`, color, roughness, metalness: 0, sheen,
});
const COLOUR_FINISHES = [
  colour("c_charcoal", "Charcoal", "upholstery", "rgb(46,47,50)", 0.8, 0.3),
  colour("c_oat", "Oat", "upholstery", "rgb(196,182,160)", 0.82, 0.3),
  colour("c_moss", "Moss", "upholstery", "rgb(92,104,72)", 0.8, 0.3),
  colour("c_rust", "Rust", "upholstery", "rgb(150,74,44)", 0.8, 0.3),
  colour("c_ink", "Ink Blue", "upholstery", "rgb(38,52,82)", 0.8, 0.3),
  colour("c_white_matt", "Matt White", "laminate", "rgb(236,234,229)", 0.45),
  colour("c_graphite", "Graphite", "laminate", "rgb(58,60,63)", 0.42),
  colour("c_sage", "Sage", "laminate", "rgb(160,172,150)", 0.45),
  colour("c_clay", "Clay", "laminate", "rgb(186,132,104)", 0.45),
];

export const PBR_MATERIALS = [...POLY_HAVEN, ...COLOUR_FINISHES, ...ACG_MATERIALS];
