// Photo render: progressive GPU path tracing with three-gpu-pathtracer.
//
// The tracer renders the same scene as the live renderer: same geometry, same
// materials, same studio panorama. Because the panorama is importance-sampled,
// its soft boxes behave as real area lights, which gives soft contact shadows,
// bounce light off the floor, true mirror reflections and glass.
//
// The app drives it like this:
//   - camera or scene moving  → the live renderer draws; the tracer waits
//   - everything still        → call render() each frame; samples accumulate
//     off-screen and the image cross-fades in once it is clean enough to show
//   - converged               → render() does nothing; the GPU is idle
//
// This module is loaded lazily, so devices that never trace never download it.

import * as THREE from "three";
import { WebGLPathTracer, DenoiseMaterial } from "three-gpu-pathtracer";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

const REVEAL_AT = 6;        // samples before the traced image starts to show
const FADE_MS = 450;        // cross-fade from the live frame to the traced one
const DENOISE_UNTIL = 220;  // the edge-aware denoiser eases off by this many samples
const MAX_PIXELS = 2.3e6;   // cap the traced resolution (≈ 1080p) on very large canvases

export function createPhotoTracer(renderer, scene, camera, { studio, maxSamples = 480 } = {}) {
  const tracer = new WebGLPathTracer(renderer);
  tracer.tiles.set(2, 2);            // each call traces a quarter of the frame → stays responsive
  tracer.bounces = 6;
  tracer.transmissiveBounces = 8;    // glass bottle and its liquid
  tracer.filterGlossyFactor = 0.4;   // tame fireflies from the mirror and bright steel
  tracer.multipleImportanceSampling = true;
  tracer.dynamicLowRes = false;
  tracer.rasterizeScene = false;     // the app draws the live frame itself
  tracer.renderDelay = 0;
  tracer.fadeDuration = 0;           // the cross-fade is handled below
  tracer.minSamples = REVEAL_AT;
  tracer.textureSize.set(1024, 1024);

  const denoiseQuad = new FullScreenQuad(new DenoiseMaterial());
  let revealStart = 0;
  let callsPerFrame = 4;
  let built = false;

  // Final blit: denoise early samples, fade over the live frame, tone-map once.
  tracer.renderToCanvasCallback = (target, r, quad) => {
    const now = performance.now();
    if (!revealStart) revealStart = now;
    const opacity = Math.min(1, (now - revealStart) / FADE_MS);
    const ease = Math.max(0, 1 - tracer.samples / DENOISE_UNTIL);
    const useDenoise = ease > 0.02;
    const material = useDenoise ? denoiseQuad.material : quad.material;
    if (useDenoise) {
      material.map = target.texture;
      material.sigma = 2.2;
      material.kSigma = 1;
      material.threshold = 0.012 + 0.03 * ease;
    }
    material.opacity = opacity;
    // Explicit straight-alpha blend over the live frame already on the canvas.
    material.blending = opacity < 1 ? THREE.CustomBlending : THREE.NoBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    material.premultipliedAlpha = false;
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(null);
    (useDenoise ? denoiseQuad : quad).render(r);
    r.autoClear = autoClear;
    quad.material.opacity = 1; // the library uses this as its own "revealed" flag
  };

  function fitResolution() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    tracer.renderScale = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, size.x * size.y)));
  }

  /** Hand the tracer the scene with traced lighting, then restore live lighting. */
  function withTracedLighting(fn) {
    studio?.useTracedLighting(true);
    try { fn(); } finally { studio?.useTracedLighting(false); }
  }

  return {
    get samples() { return tracer.samples; },
    get progress() { return Math.min(1, tracer.samples / maxSamples); },
    get done() { return tracer.samples >= maxSamples; },
    get revealed() { return revealStart > 0; },
    get compiling() { return tracer.isCompiling; },

    /** Build the BVH and upload materials and lights. Blocks for a moment on large scenes. */
    build() {
      fitResolution();
      withTracedLighting(() => tracer.setScene(scene, camera));
      built = true;
      revealStart = 0;
    },

    /** The camera moved: restart accumulation. */
    cameraChanged() {
      if (!built) return;
      fitResolution();
      tracer.updateCamera();
      revealStart = 0;
    },

    /** A finish changed: re-read materials and textures, restart accumulation. */
    materialsChanged() {
      if (!built) return;
      withTracedLighting(() => tracer.updateMaterials());
      revealStart = 0;
    },

    /**
     * Trace for one frame. `frameMs` is the time since the previous frame; it
     * steers how much work is queued so the page stays responsive.
     */
    render(frameMs = 16) {
      if (!built || tracer.samples >= maxSamples) return;
      if (frameMs < 22) callsPerFrame = Math.min(24, callsPerFrame + 1);
      else if (frameMs > 40) callsPerFrame = Math.max(1, callsPerFrame - 2);
      for (let i = 0; i < callsPerFrame; i++) {
        if (tracer.samples >= maxSamples) { tracer.renderToCanvas = true; tracer.renderSample(); break; }
        tracer.renderToCanvas = i === callsPerFrame - 1;
        tracer.renderSample();
      }
      tracer.renderToCanvas = true;
    },

    dispose() {
      tracer.dispose();
      denoiseQuad.dispose();
      denoiseQuad.material.dispose();
      built = false;
    },
  };
}
