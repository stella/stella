import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/benchmark-frontier.ts",
    "src/benchmarks.ts",
    "src/model-defaults-ledger.ts",
    "src/transcription.ts",
  ],
  format: ["esm"],
  platform: "neutral",
  // Many exports rely on inferred types, so tsrs emits the declarations.
  dts: {
    generator: "tsrs",
    tsrs: {
      moduleUrl: import.meta.resolve("tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
