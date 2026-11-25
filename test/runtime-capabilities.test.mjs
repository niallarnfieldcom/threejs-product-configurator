import test from "node:test";
import assert from "node:assert/strict";
import { canUsePathTracing, getRuntimeRenderProfile, isSoftwareRenderer } from "../src/runtime-capabilities.js";

test("software and constrained devices use the reduced profile", () => {
  assert.equal(isSoftwareRenderer("SwiftShader WebGL"), true);
  assert.equal(getRuntimeRenderProfile({ rendererName: "SwiftShader WebGL" }).key, "reduced");
  assert.equal(getRuntimeRenderProfile({ deviceMemory: 2, hardwareConcurrency: 2 }).key, "reduced");
});

test("mobile devices use balanced rendering without path tracing", () => {
  const profile = getRuntimeRenderProfile({ isMobile: true, deviceMemory: 4, hardwareConcurrency: 8 });
  assert.equal(profile.key, "balanced");
  assert.equal(canUsePathTracing({ profile, explicitlyRequested: true, webgl2: true }), false);
});

test("high profile only enables path tracing after explicit request", () => {
  const profile = getRuntimeRenderProfile({ deviceMemory: 8, hardwareConcurrency: 8 });
  assert.equal(profile.key, "high");
  assert.equal(canUsePathTracing({ profile, explicitlyRequested: false, webgl2: true }), false);
  assert.equal(canUsePathTracing({ profile, explicitlyRequested: true, webgl2: true }), true);
});

test("an explicit desktop request can path trace on the balanced high-DPI profile", () => {
  const profile = getRuntimeRenderProfile({ devicePixelRatio: 2.25, deviceMemory: 8, hardwareConcurrency: 8 });
  assert.equal(profile.key, "balanced");
  assert.equal(canUsePathTracing({ profile, explicitlyRequested: true, webgl2: true, allowBalanced: true }), true);
  assert.equal(canUsePathTracing({ profile, explicitlyRequested: false, webgl2: true, allowBalanced: true }), false);
});
