import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";
import { exports as packageExports } from "./package.json";

export default defineConfig({
  entry: Object.values(packageExports),
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
