import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  entry: Object.values(packageJson.exports),
  deps: {
    neverBundle: ["bun", "node:path", "node:url"],
  },
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
