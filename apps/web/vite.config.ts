import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { visualizer } from "rollup-plugin-visualizer";
import {
  defineConfig,
  type Logger,
  type Plugin,
  type PluginOption,
} from "vite";

import stllAnonymizeWasm from "@stll/anonymize-wasm/vite";

import { REACT_COMPILER_OPTIONS } from "./react-compiler-options.ts";

const APP_ROOT = import.meta.dirname;
const BUN_GLOBAL_STORE_ROOT = path.resolve(
  process.env["BUN_INSTALL_CACHE_DIR"] ??
    path.join(homedir(), ".bun/install/cache"),
  "links",
);
const ANALYZE_MODE = "analyze";
export const REACT_PLUGIN_EXCLUDE = [
  /[/\\]node_modules[/\\]/u,
  // These sanctioned wrappers accept opaque callbacks and dependency arrays.
  // The compiler cannot validate their call-site dependencies, and their
  // intentional exhaustive-deps suppressions otherwise emit on every load.
  /[/\\]src[/\\]hooks[/\\]use-effect\.ts$/u,
];
const DEV_API_PROXY_PATHS = [
  "/api",
  "/v1",
  "/mcp",
  "/.well-known",
  "/health",
  "/dev-public",
  "/oauth-ui",
] as const;

export const rewriteBrowserApiPath = (requestPath: string): string => {
  if (requestPath === "/api/auth" || requestPath.startsWith("/api/auth/")) {
    return requestPath;
  }
  return requestPath.replace(/^\/api(?=\/|$)/u, "") || "/";
};
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
export const capViteLogger = (logger: Logger): void => {
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
};

const logCapPlugin = (): Plugin => ({
  name: "stella-log-cap",
  enforce: "pre",
  configResolved(config) {
    capViteLogger(config.logger);
  },
});

const ensurePluginOption = (option: unknown, label: string): PluginOption => {
  if (isPluginOption(option)) {
    return option;
  }

  throw new TypeError(`Invalid Vite plugin option from ${label}`);
};

// The exact default asset-base expression `@stll/anonymize-wasm` compiles
// into its dist entry; the package's own Vite plugin anchors on the same
// text for `vite build` rewrites.
const ANONYMIZE_WASM_ASSET_URL_BASE =
  // eslint-disable-next-line no-template-curly-in-string -- matches the literal `${NATIVE_ASSET_DIR}` text in the compiled dist entry, not an interpolation site
  "new URL(`./${NATIVE_ASSET_DIR}/`, import.meta.url)";

/**
 * Serve-mode counterpart of the `@stll/anonymize-wasm` build plugin (which
 * only runs for `vite build`). The package resolves its native assets
 * against a template-literal `new URL(..., import.meta.url)`; in dev, Vite's
 * dynamic-URL analysis expands that template into an eager
 * `import.meta.glob` over the package's whole dist directory, and the glob's
 * `*.mjs.map?import&url` entries come back as JSON — a MIME the module
 * loader rejects, which fails the wasm module graph and with it the chat
 * anonymization worker. `@vite-ignore` opts the expression out of the
 * analysis; plain runtime URL resolution works as-is under `/@fs` serving.
 */
const anonymizeWasmDevAssetBasePlugin = (): Plugin => ({
  name: "stella-anonymize-wasm-dev-asset-base",
  apply: "serve",
  enforce: "pre",
  transform(code, id) {
    const [idPath] = id.split("?");
    if (!(idPath?.includes("anonymize-wasm") && idPath.endsWith("wasm.mjs"))) {
      return null;
    }
    if (!code.includes(ANONYMIZE_WASM_ASSET_URL_BASE)) {
      this.error(
        `stella-anonymize-wasm-dev-asset-base: could not find the assetUrl base in ${id}. The @stll/anonymize-wasm dist shape changed; update ANONYMIZE_WASM_ASSET_URL_BASE.`,
      );
    }
    return {
      code: code.replace(
        ANONYMIZE_WASM_ASSET_URL_BASE,
        // eslint-disable-next-line no-template-curly-in-string -- emits the same literal template text back into the module, opted out of Vite's analysis
        "new URL(/* @vite-ignore */ `./${NATIVE_ASSET_DIR}/`, import.meta.url)",
      ),
      map: null,
    };
  },
});

const runtimeAssetPlugins = (): PluginOption[] => [
  anonymizeWasmDevAssetBasePlugin(),
  ensurePluginOption(
    stllAnonymizeWasm({ packages: "none" }),
    "@stll/anonymize-wasm/vite",
  ),
];

const pdfjsWorkerModuleContractPlugin = (): Plugin => ({
  name: "stella-pdfjs-worker-module-contract",
  renderChunk(code, chunk) {
    if (
      !chunk.isEntry ||
      !chunk.facadeModuleId
        ?.replaceAll("\\", "/")
        .endsWith("/src/lib/pdf/pdfjs-worker.ts")
    ) {
      return null;
    }

    // Vite deliberately strips exports from worker entries. PDF.js also
    // imports workerSrc as an ES module for its same-thread recovery path,
    // so restore that public contract before Rollup hashes the emitted chunk.
    return `${code}\nexport { WorkerMessageHandler };\n`;
  },
});

const workerRuntimeAssetPlugins = (): PluginOption[] => [
  ...runtimeAssetPlugins(),
  pdfjsWorkerModuleContractPlugin(),
];

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
  const devApiProxyTarget = process.env["DEV_API_PROXY_TARGET"];
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
    ...runtimeAssetPlugins(),
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
    ensurePluginOption(
      react({
        compiler: REACT_COMPILER_OPTIONS,
        exclude: REACT_PLUGIN_EXCLUDE,
      }),
      "@vitejs/plugin-react with Oxc React Compiler",
    ),
    shouldAnalyze &&
      visualizer({
        filename: "stats.html",
        gzipSize: true,
        brotliSize: true,
      }),
  ];

  return {
    root: APP_ROOT,
    define: {
      __APP_COMMIT_SHA__: JSON.stringify(APP_COMMIT_SHA),
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    server: {
      port: 3000,
      ...(devApiProxyTarget
        ? {
            proxy: Object.fromEntries(
              DEV_API_PROXY_PATHS.map((route) => [
                route,
                {
                  changeOrigin: true,
                  target: devApiProxyTarget,
                  ...(route === "/api"
                    ? {
                        rewrite: rewriteBrowserApiPath,
                      }
                    : {}),
                },
              ]),
            ),
          }
        : {}),
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
      // Vite follows package real paths when serving assets. Keep the
      // workspace, Bun's package-only global store, and explicit linked
      // checkouts inside the development filesystem boundary.
      fs: {
        allow: [
          path.resolve(APP_ROOT, "../.."),
          BUN_GLOBAL_STORE_ROOT,
          ...(process.env["DEV_LINKED_PACKAGE_ROOTS"]?.split(":") ?? []),
        ],
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
      // Worker builds have their own Vite plugin pipeline. Reuse the runtime
      // asset plugins so dependencies that rewrite and emit WASM sidecars keep
      // the same contract when they move off the main thread.
      plugins: workerRuntimeAssetPlugins,
    },
    build: {
      target: "es2025",
      // Maps are emitted for the image build to publish to the error tracker
      // and are removed before the runtime stage; `hidden` keeps the served
      // chunks free of a `sourceMappingURL` that browsers would request.
      sourcemap: "hidden",
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
            if (
              id.includes("node_modules/@tanstack/ai-react/") ||
              id.includes("node_modules/@mcp-ui/client/") ||
              id.includes("node_modules/@modelcontextprotocol/ext-apps/") ||
              id.includes("node_modules/@modelcontextprotocol/sdk/")
            ) {
              // This graph is reached only from ChatRichMessagePart's dynamic
              // import. Keep it out of the eagerly preloaded TanStack vendor
              // chunk so users without MCP App output never download it.
              return "mcp-app";
            }
            if (id.includes("node_modules/@tanstack/start-client-core/")) {
              return "vendor-tanstack-server-fn";
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
            // Icon and primitive libraries otherwise shatter into hundreds
            // of sub-KB shared chunks (one per icon / primitive module),
            // because each is shared by a different subset of route chunks.
            // A cold page load was measured issuing ~250 asset requests,
            // most of them these fragments; per-request overhead dominates
            // their transfer time. Grouping trades a small amount of eager
            // bytes (icons a given route doesn't use) for two cacheable
            // requests.
            if (id.includes("node_modules/lucide-react/")) {
              return "vendor-icons";
            }
            if (id.includes("node_modules/@base-ui/")) {
              return "vendor-base-ui";
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
        "@tanstack/router-core/isServer",
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
        // 4. Editor, chat, table, and drag-and-drop deps reached only through
        //    lazy route splits, so the cold crawl misses every one of them.
        //    Observed in a dev session as three optimize passes (and three
        //    full-page reloads) inside one minute while navigating between the
        //    chat, inspector, and document routes. Vite already pre-bundles all
        //    of these on discovery; listing them only moves that work into the
        //    cold pass.
        "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element",
        "@atlaskit/pragmatic-drag-and-drop-auto-scroll/external",
        "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge",
        "@atlaskit/pragmatic-drag-and-drop/adapter/drop-target-for-external",
        "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter",
        "@atlaskit/pragmatic-drag-and-drop/combine",
        "@atlaskit/pragmatic-drag-and-drop/element/adapter",
        "@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer",
        "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview",
        "@atlaskit/pragmatic-drag-and-drop/utils/center-under-pointer",
        "@atlaskit/pragmatic-drag-and-drop/utils/contains-files",
        "@atlaskit/pragmatic-drag-and-drop/utils/get-files",
        "@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview",
        "@base-ui/react/context-menu",
        "@base-ui/react/preview-card",
        "@base-ui/react/tabs",
        "@hocuspocus/provider",
        "@libpdf/core",
        "@stll/anonymize-data",
        "@stll/folio-agents",
        "@stll/folio-core",
        "@stll/folio-core/ai-edits",
        "@stll/folio-core/docx/documentParser",
        "@stll/folio-core/docx/serializer/paragraphSerializer",
        "@stll/folio-core/prosemirror/commands/comments",
        "@stll/folio-core/prosemirror/findReplaceSelection",
        "@stll/folio-core/utils/findReplace",
        "@streamdown/cjk",
        "@streamdown/math",
        "@streamdown/mermaid",
        "@tanstack/react-table",
        "@tanstack/react-table/static-functions",
        "@tiptap/extension-heading",
        "@tiptap/extension-italic",
        "@tiptap/extension-list",
        "diff",
        "y-prosemirror",
        "yjs",
      ],
      // @stll/*-wasm packages and @silurus/ooxml load their .wasm binaries via
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
        // Keep this worker entrypoint at its source URL. Leaving it out of
        // `include` is insufficient because Vite discovers it on first use.
        "pdfjs-dist/build/pdf.worker.mjs",
        "@silurus/ooxml",
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
