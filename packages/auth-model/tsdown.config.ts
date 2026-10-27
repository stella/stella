import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";

export default defineConfig({
  entry: ["src/contract.ts"],
  format: ["esm"],
  platform: "neutral",
  // The exported valibot schemas carry inferred types, so tsrs emits the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: resolvePackageBinary(import.meta.url, "tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
