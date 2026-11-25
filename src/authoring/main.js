/*
THESIS: A local product studio should make the model hierarchy visible and editable before it makes anything clever.
OWN-WORLD: Restrained vercel-black tooling, warm-white type, hairline separators, and one amber state accent for authored changes.
STORY: The operator opens a local project, imports a model or texture, selects a real entity, edits its role and transform, then saves a portable scene manifest.
FIRST VIEWPORT: A large PlayCanvas viewport sits between an asset/hierarchy rail and an inspector rail; the first action is Load Suflo, not a welcome carousel.
FORM: Operate-mode three-column editor shell, committed as a focused local authoring workspace rather than a public configurator page.
*/

import * as pc from "playcanvas";
import "./style.css";

const MODEL_URL = "/assets/69_suflo_desk/model.glb";
const PROJECT_STORAGE_KEY = "configurator-product-studio-project";

const state = {
  app: null,
  projectRoot: null,
  camera: null,
  selected: null,
  selectedAsset: null,
  projectName: "Untitled Product Project",
  assets: new Map(),
  assetCounter: 0,
  orbit: { theta: 0.72, phi: 1.08, distance: 3.2, target: new pc.Vec3(0, 0.55, 0) },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stripExtension(name) {
  return name.replace(/\.(glb|gltf|fbx|png|jpe?g|webp|ktx2)$/i, "");
}

function cleanAssetId(name) {
  return `${stripExtension(name).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "asset"}-${++state.assetCounter}`;
}

function setStatus(message, kind = "normal") {
  const status = $("#studio-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function setToast(message, kind = "normal") {
  const toast = $("#studio-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("visible");
  clearTimeout(setToast.timer);
  setToast.timer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function meta(entity) {
  if (!entity.__authoring) entity.__authoring = { role: "mesh", assetId: null };
  return entity.__authoring;
}

function inferRole(name, root = false) {
  if (root) return "product";
  const value = name.toLowerCase().replace(/\.\d+$/, "");
  if (/^[a-d]$/.test(value)) return "configurable";
  if (/internal|inside|drawer/.test(value)) return "internal";
  if (/chrome|black|grey|gray|white|glass|mirror|led|light|basin|body|neck|frame|leg|cable|port/.test(value)) return "fixed";
  return "mesh";
}

function childEntities(entity) {
  return Array.isArray(entity.children) ? entity.children : [];
}

function walkEntity(entity, callback) {
  callback(entity);
  for (const child of childEntities(entity)) walkEntity(child, callback);
}

function findEntityByName(root, name) {
  let found = null;
  walkEntity(root, (entity) => {
    if (!found && entity.name === name) found = entity;
  });
  return found;
}

function createStudioShell() {
  $("#authoring-app").innerHTML = `
    <div class="studio-shell">
      <header class="studio-topbar">
        <div class="studio-brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <div class="brand-name">Local Product Studio</div>
            <div class="brand-sub">Configurator product studio</div>
          </div>
        </div>
        <div class="engine-state"><span class="engine-dot"></span><span>PlayCanvas Engine</span><b>2.21.4</b></div>
        <div class="topbar-actions">
          <label class="project-name-wrap" title="Project name">
            <span>PROJECT</span>
            <input id="project-name" value="Untitled Product Project" aria-label="Project name" />
          </label>
          <button class="button button-quiet" id="new-project">New</button>
          <button class="button button-quiet" id="open-project">Open</button>
          <button class="button button-primary" id="save-project">Save project</button>
        </div>
      </header>

      <main class="studio-workspace">
        <aside class="left-rail" aria-label="Project assets and hierarchy">
          <section class="rail-section assets-section">
            <div class="section-heading"><div><span class="section-kicker">Library</span><h2>Assets</h2></div><span class="count-badge" id="asset-count">0</span></div>
            <div class="asset-actions">
              <button class="button button-small" id="import-model">Import model</button>
              <button class="button button-small" id="import-texture">Texture</button>
            </div>
            <div class="asset-list" id="asset-list"></div>
            <div class="asset-hint">GLB is the live import format. FBX remains a source format and should be converted through the Blender export pipeline.</div>
          </section>
          <section class="rail-section hierarchy-section">
            <div class="section-heading"><div><span class="section-kicker">Scene graph</span><h2>Hierarchy</h2></div><button class="icon-button" id="add-entity" title="Add empty entity" aria-label="Add empty entity">+</button></div>
            <div class="hierarchy-list" id="hierarchy-list"></div>
          </section>
        </aside>

        <section class="viewport-column">
          <div class="viewport-toolbar">
            <div class="viewport-title"><span class="live-pip"></span><span id="viewport-label">Empty local scene</span></div>
            <div class="viewport-actions">
              <button class="button button-small" id="load-suflo">Load Suflo</button>
              <button class="button button-small" id="fit-selection">Frame selection</button>
              <button class="button button-small" id="reset-view">Reset view</button>
            </div>
          </div>
          <div class="viewport-wrap">
            <canvas id="playcanvas-viewport" aria-label="PlayCanvas local authoring viewport"></canvas>
            <div class="viewport-empty" id="viewport-empty">
              <div class="empty-symbol">＋</div>
              <h1>Start a local product scene</h1>
              <p>Load the Suflo case study or import a GLB to create a real PlayCanvas entity hierarchy.</p>
              <button class="button button-primary" id="empty-load-suflo">Load Suflo case study</button>
            </div>
            <div class="viewport-help"><span>Orbit</span> drag <i>·</i><span>Zoom</span> wheel <i>·</i><span>Select</span> hierarchy</div>
          </div>
          <div class="viewport-footer"><span id="scene-summary">No product entities yet</span><span id="studio-status" data-kind="normal">Engine online · local-only</span></div>
        </section>

        <aside class="inspector-rail" aria-label="Entity inspector">
          <div class="inspector-heading"><div><span class="section-kicker">Properties</span><h2>Inspector</h2></div><span class="inspector-type" id="inspector-type">—</span></div>
          <div class="inspector-content" id="inspector-content"></div>
        </aside>
      </main>
      <div class="toast" id="studio-toast" role="status" aria-live="polite"></div>
      <input id="model-file" type="file" accept=".glb,.gltf,.fbx" hidden />
      <input id="texture-file" type="file" accept="image/png,image/jpeg,image/webp,.ktx2" hidden />
      <input id="project-file" type="file" accept="application/json,.json" hidden />
    </div>
  `;
}

function setupEngine() {
  const canvas = $("#playcanvas-viewport");
  state.app = new pc.Application(canvas, {
    graphicsDeviceOptions: {
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    },
  });
  state.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  state.app.setCanvasResolution(pc.RESOLUTION_AUTO);
  state.app.start();

  state.app.scene.ambientLightColor = new pc.Color(0.16, 0.16, 0.17);

  const camera = new pc.Entity("Studio Camera");
  camera.addComponent("camera", { clearColor: new pc.Color(0.035, 0.035, 0.04), fov: 42, farClip: 100 });
  state.camera = camera;
  state.app.root.addChild(camera);

  const key = new pc.Entity("Studio Key");
  key.addComponent("light", { type: "directional", color: new pc.Color(1, 0.94, 0.84), intensity: 2.1, castShadows: true, shadowDistance: 10 });
  key.setLocalEulerAngles(38, 35, 0);
  state.app.root.addChild(key);

  const fill = new pc.Entity("Studio Fill");
  fill.addComponent("light", { type: "directional", color: new pc.Color(0.65, 0.72, 0.84), intensity: 0.7 });
  fill.setLocalEulerAngles(65, -125, 0);
  state.app.root.addChild(fill);

  const floorMaterial = new pc.StandardMaterial();
  floorMaterial.diffuse = new pc.Color(0.055, 0.055, 0.06);
  floorMaterial.roughness = 0.88;
  floorMaterial.update();
  const floor = new pc.Entity("Studio Floor");
  floor.addComponent("render", { type: "plane", material: floorMaterial, castShadows: false, receiveShadows: true });
  floor.setLocalScale(12, 12, 12);
  floor.setLocalEulerAngles(-90, 0, 0);
  state.app.root.addChild(floor);

  state.projectRoot = new pc.Entity("Local Product Project");
  state.app.root.addChild(state.projectRoot);
  updateCamera();
  bindViewportControls(canvas);
}

function updateCamera() {
  const { theta, phi, distance, target } = state.orbit;
  const x = target.x + Math.sin(phi) * Math.sin(theta) * distance;
  const y = target.y + Math.cos(phi) * distance;
  const z = target.z + Math.sin(phi) * Math.cos(theta) * distance;
  state.camera.setPosition(x, y, z);
  state.camera.lookAt(target);
}

function resetView() {
  state.orbit.theta = 0.72;
  state.orbit.phi = 1.08;
  state.orbit.distance = 3.2;
  state.orbit.target.set(0, 0.55, 0);
  updateCamera();
}

function bindViewportControls(canvas) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    state.orbit.theta -= dx * 0.008;
    state.orbit.phi = Math.max(0.32, Math.min(1.48, state.orbit.phi + dy * 0.008));
    updateCamera();
  });
  canvas.addEventListener("pointerup", (event) => {
    dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointercancel", () => { dragging = false; });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    state.orbit.distance = Math.max(0.35, Math.min(30, state.orbit.distance * (event.deltaY > 0 ? 1.08 : 0.92)));
    updateCamera();
  }, { passive: false });
}

function createAssetRecord({ name, type, url, sourceKind, sourceName, sourcePath }) {
  const id = cleanAssetId(name);
  const record = { id, name, type, url, sourceKind, sourceName: sourceName || name, sourcePath: sourcePath || null, asset: null, entity: null };
  state.assets.set(id, record);
  return record;
}

function setNodeRoles(root) {
  walkEntity(root, (entity) => {
    const data = meta(entity);
    if (!data.role || data.role === "mesh") data.role = inferRole(entity.name, entity === root);
  });
}

function addModelEntity(record, serialized = null) {
  const instance = record.asset.resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true });
  const product = new pc.Entity(serialized?.name || stripExtension(record.name));
  product.__authoring = { role: serialized?.authoring?.role || "product", assetId: record.id };
  product.addChild(instance);
  state.projectRoot.addChild(product);
  record.entity = product;
  setNodeRoles(instance);
  if (serialized) applyEntityRecord(product, serialized);
  else fitSelection(product);
  hideEmptyState();
  renderAll();
  setStatus(`${record.name} loaded · hierarchy ready`, "success");
  return product;
}

function loadModelRecord(record, serialized = null) {
  const asset = new pc.Asset(record.name, "container", { url: record.url });
  record.asset = asset;
  state.app.assets.add(asset);
  asset.on("load", () => addModelEntity(record, serialized));
  asset.on("error", (error) => {
    setStatus(`Could not load ${record.name}: ${error?.message || "asset error"}`, "error");
    setToast(`Model load failed: ${record.name}`, "error");
  });
  asset.load();
  setStatus(`Loading ${record.name}…`, "loading");
}

function importModelFile(file) {
  if (!file) return;
  if (/\.fbx$/i.test(file.name)) {
    setStatus("FBX selected · convert it to GLB with the Blender pipeline first", "warning");
    setToast("FBX is a source format here; use the GLB export pipeline", "warning");
    return;
  }
  const url = URL.createObjectURL(file);
  const record = createAssetRecord({ name: file.name, type: "container", url, sourceKind: "local-file", sourceName: file.name });
  loadModelRecord(record);
  renderAll();
}

function importTextureFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const record = createAssetRecord({ name: file.name, type: "texture", url, sourceKind: "local-file", sourceName: file.name });
  const asset = new pc.Asset(record.name, "texture", { url });
  record.asset = asset;
  state.app.assets.add(asset);
  asset.on("load", () => {
    setStatus(`${file.name} imported · ready to assign`, "success");
    setToast("Texture imported", "success");
    renderAll();
  });
  asset.on("error", () => {
    setStatus(`Could not load texture ${file.name}`, "error");
    setToast("Texture load failed", "error");
  });
  asset.load();
  renderAll();
}

function loadSuflo() {
  const existing = [...state.assets.values()].find((asset) => asset.sourcePath === MODEL_URL);
  if (existing?.entity) {
    selectEntity(existing.entity);
    fitSelection(existing.entity);
    return;
  }
  const record = createAssetRecord({ name: "Suflo Reception Desk.glb", type: "container", url: MODEL_URL, sourceKind: "project-asset", sourcePath: MODEL_URL });
  loadModelRecord(record);
  renderAll();
}

function createEmptyEntity() {
  const entity = new pc.Entity("Entity");
  entity.__authoring = { role: "group", assetId: null };
  (state.selected && state.selected !== state.projectRoot ? state.selected : state.projectRoot).addChild(entity);
  selectEntity(entity);
  setStatus("Empty entity added", "success");
}

function removeSelected() {
  if (!state.selected || state.selected === state.projectRoot) return;
  const name = state.selected.name;
  state.selected.destroy();
  state.selected = null;
  renderAll();
  setStatus(`${name} removed from the local scene`, "success");
}

function duplicateSelected() {
  if (!state.selected || state.selected === state.projectRoot || typeof state.selected.clone !== "function") return;
  const copy = state.selected.clone();
  copy.name = `${state.selected.name} Copy`;
  meta(copy).assetId = meta(state.selected).assetId;
  state.selected.parent.addChild(copy);
  selectEntity(copy);
  setStatus(`${copy.name} duplicated`, "success");
}

function selectEntity(entity) {
  state.selected = entity;
  state.selectedAsset = null;
  renderAll();
}

function selectAsset(record) {
  state.selectedAsset = record;
  renderAssets();
}

function fitSelection(entity = state.selected) {
  if (!entity) return;
  let min = new pc.Vec3(Infinity, Infinity, Infinity);
  let max = new pc.Vec3(-Infinity, -Infinity, -Infinity);
  let found = false;
  walkEntity(entity, (node) => {
    for (const meshInstance of node.render?.meshInstances || []) {
      const box = meshInstance.aabb;
      const minX = box.center.x - box.halfExtents.x;
      const minY = box.center.y - box.halfExtents.y;
      const minZ = box.center.z - box.halfExtents.z;
      const maxX = box.center.x + box.halfExtents.x;
      const maxY = box.center.y + box.halfExtents.y;
      const maxZ = box.center.z + box.halfExtents.z;
      min.x = Math.min(min.x, minX); min.y = Math.min(min.y, minY); min.z = Math.min(min.z, minZ);
      max.x = Math.max(max.x, maxX); max.y = Math.max(max.y, maxY); max.z = Math.max(max.z, maxZ);
      found = true;
    }
  });
  if (!found) return;
  state.orbit.target.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
  const radius = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) * 0.5;
  state.orbit.distance = Math.max(0.6, radius / Math.tan((42 * Math.PI / 180) / 2) * 1.25);
  updateCamera();
}

function applyTextureToSelection() {
  const record = state.selectedAsset;
  if (!record || record.type !== "texture" || !record.asset?.resource || !state.selected) {
    setToast("Select a loaded texture and an entity first", "warning");
    return;
  }
  let applied = 0;
  walkEntity(state.selected, (entity) => {
    for (const meshInstance of entity.render?.meshInstances || []) {
      const material = meshInstance.material;
      if (!material) continue;
      material.diffuseMap = record.asset.resource;
      material.diffuseMapTiling = new pc.Vec2(2.2, 2.2);
      material.update();
      applied += 1;
    }
  });
  if (!applied) {
    setToast("The selected entity has no renderable meshes", "warning");
    return;
  }
  setStatus(`${record.name} assigned to ${applied} mesh material${applied === 1 ? "" : "s"}`, "success");
  setToast("Texture assigned", "success");
}

function vecArray(value) {
  return [Number(value.x.toFixed(5)), Number(value.y.toFixed(5)), Number(value.z.toFixed(5))];
}

function serializeEntity(entity) {
  return {
    name: entity.name,
    enabled: entity.enabled,
    position: vecArray(entity.getLocalPosition()),
    rotation: vecArray(entity.getLocalEulerAngles()),
    scale: vecArray(entity.getLocalScale()),
    authoring: { ...meta(entity) },
    children: childEntities(entity).map(serializeEntity),
  };
}

function applyEntityRecord(entity, record) {
  entity.name = record.name || entity.name;
  entity.enabled = record.enabled !== false;
  if (record.position) entity.setLocalPosition(...record.position);
  if (record.rotation) entity.setLocalEulerAngles(...record.rotation);
  if (record.scale) entity.setLocalScale(...record.scale);
  if (record.authoring) entity.__authoring = { ...meta(entity), ...record.authoring };
  for (const childRecord of record.children || []) {
    const existing = childEntities(entity).find((child) => child.name === childRecord.name);
    if (existing) applyEntityRecord(existing, childRecord);
  }
}

function projectData() {
  return {
    format: "configurator-product-scene",
    version: 1,
    engine: "playcanvas@2.21.4",
    projectName: state.projectName,
    savedAt: new Date().toISOString(),
    assets: [...state.assets.values()].map((record) => ({
      id: record.id,
      name: record.name,
      type: record.type,
      sourceKind: record.sourceKind,
      sourceName: record.sourceName,
      sourcePath: record.sourcePath,
    })),
    entities: childEntities(state.projectRoot).map(serializeEntity),
  };
}

function saveProject(download = true) {
  const data = projectData();
  localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(data));
  if (download) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${stripExtension(state.projectName).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "product-scene"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  setStatus("Project saved locally · scene manifest downloaded", "success");
  setToast("Project saved", "success");
}

function clearProject() {
  for (const child of [...childEntities(state.projectRoot)]) child.destroy();
  state.selected = null;
  state.selectedAsset = null;
  state.assets.clear();
  state.projectName = "Untitled Product Project";
  $("#project-name").value = state.projectName;
  showEmptyState();
  renderAll();
}

async function openProjectFile(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    setStatus("Project file is not valid JSON", "error");
    setToast("Could not open project", "error");
    return;
  }
  if (data.format !== "configurator-product-scene") {
    setStatus("This is not a Local Product Studio project file", "error");
    setToast("Unsupported project format", "error");
    return;
  }
  clearProject();
  state.projectName = data.projectName || file.name.replace(/\.json$/i, "");
  $("#project-name").value = state.projectName;
  const pending = [];
  for (const definition of data.assets || []) {
    if (definition.sourcePath?.startsWith("/assets/")) {
      const record = { ...definition, url: definition.sourcePath, asset: null, entity: null };
      state.assets.set(record.id, record);
      pending.push(new Promise((resolve) => {
        const asset = new pc.Asset(record.name, "container", { url: record.url });
        record.asset = asset;
        state.app.assets.add(asset);
        asset.once("load", () => {
          const rootRecord = (data.entities || []).find((entity) => entity.authoring?.assetId === record.id);
          if (rootRecord) addModelEntity(record, rootRecord);
          resolve();
        });
        asset.once("error", () => resolve());
        asset.load();
      }));
    } else {
      state.assets.set(definition.id, { ...definition, asset: null, entity: null, url: null });
    }
  }
  for (const entityRecord of data.entities || []) {
    if (entityRecord.authoring?.assetId && state.assets.has(entityRecord.authoring.assetId)) continue;
    const entity = new pc.Entity(entityRecord.name || "Entity");
    state.projectRoot.addChild(entity);
    applyEntityRecord(entity, entityRecord);
  }
  await Promise.all(pending);
  localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(data));
  renderAll();
  hideEmptyState();
  setStatus(`Opened ${file.name} · local project`, "success");
}

function renderAssets() {
  const list = $("#asset-list");
  const records = [...state.assets.values()];
  $("#asset-count").textContent = records.length;
  list.innerHTML = "";
  if (!records.length) {
    list.append(el("div", "asset-empty", "No assets yet. Import a GLB or load Suflo."));
    return;
  }
  for (const record of records) {
    const row = el("button", `asset-row${state.selectedAsset === record ? " selected" : ""}`);
    row.type = "button";
    const icon = el("span", `asset-icon ${record.type === "texture" ? "texture-icon" : "model-icon"}`, record.type === "texture" ? "T" : "3D");
    const body = el("span", "asset-body");
    body.append(el("strong", null, record.name));
    body.append(el("small", null, record.type === "texture" ? "Texture" : record.sourceKind === "project-asset" ? "Project GLB" : "Local GLB"));
    row.append(icon, body);
    row.addEventListener("click", () => selectAsset(record));
    list.append(row);
  }
}

function renderTreeNode(entity, depth = 0) {
  const wrap = el("div", "tree-node");
  const row = el("button", `tree-row${state.selected === entity ? " selected" : ""}`);
  row.type = "button";
  row.style.setProperty("--depth", depth);
  const chevron = el("span", childEntities(entity).length ? "tree-chevron" : "tree-chevron empty", childEntities(entity).length ? "⌄" : "·");
  const dot = el("span", `tree-dot role-${meta(entity).role}`);
  const label = el("span", "tree-label", entity.name);
  const role = el("span", "tree-role", meta(entity).role);
  row.append(chevron, dot, label, role);
  row.addEventListener("click", () => selectEntity(entity));
  wrap.append(row);
  for (const child of childEntities(entity)) wrap.append(renderTreeNode(child, depth + 1));
  return wrap;
}

function renderHierarchy() {
  const list = $("#hierarchy-list");
  list.innerHTML = "";
  const children = childEntities(state.projectRoot);
  if (!children.length) {
    list.append(el("div", "hierarchy-empty", "Your product entities will appear here."));
    return;
  }
  for (const child of children) list.append(renderTreeNode(child));
}

function numberInput(label, value, type, index) {
  return `<label class="number-field"><span>${label}</span><input type="number" step="0.01" value="${Number(value).toFixed(3)}" data-transform="${type}" data-index="${index}" /></label>`;
}

function renderInspector() {
  const content = $("#inspector-content");
  const type = $("#inspector-type");
  content.innerHTML = "";
  if (!state.selected) {
    type.textContent = "—";
    content.append(el("div", "inspector-empty", "Select an entity in the hierarchy to inspect its role, transform, visibility, and material target."));
    return;
  }
  const entity = state.selected;
  const data = meta(entity);
  type.textContent = data.role;
  const identity = el("section", "inspector-section");
  identity.innerHTML = `<div class="field-label">IDENTITY</div><label class="text-field"><span>Name</span><input id="entity-name" value="${entity.name.replace(/"/g, "&quot;")}" /></label><label class="select-field"><span>Role</span><select id="entity-role"><option value="product">Product</option><option value="group">Group</option><option value="configurable">Configurable slot</option><option value="fixed">Fixed component</option><option value="internal">Internal component</option><option value="mesh">Mesh</option></select></label><label class="check-field"><input id="entity-enabled" type="checkbox" ${entity.enabled ? "checked" : ""} /><span>Visible in scene</span></label>`;
  $("#entity-role", identity).value = data.role;
  identity.append(el("div", "field-note", data.assetId ? `Asset: ${state.assets.get(data.assetId)?.name || data.assetId}` : "Local entity · no external asset reference"));
  content.append(identity);

  const transform = el("section", "inspector-section");
  const position = entity.getLocalPosition();
  const rotation = entity.getLocalEulerAngles();
  const scale = entity.getLocalScale();
  transform.innerHTML = `<div class="field-label">TRANSFORM</div><div class="vector-group"><div class="vector-title">Position</div><div class="number-grid">${numberInput("X", position.x, "position", 0)}${numberInput("Y", position.y, "position", 1)}${numberInput("Z", position.z, "position", 2)}</div></div><div class="vector-group"><div class="vector-title">Rotation</div><div class="number-grid">${numberInput("X", rotation.x, "rotation", 0)}${numberInput("Y", rotation.y, "rotation", 1)}${numberInput("Z", rotation.z, "rotation", 2)}</div></div><div class="vector-group"><div class="vector-title">Scale</div><div class="number-grid">${numberInput("X", scale.x, "scale", 0)}${numberInput("Y", scale.y, "scale", 1)}${numberInput("Z", scale.z, "scale", 2)}</div></div>`;
  content.append(transform);

  const actions = el("section", "inspector-section inspector-actions");
  actions.innerHTML = `<div class="field-label">ACTIONS</div><div class="action-grid"><button class="button button-small" id="inspector-frame">Frame entity</button><button class="button button-small" id="inspector-duplicate">Duplicate</button><button class="button button-small danger-button" id="inspector-delete">Delete</button></div>`;
  content.append(actions);

  $("#entity-name", identity).addEventListener("change", (event) => { entity.name = event.target.value.trim() || "Entity"; renderAll(); });
  $("#entity-role", identity).addEventListener("change", (event) => { data.role = event.target.value; renderAll(); setStatus(`${entity.name} role set to ${data.role}`, "success"); });
  $("#entity-enabled", identity).addEventListener("change", (event) => { entity.enabled = event.target.checked; renderAll(); });
  $$('input[data-transform]', transform).forEach((input) => input.addEventListener("change", (event) => {
    const kind = event.target.dataset.transform;
    const index = Number(event.target.dataset.index);
    const value = Number(event.target.value) || 0;
    const vector = kind === "position" ? entity.getLocalPosition() : kind === "rotation" ? entity.getLocalEulerAngles() : entity.getLocalScale();
    if (index === 0) vector.x = value;
    if (index === 1) vector.y = value;
    if (index === 2) vector.z = value;
    if (kind === "position") entity.setLocalPosition(vector);
    if (kind === "rotation") entity.setLocalEulerAngles(vector);
    if (kind === "scale") entity.setLocalScale(vector);
    renderAll();
  }));
  $("#inspector-frame", actions).addEventListener("click", () => fitSelection(entity));
  $("#inspector-duplicate", actions).addEventListener("click", duplicateSelected);
  $("#inspector-delete", actions).addEventListener("click", removeSelected);
}

function renderSummary() {
  const products = childEntities(state.projectRoot).filter((entity) => meta(entity).role === "product").length;
  const nodes = childEntities(state.projectRoot).reduce((count, entity) => {
    let total = 0;
    walkEntity(entity, () => { total += 1; });
    return count + total;
  }, 0);
  $("#scene-summary").textContent = products ? `${products} product${products === 1 ? "" : "s"} · ${nodes} scene entit${nodes === 1 ? "y" : "ies"}` : "No product entities yet";
  const first = childEntities(state.projectRoot)[0];
  $("#viewport-label").textContent = first ? first.name : "Empty local scene";
}

function renderAll() {
  renderAssets();
  renderHierarchy();
  renderInspector();
  renderSummary();
}

function showEmptyState() { $("#viewport-empty").classList.remove("hidden"); }
function hideEmptyState() { $("#viewport-empty").classList.add("hidden"); }

function wireActions() {
  $("#project-name").addEventListener("change", (event) => { state.projectName = event.target.value.trim() || "Untitled Product Project"; event.target.value = state.projectName; });
  $("#new-project").addEventListener("click", () => { clearProject(); setStatus("New local project ready", "success"); });
  $("#save-project").addEventListener("click", () => saveProject(true));
  $("#open-project").addEventListener("click", () => $("#project-file").click());
  $("#project-file").addEventListener("change", (event) => openProjectFile(event.target.files[0]));
  $("#import-model").addEventListener("click", () => $("#model-file").click());
  $("#model-file").addEventListener("change", (event) => importModelFile(event.target.files[0]));
  $("#import-texture").addEventListener("click", () => $("#texture-file").click());
  $("#texture-file").addEventListener("change", (event) => importTextureFile(event.target.files[0]));
  $("#load-suflo").addEventListener("click", loadSuflo);
  $("#empty-load-suflo").addEventListener("click", loadSuflo);
  $("#fit-selection").addEventListener("click", () => fitSelection());
  $("#reset-view").addEventListener("click", resetView);
  $("#add-entity").addEventListener("click", createEmptyEntity);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveProject(true); }
    if (event.key === "Delete" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) removeSelected();
  });
}

createStudioShell();
setupEngine();
wireActions();
renderAll();

// Public hook for the texture action and future editor panels.
window.localProductStudio = {
  state,
  loadSuflo,
  saveProject,
  applyTextureToSelection,
  projectData,
};
