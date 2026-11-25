import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createEnvironments } from "./environments.js";
import { loadProduct, applyFabric, applyPBRMaterial, initKTX2, loadEnvRoom, loadGLBObject } from "./product.js";
import { PBR_MATERIALS } from "./pbr-materials.js";
import { initUI, readStateFromURL } from "./ui.js";
import { configurationPayload, productConfigSlots } from "./config-state.js";
import { getRuntimeRenderProfile, canUsePathTracing } from "./runtime-capabilities.js";
import { loadPresets, applyPreset } from "./material-editor.js";
import inlineAssets from "./inline-assets.js";
let photoTracer = null;
let photoTracerPromise = null;
let externalTracePaused = false;
let pendingViewportResize = false;
function loadPhotoTracer() {
  if (!photoTracerPromise) {
    photoTracerPromise = import("./photo-tracer.js").then((module) => { photoTracer = module; return module; });
  }
  return photoTracerPromise;
}
const callPhoto = (name, ...args) => photoTracer?.[name]?.(...args);
const disposePhotoTracer = (...args) => callPhoto("disposePhotoTracer", ...args);
const updatePhotoMaterials = (...args) => callPhoto("updatePhotoMaterials", ...args);
const updatePhotoCamera = (...args) => callPhoto("updatePhotoCamera", ...args);
const updatePhotoEnv = (...args) => callPhoto("updatePhotoEnv", ...args);
const setPhotoRoom = (...args) => callPhoto("setPhotoRoom", ...args);
const addTracedObject = (...args) => callPhoto("addTracedObject", ...args);
const swapTracedProduct = (...args) => callPhoto("swapTracedProduct", ...args);
const setPhotoGround = (...args) => callPhoto("setPhotoGround", ...args);
const setPhotoEnvColor = (...args) => callPhoto("setPhotoEnvColor", ...args);
const setDenoise = (...args) => callPhoto("setDenoise", ...args);
const setDenoiseActive = (...args) => callPhoto("setDenoiseActive", ...args);
const setRenderBatch = (...args) => callPhoto("setRenderBatch", ...args);
const renderPhotoTracer = (...args) => callPhoto("renderPhotoTracer", ...args);
const renderWarmupPreview = (...args) => callPhoto("renderWarmupPreview", ...args);
const renderRasterPreview = (...args) => callPhoto("renderRasterPreview", ...args);
const markPhotoSceneDirty = (...args) => callPhoto("markPhotoSceneDirty", ...args);
const syncPhotoMaterials = (...args) => callPhoto("syncPhotoMaterials", ...args);
const setPhotoQuality = (...args) => callPhoto("setPhotoQuality", ...args);
const getPhotoSamples = (...args) => callPhoto("getPhotoSamples", ...args) || 0;
const renderStill = (...args) => loadPhotoTracer().then((module) => module.renderStill(...args));
const isExporting = () => Boolean(photoTracer?.isExporting?.());
const setPhotoFloor = (...args) => callPhoto("setPhotoFloor", ...args);
const setPhotoLampIntensity = (...args) => callPhoto("setPhotoLampIntensity", ...args);
import { PRODUCTS, DEFAULT_PRODUCT, currentProductId, productCatalogue } from "./products.js";
const CURRENT_PRODUCT = currentProductId();
const PAGE_PARAMS = new URLSearchParams(location.search);
const embedMode = PAGE_PARAMS.get("embed") === "1";
// UI theme is presentation only. Photo Render keeps one calibrated neutral
// studio so materials do not change exposure or bounce between dark and light UI.
const embeddedBackdrop = "#18181b";
if (embedMode) {
  document.body.classList.add("ui-hidden");
}

// ---- Analytics: pluggable event hook (GA dataLayer + callback + postMessage) ----
function postToParent(message) {
  try {
    if (!window.parent || window.parent === window) return false;
    const configured = window.CONFIGURATOR_BRAND?.parentOrigin || new URLSearchParams(location.search).get("parentOrigin");
    const target = configured ? new URL(configured, location.origin).origin : null;
    if (!target) return false;
    window.parent.postMessage(message, target);
    return true;
  } catch { return false; }
}

function track(event, data = {}) {
  const payload = { event, product: CURRENT_PRODUCT, ...data, ts: Date.now() };
  try { (window.dataLayer = window.dataLayer || []).push({ ...payload, event: `configurator_${event}` }); } catch {}
  try { if (typeof window.CONFIGURATOR_ANALYTICS === "function") window.CONFIGURATOR_ANALYTICS(payload); } catch {}
  postToParent({ type: "configurator:event", event: payload });
}

// ---- Pricing/stock/lead-time resolver: per-product registry fields, overridable
// by a window.CONFIGURATOR_PRICING[id] = { price, leadTime, stock } data file (real data
// drops in here without code changes). Falls back to "on application".
function priceInfo() {
  const o = (typeof window !== "undefined" && window.CONFIGURATOR_PRICING && window.CONFIGURATOR_PRICING[CURRENT_PRODUCT]) || {};
  const p = PRODUCTS[CURRENT_PRODUCT] || {};
  const approved = o.approved === true || p.pricing?.approved === true;
  if (!approved) return { price: null, leadTime: null, stock: null };
  return { price: o.price ?? p.price ?? null, leadTime: o.leadTime ?? p.leadTime ?? null, stock: o.stock ?? p.stock ?? null };
}
import { bakeFromPathTracer } from "./lightmap-bake.js";

// Detect the physical device, not the embedded viewport. The Sites configurator
// can place this renderer in a sub-768px iframe on a full desktop GPU; treating
// that as a phone disabled the high-quality material and denoise paths.
const compactTouchDevice = matchMedia("(pointer: coarse)").matches &&
                           Math.min(screen.width, screen.height) < 900;
const isMobile = navigator.userAgentData?.mobile === true ||
                 /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                 compactTouchDevice;

// ---- Camera presets (target chair at origin, ~1.15m tall) ------------------
const CAM_PRESETS = {
  hero: { pos: new THREE.Vector3(1.55, 1.0, 1.85), tgt: new THREE.Vector3(0, 0.52, 0) },
  front: { pos: new THREE.Vector3(0, 0.85, 2.5), tgt: new THREE.Vector3(0, 0.55, 0) },
  detail: { pos: new THREE.Vector3(0.62, 0.85, 0.85), tgt: new THREE.Vector3(0.1, 0.6, 0) },
  back: { pos: new THREE.Vector3(-1.3, 1.05, -1.9), tgt: new THREE.Vector3(0, 0.55, 0) },
};
// Boot defaults are FINISH-AWARE + per-slot: fabric slots start on a fabric, laminate
// slots on a laminate (so a desk doesn't boot wearing velvet). Built from the active
// product's slotFinish so the slots track whatever product is loaded.
const DEFAULTS = { env: "studio", cam: "hero" };
{
  const p0 = PRODUCTS[CURRENT_PRODUCT];
  for (const s of productConfigSlots(p0)) DEFAULTS[s] = p0?.defaults?.[s];
}

const app = document.getElementById("app");
// Boot "loading" is shown in the render pill — no separate splash screen.
const bootPill = document.getElementById("pt-spinner");
const bootPillBar = bootPill?.querySelector(".pt-bar i");
const bootPillText = bootPill?.querySelector("span");
function setBootLoading(pct, text) {
  if (!bootPill) return;
  bootPill.classList.add("show");
  if (text != null && bootPillText) bootPillText.textContent = text;
  if (pct != null && bootPillBar) bootPillBar.style.width = `${pct}%`;
}

function showFatalState(title, detail) {
  const existing = document.getElementById("fatal-state");
  if (existing) return;
  const el = document.createElement("section");
  el.id = "fatal-state";
  el.setAttribute("role", "alert");
  el.style.cssText = "position:fixed;inset:0;z-index:120;display:grid;place-items:center;padding:24px;background:#0b0b0c;color:#f5f5f6;text-align:center;font-family:Inter,system-ui,sans-serif";
  el.innerHTML = `<div style="max-width:420px"><p style="font:600 20px/1.2 Georgia,serif;margin-bottom:10px">${title}</p><p style="font-size:13px;line-height:1.6;color:rgba(245,245,246,.65);margin-bottom:18px">${detail}</p><button type="button" id="fatal-retry" style="min-height:44px;padding:0 18px;border:1px solid rgba(255,255,255,.22);border-radius:10px;background:#f4f4f5;color:#111;font:600 13px Inter,system-ui,sans-serif;cursor:pointer">Retry</button></div>`;
  document.body.appendChild(el);
  el.querySelector("#fatal-retry")?.addEventListener("click", () => location.reload());
}

// Boot diagnostics: stage trace behind ?debug; error/rejection handlers always
// on so a silent boot failure surfaces loudly (this is how the material-editor
// null-host crash was caught).
const DEBUG = new URLSearchParams(location.search).has("debug");
const BT = (m) => DEBUG && console.log(`[boot] ${Math.round(performance.now())}ms — ${m}`);
addEventListener("error", (e) => console.error("[boot:error]", e.message, "@", e.filename, e.lineno));
addEventListener("unhandledrejection", (e) => console.error("[boot:rejection]", e.reason?.message || e.reason));
BT("module start");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 100);
camera.focusDistance = 2.4; // ~hero distance to the chair; retuned per camera below

// preserveDrawingBuffer lets us read the canvas for screenshots + the 4K render
// export at any time. Negligible cost here: render-on-demand + a static scene.
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
} catch (error) {
  showFatalState("3D preview unavailable", "This browser could not create a WebGL renderer. Check hardware acceleration, then retry.");
  throw error;
}
const gl = renderer.getContext();
const glRendererName = (() => {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { return ""; }
})();
// `instanceof WebGL2RenderingContext` can be false inside a hosted iframe even
// when the context is genuinely WebGL 2 (cross-realm constructor identity).
// Query the context itself so explicit Photo Render requests work on Sites.
const glWebgl2 = /^WebGL 2/i.test(String(gl.getParameter(gl.VERSION)));
const renderProfile = getRuntimeRenderProfile({
  webgl2: glWebgl2,
  rendererName: glRendererName,
  deviceMemory: navigator.deviceMemory || 4,
  hardwareConcurrency: navigator.hardwareConcurrency || 4,
  devicePixelRatio,
  isMobile,
  saveData: navigator.connection?.saveData === true,
  prefersReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
});
const pathTracingRequested = new URLSearchParams(location.search).get("pt") === "1";
// Photo Render is desktop-first. A balanced desktop profile is allowed and gets
// full material maps; physical phones/tablets stay on the live renderer.
const pathTracingAvailable = canUsePathTracing({ profile: renderProfile, explicitlyRequested: pathTracingRequested, webgl2: glWebgl2, allowBalanced: !isMobile });
const useFullMaterialMaps = renderProfile.fullMaterialMaps || (pathTracingRequested && !isMobile);
document.body.dataset.cfgWebgl2 = String(glWebgl2);
document.body.dataset.cfgProfile = renderProfile.key;
document.body.dataset.cfgIsMobile = String(isMobile);
document.body.dataset.cfgPathTracing = String(pathTracingAvailable);
document.body.dataset.cfgTracePaused = "false";
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, renderProfile.pixelRatio));
renderer.shadowMap.enabled = false; // gutted: no cast shadows in raster (dropped the 2048² studio-key shadow); IBL + baked AO handle grounding
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // static scene: bake shadows on demand only
const refreshShadows = () => (renderer.shadowMap.needsUpdate = true);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);
initKTX2(renderer); // detect GPU-supported KTX2 formats before any texture loads

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.6;
controls.maxDistance = 5.5;
controls.maxPolarAngle = Math.PI / 2 + 0.05;
controls.autoRotate = renderProfile.autoRotate && !isMobile && !navigator.connection?.saveData && !matchMedia("(prefers-reduced-motion: reduce)").matches;
controls.autoRotateSpeed = 0.45;
let controlsActive = false; // true while the user is dragging the product
controls.addEventListener("start", () => { controls.autoRotate = false; controlsActive = true; });
controls.addEventListener("end", () => { controlsActive = false; needsRender = true; });

// Camera-mounted fill "headlamp": a PointLight parented to the camera so it follows
// every orbit and keeps the view-facing surfaces lit. Parenting requires the camera
// to be in the scene graph for the renderer to collect the light. Mirrored in the PT
// (ptScene) by photo-tracer.js so it emits in both views. Default 20 cd; debug slider.
const cameraLamp = new THREE.PointLight(0xffffff, 20, 0, 2);
camera.add(cameraLamp);
scene.add(camera);

// Camera flight animation
let flight = null;
let needsRender = true;   // declared early to prevent TDZ/ReferenceError when top-level code (updateProbe, updateContactShadow, FEATURE applies, UI callbacks) runs during module init / after awaits
function flyTo(presetName, instant = false) {
  const p = CAM_PRESETS[presetName];
  if (!p) return;
  if (instant) {
    camera.position.copy(p.pos);
    controls.target.copy(p.tgt);
    controls.update();
    return;
  }
  flight = {
    t: 0,
    fromPos: camera.position.clone(),
    fromTgt: controls.target.clone(),
    toPos: p.pos.clone(),
    toTgt: p.tgt.clone(),
  };
  controls.autoRotate = false;
}

// ---- Boot -------------------------------------------------------------------
const env = createEnvironments(scene, renderer, inlineAssets);

const swatches = [
  // Full-PBR fabrics (upholstery) + laminates, grouped in the swatch UI by category
  // (+ any user-saved presets). Embed mode keeps only the lightweight colour-only finishes.
  ...PBR_MATERIALS.filter((m) => (m.category === "upholstery" || m.category === "laminate") && (!embedMode || (m.color && !m.maps)))
    .map((m) => ({ id: m.id, name: m.name, thumb: m.thumb, category: m.category, pbr: m })),
  ...loadPresets(),
];
setBootLoading(30, "Loading…");

const state = readStateFromURL(swatches, DEFAULTS, PRODUCTS[CURRENT_PRODUCT]);

let materials, chair;
try {
  ({ materials, group: chair } = await loadProduct(
    scene,
    (f) => {
      setBootLoading(30 + f * 60);
    },
    inlineAssets,
    CURRENT_PRODUCT
  ));
} catch (error) {
  console.error("product load failed:", error);
  showFatalState("Product preview unavailable", "The selected product could not be loaded. Retry the preview or choose another product.");
  throw error;
}

BT("product GLB loaded");

// Multi-product experiment: load product 2 (moon desk) beside the chair, held OUT
// of the trace scene until the chair converges (cutoff), then dropped in to trace.
// Raster scene for UNSELECTED products — drawn cheaply over the PT result so they
// don't burn path-tracer samples until selected. Transparent bg (geometry only).
const rasterScene = new THREE.Scene();
rasterScene.background = null;
// Multi-product system is kept wired but no second product is loaded right now.
// To add one back: loadGLBObject("assets/products/<name>.glb").then((g) => {
//   …scale/place g; clone per-slot materials; set desk2 = g and
//   deskP = { name, group: g, materials, sel: { a:null, b:null, activeSlot:"a" } }; })
// The loop hook (addTracedObject), click-to-select, and active-product editing all
// pick it up automatically once desk2/deskP are set.
let desk2 = null, deskP = null, desk2InPT = false;

// Click a product to focus the orbit on it (raycast; a drag still orbits).
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let _downXY = null;
function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const r = box.getBoundingSphere(new THREE.Sphere()).radius;
  const dir = camera.position.clone().sub(controls.target).normalize(); // keep current view angle
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov) * 0.5)) * 1.3;
  flight = { t: 0, fromPos: camera.position.clone(), fromTgt: controls.target.clone(), toPos: center.clone().add(dir.multiplyScalar(dist)), toTgt: center };
  controls.autoRotate = false;
}
renderer.domElement.addEventListener("pointerdown", (e) => { _downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!_downXY) return;
  const moved = Math.hypot(e.clientX - _downXY[0], e.clientY - _downXY[1]); _downXY = null;
  if (moved > 5) return; // it was a drag (orbit), not a click
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  const targets = [chair, desk2].filter(Boolean);
  const hits = _ray.intersectObjects(targets, true);
  if (!hits.length) return;
  let root = hits[0].object;
  while (root.parent && !targets.includes(root)) root = root.parent;
  if (root === chair) { setActive(chairP); frameObject(root); }
  else if (root === desk2 && deskP) { setActive(deskP); frameObject(root); }
});

// Bind the material UI to the selected product (per-product slot selections).
function setActive(P) {
  if (!P || P === activeP) return;
  activeP.sel = { ...Object.fromEntries(productConfigSlots(product).map((slot) => [slot, state[slot]])), activeSlot: state.activeSlot }; // save outgoing selections
  activeP = P;
  // Both products stay path-traced together; selecting just rebinds editing + focus.
  Object.assign(state, P.sel, { activeSlot: P.sel.activeSlot || productConfigSlots(product)[0] || "" });
  if (productNameEl) productNameEl.textContent = P.name;
  ui.refreshGrid();
  ui.syncSlots?.();
}
// Product-only trace scene: the chair is traced alone, lit by the HDRI (IBL) on
// a clean alpha — no floor or room geometry. This is the fastest, lowest-noise
// case. (loadEnvRoom/setPhotoRoom remain available to reintroduce a traced
// environment later.)

// Generic: title + heading come from the product registry, not hardcoded copy.
const product = PRODUCTS[CURRENT_PRODUCT];
document.title = `${product.name} — 3D Product Configurator`;
const productNameEl = document.getElementById("product-name");
if (productNameEl) productNameEl.textContent = product.name;

// ---- Catalogue dropdown: click the product name to search + switch products.
// Selecting reloads with ?product=<id> (clean reinit). Scales to the whole catalogue.
(function productDropdown() {
  const nameEl = document.getElementById("product-name");
  if (!nameEl) return;
  const items = productCatalogue();
  nameEl.style.cursor = "pointer";
  nameEl.title = "Switch product";
  const caret = document.createElement("span");
  caret.textContent = " ▾"; caret.style.cssText = "opacity:0.45;font-size:0.62em;vertical-align:middle";
  nameEl.appendChild(caret);

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:90;display:none;align-items:flex-start;justify-content:center;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);padding-top:11vh";
  const card = document.createElement("div");
  card.style.cssText = "width:min(92vw,440px);max-height:72vh;display:flex;flex-direction:column;background:#141416;border:1px solid rgba(255,255,255,0.12);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,0.6);overflow:hidden";
  const search = document.createElement("input");
  search.type = "text"; search.placeholder = "Search products…";
  search.style.cssText = "border:0;border-bottom:1px solid rgba(255,255,255,0.1);background:transparent;color:#f5f5f6;font:inherit;font-size:14px;padding:14px 16px;outline:none";
  const list = document.createElement("div");
  list.style.cssText = "overflow-y:auto;padding:6px";
  card.append(search, list); overlay.appendChild(card); document.body.appendChild(overlay);

  const close = () => { overlay.style.display = "none"; };
  const render = (q) => {
    const ql = q.trim().toLowerCase();
    list.innerHTML = "";
    const filtered = items.filter((p) => !ql || p.name.toLowerCase().includes(ql) || p.category.toLowerCase().includes(ql));
    if (!filtered.length) { const e = document.createElement("div"); e.textContent = "No matches"; e.style.cssText = "padding:14px 12px;color:rgba(245,245,246,0.45);font-size:13px"; list.appendChild(e); return; }
    for (const p of filtered) {
      const active = p.id === CURRENT_PRODUCT;
      const rowB = document.createElement("button");
       rowB.style.cssText = `display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;min-height:44px;text-align:left;font:inherit;font-size:13.5px;padding:10px 12px;border:0;border-radius:9px;cursor:pointer;background:${active ? "rgba(255,255,255,0.10)" : "transparent"};color:${active ? "#fff" : "rgba(245,245,246,0.82)"}`;
      rowB.onmouseenter = () => { if (!active) rowB.style.background = "rgba(255,255,255,0.05)"; };
      rowB.onmouseleave = () => { if (!active) rowB.style.background = "transparent"; };
      const nm = document.createElement("span"); nm.textContent = p.name;
      const cat = document.createElement("span"); cat.textContent = p.category; cat.style.cssText = "opacity:0.4;font-size:11px;text-transform:capitalize;white-space:nowrap";
      rowB.append(nm, cat);
      rowB.onclick = () => { if (active) { close(); return; } const u = new URL(location.href); u.searchParams.set("product", p.id); location.href = u.toString(); };
      list.appendChild(rowB);
    }
  };
  nameEl.addEventListener("click", () => { overlay.style.display = "flex"; search.value = ""; render(""); search.focus(); });
  search.addEventListener("input", () => render(search.value));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
})();

// ---- Collapsible tool launcher (bottom-left) — one tidy ⚙ Tools menu -----------
const toolRail = document.createElement("div");
toolRail.id = "tool-rail";
toolRail.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:45;display:flex;flex-direction:column;gap:6px;align-items:flex-start";
const toolBody = document.createElement("div");
toolBody.style.cssText = "display:none;flex-direction:column-reverse;gap:6px;align-items:flex-start";
const _btnStyle = "min-height:44px;font:600 11px/1 ui-monospace,monospace;padding:7px 11px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);background:rgba(0,0,0,0.5);color:rgba(245,245,246,0.85);cursor:pointer;backdrop-filter:blur(6px);white-space:nowrap";
const toolHeader = document.createElement("button");
toolHeader.textContent = "⚙ Tools"; toolHeader.setAttribute("aria-label", "Tools menu"); toolHeader.style.cssText = _btnStyle;
toolHeader.onclick = () => { const open = toolBody.style.display === "flex"; toolBody.style.display = open ? "none" : "flex"; toolHeader.style.background = open ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.92)"; toolHeader.style.color = open ? "rgba(245,245,246,0.85)" : "#111"; };
toolRail.append(toolBody, toolHeader);
document.body.appendChild(toolRail);
function addTool(label) {
  const b = document.createElement("button");
  b.textContent = label; b._on = false; b.style.cssText = _btnStyle;
  b._paint = () => { b.style.background = b._on ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.5)"; b.style.color = b._on ? "#111" : "rgba(245,245,246,0.85)"; };
  toolBody.appendChild(b);
  return b;
}

// ---- Dimensions + human-scale silhouette (space planning) ----------------------
// Real-world W×D×H readout (the model is normalised to true metres) plus a 1.7 m
// figure placed beside the product so scale reads instantly.
(function dimensionsFeature() {
  const size = new THREE.Box3().setFromObject(chair).getSize(new THREE.Vector3());
  const cm = (m) => Math.round(m * 100);
  const readout = document.createElement("div");
  readout.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:40;display:none;font:600 12px/1 ui-monospace,monospace;color:#f5f5f6;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);padding:7px 12px;border-radius:8px;pointer-events:none";
  readout.textContent = `W ${cm(size.x)} · D ${cm(size.z)} · H ${cm(size.y)} cm`;
  document.body.appendChild(readout);

  // 3D silhouette (lives in the scene so it scales/orbits correctly)
  const c = document.createElement("canvas"); c.width = 128; c.height = 460;
  const g = c.getContext("2d"); g.fillStyle = "rgba(150,160,180,0.55)";
  g.beginPath(); g.arc(64, 56, 32, 0, 7); g.fill();
  g.beginPath(); g.roundRect(30, 90, 68, 360, 28); g.fill();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const fig = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 1.7), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  fig.position.set(-(size.x / 2 + 0.5), 0.85, 0); fig.visible = false; fig.renderOrder = 2;
  scene.add(fig);
  const billboard = () => { fig.rotation.y = Math.atan2(camera.position.x - fig.position.x, camera.position.z - fig.position.z); };
  controls.addEventListener("change", () => { if (fig.visible) { billboard(); needsRender = true; } });

  const btn = addTool("Dimensions");
  btn.addEventListener("click", () => {
    btn._on = !btn._on; btn._paint();
    readout.style.display = btn._on ? "block" : "none"; fig.visible = btn._on;
    if (btn._on) billboard();
    needsRender = true;
  });
})();

// ---- Shortlist / moodboard (localStorage) -------------------------------------
// Save the current product + finish config; reopen any saved one. Persists locally.
(function shortlistFeature() {
  const KEY = "configurator_shortlist_v1";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const store = (a) => localStorage.setItem(KEY, JSON.stringify(a));
  const current = () => ({ product: CURRENT_PRODUCT, config: configurationPayload(state, product), ts: Date.now() });
  const urlFor = (c) => { const u = new URL(location.origin + location.pathname); const s = u.searchParams; if (c.product) s.set("product", c.product); for (const [slot, value] of Object.entries(c.config?.slots || {})) if (value) s.set(slot, value); if (c.config?.env) s.set("env", c.config.env); if (c.config?.cam) s.set("cam", c.config.cam); return u.toString(); };
  const nameFor = (c) => (PRODUCTS[c.product]?.name || c.product || "Product");

  const tBtn = addTool("");
  const refreshBtn = () => (tBtn.textContent = `♡ Shortlist (${load().length})`);
  refreshBtn();

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;left:130px;bottom:12px;z-index:47;width:min(86vw,300px);max-height:60vh;display:none;flex-direction:column;background:#141416;border:1px solid rgba(255,255,255,0.12);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,0.6);overflow:hidden";
  const headRow = document.createElement("div");
  headRow.style.cssText = "padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08)";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "＋ Save current";
  saveBtn.style.cssText = "width:100%;font:inherit;font-size:12px;font-weight:600;padding:7px 0;border-radius:8px;border:0;background:var(--accent-grad,#f4f4f5);color:#111;cursor:pointer";
  headRow.appendChild(saveBtn);
  const list = document.createElement("div");
  list.style.cssText = "overflow-y:auto;padding:6px";
  panel.append(headRow, list); document.body.appendChild(panel);

  function renderList() {
    const items = load(); list.innerHTML = "";
    if (!items.length) { const e = document.createElement("div"); e.textContent = "No saved configs yet"; e.style.cssText = "padding:12px;color:rgba(245,245,246,0.4);font-size:12px"; list.appendChild(e); return; }
    items.forEach((c, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;cursor:pointer";
      row.onmouseenter = () => (row.style.background = "rgba(255,255,255,0.05)");
      row.onmouseleave = () => (row.style.background = "transparent");
      const txt = document.createElement("div"); txt.style.cssText = "flex:1;min-width:0";
      txt.innerHTML = `<div style="font-size:12.5px;color:#f5f5f6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${nameFor(c)}</div><div style="font-size:10.5px;color:rgba(245,245,246,0.45)">${c.a || "—"} / ${c.b || "—"}</div>`;
      txt.onclick = () => (location.href = urlFor(c));
      const del = document.createElement("button"); del.textContent = "×";
      del.style.cssText = "border:0;background:transparent;color:rgba(245,245,246,0.4);font-size:16px;cursor:pointer;padding:0 4px";
      del.onclick = (e) => { e.stopPropagation(); const arr = load(); arr.splice(i, 1); store(arr); renderList(); refreshBtn(); };
      row.append(txt, del); list.appendChild(row);
    });
  }
  saveBtn.onclick = () => { const arr = load(); arr.unshift(current()); store(arr.slice(0, 50)); renderList(); refreshBtn(); ui.showToast?.("Saved to shortlist"); };
  tBtn.onclick = () => { const open = panel.style.display === "flex"; panel.style.display = open ? "none" : "flex"; if (!open) renderList(); };
})();

// ---- White-label theming -------------------------------------------------------
// Brand the configurator per host/client: accent colour, brand name, logo. Driven
// by URL params (?accent=RRGGBB&brand=Name&logo=URL) or a window.CONFIGURATOR_BRAND config
// (set before the bundle loads, e.g. by the embedding page). Foundation for embeds.
(function branding() {
  const p = new URLSearchParams(location.search);
  const cfg = (typeof window !== "undefined" && window.CONFIGURATOR_BRAND) || {};
  const accent = cfg.accent || p.get("accent");
  const brand = cfg.name || p.get("brand");
  const logo = cfg.logo || p.get("logo");
  if (accent && /^#?[0-9a-f]{6}$/i.test(accent)) {
    const c = accent[0] === "#" ? accent : "#" + accent;
    const root = document.documentElement.style;
    root.setProperty("--accent", c);
    root.setProperty("--accent-grad", c);
    root.setProperty("--accent-2", c);
  }
  if (brand) document.title = `${brand} — 3D Product Configurator`;
  if (logo) {
    const ph = document.querySelector("#panel .htext");
    if (ph) { const img = document.createElement("img"); img.src = logo; img.alt = brand || "logo"; img.style.cssText = "max-height:22px;max-width:120px;display:block;margin-bottom:6px;object-fit:contain"; ph.insertBefore(img, ph.firstChild); }
  }
})();

// ---- Branded spec sheet / quote (print → PDF) ----------------------------------
// Opens a branded one-pager: live render thumbnail + config + dimensions + link,
// with a Print button (browser "Save as PDF"). Dependency-free; brand-aware.
(function quoteFeature() {
  const btn = addTool("⎙ Spec sheet");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  btn.onclick = () => {
    let img = "";
    try { if (photoMode) renderPhotoTracer(); else renderer.render(scene, camera); img = renderer.domElement.toDataURL("image/png"); } catch (e) { console.warn("canvas capture failed", e); }
    const size = new THREE.Box3().setFromObject(chair).getSize(new THREE.Vector3());
    const dims = `${Math.round(size.x * 100)} × ${Math.round(size.z * 100)} × ${Math.round(size.y * 100)} cm (W×D×H)`;
    const p = new URLSearchParams(location.search);
    const brand = (window.CONFIGURATOR_BRAND && window.CONFIGURATOR_BRAND.name) || p.get("brand") || "Configurator";
    const accent = ((window.CONFIGURATOR_BRAND && window.CONFIGURATOR_BRAND.accent) || p.get("accent") || "111111").replace("#", "");
    const pi = priceInfo();
    const rows = [
      ["Product", product.name],
      ...product.fabricSlots.map((s) => [`Finish ${s.toUpperCase()}`, state[s] || "—"]),
      ["Dimensions", dims],
      ["Reference", `${product.id}-${productConfigSlots(product).map((slot) => state[slot] || "none").join("-") || "fixed"}`],
      ["Price", pi.price ? `£${pi.price}` : "On application"],
      ...(pi.leadTime ? [["Lead time", pi.leadTime]] : []),
      ...(pi.stock ? [["Availability", pi.stock]] : []),
    ];
    const win = window.open("", "_blank");
    if (!win) { ui.showToast?.("Allow pop-ups to open the spec sheet"); return; }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(brand)} — ${esc(product.name)}</title>
      <style>
        *{box-sizing:border-box} body{font:14px/1.5 -apple-system,Inter,Segoe UI,sans-serif;color:#1a1a1a;margin:0;padding:40px;max-width:820px;margin:auto}
        .top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #${esc(accent)};padding-bottom:10px;margin-bottom:24px}
        .brand{font-weight:800;font-size:20px;letter-spacing:.02em} .doc{color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.2em}
        h1{font-size:26px;margin:0 0 18px} .hero{width:100%;border:1px solid #eee;border-radius:10px;margin-bottom:24px}
        table{width:100%;border-collapse:collapse} td{padding:10px 4px;border-bottom:1px solid #eee} td:first-child{color:#888;width:160px}
        .foot{margin-top:28px;color:#888;font-size:12px;word-break:break-all}
        .print{margin-top:24px;padding:11px 22px;border:0;border-radius:9px;background:#${esc(accent)};color:#fff;font-weight:700;font-size:14px;cursor:pointer}
        @media print{.print{display:none}}
      </style></head><body>
      <div class="top"><div class="brand">${esc(brand)}</div><div class="doc">Specification</div></div>
      <h1>${esc(product.name)}</h1>
      ${img ? `<img class="hero" src="${img}">` : ""}
      <table>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join("")}</table>
      <div class="foot">Configure live: ${esc(location.href)}</div>
      <button class="print" onclick="window.print()">Print / Save as PDF</button>
      </body></html>`);
    win.document.close();
  };
})();

// ---- Embed / iframe postMessage API --------------------------------------------
// Host page can drive the configurator: postMessage({type:'configurator:setProduct',product})
// or 'configurator:setAccent'. The configurator announces 'configurator:ready' with the catalogue.
// See /embed-example.html.
(function embedAPI() {
  const post = (msg) => postToParent(msg);
  const configuredOrigin = window.CONFIGURATOR_BRAND?.parentOrigin;
  const parentOrigin = configuredOrigin ? (() => { try { return new URL(configuredOrigin, location.origin).origin; } catch { return null; } })() : location.origin;
  post({ type: "configurator:ready", product: CURRENT_PRODUCT, products: productCatalogue() });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !parentOrigin || e.origin !== parentOrigin) return;
    const m = e.data; if (!m || typeof m !== "object") return;
    if (m.type === "configurator:setProduct" && PRODUCTS[m.product]) {
      const u = new URL(location.href); u.searchParams.set("product", m.product); location.href = u.toString();
    } else if (m.type === "configurator:setAccent" && /^#?[0-9a-f]{6}$/i.test(m.accent || "")) {
      const c = m.accent[0] === "#" ? m.accent : "#" + m.accent;
      document.documentElement.style.setProperty("--accent", c);
      document.documentElement.style.setProperty("--accent-grad", c);
    } else if (m.type === "configurator:setTracePaused") {
      setExternalTracePaused(m.paused === true);
    }
  });
})();

// ---- PWA: register the service worker (production build only — keeps dev HMR
// clean). Manifest + icons make the app installable.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// ---- Accessibility: respect reduced-motion (no auto-spin) + label the canvas ----
(function a11y() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) controls.autoRotate = false;
    const cv = renderer.domElement;
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", `Interactive 3D view of ${product.name}`);
  } catch {}
})();

// ---- Scene presets: one-tap studio looks (exposure + backdrop + key) -----------
(function scenePresets() {
  const PRESETS = [
    { name: "Studio", exp: 1.12, bg: 0xf2f2f2, key: 1.7 },
    { name: "Charcoal", exp: 1.0, bg: 0x1a1a1c, key: 1.45 },
    { name: "Soft", exp: 1.2, bg: 0xeae6df, key: 1.25 },
    { name: "Punch", exp: 1.32, bg: 0xffffff, key: 2.2 },
  ];
  let keyLight = null; scene.traverse((n) => { if (n.isDirectionalLight && n.intensity > 0.3) keyLight = n; });
  let i = 0;
  const apply = (p) => {
    renderer.toneMappingExposure = p.exp;
    if (scene.background && scene.background.isColor) scene.background.set(p.bg);
    setPhotoEnvColor("#" + p.bg.toString(16).padStart(6, "0"));
    if (keyLight) keyLight.intensity = p.key;
    needsRender = true; if (photoMode) markPhotoSceneDirty();
  };
  const btn = addTool("Scene: Studio");
  btn.addEventListener("click", () => { i = (i + 1) % PRESETS.length; const p = PRESETS[i]; apply(p); btn.textContent = `Scene: ${p.name}`; });
})();

// ---- Fabric from photo: upload an inspiration image → nearest swatch by colour --
// Pure client-side: average the photo's colour, compare to each swatch's average
// (computed from its thumbnail, cached), apply the closest to the active slot.
(function fabricFromPhoto() {
  const loadImg = (url) => new Promise((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = rej; im.src = url; });
  const avgColor = (im) => {
    const s = 24, c = document.createElement("canvas"); c.width = s; c.height = s;
    const g = c.getContext("2d"); g.drawImage(im, 0, 0, s, s);
    const px = g.getImageData(0, 0, s, s).data; let r = 0, gg = 0, b = 0, n = 0;
    for (let k = 0; k < px.length; k += 4) { r += px[k]; gg += px[k + 1]; b += px[k + 2]; n++; }
    return [r / n, gg / n, b / n];
  };
  const dist = (a, b) => { const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]; return 2 * dr * dr + 4 * dg * dg + 3 * db * db; };
  let cache = null;
  async function swatchColors() {
    if (cache) return cache;
    cache = [];
    for (const sw of swatches) { try { cache.push({ sw, c: avgColor(await loadImg(sw.thumb || sw.tile)) }); } catch {} }
    return cache;
  }
  async function match(file) {
    const url = URL.createObjectURL(file);
    let target; try { target = avgColor(await loadImg(url)); } finally { URL.revokeObjectURL(url); }
    const list = await swatchColors();
    let best = null, bd = Infinity;
    for (const e of list) { const dd = dist(target, e.c); if (dd < bd) { bd = dd; best = e.sw; } }
    if (!best) return;
    const slot = state.activeSlot && product.fabricSlots.includes(state.activeSlot) ? state.activeSlot : product.fabricSlots[0];
    if (!slot) { ui.showToast?.("No fabric slot to match"); return; }
    state[slot] = best.id;
    applySwatch(slot, best); refreshShadows(); updateProbe();
    if (photoMode) { updatePhotoMaterials(materials, state.env); markPhotoSceneDirty(); }
    ui.refreshGrid?.(); ui.syncSlots?.(); needsRender = true;
    ui.showToast?.(`Matched ${slot.toUpperCase()}: ${best.name}`);
  }
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/*"; input.style.display = "none"; document.body.appendChild(input);
  input.addEventListener("change", () => { const f = input.files[0]; if (f) match(f).catch((e) => { console.error("match failed", e); ui.showToast?.("Match failed"); }); input.value = ""; });
  addTool("Match from photo").addEventListener("click", () => input.click());
})();

// ---- Compare mode: before/after wipe (snapshot vs live) ------------------------
(function compareFeature() {
  let overlay = null;
  const cBtn = addTool("Compare");
  const open = () => {
    let snap; try { if (photoMode) renderPhotoTracer(); else renderer.render(scene, camera); snap = renderer.domElement.toDataURL("image/png"); } catch { ui.showToast?.("Compare unavailable"); cBtn._on = false; cBtn._paint(); return; }
    overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:60;pointer-events:none";
    const img = document.createElement("img");
    img.src = snap; img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;clip-path:inset(0 50% 0 0)";
    const handle = document.createElement("div");
    handle.style.cssText = "position:absolute;top:0;bottom:0;left:50%;width:2px;background:#fff;box-shadow:0 0 8px rgba(0,0,0,0.5);pointer-events:auto;cursor:ew-resize";
    const grip = document.createElement("div"); grip.textContent = "⇆";
    grip.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font-size:13px";
    handle.appendChild(grip);
    const mk = (t, side) => { const l = document.createElement("div"); l.textContent = t; l.style.cssText = `position:absolute;top:14px;${side}:14px;font:600 11px ui-monospace,monospace;color:#fff;background:rgba(0,0,0,0.5);padding:5px 9px;border-radius:7px;pointer-events:none`; return l; };
    const close = document.createElement("button"); close.textContent = "✕ Close compare";
    close.style.cssText = "position:absolute;bottom:14px;left:50%;transform:translateX(-50%);pointer-events:auto;font:600 11px ui-monospace,monospace;padding:8px 14px;border-radius:9px;border:0;background:#fff;color:#111;cursor:pointer";
    close.onclick = () => { overlay.remove(); overlay = null; cBtn._on = false; cBtn._paint(); };
    overlay.append(img, handle, mk("Saved", "left"), mk("Live", "right"), close);
    document.body.appendChild(overlay);
    let dragging = false;
    const setX = (cx) => { const x = Math.max(2, Math.min(98, (cx / window.innerWidth) * 100)); handle.style.left = x + "%"; img.style.clipPath = `inset(0 ${100 - x}% 0 0)`; };
    handle.addEventListener("pointerdown", () => (dragging = true));
    window.addEventListener("pointermove", (e) => dragging && setX(e.clientX));
    window.addEventListener("pointerup", () => (dragging = false));
  };
  cBtn.addEventListener("click", () => { cBtn._on = !cBtn._on; cBtn._paint(); if (cBtn._on) open(); else { overlay?.remove(); overlay = null; } });
})();

// ---- Hotspots: data-driven feature pins (product.hotspots = [{label,pos}]) ------
(function hotspotsFeature() {
  // Auto-generate hotspots from the product's named part meshes when none are
  // hand-authored — so every product gets meaningful callouts for free.
  const autoHotspots = () => {
    const LABELS = { mirror: "Mirror", led: "LED lighting", taps: "Mixer taps", neck: "Tap neck", basin: "Wash basin", body: "Basin", base: "Base", legs: "Legs", feet: "Feet", foot: "Feet", chrome: "Chrome frame", black: "Frame", frame: "Frame", a: "Upholstery", b: "Piping / secondary", c: "Detail trim", handle: "Handle", blower: "Dryer", wheels: "Castors", port: "Cable port", ports: "Cable ports", slides: "Drawer", buttons: "Controls", internals: "Storage" };
    const groups = {};
    chair.traverse((n) => { if (!n.isMesh) return; const base = n.name.toLowerCase().replace(/\.\d+$/, ""); const lab = LABELS[base]; if (!lab) return; (groups[base] = groups[base] || { label: lab, box: new THREE.Box3() }).box.expandByObject(n); });
    return Object.values(groups).slice(0, 6).map((g) => { const c = g.box.getCenter(new THREE.Vector3()); return { label: g.label, pos: [c.x, c.y, c.z] }; });
  };
  const defs = (product.hotspots && product.hotspots.length) ? product.hotspots : autoHotspots();
  if (!defs.length) return;
  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;z-index:35;pointer-events:none;display:none";
  document.body.appendChild(layer);
  const pins = defs.map((h) => {
    const p = document.createElement("button"); p.textContent = "+"; p.setAttribute("aria-label", h.label);
     p.style.cssText = "position:absolute;width:44px;height:44px;border-radius:50%;border:2px solid #fff;background:rgba(0,0,0,0.62);color:#fff;font-size:15px;line-height:1;cursor:pointer;pointer-events:auto;transform:translate(-50%,-50%)";
    const tip = document.createElement("span"); tip.textContent = h.label;
    tip.style.cssText = "position:absolute;left:28px;top:50%;transform:translateY(-50%);white-space:nowrap;font:600 11px ui-monospace,monospace;color:#fff;background:rgba(0,0,0,0.62);padding:3px 7px;border-radius:6px;display:none";
    p.appendChild(tip);
    p.onmouseenter = () => (tip.style.display = "block");
    p.onmouseleave = () => (tip.style.display = "none");
    layer.appendChild(p);
    return { p, v: new THREE.Vector3(...h.pos) };
  });
  const update = () => { if (layer.style.display === "none") return; for (const pin of pins) { const v = pin.v.clone().project(camera); pin.p.style.left = (v.x * 0.5 + 0.5) * window.innerWidth + "px"; pin.p.style.top = (-v.y * 0.5 + 0.5) * window.innerHeight + "px"; pin.p.style.display = v.z < 1 ? "block" : "none"; } };
  controls.addEventListener("change", update); window.addEventListener("resize", update);
  const btn = addTool("Hotspots");
  btn.addEventListener("click", () => { btn._on = !btn._on; btn._paint(); layer.style.display = btn._on ? "block" : "none"; update(); });
})();

// ---- Lead capture: enquiry form attached to the current config -----------------
(function leadFeature() {
  const btn = addTool("Enquire");
  btn.addEventListener("click", () => {
    document.getElementById("lead-modal")?.remove();
    const m = document.createElement("div"); m.id = "lead-modal";
    const configSummary = productConfigSlots(product).map((slot) => `${slot.toUpperCase()}: ${state[slot] || "—"}`).join(" · ") || "Fixed finish product";
    m.style.cssText = "position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px)";
    m.innerHTML = `<div style="width:min(92vw,360px);background:#141416;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:20px">
      <div style="font-size:15px;font-weight:700;color:#f5f5f6;margin-bottom:4px">Enquire — ${product.name}</div>
      <div style="font-size:12px;color:rgba(245,245,246,0.5);margin-bottom:14px">${configSummary}</div>
      <input id="lead-name" placeholder="Name" style="width:100%;margin-bottom:8px;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:#f5f5f6;font:inherit">
      <input id="lead-email" placeholder="Email" type="email" style="width:100%;margin-bottom:8px;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:#f5f5f6;font:inherit">
      <textarea id="lead-msg" placeholder="Message (optional)" rows="3" style="width:100%;margin-bottom:12px;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:#f5f5f6;font:inherit;resize:vertical"></textarea>
      <div style="display:flex;gap:8px"><button id="lead-cancel" style="flex:1;padding:10px;border-radius:9px;border:1px solid rgba(255,255,255,0.16);background:transparent;color:#f5f5f6;font:inherit;cursor:pointer">Cancel</button><button id="lead-send" style="flex:1.4;padding:10px;border-radius:9px;border:0;background:var(--accent-grad,#f4f4f5);color:#111;font:inherit;font-weight:700;cursor:pointer">Send enquiry</button></div>
    </div>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.onclick = (e) => { if (e.target === m) close(); };
    m.querySelector("#lead-cancel").onclick = close;
    m.querySelector("#lead-send").onclick = async () => {
      const name = m.querySelector("#lead-name").value.trim();
      const email = m.querySelector("#lead-email").value.trim();
      if (!name || !email) { ui.showToast?.("Name + email required"); return; }
       const payload = { name, email, message: m.querySelector("#lead-msg").value.trim(), product: product.id, config: configurationPayload(state, product), url: location.href, ts: Date.now() };
       const ep = window.CONFIGURATOR_BRAND && window.CONFIGURATOR_BRAND.leadEndpoint;
       if (ep) {
         try {
           const response = await fetch(ep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
           if (!response.ok) throw new Error(`HTTP ${response.status}`);
           close(); ui.showToast?.("Enquiry sent"); track("enquiry");
         } catch (e) {
           console.warn("lead post failed", e);
           ui.showToast?.("Could not send enquiry — please try again");
         }
         return;
       }
       if (postToParent({ type: "configurator:lead", lead: payload })) {
         close(); ui.showToast?.("Enquiry handed to the host"); track("enquiry");
       } else {
         ui.showToast?.("Enquiries are not configured yet");
       }
    };
  });
})();

// ---- Vibe → palette: one-tap curated finish combos (rule-based, no AI) ---------
(function vibePalette() {
  const VIBES = [
    ["Warm minimal", "autumn_bark", "anthracite"],
    ["Cool modern", "anthracite", "black"],
    ["Natural", "birch", "bison"],
    ["Bold", "buffalo", "black"],
  ];
  const applyPalette = (...ids) => {
    for (const [index, slot] of productConfigSlots(product).entries()) {
      const id = ids[index];
      if (!id) continue;
      state[slot] = id; applySwatch(slot, byId(id));
    }
    refreshShadows(); updateProbe();
    if (photoMode) { updatePhotoMaterials(materials, state.env); markPhotoSceneDirty(); }
    ui.refreshGrid?.(); ui.syncSlots?.(); needsRender = true; track("palette_applied");
  };
  let i = -1;
  const btn = addTool("Palette ✨");
  btn.addEventListener("click", () => { i = (i + 1) % VIBES.length; const [name, a, b] = VIBES[i]; applyPalette(a, b); btn.textContent = `Palette: ${name}`; ui.showToast?.(name); });
})();

// fire a product_view on load
track("product_view", { name: product.name });

// ---- Guided wizard: first-visit walkthrough (+ ? to re-open) -------------------
(function wizard() {
  const STEPS = [
    { t: "Welcome", d: "Configure this product in 3D — finishes, camera views, AR and more." },
    { t: "Switch products", d: "Click the product name (top-right) to search the whole catalogue." },
    { t: "Pick finishes", d: "Use the Material slots to swap fabrics — or ⚙ Tools → Palette / Match-from-photo." },
    { t: "Share & quote", d: "⚙ Tools → Spec sheet (PDF), Enquire (send a lead), or View in AR." },
  ];
  const card = document.createElement("div");
  card.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:80;width:min(92vw,360px);background:#141416;border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:16px 18px;box-shadow:0 18px 50px rgba(0,0,0,0.6);display:none";
  document.body.appendChild(card);
  let i = 0;
  const done = () => { card.style.display = "none"; try { localStorage.setItem("configurator_wizard_seen", "1"); } catch {} };
  const render = () => {
    const s = STEPS[i];
    card.innerHTML = `<div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:rgba(245,245,246,0.4);margin-bottom:6px">Step ${i + 1} / ${STEPS.length}</div>
      <div style="font-size:15px;font-weight:700;color:#f5f5f6;margin-bottom:5px">${s.t}</div>
      <div style="font-size:13px;color:rgba(245,245,246,0.7);line-height:1.5;margin-bottom:14px">${s.d}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button id="wz-skip" style="font:inherit;font-size:12px;padding:7px 12px;border-radius:8px;border:0;background:transparent;color:rgba(245,245,246,0.5);cursor:pointer">Skip</button><button id="wz-next" style="font:inherit;font-size:12px;font-weight:700;padding:7px 16px;border-radius:8px;border:0;background:var(--accent-grad,#f4f4f5);color:#111;cursor:pointer">${i === STEPS.length - 1 ? "Done" : "Next"}</button></div>`;
    card.querySelector("#wz-skip").onclick = done;
    card.querySelector("#wz-next").onclick = () => { if (i === STEPS.length - 1) done(); else { i++; render(); } };
  };
  const show = () => { i = 0; card.style.display = "block"; render(); };
  let seen = false; try { seen = localStorage.getItem("configurator_wizard_seen") === "1"; } catch {}
  if (!seen) setTimeout(show, 900);
  const help = document.createElement("button"); help.textContent = "?"; help.setAttribute("aria-label", "Help");
   help.style.cssText = "position:fixed;right:12px;top:12px;z-index:45;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,0.18);background:rgba(0,0,0,0.5);color:#f5f5f6;font:700 13px ui-monospace,monospace;cursor:pointer;backdrop-filter:blur(6px)";
  help.onclick = show; document.body.appendChild(help);
})();

// ---- AI product helper: rule-based assistant + optional LLM endpoint ------------
// Works offline (intents: switch product, change finish, price, size, AR, spec).
// If window.CONFIGURATOR_AI.endpoint is set, unmatched questions are POSTed there for a
// richer reply. No API key is ever embedded client-side.
(function aiHelper() {
  const cat = productCatalogue();
  const applyFinish = (id) => {
    const slot = state.activeSlot && product.fabricSlots.includes(state.activeSlot) ? state.activeSlot : product.fabricSlots[0];
    if (!slot) return false;
    state[slot] = id; applySwatch(slot, byId(id)); refreshShadows(); updateProbe();
    if (photoMode) { updatePhotoMaterials(materials, state.env); markPhotoSceneDirty(); }
    ui.refreshGrid?.(); ui.syncSlots?.(); needsRender = true; track("config_change", { slot, swatch: id, via: "ai" });
    return true;
  };
  const findProduct = (q) => {
    let hit = cat.find((p) => p.name.toLowerCase() === q) || cat.find((p) => p.name.toLowerCase().includes(q));
    if (!hit) { const t = ["chair", "stool", "sofa", "desk", "table", "sideboard", "lamp"].find((t) => q.includes(t)); if (t) hit = cat.find((p) => p.name.toLowerCase().includes(t.split(" ")[0])); }
    return hit;
  };
  const findSwatch = (q) => swatches.find((s) => q.includes(s.name.toLowerCase())) || swatches.find((s) => s.name.toLowerCase().split(" ").some((w) => w.length > 3 && q.includes(w)));
  const priceMsg = () => { const pi = priceInfo(); const pr = pi.price ? `£${pi.price}` : "available on application"; const lt = pi.leadTime ? `, typically ${pi.leadTime} lead time` : ""; return `The ${product.name} is ${pr}${lt}. Want a spec sheet? Just say "spec".`; };
  const dimsMsg = () => { const s = new THREE.Box3().setFromObject(chair).getSize(new THREE.Vector3()); return `${product.name}: ${Math.round(s.x * 100)} × ${Math.round(s.z * 100)} × ${Math.round(s.y * 100)} cm (W×D×H). Toggle Dimensions in ⚙ Tools for an in-scene scale guide.`; };
  const helpMsg = () => `I can help you: switch products ("show me a stool"), change finishes ("make it navy"), check size or price, view in AR, or make a spec sheet. What would you like?`;
  async function respond(text) {
    const q = text.toLowerCase().trim();
    if (/\b(price|cost|how much|quote|expensive)\b/.test(q)) return priceMsg();
    if (/\b(size|dimension|fit|how (big|tall|wide)|measur)\b/.test(q)) return dimsMsg();
    if (/\b(ar|augmented|in (my|the) (room|home|office|space)|view in)\b/.test(q)) { document.getElementById("btn-ar")?.click(); return "Opening AR — point your phone at the floor to place it to scale."; }
    if (/\b(spec|datasheet|data sheet|pdf|brochure|sheet)\b/.test(q)) { [...document.querySelectorAll("button")].find((b) => /Spec sheet/.test(b.textContent || ""))?.click(); return "Generating your branded spec sheet now."; }
    const sw = findSwatch(q);
    if (sw && /\b(make|change|try|swap|in |colour|color|fabric|finish|upholster)\b/.test(q)) { return applyFinish(sw.id) ? `Done — ${sw.name} applied.` : "This product has no fabric slot to change."; }
    const prod = findProduct(q);
    if (prod && /\b(show|switch|see|view|find|product|chair|stool|sofa|desk|table|sideboard|lamp)\b/.test(q)) {
      if (prod.id !== CURRENT_PRODUCT) { setTimeout(() => { const u = new URL(location.href); u.searchParams.set("product", prod.id); location.href = u.toString(); }, 700); return `Loading the ${prod.name}…`; }
      return `You're already viewing the ${prod.name}.`;
    }
    if (/\b(recommend|suggest|popular|best|options)\b/.test(q)) return `A few to explore: ${cat.slice(0, 4).map((p) => p.name).join(", ")}. Tell me a type — chair, stool, sofa, sideboard — and I'll pull it up.`;
    if (/\b(hi|hello|hey|help|what can|who are)\b/.test(q)) return helpMsg();
    if (window.CONFIGURATOR_AI && window.CONFIGURATOR_AI.endpoint) {
      try { const r = await fetch(window.CONFIGURATOR_AI.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, product: CURRENT_PRODUCT, products: cat }) }); const j = await r.json(); if (j && j.reply) return j.reply; } catch (e) { console.warn("AI endpoint failed", e); }
    }
    return helpMsg();
  }

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;right:12px;bottom:54px;z-index:80;width:min(92vw,330px);height:min(60vh,440px);display:none;flex-direction:column;background:#141416;border:1px solid rgba(255,255,255,0.12);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,0.6);overflow:hidden";
  panel.innerHTML = `<div style="padding:11px 14px;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;font-weight:700;color:#f5f5f6">Assistant</div>
    <div id="ai-log" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px"></div>
    <div style="display:flex;gap:6px;padding:10px;border-top:1px solid rgba(255,255,255,0.08)"><input id="ai-in" placeholder="Ask anything…" style="flex:1;padding:9px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:#f5f5f6;font:inherit;outline:none"><button id="ai-send" style="padding:9px 13px;border-radius:8px;border:0;background:var(--accent-grad,#f4f4f5);color:#111;font:inherit;font-weight:700;cursor:pointer">→</button></div>`;
  document.body.appendChild(panel);
  const log = panel.querySelector("#ai-log"), input = panel.querySelector("#ai-in");
  const bubble = (txt, me) => { const b = document.createElement("div"); b.textContent = txt; b.style.cssText = `max-width:85%;padding:8px 11px;border-radius:11px;font-size:13px;line-height:1.45;${me ? "align-self:flex-end;background:var(--accent,#f4f4f5);color:#111" : "align-self:flex-start;background:rgba(255,255,255,0.07);color:#f5f5f6"}`; log.appendChild(b); log.scrollTop = log.scrollHeight; };
  const send = async () => { const t = input.value.trim(); if (!t) return; bubble(t, true); input.value = ""; track("ai_query"); const r = await respond(t); bubble(r, false); };
  panel.querySelector("#ai-send").onclick = send;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  const fab = document.createElement("button");
  fab.textContent = "✦ Ask"; fab.setAttribute("aria-label", "AI assistant");
  fab.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:81;font:700 12px ui-monospace,monospace;padding:9px 14px;border-radius:20px;border:1px solid rgba(255,255,255,0.18);background:rgba(0,0,0,0.6);color:#f5f5f6;cursor:pointer;backdrop-filter:blur(6px)";
  let greeted = false;
  fab.onclick = () => { const open = panel.style.display === "flex"; panel.style.display = open ? "none" : "flex"; if (!open && !greeted) { greeted = true; bubble(helpMsg(), false); } if (!open) input.focus(); };
  document.body.appendChild(fab);
})();

// ---- Pricing display: price / lead-time / stock under the product name ----------
(function pricingDisplay() {
  const htext = document.querySelector("#panel .htext"); if (!htext) return;
  const pi = priceInfo();
  const el = document.createElement("div");
  el.style.cssText = "font-size:11.5px;color:rgba(245,245,246,0.55);margin-top:3px";
  const parts = [pi.price ? `£${pi.price}` : "Price on application"];
  if (pi.leadTime) parts.push(`${pi.leadTime} lead`);
  if (pi.stock) parts.push(pi.stock);
  el.textContent = parts.join("  ·  ");
  htext.appendChild(el);
})();

// ---- i18n: framework + EN/FR/ES/DE for the UI chrome + a language switcher ------
// v1 covers the tool chrome; extend the dict for full coverage. ?lang= / saved.
(function i18n() {
  const T = {
    fr: { "Dimensions": "Dimensions", "Compare": "Comparer", "Hotspots": "Points clés", "Enquire": "Demander un devis", "Match from photo": "Associer une photo", "⎙ Spec sheet": "⎙ Fiche", "⚙ Tools": "⚙ Outils", "✦ Ask": "✦ Assistant" },
    es: { "Dimensions": "Dimensiones", "Compare": "Comparar", "Hotspots": "Detalles", "Enquire": "Consultar", "Match from photo": "Buscar por foto", "⎙ Spec sheet": "⎙ Ficha", "⚙ Tools": "⚙ Opciones", "✦ Ask": "✦ Asistente" },
    de: { "Dimensions": "Maße", "Compare": "Vergleich", "Hotspots": "Hotspots", "Enquire": "Anfragen", "Match from photo": "Foto-Abgleich", "⎙ Spec sheet": "⎙ Datenblatt", "⚙ Tools": "⚙ Werkzeuge", "✦ Ask": "✦ Assistent" },
  };
  const keys = Object.keys(T.fr);
  const apply = (lang) => document.querySelectorAll("button").forEach((b) => {
    const en = b.dataset.en || (keys.includes(b.textContent.trim()) ? b.textContent.trim() : null);
    if (!en) return; b.dataset.en = en;
    b.textContent = lang === "en" || !T[lang] ? en : T[lang][en] || en;
  });
  let lang = new URLSearchParams(location.search).get("lang") || (() => { try { return localStorage.getItem("configurator_lang"); } catch { return null; } })() || (navigator.language || "en").slice(0, 2);
  if (!["en", "fr", "es", "de"].includes(lang)) lang = "en";
  apply(lang);
  const langs = ["en", "fr", "es", "de"];
  const sw = addTool(`🌐 ${lang.toUpperCase()}`);
  sw.addEventListener("click", () => { lang = langs[(langs.indexOf(lang) + 1) % langs.length]; try { localStorage.setItem("configurator_lang", lang); } catch {} apply(lang); sw.textContent = `🌐 ${lang.toUpperCase()}`; });
})();

// ---- Mechanism animations: registry-driven (product.animations) + auto drawers --
(function animations() {
  const defs = (product.animations || []).slice();
  chair.traverse((n) => { if (n.isMesh) { const b = n.name.toLowerCase().replace(/\.\d+$/, ""); if (b === "slides" && !defs.some((d) => d.mesh === b)) defs.push({ name: "Drawer", mesh: b, type: "translate", axis: "z", range: 0.22 }); } });
  if (!defs.length) return;
  const meshOf = (name) => { let m = null; chair.traverse((n) => { if (n.isMesh && n.name.toLowerCase().replace(/\.\d+$/, "") === name) m = n; }); return m; };
  defs.forEach((d) => { d._mesh = meshOf(d.mesh); if (d._mesh) { d._home = d.type === "rotate" ? d._mesh.rotation[d.axis] : d._mesh.position[d.axis]; d._open = false; } });
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const toggle = (d) => {
    if (!d._mesh) return;
    const from = d.type === "rotate" ? d._mesh.rotation[d.axis] : d._mesh.position[d.axis];
    const target = d._open ? d._home : d._home + (d.range || 0.2); d._open = !d._open;
    const t0 = performance.now();
    (function step() { const t = Math.min(1, (performance.now() - t0) / 450); const v = from + (target - from) * ease(t); if (d.type === "rotate") d._mesh.rotation[d.axis] = v; else d._mesh.position[d.axis] = v; needsRender = true; if (photoMode) markPhotoSceneDirty(); if (t < 1) requestAnimationFrame(step); })();
  };
  const btn = addTool(defs.length === 1 ? defs[0].name : "Mechanism");
  btn.addEventListener("click", () => { defs.forEach(toggle); track("animation"); });
})();

const maxAniso = renderer.capabilities.getMaxAnisotropy();
const byId = (id) => swatches.find((s) => s.id === id) || swatches[0];
// Active product — the material UI edits whichever product is currently selected.
const chairP = { name: product.name, group: chair, materials, sel: { ...Object.fromEntries(productConfigSlots(product).map((slot) => [slot, state[slot]])), activeSlot: state.activeSlot || productConfigSlots(product)[0] || "" } };
let activeP = chairP;
// Route by swatch type — PBR material, saved preset, or legacy fabric. Targets the ACTIVE product.
const applySwatch = (slot, sw) => {
  const m = activeP.materials;
  if (!m[slot] || !sw) return; // slot may not exist on this product (e.g. fixed-finish-only)
  if (sw.pbr) applyPBRMaterial(m, slot, sw.pbr, maxAniso, { fullMaterialMaps: useFullMaterialMaps });
  else if (sw.custom) applyPreset(m, slot, sw, maxAniso);
  else applyFabric(m, slot, sw, maxAniso);
};
for (const s of product.fabricSlots) applySwatch(s, byId(state[s]));
document.body.dataset.cfgProduct = CURRENT_PRODUCT;
for (const s of product.fabricSlots) {
  document.body.dataset[`cfgSlot${s.toUpperCase()}`] = state[s] || "";
  document.body.dataset[`cfgColor${s.toUpperCase()}`] = materials[s]?.color?.getStyle?.() || "";
}
await env.setEnv(state.env);
rasterScene.environment = scene.environment; // HDRI IBL lights the raster overlay too
flyTo(state.cam, true);
refreshShadows();
// Only the studio HDRI is offered as the lighting env — hide the rest.
document.querySelectorAll("#env-seg [data-env]").forEach((b) => {
  if (!["hdri"].includes(b.dataset.env)) b.style.display = "none";
});

// ---- One-shot probes (re-rendered on config change, zero per-frame cost) ----
// Reflection probe: chrome reflects the actual chair + stage, not just the HDRI
const probeRT = renderProfile.probe ? new THREE.WebGLCubeRenderTarget(256) : null;
const probeCam = probeRT ? new THREE.CubeCamera(0.05, 50, probeRT) : null;
if (probeCam) { probeCam.position.set(0, 0.45, 0); scene.add(probeCam); }
const probePmrem = probeRT ? new THREE.PMREMGenerator(renderer) : null;
let probeEnvRT = null;
const ENV_INTENSITY = { a: 0.7, b: 0.7, black: 0.9, chrome: 1.2 };
function updateProbe() {
  if (!probeCam || !probePmrem) return;
  const saved = [];
  chair.traverse((n) => { if (n.isMesh) { saved.push([n, n.visible]); n.visible = false; } });
  probeCam.update(renderer, scene);
  saved.forEach(([m, v]) => (m.visible = v)); // restore prior visibility (keeps hidden helpers hidden)
  // PMREM-filter the capture: correct roughness-blurred reflections, no aliasing
  const prev = probeEnvRT;
  probeEnvRT = probePmrem.fromCubemap(probeRT.texture);
  if (prev) prev.dispose();
  // Reflect the NEUTRAL scene probe, never the raw lighting HDRI. The HDRI is
  // IBL-only (never shown); reflecting it put its huge softbox/window shapes into
  // every mirror + chrome surface. The probe captures the neutral studio backdrop,
  // so reflections read as a calm studio and follow the White/Black env toggle.
  for (const slot of Object.keys(materials)) {
    const mat = materials[slot]; if (!mat) continue;
    const s = slot.toLowerCase();
    mat.envMap = probeEnvRT.texture;
    mat.envMapIntensity = mat.userData.envIntensity ?? ENV_INTENSITY[slot] ?? (s.includes("chrome") ? 1.0 : /black|metal/.test(s) ? 0.9 : 0.7);
    mat.needsUpdate = true;
  }
  needsRender = true;  // safe now that declared early
}

// Contact shadow: true top-down silhouette projected under the product
const shadowRT = new THREE.WebGLRenderTarget(128, 128);
const shadowCam = new THREE.OrthographicCamera(-0.75, 0.75, 0.75, -0.75, 0.05, 4);
shadowCam.position.set(0, 2.5, 0);
shadowCam.lookAt(0, 0, 0);
const silhouetteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
function updateContactShadow() {
  const prevBg = scene.background;
  const vis = [env.groups.studio.visible, env.blob.visible];
  env.groups.studio.visible = env.blob.visible = false;
  scene.background = new THREE.Color(0x000000);
  scene.overrideMaterial = silhouetteMat;
  renderer.setRenderTarget(shadowRT);
  renderer.render(scene, shadowCam);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  [env.groups.studio.visible, env.blob.visible] = vis;
  scene.background = prevBg;
  env.blob.material.map = null;
  env.blob.material.alphaMap = shadowRT.texture;
  env.blob.material.color.set(0x000000);
  env.blob.material.opacity = 0.5;
  env.blob.material.needsUpdate = true;
  env.blob.scale.setScalar(1.5);
  needsRender = true;
}
// ---- Rendering-engine feature registry ---------------------------------------
const fabricMats = productConfigSlots(product).map((slot) => materials[slot]).filter(Boolean);
const allMats = Object.values(materials).filter(Boolean);
const recompile = () => { scene.traverse((n) => { if (n.isMesh) n.material.needsUpdate = true; }); };
// Full path-tracer build: the render list is just ACES tonemap + Photo Mode.
// The old raster toggles (baked GI/AO, HDRI light, probe reflections, contact /
// dynamic shadows, bloom/DoF/grain/chromatic) are gone — the path tracer
// computes lighting, shadows and reflections directly.
// ?samples=N — experiment: cap the path tracer at N accumulated samples.
// ?ms=N — experiment: render for N ms of wall-clock then FREEZE at whatever spp
// landed (restarts the budget when you move / change config). Both skip the
// warm-up wireframe overlay so the raw frame is shown as-is.
const SAMPLE_CAP = parseInt(new URLSearchParams(location.search).get("samples"), 10) || 0;
let SAMPLE_MS = parseInt(new URLSearchParams(location.search).get("ms"), 10) || 1000; // default 1s cutoff; live-editable via the Cutoff slider
const MIN_RENDER_MS = isMobile ? 3500 : 6000; // desktop gets a cleaner settle; mobile is normally gated by the host UI
let ptAccumStart = 0, ptPrevSpp = 0, ptFrozen = false; // time-budget bookkeeping
const FEATURES = [
  { key: "photoMode", label: "Photo Mode (Path Tracer)", on: true, apply: (on) => {
    if (on) {
      if (!pathTracingAvailable) {
        ui?.showToast?.("Photo Mode is unavailable on this device");
        postToParent({ type: "configurator:traceState", status: "unavailable", samples: 0 });
        return;
      }
      // Load the path tracer only when explicitly requested. It is intentionally
      // absent from the first paint bundle on reduced/balanced devices.
      loadPhotoTracer().then((module) => {
        if (!on) return;
        // tracer reuses THIS renderer + the live chair/fabrics, drawing to the
        // same canvas — no overlay. Pass the raw equirect HDR for correct IBL.
        photoMode = module.initPhotoTracer(chair, scene, camera, renderer, env.getActive()?.raw);
        if (photoMode) {
          // The HDR remains lighting-only, preserving useful metal reflections.
          // The backdrop and physical fill are deliberately theme-independent.
          module.setPhotoEnvColor(embeddedBackdrop);
          module.setPhotoLampIntensity(4);
          controls.autoRotate = false; // it's a still — let samples settle
          showPhotoQualityPanel();
          applyQualityPreset(defaultQualityKey); // desktop Fast / mobile Fastest
          if (SAMPLE_CAP) module.setPhotoQuality({ maxSamples: SAMPLE_CAP }); // ?samples=N experiment
          document.getElementById("pt-spinner")?.classList.add("show"); // warm-up; loop hides it at PT_READY_SAMPLES
          needsRender = true;
        }
      }).catch((error) => {
        console.error("path tracer load failed:", error);
        ui?.showToast?.("Photo Mode could not load");
      });
    } else {
      photoMode = false;
      disposePhotoTracer();
      hidePhotoQualityPanel();
      document.getElementById("pt-spinner")?.classList.remove("show");
    }
    needsRender = true;
  } },
];

// Lightweight post state (only used when features are active)
const post = {
  bloom: false,
  dof: false,
  grain: false,
  chromatic: false,
  // resolutionScale for mobile perf (effects render at lower res)
  resolutionScale: isMobile ? 0.5 : 1.0,
};

let photoMode = false;
let composer = null;
let bloomPass = null;
let grainPass = null;
let renderPass = null;

async function initPost() {
  if (composer) return;

  // Dynamic import keeps the postprocessing addons out of the initial bundle
  const [
    { EffectComposer },
    { RenderPass },
    { ShaderPass },
    { UnrealBloomPass }
  ] = await Promise.all([
    import("three/addons/postprocessing/EffectComposer.js"),
    import("three/addons/postprocessing/RenderPass.js"),
    import("three/addons/postprocessing/ShaderPass.js"),
    import("three/addons/postprocessing/UnrealBloomPass.js")
  ]);

  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Bloom - high impact for chrome/highlights, cheap at reduced res
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth * post.resolutionScale, window.innerHeight * post.resolutionScale),
    0.6,   // strength (tuned for this scene)
    0.4,   // radius
    0.85   // threshold
  );
  composer.addPass(bloomPass);
  bloomPass.enabled = post.bloom;

  // Simple grain + vignette + chromatic aberration as final pass (extremely cheap, big "photo" feel)
  const grainShader = {
    uniforms: {
      tDiffuse: { value: null },
      grainAmount: { value: 0.035 },
      vignetteAmount: { value: 0.25 },
      chromaticAmount: { value: 0.8 },
      time: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform float grainAmount;
      uniform float vignetteAmount;
      uniform float chromaticAmount;
      uniform float time;
      varying vec2 vUv;
      void main() {
        vec2 uv = vUv;
        vec2 center = uv - 0.5;
        float dist = length(center);
        // Chromatic Aberration (cheap RGB channel offset)
        float ca = chromaticAmount * dist * 0.015;
        vec4 color;
        if (chromaticAmount > 0.01) {
          float r = texture2D(tDiffuse, uv + center * ca).r;
          float g = texture2D(tDiffuse, uv).g;
          float b = texture2D(tDiffuse, uv - center * ca).b;
          color = vec4(r, g, b, 1.0);
        } else {
          color = texture2D(tDiffuse, uv);
        }
        // Film grain
        float noise = fract(sin(dot(vUv + time * 0.001, vec2(12.9898, 78.233))) * 43758.5453);
        color.rgb += (noise - 0.5) * grainAmount;
        // Vignette
        float vignette = smoothstep(0.7, 0.3, dist);
        color.rgb *= mix(1.0, vignette, vignetteAmount);
        gl_FragColor = color;
      }
    `,
  };
  grainPass = new ShaderPass(grainShader);
  composer.addPass(grainPass);
  grainPass.enabled = post.grain;
}

function updatePost() {
  if (!composer) return;
  if (bloomPass) bloomPass.enabled = post.bloom;
  if (grainPass) grainPass.enabled = post.grain;
  if (grainPass && grainPass.uniforms.chromaticAmount) {
    grainPass.uniforms.chromaticAmount.value = post.chromatic ? 0.8 : 0.0;
  }
  // Update resolution if scale changed (e.g. mobile)
  if (bloomPass) {
    bloomPass.resolution.set(
      window.innerWidth * post.resolutionScale,
      window.innerHeight * post.resolutionScale
    );
  }
}

// Photo Mode (path tracer) integration lives in src/photo-tracer.js (the custom PathTracingRenderer + shaders + chair data extraction).

const ui = initUI({
  swatches,
  state,
  product, // per-slot finish types drive which material group (fabric/laminate) each slot shows
  features: [], // Photo Mode toggle removed — PT is on by default (enablePT drives it)
  callbacks: {
    onFeature: (key, on) => {
      FEATURES.find((f) => f.key === key)?.apply(on);
      needsRender = true;
    },
    onFabric: (slot, sw) => {
      applySwatch(slot, sw);
      track("config_change", { slot, swatch: sw.id });
      refreshShadows();
      updateProbe(); // probe is environment-only — no need to wait for the fabric texture

      if (photoMode) {
        updatePhotoMaterials(materials, state.env);
        markPhotoSceneDirty();
      }
    },
    onEnv: (name) => env.setEnv(name).then(() => {
      refreshShadows();
      updateProbe();
      needsRender = true;

      if (photoMode) {
        updatePhotoEnv(env.getActive()?.raw);
      }
    }),
    onCamera: (cam) => {
      flyTo(cam);
      if (photoMode) {
        updatePhotoCamera(camera);
        markPhotoSceneDirty();
      }
    },
    onScreenshot: () => {
      if (photoMode) renderPhotoTracer(); else renderer.render(scene, camera);
      try {
        const a = document.createElement("a");
        a.href = renderer.domElement.toDataURL("image/jpeg", 0.92);
        const suffix = productConfigSlots(product).map((slot) => `${slot}-${state[slot] || "none"}`).join("_");
        a.download = `${product.id}-${suffix || "fixed"}.jpg`;
        a.click();
      } catch { ui?.showToast?.("Screenshot unavailable"); }
    },
    onQuote: () => showQuote(),
  },
});

BT("before probe/shadow");
// Don't block boot on the studio HDR. Set up probe/shadows now with the default
// environment and render immediately; refresh once the HDR lands in background.
try { updateProbe(); BT("probe done"); } catch (e) { console.error("probe init failed:", e); }
// Gut the raster to essentials. Removed: the contact-shadow blob (looked bad) and
// the planar floor Reflector (a full extra scene render EVERY frame — the single
// biggest raster cost). Shadow-map casting is off (see renderer setup). Kept: IBL +
// baked lightmap/AO + probe chrome reflections + key/rim form lighting + ACES + MSAA.
if (env.blob) env.blob.visible = false;
if (env.reflector) env.reflector.visible = false;
env.hdrReady.then((ok) => {
  if (!ok) return;
  try { updateProbe(); } catch {}
  if (photoMode) updatePhotoEnv(env.getActive()?.raw);
  needsRender = true;
}).catch(() => {});
BT("scene ready — revealing");
setBootLoading(0, "Rendering…"); // loaded — hand the pill over to the render bar

// Path tracer is the DEFAULT view, but enabling it must NEVER block first paint
// (its BVH build + shader compile can take seconds). It is switched on AFTER the
// render loop starts — see the deferred enable at the bottom of this file. The
// loop shows the raster chair immediately; the tracer then refines to photoreal.
// ?pt=0 stays raster-only (weak devices / debugging).
const ptDefault = pathTracingAvailable; // explicit opt-in on any hardware-capable WebGL2 profile
if (!ptDefault) {
  const f = FEATURES.find((x) => x.key === "photoMode");
  if (f) f.on = false;
  document.querySelectorAll("#feature-grid .feat").forEach((el) => {
    if (el.textContent.includes("Photo Mode")) el.classList.remove("on");
  });
}

// ---- Photo-mode quality panel (shown only while Photo Mode is on) ------------
const pqSamplesEl = document.getElementById("pq-samples");
const ptSpinnerEl = document.getElementById("pt-spinner");
const PT_READY_SAMPLES = 6; // below this, show the wireframe warm-up + spinner
// Quality presets: cutoffMs controls the raster→trace reveal. The desktop Fast
// preset prioritises stable interaction, six-bounce GI and full-resolution output.
const QUALITY_PRESETS = {
  Fastest: { cutoffMs: 250, bounces: 3, filterGlossyFactor: 0.55, renderScale: 0.7,  samplesPerFrame: 1, maxSamples: 0,   stableNoise: false },
  Faster:  { cutoffMs: 400, bounces: 4, filterGlossyFactor: 0.42, renderScale: 0.85, samplesPerFrame: 2, maxSamples: 0,   stableNoise: false },
  Fast:    { cutoffMs: 650, bounces: 6, filterGlossyFactor: 0.32, renderScale: 1.0,  samplesPerFrame: 2, maxSamples: 0,   stableNoise: false },
  Pro:     { cutoffMs: 0,   bounces: 8, filterGlossyFactor: 0.25, renderScale: 1.25, samplesPerFrame: 1, maxSamples: 768, stableNoise: true },
};
const defaultQualityKey = isMobile ? "Fastest" : "Fast";
let rsInput = null, bnInput = null, spfInput = null, glossyInput = null, cutoffInput = null; // debug-panel PT sliders (synced on preset change)
// Apply a quality preset: render settings + the reveal cutoff, then restart accumulation.
function applyQualityPreset(key) {
  const p = QUALITY_PRESETS[key];
  if (!p) return;
  SAMPLE_MS = p.cutoffMs;              // 0 = Pro (uncapped, no reveal cutoff)
  setPhotoQuality(p);                  // bounces / glossy / renderScale / samplesPerFrame / maxSamples
  // sync the debug sliders' DISPLAY to the preset (setPhotoQuality already applied the values)
  const disp = (el, v) => { if (el) { el.value = v; el._label.textContent = el._fmt(v); } };
  disp(rsInput, p.renderScale); disp(bnInput, p.bounces); disp(spfInput, p.samplesPerFrame);
  disp(glossyInput, p.filterGlossyFactor); disp(cutoffInput, p.cutoffMs);
  ptAccumStart = 0; ptFrozen = false;  // restart the budget for the new preset
  markPhotoSceneDirty();
}
// ---- Lightmap bake experiment ----
const BAKE_SAMPLES = 100;          // converge to this many samples, then bake
let bakeArmed = false;             // waiting to reach BAKE_SAMPLES
let bakedRestore = null;           // restore fn while a bake is applied
let bakeBtn = null;                // the panel button
function pqSlider(wrap, label, { min, max, step, value, fmt, onInput }) {
  const row = document.createElement("label");
  row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:10.5px;color:rgba(242,239,233,0.6)";
  row.innerHTML = `<span style="min-width:92px">${label}</span>`;
  const input = document.createElement("input");
  input.type = "range"; input.min = min; input.max = max; input.step = step; input.value = value;
  input.style.cssText = "flex:1;accent-color:#fff;height:14px";
  const val = document.createElement("span");
  val.style.cssText = "min-width:34px;text-align:right;font-family:monospace";
  const show = (v) => (fmt ? fmt(v) : (+v).toFixed(2));
  val.textContent = show(value);
  input.addEventListener("input", () => { const v = parseFloat(input.value); val.textContent = show(v); onInput(v); });
  row.append(input, val); wrap.appendChild(row);
  return input;
}
let pqBuilt = false;
function buildPhotoQualityPanel() {
  if (pqBuilt) return; pqBuilt = true;
  const w = document.getElementById("pq-controls");
  if (!w) return;
  // Quality preset — replaces the bounces / glossy / render-scale / max-samples sliders.
  {
    const label = document.createElement("div");
    label.style.cssText = "font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--ink-faint);margin:2px 0 8px";
    label.textContent = "Quality";
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const key of ["Fastest", "Faster", "Fast", "Pro"]) {
      const b = document.createElement("button");
      b.textContent = key;
      if (key === defaultQualityKey) b.classList.add("active");
      b.addEventListener("click", () => {
        seg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        applyQualityPreset(key);
      });
      seg.appendChild(b);
    }
    w.append(label, seg);
  }


  // Environment colour — backdrop + ground follow it. White / Black presets +
  // a free colour picker. (White preset = soft white, not pure 0xffffff.)
  {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:10px";
    const lab = document.createElement("span");
    lab.style.cssText = "font-size:11px;color:rgba(242,239,233,0.7);min-width:84px";
    lab.textContent = "Environment";
    const picker = document.createElement("input");
    picker.type = "color"; picker.value = "#f2f2f2";
    picker.style.cssText = "width:26px;height:22px;padding:0;border:0;background:none;cursor:pointer";
    picker.addEventListener("input", () => setPhotoEnvColor(picker.value));
    const mk = (label, hex) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "font:inherit;font-size:10.5px;padding:4px 9px;border-radius:7px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:rgba(242,239,233,0.8);cursor:pointer";
      b.addEventListener("click", () => { picker.value = hex; setPhotoEnvColor(hex); });
      return b;
    };
    wrap.append(lab, mk("White", "#f2f2f2"), mk("Black", "#000000"), picker);
    w.appendChild(wrap);
  }

  // Denoise is automatic now — off during accumulation, switched on by the loop at
  // the cutoff reveal (see setDenoiseActive). No manual toggle.

  // Sharpen + Throughput sliders moved to the Debug panel (full PT controls there).

  // ---- Export: high-res path-traced still (1080/4K) + real-time turntable video ----
  {
    const lbl = document.createElement("div");
    lbl.style.cssText = "font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,245,246,0.4);margin:14px 0 6px";
    lbl.textContent = "Export"; w.appendChild(lbl);

    let exportLong = 3840; // long-edge px; default 4K
    const seg = document.createElement("div");
    seg.style.cssText = "display:flex;gap:4px;margin-bottom:8px";
    const paint = () => [...seg.children].forEach((c) => { const on = +c.dataset.px === exportLong; c.style.background = on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.05)"; c.style.color = on ? "#111" : "rgba(245,245,246,0.85)"; });
    for (const [name, px] of [["1080p", 1920], ["4K", 3840]]) {
      const b = document.createElement("button");
      b.textContent = name; b.dataset.px = px;
      b.style.cssText = "flex:1;font:inherit;font-size:11px;padding:5px 0;border-radius:7px;border:1px solid rgba(255,255,255,0.14);cursor:pointer";
      b.onclick = () => { exportLong = px; paint(); };
      seg.appendChild(b);
    }
    paint(); w.appendChild(seg);

    const stillBtn = document.createElement("button");
    stillBtn.textContent = "Download render";
    stillBtn.style.cssText = "width:100%;font:inherit;font-size:12px;font-weight:700;padding:9px 0;border-radius:9px;border:0;background:var(--accent-grad);color:#0b0710;cursor:pointer";
    stillBtn.addEventListener("click", async () => {
      if (stillBtn.disabled) return; stillBtn.disabled = true; stillBtn.style.opacity = "0.7"; const lab = "Download render";
      try {
        const aspect = (window.innerWidth / window.innerHeight) || (16 / 9);
        const width = aspect >= 1 ? exportLong : Math.round(exportLong * aspect);
        const height = aspect >= 1 ? Math.round(exportLong / aspect) : exportLong;
        const url = await renderStill({ width, height, samples: 500, onProgress: (p) => (stillBtn.textContent = `Rendering ${Math.round(p * 100)}%`) });
        if (url) { const a = document.createElement("a"); a.href = url; a.download = `${product.id}-${exportLong >= 3840 ? "4k" : "1080"}.png`; a.click(); ui.showToast("Render saved"); }
      } catch (e) { console.error("render export failed:", e); ui.showToast("Render failed — see console"); }
      stillBtn.textContent = lab; stillBtn.disabled = false; stillBtn.style.opacity = "1";
    });
    w.appendChild(stillBtn);

    // Turntable: orbit the camera one full revolution and record the canvas to webm.
    // Records whatever's on screen — smoothest in raster (the default); in PT mode the
    // per-frame reset shows the raster bridge, which still records cleanly.
    async function recordTurntable(seconds, onProgress) {
      const canvas = renderer.domElement;
      const stream = canvas.captureStream(30);
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
      const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((res) => (rec.onstop = res));
      const savedPos = camera.position.clone(), target = controls.target.clone(), offset = camera.position.clone().sub(target);
      const wasAuto = controls.autoRotate; controls.autoRotate = false;
      const upY = new THREE.Vector3(0, 1, 0);
      rec.start(); const t0 = performance.now();
      await new Promise((resolve) => {
        (function spin() {
          const t = Math.min(1, (performance.now() - t0) / (seconds * 1000));
          camera.position.copy(target).add(offset.clone().applyAxisAngle(upY, t * Math.PI * 2));
          camera.lookAt(target);
          if (photoMode) { updatePhotoCamera(camera); markPhotoSceneDirty(); }
          needsRender = true; onProgress?.(t);
          if (t >= 1) resolve(); else requestAnimationFrame(spin);
        })();
      });
      rec.stop(); await stopped;
      controls.autoRotate = wasAuto; camera.position.copy(savedPos); camera.lookAt(target); controls.update(); needsRender = true;
      const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      const a = document.createElement("a"); a.href = url; a.download = `${product.id}-turntable.webm`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    const ttBtn = document.createElement("button");
    ttBtn.textContent = "Record turntable";
    ttBtn.style.cssText = "width:100%;margin-top:6px;font:inherit;font-size:12px;font-weight:600;padding:9px 0;border-radius:9px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.05);color:#f5f5f6;cursor:pointer";
    ttBtn.addEventListener("click", async () => {
      if (ttBtn.disabled) return;
      if (!renderer.domElement.captureStream || typeof MediaRecorder === "undefined") { ui.showToast("Recording unsupported in this browser"); return; }
      ttBtn.disabled = true; ttBtn.style.opacity = "0.7"; const lab = "Record turntable";
      try { await recordTurntable(8, (p) => (ttBtn.textContent = `Recording ${Math.round(p * 100)}%`)); ui.showToast("Turntable saved"); }
      catch (e) { console.error("turntable failed:", e); ui.showToast("Turntable failed — see console"); }
      ttBtn.textContent = lab; ttBtn.disabled = false; ttBtn.style.opacity = "1";
    });
    w.appendChild(ttBtn);
  }

  // Bake & freeze — capture the converged frame into the product's uv1 atlas and
  // switch to cheap raster (path tracer off). Single-view for now; foundation for
  // the multi-product environment. Click again to un-bake.
  bakeBtn = document.createElement("button");
  bakeBtn.textContent = "Bake lightmap & freeze";
  bakeBtn.style.cssText = "margin-top:8px;font:inherit;font-size:12px;font-weight:600;padding:9px 0;border-radius:9px;border:1px solid var(--line-2);background:var(--panel-2);color:var(--ink);cursor:pointer";
  bakeBtn.addEventListener("click", () => { if (bakedRestore) unBake(); else doBake(); });
  w.appendChild(bakeBtn);
}

function doBake() {
  const s = ptSpinnerEl?.querySelector("span");
  if (s) s.textContent = "Baking lightmap…";
  ptSpinnerEl?.classList.add("show");
  try {
    bakedRestore = bakeFromPathTracer({ renderer, chair, camera });
  } catch (e) {
    console.error("lightmap bake failed:", e);
    ui.showToast("Bake failed — see console");
    ptSpinnerEl?.classList.remove("show");
    return;
  }
  // turn the path tracer OFF — show only the baked raster
  photoMode = false;
  disposePhotoTracer();
  const f = FEATURES.find((x) => x.key === "photoMode"); if (f) f.on = false;
  document.querySelectorAll("#feature-grid .feat").forEach((el) => { if (el.textContent.includes("Photo Mode")) el.classList.remove("on"); });
  needsRender = true;
  if (bakeBtn) bakeBtn.textContent = "Un-bake (live path tracer)";
  if (s) s.textContent = "Baked · path tracer OFF";
  setTimeout(() => { ptSpinnerEl?.classList.remove("show"); if (s) s.textContent = "Refining render…"; }, 2600);
}

function unBake() {
  if (bakedRestore) { bakedRestore(); bakedRestore = null; }
  FEATURES.find((x) => x.key === "photoMode")?.apply(true); // re-enable the path tracer
  document.querySelectorAll("#feature-grid .feat").forEach((el) => { if (el.textContent.includes("Photo Mode")) el.classList.add("on"); });
  if (bakeBtn) bakeBtn.textContent = "Bake lightmap & freeze";
  needsRender = true;
}
function showPhotoQualityPanel() { buildPhotoQualityPanel(); const s = document.getElementById("photo-quality"); if (s) s.style.display = ""; }
function hidePhotoQualityPanel() { const s = document.getElementById("photo-quality"); if (s) s.style.display = "none"; }

// ---- Get a quote — liquid-glass modal (client surface) ----------------------
function showQuote() {
  document.getElementById("quote-modal")?.remove();
  const endpoint = window.CONFIGURATOR_BRAND?.quoteEndpoint;
  if (!endpoint) { ui?.showToast?.("Quote requests are not configured yet"); return; }
  const nameOf = (id) => (swatches.find((s) => s.id === id)?.name || id);
  const configSummary = productConfigSlots(product).map((slot) => `<div>Slot ${slot.toUpperCase()} · <b style="color:var(--ink)">${nameOf(state[slot])}</b></div>`).join("") || "<div>Fixed finish product</div>";
  const m = document.createElement("div");
  m.id = "quote-modal";
  m.style.cssText = "position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(7px)";
  m.innerHTML = `
    <div style="width:min(92vw,400px);background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,0.6);overflow:hidden">
      <div style="padding:20px 22px 10px">
        <div style="font-size:10px;letter-spacing:.3em;text-transform:uppercase;font-weight:700;background:var(--accent-grad);-webkit-background-clip:text;background-clip:text;color:transparent">Request a quote</div>
        <h2 style="font-size:18px;font-weight:600;margin-top:6px">${product.name}</h2>
      </div>
      <div style="padding:2px 22px 6px;font-size:13px;color:var(--ink-dim);line-height:2">
         ${configSummary}
        <div>Environment · <b style="color:var(--ink)">${state.env}</b></div>
      </div>
      <div style="padding:14px 18px 18px;display:flex;gap:8px">
        <button id="q-cancel" style="flex:1;font:inherit;font-size:12.5px;font-weight:600;padding:11px 0;border-radius:11px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.08);color:var(--ink);cursor:pointer">Close</button>
        <button id="q-send" style="flex:1.4;font:inherit;font-size:12.5px;font-weight:700;padding:11px 0;border-radius:11px;border:0;background:var(--accent-grad);color:#0b0710;cursor:pointer">Request quote</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", (e) => { if (e.target === m || e.target.id === "q-cancel") m.remove(); });
  m.querySelector("#q-send").addEventListener("click", async () => {
    const button = m.querySelector("#q-send");
    button.disabled = true;
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: product.id, config: configurationPayload(state, product), url: location.href, ts: Date.now() }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      m.remove(); ui.showToast("Quote request sent"); track("quote_request");
    } catch (e) {
      console.warn("quote post failed", e);
      button.disabled = false;
      ui.showToast("Could not send quote request — please try again");
    }
  });
}

// ---- Dev panel: hidden by default; summon with the ` key or ?dev=1 ----------
{
  const studioEl = document.getElementById("studio");
  const setDev = (show) => {
    studioEl?.classList.toggle("hidden", !show);
    document.body.classList.toggle("dev-on", !!show);
  };
  setDev(new URLSearchParams(location.search).get("dev") === "1");
  addEventListener("keydown", (e) => {
    if ((e.key === "`" || e.key === "~") && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) setDev(studioEl.classList.contains("hidden"));
  });
}

// Mobile bottom sheet — tap the panel header to expand/collapse the controls.
{
  const panelEl = document.getElementById("panel");
  document.getElementById("ph")?.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 599px)").matches) panelEl?.classList.toggle("open");
  });
}

// Global UI toggle — hide every panel for an unobstructed view (esp. on phones).
document.getElementById("ui-toggle")?.addEventListener("click", () => {
  document.body.classList.toggle("ui-hidden");
});
// 'h' key also toggles the whole UI
addEventListener("keydown", (e) => {
  if (e.key === "h" && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) document.body.classList.toggle("ui-hidden");
});

// ---- View in AR -------------------------------------------------------------
// Export the CONFIGURED chair → GLB (+ USDZ for iOS), hand it to <model-viewer>.
// Slot a/b are swapped to 2K JPEG maps for the export (KTX2 can't go into a
// GLB/USDZ, and 4K would crash the phone). The tracer is paused while AR is up.
let arActive = false;
let arGLBURL = null;
let arUSDZURL = null;
function cleanupArAssets() {
  const mv = document.getElementById("ar-viewer");
  if (mv) { mv.src = ""; mv.iosSrc = ""; }
  if (arGLBURL) URL.revokeObjectURL(arGLBURL);
  if (arUSDZURL) URL.revokeObjectURL(arUSDZURL);
  arGLBURL = arUSDZURL = null;
}
async function viewInAR() {
  const overlay = document.getElementById("ar-overlay");
  const mv = document.getElementById("ar-viewer");
  if (!overlay || !mv) return;
  ui.showToast("Preparing AR model…");
  cleanupArAssets();
  arActive = true; // pause the path tracer during export + AR
  const saved = [];
  try {
    const TL = new THREE.TextureLoader();
    const jpg = async (def, stem, srgb) => {
      const t = await TL.loadAsync(`${def.arBase}/${stem}.jpg`);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(def.repeat ?? 2.4, def.repeat ?? 2.4);
      t.flipY = false; t.needsUpdate = true;
      return t;
    };
    for (const slot of productConfigSlots(product)) {
      const sw = byId(state[slot]); if (!sw?.pbr) continue;
      const def = sw.pbr, mat = materials[slot];
      saved.push({ mat, map: mat.map, normalMap: mat.normalMap, roughnessMap: mat.roughnessMap, metalnessMap: mat.metalnessMap, specularIntensityMap: mat.specularIntensityMap });
      mat.map = await jpg(def, def.maps.albedo, true);
      if (def.maps.normal) mat.normalMap = await jpg(def, def.maps.normal, false);
      if (def.maps.roughness) { mat.roughnessMap = await jpg(def, def.maps.roughness, false); mat.metalnessMap = null; }
      else if (def.maps.arm) { const arm = await jpg(def, def.maps.arm, false); mat.roughnessMap = arm; mat.metalnessMap = arm; }
      if (def.maps.spec) mat.specularIntensityMap = await jpg(def, def.maps.spec, false);
      mat.needsUpdate = true;
    }
    const [{ GLTFExporter }, { USDZExporter }] = await Promise.all([
      import("three/addons/exporters/GLTFExporter.js"),
      import("three/addons/exporters/USDZExporter.js"),
    ]);
    await import("@google/model-viewer");
    chair.updateMatrixWorld(true);
    const glb = await new GLTFExporter().parseAsync(chair, { binary: true });
    arGLBURL = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
    mv.src = arGLBURL;
    try {
      const usdz = await new USDZExporter().parseAsync(chair);
      arUSDZURL = URL.createObjectURL(new Blob([usdz], { type: "model/vnd.usdz+zip" }));
      mv.iosSrc = arUSDZURL;
    } catch (e) { console.warn("USDZ export failed (iOS AR unavailable):", e); }
    overlay.classList.add("show");
  } catch (e) {
    console.error("AR prepare failed:", e);
    cleanupArAssets();
    ui.showToast("Couldn't prepare AR — see console");
    arActive = false; needsRender = true; // AR didn't open — resume rendering
  } finally {
    // restore the live KTX2 maps (live view is paused, so no flicker)
    for (const s of saved) {
      s.mat.map = s.map; s.mat.normalMap = s.normalMap; s.mat.roughnessMap = s.roughnessMap;
      s.mat.metalnessMap = s.metalnessMap; s.mat.specularIntensityMap = s.specularIntensityMap;
      s.mat.needsUpdate = true;
    }
  }
}
document.getElementById("btn-ar")?.addEventListener("click", viewInAR);
document.getElementById("ar-close")?.addEventListener("click", () => {
  document.getElementById("ar-overlay")?.classList.remove("show");
  cleanupArAssets();
  arActive = false; needsRender = true; // resume the path tracer
});


// ---- Loop (render-on-demand: skip frames when nothing moves) ----------------
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
// needsRender declared early (near flight) to avoid TDZ for updateProbe/updateContactShadow + callbacks executed during/after top-level awaits and initUI
controls.addEventListener("change", () => {
  needsRender = true;
  if (photoMode) {
    updatePhotoCamera(camera);
    markPhotoSceneDirty();
  }
});
// repaint whenever async textures (fabric swaps) finish arriving
THREE.DefaultLoadingManager.onLoad = () => (needsRender = true);

// Diagnostics — Studio header shows fps (#fps). ?stats=1 adds a corner overlay
// with fps, path-traced samples/sec + accumulated spp, and the live GPU/backend
// so you can confirm the trace runs on the GPU, not a software fallback.
const fpsEl = document.getElementById("fps");
let statsEl = null, frames = 0, statT = performance.now();
let prevSpp = 0, sps = 0;
const gpu = (() => {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const soft = /swiftshader|llvmpipe|software|microsoft basic|basic render/i.test(name || "");
    const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    return { name: name || "unknown", soft, webgl2 };
  } catch { return { name: "unknown", soft: false, webgl2: false }; }
})();
console.log(`[GPU] ${gpu.name} · WebGL2:${gpu.webgl2} · ${gpu.soft ? "SOFTWARE ⚠" : "hardware"}`);
if (new URLSearchParams(location.search).has("stats")) {
  statsEl = document.createElement("div");
  statsEl.style.cssText =
    "position:fixed;left:12px;bottom:12px;z-index:50;font:11px/1.5 monospace;color:#7CFC00;background:rgba(0,0,0,0.72);padding:6px 9px;border-radius:6px;white-space:pre;pointer-events:none";
  document.body.appendChild(statsEl);
}
// Always-on samples/sec counter, top-left, green (like an FPS readout).
const sppCounterEl = document.createElement("div");
sppCounterEl.style.cssText = "position:fixed;top:12px;left:12px;z-index:50;font:700 13px/1 ui-monospace,monospace;color:#3cff8e;text-shadow:0 1px 3px rgba(0,0,0,0.7);pointer-events:none";
if (!embedMode) document.body.appendChild(sppCounterEl);
let lastTraceReport = 0;

renderer.setAnimationLoop(() => {
  if (flight) {
    flight.t = Math.min(1, flight.t + 0.022);
    const e = easeInOut(flight.t);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    controls.target.lerpVectors(flight.fromTgt, flight.toTgt, e);
    if (flight.t >= 1) flight = null;
    needsRender = true;
  }
  if (controls.autoRotate) needsRender = true;
  if (controls.update()) needsRender = true;
  if (renderer.shadowMap.needsUpdate) needsRender = true;

  if (isExporting() || arActive || externalTracePaused) return; // transition/export owns the renderer — no wasted PT samples

  if (photoMode) {
    // progressive path tracer: sample every frame; it resets its own
    // accumulation on camera / material / env changes (see the update* calls)
    // While the user is dragging (or the camera is flying), DON'T trace — show
    // only the wireframe. Sampling then is wasted (every move resets it). Resume
    // accumulation the moment it's settled.
    const manipulating = controlsActive || !!flight;
    const spp = getPhotoSamples();
    if (performance.now() - lastTraceReport > 500) {
      lastTraceReport = performance.now();
      postToParent({ type: "configurator:traceState", status: spp > 0 ? "tracing" : "starting", samples: spp });
    }
    const reachedSampleCap = SAMPLE_CAP > 0 && spp >= SAMPLE_CAP;
    if (reachedSampleCap) {
      setDenoiseActive(true);
      ptFrozen = true;
    } else if (manipulating) {
      renderRasterPreview(); // shaded raster bridge while orbiting (was wireframe)
      ptAccumStart = 0; ptFrozen = false; // restart the time budget once it settles
      setDenoiseActive(false);            // denoise only once the trace is revealed
    } else if (SAMPLE_MS) {
      if (spp <= 0 || spp < ptPrevSpp) { ptAccumStart = 0; ptFrozen = false; } // compiling / reset
      else if (ptAccumStart === 0) ptAccumStart = performance.now();            // first real sample → start clock
      const elapsed = ptAccumStart > 0 ? performance.now() - ptAccumStart : 0;
      const renderMs = Math.max(SAMPLE_MS, MIN_RENDER_MS); // render at least MIN_RENDER_MS
      setDenoiseActive(elapsed >= SAMPLE_MS); // denoiser switches on AT the cutoff reveal, then stays on
      if (ptAccumStart === 0 || elapsed < renderMs) {
        renderPhotoTracer();                            // keep accumulating for the full render time
        if (elapsed < SAMPLE_MS) renderRasterPreview(); // shaded raster covers the trace until the cutoff reveal
      } else if (!ptFrozen) {
        ptFrozen = true;
        renderPhotoTracer();                            // freeze → final converged blit
      }
    } else {
      setDenoiseActive(spp >= PT_READY_SAMPLES); // Pro (no cutoff): denoise once past the warm-up
      renderPhotoTracer();
      if (!SAMPLE_CAP && spp < PT_READY_SAMPLES) renderRasterPreview(); // post-settle warm-up (shaded raster)
    }
    // Drop product 2 into the trace scene once PT is live (both path-traced).
    if (desk2 && !desk2InPT) { addTracedObject(desk2); desk2InPT = true; }
    ptPrevSpp = spp;
    if (pqSamplesEl) pqSamplesEl.textContent = `${Math.round(spp)} spp`;
    // Render pill = a determinate progress bar over the cutoff budget (elapsed / cutoff).
    let pillShow, pillProgress = 0;
    if (SAMPLE_MS) {
      const elapsedMs = ptAccumStart > 0 ? performance.now() - ptAccumStart : 0;
      pillShow = !manipulating && !ptFrozen && (ptAccumStart === 0 || elapsedMs < SAMPLE_MS); // until the reveal
      pillProgress = ptAccumStart > 0 ? Math.min(1, elapsedMs / SAMPLE_MS) : 0; // bar tracks the cutoff, not the 5s floor
    } else {
      pillShow = manipulating || spp < PT_READY_SAMPLES;
    }
    if (ptSpinnerEl) {
      ptSpinnerEl.classList.toggle("show", pillShow || bakeArmed);
      const bar = ptSpinnerEl.querySelector(".pt-bar i");
      if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, pillProgress))})`;
    }
    if (bakeArmed && spp >= BAKE_SAMPLES) { bakeArmed = false; doBake(); }
    needsRender = false;
    frames += 1;
  } else if (needsRender) {
    const usePost = post.bloom || post.dof || post.grain;
    if (usePost) {
      if (!composer) initPost();
      updatePost();
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
    needsRender = false;
    frames += 1;
  }
  {
    const now = performance.now();
    if (now - statT > 500) {
      const dt = (now - statT) / 1000;
      const fps = Math.round((frames * 1000) / (now - statT));
      const spp = photoMode ? getPhotoSamples() : 0;
      const dSpp = spp - prevSpp;
      sps = dSpp > 0 ? Math.round(dSpp / dt) : 0; // samples/sec (0 right after a reset)
      prevSpp = spp;
      if (fpsEl) fpsEl.textContent = `${fps} fps`;
      sppCounterEl.textContent = photoMode ? `${sps} spp/s` : "";
      if (statsEl) {
        statsEl.textContent =
          `${fps} fps` + (photoMode ? ` · ${sps} spp/s · ${Math.round(spp)} samples` : ` (raster)`) + `\n` +
          `GPU: ${gpu.name}\n` +
          `WebGL2 ${gpu.webgl2 ? "✓" : "✗"} · ${gpu.soft ? "SOFTWARE ⚠" : "hardware ✓"} · ${renderer.info.render.calls} calls`;
      }
      frames = 0;
      statT = now;
    }
  }
});

function resizeRendererToViewport({ restartTrace = true } = {}) {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  pendingViewportResize = false;
  if (photoMode && restartTrace) {
    updatePhotoCamera(camera);
    markPhotoSceneDirty();
    ptAccumStart = 0;
    ptPrevSpp = 0;
    ptFrozen = false;
  }
  needsRender = true;
}

function setExternalTracePaused(paused) {
  const next = Boolean(paused);
  if (next === externalTracePaused && !(pendingViewportResize && !next)) return;
  externalTracePaused = next;
  document.body.dataset.cfgTracePaused = String(next);
  if (next) {
    postToParent({ type: "configurator:traceState", status: "paused", samples: getPhotoSamples() });
    return;
  }
  // The host waits for the fullscreen layout to settle before resuming. Resize
  // once at the final dimensions, reset accumulation, then restart the tracer.
  resizeRendererToViewport({ restartTrace: true });
  postToParent({ type: "configurator:traceState", status: "starting", samples: 0 });
}

addEventListener("resize", () => {
  if (externalTracePaused) {
    pendingViewportResize = true;
    return;
  }
  resizeRendererToViewport({ restartTrace: true });
});

// Debug handle for headless verification
window.__demo = { renderer, scene, camera, controls, chair, materials, state, flyTo, env };
BT("BOOT COMPLETE — loop running, __demo set");

// ---- Debug / dev panel: full control over every raster lever and path-tracer
// setting, logically grouped (Render mode → Raster → PT quality → PT post).
// Raster is the default view; PT + lightmap are toggles. Always-visible.
(function debugPanel() {
  const body = document.querySelector("#studio .sbody");
  if (!body) return;
  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = '<div class="label">Debug</div>';

  const subhead = (text) => {
    const h = document.createElement("div");
    h.style.cssText = "font-size:9.5px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,245,246,0.4);margin:15px 0 4px";
    h.textContent = text; sec.appendChild(h);
  };
  const mkBtn = (text, on) => {
    const b = document.createElement("button");
    b.textContent = text; b._on = on;
    b.style.cssText = "font:inherit;font-size:11px;padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);cursor:pointer";
    b._paint = () => { b.style.background = b._on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.05)"; b.style.color = b._on ? "#111" : "rgba(245,245,246,0.85)"; };
    b._paint(); return b;
  };
  const slider = (label, value, min, max, step, fmt, onInput) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px";
    const lab = document.createElement("span");
    lab.style.cssText = "font-size:11px;color:rgba(245,245,246,0.7);min-width:104px";
    lab.textContent = label;
    const s = document.createElement("input");
    s.type = "range"; s.min = min; s.max = max; s.step = step; s.value = value;
    s.style.cssText = "flex:1;accent-color:#fff;cursor:pointer";
    const v = document.createElement("span");
    v.style.cssText = "font:11px ui-monospace,monospace;color:rgba(245,245,246,0.85);min-width:44px;text-align:right";
    v.textContent = fmt(+value);
    s.addEventListener("input", () => { const val = parseFloat(s.value); v.textContent = fmt(val); onInput(val); });
    s._label = v; s._fmt = fmt; // external display sync (preset changes call these)
    wrap.append(lab, s, v); sec.appendChild(wrap);
    return s;
  };

  // — Render mode —
  const togRow = document.createElement("div");
  togRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
  const ptBtn = mkBtn("Path Trace", photoMode);
  ptBtn.addEventListener("click", () => { ptBtn._on = !ptBtn._on; ptBtn._paint(); FEATURES.find((f) => f.key === "photoMode")?.apply(ptBtn._on); });
  const lmBtn = mkBtn("Lightmap", true);
  lmBtn.addEventListener("click", () => {
    lmBtn._on = !lmBtn._on; lmBtn._paint();
    for (const m of Object.values(materials)) { if (!m || !m.userData.bakedLM) continue; m.lightMap = lmBtn._on ? m.userData.bakedLM : null; m.needsUpdate = true; }
    needsRender = true;
  });
  togRow.append(ptBtn, lmBtn); sec.appendChild(togRow);

  // — Raster levers —
  subhead("Raster");
  slider("Lightmap intensity", materials.a?.lightMapIntensity ?? 1, 0, 3, 0.05, (v) => v.toFixed(2), (v) => {
    for (const m of Object.values(materials)) { if (m) m.lightMapIntensity = v; } needsRender = true;
  });
  slider("AO strength", materials.a?.aoMapIntensity ?? 1.5, 0, 2, 0.05, (v) => v.toFixed(2), (v) => {
    for (const m of Object.values(materials)) { if (m) m.aoMapIntensity = v; } needsRender = true;
  });
  let keyLight = null;
  scene.traverse((n) => { if (n.isDirectionalLight && n.intensity > 0.5) keyLight = n; });
  if (keyLight) slider("Key light", keyLight.intensity, 0, 4, 0.05, (v) => v.toFixed(2), (v) => { keyLight.intensity = v; needsRender = true; });
  slider("Camera lamp", cameraLamp.intensity, 0, 120, 1, (v) => `${v | 0}`, (v) => { cameraLamp.intensity = v; setPhotoLampIntensity(v); needsRender = true; if (photoMode) markPhotoSceneDirty(); });
  slider("Exposure", renderer.toneMappingExposure, 0.2, 2.5, 0.01, (v) => v.toFixed(2), (v) => { renderer.toneMappingExposure = v; needsRender = true; });

  // — Path tracer: quality —
  subhead("Path tracer — quality");
  const dp = QUALITY_PRESETS[defaultQualityKey];
  rsInput = slider("Render scale", dp.renderScale, 0.4, 2, 0.05, (v) => v.toFixed(2), (v) => setPhotoQuality({ renderScale: v }));
  bnInput = slider("Bounces", dp.bounces, 1, 12, 1, (v) => `${v | 0}`, (v) => setPhotoQuality({ bounces: v }));
  spfInput = slider("Samples / frame", dp.samplesPerFrame, 1, 8, 1, (v) => `${v | 0}`, (v) => setPhotoQuality({ samplesPerFrame: v }));
  glossyInput = slider("Filter glossy", dp.filterGlossyFactor, 0, 1, 0.01, (v) => v.toFixed(2), (v) => setPhotoQuality({ filterGlossyFactor: v }));
  cutoffInput = slider("Cutoff (ms)", dp.cutoffMs, 0, 2000, 10, (v) => `${v | 0}`, (v) => { SAMPLE_MS = v; ptAccumStart = 0; ptFrozen = false; });

  // — Path tracer: final denoise —
  subhead("Path tracer — post");
  slider("Denoise sigma", 2.0, 0.5, 8, 0.1, (v) => v.toFixed(1), (v) => setDenoise({ sigma: v }));
  slider("Denoise kSigma", 1.0, 0.5, 3, 0.05, (v) => v.toFixed(2), (v) => setDenoise({ kSigma: v }));
  slider("Denoise threshold", 0.035, 0.005, 0.2, 0.005, (v) => v.toFixed(3), (v) => setDenoise({ threshold: v }));

  body.insertBefore(sec, body.firstChild);
})();

// ---- Live material editor: every adjustable PBR scalar on any of the product's
// materials, tweakable in real time. Textures/maps are baked prep work (locked);
// the shader parameters (roughness, metalness, reflectivity, clearcoat, sheen,
// IOR, …) are exposed. Raster updates instantly; the path tracer re-syncs when on.
(function materialEditor() {
  const body = document.querySelector("#studio .sbody");
  if (!body) return;
  // Only params the material actually has (typeof === number) get a slider, so
  // MeshStandard (frame) shows fewer than MeshPhysical (fabric/chrome) automatically.
  const PARAMS = [
    { key: "roughness",          label: "Roughness",       min: 0, max: 1,     step: 0.01 },
    { key: "metalness",          label: "Metalness",       min: 0, max: 1,     step: 0.01 },
    { key: "envMapIntensity",    label: "Reflectivity",    min: 0, max: 3,     step: 0.05 },
    { key: "clearcoat",          label: "Clearcoat",       min: 0, max: 1,     step: 0.01 },
    { key: "clearcoatRoughness", label: "Clearcoat rough", min: 0, max: 1,     step: 0.01 },
    { key: "sheen",              label: "Sheen",           min: 0, max: 1,     step: 0.01 },
    { key: "sheenRoughness",     label: "Sheen rough",     min: 0, max: 1,     step: 0.01 },
    { key: "ior",                label: "IOR",             min: 1, max: 2.333, step: 0.01 },
    { key: "specularIntensity",  label: "Specular",        min: 0, max: 1,     step: 0.01 },
  ];
  const niceLabel = (s) => ({ a: "Fabric A", b: "Fabric B", c: "Fabric C", black: "Frame", chrome: "Chrome" }[s] ||
    s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
  const SLOTS = product.slots.map((s) => [s, niceLabel(s)]);
  let current = product.slots[0] || "a";
  const mats = () => (activeP && activeP.materials) || materials;

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = '<div class="label">Material</div>';
  const tabs = document.createElement("div");
  tabs.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px";
  const paramWrap = document.createElement("div");
  paramWrap.style.cssText = "display:flex;flex-direction:column;gap:8px";

  const mkRow = (label, value, min, max, step, onInput) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:8px";
    const lab = document.createElement("span");
    lab.style.cssText = "font-size:11px;color:rgba(245,245,246,0.7);min-width:96px";
    lab.textContent = label;
    const s = document.createElement("input");
    s.type = "range"; s.min = min; s.max = max; s.step = step; s.value = value;
    s.style.cssText = "flex:1;accent-color:#fff;cursor:pointer";
    const v = document.createElement("span");
    v.style.cssText = "font:11px ui-monospace,monospace;color:rgba(245,245,246,0.85);min-width:34px;text-align:right";
    v.textContent = (+value).toFixed(2);
    s.addEventListener("input", () => { const val = parseFloat(s.value); v.textContent = val.toFixed(2); onInput(val); });
    wrap.append(lab, s, v);
    return wrap;
  };

  function buildParams() {
    paramWrap.innerHTML = "";
    const mat = mats()[current];
    if (!mat) return;
    for (const p of PARAMS) {
      if (typeof mat[p.key] !== "number") continue;
      paramWrap.appendChild(mkRow(p.label, mat[p.key], p.min, p.max, p.step, (val) => {
        mat[p.key] = val; needsRender = true; if (photoMode) syncPhotoMaterials(); // scalar uniforms — no needsUpdate (no recompile)
      }));
    }
    if (mat.normalScale && mat.normalMap) {
      paramWrap.appendChild(mkRow("Normal depth", mat.normalScale.x, 0, 2, 0.01, (val) => {
        mat.normalScale.set(val, val); needsRender = true; if (photoMode) syncPhotoMaterials();
      }));
    }
  }

  const paintTabs = () => [...tabs.children].forEach((b) => {
    const on = b.dataset.slot === current;
    b.style.background = on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.05)";
    b.style.color = on ? "#111" : "rgba(245,245,246,0.85)";
  });
  for (const [key, label] of SLOTS) {
    const b = document.createElement("button");
    b.textContent = label; b.dataset.slot = key;
    b.style.cssText = "font:inherit;font-size:10.5px;padding:5px 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.16);cursor:pointer";
    b.addEventListener("click", () => { current = key; paintTabs(); buildParams(); });
    tabs.appendChild(b);
  }
  paintTabs(); buildParams();
  sec.append(tabs, paramWrap);
  body.insertBefore(sec, body.children[1] || null); // just below the Debug section
})();

// Path tracer is the default view — enable it AFTER first paint so its BVH build
// + shader compile can't block the raster chair from showing. The loop above is
// already rendering raster; flipping photoMode hands rendering to the tracer,
// which shows raster while it warms up, then refines to photoreal.
if (ptDefault) {
  // Enable PT right after the first raster frame paints. rAF = "next frame" on a
  // focused tab; the setTimeout fallback covers hidden/throttled tabs where rAF
  // is paused (otherwise PT would never turn on). Idempotent — first one wins.
  let ptStarted = false;
  const enablePT = () => {
    if (ptStarted) return;
    ptStarted = true;
    BT("path tracer enable start");
    try { FEATURES.find((f) => f.key === "photoMode")?.apply(true); BT("path tracer enable done"); }
    catch (e) { console.error("path tracer enable failed (staying on raster):", e); }
  };
  requestAnimationFrame(() => requestAnimationFrame(enablePT));
  setTimeout(enablePT, 400);
}
