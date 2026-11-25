import * as THREE from "three";

// Material Lab: drop PBR maps (albedo / normal / roughness / metalness) onto
// any material slot and tune the full PBR parameter set live.
const MAP_DEFS = [
  { key: "map", label: "Albedo", color: true },
  { key: "normalMap", label: "Normal", color: false },
  { key: "roughnessMap", label: "Roughness", color: false },
  { key: "metalnessMap", label: "Metalness", color: false },
];

const PARAM_DEFS = [
  { key: "roughness", min: 0, max: 1, step: 0.01 },
  { key: "metalness", min: 0, max: 1, step: 0.01 },
  { key: "normalScale", min: 0, max: 3, step: 0.05, vector2: true },
  { key: "sheen", min: 0, max: 1, step: 0.05 },
  { key: "sheenRoughness", min: 0, max: 1, step: 0.05 },
  { key: "clearcoat", min: 0, max: 1, step: 0.05 },
  { key: "clearcoatRoughness", min: 0, max: 1, step: 0.05 },
  { key: "envMapIntensity", min: 0, max: 3, step: 0.05 },
  { key: "aoMapIntensity", min: 0, max: 2, step: 0.05 },
  { key: "lightMapIntensity", min: 0, max: 2, step: 0.05 },
];

// ---- Preset persistence -------------------------------------------------------
const STORE_KEY = "configurator-material-presets";

export function loadPresets() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { return []; }
}

function persistPresets(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) { console.warn("preset save failed:", e.message); }
}

function imageToDataURL(img, size, jpeg = true) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d").drawImage(img, 0, 0, size, size);
  return c.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.85);
}

export function captureMaterialPreset(materials, slot, name) {
  const mat = materials[slot];
  const preset = { id: `custom_${Date.now().toString(36)}`, name, custom: true, params: {}, maps: {} };
  for (const p of PARAM_DEFS) {
    const v = mat[p.key];
    if (v === undefined || v === null) continue;
    preset.params[p.key] = p.vector2 ? v.x : v;
  }
  preset.params.repeat = mat.map?.repeat.x ?? 2.2;
  preset.params.color = "#" + mat.color.getHexString();
  for (const def of MAP_DEFS) {
    const tex = mat[def.key];
    if (tex?.image?.width) preset.maps[def.key] = imageToDataURL(tex.image, 512);
  }
  // thumbnail: albedo if present, else flat colour chip
  if (preset.maps.map) preset.thumb = imageToDataURL(mat.map.image, 96);
  else {
    const c = document.createElement("canvas");
    c.width = c.height = 96;
    const ctx = c.getContext("2d");
    ctx.fillStyle = preset.params.color;
    ctx.fillRect(0, 0, 96, 96);
    preset.thumb = c.toDataURL("image/jpeg", 0.85);
  }
  return preset;
}

export function savePreset(preset) {
  const list = loadPresets();
  list.push(preset);
  persistPresets(list);
}

const presetTexCache = new Map();
export function applyPreset(materials, slot, preset, anisotropy = 8) {
  const mat = materials[slot];
  for (const def of MAP_DEFS) {
    const data = preset.maps[def.key];
    if (!data) { if (def.key !== "map") mat[def.key] = null; continue; }
    const cacheKey = preset.id + def.key;
    let tex = presetTexCache.get(cacheKey);
    if (!tex) {
      tex = new THREE.TextureLoader().load(data);
      tex.colorSpace = def.color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = anisotropy;
      presetTexCache.set(cacheKey, tex);
    }
    tex.repeat.set(preset.params.repeat, preset.params.repeat);
    mat[def.key] = tex;
  }
  for (const p of PARAM_DEFS) {
    const v = preset.params[p.key];
    if (v === undefined || mat[p.key] === undefined || mat[p.key] === null) continue;
    if (p.vector2) mat[p.key].set(v, v); else mat[p.key] = v;
  }
  if (preset.params.color) mat.color.set(preset.params.color);
  mat.needsUpdate = true;
}

export function initMaterialEditor({ materials, onChange, onSave }) {
  // Material Lab is a technical/advanced control → lives in the Studio panel.
  const body = document.querySelector("#studio .sbody")
    || document.getElementById("pane-materials")
    || document.querySelector("#panel .body");
  if (!body) throw new Error("Material Lab: no host container found");
  const section = document.createElement("div");
  section.className = "section";
  section.innerHTML = `<div class="label">Material Lab</div>`;
  const det = document.createElement("details");
  det.style.cssText = "background:rgba(255,255,255,0.04);border-radius:11px;padding:10px 12px";
  det.innerHTML = `<summary style="cursor:pointer;font-size:11.5px;color:rgba(242,239,233,0.7)">Open editor — full PBR control</summary>`;
  const box = document.createElement("div");
  box.style.cssText = "margin-top:10px;display:flex;flex-direction:column;gap:10px";
  det.appendChild(box);
  section.appendChild(det);
  body.appendChild(section);

  // slot selector
  let active = "a";
  const slotSeg = document.createElement("div");
  slotSeg.className = "seg";
  for (const slot of Object.keys(materials)) {
    const b = document.createElement("button");
    b.textContent = slot.toUpperCase();
    if (slot === active) b.classList.add("active");
    b.addEventListener("click", () => {
      active = slot;
      slotSeg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      syncSliders();
    });
    slotSeg.appendChild(b);
  }
  box.appendChild(slotSeg);

  // texture drop zones
  const dropRow = document.createElement("div");
  dropRow.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px";
  for (const def of MAP_DEFS) {
    const zone = document.createElement("label");
    zone.style.cssText =
      "display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 4px;border:1px dashed rgba(255,255,255,0.2);border-radius:9px;font-size:10.5px;color:rgba(242,239,233,0.55);cursor:pointer;text-align:center";
    zone.innerHTML = `<b style="font-size:11px;color:#f2efe9">${def.label}</b><span>drop / click</span>`;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    zone.appendChild(input);

    const loadFile = (file) => {
      if (!file) return;
      const url = URL.createObjectURL(file);
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = def.color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        const prevMap = materials[active].map;
        const rep = prevMap?.repeat || new THREE.Vector2(2.2, 2.2);
        tex.repeat.copy(rep);
        tex.anisotropy = 8;
        materials[active][def.key] = tex;
        materials[active].needsUpdate = true;
        zone.querySelector("span").textContent = file.name.slice(0, 16);
        zone.style.borderColor = "#c9a96a";
        onChange?.();
      });
    };
    input.addEventListener("change", () => loadFile(input.files[0]));
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.style.borderColor = "#c9a96a"; });
    zone.addEventListener("drop", (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });
    dropRow.appendChild(zone);
  }
  box.appendChild(dropRow);

  // UV repeat
  const sliderWrap = document.createElement("div");
  sliderWrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
  box.appendChild(sliderWrap);

  const sliders = [];
  function makeSlider(label, min, max, step, get, set) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:10.5px;color:rgba(242,239,233,0.55)";
    row.innerHTML = `<span style="min-width:104px">${label}</span>`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = min; input.max = max; input.step = step;
    input.style.cssText = "flex:1;accent-color:#c9a96a;height:14px";
    const val = document.createElement("span");
    val.style.cssText = "min-width:34px;text-align:right;font-family:monospace";
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      set(v);
      val.textContent = v.toFixed(2);
      materials[active].needsUpdate = true;
      onChange?.();
    });
    row.appendChild(input);
    row.appendChild(val);
    sliderWrap.appendChild(row);
    sliders.push({ input, val, get });
  }

  makeSlider("UV repeat", 0.5, 8, 0.1,
    () => materials[active].map?.repeat.x ?? 2.2,
    (v) => {
      for (const def of MAP_DEFS) materials[active][def.key]?.repeat.set(v, v);
    });

  for (const p of PARAM_DEFS) {
    if (materials.a[p.key] === undefined && materials.chrome[p.key] === undefined) continue;
    makeSlider(p.key, p.min, p.max, p.step,
      () => {
        const cur = materials[active][p.key];
        if (cur === undefined || cur === null) return 0;
        return p.vector2 ? cur.x : cur;
      },
      (v) => {
        const cur = materials[active][p.key];
        if (cur === undefined || cur === null) return;
        if (p.vector2) cur.set(v, v); else materials[active][p.key] = v;
      });
  }

  function syncSliders() {
    for (const s of sliders) {
      const v = s.get();
      s.input.value = v;
      s.val.textContent = Number(v).toFixed(2);
    }
  }
  syncSliders();

  // ---- Save as material ----
  const saveRow = document.createElement("div");
  saveRow.style.cssText = "display:flex;gap:6px;margin-top:4px";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Material name…";
  nameInput.style.cssText =
    "flex:1;font:inherit;font-size:11.5px;color:#f2efe9;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:7px 10px;outline:none";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "＋ Save material";
  saveBtn.style.cssText =
    "font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;border-radius:8px;padding:7px 12px;border:0;background:#c9a96a;color:#181613";
  saveBtn.addEventListener("click", () => {
    const name = nameInput.value.trim() || `Custom ${loadPresets().length + 1}`;
    const preset = captureMaterialPreset(materials, active, name);
    savePreset(preset);
    nameInput.value = "";
    onSave?.(preset);
  });
  saveRow.appendChild(nameInput);
  saveRow.appendChild(saveBtn);
  box.appendChild(saveRow);

  return { open: () => { det.open = true; det.scrollIntoView({ behavior: "smooth", block: "nearest" }); } };
}
