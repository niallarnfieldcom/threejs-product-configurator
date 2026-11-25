// src/photo-tracer.js
// Photo Mode — GPU path tracing via three-gpu-pathtracer (WebGLPathTracer).
//
// Reuses the app's main WebGLRenderer and the live product geometry/materials,
// so the traced image is the real chair with its real fabrics — no duplicated
// scene description. The tracer builds a BVH, shows a rasterized frame while it
// compiles, then accumulates progressive samples.
//
// Why a dedicated ptScene: the tracer packs EVERY material in the scene it is
// given. The studio environment helpers (floor/dome/contact blob) use
// MeshBasicMaterial, which has no `.emissive` — and the tracer reads `.emissive`
// unconditionally, so handing it the full scene crashes in MaterialsTexture.
// We trace a scene that holds only the product, and carry the environment map
// on it for image-based lighting. A real THREE.Scene (not the bare group) also
// supplies the environment*/background* fields the tracer reads.
//
// Host contract (names kept stable so main.js stays wired):
//   initPhotoTracer(object, scene, camera, renderer, envTexture) -> bool
//   renderPhotoTracer()        -> render one progressive sample to the canvas
//   updatePhotoCamera(camera)  -> camera moved; restart accumulation
//   updatePhotoMaterials()     -> fabric changed; rebuild materials + restart
//   updatePhotoEnv(envTexture) -> environment changed; reload IBL + restart
//   markPhotoSceneDirty()      -> restart accumulation
//   exitPhotoTracer()          -> tear down, hand geometry back, restore raster

import * as THREE from "three";
import { WebGLPathTracer, DenoiseMaterial } from "three-gpu-pathtracer";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

let tracer = null;
let ptScene = null;       // dedicated trace scene (product only + environment)
let mainScene = null;     // the live app scene, to return the product to on exit
let tracedObject = null;  // the product group borrowed into ptScene
let envTexture = null;    // raw equirect HDR for IBL (preferred over PMREM cubeUV)
let activeCamera = null;
let activeRenderer = null;
let maxSamples = 0;       // 0 = unlimited; otherwise stop sampling once converged
let exporting = false;    // while true the live loop yields; renderStill drives samples
let ptFloor = null;        // optional ground plane for grounded hero shots (off by default)
let ptKey = null;          // soft key light above the product → a DEFINED contact shadow
let ptLamp = null;         // camera-mounted fill "headlamp" — follows the camera, traced
let lampIntensity = 4;     // subtle neutral fill; HDRI + area key remain the primary lights
let ptRoom = null;         // blocked-out surrounding environment (floor + walls), traced
let floorColor = 0x303034; // fixed neutral floor keeps bounce light stable across UI themes
let groundOn = true;       // contact-shadow floor always on
// Soft white, NOT pure 0xffffff: the tracer's GradientEquirectTexture defaults
// topColor=white, and it only rewrites the gradient when topColor !== background
// — so pure white silently leaves a white→black gradient. Off-white dodges that.
const PT_BG = new THREE.Color(0x18181b);

// Lazily build the dark, slightly-glossy ground — a CIRCLE just big enough to
// cover the product's footprint (computed from its bounds + a small margin),
// centred under it. Dark = low albedo, so rays that hit it are mostly absorbed
// and terminate fast (much cheaper than a bright floor), while a touch of gloss
// reflects the product to ground it.
// Radial opaque→transparent alpha map: opaque in the centre (catches the contact
// shadow), fading to nothing at the rim so the disc dissolves into the backdrop.
function radialAlphaMap(innerFrac) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(Math.min(0.95, innerFrac), "#fff"); // opaque under the product
  grad.addColorStop(1, "#000");                          // gone at the rim
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function ensureGround() {
  if (ptFloor) return;
  let rf = 1.0, cx = 0, cz = 0, top = 1.2; // footprint radius + centre + product top
  if (tracedObject) {
    const box = new THREE.Box3().setFromObject(tracedObject);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    rf = Math.max(size.x, size.z) * 0.5 + 0.15; // footprint + ~15cm margin
    cx = center.x; cz = center.z; top = box.max.y;
  }
  // Disc much larger than the footprint so the alpha rim fades out well past the
  // product → SEAMLESS infinity: colour matches the backdrop, edge dissolves.
  const R = rf * 2.8;
  ptFloor = new THREE.Mesh(
    new THREE.CircleGeometry(R, 96),
    new THREE.MeshStandardMaterial({
      color: floorColor, roughness: 0.9, metalness: 0,
      transparent: true, alphaMap: radialAlphaMap(rf / R), depthWrite: false,
    })
  );
  ptFloor.rotation.x = -Math.PI / 2;
  ptFloor.position.set(cx, 0, cz);
  // Soft area key light above the product → a DEFINED soft contact shadow on the
  // opaque centre (pure HDRI alone gives none). Sized to the footprint.
  const ks = Math.max(2, rf * 4);
  ptKey = new THREE.RectAreaLight(0xffffff, 2, ks, ks);
  ptKey.position.set(cx + 0.3, top + 1.6, cz + 0.8);
  ptKey.lookAt(cx, 0, cz);
}

// Toggle the grounded-hero floor (contact shadow + soft reflection). Off keeps
// the fastest product-only path; on adds a real surface so the chair isn't
// floating — opt-in for stills.
export function setPhotoGround(on) {
  groundOn = !!on;
  if (!ptScene) return;
  if (groundOn) {
    ensureGround();
    if (ptFloor.parent !== ptScene) ptScene.add(ptFloor);
    if (ptKey.parent !== ptScene) ptScene.add(ptKey);
  } else {
    if (ptFloor?.parent === ptScene) ptScene.remove(ptFloor);
    if (ptKey?.parent === ptScene) ptScene.remove(ptKey);
  }
  applyRoomTint();
  if (tracer) { tracer.setScene(ptScene, activeCamera); tracer.reset(); }
}

// Set the visible backdrop only. The physical floor and lights stay fixed so a
// UI theme change cannot alter material exposure, bounce light or colour balance.
export function setPhotoEnvColor(hex) {
  PT_BG.set(hex);
  if (ptScene) ptScene.background = PT_BG;
  if (tracer) { tracer.updateEnvironment(); tracer.reset(); }
}

// Add another product into the trace scene and rebuild the BVH — used for the
// sequential multi-product experiment (drop product 2 in once product 1 converged).
export function addTracedObject(obj) {
  if (!obj) return;
  if (ptScene && obj.parent !== ptScene) ptScene.add(obj);
  if (tracer && ptScene) { tracer.setScene(ptScene, activeCamera); tracer.reset(); }
}

// Swap which product the tracer renders: pull `outObj` out, put `inObj` in,
// rebuild the BVH. The outgoing product is handed back to the caller (raster).
export function swapTracedProduct(outObj, inObj) {
  if (outObj && outObj.parent === ptScene) ptScene.remove(outObj);
  if (inObj && inObj.parent !== ptScene) ptScene.add(inObj);
  if (tracer && ptScene) { tracer.setScene(ptScene, activeCamera); tracer.reset(); }
}

// Install the blocked-out environment room into the trace scene. It brings its
// own floor, so it replaces the fallback ground plane; rebuilds the BVH.
export function setPhotoRoom(obj) {
  ptRoom = obj;
  if (ptScene) {
    if (ptFloor && ptFloor.parent === ptScene) ptScene.remove(ptFloor);
    if (ptRoom.parent !== ptScene) ptScene.add(ptRoom);
  }
  applyRoomTint();
  if (tracer && ptScene) { tracer.setScene(ptScene, activeCamera); tracer.reset(); }
}

// Tint the environment surfaces to match the active lighting mood.
export function setPhotoFloor(color) {
  floorColor = color;
  applyRoomTint();
}

function applyRoomTint() {
  const target = ptRoom || ptFloor;
  if (!target) return;
  target.traverse((n) => { if (n.isMesh && n.material?.color) n.material.color.set(floorColor); });
  if (tracer) { tracer.updateMaterials(); tracer.reset(); }
}

// ---- Post FX: one final denoise + one output transform -----------------------
// DenoiseMaterial is explicitly a FINAL screen pass: it already applies the
// renderer's tone mapping and output colour-space conversion. The previous
// albedo-demodulation chain rendered through DenoiseMaterial into an intermediate
// texture, multiplied that nonlinear result by albedo, then tone-mapped it again.
// That double transform washed pale fabrics toward white, crushed dark fabrics,
// and the following unsharp mask produced black rings around modelled stitches.
// Keep radiance linear until this one edge-aware final pass; no remodulation and
// no sharpening means the tracer and material colours retain their real relation.
let denoiseQuad = null;
const denoise = { enabled: false, sigma: 2.0, kSigma: 1.0, threshold: 0.035 };

// Live-tunable denoise values; force a re-blit so changes show immediately.
export function setDenoise(o = {}) { Object.assign(denoise, o); if (tracer && !exporting) tracer.renderSample(); }
export function setDenoiseActive(b) { denoise.enabled = !!b; }

function denoiseUniforms(tex) {
  const u = denoiseQuad.material.uniforms;
  u.map.value = tex;
  u.sigma.value = Math.max(0.01, denoise.sigma);
  u.kSigma.value = denoise.kSigma; // full strength when on — gated by the cutoff reveal, not faded by sample count
  u.threshold.value = denoise.threshold;
}

// Hook the tracer's canvas blit. DenoiseMaterial is used only as intended: the
// final target-to-screen operation, where it tone-maps exactly once.
function setupDenoise() {
  if (denoiseQuad || !tracer) return;
  denoiseQuad = new FullScreenQuad(new DenoiseMaterial());
  tracer.renderToCanvasCallback = (target, renderer, quad) => {
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.setRenderTarget(null);
    if (denoise.enabled) {
      denoiseUniforms(target.texture);
      denoiseQuad.render(renderer);
    } else {
      quad.render(renderer);
    }
    renderer.autoClear = ac;
  };
}

export function initPhotoTracer(object, scene, camera, renderer, env = null) {
  // three-gpu-pathtracer is WebGL2-only — guard so the WebGPU tier can't crash.
  if (!renderer || renderer.isWebGPURenderer) {
    console.warn("[PhotoTracer] Photo Mode needs a WebGLRenderer — unavailable on this backend.");
    return false;
  }

  mainScene = scene;
  tracedObject = object;
  activeCamera = camera;
  activeRenderer = renderer;
  envTexture = env;

  if (!ptScene) ptScene = new THREE.Scene();
  // Product-only: trace just the chair, lit by the HDRI (IBL) on clean alpha.
  // No floor/room geometry → rays escape to the environment in one bounce, so
  // this is the fastest, lowest-noise case. A traced environment can be added
  // back at runtime via setPhotoRoom().
  if (ptRoom && ptRoom.parent !== ptScene) ptScene.add(ptRoom);
  if (groundOn) { ensureGround(); ptScene.add(ptFloor); ptScene.add(ptKey); } // floor + key (opt-in)
  applyRoomTint();
  syncEnv();
  // Borrow the product into the trace scene. World transform is unchanged — both
  // parents are at identity — so the BVH is built in the right world positions.
  ptScene.add(object);

  // Camera-mounted fill lamp ("headlamp"): a PointLight that rides the camera so
  // whatever faces the view stays lit. three-gpu-pathtracer samples real lights, so
  // it emits in the PT too. Position is refreshed in updatePhotoCamera (camera move),
  // re-synced cheaply via tracer.updateLights() — no BVH rebuild.
  if (!ptLamp) { ptLamp = new THREE.PointLight(0xffffff, lampIntensity, 0, 2); ptLamp.userData.envIntensity = 0; }
  ptLamp.intensity = lampIntensity;
  if (camera) ptLamp.position.copy(camera.position);
  if (ptLamp.parent !== ptScene) ptScene.add(ptLamp);

  if (!tracer) {
    tracer = new WebGLPathTracer(renderer);
    tracer.renderScale = 1;          // full-res accumulation
    tracer.tiles.set(2, 2);          // split each sample across tiles → responsive
    // The application already supplies its own shaded raster bridge while the
    // camera moves and during warm-up. Disable the library previews so the GPU
    // does not render the same transition a second time.
    tracer.dynamicLowRes = false;
    tracer.rasterizeScene = false;
    tracer.renderDelay = 0;
    tracer.fadeDuration = 0;
    tracer.minSamples = 1;
    tracer.bounces = 6;              // richer indirect light without Pro-mode cost
    tracer.filterGlossyFactor = 0.32; // suppress chrome fireflies while retaining reflections
  }
  setupDenoise(); // hook the denoise post-pass onto the canvas blit
  tracer.setScene(ptScene, camera);
  return true;
}

// Live quality controls (all optional; only the provided fields are applied).
export function setPhotoQuality(o = {}) {
  if (o.samplesPerFrame != null) samplesPerFrame = Math.max(1, o.samplesPerFrame); // honoured on mobile too now
  if (!tracer) return;
  if (o.bounces != null) tracer.bounces = o.bounces;
  if (o.filterGlossyFactor != null) tracer.filterGlossyFactor = o.filterGlossyFactor;
  if (o.renderScale != null) tracer.renderScale = o.renderScale;
  if (o.stableNoise != null) tracer.stableNoise = o.stableNoise;
  if (o.maxSamples != null) maxSamples = o.maxSamples;
  if (o.envIntensity != null && ptScene) {
    ptScene.environmentIntensity = o.envIntensity;
    tracer.updateEnvironment();
  }
  tracer.reset();
}

// Current accumulated sample count — for a UI "converging…" readout.
export function getPhotoSamples() {
  return tracer ? tracer.samples : 0;
}

function syncEnv() {
  if (!ptScene) return;
  // The tracer needs a RAW equirectangular HDR for IBL. Never fall back to
  // scene.environment (a PMREM/cubeUV texture) — the tracer can't sample it and
  // crashes. Null until the HDR loads; hdrReady → updatePhotoEnv sets it then.
  ptScene.environment = envTexture || null;
  ptScene.environmentIntensity = (mainScene && mainScene.environmentIntensity) ?? 1;
  // No equirect backdrop — the HDRI is lighting-only (IBL). The visible
  // surroundings are a calibrated neutral studio colour.
  ptScene.background = PT_BG;
}

export function isExporting() { return exporting; } // main loop must not draw during a render export

let samplesPerFrame = 2;   // fallback batch when the adaptive controller isn't driving
let liveBatchCalls = 0;    // >0 → adaptive batch (tile-calls/frame) from the loop's GPU-saturation controller
export function setRenderBatch(n) { liveBatchCalls = Math.min(64, Math.max(0, n | 0)); } // hard cap — never flood the GPU queue
export function renderPhotoTracer() {
  if (exporting || !tracer) return; // renderStill owns the renderer during a high-res export
  // Batch many tile-calls per frame to keep the GPU busy (one call/frame is
  // vsync-gated to ~15 spp/s with the GPU ~idle). Only the LAST call blits — runs
  // the final denoise/output pass once per frame, not once per tile.
  const calls = liveBatchCalls > 0 ? liveBatchCalls : Math.max(1, Math.round(samplesPerFrame * tracer.tiles.x * tracer.tiles.y));
  const prevRTC = tracer.renderToCanvas;
  for (let i = 0; i < calls; i++) {
    if (maxSamples > 0 && tracer.samples >= maxSamples) break;
    tracer.renderToCanvas = i === calls - 1;
    tracer.renderSample();
  }
  tracer.renderToCanvas = prevRTC;
}

// Warm-up placeholder: paint the product as a white wireframe over the forming
// (low-sample) frame so the user sees its form while the tracer accumulates.
// ptScene holds only the product, so this is "nothing else" — just the chair.
let _wireMat = null;
export function renderWarmupPreview() {
  if (!tracer || !ptScene || !activeCamera || !activeRenderer) return;
  if (!_wireMat) _wireMat = new THREE.MeshBasicMaterial({ color: 0x999999, wireframe: true });
  const r = activeRenderer;
  const prevColor = new THREE.Color();
  r.getClearColor(prevColor);
  const prevAlpha = r.getClearAlpha();
  r.setRenderTarget(null);
  r.setClearColor(0xffffff, 1);
  r.clear();
  const floorVis = ptFloor ? ptFloor.visible : false;
  if (ptFloor) ptFloor.visible = false; // hide floor from the wireframe; geometry stays in the PT BVH for the shadow
  ptScene.overrideMaterial = _wireMat;
  r.render(ptScene, activeCamera);
  ptScene.overrideMaterial = null;
  if (ptFloor) ptFloor.visible = floorVis;
  r.setClearColor(prevColor, prevAlpha);
}

// Live RASTER preview shown WHILE the camera moves (and during the pre-reveal
// warm-up): the product with its REAL PBR materials — baked lightmaps / AO /
// normals — lit by the same IBL, on the PT backdrop. This is the "older
// renderer": not as good as the path trace, but a fully shaded chair, so the
// user never sees a wireframe. The tracer converges underneath and snaps in at
// the cutoff. Cheap (one raster pass); the BVH/material override is untouched.
export function renderRasterPreview() {
  if (!ptScene || !activeCamera || !activeRenderer) return;
  const r = activeRenderer;
  const prevColor = new THREE.Color();
  r.getClearColor(prevColor);
  const prevAlpha = r.getClearAlpha();
  // The path tracer drives gl scissor/viewport directly for tiling, desyncing
  // three's state cache. Without this resync, clear() can be scissored to the last
  // tile → the previous frame (e.g. the frozen render from the last zoom) survives
  // around the edges = ghosting. resetState() re-syncs so the clear covers the
  // FULL canvas.
  r.resetState();
  r.setRenderTarget(null);
  r.setClearColor(PT_BG, 1); // same backdrop as the trace → no flash on reveal
  r.clear();
  const floorVis = ptFloor ? ptFloor.visible : false;
  if (ptFloor) ptFloor.visible = false; // shadow-catcher is PT-only; hide in raster
  r.render(ptScene, activeCamera);      // real materials + IBL, no override
  if (ptFloor) ptFloor.visible = floorVis;
  r.setClearColor(prevColor, prevAlpha);
}

// High-res hero render: trace at `width`×`height` until `samples` ACCUMULATED
// samples, return a PNG data URL, then restore the live view. `samples` is the
// real converged sample count (not render-call count — tiling means many calls
// per sample). Reuses the same tracer/scene/IBL.
export async function renderStill({ width = 3840, height = 2160, samples = 1000, onProgress } = {}) {
  if (!tracer || !activeRenderer || !activeCamera) return null;
  const r = activeRenderer;
  const prev = r.getSize(new THREE.Vector2());
  const prevPR = r.getPixelRatio();
  const prevTiles = tracer.tiles.clone();
  const prevBg = ptScene.background;
  const prevLowRes = tracer.dynamicLowRes;
  const prevDelay = tracer.renderDelay;
  // Product-only cutout: pull the floor disc so the alpha PNG is just the product
  // on transparency (no white shadow-pad). Key light stays (no geometry → lighting only).
  const hadFloor = ptFloor && ptFloor.parent === ptScene;
  exporting = true;
  try {
    r.setPixelRatio(1);
    r.setSize(width, height, false); // internal buffer only — CSS size untouched
    activeCamera.aspect = width / height; activeCamera.updateProjectionMatrix();
    tracer.tiles.set(4, 4); // smaller GPU chunks per call → safe at 8K (no context timeout)
    tracer.dynamicLowRes = false; // full-res from sample 1: the responsive low-res ramp +
    tracer.renderDelay = 0;       // renderDelay need real frames/time, which batching skips → noise
    if (hadFloor) ptScene.remove(ptFloor); // product-only cutout (no white pad in the alpha PNG)
    ptScene.background = null; // export on a TRANSPARENT backdrop → alpha PNG (env not baked in)
    tracer.setScene(ptScene, activeCamera); // rebuild targets at export resolution
    tracer.reset();
    let guard = 0;
    const maxCalls = samples * 32; // hard stop (tiles → ~16 calls per sample)
    while (tracer.samples < samples && guard < maxCalls) {
      // Batch tiled calls per frame so the GPU runs flat-out. rAF-gating ONE
      // tiled call per frame capped it at ~4 samples/sec (16 calls/sample) —
      // export took minutes. 16 calls/frame ≈ a full sample per frame.
      for (let k = 0; k < 16 && tracer.samples < samples && guard < maxCalls; k++) {
        tracer.renderSample();
        guard++;
      }
      onProgress?.(Math.min(1, tracer.samples / samples));
      await new Promise((res) => requestAnimationFrame(res));
    }
    return r.domElement.toDataURL("image/png");
  } finally {
    tracer.tiles.copy(prevTiles);
    tracer.dynamicLowRes = prevLowRes;
    tracer.renderDelay = prevDelay;
    r.setPixelRatio(prevPR);
    r.setSize(prev.x, prev.y, false);
    activeCamera.aspect = prev.x / prev.y; activeCamera.updateProjectionMatrix();
    if (hadFloor) ptScene.add(ptFloor); // restore the floor disc
    ptScene.background = prevBg; // restore the live backdrop
    tracer.setScene(ptScene, activeCamera);
    tracer.reset();
    exporting = false;
  }
}

export function updatePhotoCamera(camera) {
  if (!tracer) return;
  if (camera) activeCamera = camera;
  // headlamp rides the camera: reposition + cheap light-only re-sync (no BVH rebuild)
  if (ptLamp && activeCamera && lampIntensity > 0) { ptLamp.position.copy(activeCamera.position); tracer.updateLights(); }
  tracer.updateCamera(); // restarts accumulation internally
}

// Debug "Camera lamp" slider → set the fill intensity (raster lamp is set in main.js).
export function setPhotoLampIntensity(v) {
  lampIntensity = Math.max(0, v);
  if (ptLamp) { ptLamp.intensity = lampIntensity; if (tracer && !exporting) tracer.updateLights(); }
}

export function updatePhotoMaterials() {
  if (!tracer) return;
  tracer.updateMaterials();
  tracer.reset();
}

export function updatePhotoEnv(env) {
  if (env !== undefined) envTexture = env;
  if (!tracer) return;
  syncEnv();
  tracer.updateEnvironment();
  tracer.reset();
}

export function markPhotoSceneDirty() {
  if (tracer) tracer.reset();
}

// Push live material-PROPERTY edits (roughness, metalness, clearcoat, …) into the
// tracer's GPU material buffer, then restart accumulation. reset() alone won't
// pick up property changes — updateMaterials() re-reads them.
export function syncPhotoMaterials() {
  if (tracer) { tracer.updateMaterials(); tracer.reset(); }
}

export function exitPhotoTracer() {
  if (tracer) {
    tracer.dispose();
    tracer = null;
  }
  // Hand the product back to the live scene and paint one clean raster frame.
  if (tracedObject && mainScene) mainScene.add(tracedObject);
  if (activeRenderer && mainScene && activeCamera) {
    activeRenderer.setRenderTarget(null);
    activeRenderer.render(mainScene, activeCamera);
  }
  tracedObject = mainScene = activeCamera = activeRenderer = envTexture = null;
}

// Alias kept for callers that use disposePhotoTracer().
export { exitPhotoTracer as disposePhotoTracer };
