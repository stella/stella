import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";

export default defineConfig({
  entry: ["src/index.ts", "src/path.ts"],
  format: ["esm"],
  platform: "neutral",
  // tsrs keeps the doc comments on union members in the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: resolvePackageBinary(import.meta.url, "tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
