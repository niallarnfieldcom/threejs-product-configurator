import test from "node:test";
import assert from "node:assert/strict";
import { chooseRenderTier, isSoftwareRenderer } from "../src/capabilities.js";

const desktop = { webgl2: true, rendererName: "ANGLE (NVIDIA GeForce RTX 3080)", deviceMemory: 8, hardwareConcurrency: 12 };

test("desktop GPUs get the path-traced photo render", () => {
  const tier = chooseRenderTier(desktop);
  assert.equal(tier.key, "traced");
  assert.equal(tier.pathTracing, true);
});

test("capable phones and tablets get a lighter photo render", () => {
  const tier = chooseRenderTier({ ...desktop, isMobile: true });
  assert.equal(tier.key, "mobile");
  assert.equal(tier.pathTracing, true);
  assert.ok(tier.photo.maxPixels < chooseRenderTier(desktop).photo.maxPixels);
  assert.ok(tier.photo.maxSamples < chooseRenderTier(desktop).photo.maxSamples);
});

test("devices that cannot path trace stay on the live renderer", () => {
  assert.equal(chooseRenderTier({ ...desktop, floatRenderTargets: false }).key, "live");
  assert.equal(chooseRenderTier({ ...desktop, isMobile: true, deviceMemory: 3 }).key, "live");
  assert.equal(chooseRenderTier({ ...desktop, isMobile: true, floatRenderTargets: false }).pathTracing, false);
});

test("a crashed photo render keeps the device on the live renderer", () => {
  assert.equal(chooseRenderTier({ ...desktop, photoRenderFailed: true }).key, "live");
  assert.equal(chooseRenderTier({ ...desktop, isMobile: true, photoRenderFailed: true }).key, "live");
  assert.equal(chooseRenderTier({ ...desktop, photoRenderFailed: true, requested: "traced" }).key, "traced");
});

test("software rendering, WebGL 1, data saver and low memory fall back to basic", () => {
  assert.equal(chooseRenderTier({ ...desktop, rendererName: "Google SwiftShader" }).key, "basic");
  assert.equal(chooseRenderTier({ ...desktop, webgl2: false }).key, "basic");
  assert.equal(chooseRenderTier({ ...desktop, saveData: true }).key, "basic");
  assert.equal(chooseRenderTier({ ...desktop, deviceMemory: 2 }).key, "basic");
  assert.ok(isSoftwareRenderer("llvmpipe (LLVM 15)"));
});

test("a visitor can ask for a tier, but a constrained device stays on basic", () => {
  assert.equal(chooseRenderTier({ ...desktop, requested: "live" }).key, "live");
  assert.equal(chooseRenderTier({ ...desktop, isMobile: true, requested: "traced" }).key, "mobile");
  assert.equal(chooseRenderTier({ ...desktop, floatRenderTargets: false, requested: "traced" }).key, "live");
  assert.equal(chooseRenderTier({ ...desktop, webgl2: false, requested: "traced" }).key, "basic");
});
