import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig, type Plugin, type PluginOption } from "vite";

import stllAnonymizeWasm from "@stll/anonymize-wasm/vite";

const APP_ROOT = import.meta.dirname;
const ANALYZE_MODE = "analyze";
const APP_VERSION = readFileSync(
  path.resolve(APP_ROOT, "../../VERSION"),
  "utf-8",
).trim();

const readCommitSha = () => {
  const explicitSha = process.env["STELLA_COMMIT_SHA"];
  if (explicitSha && explicitSha !== "dev") {
    return explicitSha;
  }

  const railwaySha = process.env["RAILWAY_GIT_COMMIT_SHA"];
  if (railwaySha) {
    return railwaySha;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(APP_ROOT, "../.."),
      encoding: "utf-8",
    }).trim();
  } catch {
    return explicitSha ?? "dev";
  }
};

const APP_COMMIT_SHA = readCommitSha();

// Emit a served version marker so deploy tooling can confirm which
// frontend revision a CDN origin is actually serving (the commit is
// otherwise only baked into the hashed JS bundles).
const versionManifestPlugin = (): Plugin => ({
  name: "stella-version-manifest",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "version.json",
      source: JSON.stringify({
        commit: APP_COMMIT_SHA,
        version: APP_VERSION,
      }),
    });
  },
});

// A misbehaving client console message — e.g. a warning that serializes a DOM
// node / circular React fiber, forwarded to the terminal through Vite's logger —
// can balloon the dev log to gigabytes and OOM the dev server (it has). Cap
// every logged line at the one chokepoint so no single message, from any plugin
// or component, can ever do that again.
const MAX_LOG_CHARS = 4000;
const logCapPlugin = (): Plugin => ({
  name: "stella-log-cap",
  enforce: "pre",
  configResolved(config) {
    const { logger } = config;
    const cap = (message: string) =>
      message.length > MAX_LOG_CHARS
        ? `${message.slice(0, MAX_LOG_CHARS)}… [${message.length - MAX_LOG_CHARS} chars truncated]`
        : message;
    const info = logger.info.bind(logger);
    const warn = logger.warn.bind(logger);
    const warnOnce = logger.warnOnce.bind(logger);
    const error = logger.error.bind(logger);
    logger.info = (message, options) => info(cap(message), options);
    logger.warn = (message, options) => warn(cap(message), options);
    logger.warnOnce = (message, options) => warnOnce(cap(message), options);
    logger.error = (message, options) => error(cap(message), options);
  },
});

const ensurePluginOption = (option: unknown, label: string): PluginOption => {
  if (isPluginOption(option)) {
    return option;
  }

  throw new TypeError(`Invalid Vite plugin option from ${label}`);
};

const isPluginOption = (value: unknown): value is PluginOption => {
  if (value === false || value === null || value === undefined) {
    return true;
  }

  if (isPlugin(value)) {
    return true;
  }

  if (isUnknownArray(value)) {
    return value.every(isPluginOption);
  }

  if (isPromiseLikePluginOption(value)) {
    return true;
  }

  return false;
};

const isPlugin = (value: unknown): value is Plugin => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("name" in value)) {
    return false;
  }

  return typeof value.name === "string";
};

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const isPromiseLikePluginOption = (
  value: unknown,
): value is PromiseLike<PluginOption> => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }

  if (!("then" in value)) {
    return false;
  }

  return typeof value.then === "function";
};

export default defineConfig(({ mode }) => {
  const shouldAnalyze = mode === ANALYZE_MODE || process.env["ANALYZE"] === "1";
  const plugins: PluginOption[] = [
    logCapPlugin(),
    ensurePluginOption(
      devtools({ consolePiping: { enabled: false } }),
      "@tanstack/devtools-vite",
    ),
    versionManifestPlugin(),
    // Emits @stll/anonymize-wasm's binding + glue as build assets and
    // rewrites its runtime asset URLs so `vite build` can resolve them
    // (the package computes them at runtime, which Rollup can't follow
    // statically). We never call loadPipeline()/loadDefaultPipeline()
    // (the app only builds packages in-browser from a PipelineConfig via
    // createNativePipelineFromConfig), so no bundled prepared packages
    // are needed — "none" skips emitting the ~20MB+ default/per-language
    // .stlanonpkg assets.
    ensurePluginOption(
      stllAnonymizeWasm({ packages: "none" }),
      "@stll/anonymize-wasm/vite",
    ),
    ensurePluginOption(tailwindcss(), "@tailwindcss/vite"),
    ensurePluginOption(
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
      "@tanstack/react-start",
    ),
    ensurePluginOption(react(), "@vitejs/plugin-react"),
    ensurePluginOption(
      babel({
        // `apps/web` imports TSX from workspace packages such as `@stll/ui`.
        // Be explicit so Babel parses TS/JSX outside the app CWD before the
        // React Compiler preset runs.
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      "@rolldown/plugin-babel",
    ),
    shouldAnalyze &&
      ensurePluginOption(
        visualizer({
          filename: "stats.html",
          gzipSize: true,
          brotliSize: true,
        }),
        "rollup-plugin-visualizer",
      ),
  ];

  return {
    root: APP_ROOT,
    define: {
      __APP_COMMIT_SHA__: JSON.stringify(APP_COMMIT_SHA),
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    server: {
      port: 3000,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
      // Vite's fs allowlist covers the workspace root only. When a dependency
      // is bun-linked to a local checkout (e.g. developing @stll/folio-*
      // against the app), its out-of-root source must be allowed explicitly;
      // pass the checkout root(s), colon-separated, via
      // DEV_LINKED_PACKAGE_ROOTS.
      ...(process.env["DEV_LINKED_PACKAGE_ROOTS"]
        ? {
            fs: {
              allow: [
                path.resolve(APP_ROOT, "../.."),
                ...process.env["DEV_LINKED_PACKAGE_ROOTS"].split(":"),
              ],
            },
          }
        : {}),
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
      rolldownOptions: {
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
      //   1. better-auth: src/lib/auth.ts statically imports the client
      //      entrypoints (better-auth/react + /client + /client/plugins,
      //      @better-auth/oauth-provider/client), but their runtime-only deep
      //      subpaths (e.g. the multi-tab session `broadcast-channel`) are not
      //      statically reachable, so the cold crawl misses them until a
      //      protected route actually runs the auth client. Listing the
      //      entrypoints makes the optimizer bundle their full graph up front.
      //   2. @stll/folio-react (which pulls @stll/folio-core, ~350 dist
      //      modules): its root entry is statically reachable from shared
      //      chunks (chat mention links, the AI-suggestion host) on every
      //      page, so it must stay pre-bundled. Serving it unoptimized makes
      //      every dev page load fetch hundreds of individual modules
      //      (measured in the e2e route walk: ~90 folio requests pre-bundled
      //      vs ~9,600 unoptimized, over a second of extra load per route).
      //      Trade-off: the optimizer rewrites the layout engine's
      //      `new Worker(new URL(..., import.meta.url))` to a .vite/deps path
      //      that does not exist, so in dev the font-metrics worker fails to
      //      spawn and folio silently falls back to main-thread measuring.
      //      Dev-only: the production build bundles the worker correctly.
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
        // 3. @tanstack/react-start's isomorphic-fn/server entrypoints
        //    (lib/beta-features.ts) reach these only at runtime.
        "@tanstack/history",
        "@tanstack/router-core",
        "@tanstack/router-core/ssr/client",
        "@tanstack/router-core/ssr/server",
        "h3-v2",
        "seroval",
        "@better-auth/core/env",
        "@better-auth/core/error",
        "@better-auth/core/utils/error-codes",
        "@better-auth/core/utils/string",
        "@better-auth/core/utils/url",
        "better-auth/react",
        "better-auth/client",
        "better-auth/client/plugins",
        "@better-auth/oauth-provider/client",
        "@better-fetch/fetch",
        "defu",
        "nanostores",
        "@stll/folio-react",
        "@stll/folio-react/messages",
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
        "marked",
      ],
      // @stll/*-wasm packages load their .wasm binaries via
      // `new URL("./foo.wasm32-wasi.wasm", import.meta.url)`. Vite's dep
      // optimizer would rewrite that URL into .vite/deps/, where the .wasm
      // binary doesn't exist and the dev server falls back to index.html —
      // producing a WASM CompileError. Excluding them keeps the original
      // module paths intact so the relative URL resolves.
      //
      // @stll/anonymize-wasm is excluded by its own Vite plugin (registered
      // above), which does the same thing for its napi-rs wasm32-wasip1-threads
      // binding + glue.
      exclude: [
        "@stll/text-search-wasm",
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
        "solid-js",
        "lucide-react",
        "zustand",
        "@tanstack/react-query",
      ],
    },
    plugins,
  };
});
