import path from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/contract.ts"],
  format: ["esm"],
  platform: "neutral",
  // The exported valibot schemas carry inferred types, so tsrs emits the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: path.join(import.meta.dirname, "../../node_modules/tsrs/bin/tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
