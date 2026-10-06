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
  Anthropic: {
    dependencies: ["@anthropic-ai/sdk"],
    url: "https://platform.claude.com/llms.txt",
  },
  Mistral: {
    dependencies: ["@mistralai/mistralai"],
    url: "https://docs.mistral.ai/llms.txt",
  },
  OpenAI: {
    dependencies: ["openai"],
    url: "https://developers.openai.com/llms.txt",
  },
  OpenRouter: {
    dependencies: ["@openrouter/sdk"],
    url: "https://openrouter.ai/docs/llms.txt",
  },
  Elysia: {
    dependencies: ["elysia", "@elysia/cors", "@elysia/eden"],
    url: "https://elysiajs.com/llms.txt",
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
      "expo",
      "expo-constants",
      "expo-linking",
      "expo-router",
      "expo-status-bar",
      "expo-system-ui",
      "expo-updates",
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
      "oxc-transform-react",
      "oxfmt",
      "oxlint-tsgolint",
    ],
    markdownPages: {
      pathIncludes: "/docs/",
      rewrite: "replace-html-with-md",
    },
    url: "https://oxc.rs/llms.txt",
  },
  Streamdown: {
    dependencies: [
      "streamdown",
      "@streamdown/cjk",
      "@streamdown/math",
      "@streamdown/mermaid",
    ],
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
    dependencies: ["yjs"],
    url: "https://docs.yjs.dev/llms.txt",
  },
} as const satisfies Record<string, DocSource>;

const NO_LLMS_TXT_EXPLANATION =
  "The canonical project documentation did not publish an llms.txt endpoint when checked.";
const NO_LLMS_TXT_CHECKED_AT = "2026-09-25T00:00:00.000Z";
const NO_LLMS_TXT_EXPIRES_AT = "2026-10-25T00:00:00.000Z";

const noLlmsTxt = (dependency: string): NoLlmsTxtExclusion => ({
  checkedAt: NO_LLMS_TXT_CHECKED_AT,
  dependency,
  explanation: NO_LLMS_TXT_EXPLANATION,
  expiresAt: NO_LLMS_TXT_EXPIRES_AT,
  reason: "no-llms-txt",
});

export const DOC_SOURCE_EXCLUSIONS = [
  "@astrojs/check",
  "@astrojs/react",
  "@astrojs/sitemap",
  "@astrojs/starlight",
  "@atlaskit/pragmatic-drag-and-drop",
  "@atlaskit/pragmatic-drag-and-drop-auto-scroll",
  "@atlaskit/pragmatic-drag-and-drop-hitbox",
  "@atlaskit/pragmatic-drag-and-drop-live-region",
  "@babel/core",
  "@changesets/changelog-github",
  "@changesets/cli",
  "@electric-sql/pglite",
  "@firecrawl/anydoc",
  "@formatjs/icu-messageformat-parser",
  "@google/genai",
  "@happy-dom/global-registrator",
  "@hyzyla/pdfium",
  "@jitl/quickjs-wasmfile-release-asyncify",
  "@libpdf/core",
  "@litko/yara-x",
  "@mcp-ui/client",
  "@neftaly/editcontext-polyfill",
  "@opentelemetry/api-logs",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-logs",
  "@playwright/test",
  "@resvg/resvg-js",
  "@shadcn/lint",
  "@silurus/ooxml",
  "@sinclair/typebox",
  "@stricli/core",
  "@t3-oss/env-core",
  "@tailwindcss/vite",
  "@testing-library/dom",
  "@testing-library/react",
  "@types/chrome",
  "@types/hast",
  "@types/node",
  "@typescript/native",
  "@vscode/markdown-editor",
  "@vscode/observables",
  "astro",
  "cheerio",
  "class-variance-authority",
  "client-zip",
  "clsx",
  "cobe",
  "diff",
  "disposable-email-domains-js",
  "domhandler",
  "driver.js",
  "entities",
  "eslint",
  "expo-doctor",
  "franc",
  "happy-dom",
  "immer",
  "input-otp",
  "ioredis",
  "jose",
  "jszip",
  "katex",
  "knip",
  "lefthook",
  "nodemailer",
  "onnxruntime-node",
  "oxlint-tailwindcss",
  "pdfjs-dist",
  "postal-mime",
  "prism-react-renderer",
  "quickjs-emscripten-core",
  "re2-wasm",
  "react-native-web",
  "rollup-plugin-visualizer",
  "saxes",
  "scslre",
  "sherif",
  "slimdom",
  "squawk-cli",
  "ssf",
  "tailwind-merge",
  "tailwindcss",
  "thinking-orbs",
  "tw-animate-css",
  "typescript",
  "unified",
  "uqr",
  "use-debounce",
  "use-intl",
  "uuid",
]
  .map(noLlmsTxt)
  .concat(
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
      dependency: "@sparticuz/chromium-min",
      explanation:
        "https://raw.githubusercontent.com/Sparticuz/chromium/main/llms.txt returns 404. Use the canonical documentation at https://github.com/Sparticuz/chromium directly.",
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
      checkedAt: "2026-09-27T00:00:00.000Z",
      dependency: "mailauth",
      explanation:
        "The canonical repository has no llms.txt (raw endpoint returns 404). Use the authentication API documentation at https://github.com/postalsys/mailauth directly.",
      expiresAt: "2026-10-27T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-27T00:00:00.000Z",
      dependency: "tldts",
      explanation:
        "The canonical repository has no llms.txt (raw endpoint returns 404). Use the domain parsing API documentation at https://github.com/remusao/tldts directly.",
      expiresAt: "2026-10-27T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-27T00:00:00.000Z",
      dependency: "ajv",
      explanation:
        "https://ajv.js.org/llms.txt returns 404. Use the API reference at https://ajv.js.org/api.html and the strict-mode rules at https://ajv.js.org/strict-mode.html directly.",
      expiresAt: "2026-10-27T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-27T00:00:00.000Z",
      dependency: "ajv-formats",
      explanation:
        "The Ajv project publishes no llms.txt. Use the format list in the README at https://github.com/ajv-validator/ajv-formats directly.",
      expiresAt: "2026-10-27T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-27T00:00:00.000Z",
      dependency: "fast-xml-parser",
      explanation:
        "The project publishes no llms.txt (https://naturalintelligence.github.io/fast-xml-parser/llms.txt returns 404). Use the docs at https://github.com/NaturalIntelligence/fast-xml-parser/tree/master/docs and the typed API in its package (src/fxp.d.ts) directly.",
      expiresAt: "2026-10-27T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-26T00:00:00.000Z",
      dependency: "cldr-misc-full",
      explanation:
        "A CLDR JSON data package with no API; the Unicode CLDR project publishes no llms.txt. Use the data layout at https://github.com/unicode-org/cldr-json and the exemplar-character specification at https://unicode.org/reports/tr35/tr35-general.html#Character_Elements directly.",
      expiresAt: "2026-10-26T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-26T00:00:00.000Z",
      dependency: "asn1js",
      explanation:
        "https://asn1js.org/llms.txt returns 404 and the project publishes no other llms.txt. Use the README at https://github.com/PeculiarVentures/asn1.js and the typed API in its package directly.",
      expiresAt: "2026-10-26T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-26T00:00:00.000Z",
      dependency: "pkijs",
      explanation:
        "https://pkijs.org/llms.txt returns 404 and the project publishes no other llms.txt. Use the documentation at https://pkijs.org/docs/ and the typed API in its package directly.",
      expiresAt: "2026-10-26T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-12T00:00:00.000Z",
      dependency: "stylelint",
      explanation:
        "https://stylelint.io/llms.txt returns 404. Use https://stylelint.io/user-guide/rules/ and https://stylelint.io/user-guide/configure/ directly for the CSS correctness configuration.",
      expiresAt: "2026-10-12T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-23T00:00:00.000Z",
      dependency: "hyparquet",
      explanation:
        "https://hyparam.github.io/hyparquet/llms.txt returns 404 and the project publishes no other llms.txt. Use the README at https://github.com/hyparam/hyparquet and the typed API in its package (src/types.d.ts) directly.",
      expiresAt: "2026-10-23T00:00:00.000Z",
      reason: "no-llms-txt",
    },
    {
      checkedAt: "2026-09-08T00:00:00.000Z",
      dependency: "temporal-polyfill",
      explanation:
        "The package publishes Markdown documentation at https://github.com/fullcalendar/temporal-polyfill and API documentation at https://tc39.es/proposal-temporal/docs/, but neither publishes llms.txt. Use those canonical references directly.",
      expiresAt: "2026-10-08T00:00:00.000Z",
      reason: "no-llms-txt",
    },
  );
