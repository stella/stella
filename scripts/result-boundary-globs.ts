// The `better-result` boundary: paths allowed to `throw` or `try`/`catch` (see
// AGENTS.md "Error Handling" — top-level request handlers, framework hooks,
// queue/worker entry points, and operational scripts). Everywhere else on the
// tree, error handling goes through `Result`.
//
// `oxlint.config.ts` mirrors this list for the `no-throw-outside-boundary` /
// `no-try-catch-outside-boundary` rules: the lint rule blocks a new violation
// at the boundary in real time, this ratchet keeps the count in already-merged
// code from growing back. Keep the two lists side by side — a path added to
// one belongs in the other.
export const RESULT_BOUNDARY_GLOBS = [
  "apps/api/src/lib/api-handlers.ts",
  "apps/api/src/handlers/**/routes.ts",
  "apps/api/src/handlers/**/*route.ts",
  "apps/api/src/server.ts",
  "apps/api/src/lib/*queue*.ts",
  "apps/api/src/lib/**/run-queue.ts",
  "apps/api/src/lib/flows/flow-run-worker.ts",
  "apps/api/src/lib/document-deadline-scout-worker.ts",
  "apps/api/src/scripts/**",
  "apps/api/src/handlers/mcp-app-sandbox/**",
  "apps/api/src/tests/**",
] as const;

const boundaryGlobs = RESULT_BOUNDARY_GLOBS.map((glob) => new Bun.Glob(glob));

// Whether `file` (repo-relative) sits inside the result-boundary allowlist.
export const isResultBoundaryFile = (file: string): boolean =>
  boundaryGlobs.some((glob) => glob.match(file));
