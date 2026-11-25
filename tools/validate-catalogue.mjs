import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS } from "../src/products.js";
import { PBR_MATERIALS } from "../src/pbr-materials.js";
import { CONFIG_SLOTS } from "../src/config-state.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const products = Object.values(PRODUCTS);
const materialById = new Map(PBR_MATERIALS.map((material) => [material.id, material]));

if (!products.length) errors.push("catalogue is empty");

const seenIds = new Set();
function glbNodeNames(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString("ascii", 0, 4) !== "glTF") return new Set();
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (type === 0x4e4f534a) {
      const json = JSON.parse(buffer.subarray(offset, offset + length).toString("utf8"));
      return new Set((json.nodes || []).map((node) => String(node.name || "").toLowerCase().replace(/\.\d+$/, "")).filter(Boolean));
    }
    offset += length;
  }
  return new Set();
}

for (const product of products) {
  if (!product?.id) errors.push("product is missing id");
  if (seenIds.has(product.id)) errors.push(`duplicate product id: ${product.id}`);
  seenIds.add(product.id);

  if (!product.name?.trim()) errors.push(`${product.id}: missing name`);
  if (!Number.isFinite(product.targetHeight) || product.targetHeight <= 0) {
    errors.push(`${product.id}: targetHeight must be positive`);
  }

  const slots = Array.isArray(product.slots) ? product.slots : [];
  const fabricSlots = Array.isArray(product.fabricSlots) ? product.fabricSlots : [];
  if (new Set(slots).size !== slots.length) errors.push(`${product.id}: duplicate model slots`);
  if (new Set(fabricSlots).size !== fabricSlots.length) errors.push(`${product.id}: duplicate fabric slots`);
  for (const slot of fabricSlots) {
    if (!CONFIG_SLOTS.includes(slot)) errors.push(`${product.id}: unsupported fabric slot ${slot}`);
    if (!slots.includes(slot)) errors.push(`${product.id}: fabric slot ${slot} is not a model slot`);
    if (!product.defaults?.[slot]) errors.push(`${product.id}: missing default for slot ${slot}`);
    else {
      const material = materialById.get(product.defaults[slot]);
      if (!material) errors.push(`${product.id}: default ${product.defaults[slot]} is not a registered swatch`);
      else if (product.slotFinish?.[slot] === "laminate" && material.category !== "laminate") errors.push(`${product.id}: laminate slot ${slot} default is not a laminate material`);
      else if (product.slotFinish?.[slot] === "fabric" && material.category !== "upholstery") errors.push(`${product.id}: fabric slot ${slot} default is not an upholstery material`);
    }
  }

  const modelPath = path.join(root, "public", product.model);
  if (!fs.existsSync(modelPath)) errors.push(`${product.id}: missing model ${product.model}`);
  else {
    const nodeNames = glbNodeNames(modelPath);
    for (const slot of slots) {
      if (!nodeNames.has(String(slot).toLowerCase().replace(/\.\d+$/, ""))) {
        errors.push(`${product.id}: declared model slot ${slot} is absent from GLB nodes`);
      }
    }
  }
}

if (errors.length) {
  console.error(`Catalogue validation failed: ${errors.length} issue(s)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Catalogue valid: ${products.length} products; ${products.filter((p) => p.fabricSlots.length === 0).length} fixed-finish, ${products.filter((p) => p.fabricSlots.length === 1).length} one-slot, ${products.filter((p) => p.fabricSlots.length === 2).length} two-slot, ${products.filter((p) => p.fabricSlots.length >= 3).length} three-plus-slot.`);
}
