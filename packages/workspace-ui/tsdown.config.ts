import { defineConfig } from "tsdown";

export default defineConfig({
  // Keep one output module per source module: the package export map names
  // each public entry, and a view only loads the pieces it imports.
  entry: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  unbundle: true,
  format: ["esm"],
  platform: "neutral",
  // Many exports rely on inferred types, so tsrs emits the declarations.
  dts: {
    generator: "tsrs",
    tsrs: {
      moduleUrl: import.meta.resolve("tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
