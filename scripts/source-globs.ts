import { panic } from "better-result";

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

const gitFileList = (root: string, args: readonly string[]): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic(
      `git ls-files ${args.join(" ")} failed in ${root}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
};

// Repo-relative paths in the git index that exist in the working tree:
// committed files plus staged additions, the same set the ratchet scans.
// Never a walk of the working tree: tests and checks run side by side in one
// checkout, and a fixture directory another one creates and removes would
// appear in the walk and vanish before it is read.
export const indexedWorkingTreeFiles = (root: string): readonly string[] => {
  const deleted = new Set(gitFileList(root, ["--deleted"]));
  return gitFileList(root, []).filter((file) => !deleted.has(file));
};

// Repo-relative paths of every scannable source file under `root`.
export const scanSourceFiles = (root: string): readonly string[] => {
  const files = indexedWorkingTreeFiles(root);
  const seen = new Set<string>();
  for (const glob of ALL_SOURCE_GLOBS) {
    const matcher = new Bun.Glob(glob);
    for (const rel of files) {
      if (matcher.match(rel) && !isExcludedSource(rel)) {
        seen.add(rel);
      }
    }
  }
  return [...seen].toSorted();
};
