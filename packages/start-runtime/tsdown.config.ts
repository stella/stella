import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/runtime.ts"],
  deps: {
    neverBundle: ["bun", "node:path", "node:url"],
  },
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
