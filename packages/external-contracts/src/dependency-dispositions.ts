// The closed dependency partition: every declared dependency name is assigned either to an external contract SDK or this in-process ledger.
// Keep reasons specific to each package role; the guard enforces the key set against manifests and the root catalog.
export const IN_PROCESS_DEPENDENCIES = {
  "@ag-ui/core": "Agent UI event types and protocol data structures.",
  "@astrojs/check": "Astro build or site integration tooling.",
  "@astrojs/react": "Astro build or site integration tooling.",
  "@astrojs/sitemap": "Astro build or site integration tooling.",
  "@astrojs/starlight": "Astro build or site integration tooling.",
  "@atlaskit/pragmatic-drag-and-drop":
    "Drag-and-drop UI behavior running in the browser.",
  "@atlaskit/pragmatic-drag-and-drop-auto-scroll":
    "Drag-and-drop UI behavior running in the browser.",
  "@atlaskit/pragmatic-drag-and-drop-hitbox":
    "Drag-and-drop UI behavior running in the browser.",
  "@atlaskit/pragmatic-drag-and-drop-live-region":
    "Drag-and-drop UI behavior running in the browser.",
  "@babel/core":
    "In-process application, platform, schema, or development utility; see its package role in the consuming workspace.",
  "@base-ui/react": "Accessible UI primitives rendered by the application.",
  "@changesets/cli": "Release and changelog automation tooling.",
  "@electric-sql/pglite":
    "Embedded PostgreSQL-compatible database used locally for development or tests.",
  "@elysia/cors":
    "Local Elysia HTTP server middleware or typed client helpers.",
  "@elysia/eden":
    "Local Elysia HTTP server middleware or typed client helpers.",
  "@firecrawl/anydoc":
    "Local document parsing library; hosted OCR is an explicit optional mode.",
  "@fontsource-variable/source-serif-4":
    "Static font assets bundled with the application.",
  "@formatjs/icu-messageformat-parser":
    "Locale message parsing utility used during formatting.",
  "@gdp-ts/core": "Local document processing utility.",
  "@embedpdf/pdfium":
    "Local PDFium WebAssembly runtime used for in-process document rendering.",
  "@happy-dom/global-registrator": "DOM test environment registration.",
  "@hocuspocus/server":
    "Collaboration server framework; this package hosts the service rather than acting as a remote client.",
  "@jitl/quickjs-wasmfile-release-asyncify":
    "Local PDFium runtime and WASM assets for document processing.",
  "@libpdf/core": "Local PDF reading and writing library.",
  "@litko/yara-x": "Local YARA-X bindings for content scanning.",
  "@mcp-ui/client": "MCP extension UI renderer running in the client.",
  "@modelcontextprotocol/ext-apps":
    "MCP server or UI protocol support used in-process; remote MCP client is separately inventoried.",
  "@modelcontextprotocol/server":
    "MCP server or UI protocol support used in-process; remote MCP client is separately inventoried.",
  "@myriaddreamin/typst-ts-renderer":
    "Local WebAssembly document rendering for Typst invoice output.",
  "@myriaddreamin/typst-ts-web-compiler":
    "Local WebAssembly compilation of Typst invoice templates.",
  "@neftaly/editcontext-polyfill":
    "Browser editor compatibility and document model utilities.",
  "@opentelemetry/api-logs":
    "Telemetry API or resource configuration; exporter and SDK transport are separately inventoried.",
  "@opentelemetry/resources":
    "Telemetry API or resource configuration; exporter and SDK transport are separately inventoried.",
  "@oxlint/plugins": "Lint plugin used only by repository tooling.",
  "@playwright/test": "Browser automation test tooling.",
  "@react-email/components":
    "Email template rendering components; delivery is handled by the SMTP integration.",
  "@react-email/render":
    "Email template rendering components; delivery is handled by the SMTP integration.",
  "@resvg/resvg-js": "Local SVG rasterization utility.",
  "@shadcn/lint": "Lint plugin used only by repository tooling.",
  "@silurus/ooxml": "Local OOXML document parsing and serialization.",
  "@sinclair/typebox": "Schema/type interoperability utility used in-process.",
  "@sparticuz/chromium-min":
    "Bundled Chromium runtime used by local server-side rendering.",
  "@standard-schema/spec":
    "Schema/type interoperability utility used in-process.",
  "@stll/aho-corasick":
    "In-process string matching library used by local text analysis.",
  "@stll/aho-corasick-wasm":
    "WebAssembly bindings for in-process Aho-Corasick text matching.",
  "@stll/agent-engine":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/agent-input":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/ai-catalog":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/analytics-config":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/anonymize":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/anonymize-chat":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/anonymize-data":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/anonymize-wasm":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/api":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/api-client":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/api-contract":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/auth-model":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/boe":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/business-registries":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/calculations":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/catalogue":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/chat":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/chat-limits":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/cli":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/clipboard":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/collation":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/concurrency":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/conditions":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/country-codes":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/db-load-gate":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/decision-reader":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/docx-core":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/docx-utils":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/errors":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/fetch":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/folio-agents":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/folio-core":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/folio-react":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/fuzzy-search":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/infosoud":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/invoicing":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/legal-ast":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/legal-atlas":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/locales":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/mcp-apps":
    "Local MCP app frontends and protocol UI; outbound upload runtimes are inventoried separately.",
  "@stll/mojibake":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/money":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/oxlint-config":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/permissions":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/playwright-tools":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/portable-path":
    "Workspace helpers for portable path identifiers and local filesystem containment.",
  "@stll/property-testing":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/regex-set":
    "In-process regular-expression set matching for local text analysis.",
  "@stll/regex-set-wasm":
    "WebAssembly bindings for in-process regular-expression set matching.",
  "@stll/redis-config":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/runtime-mode":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/sanctions":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/scan-engine":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/scripts":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/sha256":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/skills":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/ssr-kit":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/ssr-testkit":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/stable-stringify":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/start-runtime":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/stdnum":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/template-conditions":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/template-packs":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/test-kit":
    "Workspace package used as an internal test utility; implementation stays within the monorepo.",
  "@stll/text-normalize":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/time":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/transactional":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/typescript-config":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/ui":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/user-agent":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/uuid-codec":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@stll/workspace-ui":
    "Workspace package used as an internal module; implementation stays within the monorepo.",
  "@streamdown/cjk": "Markdown rendering plugin executed in the UI.",
  "@streamdown/math": "Markdown rendering plugin executed in the UI.",
  "@streamdown/mermaid": "Markdown rendering plugin executed in the UI.",
  "@stricli/core": "CLI command framework running locally.",
  "@t3-oss/env-core":
    "In-process application, platform, schema, or development utility; see its package role in the consuming workspace.",
  "@tailwindcss/postcss": "CSS build-time integration for Tailwind.",
  "@tailwindcss/vite": "CSS build-time integration for Tailwind.",
  "@tanstack/ai-client":
    "AI framework integration or local orchestration layer; network provider clients are separately inventoried.",
  "@tanstack/ai-code-mode":
    "AI framework integration or local orchestration layer; network provider clients are separately inventoried.",
  "@tanstack/ai-codex":
    "AI framework integration or local orchestration layer; network provider clients are separately inventoried.",
  "@tanstack/ai-persistence":
    "AI framework integration or local orchestration layer; network provider clients are separately inventoried.",
  "@tanstack/ai-react":
    "AI framework integration or local orchestration layer; network provider clients are separately inventoried.",
  "@tanstack/ai-sandbox":
    "AI framework integration or local orchestration layer; network provider clients are separately inventoried.",
  "@tanstack/charts":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/devtools-vite":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/eslint-plugin-query":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/eslint-plugin-router":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-devtools":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-form":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-hotkeys":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-query":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-query-devtools":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-router":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-router-devtools":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-router-ssr-query":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-start":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-table":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-table-devtools":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/react-virtual":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/router-generator":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tanstack/table-core":
    "Application UI, routing, query, table, chart, or developer-tooling library.",
  "@tauri-apps/api":
    "In-process application, platform, schema, or development utility; see its package role in the consuming workspace.",
  "@tauri-apps/cli":
    "In-process application, platform, schema, or development utility; see its package role in the consuming workspace.",
  "@testing-library/dom": "Test-only DOM or component interaction utilities.",
  "@testing-library/react": "Test-only DOM or component interaction utilities.",
  "@tiptap/core":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-bold":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-document":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-hard-break":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-heading":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-italic":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-list":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-mention":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-paragraph":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extension-text":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/extensions":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/pm":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/react":
    "Rich-text editor extension or editor integration executed in the application.",
  "@tiptap/suggestion":
    "Rich-text editor extension or editor integration executed in the application.",
  "@types/chrome":
    "Type declarations or compiler support; no runtime client is instantiated.",
  "@types/d3-scale":
    "Type declarations or compiler support; no runtime client is instantiated.",
  "@types/emscripten":
    "Compile-time declarations for locally executed Emscripten modules.",
  "@types/hast":
    "Type declarations or compiler support; no runtime client is instantiated.",
  "@types/node":
    "Type declarations or compiler support; no runtime client is instantiated.",
  "@types/react":
    "Type declarations or compiler support; no runtime client is instantiated.",
  "@types/react-dom":
    "Type declarations or compiler support; no runtime client is instantiated.",
  "@typescript/native":
    "Type declarations or compiler support; no runtime client is instantiated.",
  "@valibot/to-json-schema":
    "Schema conversion utility for in-process validation schemas.",
  "@vitejs/plugin-react": "Vite build plugin.",
  "@vscode/markdown-editor":
    "Editor document and observable model libraries used locally.",
  "@vscode/observables":
    "Editor document and observable model libraries used locally.",
  ajv: "In-process application utility, validation, formatting, or UI component.",
  "ajv-formats":
    "In-process application utility, validation, formatting, or UI component.",
  asn1js:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  astro: "Repository or application build, validation, or release tooling.",
  "better-result":
    "In-process application utility, validation, formatting, or UI component.",
  "bun-types":
    "Type declarations or compiler support; no runtime client is instantiated.",
  cheerio:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "class-variance-authority":
    "In-process application utility, validation, formatting, or UI component.",
  "cldr-misc-full":
    "In-process application utility, validation, formatting, or UI component.",
  "client-zip":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  clsx: "In-process application utility, validation, formatting, or UI component.",
  cobe: "In-process application utility, validation, formatting, or UI component.",
  crossws:
    "Server-side HTTP or WebSocket framework; it accepts inbound traffic.",
  "d3-scale":
    "Repository tooling or local application library; no remote service client role identified.",
  diff: "In-process application utility, validation, formatting, or UI component.",
  "disposable-email-domains-js":
    "In-process application utility, validation, formatting, or UI component.",
  domhandler:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "driver.js":
    "In-process application utility, validation, formatting, or UI component.",
  "drizzle-kit":
    "Repository or application build, validation, or release tooling.",
  "drizzle-orm":
    "Database query or embedded database tooling; remote database connection is tracked separately.",
  elysia:
    "Server-side HTTP or WebSocket framework; it accepts inbound traffic.",
  entities:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  eslint: "Repository or application build, validation, or release tooling.",
  expo: "Repository or application build, validation, or release tooling.",
  "expo-constants": "Application runtime and platform UI APIs.",
  "expo-doctor":
    "Repository or application build, validation, or release tooling.",
  "expo-linking": "Application runtime and platform UI APIs.",
  "expo-router": "Application runtime and platform UI APIs.",
  "expo-status-bar": "Application runtime and platform UI APIs.",
  "expo-system-ui": "Application runtime and platform UI APIs.",
  "expo-updates": "Application runtime and platform UI APIs.",
  "fast-check": "Test or browser automation tooling.",
  "fast-xml-parser":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  franc:
    "In-process application utility, validation, formatting, or UI component.",
  "happy-dom": "Test or browser automation tooling.",
  hyparquet:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  immer:
    "In-process application utility, validation, formatting, or UI component.",
  "linkify-it": "Local URL detection and parsing utility.",
  "input-otp":
    "In-process application utility, validation, formatting, or UI component.",
  isbot: "Local user-agent classification for server-side rendering.",
  jszip:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  katex:
    "In-process application utility, validation, formatting, or UI component.",
  knip: "Repository or application build, validation, or release tooling.",
  lefthook: "Repository or application build, validation, or release tooling.",
  "lucide-react":
    "In-process application utility, validation, formatting, or UI component.",
  "mdast-util-from-markdown":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "mdast-util-gfm":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "micromark-extension-gfm":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "onnxruntime-node":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "oxc-transform-react":
    "Repository tooling or local application library; no remote service client role identified.",
  oxfmt: "Repository or application build, validation, or release tooling.",
  oxlint: "Repository or application build, validation, or release tooling.",
  "oxlint-tailwindcss":
    "Repository or application build, validation, or release tooling.",
  "oxlint-tsgolint":
    "Repository or application build, validation, or release tooling.",
  "pdfjs-dist":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  pkijs:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "playwright-core": "Test or browser automation tooling.",
  "prosemirror-commands": "In-process rich-text editor commands.",
  "prosemirror-dropcursor": "In-process rich-text editor drop-cursor UI.",
  "prosemirror-gapcursor": "In-process rich-text editor gap-cursor UI.",
  "prosemirror-history": "In-process rich-text editor undo history.",
  "prosemirror-inputrules": "In-process rich-text editor input rules.",
  "prosemirror-keymap": "In-process rich-text editor keyboard bindings.",
  "prosemirror-model": "In-process rich-text editor document model.",
  "prosemirror-state": "In-process rich-text editor state management.",
  "prosemirror-tables": "In-process rich-text editor table support.",
  "prosemirror-transform": "In-process rich-text document transforms.",
  "prosemirror-view": "In-process rich-text editor rendering.",
  "postal-mime":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  postcss:
    "Repository tooling or local application library; no remote service client role identified.",
  "prism-react-renderer":
    "In-process application utility, validation, formatting, or UI component.",
  "quickjs-emscripten-core":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "re2-wasm":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  react: "Application runtime and platform UI APIs.",
  "react-dom": "Application runtime and platform UI APIs.",
  "react-native": "Application runtime and platform UI APIs.",
  "react-native-safe-area-context": "Application runtime and platform UI APIs.",
  "react-native-screens": "Application runtime and platform UI APIs.",
  "react-native-web": "Application runtime and platform UI APIs.",
  "rollup-plugin-visualizer":
    "Repository or application build, validation, or release tooling.",
  saxes:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  scslre:
    "Repository tooling or local application library; no remote service client role identified.",
  "shell-quote": "Local shell argument parsing for lint-runner validation.",
  sherif: "Repository or application build, validation, or release tooling.",
  slimdom:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  "squawk-cli":
    "Repository or application build, validation, or release tooling.",
  ssf: "In-process application utility, validation, formatting, or UI component.",
  streamdown:
    "In-process application utility, validation, formatting, or UI component.",
  stylelint: "Repository or application build, validation, or release tooling.",
  "tailwind-merge":
    "In-process application utility, validation, formatting, or UI component.",
  tailwindcss:
    "Repository tooling or local application library; no remote service client role identified.",
  "temporal-polyfill":
    "In-process application utility, validation, formatting, or UI component.",
  tldts:
    "In-process application utility, validation, formatting, or UI component.",
  tsdown: "Repository or application build, validation, or release tooling.",
  turbo: "Repository or application build, validation, or release tooling.",
  "tw-animate-css":
    "In-process application utility, validation, formatting, or UI component.",
  typescript:
    "Repository or application build, validation, or release tooling.",
  unified:
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  uqr: "In-process application utility, validation, formatting, or UI component.",
  "use-debounce":
    "In-process application utility, validation, formatting, or UI component.",
  "use-intl":
    "Repository tooling or local application library; no remote service client role identified.",
  uuid: "In-process application utility, validation, formatting, or UI component.",
  valibot:
    "In-process application utility, validation, formatting, or UI component.",
  vite: "Repository or application build, validation, or release tooling.",
  wxt: "Repository or application build, validation, or release tooling.",
  "y-protocols": "In-process CRDT synchronization protocol implementation.",
  "y-prosemirror":
    "Local parsing, serialization, document processing, or embedded runtime utility.",
  yjs: "Local parsing, serialization, document processing, or embedded runtime utility.",
  zod: "In-process application utility, validation, formatting, or UI component.",
  zustand:
    "In-process application utility, validation, formatting, or UI component.",
} as const satisfies Record<string, string>;
