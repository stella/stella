import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/numeric-token.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
