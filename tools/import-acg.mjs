// Bulk material importer: ambientCG (CC0) → app KTX2 pipeline.
// Fetches valid asset IDs from the ambientCG API (no guessing), downloads the
// 2K-JPG set, extracts Color/NormalGL/Roughness, then 2K KTX2 (in-app) + 2K JPEG
// (AR) + thumb — same encoder/opts as make-ktx.mjs. Writes a generated module
// src/pbr-materials-acg.js (ACG_MATERIALS) that pbr-materials.js folds in.
//
// Idempotent: skips a material whose ktx2 albedo already exists.
//   node tools/import-acg.mjs
import sharp from "sharp";
import { encodeToKTX2 } from "ktx2-encoder";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const SIZE = 2048;
const ROOT = "public/assets/materials";
const TMP = "tools/.acg-tmp";
const WANT = { fabric: 20, wood: 20 }; // 20 fabrics (upholstery) + 20 woods (laminate)

const imageDecoder = async (buf) => {
  const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};
const optsFor = (type) =>
  type === "albedo" ? { isUASTC: false, isPerceptual: true, generateMipmap: true, qualityLevel: 200, compressionLevel: 2 }
  : type === "normal" ? { isUASTC: true, isNormalMap: true, isPerceptual: false, generateMipmap: true, uastcLDRQualityLevel: 2 }
  : { isUASTC: false, isPerceptual: false, generateMipmap: true, qualityLevel: 200, compressionLevel: 2 };

async function apiList(category, want) {
  // over-fetch so we can skip any asset missing a needed map
  const u = `https://ambientcg.com/api/v2/full_json?type=Material&category=${category}&limit=${want + 12}&sort=Popular&include=downloadData`;
  const j = await (await fetch(u)).json();
  const out = [];
  for (const a of j.foundAssets || []) {
    const dl = a.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads || [];
    const jpg = dl.find((d) => /^2K-JPG$/i.test(d.attribute || d.downloadAttribute || ""));
    const url = jpg?.fullDownloadPath || jpg?.downloadLink;
    if (url) out.push({ id: a.assetId, name: a.displayName?.replace(/\s+/g, " ").trim() || a.assetId, url });
    if (out.length >= want + 8) break;
  }
  return out;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const findMap = (dir, re) => walk(dir).find((f) => re.test(path.basename(f)));

async function process(matId, srcDir, category) {
  const color = findMap(srcDir, /_Color\.(jpg|png)$/i);
  const normal = findMap(srcDir, /_NormalGL\.(jpg|png)$/i);
  const rough = findMap(srcDir, /_Roughness\.(jpg|png)$/i);
  if (!color || !normal || !rough) return null; // missing a required map → skip

  const outId = `acg_${matId.toLowerCase()}`;
  const dest = `${ROOT}/${outId}`;
  const ktxDir = `${dest}/ktx2`, jpgDir = `${dest}/2k`;
  const stem = matId; // map stems carry the asset id
  fs.mkdirSync(ktxDir, { recursive: true });
  fs.mkdirSync(jpgDir, { recursive: true });

  const jobs = [[color, "albedo", "diff"], [normal, "normal", "nor_gl"], [rough, "linear", "rough"]];
  for (const [src, type, tag] of jobs) {
    // Normals at 1K (low-frequency on fabric/wood, ~3.5× smaller); albedo+rough at 2K.
    const ktxSize = type === "normal" ? 1024 : SIZE;
    const png = await sharp(src).resize(ktxSize, ktxSize, { fit: "fill" }).png().toBuffer();
    await sharp(src).resize(SIZE, SIZE, { fit: "fill" }).jpeg({ quality: 88 }).toFile(`${jpgDir}/${stem}_${tag}_2k.jpg`); // AR jpg stays 2K
    const ktx2 = await encodeToKTX2(new Uint8Array(png), { ...optsFor(type), imageDecoder });
    fs.writeFileSync(`${ktxDir}/${stem}_${tag}_2k.ktx2`, Buffer.from(ktx2));
  }
  // thumb from the colour map
  await sharp(color).resize(256, 256, { fit: "fill" }).jpeg({ quality: 84 }).toFile(`${dest}/thumb.jpg`);

  const isFab = category === "Fabric";
  return {
    id: outId, name: name(matId), category: isFab ? "upholstery" : "laminate",
    thumb: `assets/materials/${outId}/thumb.jpg`,
    base: `assets/materials/${outId}/ktx2`, arBase: `assets/materials/${outId}/2k`,
    maps: { albedo: `${stem}_diff_2k`, normal: `${stem}_nor_gl_2k`, roughness: `${stem}_rough_2k` },
    repeat: isFab ? 2.4 : 1.4, normalScale: 1.0, metalness: 0,
  };
}
const name = (id) => id.replace(/([A-Za-z]+)(\d+)([A-Z]?)/, (_, w, n, s) => `${w} ${n}${s ? " " + s : ""}`);

fs.mkdirSync(TMP, { recursive: true });
const out = [];
for (const [cat, want] of [["Fabric", WANT.fabric], ["Wood", WANT.wood]]) {
  const list = await apiList(cat, want);
  let got = 0;
  for (const a of list) {
    if (got >= want) break;
    const outId = `acg_${a.id.toLowerCase()}`;
    // Skip only if FULLY processed — all 3 maps + thumb. (A partial dir from an
    // interrupted run must be redone, not skipped.)
    const complete = ["diff", "nor_gl", "rough"].every((t) => fs.existsSync(`${ROOT}/${outId}/ktx2/${a.id}_${t}_2k.ktx2`))
      && fs.existsSync(`${ROOT}/${outId}/thumb.jpg`);
    if (complete) {
      console.log(`SKIP ${a.id} (exists)`);
      const ex = await reEntry(a, cat); if (ex) { out.push(ex); got++; } continue;
    }
    try {
      const zip = path.join(TMP, `${a.id}.zip`);
      const ex = path.join(TMP, a.id);
      if (!fs.existsSync(zip) || fs.statSync(zip).size < 5000) {
        console.log(`DL   ${a.id} …`);
        const buf = Buffer.from(await (await fetch(a.url)).arrayBuffer());
        if (buf.length < 5000) { console.log(`  bad zip (${buf.length}b), skip`); continue; }
        fs.writeFileSync(zip, buf);
      } else console.log(`DL   ${a.id} (cached)`);
      fs.rmSync(ex, { recursive: true, force: true });
      fs.mkdirSync(ex, { recursive: true });
      // GNU tar here can't read zip — use PowerShell Expand-Archive (bsdtar absent).
      execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${path.resolve(zip)}' -DestinationPath '${path.resolve(ex)}' -Force"`, { stdio: "ignore" });
      const t0 = Date.now();
      const entry = await process(a.id, ex, cat);
      if (entry) { out.push(entry); got++; console.log(`  OK  ${a.id} (${cat}) ${((Date.now() - t0) / 1000).toFixed(0)}s  [${got}/${want}]`); }
      else console.log(`  skip ${a.id} (missing map)`);
      fs.rmSync(ex, { recursive: true, force: true });
    } catch (e) { console.log(`  ERR ${a.id}: ${String(e.message).slice(0, 100)}`); }
  }
  console.log(`=== ${cat}: ${got}/${want} ===`);
}
async function reEntry(a, cat) {
  const outId = `acg_${a.id.toLowerCase()}`, isFab = cat === "Fabric", stem = a.id;
  return { id: outId, name: name(a.id), category: isFab ? "upholstery" : "laminate",
    thumb: `assets/materials/${outId}/thumb.jpg`, base: `assets/materials/${outId}/ktx2`, arBase: `assets/materials/${outId}/2k`,
    maps: { albedo: `${stem}_diff_2k`, normal: `${stem}_nor_gl_2k`, roughness: `${stem}_rough_2k` },
    repeat: isFab ? 2.4 : 1.4, normalScale: 1.0, metalness: 0 };
}

const body = "// AUTO-GENERATED by tools/import-acg.mjs — ambientCG CC0 materials.\n"
  + "// Do not hand-edit; re-run the importer to regenerate.\n"
  + "export const ACG_MATERIALS = " + JSON.stringify(out, null, 2) + ";\n";
fs.writeFileSync("src/pbr-materials-acg.js", body);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nDONE — ${out.length} materials → src/pbr-materials-acg.js`);
