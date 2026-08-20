import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/properties.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
