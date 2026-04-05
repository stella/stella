import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  build: {
    target: "es2025",
  },
  optimizeDeps: {
    // @stll/*-wasm packages load their .wasm binaries via
    // `new URL("./foo.wasm32-wasi.wasm", import.meta.url)`. Vite's dep
    // optimizer would rewrite that URL into .vite/deps/, where the .wasm
    // binary doesn't exist and the dev server falls back to index.html —
    // producing a WASM CompileError. Excluding them keeps the original
    // module paths intact so the relative URL resolves.
    exclude: [
      "@stll/anonymize-wasm",
      "@stll/text-search-wasm",
      "@stll/aho-corasick-wasm",
      "@stll/fuzzy-search-wasm",
      "@stll/regex-set-wasm",
    ],
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    babel({
      // `apps/web` imports TSX from workspace packages such as `@stella/ui`.
      // Be explicit so Babel parses TS/JSX outside the app CWD before the
      // React Compiler preset runs.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
  ],
});
