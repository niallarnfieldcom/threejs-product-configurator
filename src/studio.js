// The photo studio the product stands in: a bright seamless backdrop lit by
// soft boxes. One lighting description drives both renderers.
//
// - The lighting is a small procedural HDR panorama (soft boxes on a gentle
//   gradient). The path tracer importance-samples it, so the soft boxes cast
//   real soft shadows; the live renderer uses a second version of it,
//   prefiltered, for image-based lighting and reflections. Nothing is downloaded.
// - The floor is a large matte disc that fades into the backdrop colour, so
//   there is no visible horizon from any orbit angle.
// - The live renderer cannot shadow image-based light, so it gets one
//   shadow-casting directional light aligned with the key soft box. That light
//   lives in `rasterRig` and is hidden from the path tracer.

import * as THREE from "three";

export const BACKDROP = new THREE.Color("#ebe5db"); // warm studio off-white

// The floor is tinted so that, once lit by the warm key, it lands on the
// backdrop colour and the horizon disappears. The two renderers light it
// slightly differently, so each has its own tint. The live renderer does not
// tone-map a plain background colour, so it also gets the backdrop as it
// appears after tone mapping.
const FLOOR_TRACED = BACKDROP.clone().multiply(new THREE.Color(0.63, 0.66, 0.7));
const FLOOR_LIVE = BACKDROP.clone().multiply(new THREE.Color(0.71, 0.75, 0.81));
const BACKDROP_LIVE = new THREE.Color("#e5dfd5");

// The live renderer adds a directional key for shadows, so its image-based
// light is turned down to keep overall exposure close to the path-traced result.
const RASTER_ENV_INTENSITY = 0.66;

const DEG = Math.PI / 180;

// Soft boxes: azimuth/elevation of the centre, angular half-size, and radiance
// (linear, HDR). Azimuth 0 is +x, 90 is +z (towards the default camera side).
// Radiances are balanced so a white card on the floor receives about one unit
// of light in total, a little over half of it from the key: bright, with soft
// but readable shadows.
const SOFT_BOXES = [
  { az: 118, el: 50, halfAz: 17, halfEl: 11, color: [1.0, 0.97, 0.93], radiance: 15.5 },  // key, high front-left
  { az: -18, el: 26, halfAz: 40, halfEl: 20, color: [0.94, 0.97, 1.0], radiance: 0.85 }, // fill, low right
  { az: 236, el: 38, halfAz: 8, halfEl: 28, color: [1.0, 0.98, 0.96], radiance: 3.2 },   // rim strip, behind
  { az: 300, el: 30, halfAz: 28, halfEl: 15, color: [1.0, 0.97, 0.94], radiance: 1.0 },  // back fill
];
export const KEY_DIRECTION = new THREE.Vector3(
  Math.cos(SOFT_BOXES[0].el * DEG) * Math.cos(SOFT_BOXES[0].az * DEG),
  Math.sin(SOFT_BOXES[0].el * DEG),
  Math.cos(SOFT_BOXES[0].el * DEG) * Math.sin(SOFT_BOXES[0].az * DEG),
);

const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Build the studio lighting as an equirectangular float HDR texture.
 *
 * The path tracer sees the real scene in every reflection, so its panorama
 * only carries the lights. The live renderer has nothing but the panorama to
 * reflect, so its version also paints in the bright backdrop and floor;
 * otherwise steel and the mirror would reflect a dark, empty room.
 */
export function createStudioEnvironment({ reflectBackdrop = false, width = 1024, height = 512 } = {}) {
  const data = new Float32Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const el = ((j + 0.5) / height) * Math.PI - Math.PI / 2; // -90° (down) → +90° (up)
    const cosEl = Math.cos(el);
    // Ambient wrap: bright ceiling bounce, softer walls, warm floor bounce below the horizon.
    const up = smooth(-0.15, 1, Math.sin(el));
    const ambient = reflectBackdrop
      ? (el < 0 ? 0.74 : 0.8 + 0.1 * up)
      // A bright band around the horizon stands in for the studio walls, so the
      // mirror and steel have something light to reflect; the dome above stays
      // dimmer so the key light still shapes the scene.
      : (el < 0 ? 0.3 : 0.2 + 0.42 * (1 - smooth(12 * DEG, 42 * DEG, el)) + 0.06 * up);
    for (let i = 0; i < width; i++) {
      const az = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
      let r = ambient * 1.0, g = ambient * (reflectBackdrop ? 0.95 : 0.975), b = ambient * (reflectBackdrop ? 0.88 : 0.94);
      for (const box of SOFT_BOXES) {
        let dAz = az - box.az * DEG;
        dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz)) * cosEl; // wrap, and keep the box rectangular on the sphere
        const dEl = el - box.el * DEG;
        const wA = 1 - smooth(box.halfAz * DEG * 0.78, box.halfAz * DEG, Math.abs(dAz));
        const wE = 1 - smooth(box.halfEl * DEG * 0.78, box.halfEl * DEG, Math.abs(dEl));
        const w = wA * wE * box.radiance * (reflectBackdrop ? 0.4 : 1);
        if (w > 0) { r += box.color[0] * w; g += box.color[1] * w; b += box.color[2] * w; }
      }
      const o = (j * width + i) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function radialFade(innerFraction) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
  gradient.addColorStop(0, "#fff");
  gradient.addColorStop(innerFraction, "#fff");
  gradient.addColorStop(1, "#000");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/**
 * Add the studio to a scene. Returns the pieces the app needs to switch
 * between the live renderer and the path tracer.
 */
export function createStudio(scene, renderer, { radius = 14, shadowExtent = 3.4 } = {}) {
  // Both panoramas are raw equirectangular textures: three prefilters one for the
  // live renderer by itself, and the path tracer importance-samples the other.
  const tracedEnvironment = createStudioEnvironment();
  const liveEnvironment = createStudioEnvironment({ reflectBackdrop: true });
  scene.background = BACKDROP_LIVE.clone();
  scene.environment = liveEnvironment;

  // Seamless floor: matte, the backdrop's colour, fading out towards its rim.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 96),
    new THREE.MeshStandardMaterial({
      color: FLOOR_TRACED.clone(),
      roughness: 0.96,
      metalness: 0,
      transparent: true,
      alphaMap: radialFade(0.3),
      depthWrite: false,
    }),
  );
  floor.name = "studio-floor";
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  floor.receiveShadow = true;
  floor.renderOrder = -1;
  scene.add(floor);

  // Live-renderer shadow light, aligned with the key soft box.
  const rasterRig = new THREE.Group();
  rasterRig.name = "raster-rig";
  const sun = new THREE.DirectionalLight(0xfff6ea, 2.45);
  sun.position.copy(KEY_DIRECTION).multiplyScalar(9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.right = sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 20;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 9;
  sun.shadow.blurSamples = 16;
  rasterRig.add(sun, sun.target);
  scene.add(rasterRig);

  return {
    floor,
    rasterRig,
    /** Switch lighting between the path tracer (true) and the live renderer (false). */
    useTracedLighting(on) {
      rasterRig.visible = !on;
      scene.environment = on ? tracedEnvironment : liveEnvironment;
      scene.background.copy(on ? BACKDROP : BACKDROP_LIVE);
      floor.material.color.copy(on ? FLOOR_TRACED : FLOOR_LIVE);
      scene.environmentIntensity = on ? 1 : RASTER_ENV_INTENSITY;
    },
  };
}
