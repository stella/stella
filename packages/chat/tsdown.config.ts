import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";

export default defineConfig({
  entry: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  unbundle: true,
  format: ["esm"],
  platform: "neutral",
  // Many exports rely on inferred types, so tsrs emits the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: resolvePackageBinary(import.meta.url, "tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
