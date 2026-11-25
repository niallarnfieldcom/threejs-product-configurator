// Build a model→mesh-name map by reading the JSON chunk of every product GLB
// (Draco only compresses geometry buffers — node/mesh names stay in the JSON, so no
// gltf loader needed). Writes tools/model-mesh-map.json + prints a material-coverage
// audit (which mesh names exist across the catalogue and what material rule catches them).
//   node tools/scan-meshes.mjs
import fs from "node:fs";

const ROOT = "public/assets";
const map = {};
for (const id of fs.readdirSync(ROOT)) {
  const f = `${ROOT}/${id}/model.glb`;
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  if (buf.readUInt32LE(0) !== 0x46546c67) continue;        // 'glTF'
  const len = buf.readUInt32LE(12), type = buf.readUInt32LE(16);
  if (type !== 0x4e4f534a) continue;                        // 'JSON'
  const json = JSON.parse(buf.subarray(20, 20 + len).toString("utf8"));
  const names = new Set();
  for (const n of json.nodes || []) if (n.mesh !== undefined && n.name) names.add(n.name);
  if (!names.size) for (const m of json.meshes || []) if (m.name) names.add(m.name);
  map[id] = [...names];
}
fs.writeFileSync("tools/model-mesh-map.json", JSON.stringify(map, null, 1));

// ---- audit ----
const tally = new Map(); // baseName -> count of products it appears in
for (const arr of Object.values(map))
  for (const raw of new Set(arr.map((n) => n.toLowerCase().replace(/\.\d+$/, "")))) tally.set(raw, (tally.get(raw) || 0) + 1);

const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
const hit = (re) => sorted.filter(([n]) => re.test(n));
console.log(`Scanned ${Object.keys(map).length} models → tools/model-mesh-map.json`);
console.log(`\nUnique mesh base-names: ${sorted.length}`);
console.log("\nBASIN/BODY (→ ceramic):", JSON.stringify(hit(/basin|body/i)));
console.log("\nBLACK (→ dark):       ", JSON.stringify(hit(/black/i)));
console.log("\nCHROME (→ chrome):    ", JSON.stringify(hit(/chrome/i)));
console.log("\nBASE/FEET (→ chrome): ", JSON.stringify(hit(/base|feet|foot/i)));
console.log("\nALL names (name × #products):");
console.log(sorted.map(([n, c]) => `${n}(${c})`).join("  "));
