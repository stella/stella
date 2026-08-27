import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/agent-surface.ts",
      "src/build-native-package.ts",
      "src/capabilities.ts",
      "src/constants.ts",
      "src/feedback.ts",
      "src/feedback-sanitize.ts",
      "src/native.ts",
      "src/native-node.ts",
      "src/native-runtime.ts",
    ],
    outDir: "dist",
    format: ["esm"],
    deps: { neverBundle: ["../index.cjs"] },
    dts: true,
    clean: true,
    sourcemap: true,
    hash: false,
  },
  {
    // The wasm binding is loaded at runtime from the copied `native/` asset
    // directory via a dynamic `import(new URL(...).href)`, so there is no
    // build-time dependency to keep external here.
    entry: ["src/wasm.ts", "src/capabilities.ts", "src/constants.ts"],
    tsconfig: "tsconfig.wasm.json",
    outDir: "wasm/dist",
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    hash: false,
  },
  {
    entry: ["src/vite.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    hash: false,
    deps: { neverBundle: [/^vite$/] },
  },
]);
