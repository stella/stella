import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/model/document.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
