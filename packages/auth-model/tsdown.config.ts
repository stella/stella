import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/contract.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
