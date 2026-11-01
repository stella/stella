import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/load.ts",
    "src/selection.ts",
    "src/nodes.ts",
    "src/bounded.ts",
    "src/email.ts",
  ],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
