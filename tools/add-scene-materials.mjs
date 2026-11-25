// Turn the Fern Room's own walnut and leather base-colour maps into selectable
// configurator materials (1K KTX2 for the live view, 1K JPEG for AR, thumbnail).
//   node tools/add-scene-materials.mjs "<path>/Fern Room/Textures"
import sharp from "sharp";
import { encodeToKTX2 } from "ktx2-encoder";
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2];
if (!SRC) throw new Error("Pass the Fern Room Textures folder");
const SIZE = 1024;
const imageDecoder = async (buf) => {
  const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};
const SETS = [
  { id: "fern_walnut", file: "walnut-basecolor.png" },
  { id: "fern_leather", file: "leather-basecolor.png" },
];
for (const { id, file } of SETS) {
  const dir = `public/assets/materials/${id}`;
  fs.mkdirSync(`${dir}/ktx2`, { recursive: true });
  fs.mkdirSync(`${dir}/1k`, { recursive: true });
  const src = path.join(SRC, file);
  const png = await sharp(src).resize(SIZE, SIZE, { fit: "fill" }).png().toBuffer();
  await sharp(src).resize(SIZE, SIZE, { fit: "fill" }).jpeg({ quality: 86 }).toFile(`${dir}/1k/${id}_diff_1k.jpg`);
  await sharp(src).resize(256, 256, { fit: "cover" }).jpeg({ quality: 82 }).toFile(`${dir}/thumb.jpg`);
  const ktx2 = await encodeToKTX2(new Uint8Array(png), { isUASTC: false, isPerceptual: true, generateMipmap: true, qualityLevel: 200, compressionLevel: 2, imageDecoder });
  fs.writeFileSync(`${dir}/ktx2/${id}_diff_1k.ktx2`, Buffer.from(ktx2));
  console.log(`${id}: ${(ktx2.length / 1024).toFixed(0)} KB ktx2`);
}
