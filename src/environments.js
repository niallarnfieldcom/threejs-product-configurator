import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { GroundedSkybox } from "three/addons/objects/GroundedSkybox.js";

// Environments:
//  - studio: dark premium stage (baked unlit gradients, car-configurator style)
//  - HDRI scenes: GroundedSkybox domes — the product stands on the photographed
//    floor and, critically, scene.environment swaps to THAT scene's PMREM, so
//    metals/fabrics are lit and reflected by the world they're standing in.
// box = room dimensions for parallax-correct cuboid projection (metres);
// camHeight = capture tripod height above the floor
const HDRI_SCENES = {
  // High-res 4K interiors (Poly Haven, CC0). The path tracer lights the product
  // from these; the box dims set the room scale for the raster backdrop.
  hdri: { file: "assets/brown_photostudio_02_4k.hdr", box: { w: 8, d: 10, h: 4, camHeight: 1.5 } },
  loft: { file: "assets/anniversary_lounge_4k.hdr", box: { w: 7, d: 9, h: 3.2, camHeight: 1.4 } },
  // Default studio lighting reuses the CC0 photo-studio HDRI.
  studioHdr: { file: "assets/brown_photostudio_02_4k.hdr", box: { w: 7, d: 7, h: 3.4, camHeight: 1.4 } },
};

// Floor tint per visible environment — the path-tracer ground plane is set to
// this so it blends with the HDRI's own floor (keeps the product grounded).
const FLOOR_COLORS = { studio: 0x16161a, hdri: 0x4f4c46, loft: 0x40362c };

// Equirect HDRI projected onto a room-shaped cuboid: sphere UVs stay valid
// because vertices move ALONG their view ray (direction unchanged) until they
// hit the box — same principle GroundedSkybox uses for its floor, generalised
// to four walls + ceiling. Result: parallax-correct walls and corners.
function makeBoxProjectedRoom(hdrTex, { w, d, h, camHeight }) {
  const geo = new THREE.SphereGeometry(1, 96, 48);
  const pos = geo.attributes.position;
  const dir = new THREE.Vector3();
  // box faces relative to the capture point (origin of the projection)
  const xMin = -w / 2, xMax = w / 2, zMin = -d / 2, zMax = d / 2;
  const yMin = -camHeight, yMax = h - camHeight;
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    // slab method: nearest positive intersection with the room cuboid
    let t = Infinity;
    if (dir.x > 1e-6) t = Math.min(t, xMax / dir.x);
    if (dir.x < -1e-6) t = Math.min(t, xMin / dir.x);
    if (dir.y > 1e-6) t = Math.min(t, yMax / dir.y);
    if (dir.y < -1e-6) t = Math.min(t, yMin / dir.y);
    if (dir.z > 1e-6) t = Math.min(t, zMax / dir.z);
    if (dir.z < -1e-6) t = Math.min(t, zMin / dir.z);
    if (!isFinite(t)) t = 1;
    pos.setXYZ(i, dir.x * t, dir.y * t, dir.z * t);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: hdrTex, side: THREE.BackSide }));
  mesh.position.y = camHeight - 0.01; // capture point above floor → floor lands at y≈0
  return mesh;
}

function makeStageFloorTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#101013";
  ctx.fillRect(0, 0, 1024, 1024);
  let g = ctx.createRadialGradient(512, 512, 0, 512, 512, 520);
  g.addColorStop(0, "#5a5a64");
  g.addColorStop(0.45, "#2e2e36");
  g.addColorStop(1, "#101013");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  g = ctx.createRadialGradient(720, 340, 0, 720, 340, 330);
  g.addColorStop(0, "rgba(90,88,98,0.35)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  // dissolve the rim to transparent — floor reads as infinite space
  g = ctx.createRadialGradient(512, 512, 300, 512, 512, 512);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.75, "rgba(0,0,0,0.55)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 1024);
  ctx.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStageBackdropTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 512;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 512, 0, 0);
  g.addColorStop(0, "#16161a");
  g.addColorStop(0.25, "#3a3a44");
  g.addColorStop(0.55, "#1e1e24");
  g.addColorStop(1, "#0c0c0f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function blobShadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(0,0,0,0.4)");
  g.addColorStop(0.7, "rgba(0,0,0,0.12)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export function createEnvironments(scene, renderer, inline = null) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // ---------- STUDIO (dark stage) ----------
  const studio = new THREE.Group();
  studio.name = "env-studio";

  const studioFloor = new THREE.Mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.MeshBasicMaterial({ map: makeStageFloorTexture(), transparent: true, opacity: 0.8, depthWrite: false })
  );
  studioFloor.rotation.x = -Math.PI / 2;
  studioFloor.position.y = 0.0016;
  studio.add(studioFloor);

  const catcher = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.ShadowMaterial({ opacity: 0.42 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = 0.002;
  catcher.receiveShadow = true;
  studio.add(catcher);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(16, 48, 24),
    new THREE.MeshBasicMaterial({ map: makeStageBackdropTexture(), side: THREE.BackSide })
  );
  dome.position.y = 2;
  studio.add(dome);

  // Key light aligned to the PT ptKey so the raster→PT bridge doesn't pop:
  // WHITE (was warm) and nearly OVERHEAD, slightly front-right (was a side key
  // from 40°). Same direction + colour as the path tracer's RectAreaLight.
  const studioKey = new THREE.DirectionalLight(0xffffff, 1.7);
  studioKey.position.set(0.3, 2.75, 0.8); // ≈ ptKey (cx+0.3, top+1.6, cz+0.8) aimed at origin
  studioKey.castShadow = false;
  studio.add(studioKey);
  // Rim dropped to match PT (which has no rim). Kept at intensity 0 so it's a
  // one-line restore if the chair needs back-edge separation later.
  const studioRim = new THREE.DirectionalLight(0xcfdcff, 0.0);
  studioRim.position.set(-4, 2.4, -3);
  studio.add(studioRim);

  // contact blob (silhouette RT replaces the map at runtime)
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.004;
  blob.scale.setScalar(1.7);
  blob.renderOrder = 1;

  scene.add(studio, blob);

  // ---------- HDRI scenes (lazy) ----------
  const loaded = {}; // key -> { envTex, dome }
  const loader = new HDRLoader();
  let studioEnvTex = null;

  function loadHdriScene(key) {
    if (loaded[key]) return Promise.resolve(loaded[key]);
    const def = HDRI_SCENES[key];
    const url = inline && def.inlineKey && inline[def.inlineKey]
      ? `data:application/octet-stream;base64,${inline[def.inlineKey]}`
      : def.file;
    return new Promise((resolve, reject) => {
      loader.load(url, (hdr) => {
        const envTex = pmrem.fromEquirectangular(hdr).texture;
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const room = def.box
          ? makeBoxProjectedRoom(hdr, def.box)
          : (() => { const s = new GroundedSkybox(hdr, def.height, def.radius); s.position.y = def.height - 0.01; return s; })();
        room.visible = false;
        scene.add(room);
        loaded[key] = { envTex, dome: room, raw: hdr }; // raw equirect kept for mirror-sharp chrome
        resolve(loaded[key]);
      }, undefined, reject);
    });
  }

  // boot: the original light-strip studio HDR drives the dark stage's IBL
  const hdrReady = loadHdriScene("studioHdr")
    .then((s) => { studioEnvTex = s.envTex; scene.environment = studioEnvTex; return true; })
    .catch(() => false);

  // setEnv returns a promise — callers refresh probes/render when it resolves
  let activeKey = "hdri";
  const getActive = () => loaded[activeKey === "studio" ? "studioHdr" : activeKey] || null;
  const getFloorColor = () => FLOOR_COLORS[activeKey] ?? 0x3a3a3e;
  const setEnv = async (name) => {
    activeKey = name;
    if (HDRI_SCENES[name]) await loadHdriScene(name).catch(() => null);
    studio.visible = name === "studio";
    for (const s of Object.values(loaded)) s.dome.visible = false; // HDRI is IBL-only — never show the dome
    if (name === "studio") {
      scene.background = new THREE.Color(0x0c0c0f);
      scene.environment = studioEnvTex || scene.environment;
      scene.environmentIntensity = 1.15;
    } else {
      scene.background = new THREE.Color(0xf2f2f2); // flat white raster backdrop (matches PT), HDRI not shown
      scene.environment = loaded[name]?.envTex || scene.environment;
      scene.environmentIntensity = 1.0;
    }
  };
  setEnv("studio");
  const getActiveKey = () => activeKey;
  return { setEnv, getActive, getActiveKey, getFloorColor, hdrReady, blob, groups: { studio }, reflector: null };
}
