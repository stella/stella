// Every committed baseline, and the script that seeds it.
//
// A baseline records counts, sizes, or advisories measured on ONE tree: the
// head that ran the producer. That makes each of these files merge-order
// sensitive, which is why `scripts/merge-bar.ts` refuses to merge a pull
// request carrying one unless its head is current with the base. The merge bar
// cannot infer the set — two of them live under `apps/`, and one carries no
// `-baseline` suffix at all — so the paths are enumerated here, each producer
// reads its own from this map, and `baseline-paths.test.ts` fails when a
// tracked baseline file is missing from it.

export const BASELINE_PATHS = {
  /** scripts/bundle-baseline.ts */
  bundle: "scripts/bundle-baseline.json",
  /** scripts/dependency-audit.ts */
  dependencyAudit: "scripts/dependency-audit-baseline.json",
  /** scripts/knip-exports-ratchet.ts */
  knipExports: "scripts/knip-exports-baseline.json",
  /** scripts/ratchet.ts */
  ratchet: "scripts/ratchet-baseline.json",
  /** scripts/rc-bailouts.ts */
  reactCompilerBailouts: "scripts/react-compiler-bailouts.json",
  /** scripts/typecheck-baseline.ts */
  typecheck: "scripts/typecheck-baseline.json",
  /** apps/api/scripts/mcp-coverage-guard.ts */
  mcpCoverage: "apps/api/mcp-coverage-baseline.json",
  /** apps/web/e2e/helpers/network.ts */
  webNetwork: "apps/web/e2e/network-baseline.json",
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
  // Not produced by any script in the tree: a stale copy of the root ratchet
  // baseline. Listed so the merge bar still holds a pull request that touches
  // it, and so the test below does not read its absence from this map as a
  // missing producer.
  staleWebRatchet: "apps/web/scripts/ratchet-baseline.json",
} as const satisfies Record<string, string>;

export const isSeededBaselineFile = (file: string): boolean =>
  Object.values(BASELINE_PATHS).some((baseline) => baseline === file);
