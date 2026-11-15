import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/contract.ts", "src/invitation-sections.ts"],
  format: ["esm"],
  platform: "neutral",
  // The exported valibot schemas carry inferred types, so tsrs emits the declarations.
  dts: {
    generator: "tsrs",
    tsrs: {
      moduleUrl: import.meta.resolve("tsrs"),
    },
  },
  outDir: "dist",
  clean: true,
});
