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
  "packages/*/src/**/*.{ts,tsx}",
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
