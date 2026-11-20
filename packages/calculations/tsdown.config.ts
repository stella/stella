import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "neutral",
  // tsrs keeps the doc comments on union members in the declarations.
  dts: {
    generator: "tsrs",
    tsrs: {
      moduleUrl: import.meta.resolve("tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
