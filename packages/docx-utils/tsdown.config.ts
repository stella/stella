import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";

export default defineConfig({
  entry: ["src/index.ts", "src/office-formats.ts", "src/office-metadata.ts"],
  format: ["esm"],
  platform: "neutral",
  // Isolated declarations cannot express the TaggedError base classes, so tsrs emits the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: resolvePackageBinary(import.meta.url, "tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
