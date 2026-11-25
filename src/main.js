// Fern Room configurator.
//
// One scene, three layers:
//   scene-config.js  what can be configured (slots, finishes, views, price)
//   this file        the live renderer, camera, UI wiring and URL state
//   photo-tracer.js  the path-traced photo render, loaded only on capable devices
//
// The live renderer draws while anything moves. Once the view is still, the
// path tracer accumulates samples and its image fades in over the live frame.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { SCENE, findFinish, findView, readState, writeState, describeState, priceInfo } from "./scene-config.js";
import { chooseRenderTier } from "./capabilities.js";
import { createStudio } from "./studio.js";
import { createFinishes } from "./finishes.js";

const params = new URLSearchParams(location.search);
const embedMode = params.get("embed") === "1";
const $ = (id) => document.getElementById(id);

// ---- Hooks for host pages: analytics and embed messaging --------------------
const brand = window.CONFIGURATOR_BRAND || {};
function postToParent(message) {
  try {
    if (!window.parent || window.parent === window) return;
    const origin = brand.parentOrigin || params.get("parentOrigin");
    if (!origin) return; // never post to an unknown parent
    window.parent.postMessage(message, new URL(origin, location.origin).origin);
  } catch { /* an invalid origin just disables messaging */ }
}
function track(event, data = {}) {
  const payload = { event, ...describeState(state), ...data, ts: Date.now() };
  try { (window.dataLayer = window.dataLayer || []).push({ ...payload, event: `configurator_${event}` }); } catch { /* optional */ }
  try { if (typeof window.CONFIGURATOR_ANALYTICS === "function") window.CONFIGURATOR_ANALYTICS(payload); } catch { /* optional */ }
  postToParent({ type: "configurator:event", event: payload });
}

// ---- State ------------------------------------------------------------------
const state = readState(params);
function syncUrl() {
  const next = writeState(state);
  for (const key of ["embed", "parentOrigin", "render", "debug"]) if (params.has(key)) next.set(key, params.get(key));
  history.replaceState(null, "", `${location.pathname}?${next}`);
  updatePhoneCode();
}

// ---- "Try it on your phone" QR code ------------------------------------------
// Shown on roomy desktop screens only (see the media query in index.html). The
// QR library is loaded on demand and the code follows the current configuration.
let qrModule = null;
let qrUrl = "";
async function updatePhoneCode() {
  const card = $("phone");
  if (!card || getComputedStyle(card).display === "none") return;
  const url = `${location.origin}${location.pathname}?${writeState(state)}`;
  if (url === qrUrl) return;
  qrUrl = url;
  try {
    qrModule ||= await import("qrcode");
    const svg = await (qrModule.default ?? qrModule).toString(url, {
      type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1c1a17", light: "#ffffff" },
    });
    if (url !== qrUrl) return; // a newer configuration is already being drawn
    card.querySelector(".code").innerHTML = svg;
    card.dataset.ready = "1";
  } catch (error) {
    console.warn("QR code unavailable", error);
    card.hidden = true;
  }
}

// ---- Renderer ---------------------------------------------------------------
const app = $("app");
function fatal(title, detail) {
  $("loader")?.remove();
  const el = $("fatal");
  el.querySelector("h2").textContent = title;
  el.querySelector("p").textContent = detail;
  el.hidden = false;
}

let renderer;
try {
  // preserveDrawingBuffer keeps the last frame on the canvas, which the
  // photo render fades over and "Save image" reads back.
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
} catch (error) {
  fatal("3D preview unavailable", "This browser could not start WebGL. Check that hardware acceleration is on, then reload.");
  throw error;
}
const gl = renderer.getContext();
const rendererName = (() => {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return ""; }
})();
const isMobile = navigator.userAgentData?.mobile === true
  || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 900);
// If a photo render attempt took the page down (out of memory, lost context),
// this flag survives the reload and keeps the device on the live renderer.
const PHOTO_FLAG = "configurator:photo-render";
const readFlag = () => { try { return sessionStorage.getItem(PHOTO_FLAG); } catch { return null; } };
const writeFlag = (value) => { try { value ? sessionStorage.setItem(PHOTO_FLAG, value) : sessionStorage.removeItem(PHOTO_FLAG); } catch { /* storage may be blocked */ } };
const tier = chooseRenderTier({
  webgl2: /^WebGL 2/i.test(String(gl.getParameter(gl.VERSION))),
  rendererName,
  deviceMemory: navigator.deviceMemory || 4,
  hardwareConcurrency: navigator.hardwareConcurrency || 4,
  isMobile,
  saveData: navigator.connection?.saveData === true,
  floatRenderTargets: Boolean(gl.getExtension("EXT_color_buffer_float")),
  photoRenderFailed: readFlag() !== null,
  requested: params.get("render"),
});
document.documentElement.dataset.renderTier = tier.key;

renderer.setPixelRatio(Math.min(devicePixelRatio, tier.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping; // keeps finish colours true; only highlights roll off
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.shadowMap.autoUpdate = false; // the scene is static: render the shadow map on demand
app.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 80);
const studio = createStudio(scene, renderer);
studio.rasterRig.children[0].shadow.mapSize.setScalar(tier.shadowMapSize);
studio.useTracedLighting(false);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.minDistance = 1.1;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI / 2 - 0.03; // stay above the floor
controls.zoomSpeed = 0.8;
const TARGET_BOUNDS = new THREE.Box3(new THREE.Vector3(-1.1, 0.25, -2.2), new THREE.Vector3(1.1, 2.0, 2.2));

// ---- Loading ----------------------------------------------------------------
const loaderBar = document.querySelector("#loader .bar i");
const setLoading = (fraction) => { if (loaderBar) loaderBar.style.transform = `scaleX(${Math.min(1, Math.max(0.04, fraction))})`; };

const draco = new DRACOLoader().setDecoderPath("draco/");
draco.setDecoderConfig({ type: "wasm" });
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);

let product;
try {
  const gltf = await new Promise((resolve, reject) => {
    gltfLoader.load(SCENE.model, resolve, (e) => { if (e.total) setLoading(0.9 * e.loaded / e.total); }, reject);
  });
  product = gltf.scene;
} catch (error) {
  console.error(error);
  fatal("The scene could not be loaded", "Check your connection, then reload the page.");
  throw error;
}
draco.dispose();

// Normalise: real-world height, standing on y = 0, centred on the origin.
{
  const box = new THREE.Box3().setFromObject(product);
  product.scale.setScalar(SCENE.height / (box.max.y - box.min.y));
  box.setFromObject(product);
  const centre = box.getCenter(new THREE.Vector3());
  product.position.set(-centre.x, -box.min.y, -centre.z);
}
const slotMeshes = {};
const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
product.traverse((node) => {
  if (!node.isMesh) return;
  node.castShadow = true;
  node.receiveShadow = true;
  const name = node.name.toLowerCase().replace(/\.\d+$/, "");
  if (SCENE.slots.some((slot) => slot.id === name)) slotMeshes[name] = node;
  const material = node.material;
  if (material.map) material.map.anisotropy = maxAnisotropy;
  // Cut-out foliage must not write soft shadow edges as solid quads.
  if (material.alphaTest > 0) material.shadowSide = THREE.DoubleSide;
  // The tube light is the only emitter; it should not be dimmed by its own shadow.
  if (material.emissiveIntensity > 0 && material.emissive?.getHex() > 0) node.castShadow = false;
});
scene.add(product);
const finishes = createFinishes(slotMeshes, { anisotropy: maxAnisotropy });
for (const slot of SCENE.slots) finishes.apply(slot.id, findFinish(slot.id, state[slot.id]));

// ---- Camera views -----------------------------------------------------------
// Keep the product clear of the control panel by shifting the projection.
function layoutCamera() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  const panel = $("panel");
  let dx = 0, dy = 0;
  if (panel && !embedMode && getComputedStyle(panel).display !== "none") {
    const rect = panel.getBoundingClientRect();
    if (rect.width < w * 0.7) dx = (w - rect.left) / 2;      // side panel: shift the view left
    else dy = Math.min(h * 0.5, h - rect.top) / 2;            // bottom sheet: shift the view up
  }
  if (dx || dy) camera.setViewOffset(w, h, dx, dy, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
// Views are authored for a landscape window; step back on narrow or tall ones.
function viewPose(view) {
  const target = new THREE.Vector3(...view.target);
  const offset = new THREE.Vector3(...view.position).sub(target);
  const usable = Math.max(0.35, (innerWidth - (innerWidth >= 900 ? 380 : 0)) / innerHeight);
  offset.multiplyScalar(THREE.MathUtils.clamp(1.25 / usable, 1, 2.05));
  // Stay inside the orbit limits, or the controls would keep correcting the camera
  // every frame and the view would never count as still.
  offset.clampLength(controls.minDistance + 0.05, controls.maxDistance - 0.25);
  return { position: target.clone().add(offset), target };
}
let flight = null;
function goToView(id, { instant = false } = {}) {
  const view = findView(id);
  if (!view) return;
  const pose = viewPose(view);
  if (instant || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    camera.position.copy(pose.position);
    controls.target.copy(pose.target);
    controls.update();
    flight = null;
  } else {
    flight = { start: performance.now(), duration: 1100, fromPosition: camera.position.clone(), fromTarget: controls.target.clone(), ...pose };
  }
  invalidate();
}
controls.addEventListener("start", () => { flight = null; });

// ---- Render loop ------------------------------------------------------------
let photo = null;          // the path tracer, once loaded and built
let liveDirty = true;      // the live frame needs redrawing
let lastMotion = performance.now();
let lastFrame = performance.now();
let tracedOnScreen = false;
const SETTLE_MS = tier.photo?.settleMs ?? 220; // stillness before the photo render starts

function invalidate() {
  liveDirty = true;
  lastMotion = performance.now();
}

function drawLive() {
  if (tracedOnScreen) renderer.resetState(); // the tracer drives GL state directly
  tracedOnScreen = false;
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  liveDirty = false;
}

function frame(now) {
  requestAnimationFrame(frame);
  const frameMs = now - lastFrame;
  lastFrame = now;

  if (flight) {
    const t = Math.min(1, (now - flight.start) / flight.duration);
    const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(flight.fromPosition, flight.position, k);
    controls.target.lerpVectors(flight.fromTarget, flight.target, k);
    if (t >= 1) flight = null;
    invalidate();
  }
  controls.target.clamp(TARGET_BOUNDS.min, TARGET_BOUNDS.max);
  if (controls.update()) invalidate();

  const still = now - lastMotion > SETTLE_MS;
  if (photo && still && !document.hidden) {
    if (liveDirty) drawLive();           // make sure the frame under the fade is current
    if (photo.stale) { photo.cameraChanged(); photo.stale = false; }
    photo.render(frameMs);
    tracedOnScreen = true;
    updateStatus();
  } else if (liveDirty) {
    drawLive();
    if (photo) { photo.stale = true; updateStatus(); }
  }
}

// ---- Photo render status ----------------------------------------------------
const statusEl = $("status");
let statusKey = "";
function updateStatus() {
  if (!statusEl) return;
  let key = "hidden", label = "", progress = 0;
  if (photo) {
    if (photo.compiling) { key = "preparing"; label = "Preparing photo render"; }
    else if (photo.stale || !photo.revealed) { key = "preparing"; label = "Live preview"; }
    else if (!photo.done) { key = "rendering"; label = "Rendering photo"; progress = photo.progress; if (photo.samples > 12) writeFlagOnce(); }
    else { key = "done"; label = "Photo render"; progress = 1; }
  }
  statusEl.style.setProperty("--progress", progress.toFixed(3));
  if (key === statusKey) return;
  statusKey = key;
  statusEl.dataset.state = key;
  statusEl.querySelector("span").textContent = label;
}

// A normal navigation away is not a crash: only an abrupt kill leaves the flag set.
addEventListener("pagehide", () => { if (readFlag() === "attempting") writeFlag(null); });
let flagCleared = false;
function writeFlagOnce() { if (!flagCleared) { flagCleared = true; writeFlag(null); } }

async function startPhotoRender() {
  if (!tier.pathTracing) return;
  try {
    const { createPhotoTracer } = await import("./photo-tracer.js");
    // Let the first live frame paint before the BVH build blocks the thread.
    await new Promise((resolve) => setTimeout(resolve, 60));
    writeFlag("attempting"); // cleared once the first traced image is on screen
    const tracer = createPhotoTracer(renderer, scene, camera, { studio, ...tier.photo });
    tracer.build();
    tracedOnScreen = true; // the build touched GL state; resync before the next live frame
    tracer.stale = true;
    photo = tracer;
    document.documentElement.dataset.photo = "on";
    updateStatus();
  } catch (error) {
    console.warn("Photo render unavailable; staying on the live renderer.", error);
    writeFlag("failed");
    photo = null;
    renderer.resetState();
    invalidate();
  }
}

// ---- UI ---------------------------------------------------------------------
const toastEl = $("toast");
let toastTimer = 0;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
}

function setFinish(slotId, finishId, { silent = false } = {}) {
  const finish = findFinish(slotId, finishId);
  if (!finish || !finishes.apply(slotId, finish)) return false;
  state[slotId] = finishId;
  const fieldset = document.querySelector(`fieldset[data-slot="${slotId}"]`);
  if (fieldset) {
    fieldset.querySelector(".current").textContent = finish.name;
    const input = fieldset.querySelector(`input[value="${finishId}"]`);
    if (input) input.checked = true;
  }
  renderer.shadowMap.needsUpdate = true;
  invalidate();
  if (photo) { photo.materialsChanged(); tracedOnScreen = true; }
  syncUrl();
  if (!silent) {
    track("finish", { slot: slotId, finish: finishId });
    postToParent({ type: "configurator:change", state: describeState(state) });
  }
  return true;
}

function setView(viewId, options) {
  if (!findView(viewId)) return false;
  state.view = viewId;
  for (const button of document.querySelectorAll("#views button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === viewId));
  }
  goToView(viewId, options);
  syncUrl();
  return true;
}

function buildPanel() {
  $("kind").textContent = SCENE.kind;
  $("title").textContent = SCENE.name;
  const { price, leadTime } = priceInfo(window.CONFIGURATOR_PRICING);
  const priceEl = $("price");
  if (price) {
    priceEl.querySelector(".amount").textContent = `£${price}`;
    priceEl.querySelector(".lead").textContent = leadTime ? `${leadTime} lead time` : "";
    priceEl.querySelector(".note").hidden = SCENE.pricing.sample !== true;
  } else {
    priceEl.hidden = true;
  }

  const slotsEl = $("slots");
  for (const slot of SCENE.slots) {
    if (!finishes.has(slot.id)) continue;
    const fieldset = document.createElement("fieldset");
    fieldset.dataset.slot = slot.id;
    const legend = document.createElement("legend");
    legend.innerHTML = `<span class="name"></span><span class="current" aria-live="polite"></span>`;
    legend.querySelector(".name").textContent = slot.label;
    fieldset.append(legend);
    const row = document.createElement("div");
    row.className = "swatches";
    for (const finish of slot.finishes) {
      const label = document.createElement("label");
      label.className = "swatch";
      label.title = finish.name;
      const input = Object.assign(document.createElement("input"), { type: "radio", name: `slot-${slot.id}`, value: finish.id });
      input.checked = state[slot.id] === finish.id;
      input.addEventListener("change", () => setFinish(slot.id, finish.id));
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.setProperty("--swatch", finish.swatch || finish.color);
      const text = document.createElement("span");
      text.className = "visually-hidden";
      text.textContent = finish.name;
      label.append(input, chip, text);
      row.append(label);
    }
    fieldset.append(row);
    slotsEl.append(fieldset);
    fieldset.querySelector(".current").textContent = findFinish(slot.id, state[slot.id]).name;
  }

  const viewsEl = $("views");
  for (const view of SCENE.views) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.view = view.id;
    button.textContent = view.label;
    button.setAttribute("aria-pressed", String(state.view === view.id));
    button.addEventListener("click", () => { setView(view.id); track("view", { view: view.id }); });
    viewsEl.append(button);
  }

  $("btn-save").addEventListener("click", saveImage);
  $("btn-share").addEventListener("click", share);
  const arButton = $("btn-ar");
  arButton.hidden = !isMobile;
  arButton.addEventListener("click", openAR);
  $("ar-close").addEventListener("click", () => { $("ar-overlay").hidden = true; });

  const sheetToggle = $("sheet-toggle");
  sheetToggle.addEventListener("click", () => {
    const collapsed = $("panel").classList.toggle("collapsed");
    sheetToggle.setAttribute("aria-expanded", String(!collapsed));
    requestAnimationFrame(() => { layoutCamera(); invalidate(); });
  });
}

function fileStem() {
  return [SCENE.id, ...SCENE.slots.map((slot) => state[slot.id])].join("-").replace(/_/g, "-");
}

function saveImage() {
  if (liveDirty) drawLive();
  renderer.domElement.toBlob((blob) => {
    if (!blob) return toast("The image could not be saved");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${fileStem()}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    toast(photo?.revealed ? "Photo render saved" : "Image saved");
    track("save_image", { traced: Boolean(photo?.revealed), samples: photo?.samples ?? 0 });
  }, "image/png");
}

async function share() {
  syncUrl();
  const url = location.href;
  const title = `${SCENE.name}: ${SCENE.slots.map((slot) => findFinish(slot.id, state[slot.id]).name).join(", ")}`;
  track("share");
  try {
    if (isMobile && navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
    toast("Link to this configuration copied");
  } catch (error) {
    if (error?.name !== "AbortError") toast("Copy the address bar to share this configuration");
  }
}

// AR: export the configured scene and hand it to <model-viewer> (Scene Viewer / Quick Look).
let arUrl = null;
async function openAR() {
  const button = $("btn-ar");
  button.disabled = true;
  toast("Preparing AR…");
  try {
    const [{ GLTFExporter }] = await Promise.all([
      import("three/addons/exporters/GLTFExporter.js"),
      import("@google/model-viewer"),
    ]);
    const buffer = await new GLTFExporter().parseAsync(product, { binary: true, maxTextureSize: 1024 });
    if (arUrl) URL.revokeObjectURL(arUrl);
    arUrl = URL.createObjectURL(new Blob([buffer], { type: "model/gltf-binary" }));
    const viewer = $("ar-viewer");
    viewer.src = arUrl;
    $("ar-overlay").hidden = false;
    track("ar_open");
  } catch (error) {
    console.error(error);
    toast("AR is not available on this device");
  } finally {
    button.disabled = false;
  }
}

// Messages from a host page (only honoured from the configured parent origin).
addEventListener("message", (event) => {
  const origin = brand.parentOrigin || params.get("parentOrigin");
  if (!origin || event.origin !== new URL(origin, location.origin).origin) return;
  const message = event.data;
  if (message?.type === "configurator:setFinish") setFinish(String(message.slot), String(message.finish));
  else if (message?.type === "configurator:setView") setView(String(message.view));
});

// ---- Boot -------------------------------------------------------------------
if (embedMode) document.documentElement.dataset.embed = "1";
buildPanel();
layoutCamera();
setView(state.view, { instant: true });
renderer.shadowMap.needsUpdate = true;
drawLive();
setLoading(1);
$("loader")?.classList.add("done");
setTimeout(() => $("loader")?.remove(), 700);

addEventListener("resize", () => { layoutCamera(); invalidate(); updatePhoneCode(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) lastFrame = performance.now(); });
renderer.domElement.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  // A context lost while path tracing usually means the GPU ran out of memory.
  // Reload once on the live renderer instead of leaving a dead canvas.
  if (photo && readFlag() !== "failed") { writeFlag("failed"); location.reload(); return; }
  fatal("The 3D view stopped", "The graphics context was lost. Reload the page to continue.");
});

if (params.has("debug")) window.__configurator = { THREE, scene, camera, renderer, controls, studio, state, get photo() { return photo; } };

requestAnimationFrame(frame);
postToParent({
  type: "configurator:ready",
  scene: SCENE.id,
  slots: SCENE.slots.map((slot) => ({ id: slot.id, label: slot.label, finishes: slot.finishes.map(({ id, name }) => ({ id, name })) })),
  views: SCENE.views.map(({ id, label }) => ({ id, label })),
});
track("ready", { tier: tier.key });
startPhotoRender();
