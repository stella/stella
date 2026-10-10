import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/benchmark-frontier.ts", "src/benchmarks.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
