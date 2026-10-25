import path from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/path.ts"],
  format: ["esm"],
  platform: "neutral",
  // tsrs keeps the doc comments on union members in the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: path.join(import.meta.dirname, "../../node_modules/tsrs/bin/tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
