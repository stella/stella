import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const lint = (source: string) =>
  lintSingleRule("no-live-test-base", source, {
    sourcePath: "scripts/example.test.ts",
  });

test("rejects moving test baselines in the checkout", async () => {
  expect(
    await lint(
      [
        'const REPO_ROOT = path.resolve(import.meta.dir, "..");',
        "const alias = REPO_ROOT;",
        `Bun.spawnSync(["git", "show", \`origin/main:\${REGISTRY_PATH}\`], { cwd: alias });`,
        'Bun.spawnSync(["git", "show", "origin/main:scripts/baseline.json"]);',
        'run(["git", "ls-tree", "--name-only", "origin/main", "--", catalog], REPO_ROOT);',
        'execFileSync("git", ["show", "origin/main:baseline.json"], { cwd: process.cwd() });',
        'Bun.spawnSync(["git", "merge-base", "origin/main", "HEAD"], { cwd: REPO_ROOT });',
        'runGit(REPO_ROOT, "rev-parse", "origin/main");',
        'Bun.spawnSync(["git", "show", "origin/main:baseline.json"], { stdout: "pipe" });',
        'execFileSync("git", ["rev-parse", "origin/main^{commit}"]);',
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
});

test("allows fixture repositories and pinned reads without exemptions", async () => {
  expect(
    await lint(
      [
        'const fixture = mkdtempSync(path.join(import.meta.dir, ".fixture-"));',
        "const alias = fixture;",
        'Bun.spawnSync(["git", "show", "origin/main:baseline.json"], { cwd: alias });',
        'run(["git", "rev-parse", "origin/main"], fixture);',
        'git(fixture, "merge-base", "origin/main", "HEAD");',
        'Bun.spawnSync(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: fixture });',
        "const base = treeBaseRevision({ repoRoot: REPO_ROOT });",
        `Bun.spawnSync(["git", "show", \`\${base}:baseline.json\`], { cwd: REPO_ROOT });`,
        'expect(workflow).toContain("show origin/main:scripts/check.sh");',
      ].join("\n"),
    ),
  ).toEqual([]);
});
