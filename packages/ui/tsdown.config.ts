import { defineConfig } from "tsdown";

export default defineConfig({
  // One output module per source module: the package.json export map names
  // each of them, and a consumer's bundler drops the ones it never imports.
  entry: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  unbundle: true,
  // Atlaskit's directory entry points have no package exports and are not
  // valid Node ESM specifiers. The kanban module imports its explicit CJS
  // files, so preserve those portable dependency subpaths in emitted ESM.
  deps: {
    resolveDepSubpath: false,
  },
  format: ["esm"],
  platform: "neutral",
  dts: true,
  outDir: "dist",
  clean: true,
  // The theme is shipped as source CSS, not compiled utilities: the consumer
  // owns its own Tailwind build. tsdown does not process CSS, so the
  // stylesheets are copied verbatim.
  copy: ["src/styles"],
});
