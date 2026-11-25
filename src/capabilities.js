// Decides how much rendering a device should be asked to do. Pure functions,
// so the rules are unit-tested without a browser.
//
//   basic   WebGL 1, software rendering, data saver or very little memory:
//           live renderer at 1× pixel ratio, small shadow map
//   live    phones and tablets: live renderer with soft shadows
//   traced  desktop GPUs: live renderer while moving, path-traced photo render
//           when the view is still

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|microsoft basic|basic render/i;

export const RENDER_TIERS = Object.freeze({
  basic: Object.freeze({ key: "basic", pixelRatio: 1, shadowMapSize: 1024, pathTracing: false }),
  live: Object.freeze({ key: "live", pixelRatio: 2, shadowMapSize: 2048, pathTracing: false }),
  traced: Object.freeze({ key: "traced", pixelRatio: 2, shadowMapSize: 2048, pathTracing: true }),
});

export function isSoftwareRenderer(rendererName = "") {
  return SOFTWARE_RENDERER.test(rendererName);
}

export function chooseRenderTier({
  webgl2 = true,
  rendererName = "",
  deviceMemory = 4,
  hardwareConcurrency = 4,
  isMobile = false,
  saveData = false,
  requested = null, // "live" or "traced" from ?render=, when the visitor asks
} = {}) {
  if (!webgl2 || isSoftwareRenderer(rendererName)) return RENDER_TIERS.basic;
  if (saveData || deviceMemory <= 2 || hardwareConcurrency <= 2) return RENDER_TIERS.basic;
  if (requested === "live") return RENDER_TIERS.live;
  if (requested === "traced") return RENDER_TIERS.traced;
  return isMobile ? RENDER_TIERS.live : RENDER_TIERS.traced;
}
