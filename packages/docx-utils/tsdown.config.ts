import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/office-formats.ts", "src/office-metadata.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
