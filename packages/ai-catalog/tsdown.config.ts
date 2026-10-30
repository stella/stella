import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";

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
      path: resolvePackageBinary(import.meta.url, "tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
