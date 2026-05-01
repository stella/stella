import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";

const APP_ROOT = import.meta.dirname;
const ANALYZE_MODE = "analyze";

export default defineConfig(({ mode }) => {
  const shouldAnalyze = mode === ANALYZE_MODE || process.env["ANALYZE"] === "1";

  return {
    root: APP_ROOT,
    server: {
      port: 3000,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
    },
    build: {
      target: "es2025",
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (
              id.includes("node_modules/react/") ||
              id.includes("node_modules/react-dom/") ||
              id.includes("node_modules/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("node_modules/@tanstack/")) {
              return "vendor-tanstack";
            }
            if (id.includes("node_modules/@stll/anonymize-data/")) {
              return "vendor-anonymize-data";
            }
            if (id.includes("node_modules/@stll/") && id.includes("-wasm")) {
              return "wasm-vendor";
            }
            if (id.includes("node_modules/@napi-rs/wasm-runtime")) {
              return "wasm-vendor";
            }
            if (id.includes("node_modules/cytoscape")) {
              return "vendor-graphs";
            }
            if (id.includes("node_modules/@tiptap")) {
              return "vendor-editor";
            }
            return undefined;
          },
        },
      },
    },
    optimizeDeps: {
      // @stll/*-wasm packages load their .wasm binaries via
      // `new URL("./foo.wasm32-wasi.wasm", import.meta.url)`. Vite's dep
      // optimizer would rewrite that URL into .vite/deps/, where the .wasm
      // binary doesn't exist and the dev server falls back to index.html —
      // producing a WASM CompileError. Excluding them keeps the original
      // module paths intact so the relative URL resolves.
      exclude: [
        "@stll/text-search-wasm",
        "@stll/anonymize-wasm",
        "@stll/aho-corasick-wasm",
        "@stll/fuzzy-search-wasm",
        "@stll/regex-set-wasm",
      ],
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: [
        "react",
        "react-dom",
        "lucide-react",
        "zustand",
        "@tanstack/react-query",
      ],
    },
    plugins: [
      devtools({ consolePiping: { enabled: false } }),
      tailwindcss(),
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
      }),
      react(),
      babel({
        // `apps/web` imports TSX from workspace packages such as `@stll/ui`.
        // Be explicit so Babel parses TS/JSX outside the app CWD before the
        // React Compiler preset runs.
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      shouldAnalyze &&
        visualizer({
          filename: "stats.html",
          gzipSize: true,
          brotliSize: true,
        }),
    ],
  };
});
