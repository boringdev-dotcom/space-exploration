import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // Three.js + Spark + WASM are heavy; raise the warning threshold so it
    // doesn't fire on every build.
    chunkSizeWarningLimit: 6000,
  },
  optimizeDeps: {
    include: ["three", "@sparkjsdev/spark"],
  },
});
