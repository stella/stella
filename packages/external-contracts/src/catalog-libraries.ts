// The catalog is partitioned between these in-process packages and registry SDKs.
// A new package must make that decision before the offline guard can pass.
export const IN_PROCESS_CATALOG_PACKAGES = {
  "d3-scale":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@types/d3-scale":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@base-ui/react":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@libpdf/core":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@mcp-ui/client":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@oxlint/plugins":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@shadcn/lint":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@silurus/ooxml":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/anonymize":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/anonymize-data":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/anonymize-wasm":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/docx-core":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/folio-agents":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/folio-core":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/folio-react":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@stll/fuzzy-search":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@t3-oss/env-core":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tailwindcss/postcss":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tailwindcss/vite":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/ai-codex":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/ai-sandbox":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/ai-client":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/ai-code-mode":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/ai-persistence":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/ai-react":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/charts":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/eslint-plugin-query":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@tanstack/eslint-plugin-router":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@types/node":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "bun-types":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "@vitejs/plugin-react":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  ajv: "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "ajv-formats":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "better-result":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "cldr-misc-full":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  diff: "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "disposable-email-domains-js":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "drizzle-kit":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "drizzle-orm":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  elysia:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  eslint:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "fast-check":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  franc:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  jszip:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "lucide-react":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "oxc-transform-react":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  oxfmt:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  oxlint:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  saxes:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  sherif:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  ssf: "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  stylelint:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  tailwindcss:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "temporal-polyfill":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  tsdown:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  typescript:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  "use-intl":
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  valibot:
    "In-process library, framework, local process adapter, types or build tooling; no external service client.",
  vite: "In-process library, framework, local process adapter, types or build tooling; no external service client.",
} as const satisfies Record<string, string>;
