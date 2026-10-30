import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

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

for (const { name, now, changedLines, diagnostics } of [
  {
    name: "unchanged during rollout",
    now: "2026-10-30",
    changedLines: [],
    diagnostics: [],
  },
  {
    name: "changed within a multiline call",
    now: "2026-10-30",
    changedLines: [3],
    diagnostics: [1],
  },
  {
    name: "unchanged after expiry",
    now: "2026-11-06",
    changedLines: [],
    diagnostics: [1],
  },
]) {
  test(`checkout baseline rollout: ${name}`, async () => {
    const directory = await mkdtemp(
      path.resolve(import.meta.dir, "../..", ".base-rollout-"),
    );
    const wrapper = path.join(directory, "plugin.ts");
    const plugin = path.resolve(import.meta.dir, "../no-live-test-base.ts");
    const scope = path.resolve(
      import.meta.dir,
      "../../scripts/guard-rollouts.ts",
    );
    const portablePath = path.resolve(
      import.meta.dir,
      "../../packages/portable-path/src/index.ts",
    );
    const repository = path.resolve(import.meta.dir, "../..");
    await Bun.write(
      wrapper,
      `import { createTestBasePlugin } from ${JSON.stringify(plugin)};
import { guardEnforcesLine } from ${JSON.stringify(scope)};
import { repoRelativePath } from ${JSON.stringify(portablePath)};
export default createTestBasePlugin((options) => guardEnforcesLine({
  ...options,
  now: new Date(${JSON.stringify(now)}),
  changedLines: new Map([[repoRelativePath(${JSON.stringify(repository)}, options.file), new Set(${JSON.stringify(changedLines)})]]),
}));`,
    );
    try {
      expect(
        await lintSingleRule(
          "no-live-test-base",
          [
            "Bun.spawnSync(",
            '  ["git", "show", "origin/main:baseline.json"],',
            "  { cwd: process.cwd() },",
            ");",
          ].join("\n"),
          { sourcePath: "scripts/example.test.ts", pluginPath: wrapper },
        ),
      ).toEqual(diagnostics);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
