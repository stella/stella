export type DocSource = {
  dependencies: readonly [string, ...string[]];
  markdownPages?: {
    pathIncludes: string;
    rewrite: "append-md" | "replace-html-with-md";
  };
  url: string;
};

export type NoLlmsTxtExclusion = {
  checkedAt: string;
  dependency: string;
  explanation: string;
  expiresAt: string;
  reason: "no-llms-txt";
};

export const DOC_SOURCES = {
  AGUI: {
    dependencies: ["@ag-ui/core"],
    url: "https://docs.ag-ui.com/llms.txt",
  },
  Zod: {
    dependencies: ["zod"],
    url: "https://zod.dev/llms.txt",
  },
  Anthropic: {
    dependencies: ["@anthropic-ai/sdk"],
    url: "https://platform.claude.com/llms.txt",
  },
  OpenAI: {
    dependencies: ["openai"],
    url: "https://developers.openai.com/llms.txt",
  },
  OpenRouter: {
    dependencies: ["@openrouter/sdk"],
    url: "https://openrouter.ai/docs/llms.txt",
  },
  Drizzle: {
    dependencies: ["drizzle-orm", "drizzle-kit"],
    url: "https://orm.drizzle.team/llms.txt",
  },
  TanStack: {
    dependencies: [
      "@tanstack/ai",
      "@tanstack/ai-anthropic",
      "@tanstack/ai-bedrock",
      "@tanstack/ai-client",
      "@tanstack/ai-code-mode",
      "@tanstack/ai-codex",
      "@tanstack/ai-gemini",
      "@tanstack/ai-mcp",
      "@tanstack/ai-mistral",
      "@tanstack/ai-openai",
      "@tanstack/ai-openrouter",
      "@tanstack/ai-persistence",
      "@tanstack/ai-react",
      "@tanstack/ai-sandbox",
      "@tanstack/charts",
      "@tanstack/devtools-vite",
      "@tanstack/eslint-plugin-router",
      "@tanstack/react-devtools",
      "@tanstack/react-form",
      "@tanstack/react-hotkeys",
      "@tanstack/react-router",
      "@tanstack/react-router-devtools",
      "@tanstack/react-table",
      "@tanstack/react-table-devtools",
      "@tanstack/react-virtual",
      "@tanstack/router-generator",
      "@tanstack/table-core",
    ],
    markdownPages: {
      pathIncludes: "/docs/",
      rewrite: "append-md",
    },
    url: "https://tanstack.com/llms.txt",
  },
  TanStackQuery: {
    dependencies: [
      "@tanstack/eslint-plugin-query",
      "@tanstack/react-query",
      "@tanstack/react-query-devtools",
      "@tanstack/react-router-ssr-query",
    ],
    markdownPages: {
      pathIncludes: "/docs/",
      rewrite: "append-md",
    },
    url: "https://tanstack.com/query/latest/llms.txt",
  },
  TanStackStart: {
    dependencies: ["@tanstack/react-start"],
    markdownPages: {
      pathIncludes: "/docs/",
      rewrite: "append-md",
    },
    url: "https://tanstack.com/start/latest/llms.txt",
  },
  React: {
    dependencies: ["react", "react-dom", "@types/react", "@types/react-dom"],
    url: "https://react.dev/llms.txt",
  },
  ReactEmail: {
    dependencies: ["@react-email/components", "@react-email/render"],
    url: "https://react.email/docs/llms.txt",
  },
  BaseUI: {
    dependencies: ["@base-ui/react"],
    url: "https://base-ui.com/llms.txt",
  },
  Valibot: {
    dependencies: ["valibot", "@valibot/to-json-schema"],
    url: "https://valibot.dev/llms.txt",
  },
  TipTap: {
    dependencies: [
      "@tiptap/core",
      "@tiptap/extension-bold",
      "@tiptap/extension-document",
      "@tiptap/extension-hard-break",
      "@tiptap/extension-heading",
      "@tiptap/extension-italic",
      "@tiptap/extension-list",
      "@tiptap/extension-mention",
      "@tiptap/extension-paragraph",
      "@tiptap/extension-text",
      "@tiptap/extensions",
      "@tiptap/pm",
      "@tiptap/react",
      "@tiptap/suggestion",
      "@hocuspocus/extension-redis",
      "@hocuspocus/provider",
      "@hocuspocus/server",
      "y-prosemirror",
    ],
    url: "https://tiptap.dev/docs/llms.txt",
  },
  Tauri: {
    dependencies: ["@tauri-apps/api", "@tauri-apps/cli"],
    url: "https://v2.tauri.app/llms.txt",
  },
  Vite: {
    dependencies: ["vite", "@vitejs/plugin-react"],
    url: "https://vite.dev/llms.txt",
  },
  Expo: {
    dependencies: [
      "@expo/fingerprint",
      "expo",
      "expo-constants",
      "expo-crypto",
      "expo-dev-client",
      "expo-doctor",
      "expo-linking",
      "expo-router",
      "expo-secure-store",
      "expo-status-bar",
      "expo-system-ui",
      "expo-updates",
      "expo-web-browser",
      "react-native-safe-area-context",
      "react-native-screens",
    ],
    url: "https://docs.expo.dev/llms.txt",
  },
  ReactNative: {
    dependencies: ["react-native"],
    url: "https://reactnative.dev/llms.txt",
  },
  MCP: {
    dependencies: [
      "@modelcontextprotocol/client",
      "@modelcontextprotocol/ext-apps",
      "@modelcontextprotocol/server",
    ],
    url: "https://modelcontextprotocol.io/llms.txt",
  },
  AWSSDK: {
    dependencies: [
      "@aws-sdk/client-bedrock-runtime",
      "@aws-sdk/client-cloudwatch",
      "@aws-sdk/client-lambda",
      "@aws-sdk/client-s3",
      "@aws-sdk/client-sesv2",
      "@aws-sdk/client-sqs",
      "@aws-sdk/client-sts",
      "@aws-sdk/s3-request-presigner",
      "@smithy/fetch-http-handler",
    ],
    url: "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/llms.txt",
  },
  Bun: {
    dependencies: ["bun-types"],
    url: "https://bun.sh/llms.txt",
  },
  BetterAuth: {
    dependencies: [
      "better-auth",
      "@better-auth/api-key",
      "@better-auth/core",
      "@better-auth/oauth-provider",
      "@better-auth/cimd",
    ],
    url: "https://better-auth.com/llms.txt",
  },
  Turborepo: {
    dependencies: ["turbo"],
    url: "https://turborepo.dev/llms.txt",
  },
  PostHog: {
    dependencies: ["posthog-js", "posthog-node"],
    url: "https://posthog.com/llms.txt",
  },
  Zustand: {
    dependencies: ["zustand"],
    url: "https://zustand.docs.pmnd.rs/llms.txt",
  },
  Oxlint: {
    dependencies: [
      "oxlint",
      "@oxlint/plugins",
      "oxc-parser",
      "oxc-transform-react",
      "oxlint-tsgolint",
    ],
    markdownPages: {
      pathIncludes: "/docs/",
      rewrite: "replace-html-with-md",
    },
    url: "https://oxc.rs/llms.txt",
  },
  Streamdown: {
    dependencies: ["streamdown", "@streamdown/cjk", "@streamdown/math"],
    url: "https://streamdown.dev/llms.txt",
  },
  BetterResult: {
    dependencies: ["better-result"],
    url: "https://better-result.dev/llms.txt",
  },
  BullMQ: {
    dependencies: ["bullmq"],
    url: "https://bullmq.io/llms.txt",
  },
  Crossws: {
    dependencies: ["crossws"],
    url: "https://crossws.h3.dev/llms.txt",
  },
  FastCheck: {
    dependencies: ["fast-check"],
    url: "https://fast-check.dev/llms.txt",
  },
  Fontsource: {
    dependencies: ["@fontsource-variable/source-serif-4"],
    url: "https://fontsource.org/llms.txt",
  },
  Lucide: {
    dependencies: ["lucide-react"],
    url: "https://lucide.dev/llms.txt",
  },
  Tsdown: {
    dependencies: ["tsdown"],
    url: "https://tsdown.dev/llms.txt",
  },
  WXT: {
    dependencies: ["wxt"],
    url: "https://wxt.dev/llms.txt",
  },
  Yjs: {
    dependencies: ["yjs", "y-protocols"],
    url: "https://docs.yjs.dev/llms.txt",
  },
  OxlintTailwind: {
    dependencies: ["oxlint-tailwindcss"],
    url: "https://oxlint-tailwindcss.pages.dev/llms.txt",
  },
  OpenTelemetry: {
    dependencies: [
      "@opentelemetry/api-logs",
      "@opentelemetry/exporter-logs-otlp-http",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-logs",
    ],
    url: "https://opentelemetry.io/llms.txt",
  },
  GeminiAPI: {
    dependencies: ["@google/genai"],
    url: "https://ai.google.dev/gemini-api/docs/llms.txt",
  },
  ClassVarianceAuthority: {
    dependencies: ["class-variance-authority"],
    url: "https://cva.style/llms.txt",
  },
  Lefthook: {
    dependencies: ["lefthook"],
    url: "https://lefthook.dev/llms.txt",
  },
} as const satisfies Record<string, DocSource>;

const NO_LLMS_TXT_CHECKED_AT = "2026-10-25T00:00:00.000Z";
const NO_LLMS_TXT_EXPIRES_AT = "2026-11-24T00:00:00.000Z";

// Probed on the check date. The waiver recheck reads the first URL, so it is
// the documentation's own llms.txt location where the project has a site.
const PROBED_WITHOUT_LLMS_TXT = [
  [
    "@astrojs/check",
    ["https://raw.githubusercontent.com/withastro/astro/HEAD/llms.txt"],
  ],
  [
    "@astrojs/react",
    [
      "https://docs.astro.build/llms.txt",
      "https://docs.astro.build/en/guides/integrations-guide/react/llms.txt",
    ],
  ],
  [
    "@astrojs/sitemap",
    [
      "https://docs.astro.build/llms.txt",
      "https://docs.astro.build/en/guides/integrations-guide/sitemap/llms.txt",
    ],
  ],
  [
    "@astrojs/starlight",
    [
      "https://starlight.astro.build/llms.txt",
      "https://starlight.astro.build/docs/llms.txt",
    ],
  ],
  // https://atlassian.design/llms.txt covers the design system components, not
  // Pragmatic drag and drop.
  [
    "@atlaskit/pragmatic-drag-and-drop",
    ["https://atlassian.design/components/pragmatic-drag-and-drop/llms.txt"],
  ],
  [
    "@atlaskit/pragmatic-drag-and-drop-auto-scroll",
    ["https://atlassian.design/components/pragmatic-drag-and-drop/llms.txt"],
  ],
  [
    "@atlaskit/pragmatic-drag-and-drop-hitbox",
    ["https://atlassian.design/components/pragmatic-drag-and-drop/llms.txt"],
  ],
  [
    "@atlaskit/pragmatic-drag-and-drop-live-region",
    ["https://atlassian.design/components/pragmatic-drag-and-drop/llms.txt"],
  ],
  [
    "@babel/core",
    [
      "https://babel.dev/llms.txt",
      "https://babel.dev/docs/en/next/babel-core/llms.txt",
    ],
  ],
  [
    "@changesets/changelog-github",
    ["https://raw.githubusercontent.com/changesets/changesets/HEAD/llms.txt"],
  ],
  [
    "@changesets/cli",
    ["https://changesets.dev/llms.txt", "https://changesets.dev/docs/llms.txt"],
  ],
  [
    "@electric-sql/pglite",
    ["https://pglite.dev/llms.txt", "https://pglite.dev/docs/llms.txt"],
  ],
  [
    "@firecrawl/anydoc",
    ["https://raw.githubusercontent.com/firecrawl/anydoc/HEAD/llms.txt"],
  ],
  [
    "@formatjs/icu-messageformat-parser",
    ["https://raw.githubusercontent.com/formatjs/formatjs/HEAD/llms.txt"],
  ],
  [
    "@happy-dom/global-registrator",
    ["https://raw.githubusercontent.com/capricorn86/happy-dom/HEAD/llms.txt"],
  ],
  [
    "@jitl/quickjs-wasmfile-release-asyncify",
    [
      "https://raw.githubusercontent.com/justjake/quickjs-emscripten/HEAD/llms.txt",
    ],
  ],
  [
    "@libpdf/core",
    ["https://libpdf.dev/llms.txt", "https://libpdf.dev/docs/llms.txt"],
  ],
  [
    "@litko/yara-x",
    ["https://raw.githubusercontent.com/cawalch/node-yara-x/HEAD/llms.txt"],
  ],
  [
    "@mcp-ui/client",
    [
      "https://mcpui.dev/llms.txt",
      "https://raw.githubusercontent.com/MCP-UI-Org/mcp-ui/HEAD/llms.txt",
    ],
  ],
  [
    "@neftaly/editcontext-polyfill",
    [
      "https://neftaly.github.io/llms.txt",
      "https://neftaly.github.io/editcontext-polyfill/llms.txt",
    ],
  ],
  [
    "@playwright/test",
    ["https://playwright.dev/llms.txt", "https://playwright.dev/docs/llms.txt"],
  ],
  [
    "@resvg/resvg-js",
    ["https://raw.githubusercontent.com/yisibl/resvg-js/HEAD/llms.txt"],
  ],
  [
    "@shadcn/lint",
    ["https://raw.githubusercontent.com/shadcn-ui/lint/HEAD/llms.txt"],
  ],
  [
    "@silurus/ooxml",
    [
      "https://ooxml.silurus.dev/llms.txt",
      "https://ooxml.silurus.dev/docs/llms.txt",
    ],
  ],
  [
    "@stricli/core",
    ["https://raw.githubusercontent.com/bloomberg/stricli/HEAD/llms.txt"],
  ],
  [
    "@t3-oss/env-core",
    ["https://raw.githubusercontent.com/t3-oss/t3-env/HEAD/llms.txt"],
  ],
  [
    "@tailwindcss/vite",
    [
      "https://tailwindcss.com/llms.txt",
      "https://tailwindcss.com/docs/llms.txt",
    ],
  ],
  [
    "@testing-library/dom",
    [
      "https://raw.githubusercontent.com/testing-library/dom-testing-library/HEAD/llms.txt",
    ],
  ],
  [
    "@testing-library/react",
    [
      "https://raw.githubusercontent.com/testing-library/react-testing-library/HEAD/llms.txt",
    ],
  ],
  [
    "@types/chrome",
    [
      "https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/HEAD/llms.txt",
    ],
  ],
  [
    "@types/hast",
    [
      "https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/HEAD/llms.txt",
    ],
  ],
  [
    "@types/node",
    [
      "https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/HEAD/llms.txt",
    ],
  ],
  [
    "@vscode/markdown-editor",
    [
      "https://raw.githubusercontent.com/microsoft/vscode-packages/HEAD/llms.txt",
    ],
  ],
  [
    "@vscode/observables",
    [
      "https://raw.githubusercontent.com/microsoft/vscode-packages/HEAD/llms.txt",
    ],
  ],
  [
    "astro",
    ["https://astro.build/llms.txt", "https://astro.build/docs/llms.txt"],
  ],
  [
    "cheerio",
    ["https://cheerio.js.org/llms.txt", "https://cheerio.js.org/docs/llms.txt"],
  ],
  [
    "client-zip",
    ["https://raw.githubusercontent.com/Touffy/client-zip/HEAD/llms.txt"],
  ],
  ["clsx", ["https://raw.githubusercontent.com/lukeed/clsx/HEAD/llms.txt"]],
  ["cobe", ["https://raw.githubusercontent.com/shuding/cobe/HEAD/llms.txt"]],
  ["diff", ["https://raw.githubusercontent.com/kpdecker/jsdiff/HEAD/llms.txt"]],
  [
    "disposable-email-domains-js",
    [
      "https://raw.githubusercontent.com/mziyut/disposable-email-domains-js/HEAD/llms.txt",
    ],
  ],
  [
    "domhandler",
    ["https://raw.githubusercontent.com/fb55/domhandler/HEAD/llms.txt"],
  ],
  [
    "driver.js",
    ["https://driverjs.com/llms.txt", "https://driverjs.com/docs/llms.txt"],
  ],
  [
    "entities",
    ["https://raw.githubusercontent.com/fb55/entities/HEAD/llms.txt"],
  ],
  [
    "eslint",
    ["https://eslint.org/llms.txt", "https://eslint.org/docs/llms.txt"],
  ],
  ["franc", ["https://raw.githubusercontent.com/wooorm/franc/HEAD/llms.txt"]],
  [
    "happy-dom",
    ["https://raw.githubusercontent.com/capricorn86/happy-dom/HEAD/llms.txt"],
  ],
  ["immer", ["https://raw.githubusercontent.com/immerjs/immer/HEAD/llms.txt"]],
  [
    "input-otp",
    [
      "https://input-otp.rodz.dev/llms.txt",
      "https://input-otp.rodz.dev/docs/llms.txt",
    ],
  ],
  [
    "ioredis",
    ["https://raw.githubusercontent.com/redis/ioredis/HEAD/llms.txt"],
  ],
  ["jose", ["https://raw.githubusercontent.com/panva/jose/HEAD/llms.txt"]],
  ["jszip", ["https://raw.githubusercontent.com/Stuk/jszip/HEAD/llms.txt"]],
  ["katex", ["https://katex.org/llms.txt", "https://katex.org/docs/llms.txt"]],
  ["knip", ["https://knip.dev/llms.txt", "https://knip.dev/docs/llms.txt"]],
  [
    "nodemailer",
    ["https://nodemailer.com/llms.txt", "https://nodemailer.com/docs/llms.txt"],
  ],
  [
    "onnxruntime-node",
    ["https://raw.githubusercontent.com/Microsoft/onnxruntime/HEAD/llms.txt"],
  ],
  [
    "parse5",
    ["https://parse5.js.org/llms.txt", "https://parse5.js.org/docs/llms.txt"],
  ],
  [
    "parse5-htmlparser2-tree-adapter",
    ["https://parse5.js.org/llms.txt", "https://parse5.js.org/docs/llms.txt"],
  ],
  [
    "pdfjs-dist",
    [
      "https://mozilla.github.io/llms.txt",
      "https://mozilla.github.io/pdf.js/llms.txt",
    ],
  ],
  [
    "postal-mime",
    [
      "https://postal-mime.postalsys.com/llms.txt",
      "https://postal-mime.postalsys.com/docs/llms.txt",
    ],
  ],
  [
    "prism-react-renderer",
    [
      "https://raw.githubusercontent.com/FormidableLabs/prism-react-renderer/HEAD/llms.txt",
    ],
  ],
  [
    "quickjs-emscripten-core",
    [
      "https://raw.githubusercontent.com/justjake/quickjs-emscripten/HEAD/llms.txt",
    ],
  ],
  [
    "re2-wasm",
    ["https://raw.githubusercontent.com/google/re2-wasm/HEAD/llms.txt"],
  ],
  [
    "react-native-web",
    [
      "https://raw.githubusercontent.com/necolas/react-native-web/HEAD/llms.txt",
    ],
  ],
  [
    "rollup-plugin-visualizer",
    [
      "https://raw.githubusercontent.com/btd/rollup-plugin-visualizer/HEAD/llms.txt",
    ],
  ],
  ["saxes", ["https://raw.githubusercontent.com/lddubeau/saxes/HEAD/llms.txt"]],
  [
    "scslre",
    ["https://raw.githubusercontent.com/RunDevelopment/scslre/HEAD/llms.txt"],
  ],
  ["sherif", ["https://raw.githubusercontent.com/QuiiBz/sherif/HEAD/llms.txt"]],
  [
    "slimdom",
    ["https://raw.githubusercontent.com/bwrrp/slimdom/HEAD/llms.txt"],
  ],
  [
    "squawk-cli",
    ["https://raw.githubusercontent.com/sbdchd/squawk/HEAD/llms.txt"],
  ],
  [
    "ssf",
    ["https://docs.sheetjs.com/llms.txt", "https://sheetjs.com/llms.txt"],
  ],
  [
    "tailwind-merge",
    ["https://raw.githubusercontent.com/dcastil/tailwind-merge/HEAD/llms.txt"],
  ],
  [
    "tailwindcss",
    [
      "https://tailwindcss.com/llms.txt",
      "https://tailwindcss.com/docs/llms.txt",
    ],
  ],
  [
    "tw-animate-css",
    [
      "https://raw.githubusercontent.com/Wombosvideo/tw-animate-css/HEAD/llms.txt",
    ],
  ],
  [
    "tsrs",
    ["https://raw.githubusercontent.com/oxc-project/tsrs/HEAD/llms.txt"],
  ],
  [
    "typescript",
    [
      "https://www.typescriptlang.org/llms.txt",
      "https://www.typescriptlang.org/docs/llms.txt",
    ],
  ],
  [
    "typescript6",
    [
      "https://www.typescriptlang.org/llms.txt",
      "https://raw.githubusercontent.com/microsoft/TypeScript/HEAD/llms.txt",
    ],
  ],
  [
    "unified",
    ["https://unifiedjs.com/llms.txt", "https://unifiedjs.com/docs/llms.txt"],
  ],
  ["uqr", ["https://raw.githubusercontent.com/unjs/uqr/HEAD/llms.txt"]],
  [
    "use-debounce",
    ["https://raw.githubusercontent.com/xnimorz/use-debounce/HEAD/llms.txt"],
  ],
  [
    "use-intl",
    ["https://next-intl.dev/llms.txt", "https://next-intl.dev/docs/llms.txt"],
  ],
  ["uuid", ["https://raw.githubusercontent.com/uuidjs/uuid/HEAD/llms.txt"]],
  [
    "xmllint-wasm",
    ["https://raw.githubusercontent.com/noppa/xmllint-wasm/HEAD/llms.txt"],
  ],
] as const satisfies readonly (readonly [
  string,
  readonly [string, ...string[]],
])[];

const noLlmsTxt = ([dependency, urls]: readonly [
  string,
  readonly string[],
]): NoLlmsTxtExclusion => ({
  checkedAt: NO_LLMS_TXT_CHECKED_AT,
  dependency,
  explanation: `${urls.join(" and ")} ${urls.length === 1 ? "returns" : "return"} no llms.txt. Use the project's own documentation directly.`,
  expiresAt: NO_LLMS_TXT_EXPIRES_AT,
  reason: "no-llms-txt",
});

export const DOC_SOURCE_EXCLUSIONS = PROBED_WITHOUT_LLMS_TXT.map(
  noLlmsTxt,
).concat(
  ...[
    "prosemirror-commands",
    "prosemirror-dropcursor",
    "prosemirror-gapcursor",
    "prosemirror-history",
    "prosemirror-inputrules",
    "prosemirror-keymap",
    "prosemirror-model",
    "prosemirror-state",
    "prosemirror-tables",
    "prosemirror-transform",
    "prosemirror-view",
  ].map(
    (dependency) =>
      ({
        checkedAt: "2026-10-15T00:00:00.000Z",
        dependency,
        explanation:
          "https://prosemirror.net/llms.txt and https://prosemirror.net/docs/llms.txt return 404. Use the official guide and package API reference at https://prosemirror.net/docs/ directly.",
        expiresAt: "2026-11-14T00:00:00.000Z",
        reason: "no-llms-txt",
      }) satisfies NoLlmsTxtExclusion,
  ),
  {
    checkedAt: "2026-10-24T00:00:00.000Z",
    dependency: "@noble/hashes",
    explanation:
      "The repository's https://raw.githubusercontent.com/paulmillr/noble-hashes/main/llms.txt returns 404. Use the official README and API declarations at https://github.com/paulmillr/noble-hashes directly; the shared SHA-256 owner uses create(), update() and digest() for bounded browser Blob hashing.",
    expiresAt: "2026-11-23T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-20T00:00:00.000Z",
    dependency: "lzma1",
    explanation:
      "https://xseman.github.io/lzma1/llms.txt and the repository's llms.txt return 404. Use the README and type declarations at https://github.com/xseman/lzma1 directly; PAY by square uses only compress() with explicit lc/lp/pb/dictSize options.",
    expiresAt: "2026-11-19T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-24T00:00:00.000Z",
    dependency: "bysquare",
    explanation:
      "https://raw.githubusercontent.com/xseman/bysquare/master/llms.txt and the typescript/llms.txt path return 404. Use the TypeScript README and API declarations at https://github.com/xseman/bysquare/tree/master/typescript directly; the package is used only as an independent PAY by square decoder in tests.",
    expiresAt: "2026-11-23T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-25T00:00:00.000Z",
    dependency: "@embedpdf/pdfium",
    explanation:
      "https://www.embedpdf.com/llms.txt returns no llms.txt. The package ships no llms.txt and its README links none. The functions it wraps are PDFium's public C API; read the headers at https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/ directly.",
    expiresAt: "2026-11-16T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-25T00:00:00.000Z",
    dependency: "@types/emscripten",
    explanation:
      "https://emscripten.org/llms.txt returns no llms.txt. Type declarations for the Emscripten runtime that @embedpdf/pdfium's module extends; they have no documentation site of their own. Use the Emscripten API reference at https://emscripten.org/docs/api_reference/ and the declarations directly.",
    expiresAt: "2026-11-16T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-13T00:00:00.000Z",
    dependency: "@myriaddreamin/typst-ts-renderer",
    explanation:
      "https://myriad-dreamin.github.io/typst.ts/llms.txt and https://typst.app/llms.txt return 404. Use the typst.ts guide at https://myriad-dreamin.github.io/typst.ts/cookery/ and the Typst reference at https://typst.app/docs/ directly.",
    expiresAt: "2026-11-12T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-13T00:00:00.000Z",
    dependency: "@myriaddreamin/typst-ts-web-compiler",
    explanation:
      "https://myriad-dreamin.github.io/typst.ts/llms.txt and https://typst.app/llms.txt return 404. Use the typst.ts guide at https://myriad-dreamin.github.io/typst.ts/cookery/ and the Typst reference at https://typst.app/docs/ directly.",
    expiresAt: "2026-11-12T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-19T00:00:00.000Z",
    dependency: "pele",
    explanation:
      "https://pele.run/llms.txt and https://raw.githubusercontent.com/obsidianmd/pele/main/llms.txt return 404. Use the documentation at https://pele.run and the README at https://github.com/obsidianmd/pele#readme directly.",
    expiresAt: "2026-11-18T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-11T00:00:00.000Z",
    dependency: "shell-quote",
    explanation:
      "https://raw.githubusercontent.com/ljharb/shell-quote/main/llms.txt returns 404. Use the canonical package README at https://github.com/ljharb/shell-quote#readme directly.",
    expiresAt: "2026-11-10T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-07T00:00:00.000Z",
    dependency: "@gdp-ts/core",
    explanation:
      "https://raw.githubusercontent.com/rauchg/gdp-ts/HEAD/llms.txt returns 404. Use the package README at https://github.com/rauchg/gdp-ts#readme directly.",
    expiresAt: "2026-11-06T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "d3-scale",
    explanation:
      "https://d3js.org/llms.txt returns 404. Use the official scale API reference at https://d3js.org/d3-scale directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "@types/d3-scale",
    explanation:
      "Type declarations for d3-scale have no separate documentation site. https://d3js.org/llms.txt returns 404; use https://d3js.org/d3-scale and the declarations in @types/d3-scale directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "@tailwindcss/postcss",
    explanation:
      "https://tailwindcss.com/llms.txt returns 404. Use the PostCSS installation guide at https://tailwindcss.com/docs/installation/using-postcss directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "playwright-core",
    explanation:
      "https://playwright.dev/llms.txt returns 404. Use the canonical documentation at https://playwright.dev/docs/api/class-browser directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "postcss",
    explanation:
      "https://postcss.org/llms.txt returns 404. Use the API reference at https://postcss.org/api/ directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "@sparticuz/chromium-min",
    explanation:
      "https://raw.githubusercontent.com/Sparticuz/chromium/main/llms.txt returns 404. Use the canonical documentation at https://github.com/Sparticuz/chromium directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "mdast-util-from-markdown",
    explanation:
      "https://unifiedjs.com/llms.txt and the canonical repository's raw llms.txt endpoint return 404. Use the parser API at https://github.com/syntax-tree/mdast-util-from-markdown directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "mdast-util-gfm",
    explanation:
      "https://unifiedjs.com/llms.txt and the canonical repository's raw llms.txt endpoint return 404. Use the GFM tree extension API at https://github.com/syntax-tree/mdast-util-gfm directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-06T00:00:00.000Z",
    dependency: "micromark-extension-gfm",
    explanation:
      "https://unifiedjs.com/llms.txt and the canonical repository's raw llms.txt endpoint return 404. Use the GFM syntax extension API at https://github.com/micromark/micromark-extension-gfm directly.",
    expiresAt: "2026-11-05T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-09-30T00:00:00.000Z",
    dependency: "@standard-schema/spec",
    explanation:
      "https://standardschema.dev/llms.txt returns 404. Use the specification at https://standardschema.dev and the typed interfaces in @standard-schema/spec directly.",
    expiresAt: "2026-10-30T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "mailauth",
    explanation:
      "https://raw.githubusercontent.com/postalsys/mailauth/HEAD/llms.txt returns no llms.txt. The canonical repository has no llms.txt (raw endpoint returns 404). Use the authentication API documentation at https://github.com/postalsys/mailauth directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-25T00:00:00.000Z",
    dependency: "linkify-it",
    explanation:
      "https://markdown-it.github.io/linkify-it/llms.txt returns no llms.txt. The canonical raw repository and documentation-site llms.txt endpoints return 404. Use the API reference at https://markdown-it.github.io/linkify-it/ and repository documentation at https://github.com/markdown-it/linkify-it directly.",
    expiresAt: "2026-11-13T04:36:26.734Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "tldts",
    explanation:
      "https://raw.githubusercontent.com/remusao/tldts/HEAD/llms.txt returns no llms.txt. The canonical repository has no llms.txt (raw endpoint returns 404). Use the domain parsing API documentation at https://github.com/remusao/tldts directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "ajv",
    explanation:
      "https://ajv.js.org/llms.txt returns 404. Use the API reference at https://ajv.js.org/api.html and the strict-mode rules at https://ajv.js.org/strict-mode.html directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "ajv-formats",
    explanation:
      "https://ajv.js.org/llms.txt returns no llms.txt. The Ajv project publishes no llms.txt. Use the format list in the README at https://github.com/ajv-validator/ajv-formats directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "fast-xml-parser",
    explanation:
      "The project publishes no llms.txt (https://naturalintelligence.github.io/fast-xml-parser/llms.txt returns 404). Use the docs at https://github.com/NaturalIntelligence/fast-xml-parser/tree/master/docs and the typed API in its package (src/fxp.d.ts) directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "cldr-misc-full",
    explanation:
      "https://cldr.unicode.org/llms.txt, https://www.unicode.org/llms.txt and the repository llms.txt at https://raw.githubusercontent.com/unicode-org/cldr-json/HEAD/llms.txt return 404. A CLDR JSON data package with no API; the Unicode CLDR project publishes no llms.txt. Use the data layout at https://github.com/unicode-org/cldr-json and the exemplar-character specification at https://unicode.org/reports/tr35/tr35-general.html#Character_Elements directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "asn1js",
    explanation:
      "https://asn1js.org/llms.txt, https://asn1js.org/llms-full.txt, https://asn1js.org/docs/llms.txt and the repository llms.txt return 404; the project publishes no llms.txt. Use the documentation at https://asn1js.org/docs/api/, the README at https://github.com/PeculiarVentures/ASN1.js and the typed API in its package directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-26T00:00:00.000Z",
    dependency: "pkijs",
    explanation:
      "https://pkijs.org/llms.txt, https://pkijs.org/llms-full.txt, https://pkijs.org/docs/llms.txt and the repository llms.txt return 404; the project publishes no llms.txt. Use the documentation at https://pkijs.org/docs/installation and https://pkijs.org/docs/api/ and the typed API in its package directly.",
    expiresAt: "2026-11-25T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-08T00:00:00.000Z",
    dependency: "stylelint",
    explanation:
      "https://stylelint.io/llms.txt returns 404. Use https://stylelint.io/user-guide/rules/ and https://stylelint.io/user-guide/configure/ directly for the CSS correctness configuration.",
    expiresAt: "2026-11-07T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-13T00:00:00.000Z",
    dependency: "isbot",
    explanation:
      "https://raw.githubusercontent.com/omrilotan/isbot/main/llms.txt returns 404 and https://isbot.js.org/llms.txt returns 404. Use the canonical README at https://github.com/omrilotan/isbot#readme directly.",
    expiresAt: "2026-11-12T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-23T00:00:00.000Z",
    dependency: "hyparquet",
    explanation:
      "https://hyparam.github.io/hyparquet/llms.txt returns 404 and the project publishes no other llms.txt. Use the README at https://github.com/hyparam/hyparquet and the typed API in its package (src/types.d.ts) directly.",
    expiresAt: "2026-11-22T00:00:00.000Z",
    reason: "no-llms-txt",
  },
  {
    checkedAt: "2026-10-25T00:00:00.000Z",
    dependency: "temporal-polyfill",
    explanation:
      "https://raw.githubusercontent.com/fullcalendar/temporal-polyfill/HEAD/llms.txt returns no llms.txt. The package publishes Markdown documentation at https://github.com/fullcalendar/temporal-polyfill and API documentation at https://tc39.es/proposal-temporal/docs/, but neither publishes llms.txt. Use those canonical references directly.",
    expiresAt: "2026-11-07T00:00:00.000Z",
    reason: "no-llms-txt",
  },
);
