import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runSelectedPackages,
  selectTouchedPackages,
  TYPECHECK_BUDGET_EXCLUSIONS,
  validateTypecheckBudgetExclusions,
  workspacePackageNames,
} from "./pre-push-typecheck";

const manifests: Record<
  string,
  { name: string; scripts: { typecheck?: string } }
> = {
  "apps/web": { name: "@stll/web", scripts: { typecheck: "bun check" } },
  "packages/small": {
    name: "@stll/small",
    scripts: { typecheck: "bun check" },
  },
  "packages/renamed": {
    name: "@stll/renamed",
    scripts: { typecheck: "bun check" },
  },
  "packages/untyped": { name: "@stll/untyped", scripts: {} },
};

const select = (files: string[]) =>
  selectTouchedPackages(
    files,
    (directory) => manifests[directory] !== undefined,
    (directory) => {
      const manifest = manifests[directory];
      if (manifest === undefined) {
        throw new TypeError(`Unexpected ${directory}`);
      }
      return manifest;
    },
  );

const commandPath = path.join(import.meta.dirname, "pre-push-typecheck.ts");

const git = (repository: string, ...arguments_: string[]) => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pre-push test",
      GIT_AUTHOR_EMAIL: "pre-push@example.com",
      GIT_COMMITTER_NAME: "Pre-push test",
      GIT_COMMITTER_EMAIL: "pre-push@example.com",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
};

const createRepository = (
  packages: Record<string, { typecheck: string; source?: string }>,
) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), "pre-push-typecheck-"));
  mkdirSync(path.join(repository, "apps", "web"), { recursive: true });
  writeFileSync(
    path.join(repository, "apps", "web", "package.json"),
    JSON.stringify({ name: "@stll/web" }),
  );
  for (const [name, { typecheck, source = "export {};\n" }] of Object.entries(
    packages,
  )) {
    const directory = path.join(repository, "packages", name);
    mkdirSync(path.join(directory, "src"), { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: `@test/${name}`, scripts: { typecheck } }),
    );
    writeFileSync(path.join(directory, "src", "index.ts"), source);
  }
  git(repository, "init", "--quiet");
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "initial");
  return repository;
};

const runCommand = (repository: string, base = "HEAD~1") =>
  Bun.spawnSync(
    ["bun", commandPath, "--base", base, "--repo-root", repository],
    {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

test("each changed TypeScript file maps only to its owning package", () => {
  expect(
    select([
      "packages/small/src/a.ts",
      "packages/small/src/b.tsx",
      "apps/web/src/route.ts",
    ]).map(({ name }) => name),
  ).toEqual(["@stll/web", "@stll/small"]);
});

test("root-only and non-TypeScript changes select no packages", () => {
  expect(
    select(["scripts/tool.ts", "package.json", "apps/web/style.css"]),
  ).toEqual([]);
});

test("a deleted TypeScript path still selects its package", () => {
  expect(
    select(["packages/small/src/deleted.ts"]).map(({ name }) => name),
  ).toEqual(["@stll/small"]);
});

test("a deleted package is ignored without reading its removed manifest", () => {
  const reads: string[] = [];
  expect(
    selectTouchedPackages(
      ["packages/removed/src/index.ts"],
      () => false,
      (directory) => {
        reads.push(directory);
        throw new TypeError(`Unexpected manifest read for ${directory}`);
      },
    ),
  ).toEqual([]);
  expect(reads).toEqual([]);
});

test("a renamed package is selected at its new location", () => {
  expect(
    select(["packages/removed/src/index.ts", "packages/renamed/src/index.ts"]),
  ).toEqual([
    {
      directory: "packages/renamed",
      name: "@stll/renamed",
      typecheck: "bun check",
    },
  ]);
});

test("a package without a typecheck script is skipped and named", async () => {
  const packages = select(["packages/untyped/src/index.ts"]);
  expect(packages).toEqual([
    {
      directory: "packages/untyped",
      name: "@stll/untyped",
      typecheck: undefined,
    },
  ]);
  const runs: string[] = [];
  const reports: string[] = [];
  expect(
    await runSelectedPackages(
      packages,
      async ({ name }) => {
        runs.push(name);
        return 0;
      },
      (message) => {
        reports.push(message);
      },
    ),
  ).toBe(0);
  expect(runs).toEqual([]);
  expect(reports).toEqual([
    "pre-push typecheck: skipping @stll/untyped (no typecheck script)",
  ]);
});

test("an over-budget package is skipped while an unlisted package runs", async () => {
  const packages = select([
    "apps/web/src/route.ts",
    "packages/small/src/index.ts",
  ]);
  const runs: string[] = [];
  const reports: string[] = [];

  expect(
    await runSelectedPackages(
      packages,
      async ({ name }) => {
        runs.push(name);
        return 0;
      },
      (message) => {
        reports.push(message);
      },
    ),
  ).toBe(0);
  expect(runs).toEqual(["@stll/small"]);
  expect(reports).toEqual([
    "pre-push-typecheck: @stll/web skipped (75.6 s, 1.14 GB measured; over the pre-push budget); CI checks it",
    "pre-push typecheck: checking @stll/small",
  ]);
});

test("a stale budget exclusion is rejected", () => {
  expect(() =>
    validateTypecheckBudgetExclusions(
      [
        ...TYPECHECK_BUDGET_EXCLUSIONS,
        {
          name: "@stll/unknown",
          measuredTime: "21 s",
          measuredMemory: "401 MB",
        },
      ],
      new Set(["@stll/web", "@stll/small"]),
    ),
  ).toThrow("budget exclusion names unknown package @stll/unknown");
});

test("every real budget exclusion names a real workspace package", () => {
  expect(() =>
    validateTypecheckBudgetExclusions(
      TYPECHECK_BUDGET_EXCLUSIONS,
      workspacePackageNames(path.resolve(import.meta.dirname, "..")),
    ),
  ).not.toThrow();
});

test("the command defaults to the repository root when the option is absent", () => {
  const workingDirectory = mkdtempSync(
    path.join(os.tmpdir(), "pre-push-typecheck-cwd-"),
  );
  try {
    const result = Bun.spawnSync(["bun", commandPath, "--base", "HEAD"], {
      cwd: workingDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("the command ignores a deleted package whose directory remains", () => {
  const repository = createRepository({ removed: { typecheck: "exit 7" } });
  try {
    rmSync(path.join(repository, "packages", "removed"), { recursive: true });
    mkdirSync(path.join(repository, "packages", "removed", "node_modules"), {
      recursive: true,
    });
    git(repository, "add", "--all");
    git(repository, "commit", "--quiet", "-m", "remove package");

    const result = runCommand(repository);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the command selects both packages when a TypeScript file moves", () => {
  const repository = createRepository({
    source: {
      typecheck: 'echo "CHECKED_SOURCE"',
      source: "export const sourceOnly = true;\n",
    },
    destination: { typecheck: 'echo "CHECKED_DESTINATION"' },
  });
  try {
    git(
      repository,
      "mv",
      "packages/source/src/index.ts",
      "packages/destination/src/moved.ts",
    );
    git(repository, "add", "--all");
    git(repository, "commit", "--quiet", "-m", "move source");

    const result = runCommand(repository);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("checking @test/source");
    expect(result.stdout.toString()).toContain("CHECKED_SOURCE");
    expect(result.stdout.toString()).toContain("checking @test/destination");
    expect(result.stdout.toString()).toContain("CHECKED_DESTINATION");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("a package selection error reports the failure and leaves checking to CI", () => {
  const result = Bun.spawnSync(["bun", commandPath, "--base", "missing-ref"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toMatch(
    /^pre-push-typecheck: package selection failed \(.+\); CI checks the packages\n$/u,
  );
  expect(result.stderr.toString()).toBe("");
});

test("a stale budget exclusion reports its distinct fail-open message", () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), "pre-push-typecheck-"));
  try {
    mkdirSync(path.join(repository, "apps"));
    mkdirSync(path.join(repository, "packages"));

    const result = runCommand(repository, "HEAD");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "pre-push-typecheck: budget exclusion list is stale (budget exclusion names unknown package @stll/web); CI checks the packages\n",
    );
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("a typecheck that runs and fails blocks the command", () => {
  const repository = createRepository({ failing: { typecheck: "exit 7" } });
  try {
    writeFileSync(
      path.join(repository, "packages", "failing", "src", "index.ts"),
      "export const changed = true;\n",
    );
    git(repository, "add", "--all");
    git(repository, "commit", "--quiet", "-m", "change package");

    const result = runCommand(repository);
    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString()).toContain("checking @test/failing");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
