// The processes the API ships or its operators run: the server (which also
// runs the scheduler), the bundled workers, the migration runner and the
// operator scripts. The organization write graph starts from these roots, so a
// module no production process reaches is not a write entry. A census test
// keeps this list equal to the package scripts and the image's bundles.

export type ApiRuntimeEntryKind =
  "server" | "worker" | "migration" | "operator";

export type ApiRuntimeEntry = {
  readonly file: string;
  readonly kind: ApiRuntimeEntryKind;
};

export const API_RUNTIME_ENTRIES = [
  { file: "apps/api/src/server.ts", kind: "server" },
  { file: "apps/api/src/db/migrate.ts", kind: "migration" },
  { file: "apps/api/src/lib/files/office-evidence-worker.ts", kind: "worker" },
  { file: "apps/api/src/lib/files/pdf-worker.ts", kind: "worker" },
  {
    file: "apps/api/src/lib/lists/sanctions/sanctions-matcher-worker.ts",
    kind: "worker",
  },
  { file: "apps/api/src/lib/ocr-local/ocr-local-worker.ts", kind: "worker" },
  { file: "apps/api/src/lib/ocr-searchable-pdf-worker.ts", kind: "worker" },
  { file: "apps/api/src/lib/search/extraction-worker.ts", kind: "worker" },
  {
    file: "apps/api/src/scripts/document-processing-worker.ts",
    kind: "worker",
  },
  { file: "apps/api/src/scripts/file-derivative-worker.ts", kind: "worker" },
  ...[
    "action-cost-report",
    "apply-reviewed-citation-labels",
    "backfill-case-law-slugs",
    "backfill-chat-content-v3",
    "backfill-cz-us-judges",
    "backfill-legislation-work-names",
    "backfill-statute-citation-counts",
    "better-auth-17-backfill",
    "better-auth-microsoft-identity-map",
    "better-auth-migration-audit",
    "better-auth-sign-in-replay",
    "case-law-raw-layout",
    "complete-sk-us-raw",
    "corpus-generation",
    "corpus-snippet-compare",
    "database-census",
    "decision-analysis-candidates",
    "decision-analysis-input",
    "decision-analysis-save",
    "eu-completion-control",
    "eu-completion-tick",
    "fetch-ocr-models",
    "image-smoke",
    "image-smoke-model-ingress",
    "import-cz-us-roster",
    "mcp-canary",
    "partner-oauth-client",
    "partner-oauth-client-secret",
    "redact-case-law-decision",
    "repair-cz-ns-court",
    "repair-publisher-absent-text",
    "replay-case-law-source",
    "replay-tick",
    "review-account",
    "scheduler-job-pause",
    "service-oauth-client",
    "verify-decision-identifiers",
  ].map((name): ApiRuntimeEntry => ({
    file: `apps/api/src/scripts/${name}.ts`,
    kind: "operator",
  })),
] as const satisfies readonly ApiRuntimeEntry[];

export type LocalDevModule = {
  readonly file: string;
  readonly reason: string;
};

/**
 * Modules only an open local-development runtime loads. Every import of one
 * sits behind `isLocalDevOpen()` (a guard test proves it), so production never
 * runs them and the organization write graph does not follow imports into them.
 */
export const LOCAL_DEV_MODULES = [
  {
    file: "apps/api/src/handlers/dev/routes.ts",
    reason:
      "Local seeding and search maintenance routes, mounted only in an open local runtime.",
  },
] as const satisfies readonly LocalDevModule[];
