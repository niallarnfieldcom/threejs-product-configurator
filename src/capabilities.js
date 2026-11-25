// Decides how much rendering a device should be asked to do. Pure functions,
// so the rules are unit-tested without a browser.
//
//   basic   WebGL 1, software rendering, data saver or very little memory:
//           live renderer at 1× pixel ratio, small shadow map
//   live    devices that cannot path trace (no float render targets), or where
//           a previous photo render attempt crashed: live renderer with soft shadows
//   mobile  capable phones and tablets: live renderer while moving, then a
//           lighter photo render (lower resolution, fewer samples and bounces)
//   traced  desktop GPUs: live renderer while moving, full photo render when still

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|microsoft basic|basic render/i;

export const RENDER_TIERS = Object.freeze({
  basic: Object.freeze({ key: "basic", pixelRatio: 1, shadowMapSize: 1024, pathTracing: false, photo: null }),
  live: Object.freeze({ key: "live", pixelRatio: 2, shadowMapSize: 2048, pathTracing: false, photo: null }),
  mobile: Object.freeze({
    key: "mobile", pixelRatio: 2, shadowMapSize: 2048, pathTracing: true,
    photo: Object.freeze({ maxPixels: 0.6e6, maxSamples: 200, bounces: 5, transmissiveBounces: 5, tiles: 3, denoiseUntil: 500, denoiseStrength: 2.4, settleMs: 450 }),
  }),
  traced: Object.freeze({
    key: "traced", pixelRatio: 2, shadowMapSize: 2048, pathTracing: true,
    photo: Object.freeze({ maxPixels: 2.3e6, maxSamples: 480, bounces: 6, transmissiveBounces: 8, tiles: 2, denoiseUntil: 220, denoiseStrength: 1, settleMs: 220 }),
  }),
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
  floatRenderTargets = true, // EXT_color_buffer_float: the path tracer accumulates in float
  photoRenderFailed = false, // a previous attempt on this device crashed or lost the context
  requested = null,          // "live" or "traced" from ?render=, when the visitor asks
} = {}) {
  if (!webgl2 || isSoftwareRenderer(rendererName)) return RENDER_TIERS.basic;
  if (saveData || deviceMemory <= 2 || hardwareConcurrency <= 2) return RENDER_TIERS.basic;
  if (requested === "live" || !floatRenderTargets) return RENDER_TIERS.live;
  if (requested === "traced") return isMobile ? RENDER_TIERS.mobile : RENDER_TIERS.traced;
  if (photoRenderFailed) return RENDER_TIERS.live;
  if (isMobile) return deviceMemory >= 4 && hardwareConcurrency >= 4 ? RENDER_TIERS.mobile : RENDER_TIERS.live;
  return RENDER_TIERS.traced;
}
