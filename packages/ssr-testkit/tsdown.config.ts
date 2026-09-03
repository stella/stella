import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/assert-document.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
