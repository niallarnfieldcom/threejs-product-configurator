// Texture pipeline: 4K source → 2K KTX2 (GPU-compressed, mipmapped) for in-app
// rendering, AND 2K JPEG for AR export (USDZ/Quick Look can't read KTX2).
//   albedo (diff) → ETC1S, sRGB
//   normal (nor_gl) → UASTC + normal-map mode
//   rough / arm / spec → ETC1S, linear
import sharp from "sharp";
import { encodeToKTX2 } from "ktx2-encoder";
import fs from "node:fs";

const SIZE = 2048;
const imageDecoder = async (buf) => {
  const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

const MATERIALS = [
  { id: "fabric_leather_02", maps: [
    ["fabric_leather_02_diff_4k.jpg", "albedo"],
    ["fabric_leather_02_nor_gl_4k.jpg", "normal"],
    ["fabric_leather_02_rough_4k.jpg", "linear"],
  ] },
  { id: "velour_velvet", maps: [
    ["velour_velvet_diff_4k.jpg", "albedo"],
    ["velour_velvet_nor_gl_4k.jpg", "normal"],
    ["velour_velvet_arm_4k.jpg", "linear"],
    ["velour_velvet_spec_ior_4k.jpg", "linear"],
  ] },
  { id: "denim_fabric_03", maps: [
    ["denim_fabric_03_diff_4k.jpg", "albedo"],
    ["denim_fabric_03_nor_gl_4k.jpg", "normal"],
    ["denim_fabric_03_arm_4k.jpg", "linear"],
    ["denim_fabric_03_spec_ior_4k.jpg", "linear"],
  ] },
];

const optsFor = (type) =>
  type === "albedo" ? { isUASTC: false, isPerceptual: true, generateMipmap: true, qualityLevel: 200, compressionLevel: 2 }
  : type === "normal" ? { isUASTC: true, isNormalMap: true, isPerceptual: false, generateMipmap: true, uastcLDRQualityLevel: 2 }
  : { isUASTC: false, isPerceptual: false, generateMipmap: true, qualityLevel: 200, compressionLevel: 2 };

for (const mat of MATERIALS) {
  const base = `public/assets/materials/${mat.id}/textures`;
  const ktxDir = `public/assets/materials/${mat.id}/ktx2`;
  const jpgDir = `public/assets/materials/${mat.id}/2k`;
  fs.mkdirSync(ktxDir, { recursive: true });
  fs.mkdirSync(jpgDir, { recursive: true });
  for (const [file, type] of mat.maps) {
    const src = `${base}/${file}`;
    const stem = file.replace(/_4k\.jpg$/, "").replace(/\.jpg$/, "");
    const png = await sharp(src).resize(SIZE, SIZE, { fit: "fill" }).png().toBuffer();
    await sharp(src).resize(SIZE, SIZE, { fit: "fill" }).jpeg({ quality: 88 }).toFile(`${jpgDir}/${stem}_2k.jpg`);
    const t0 = Date.now();
    const ktx2 = await encodeToKTX2(new Uint8Array(png), { ...optsFor(type), imageDecoder });
    fs.writeFileSync(`${ktxDir}/${stem}_2k.ktx2`, Buffer.from(ktx2));
    console.log(`${mat.id}/${stem} [${type}] -> ${(ktx2.length / 1024).toFixed(0)}KB ktx2 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}
console.log("KTX2 + 2K JPEG pipeline complete.");
