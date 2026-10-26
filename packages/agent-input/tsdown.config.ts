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
  dts: true,
  outDir: "dist",
  clean: true,
});
