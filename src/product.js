import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { PRODUCTS, DEFAULT_PRODUCT } from "./products.js";

// Shared Draco decoder (wasm) — served from public/draco/. Models are exported
// Draco-compressed (≈88% smaller), so the loader needs this to decode geometry.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("draco/");
dracoLoader.setDecoderConfig({ type: "wasm" });

// KTX2 / Basis decoder — fabrics are 2K KTX2 (GPU-compressed, mipmapped). The
// transcoder is served from public/basis/. initKTX2(renderer) MUST run before
// loading any .ktx2 so it can detect supported GPU formats.
const ktx2Loader = new KTX2Loader().setTranscoderPath("basis/");
export function initKTX2(renderer) { ktx2Loader.detectSupport(renderer); }

// KTX2Loader.load() delivers the texture via callback (it returns undefined),
// so this is async: `onReady(texture)` fires once loaded/transcoded.
const ktxCache = new Map();
const ktxRefs = new Map();
const KTX_CACHE_LIMIT = 48;

function trimKtxCache() {
  if (ktxCache.size <= KTX_CACHE_LIMIT) return;
  const candidates = [...ktxCache.entries()]
    .filter(([url]) => (ktxRefs.get(url) || 0) === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [url, entry] of candidates) {
    if (ktxCache.size <= KTX_CACHE_LIMIT) break;
    entry.texture.dispose();
    ktxCache.delete(url);
  }
}

function retainKtx(texture) {
  const url = texture?.userData?.assetURL;
  if (url) ktxRefs.set(url, (ktxRefs.get(url) || 0) + 1);
}

function releaseKtx(texture) {
  const url = texture?.userData?.assetURL;
  if (!url) return;
  const next = (ktxRefs.get(url) || 1) - 1;
  if (next > 0) ktxRefs.set(url, next); else ktxRefs.delete(url);
}

function releaseMaterialMaps(mat) {
  for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "specularIntensityMap"]) {
    releaseKtx(mat[key]);
    mat[key] = null;
  }
  trimKtxCache();
}

function assignKtx(mat, key, texture) {
  releaseKtx(mat[key]);
  mat[key] = texture;
  retainKtx(texture);
}

function ktxTexture(url, anisotropy, isColor, repeat, onReady) {
  const cached = ktxCache.get(url);
  if (cached) {
    cached.lastUsed = performance.now();
    onReady(cached.texture);
    return;
  }
  ktx2Loader.load(url, (tex) => {
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = anisotropy;
    tex.needsUpdate = true;
    tex.userData.assetURL = url;
    ktxCache.set(url, { texture: tex, lastUsed: performance.now() });
    trimKtxCache();
    onReady(tex);
  }, undefined, (e) => { ktxCache.delete(url); console.warn("KTX2 load failed:", url, e?.message || e); });
}

// The product ships as ONE GLB whose named nodes ARE the material system:
// a/b take upholstery fabrics, black/chrome are fixed finishes. Each mesh carries
// two UV layers — 'uv' (TEXCOORD_0 = tiling fabric) + 'ao' (TEXCOORD_1 → three
// channel 1 = the Cycles-baked AO/lightmap atlas).

// Blocked-out surrounding environment (floor + walls, untextured) — traced as
// real geometry so the path tracer gives true parallax, contact shadows and GI
// bounce. Materials are double-sided (the room is viewed from inside) and the
// base colour is overridable per-environment via setPhotoFloor().
export async function loadEnvRoom(url) {
  const loader = new GLTFLoader().setDRACOLoader(dracoLoader);
  const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
  const room = gltf.scene;
  room.name = "env-room";
  room.traverse((n) => {
    if (!n.isMesh) return;
    n.castShadow = false;
    n.receiveShadow = true;
    n.material.side = THREE.DoubleSide; // interior surfaces face the camera
  });
  return room;
}

// Generic GLB loader (Draco) → returns the scene group. For dropping extra
// products into the path-traced scene (multi-product experiment).
export async function loadGLBObject(url) {
  const loader = new GLTFLoader().setDRACOLoader(dracoLoader);
  const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
  gltf.scene.traverse((n) => { if (n.isMesh && n.geometry.computeVertexNormals && !n.geometry.attributes.normal) n.geometry.computeVertexNormals(); });
  return gltf.scene;
}

async function loadGLB(loader, url, inline, id) {
  if (inline && inline.glb && inline.glb[id]) {
    // standalone build: parse embedded GLB bytes instead of fetching
    const buf = await fetch(`data:model/gltf-binary;base64,${inline.glb[id]}`).then((r) => r.arrayBuffer());
    return new Promise((res, rej) => loader.parse(buf, "", res, rej));
  }
  return new Promise((res, rej) => loader.load(url, res, undefined, rej));
}

export async function loadProduct(scene, onProgress, inline = null, productId = DEFAULT_PRODUCT) {
  const product = PRODUCTS[productId] || PRODUCTS[DEFAULT_PRODUCT];
  const loader = new GLTFLoader().setDRACOLoader(dracoLoader);
  const group = new THREE.Group();
  group.name = product.id;

  // Baked AO atlas + Cycles lightmaps removed — the path tracer computes
  // occlusion and global illumination directly, so those ~1.5 MB of textures
  // were redundant boot load. (The GLB's uv1/'ao' channel is now unused.)
  // One material per registry slot, type inferred from the slot NAME so any
  // product's node set maps automatically. These roles are deliberately
  // physically distinct: chrome/aluminium are conductors, powder coat and gloss
  // paint are dielectric coatings, and plastic never receives metallic response.
  const roleMaterial = (material, role, envIntensity) => {
    material.name = `PBR · ${role}`;
    material.userData.pbrRole = role;
    material.userData.envIntensity = envIntensity;
    material.envMapIntensity = envIntensity;
    return material;
  };
  const makeSlotMaterial = (slot) => {
    const s = slot.toLowerCase();
    if (s.includes("chrome")) {
      const dark = s.includes("black");
      return roleMaterial(new THREE.MeshStandardMaterial({
        color: dark ? 0x202124 : 0xd7dadd,
        metalness: 1,
        roughness: dark ? 0.24 : 0.1,
      }), dark ? "black chrome" : "polished chrome", dark ? 1.1 : 1.35);
    }
    if (/plastic|rubber|vinyl/.test(s)) {
      return roleMaterial(new THREE.MeshStandardMaterial({
        color: 0x171719, metalness: 0, roughness: 0.5,
      }), "black polymer", 0.55);
    }
    if (/gloss/.test(s)) {
      return roleMaterial(new THREE.MeshPhysicalMaterial({
        color: s.includes("black") ? 0x101012 : 0xf2f2ef,
        metalness: 0, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.06,
      }), "high-gloss paint", 0.9);
    }
    if (/aluminium|aluminum|\balu\b|brushed/.test(s)) {
      return roleMaterial(new THREE.MeshStandardMaterial({
        color: 0xc2c5c8, metalness: 1, roughness: 0.32,
      }), "brushed aluminium", 1.2);
    }
    if (/stainless|steel|bare metal/.test(s)) {
      return roleMaterial(new THREE.MeshStandardMaterial({
        color: 0xc8cbce, metalness: 1, roughness: 0.2,
      }), "satin steel", 1.2);
    }
    if (/black|metal|frame|base|leg|foot|feet/.test(s)) {
      return roleMaterial(new THREE.MeshPhysicalMaterial({
        color: 0x141416, metalness: 0.08, roughness: 0.36,
        clearcoat: 0.24, clearcoatRoughness: 0.28,
      }), "powder-coated frame", 0.75);
    }
    return roleMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0, roughness: 0.78,
      sheen: 0.35, sheenRoughness: 0.55,
    }), "configurable surface", 0.7);
  };
  const materials = {};
  for (const slot of product.slots) materials[slot] = makeSlotMaterial(slot);

  // Known NON-slot parts get a proper material (the GLB's exported one is often
  // flat/wrong — mirrors aren't reflective, LEDs don't glow). Returns [key, mat]
  // or null (unknown parts keep their GLB material). Stored into `materials` so
  // the reflection probe gives them an envMap too (mirrors/taps need it).
  const makePartMaterial = (name) => {
    const s = name.toLowerCase().replace(/\.\d+$/, "");
    // mirror → true reflector
    if (s.includes("mirror")) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.01 }), "mirror", 1.6); m.userData.isMirror = true; return [s, m]; }
    // led / light → warm emissive glow (no reflections)
    if (s.includes("led") || s.includes("light")) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dd, emissiveIntensity: 2.4, roughness: 1 }), "emissive light", 0); return [s, m]; }
    // taps / faucet necks / handles / stool bases → polished chrome
    if (/chrome|tap|faucet|hydraulic|pump|footrest|neck/.test(s)) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0xd7dadd, metalness: 1, roughness: 0.1 }), "polished chrome", 1.35); return [s, m]; }
    // washbasin / unit body / drainer → glazed white ceramic (bright, smooth, clearcoat glaze sheen)
    if (/basin|ceramic|porcelain|drainer/.test(s)) { const m = roleMaterial(new THREE.MeshPhysicalMaterial({ color: 0xf7f7f5, metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.04 }), "glazed ceramic", 0.9); return [s, m]; }
    // aluminium / stainless parts must be resolved before the generic frame rule
    if (/aluminium|aluminum|\balu\b|brushed/.test(s)) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0xc2c5c8, metalness: 1, roughness: 0.32 }), "brushed aluminium", 1.2); return [s, m]; }
    if (/stainless|steel/.test(s)) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0xc8cbce, metalness: 1, roughness: 0.2 }), "satin steel", 1.2); return [s, m]; }
    // frames / legs / drawer slides / wheels / castors / cable ports / buttons / blowers → dark satin metal
    if (/leg|frame|base|slide|wheel|castor|internal|port|button|blower|bracket|zip/.test(s)) { const m = roleMaterial(new THREE.MeshPhysicalMaterial({ color: 0x171719, roughness: 0.4, metalness: 0.08, clearcoat: 0.18, clearcoatRoughness: 0.3 }), "powder-coated frame", 0.75); return [s, m]; }
    // glass panels / shelves → clear glass
    if (s.includes("glass")) { const m = roleMaterial(new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.04, transmission: 0.9, ior: 1.5, thickness: 0.4, transparent: true, opacity: 0.5 }), "clear glass", 1); return [s, m]; }
    // robustness fallbacks for finish "bits" not registered as a slot (else they keep
    // the GLB's flat material): plastic → matte, black/grey/white → tinted satin.
    if (/plastic|rubber|vinyl/.test(s)) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0x202024, roughness: 0.55, metalness: 0 }), "polymer", 0.5); return [s, m]; }
    if (s.includes("black")) { const metal = /metal|steel/.test(s); const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: metal ? 0.3 : 0.45, metalness: metal ? 1 : 0 }), metal ? "blackened steel" : "black finish", metal ? 1 : 0.65); return [s, m]; }
    if (s.includes("grey") || s.includes("gray")) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.55, metalness: 0 }), "grey finish", 0.65); return [s, m]; }
    if (s.includes("white")) { const m = roleMaterial(new THREE.MeshStandardMaterial({ color: 0xededed, roughness: 0.5, metalness: 0 }), "white finish", 0.6); return [s, m]; }
    return null;
  };

  const gltf = await loadGLB(loader, product.model, inline, product.id);
  onProgress?.(0.85);

  // Map each GLB node to its slot by name: exact match, else strip the exporter
  // suffix (".001") and match the base. NO loose startsWith — that would let a
  // mesh like "basin"/"base"/"body" wrongly grab single-letter slot "b". Meshes
  // that match no slot (mirror, led, basin, …) keep their GLB material.
  const slotOf = (name) => {
    const n = (name || "").toLowerCase();
    if (product.slots.includes(n)) return n;
    const base = n.replace(/\.\d+$/, "");
    if (product.slots.includes(base)) return base;
    const alias = product.materialAliases?.[base];
    if (alias && product.slots.includes(alias)) return alias;
    // Some exporters name trim explicitly (for example "A Piping") rather than
    // using the slot name. Preserve that authored association.
    const labelledTrim = base.match(/^([abcd])[\s_-]+(?:piping|stitches?|stiches?)$/);
    if (labelledTrim && product.fabricSlots.includes(labelledTrim[1])) return labelledTrim[1];
    return null;
  };

  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    // Hide modelling helpers that some .blends ship (UV-scale guides, "raw" backup
    // copies, blocked-out "block" massing, oversized "stl" imports, "old" version dupes).
    if (/uv[_-]|guide|scaler|^raw$|block|^stl$|^old$/i.test(node.name.toLowerCase().replace(/\.\d+$/, ""))) { node.visible = false; return; }
    const slot = slotOf(node.name);
    if (slot && materials[slot]) {
      node.material = materials[slot];
    } else {
      const key = node.name.toLowerCase().replace(/\.\d+$/, "");
      if (materials[key]) node.material = materials[key]; // shared with a sibling part
      else { const pm = makePartMaterial(node.name); if (pm) { materials[pm[0]] = pm[1]; node.material = pm[1]; } }
    }
    node.castShadow = true;
    node.receiveShadow = true;
    // Tangents for correct tangent-space normal mapping — the path tracer needs
    // them (raster derives them in-shader, the GLB ships without them).
    const g = node.geometry;
    if (g && g.index && g.attributes.uv && g.attributes.normal && !g.attributes.tangent) {
      try { g.computeTangents(); } catch (e) { console.warn("computeTangents failed for", node.name, e.message); }
    }
  });
  group.add(gltf.scene);
  onProgress?.(1);

  // Normalise: uniform scale to target height, base resting on y=0, centred.
  // Measure only VISIBLE meshes so hidden helpers (oversized STL/block) don't skew it.
  const box = new THREE.Box3();
  group.traverse((n) => { if (n.isMesh && n.visible) box.expandByObject(n); });
  if (box.isEmpty()) box.setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const s = product.targetHeight / size.y;
  group.scale.setScalar(s);
  const scaled = new THREE.Box3().setFromObject(group);
  const centre = scaled.getCenter(new THREE.Vector3());
  group.position.x -= centre.x;
  group.position.z -= centre.z;
  group.position.y -= scaled.min.y;

  scene.add(group);

  // Baked maps (lightmap + AO) are per-product prep. Only load them when the
  // registry flags the product as baked; a fresh product would
  // otherwise 404 on maps that don't exist yet.
  if (product.baked) {
  // Re-attach the baked LIGHTING-ONLY lightmaps onto the GLB's uv1/'ao' atlas.
  // These ONLY affect the raster preview shown while the camera moves — the path
  // tracer computes its own GI and ignores material.lightMap — so the orbiting
  // view gets baked soft shadow + bounce instead of flat IBL, with zero effect on
  // the final trace. Loaded async so the ~8 MB never blocks first paint; applied
  // on arrival. Skip chrome (metalness 1.0 → no diffuse for a lightmap to modulate).
  const bakedSlots = Array.isArray(product.bakedSlots)
    ? product.bakedSlots
    : product.slots.filter((slot) => !/chrome/i.test(slot));
  for (const slot of bakedSlots) {
    const mat = materials[slot];
    if (!mat) continue;
    texLoader.load(
      `assets/${product.id}/lm_${slot}.png`,
      (tex) => {
        tex.channel = 1;                     // sample uv1 ('ao' atlas), not the tiling fabric uv
        tex.flipY = false;                   // glTF UV convention (matches the GLB's uv1)
        tex.colorSpace = THREE.NoColorSpace; // linear irradiance — no sRGB decode
        tex.needsUpdate = true;
        mat.userData.bakedLM = tex;          // kept so the debug toggle can null/restore it
        // lightMap ADDS the baked GI bounce (subtle fill toward the PT look).
        // NOTE: do NOT reuse this as an aoMap — it's a *lighting* bake (avg ~0.4),
        // so as an aoMap it multiplies the whole chair down ~2.6× (the dark/"lit
        // from behind" bug). Correct occlusion needs a dedicated AO bake.
        mat.lightMap = tex; mat.lightMapIntensity = 1.0;
        mat.needsUpdate = true;
      },
      undefined,
      (e) => console.warn("lightmap load failed", slot, e?.message || e)
    );
  }

  // Proper baked AO atlas (Niall's bake) — ONE shared map; every slot samples its
  // own islands via uv1. White = open (no change), dark = true crevices, so it
  // multiplies the IBL down ONLY where it should — visible contact occlusion with
  // no brightness crush. Strength is live via aoMapIntensity (UI slider).
  texLoader.load(
    `assets/${product.id}/ao_2k.png`,
    (tex) => {
      tex.channel = 1;                     // uv1 ('ao' atlas), same as the lightmaps
      tex.flipY = false;                   // glTF UV convention
      tex.colorSpace = THREE.NoColorSpace; // occlusion is data, not colour
      tex.needsUpdate = true;
      for (const slot of bakedSlots) {
        const mat = materials[slot]; if (!mat) continue;
        mat.aoMap = tex; mat.aoMapIntensity = 1.5; // tune via the AO slider
        mat.needsUpdate = true;
      }
    },
    undefined,
    (e) => console.warn("AO map load failed", e?.message || e)
  );
  } // end if (product.baked)

  return { group, materials };
}

// ---- Fabric application -----------------------------------------------------
const texCache = new Map();
const texLoader = new THREE.TextureLoader();
const slotGenerations = new WeakMap();

function nextSlotGeneration(materials, slot) {
  let generations = slotGenerations.get(materials);
  if (!generations) {
    generations = new Map();
    slotGenerations.set(materials, generations);
  }
  const next = (generations.get(slot) || 0) + 1;
  generations.set(slot, next);
  return next;
}

function isCurrentSlotGeneration(materials, slot, generation) {
  return slotGenerations.get(materials)?.get(slot) === generation;
}

function fabricTexture(url, anisotropy, isColor = true) {
  if (texCache.has(url)) return texCache.get(url);
  const tex = texLoader.load(url);
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.2, 2.2);
  tex.anisotropy = anisotropy;
  texCache.set(url, tex);
  return tex;
}

export function applyFabric(materials, slot, swatch, anisotropy = 8) {
  const mat = materials[slot];
  if (!mat) return;
  nextSlotGeneration(materials, slot);
  releaseMaterialMaps(mat);
  mat.map = fabricTexture(swatch.tile, anisotropy);
  // micro-relief from the derived normal map (VW: every soft surface has one)
  const nUrl = swatch.normal || (swatch.tile.endsWith(".jpg") ? swatch.tile.replace(/\.jpg$/, "_n.jpg") : null);
  if (nUrl) {
    mat.normalMap = fabricTexture(nUrl, anisotropy, false);
    mat.normalScale = new THREE.Vector2(0.55, 0.55);
  }
  // clear any PBR maps a previous full-PBR material may have set on this slot
  mat.roughnessMap = mat.metalnessMap = mat.specularIntensityMap = null;
  mat.color.set(0xffffff);
  mat.needsUpdate = true;
}

// ---- Full-PBR material application (Poly Haven 4K sets) ----------------------
// Layers albedo/normal/rough/metal from the material; the path tracer handles
// occlusion + GI (no baked AO/lightmaps). ARM packs AO(R)/Rough(G)/Metal(B) — we
// feed it to roughnessMap + metalnessMap and let three read the right channel
// (the AO channel is unused; the tracer computes real occlusion).
export function applyPBRMaterial(materials, slot, def, anisotropy = 8, { fullMaterialMaps = true } = {}) {
  const mat = materials[slot];
  if (!mat || !def) return;
  const generation = nextSlotGeneration(materials, slot);
  releaseMaterialMaps(mat);
  const rep = def.repeat ?? 2.2;
  // Materials can be authored as an exact catalogue colour rather than a
  // texture set. Supporting that form lets a commerce UI pass its material
  // command straight into this renderer.
  if (def.color && !def.maps?.albedo) {
    mat.color.set(def.color);
    mat.roughness = def.roughness ?? (def.category === "laminate" ? 0.42 : 0.78);
    mat.metalness = def.metalness ?? 0;
    mat.sheen = def.sheen ?? (def.category === "upholstery" ? 0.28 : 0);
    mat.sheenRoughness = def.sheenRoughness ?? 0.6;
    // White default sheen desaturates dark and mid-tone fabrics under an HDRI.
    // Cloth fibres inherit the fabric hue with only a slight neutral lift.
    if (def.category === "upholstery" && mat.sheenColor) {
      mat.sheenColor.copy(mat.color).lerp(new THREE.Color(0xffffff), 0.08);
      mat.specularIntensity = def.specularIntensity ?? 0.45;
      mat.ior = def.ior ?? 1.35;
    }
    mat.normalMap = mat.roughnessMap = mat.metalnessMap = mat.specularIntensityMap = null;
    mat.needsUpdate = true;
    return;
  }
  // maps load async (KTX2 transcode) → assign on the slot when ready
  const set = (stem, isColor, key) =>
    ktxTexture(`${def.base}/${stem}.ktx2`, anisotropy, isColor, rep, (t) => {
      if (!isCurrentSlotGeneration(materials, slot, generation)) return;
      assignKtx(mat, key, t); mat.needsUpdate = true;
    });

  set(def.maps.albedo, true, "map");

  if (!fullMaterialMaps) {
    // Constrained devices keep the colour map only. This preserves the
    // product/finish choice while avoiding several extra GPU uploads per slot.
    mat.normalMap = null;
    mat.roughnessMap = mat.metalnessMap = mat.specularIntensityMap = null;
    mat.roughness = def.roughness ?? 0.78;
    mat.metalness = def.metalness ?? 0;
    if (def.sheen != null) { mat.sheen = def.sheen; mat.sheenRoughness = def.sheenRoughness ?? 0.5; }
    mat.color.set(0xffffff);
    mat.needsUpdate = true;
    return;
  }

  if (def.maps.normal) {
    set(def.maps.normal, false, "normalMap");
    const ns = def.normalScale ?? 1;
    mat.normalScale = new THREE.Vector2(ns, ns);
  } else mat.normalMap = null;

  if (def.maps.roughness) {
    set(def.maps.roughness, false, "roughnessMap");
    mat.metalnessMap = null;
    mat.roughness = 1; mat.metalness = def.metalness ?? 0;
  } else if (def.maps.arm) {
    mat.roughness = 1; mat.metalness = 1;
    // ARM: same texture → roughnessMap (G) + metalnessMap (B)
    ktxTexture(`${def.base}/${def.maps.arm}.ktx2`, anisotropy, false, rep, (t) => {
      if (!isCurrentSlotGeneration(materials, slot, generation)) return;
      assignKtx(mat, "roughnessMap", t); assignKtx(mat, "metalnessMap", t); mat.needsUpdate = true;
    });
  } else {
    mat.roughnessMap = mat.metalnessMap = null;
  }

  if (def.maps.spec && "specularIntensityMap" in mat) set(def.maps.spec, false, "specularIntensityMap");
  else mat.specularIntensityMap = null;

  if (def.sheen != null) { mat.sheen = def.sheen; mat.sheenRoughness = def.sheenRoughness ?? 0.5; }
  mat.color.set(0xffffff);
  mat.needsUpdate = true;
}
