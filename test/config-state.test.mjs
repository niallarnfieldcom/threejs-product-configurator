import test from "node:test";
import assert from "node:assert/strict";
import {
  configurationPayload,
  createConfigurationDefaults,
  productConfigSlots,
  readConfiguration,
  serializeConfiguration,
} from "../src/config-state.js";

const product = { fabricSlots: ["c", "a", "b"], defaults: { a: "a0", b: "b0", c: "c0" } };
const swatches = [{ id: "a0" }, { id: "b1" }, { id: "c1" }];

test("configuration slots are normalized to the supported product order", () => {
  assert.deepEqual(productConfigSlots(product), ["a", "b", "c"]);
  assert.deepEqual(createConfigurationDefaults(product), {
    env: "studio", cam: "hero", activeSlot: "a", a: "a0", b: "b0", c: "c0",
  });
});

test("three-slot state round-trips without phantom slots", () => {
  const state = readConfiguration("?env=hdri&cam=detail&slot=c&a=a0&b=b1&c=c1&d=ignored", { product, swatches });
  assert.deepEqual(configurationPayload(state, product), {
    env: "hdri", cam: "detail", slots: { a: "a0", b: "b1", c: "c1" },
  });
  assert.equal(serializeConfiguration(state, product).toString(), "env=hdri&cam=detail&slot=c&a=a0&b=b1&c=c1");
});

test("invalid URL values fall back to safe defaults", () => {
  const state = readConfiguration("?env=nope&cam=nope&a=missing", { product, swatches });
  assert.equal(state.env, "studio");
  assert.equal(state.cam, "hero");
  assert.equal(state.a, "a0");
});
