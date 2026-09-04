// The repo's hand-written source surface, shared by the guards that scan it.
//
// Extracted so the ratchet's suppression budgets (scripts/ratchet.ts) and the
// security-tier waiver ledger (scripts/suppression-waivers.ts) cannot scan
// different file sets: a directive one guard sees and the other does not is a
// budgeted-but-unledgered suppression, exactly the hole both exist to close.

// Every hand-written source file in the repo. Used by metrics that guard a
// property of the code itself rather than an app convention, so there is no
// reason for the rule to stop at the two big apps.
//
// Deliberately not limited to `src`: a super-linear regex in an ingestion,
// backfill or codegen script blocks the same event loop as one in a handler,
// and a metric that claims to be repo-wide has to mean it.
export const ALL_SOURCE_GLOBS = [
  "apps/*/src/**/*.{ts,tsx}",
  "apps/*/scripts/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
  "packages/*/scripts/**/*.{ts,tsx}",
  "scripts/**/*.ts",
  ".oxlint-plugins/*.ts",
] as const;

// Never hand-edited, so never budgeted: generated declarations, generated
// modules, and the browser suite that no ratchet glob reaches anyway.
const isGeneratedSource = (file: string): boolean =>
  file.endsWith(".d.ts") || /\.gen\./u.test(file) || file.includes("/e2e/");

export const isExcludedSource = (file: string): boolean =>
  isGeneratedSource(file) ||
  /\.test\./u.test(file) ||
  // `*.type-test.ts` asserts on types at compile time. It is a test the type
  // checker runs, and the hyphen keeps it out of the `.test.` pattern above.
  /\.type-test\./u.test(file) ||
  /\.spec\./u.test(file) ||
  file.includes("/tests/") ||
  file.includes("/__tests__/");

// The same surface with test files KEPT. A rule that oxlint enables only on
// tests must be budgeted over tests: scanning it with `isExcludedSource` would
// leave the budget structurally unable to count a single one of its
// directives, so a committed zero would stay green no matter how many
// suppressions land. Known boundary: `apps/*/e2e` sits outside
// ALL_SOURCE_GLOBS, so no ratchet, this one included, sees directives there.
export const isExcludedTestInclusiveSource = isGeneratedSource;

// Repo-relative paths of every scannable source file under `root`.
export const scanSourceFiles = (root: string): readonly string[] => {
  const seen = new Set<string>();
  for (const glob of ALL_SOURCE_GLOBS) {
    for (const rel of new Bun.Glob(glob).scanSync(root)) {
      if (!isExcludedSource(rel)) {
        seen.add(rel);
      }
    }
  }
  return [...seen].sort();
};
