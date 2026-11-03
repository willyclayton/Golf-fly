import { defineConfig } from "vite";

// Relative base so the build works both locally and under GitHub Pages' /<repo>/ path.
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 800 },
});
