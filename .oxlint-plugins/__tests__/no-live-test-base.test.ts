import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule";

const lint = async (source: string) =>
  await lintSingleRule("no-live-test-base", source, {
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
        'const argvShow = ["git", "show", "origin/main:baseline.json"];',
        "Bun.spawnSync(argvShow, { cwd: REPO_ROOT });",
        "const checkoutOptions = { cwd: REPO_ROOT };",
        // A later spread replaces the explicit cwd at runtime.
        'Bun.spawnSync(["git", "show", "origin/main:a.json"], { cwd: fixture, ...checkoutOptions });',
        'Bun.spawnSync(["git", "show", "origin/main:a.json"], { cwd: fixture, ...callerOptions });',
        'const pipeOptions = { stdout: "pipe" };',
        'Bun.spawnSync(["git", "show", "origin/main:a.json"], pipeOptions);',
        'Bun.spawnSync(["git", "show", "origin/main:a.json"], checkoutOptions);',
        // A Git-named wrapper without a directory runs in the checkout.
        'git("show", "origin/main:x");',
        'git("show", "origin/main:x", { cwd: REPO_ROOT });',
        // A local wrapper that spawns Git without a cwd runs in the checkout.
        'const localGit = (...args) => Bun.spawnSync(["git", ...args]);',
        'localGit("show", "origin/main:x");',
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 17, 18, 19, 20, 22]);
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
        'const fixtureArgv = ["git", "show", "origin/main:a.json"];',
        "Bun.spawnSync(fixtureArgv, { cwd: fixture });",
        "const fixtureOptions = { cwd: fixture };",
        'Bun.spawnSync(["git", "show", "origin/main:a.json"], { stdout: "pipe", ...fixtureOptions });',
        'Bun.spawnSync(["git", "show", "origin/main:a.json"], { ...callerOptions, cwd: fixture });',
        'Bun.spawnSync(["git", "show", "origin/main:a.json"], fixtureOptions);',
        'git(fixture, "show", "origin/main:x");',
        'git("show", "origin/main:x", { cwd: fixture });',
        // Wrappers whose definition captures a fixture repository.
        'const withFixture = (verify) => { const root = mkdtempSync("fixture-"); const git = (...args) => Bun.spawnSync(["git", ...args], { cwd: root }); verify(root, git); };',
        'withFixture((root, git) => { git("show", "origin/main:x"); git("merge-base", "origin/main", "HEAD"); });',
        'function fixtureGit(...args) { return Bun.spawnSync(["git", ...args], { cwd: fixture }); }',
        'fixtureGit("show", "origin/main:x");',
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

test("command assertions and explicit Git stubs do not read a checkout baseline", async () => {
  expect(
    await lint(
      [
        'expect(["git", "rev-parse", "origin/main"]).toEqual(expected);',
        'expect(calls).toContainEqual(["git", "rev-parse", "origin/main^{commit}"]);',
        'Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "origin/main^{commit}"], { env: { ...process.env, PATH: stubPath } });',
        'const expectedArgv = ["git", "show", "origin/main:baseline.json"];',
        "expect(command).toEqual(expectedArgv);",
        'expect(command).toEqual(["git", "show", "origin/main:baseline.json"]);',
      ].join("\n"),
    ),
  ).toEqual([]);
});
