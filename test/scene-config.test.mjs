import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE, defaultState, readState, writeState, describeState, priceInfo, findFinish } from "../src/scene-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Node names from the JSON chunk of a GLB (no loader needed; Draco only compresses buffers). */
function glbNodeNames(file) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.toString("ascii", 0, 4), "glTF");
  const length = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + length).toString("utf8"));
  return new Set(json.nodes.map((node) => String(node.name || "").toLowerCase()));
}

test("the model exists and has a node for every configurable slot", () => {
  const names = glbNodeNames(path.join(root, "public", SCENE.model));
  for (const slot of SCENE.slots) assert.ok(names.has(slot.id), `GLB is missing slot node "${slot.id}"`);
});

test("slots, finishes and views are well formed", () => {
  const slotIds = SCENE.slots.map((slot) => slot.id);
  assert.equal(new Set(slotIds).size, slotIds.length);
  for (const slot of SCENE.slots) {
    assert.ok(slot.label, slot.id);
    const ids = slot.finishes.map((finish) => finish.id);
    assert.equal(new Set(ids).size, ids.length, `${slot.id}: duplicate finish ids`);
    assert.equal(slot.finishes.filter((finish) => finish.original).length, 1, `${slot.id}: exactly one authored finish`);
    for (const finish of slot.finishes) {
      assert.ok(finish.name, `${slot.id}:${finish.id}`);
      assert.match(finish.original ? finish.swatch : finish.color, /^#[0-9a-f]{6}$/i, `${slot.id}:${finish.id}`);
    }
  }
  const viewIds = SCENE.views.map((view) => view.id);
  assert.equal(new Set(viewIds).size, viewIds.length);
  for (const view of SCENE.views) {
    assert.equal(view.position.length, 3, view.id);
    assert.equal(view.target.length, 3, view.id);
    assert.ok(view.position[1] > 0, `${view.id}: camera must be above the floor`);
  }
});

test("a configuration round-trips through the URL", () => {
  const state = { ...defaultState(), a: "ink", b: "oak", view: "chair" };
  assert.equal(writeState(state).toString(), "a=ink&b=oak&view=chair");
  assert.deepEqual(readState(writeState(state)), state);
});

test("invalid URL values fall back to the defaults", () => {
  assert.deepEqual(readState("?a=tartan&b=&view=ceiling&c=oak"), defaultState());
  assert.equal(readState("?a=ink&b=nope").a, "ink");
  assert.equal(readState("?a=ink&b=nope").b, defaultState().b);
});

test("the summary names finishes for quotes and analytics", () => {
  const summary = describeState({ ...defaultState(), a: "cognac" });
  assert.equal(summary.scene, SCENE.id);
  assert.equal(summary.finishes.a, findFinish("a", "cognac").name);
});

test("prices only show once approved", () => {
  assert.deepEqual(priceInfo({ approved: false }), { price: null, leadTime: null });
  assert.equal(priceInfo({ approved: true, price: "100" }).price, "100");
});
