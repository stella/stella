import { defineConfig } from "tsdown";

export default defineConfig({
  // Keep one output module per source module: the package export map names
  // each public entry, and a view only loads the pieces it imports.
  entry: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  unbundle: true,
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
});
