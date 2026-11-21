import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/path-policy.ts", "src/hydration.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: { generator: "oxc" },
  outDir: "dist",
  clean: true,
});
