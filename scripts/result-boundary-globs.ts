// The `better-result` boundary: paths allowed to `throw` or `try`/`catch` (see
// AGENTS.md "Error Handling" — top-level request handlers, framework hooks,
// queue/worker entry points, and operational scripts). Everywhere else on the
// tree, error handling goes through `Result`.
//
// `oxlint.config.ts` imports this list for the
// `no-throw-outside-boundary` / `no-try-catch-outside-boundary` rules: the lint
// rule blocks a new violation at the boundary in real time, while the ratchet
// keeps the count in already-merged code from growing back.
export const RESULT_CONVENTION_SOURCE_GLOBS = [
  "apps/api/src/lib/**/*.{ts,tsx}",
  "apps/api/src/handlers/**/*.{ts,tsx}",
  "apps/api/src/mcp/**/*.{ts,tsx}",
  "apps/web/src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
] as const;

// The directories the two lint rules are switched on for: the exact set of
// two-levels-deep app directories and `packages/*/src` roots inside the source
// scope above that already sit at zero violations. Everything else stays
// unlisted, so the rules default to off there and the `throw-outside-boundary`
// / `try-catch-outside-boundary` ratchet counters in scripts/ratchet.ts hold
// the count down until a directory reaches zero and moves into this list.
//
// oxlint.config.ts spreads this list rather than restating it, so the lint
// scope and the enrolment guard cannot drift apart.
export const RESULT_CONVENTION_ENABLED_GLOBS = [
  "apps/api/src/handlers/agent-auth/**/*.ts",
  "apps/api/src/handlers/ai-config/**/*.ts",
  "apps/api/src/handlers/audit-logs/**/*.ts",
  "apps/api/src/handlers/auth/**/*.ts",
  "apps/api/src/handlers/bilingual-translations/**/*.ts",
  "apps/api/src/handlers/billing-codes/**/*.ts",
  "apps/api/src/handlers/clauses/**/*.ts",
  "apps/api/src/handlers/contacts/**/*.ts",
  "apps/api/src/handlers/dev/**/*.ts",
  "apps/api/src/handlers/document-translations/**/*.ts",
  "apps/api/src/handlers/document-types/**/*.ts",
  "apps/api/src/handlers/docx-suggestions/**/*.ts",
  "apps/api/src/handlers/expenses/**/*.ts",
  "apps/api/src/handlers/files/**/*.ts",
  "apps/api/src/handlers/flows/**/*.ts",
  "apps/api/src/handlers/folio-collab/**/*.ts",
  "apps/api/src/handlers/mcp/**/*.ts",
  "apps/api/src/handlers/me/**/*.ts",
  "apps/api/src/handlers/memories/**/*.ts",
  "apps/api/src/handlers/notifications/**/*.ts",
  "apps/api/src/handlers/operator/**/*.ts",
  "apps/api/src/handlers/organization-settings/**/*.ts",
  "apps/api/src/handlers/reports/**/*.ts",
  "apps/api/src/handlers/saved-searches/**/*.ts",
  "apps/api/src/handlers/search/**/*.ts",
  "apps/api/src/handlers/tasks/**/*.ts",
  "apps/api/src/handlers/template-packs/**/*.ts",
  "apps/api/src/handlers/template-recipes/**/*.ts",
  "apps/api/src/handlers/uploads/**/*.ts",
  "apps/api/src/handlers/usage/**/*.ts",
  "apps/api/src/handlers/user-files/**/*.ts",
  "apps/api/src/handlers/verify/**/*.ts",
  "apps/api/src/handlers/work-obligations/**/*.ts",
  "apps/api/src/lib/bbox/**/*.ts",
  "apps/api/src/lib/clauses/**/*.ts",
  "apps/api/src/lib/conditions/**/*.ts",
  "apps/api/src/lib/document-review/**/*.ts",
  "apps/api/src/lib/document-types/**/*.ts",
  "apps/api/src/lib/extraction-runs/**/*.ts",
  "apps/api/src/lib/infosoud/**/*.ts",
  "apps/api/src/lib/json-schema/**/*.ts",
  "apps/api/src/lib/lists/**/*.ts",
  "apps/api/src/lib/markdown/**/*.ts",
  "apps/api/src/lib/mcp-connectors/**/*.ts",
  "apps/api/src/lib/memory/**/*.ts",
  "apps/api/src/lib/observability/**/*.ts",
  "apps/api/src/lib/properties/**/*.ts",
  "apps/api/src/lib/smoke-session/**/*.ts",
  "apps/api/src/lib/template-binding/**/*.ts",
  "apps/api/src/lib/uploads/**/*.ts",
  "apps/api/src/lib/usage/**/*.ts",
  "apps/api/src/lib/user-files/**/*.ts",
  "apps/api/src/lib/work-obligations/**/*.ts",
  "apps/api/src/mcp/generated/**/*.ts",
  "apps/web/src/components/ai-elements/**/*.{ts,tsx}",
  "apps/web/src/components/ai-prompt-input/**/*.{ts,tsx}",
  "apps/web/src/components/breadcrumbs/**/*.{ts,tsx}",
  "apps/web/src/components/catalogue/**/*.{ts,tsx}",
  "apps/web/src/components/conditions/**/*.{ts,tsx}",
  "apps/web/src/components/file-tree/**/*.{ts,tsx}",
  "apps/web/src/components/flows/**/*.{ts,tsx}",
  "apps/web/src/components/legal-reader/**/*.{ts,tsx}",
  "apps/web/src/components/markdown/**/*.{ts,tsx}",
  "apps/web/src/components/organization/**/*.{ts,tsx}",
  "apps/web/src/features/guides/**/*.{ts,tsx}",
  "apps/web/src/features/inbox/**/*.{ts,tsx}",
  "apps/web/src/lib/deepl/**/*.{ts,tsx}",
  "apps/web/src/lib/inbox/**/*.{ts,tsx}",
  "apps/web/src/lib/prompts/**/*.{ts,tsx}",
  "apps/web/src/lib/web-search/**/*.{ts,tsx}",
  "apps/web/src/queries/**/*.{ts,tsx}",
  "apps/web/src/routes/dev/**/*.{ts,tsx}",
  "apps/web/src/routes/sitemaps/**/*.{ts,tsx}",
  "apps/web/src/stores/**/*.{ts,tsx}",
  "packages/ai-catalog/src/**/*.ts",
  "packages/api-client/src/**/*.ts",
  "packages/auth-model/src/**/*.ts",
  "packages/calculations/src/**/*.ts",
  "packages/catalogue/src/**/*.ts",
  "packages/chat-limits/src/**/*.ts",
  "packages/conditions/src/**/*.ts",
  "packages/country-codes/src/**/*.ts",
  "packages/docx-utils/src/**/*.ts",
  "packages/errors/src/**/*.ts",
  "packages/fetch/src/**/*.ts",
  "packages/legal-atlas/src/**/*.ts",
  "packages/permissions/src/**/*.ts",
  "packages/template-packs/src/**/*.ts",
  "packages/text-normalize/src/**/*.ts",
  "packages/time/src/**/*.ts",
  "packages/workspace-model/src/**/*.ts",
  "packages/workspace-ui/src/**/*.{ts,tsx}",
] as const;

export const RESULT_BOUNDARY_GLOBS = [
  "apps/api/src/lib/api-handlers.ts",
  "apps/api/src/handlers/**/routes.ts",
  "apps/api/src/handlers/**/*route.ts",
  "apps/api/src/server.ts",
  "apps/api/src/lib/account-deletion-cleanup-queue.ts",
  "apps/api/src/lib/bilingual/run-queue.ts",
  "apps/api/src/lib/document-processing-queue.ts",
  "apps/api/src/lib/document-review/run-queue.ts",
  "apps/api/src/lib/document-translation/run-queue.ts",
  "apps/api/src/lib/entity-deletion-cleanup-queue.ts",
  "apps/api/src/lib/file-derivative-queue.ts",
  "apps/api/src/lib/flows/flow-run-worker.ts",
  "apps/api/src/lib/document-deadline-scout-worker.ts",
  "apps/api/src/lib/style-set-package-cleanup-queue.ts",
  "apps/api/src/lib/tanstack-ai-generate.ts",
  "apps/api/src/lib/workflow-queue.ts",
  "apps/api/src/scripts/**",
  "apps/api/src/handlers/mcp-app-sandbox/**",
  // Web worker entry modules. The browser, not our code, invokes the message
  // handler, and a failure has to travel back over `postMessage` instead of
  // returning to a caller that could read a `Result`.
  "apps/web/src/workers/**",
  // Vite dispatches `vite:preloadError` on `window` when a route chunk fails
  // to load; the listener is a framework hook, and its single-reload guard
  // reads `sessionStorage`, which throws by contract when storage is blocked.
  "apps/web/src/lib/preload-error-recovery.ts",
  // These packages are boundary adapters by design: the runtime turns
  // invalid startup state into fatal exceptions, while the testkit exposes
  // assertion failures to test runners.
  "packages/start-runtime/src/runtime.ts",
  "packages/ssr-testkit/src/assert-document.ts",
] as const;

// Non-authored source and test surfaces do not carry migration debt. Keep the
// lint override and ratchet exclusion derived from this same list so generated
// output cannot be enabled by one guard while skipped by the other.
export const RESULT_CONVENTION_EXCLUDE_GLOBS = [
  ...RESULT_BOUNDARY_GLOBS,
  "apps/api/evals/**",
  "apps/api/src/tests/**",
  "apps/api/src/mcp/generated/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/__fixtures__/**",
  "**/*.gen.*",
  "**/*.d.ts",
] as const;

const resultConventionExcludeGlobs = RESULT_CONVENTION_EXCLUDE_GLOBS.map(
  (glob) => new Bun.Glob(glob),
);
const resultConventionSourceGlobs = RESULT_CONVENTION_SOURCE_GLOBS.map(
  (glob) => new Bun.Glob(glob),
);

export const isResultConventionSourceFile = (file: string): boolean =>
  resultConventionSourceGlobs.some((glob) => glob.match(file));

export const isResultConventionExcludedFile = (file: string): boolean =>
  resultConventionExcludeGlobs.some((glob) => glob.match(file));
