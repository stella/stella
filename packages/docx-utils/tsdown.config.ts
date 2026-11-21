import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/office-formats.ts", "src/office-metadata.ts"],
  format: ["esm"],
  platform: "neutral",
  // Isolated declarations cannot express the TaggedError base classes, so tsrs emits the declarations.
  dts: {
    generator: "tsrs",
    tsrs: {
      moduleUrl: import.meta.resolve("tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
