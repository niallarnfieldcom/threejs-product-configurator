import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS } from "../src/products.js";
import { PBR_MATERIALS } from "../src/pbr-materials.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const errors = [];

function required(relative) {
  if (!fs.existsSync(path.join(dist, relative))) errors.push(`missing ${relative}`);
}

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(full) : [full];
  });
}

if (!fs.existsSync(dist)) errors.push("dist does not exist; run npm run build first");
for (const relative of ["index.html", "manifest.webmanifest", "sw.js", "basis/basis_transcoder.wasm", "draco/draco_decoder.wasm", "assets/brown_photostudio_02_4k.hdr", "assets/anniversary_lounge_4k.hdr"]) required(relative);
for (const product of Object.values(PRODUCTS)) required(product.model);
for (const material of PBR_MATERIALS) {
  required(material.thumb);
  for (const stem of Object.values(material.maps || {})) required(`${material.base}/${stem}.ktx2`);
}

const outputFiles = filesIn(dist);
const size = outputFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
const forbidden = outputFiles.filter((file) => /\.fbx$|^hdri_.*\.hdr$/i.test(path.basename(file)));
if (forbidden.length) errors.push(`forbidden authoring/environment files shipped: ${forbidden.length}`);
if (size > 150 * 1024 * 1024) errors.push(`dist is ${(size / 1024 / 1024).toFixed(1)} MB; limit is 150 MB`);

if (errors.length) {
  console.error("Build asset check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Build assets valid: ${outputFiles.length} files; ${(size / 1024 / 1024).toFixed(1)} MB; ${Object.keys(PRODUCTS).length} products.`);
