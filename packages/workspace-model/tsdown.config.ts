import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/properties.ts", "src/views.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: { generator: "oxc" },
  outDir: "dist",
  clean: true,
});
