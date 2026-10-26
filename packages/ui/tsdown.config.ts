import { defineConfig } from "tsdown";

import { resolvePackageBinary } from "../../scripts/resolve-package-binary.ts";

export default defineConfig({
  // One output module per source module: the package.json export map names
  // each of them, and a consumer's bundler drops the ones it never imports.
  entry: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.test.{ts,tsx}",
    "!src/**/*.playwright.spec.ts",
    "!src/**/fixtures/**",
  ],
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
  // The theme is shipped as source CSS, not compiled utilities: the consumer
  // owns its own Tailwind build. tsdown does not process CSS, so the
  // stylesheets are copied verbatim.
  copy: ["src/styles"],
});
