import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";

const APP_ROOT = import.meta.dirname;
const ANALYZE_MODE = "analyze";
const APP_VERSION = readFileSync(
  resolve(APP_ROOT, "../../VERSION"),
  "utf-8",
).trim();

const readCommitSha = () => {
  const explicitSha = process.env["STELLA_COMMIT_SHA"];
  if (explicitSha) {
    return explicitSha;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(APP_ROOT, "../.."),
      encoding: "utf-8",
    }).trim();
  } catch {
    return "dev";
  }
};

const APP_COMMIT_SHA = readCommitSha();

export default defineConfig(({ mode }) => {
  const shouldAnalyze = mode === ANALYZE_MODE || process.env["ANALYZE"] === "1";

  return {
    root: APP_ROOT,
    define: {
      __APP_COMMIT_SHA__: JSON.stringify(APP_COMMIT_SHA),
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    server: {
      port: 3000,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
    },
    // Default worker output is "iife", which forbids top-level await.
    // The @stll/*-wasm packages we own emit a loader with top-level
    // `await fetch(__wasmUrl)`, so any Web Worker importing them fails
    // `vite build` with [UNSUPPORTED_FEATURE]. Switch to ES module
    // workers, which support top-level await and match the modern
    // browser target the rest of the build already assumes (es2025).
    worker: {
      format: "es",
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
      // Pre-bundle deps that are only reached behind lazy/runtime imports so
      // Vite's dep optimizer handles them during the cold pass, before any
      // navigation. Two graphs trip this:
      //
      //   1. better-auth: src/lib/auth.ts statically imports the public
      //      entrypoints, but better-auth reaches these deep subpaths only at
      //      runtime, so the crawler misses them until a protected route runs.
      //   2. @stll/folio: the document route lazy-loads it via
      //      `await import("@stll/folio")` ($viewId.document.tsx), dragging in
      //      the prosemirror family + jszip + fast-xml-parser, none of which
      //      apps/web imports statically anywhere else.
      //
      // When that discovery happens mid-session, Vite kicks off a second
      // optimize pass and forces a full-page reload ("optimized dependencies
      // changed. reloading"), and stalls in-flight module/data requests with
      // net::ERR_EMPTY_RESPONSE. In the e2e suite the reload/stall lands
      // mid-test and tears the page down before the viewer paints, producing a
      // flaky upload-docx failure (api.log is empty on these runs — the API
      // never crashes; it is purely the dev server re-optimizing). Listing the
      // deps here makes the optimizer finish them up front. Dev-only:
      // production uses Rollup and ignores optimizeDeps.
      include: [
        "@better-auth/core/env",
        "@better-auth/core/error",
        "@better-auth/core/utils/error-codes",
        "@better-auth/core/utils/string",
        "@better-fetch/fetch",
        "defu",
        "nanostores",
        "prosemirror-commands",
        "prosemirror-dropcursor",
        "prosemirror-gapcursor",
        "prosemirror-history",
        "prosemirror-keymap",
        "prosemirror-model",
        "prosemirror-state",
        "prosemirror-tables",
        "prosemirror-transform",
        "prosemirror-view",
        "jszip",
        "fast-xml-parser",
      ],
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
      tanstackStart({
        router: {
          codeSplittingOptions: {
            defaultBehavior: [
              ["component"],
              ["errorComponent"],
              ["notFoundComponent"],
              ["pendingComponent"],
            ],
          },
        },
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
