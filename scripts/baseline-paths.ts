// Every committed baseline, and the script that seeds it.
//
// A baseline records counts, sizes, or advisories measured on ONE tree: the
// head that ran the producer. That makes each of these files merge-order
// sensitive, which is why the merge queue re-runs every check on main plus
// the pull request before it lands. The set cannot be inferred — two of them
// live under `apps/`, and one carries no `-baseline` suffix at all — so the
// paths are enumerated here, each producer reads its own from this map, and
// `baseline-paths.test.ts` fails when a tracked baseline file is missing from
// it, or when an entry names a producer that is not in the tree: a budget
// nothing writes is not a budget.
//
// A size baseline is two-sided: a row that shrinks past its tolerance fails
// like one that grows, and `--write` re-anchors it, so headroom a change gave
// back cannot be spent later unreviewed. The bundle baseline is the exception
// and only prompts on a shrink: the same tree builds up to 3% differently in CI
// and locally, so a re-anchor written locally would not hold in CI.

export const BASELINE_PATHS = {
  /** scripts/check-aggregate-locks.ts */
  aggregateLocks: "scripts/aggregate-lock-baseline.json",
  /** scripts/check-aggregate-mutations.ts */
  aggregateMutations: "scripts/aggregate-mutations-baseline.json",
  /** scripts/check-oxlint-effective-config.ts */
  oxlintEffectiveConfig: "scripts/oxlint-effective-config-baseline.json",
  /** scripts/bundle-baseline.ts */
  bundle: "scripts/bundle-baseline.json",
  /** scripts/dependency-audit.ts */
  dependencyAudit: "scripts/dependency-audit-baseline.json",
  /** scripts/knip-exports-ratchet.ts */
  knipExports: "scripts/knip-exports-baseline.json",
  /** scripts/rc-bailouts.ts */
  reactCompilerBailouts: "scripts/react-compiler-bailouts.json",
  /** scripts/design-lint-baseline.ts */
  designLint: "scripts/design-lint-baseline.json",
  /** scripts/query-data-state-baseline.ts */
  queryDataState: ".oxlint-plugins/query-data-requires-state-baseline.json",
  /** scripts/failure-as-empty-baseline.ts */
  failureAsEmpty: ".oxlint-plugins/no-failure-as-empty-baseline.json",
  /** scripts/typecheck-baseline.ts */
  typecheck: "scripts/typecheck-baseline.json",
  /** scripts/transfer-read-guard.ts */
  transferRead: "scripts/transfer-read-guard-baseline.json",
  /** scripts/source-fingerprint-baseline.ts */
  sourceFingerprint: "scripts/source-fingerprint-baseline.json",
  /** scripts/sql-perf-baseline.ts */
  sqlPerf: ".oxlint-plugins/sql-perf-baseline.json",
  /** apps/api/scripts/mcp-coverage-guard.ts */
  mcpCoverage: "apps/api/mcp-coverage-baseline.json",
  /** apps/api/scripts/mcp-surface-baseline.ts */
  mcpSurface: "apps/api/mcp-surface-baseline.json",
  /** apps/api/scripts/deployment-feature-guard.ts */
  deploymentFeature: "apps/api/deployment-feature-baseline.json",
  /** apps/api/src/handlers/chat/provider-request-cache.integration.test.ts */
  chatPromptPrefix:
    "apps/api/src/tests/fixtures/provider-request-schemas/chat-prompt-baseline.json",
  /** apps/api/src/handlers/case-law/ingestion/adapters/source-surface-census.test.ts */
  caseLawSourceSurfaceBacklog:
    "apps/api/src/handlers/case-law/ingestion/adapters/source-surface-backlog-baseline.json",
  /** apps/api/src/handlers/case-law/ingestion/adapters/silent-drop-guard.test.ts */
  caseLawSilentDrop:
    "apps/api/src/handlers/case-law/ingestion/adapters/silent-drop-guard-baseline.json",
  /** apps/api/src/handlers/case-law/ingestion/adapters/read-fault-guard.test.ts */
  caseLawReadFault:
    "apps/api/src/handlers/case-law/ingestion/adapters/read-fault-guard-baseline.json",
  /** apps/api/src/handlers/legislation/statute-recall.contract.test.ts */
  statuteRecall:
    "apps/api/src/handlers/legislation/fixtures/statute-recall/baseline.json",
  /** apps/web/e2e/helpers/network.ts */
  webNetwork: "apps/web/e2e/network-baseline.json",
  /** scripts/queue-authority.ts */
  queueAuthority: "scripts/queue-authority-baseline.json",
  /** scripts/queue-authority.ts */
  schedulerTaskAuthority: "scripts/scheduler-task-authority-baseline.json",
  // The i18n pair is produced by `packages/scripts/src/i18n-*.ts` against the
  // messages directory it is given, so the package holds the file name and
  // each app contributes the directory. Both committed pairs are listed.
  /** packages/scripts/src/i18n-check.ts, apps/web */
  webI18nCheck: "apps/web/src/i18n/i18n-check-baseline.json",
  /** packages/scripts/src/i18n-lint.ts, apps/web */
  webI18nLint: "apps/web/src/i18n/i18n-lint-baseline.json",
  /** packages/scripts/src/i18n-check.ts, apps/landing */
  landingI18nCheck: "apps/landing/src/i18n/i18n-check-baseline.json",
  /** packages/scripts/src/i18n-lint.ts, apps/landing */
  landingI18nLint: "apps/landing/src/i18n/i18n-lint-baseline.json",
} as const satisfies Record<string, string>;

export const isSeededBaselineFile = (file: string): boolean =>
  Object.values(BASELINE_PATHS).some((baseline) => baseline === file);
