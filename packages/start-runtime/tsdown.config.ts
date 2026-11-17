import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/runtime.ts", "src/local-module-loader.ts"],
  deps: {
    neverBundle: ["bun", "node:path", "node:url"],
  },
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
