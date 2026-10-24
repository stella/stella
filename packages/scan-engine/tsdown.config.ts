import { defineConfig } from "tsdown";

export default defineConfig({
  // scan-engine.ts spawns the worker by URL (`./scan-engine.worker.js`), so
  // the worker is an entry of its own and lands beside the main entry.
  entry: [
    "src/scan-engine.ts",
    "src/scan-engine.worker.ts",
    "src/review.ts",
    "src/types.ts",
  ],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
  // The wasm-bindgen glue ships unchanged in `generated/`, a sibling of both
  // `src/` and `dist/`, so the unbundled import and the
  // `../generated/scan_engine_bg.wasm` URL resolve the same from either.
  deps: { neverBundle: [/\/generated\/scan_engine\.js$/u] },
});
