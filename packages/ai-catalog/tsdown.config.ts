import path from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/benchmark-frontier.ts",
    "src/benchmarks.ts",
    "src/model-defaults-ledger.ts",
  ],
  format: ["esm"],
  platform: "neutral",
  // Many exports rely on inferred types, so tsrs emits the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: path.join(import.meta.dirname, "../../node_modules/tsrs/bin/tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
