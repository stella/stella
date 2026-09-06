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
  "apps/api/src/lib/docx-authoring/**/*.ts",
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
  "apps/web/src/features/command-palette/**/*.{ts,tsx}",
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
  "packages/clipboard/src/**/*.ts",
  "packages/concurrency/src/**/*.ts",
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

export type ResultBoundaryOptOut = {
  /** One line, or the word "unreviewed" when nobody has looked yet. */
  reason: string;
  /** An enrolment unit path, as scripts/check-result-boundary-enrolment.ts derives it. */
  unit: string;
};

// Directories inside `apps/<name>/src` or `packages/<name>/src` that have NOT
// joined the convention. Enrolment is the default:
// scripts/check-result-boundary-enrolment.ts fails on a directory that is
// neither enabled above nor listed here, so a new app, package, or feature
// directory cannot skip the convention by being forgotten. It also fails on an
// entry whose directory is enabled or gone, so the table can only shrink.
//
// The seed below is the state of the tree on the day apps/web joined: every
// entry reads "unreviewed" because that is the truth — these directories carry
// throw/try-catch debt the ratchet counters are walking down, and no one has
// argued that any of them is a genuine boundary. Replace a reason when the
// answer is something else; delete the entry when the directory reaches zero.
export const RESULT_CONVENTION_OPT_OUTS = [
  { reason: "unreviewed", unit: "apps/api/src" },
  { reason: "unreviewed", unit: "apps/api/src/agent-auth" },
  { reason: "unreviewed", unit: "apps/api/src/db" },
  { reason: "unreviewed", unit: "apps/api/src/db/schema" },
  { reason: "unreviewed", unit: "apps/api/src/dev" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/ai-autocomplete" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/api-keys" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/case-law" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/catalogue" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/chat" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/document-reviews" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/entities" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/external-preview" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/feedback" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/fields" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/hosted-usage-webhook" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/invoices" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/legislation" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/lists" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/mcp-connectors" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/playbooks" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/properties" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/rates" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/sharepoint" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/signals" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/skills" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/style-sets" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/templates" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/time-entries" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/view-templates" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/views" },
  { reason: "unreviewed", unit: "apps/api/src/handlers/workspaces" },
  { reason: "unreviewed", unit: "apps/api/src/lib" },
  { reason: "unreviewed", unit: "apps/api/src/lib/agent-skills" },
  { reason: "unreviewed", unit: "apps/api/src/lib/analytics" },
  { reason: "unreviewed", unit: "apps/api/src/lib/bilingual" },
  { reason: "unreviewed", unit: "apps/api/src/lib/business-registries" },
  { reason: "unreviewed", unit: "apps/api/src/lib/case-law" },
  { reason: "unreviewed", unit: "apps/api/src/lib/chat" },
  { reason: "unreviewed", unit: "apps/api/src/lib/corpus-index" },
  { reason: "unreviewed", unit: "apps/api/src/lib/db" },
  { reason: "unreviewed", unit: "apps/api/src/lib/deepl" },
  { reason: "unreviewed", unit: "apps/api/src/lib/document-translation" },
  { reason: "unreviewed", unit: "apps/api/src/lib/docx" },
  { reason: "unreviewed", unit: "apps/api/src/lib/email" },
  { reason: "unreviewed", unit: "apps/api/src/lib/entities" },
  { reason: "unreviewed", unit: "apps/api/src/lib/entity-versions" },
  { reason: "unreviewed", unit: "apps/api/src/lib/errors" },
  { reason: "unreviewed", unit: "apps/api/src/lib/file-scan" },
  { reason: "unreviewed", unit: "apps/api/src/lib/files" },
  { reason: "unreviewed", unit: "apps/api/src/lib/flows" },
  { reason: "unreviewed", unit: "apps/api/src/lib/health" },
  { reason: "unreviewed", unit: "apps/api/src/lib/hosted-usage-provider" },
  { reason: "unreviewed", unit: "apps/api/src/lib/legal-search" },
  { reason: "unreviewed", unit: "apps/api/src/lib/mcp-upstream" },
  { reason: "unreviewed", unit: "apps/api/src/lib/ocr-local" },
  { reason: "unreviewed", unit: "apps/api/src/lib/rate-limit" },
  { reason: "unreviewed", unit: "apps/api/src/lib/scheduler" },
  { reason: "unreviewed", unit: "apps/api/src/lib/scouts" },
  { reason: "unreviewed", unit: "apps/api/src/lib/search" },
  { reason: "unreviewed", unit: "apps/api/src/lib/signals" },
  { reason: "unreviewed", unit: "apps/api/src/lib/skills" },
  { reason: "unreviewed", unit: "apps/api/src/lib/tasks" },
  { reason: "unreviewed", unit: "apps/api/src/lib/templates" },
  { reason: "unreviewed", unit: "apps/api/src/lib/views" },
  { reason: "unreviewed", unit: "apps/api/src/lib/web-search" },
  { reason: "unreviewed", unit: "apps/api/src/lib/workflow" },
  { reason: "unreviewed", unit: "apps/api/src/mcp" },
  { reason: "unreviewed", unit: "apps/api/src/mcp/apps" },
  { reason: "unreviewed", unit: "apps/api/src/mcp/gateway" },
  { reason: "unreviewed", unit: "apps/collab/src" },
  { reason: "unreviewed", unit: "apps/desktop/src/clipboard" },
  { reason: "unreviewed", unit: "apps/desktop/src/i18n" },
  { reason: "unreviewed", unit: "apps/desktop/src/mainview" },
  { reason: "unreviewed", unit: "apps/desktop/src/shared" },
  { reason: "unreviewed", unit: "apps/desktop/src/telemetry" },
  { reason: "unreviewed", unit: "apps/landing/src" },
  { reason: "unreviewed", unit: "apps/landing/src/components" },
  { reason: "unreviewed", unit: "apps/landing/src/components/react" },
  { reason: "unreviewed", unit: "apps/landing/src/data" },
  { reason: "unreviewed", unit: "apps/landing/src/data/products" },
  { reason: "unreviewed", unit: "apps/landing/src/i18n" },
  { reason: "unreviewed", unit: "apps/landing/src/integrations" },
  { reason: "unreviewed", unit: "apps/landing/src/lib" },
  { reason: "unreviewed", unit: "apps/landing/src/pages" },
  { reason: "unreviewed", unit: "apps/landing/src/pages/images" },
  { reason: "unreviewed", unit: "apps/legal-atlas-runner/src" },
  { reason: "unreviewed", unit: "apps/legal-atlas-runner/src/runners" },
  { reason: "unreviewed", unit: "apps/mobile/src" },
  { reason: "unreviewed", unit: "apps/mobile/src/app" },
  { reason: "unreviewed", unit: "apps/mobile/src/app/(tabs)" },
  { reason: "unreviewed", unit: "apps/mobile/src/components" },
  { reason: "unreviewed", unit: "apps/playground/src" },
  { reason: "unreviewed", unit: "apps/web/src" },
  { reason: "unreviewed", unit: "apps/web/src/components" },
  { reason: "unreviewed", unit: "apps/web/src/components/ai-suggestions" },
  { reason: "unreviewed", unit: "apps/web/src/components/auth" },
  { reason: "unreviewed", unit: "apps/web/src/components/autocomplete" },
  { reason: "unreviewed", unit: "apps/web/src/components/chat" },
  { reason: "unreviewed", unit: "apps/web/src/components/dev" },
  { reason: "unreviewed", unit: "apps/web/src/components/docx" },
  { reason: "unreviewed", unit: "apps/web/src/components/inspector" },
  { reason: "unreviewed", unit: "apps/web/src/components/office" },
  { reason: "unreviewed", unit: "apps/web/src/components/pdf" },
  { reason: "unreviewed", unit: "apps/web/src/components/templates" },
  { reason: "unreviewed", unit: "apps/web/src/components/usage" },
  { reason: "unreviewed", unit: "apps/web/src/components/versions" },
  { reason: "unreviewed", unit: "apps/web/src/components/workspaces" },
  { reason: "unreviewed", unit: "apps/web/src/features/case-law" },
  { reason: "unreviewed", unit: "apps/web/src/features/chat" },
  { reason: "unreviewed", unit: "apps/web/src/features/statutes" },
  { reason: "unreviewed", unit: "apps/web/src/features/style-sets" },
  { reason: "unreviewed", unit: "apps/web/src/hooks" },
  { reason: "unreviewed", unit: "apps/web/src/i18n" },
  { reason: "unreviewed", unit: "apps/web/src/lib" },
  { reason: "unreviewed", unit: "apps/web/src/lib/account" },
  { reason: "unreviewed", unit: "apps/web/src/lib/analytics" },
  { reason: "unreviewed", unit: "apps/web/src/lib/anonymize" },
  { reason: "unreviewed", unit: "apps/web/src/lib/contacts" },
  { reason: "unreviewed", unit: "apps/web/src/lib/errors" },
  { reason: "unreviewed", unit: "apps/web/src/lib/files" },
  { reason: "unreviewed", unit: "apps/web/src/lib/knowledge" },
  { reason: "unreviewed", unit: "apps/web/src/lib/organization" },
  { reason: "unreviewed", unit: "apps/web/src/lib/pdf" },
  { reason: "unreviewed", unit: "apps/web/src/lib/workspaces" },
  { reason: "unreviewed", unit: "apps/web/src/routes" },
  { reason: "unreviewed", unit: "apps/web/src/routes/_protected.chat" },
  { reason: "unreviewed", unit: "apps/web/src/routes/_protected.contacts" },
  { reason: "unreviewed", unit: "apps/web/src/routes/_protected.inbox" },
  { reason: "unreviewed", unit: "apps/web/src/routes/_protected.knowledge" },
  { reason: "unreviewed", unit: "apps/web/src/routes/_protected.settings" },
  { reason: "unreviewed", unit: "apps/web/src/routes/_protected.workspaces" },
  { reason: "unreviewed", unit: "apps/web/src/routes/auth" },
  { reason: "unreviewed", unit: "apps/web/src/routes/law" },
  { reason: "unreviewed", unit: "apps/web/src/routes/onboarding" },
  { reason: "unreviewed", unit: "apps/web/src/routes/tools" },
  { reason: "unreviewed", unit: "packages/agent-engine/src" },
  { reason: "unreviewed", unit: "packages/anonymize-chat/src" },
  { reason: "unreviewed", unit: "packages/api-contract/src" },
  { reason: "unreviewed", unit: "packages/boe/src" },
  { reason: "unreviewed", unit: "packages/business-registries/src" },
  { reason: "unreviewed", unit: "packages/chat/src" },
  { reason: "unreviewed", unit: "packages/cli/src" },
  { reason: "unreviewed", unit: "packages/collation/src" },
  { reason: "unreviewed", unit: "packages/infosoud/src" },
  { reason: "unreviewed", unit: "packages/legal-ast/src" },
  { reason: "unreviewed", unit: "packages/locales/src" },
  { reason: "unreviewed", unit: "packages/money/src" },
  { reason: "unreviewed", unit: "packages/property-testing/src" },
  { reason: "unreviewed", unit: "packages/scripts/src" },
  { reason: "unreviewed", unit: "packages/skills/src" },
  { reason: "unreviewed", unit: "packages/ssr-kit/src" },
  { reason: "unreviewed", unit: "packages/stable-stringify/src" },
  { reason: "unreviewed", unit: "packages/template-conditions/src" },
  { reason: "unreviewed", unit: "packages/ui/src" },
  { reason: "unreviewed", unit: "packages/user-agent/src" },
] as const satisfies readonly ResultBoundaryOptOut[];

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
