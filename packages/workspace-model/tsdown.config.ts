import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/properties.ts", "src/views.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
