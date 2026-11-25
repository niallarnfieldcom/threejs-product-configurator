import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS, DEFAULT_PRODUCT, productCatalogue } from "../src/products.js";
import { PBR_MATERIALS } from "../src/pbr-materials.js";
import { CONFIG_SLOTS } from "../src/config-state.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const materialById = new Map(PBR_MATERIALS.map((material) => [material.id, material]));

test("every registered product has a model and finish-aware defaults", () => {
  const products = Object.values(PRODUCTS);
  assert.ok(products.length > 0);
  assert.ok(PRODUCTS[DEFAULT_PRODUCT], "default product is registered");
  for (const product of products) {
    assert.ok(fs.existsSync(path.join(root, "public", product.model)), product.id);
    assert.ok(product.targetHeight > 0, product.id);
    for (const slot of product.fabricSlots) {
      assert.ok(CONFIG_SLOTS.includes(slot), `${product.id}:${slot}`);
      assert.ok(product.slots.includes(slot), `${product.id}:${slot}`);
      const material = materialById.get(product.defaults?.[slot]);
      assert.ok(material, `${product.id}:${slot}:${product.defaults?.[slot]}`);
      const expected = product.slotFinish[slot] === "laminate" ? "laminate" : "upholstery";
      assert.equal(material.category, expected, `${product.id}:${slot}`);
    }
  }
});

test("prices only appear for approved pricing", () => {
  for (const product of Object.values(PRODUCTS)) {
    if (product.price) assert.equal(product.pricing?.approved, true, product.id);
  }
});

test("material ids are unique and every textured set has its files", () => {
  const ids = PBR_MATERIALS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const material of PBR_MATERIALS) {
    if (!material.maps) {
      assert.match(material.color, /^rgb\(/, material.id);
      continue;
    }
    assert.ok(fs.existsSync(path.join(root, "public", material.thumb)), material.thumb);
    for (const stem of Object.values(material.maps)) {
      assert.ok(fs.existsSync(path.join(root, "public", material.base, `${stem}.ktx2`)), `${material.id}:${stem}`);
    }
  }
});

test("the catalogue list is sorted by name", () => {
  const names = productCatalogue().map((p) => p.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});
