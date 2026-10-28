import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const engineSourcePath = fileURLToPath(
  new URL("src/scan-engine.ts", import.meta.url),
).replaceAll("\\", "/");

export default defineConfig({
  // The source URL stays resolvable by workspace consumers; only this build
  // changes its extension to the worker entry emitted beside the engine.
  plugins: [
    {
      name: "scan-engine-worker-url",
      transform(code, id) {
        if (id.replaceAll("\\", "/") !== engineSourcePath) {
          return null;
        }
        const workerUrl =
          /new URL\(\s*(["'])scan-engine\.worker\.ts\1\s*,\s*import\.meta\.url\s*\)/u;
        if (!workerUrl.test(code)) {
          this.error(
            "The scan engine source must reference its TypeScript worker URL",
          );
        }
        return code.replace(workerUrl, (url) =>
          url.replace("scan-engine.worker.ts", "scan-engine.worker.js"),
        );
      },
    },
  ],
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
