import path from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/country.ts",
    "src/date-value.ts",
    "src/locale.ts",
    "src/numeric-token.ts",
    "src/string-list.ts",
  ],
  format: ["esm"],
  platform: "neutral",
  // Isolated declarations cannot express the TaggedError base classes, so tsrs emits the declarations.
  dts: {
    generator: "tsgo",
    tsgo: {
      path: path.join(import.meta.dirname, "../../node_modules/tsrs/bin/tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
