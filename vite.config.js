import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { PRODUCTS } from "./src/products.js";
import { PBR_MATERIALS } from "./src/pbr-materials.js";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(projectDir, "public");

// Small plugin that exposes the machine's non-internal IPv4 addresses
// to the client so the Share/QR dialog can offer the exact "Network" URLs
// that Vite prints, without the user having to copy-paste manually.
// Expose the machine's PRIVATE LAN IPv4s to the client (for the phone/QR share).
// Must use the `config` hook (not configResolved) so `define` is applied before
// Vite freezes it. Filter to private ranges so the QR never targets a public IP
// the phone can't reach.
const isPrivateLAN = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
function networkInfoPlugin() {
  return {
    name: "configurator-network-info",
    config() {
      const ips = [];
      for (const iface of Object.values(os.networkInterfaces())) {
        for (const net of iface) {
          if (net.family === "IPv4" && !net.internal && isPrivateLAN(net.address)) ips.push(net.address);
        }
      }
      return { define: { __VITE_NETWORK_IPS__: JSON.stringify(ips) } };
    },
  };
}

// Production must ship the runtime catalogue, not the authoring tree. The
// source public directory intentionally keeps FBX and alternate HDR files for
// artists and local development; this pack copies only files the app can reach.
function runtimeAssetPackPlugin() {
  return {
    name: "configurator-runtime-asset-pack",
    apply: "build",
    async writeBundle(options) {
      const outDir = options.dir || path.join(projectDir, "dist");
      const files = new Set([
        "manifest.webmanifest",
        "sw.js",
        "basis/basis_transcoder.js",
        "basis/basis_transcoder.wasm",
        "draco/draco_decoder.js",
        "draco/draco_decoder.wasm",
        "draco/draco_wasm_wrapper.js",
        "icons/icon-192.png",
        "icons/icon-512.png",
        "assets/brown_photostudio_02_4k.hdr",
        "assets/anniversary_lounge_4k.hdr",
      ]);

      for (const product of Object.values(PRODUCTS)) {
        files.add(product.model);
        if (product.baked) {
          files.add(`assets/${product.id}/ao_2k.png`);
          const bakedSlots = Array.isArray(product.bakedSlots)
            ? product.bakedSlots
            : product.slots.filter((slot) => !/chrome/i.test(slot));
          for (const slot of bakedSlots) files.add(`assets/${product.id}/lm_${slot}.png`);
        }
      }

      // KTX2 maps are used by the live renderer. Thumbnails and compressed AR
      // JPEGs are retained, but AR JPEGs are rebuilt to a phone-friendly 1K
      // size so the largest material pack is not needlessly shipped at 2K.
      const arJpegs = new Set();
      for (const material of PBR_MATERIALS) {
        files.add(material.thumb);
        for (const stem of Object.values(material.maps || {})) {
          files.add(`${material.base}/${stem}.ktx2`);
          arJpegs.add(`${material.arBase}/${stem}.jpg`);
        }
      }

      const copy = async (relative) => {
        const source = path.join(publicDir, relative);
        const target = path.join(outDir, relative);
        if (!fs.existsSync(source)) throw new Error(`Runtime asset missing: ${relative}`);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(source, target);
      };

      for (const relative of files) await copy(relative);
      for (const relative of arJpegs) {
        const source = path.join(publicDir, relative);
        const target = path.join(outDir, relative);
        if (!fs.existsSync(source)) throw new Error(`Runtime AR asset missing: ${relative}`);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await sharp(source)
          .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 72, mozjpeg: true })
          .toFile(target);
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  // BASE_PATH lets the same build serve from a sub-path, e.g. GitHub Pages.
  base: process.env.BASE_PATH || "/",
  server: {
    port: 5174,
    host: true,
    strictPort: true,
    allowedHosts: true, // accept tunnel hosts for phone testing
    hmr: {
      // This is the key setting for using both localhost (desktop) and the network IP (phone) at the same time.
      // It tells the HMR websocket client to always use this port, avoiding origin confusion.
      clientPort: 5174,
    },
    // On some Windows setups, polling helps file changes be picked up reliably when the server is accessed over the network.
    watch: {
      usePolling: true,
      interval: 100,
    },
  },
  plugins: [
    networkInfoPlugin(),
    ...(mode === "production" ? [runtimeAssetPackPlugin()] : []),
    ...(mode === "standalone" ? [viteSingleFile()] : []),
  ],
  build:
    mode === "standalone"
      ? { target: "esnext", outDir: "dist-standalone", copyPublicDir: false, chunkSizeWarningLimit: 20000 }
      : {
          target: "esnext",
          copyPublicDir: mode !== "production", // production uses the runtime asset pack
          rollupOptions: {
            input: {
              main: path.join(projectDir, "index.html"),
              authoring: path.join(projectDir, "authoring.html"),
            },
          },
        },
}));
