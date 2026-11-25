import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // BASE_PATH lets the same build serve from a sub-path, e.g. GitHub Pages.
  base: process.env.BASE_PATH || "/",
  server: {
    port: 5174,
    host: true,          // also listen on the LAN, for testing on a phone
    strictPort: true,
  },
  build: {
    target: "esnext",    // top-level await in the entry module
    rollupOptions: {
      input: {
        main: path.join(projectDir, "index.html"),
        authoring: path.join(projectDir, "authoring.html"),
      },
    },
  },
});
