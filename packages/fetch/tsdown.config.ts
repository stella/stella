import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/publisher.ts", "src/body-reader.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
