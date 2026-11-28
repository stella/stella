import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectFastPreflightDiff,
  type FastPreflightRunner,
  formatFastPreflightPlan,
  parseNameStatusZ,
  planFastPreflightSteps,
  runFastPreflightSteps,
} from "./verify-fast";

const ids = (steps: ReturnType<typeof planFastPreflightSteps>): string[] =>
  steps.map((step) => step.id);

test("planFastPreflightSteps returns empty plan for empty diff", () => {
  expect(planFastPreflightSteps([], "origin/main")).toEqual([]);
  expect(formatFastPreflightPlan([])).toEqual([
    "verify --fast: no checks needed for current diff",
  ]);
});

test("planFastPreflightSteps runs type-aware oxlint only on changed existing .ts/.tsx files", () => {
  const steps = planFastPreflightSteps(
    ["README.md", "scripts/foo.ts", "apps/web/src/App.tsx", "scripts/gone.ts"],
    "origin/main",
    { deletedFiles: new Set(["scripts/gone.ts"]) },
  );
  expect(ids(steps)).toEqual(["oxlint-type-aware"]);
  expect(steps[0]?.command).toEqual([
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--no-error-on-unmatched-pattern",
    "--type-aware",
    "--type-check",
    "apps/web/src/App.tsx",
    "scripts/foo.ts",
  ]);
});

test("planFastPreflightSteps plans dedupe + lint:ws for bun.lock or any package.json", () => {
  expect(ids(planFastPreflightSteps(["bun.lock"], "origin/main"))).toEqual([
    "dedupe-check",
    "lint-ws",
  ]);
  expect(ids(planFastPreflightSteps(["package.json"], "origin/main"))).toEqual([
    "dedupe-check",
    "lint-ws",
  ]);
  expect(
    ids(planFastPreflightSteps(["apps/web/package.json"], "origin/main")),
  ).toEqual(["dedupe-check", "lint-ws"]);
});

test("planFastPreflightSteps plans api memory batches for api test topology or test-peak-rss.json", () => {
  expect(
    ids(planFastPreflightSteps(["apps/api/test-peak-rss.json"], "origin/main")),
  ).toEqual(["api-memory-batches"]);
  expect(
    ids(planFastPreflightSteps(["apps/api/src/foo.test.ts"], "origin/main")),
  ).toEqual(["oxlint-type-aware", "api-memory-batches"]);
  // Plain modification (not add/delete/rename) skips memory batches when context is provided.
  expect(
    ids(
      planFastPreflightSteps(["apps/api/src/foo.test.ts"], "origin/main", {
        apiTestTopologyChanged: false,
      }),
    ),
  ).toEqual(["oxlint-type-aware"]);
  expect(
    ids(
      planFastPreflightSteps(["apps/api/src/foo.test.ts"], "origin/main", {
        apiTestTopologyChanged: true,
      }),
    ),
  ).toEqual(["oxlint-type-aware", "api-memory-batches"]);
});

test("planFastPreflightSteps plans parser version check for case-law paths with base env", () => {
  for (const file of [
    "apps/api/src/handlers/case-law/search.ts",
    "apps/api/src/lib/case-law/parser.ts",
    "packages/case-law-core/src/index.ts",
  ]) {
    const steps = planFastPreflightSteps([file], "abc1234");
    const parserStep = steps.find((step) => step.id === "parser-versions");
    expect(parserStep).toEqual({
      id: "parser-versions",
      name: "check parser versions",
      command: ["bun", "scripts/check-parser-versions.ts"],
      env: { BASE_SHA: "abc1234", HEAD_SHA: "HEAD" },
    });
  }
});

test("planFastPreflightSteps plans generated-files-guard for generated-files.ts, apps/api/src/lib/**, and packages/**", () => {
  for (const file of [
    "scripts/generated-files.ts",
    "apps/api/src/lib/nested/helper.ts",
    "packages/errors/src/index.ts",
  ]) {
    const steps = planFastPreflightSteps([file], "origin/main");
    expect(ids(steps)).toContain("generated-files-guard");
  }
});

test("planFastPreflightSteps plans ci-checks guards for .github/ci-checks/** and global-rule-inputs.json", () => {
  for (const file of [
    ".github/ci-checks/ci-checks-rest.yml",
    ".github/global-rule-inputs.json",
  ]) {
    expect(ids(planFastPreflightSteps([file], "origin/main"))).toEqual([
      "ci-checks-guards",
    ]);
  }
});

test("planFastPreflightSteps plans design-lint-baseline check", () => {
  expect(
    ids(
      planFastPreflightSteps(
        ["scripts/design-lint-baseline.json"],
        "origin/main",
      ),
    ),
  ).toEqual(["design-lint-baseline"]);
});

test("planFastPreflightSteps plans instruction-references for agent docs or moved/deleted src files", () => {
  for (const file of [
    ".agents/rules.md",
    ".ai/context.md",
    ".claude/CLAUDE.md",
  ]) {
    expect(ids(planFastPreflightSteps([file], "origin/main"))).toEqual([
      "instruction-references",
    ]);
  }
  expect(
    ids(
      planFastPreflightSteps(["apps/web/src/old.ts"], "origin/main", {
        deletedFiles: new Set(["apps/web/src/old.ts"]),
        deletedOrRenamedFiles: new Set(["apps/web/src/old.ts"]),
      }),
    ),
  ).toEqual(["instruction-references"]);
  // Plain modified src file does not trigger instruction-references.
  expect(
    ids(
      planFastPreflightSteps(["apps/web/src/keep.ts"], "origin/main", {
        deletedFiles: new Set(),
        deletedOrRenamedFiles: new Set(),
      }),
    ),
  ).toEqual(["oxlint-type-aware"]);
});

test("planFastPreflightSteps plans module-ownership check", () => {
  for (const file of [
    "scripts/ownership/modules.json",
    "docs/module-ownership/index.md",
  ]) {
    expect(ids(planFastPreflightSteps([file], "origin/main"))).toEqual([
      "module-ownership",
    ]);
  }
});

test("planFastPreflightSteps plans ratchet check for package manifests, scripts/ratchet*, and top-level apps/api/src/lib/*", () => {
  for (const file of [
    "packages/errors/package.json",
    "scripts/ratchet.ts",
    "scripts/ratchet-allowances/foo.json",
    "apps/api/src/lib/top-level.ts",
  ]) {
    const steps = planFastPreflightSteps([file], "deadbeef");
    const ratchet = steps.find((step) => step.id === "ratchet-check");
    expect(ratchet).toEqual({
      id: "ratchet-check",
      name: "ratchet check",
      command: ["bun", "scripts/ratchet.ts", "--check"],
      env: { RATCHET_BASE_REF: "deadbeef" },
    });
  }
  // Deeply nested file under apps/api/src/lib/** should not trigger top-level ratchet check.
  expect(
    ids(
      planFastPreflightSteps(["apps/api/src/lib/sub/deep.ts"], "origin/main"),
    ),
  ).not.toContain("ratchet-check");
});

test("parseNameStatusZ tracks deleted, renamed, and api test topology changes", () => {
  const raw = [
    "M",
    "apps/api/src/existing.test.ts",
    "A",
    "apps/api/src/new.test.ts",
    "D",
    "apps/web/src/removed.ts",
    "R100",
    "apps/web/src/before.ts",
    "apps/web/src/after.ts",
    "",
  ].join("\0");
  const parsed = parseNameStatusZ(raw);
  expect(parsed.apiTestTopologyChanged).toBe(true);
  expect([...parsed.deletedFiles].toSorted()).toEqual([
    "apps/web/src/before.ts",
    "apps/web/src/removed.ts",
  ]);
  expect([...parsed.deletedOrRenamedFiles].toSorted()).toEqual([
    "apps/web/src/after.ts",
    "apps/web/src/before.ts",
    "apps/web/src/removed.ts",
  ]);
});

test("runFastPreflightSteps runs with bounded concurrency and reports failures cleanly", async () => {
  const steps = planFastPreflightSteps(
    ["bun.lock", "scripts/design-lint-baseline.json", ".agents/guide.md"],
    "origin/main",
  );
  let active = 0;
  let peak = 0;
  const gates = steps.map(() => Promise.withResolvers<undefined>());
  let started = 0;
  const runner: FastPreflightRunner = async (step) => {
    const slot = started;
    started += 1;
    active += 1;
    peak = Math.max(peak, active);
    if (slot === 0) {
      await gates[0]?.promise;
    } else if (slot === 1) {
      gates[0]?.resolve(undefined);
    }
    active -= 1;
    return {
      step,
      exitCode: step.id === "lint-ws" ? 1 : 0,
      elapsedMs: 10,
      stdout: step.id === "lint-ws" ? "workspace mismatch\n" : "",
      stderr: "",
    };
  };

  const logs: string[] = [];
  const errors: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await runFastPreflightSteps(steps, runner, 2, {
    log: (line) => {
      logs.push(line);
    },
    error: (line) => {
      errors.push(line);
    },
    writeStdout: (chunk) => {
      stdout.push(chunk);
    },
    writeStderr: (chunk) => {
      stderr.push(chunk);
    },
  });

  expect(status).toBe(1);
  expect(peak).toBeLessThanOrEqual(2);
  expect(logs.some((line) => line.includes("completed 4 steps in"))).toBe(true);
  expect(errors.some((line) => line.includes("1 check failed:"))).toBe(true);
  expect(errors.some((line) => line.includes("bun run lint:ws"))).toBe(true);
  expect(stdout).toEqual(["workspace mismatch\n"]);
  expect(stderr).toEqual([]);
});

test("collectFastPreflightDiff and --fast --list reflect git diff + untracked files", () => {
  const tempRepo = mkdtempSync(path.join(tmpdir(), "stella-verify-fast-"));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: tempRepo,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
    return result.stdout.toString().trim();
  };
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(path.join(tempRepo, "README.md"), "hello\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    // Clean tree -> empty plan.
    const cleanDiff = collectFastPreflightDiff(tempRepo, baseSha);
    expect(cleanDiff.changedFiles).toEqual([]);
    expect(
      planFastPreflightSteps(
        cleanDiff.changedFiles,
        cleanDiff.base,
        cleanDiff.context,
      ),
    ).toEqual([]);

    // Untracked TS file + modified manifest -> planned steps.
    writeFileSync(path.join(tempRepo, "package.json"), "{}\n");
    writeFileSync(path.join(tempRepo, "new-file.ts"), "export const x = 1;\n");
    const dirtyDiff = collectFastPreflightDiff(tempRepo, baseSha);
    expect(dirtyDiff.changedFiles).toEqual(["new-file.ts", "package.json"]);
    const steps = planFastPreflightSteps(
      dirtyDiff.changedFiles,
      dirtyDiff.base,
      dirtyDiff.context,
    );
    expect(ids(steps)).toEqual([
      "oxlint-type-aware",
      "dedupe-check",
      "lint-ws",
    ]);
    expect(formatFastPreflightPlan(steps)).toEqual([
      "fast: oxlint --type-aware --type-check (1 file) — bun --bun oxlint -c oxlint.config.ts --no-error-on-unmatched-pattern --type-aware --type-check new-file.ts",
      "fast: bun dedupe --check — bun --no-env-file dedupe --check",
      "fast: bun run lint:ws — bun run lint:ws",
    ]);
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});
