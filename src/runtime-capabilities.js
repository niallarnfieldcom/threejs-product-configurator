const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|microsoft basic|basic render/i;

export const RENDER_PROFILES = Object.freeze({
  reduced: Object.freeze({
    key: "reduced",
    pixelRatio: 1,
    hdr: "studio",
    probe: false,
    fullMaterialMaps: false,
    autoRotate: false,
    pathTracing: false,
  }),
  balanced: Object.freeze({
    key: "balanced",
    pixelRatio: 1.25,
    hdr: "studio",
    probe: false,
    fullMaterialMaps: false,
    autoRotate: true,
    pathTracing: false,
  }),
  high: Object.freeze({
    key: "high",
    pixelRatio: 1.5,
    hdr: "studio",
    probe: true,
    fullMaterialMaps: true,
    autoRotate: true,
    pathTracing: true,
  }),
});

export function isSoftwareRenderer(rendererName = "") {
  return SOFTWARE_RENDERER.test(rendererName);
}

export function getRuntimeRenderProfile({
  webgl2 = true,
  rendererName = "",
  deviceMemory = 4,
  hardwareConcurrency = 4,
  devicePixelRatio = 1,
  isMobile = false,
  saveData = false,
  prefersReducedMotion = false,
} = {}) {
  if (!webgl2 || isSoftwareRenderer(rendererName)) return RENDER_PROFILES.reduced;
  if (saveData || prefersReducedMotion || deviceMemory <= 2 || hardwareConcurrency <= 2) {
    return RENDER_PROFILES.reduced;
  }
  if (isMobile || devicePixelRatio > 1.5 || deviceMemory < 4) return RENDER_PROFILES.balanced;
  return RENDER_PROFILES.high;
}

export function canUsePathTracing({ profile, explicitlyRequested = false, webgl2 = true, allowBalanced = false } = {}) {
  // `balanced` is a performance recommendation, not a hard capability failure.
  // An explicit Photo Render request may use the tracer there; `reduced` still
  // blocks it because that tier represents WebGL1, software rendering or a
  // materially constrained device.
  return Boolean(explicitlyRequested && webgl2 && (profile?.key === "high" || (allowBalanced && profile?.key === "balanced")));
}
