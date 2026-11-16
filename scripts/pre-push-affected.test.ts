import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForExternalState } from "@stll/property-testing/external-state";

import {
  changedPaths,
  descendantPids,
  knipBudgetAffected,
  parsePrePushArgs,
  PRE_PUSH_EXIT,
  prePushCommands,
  rootScriptTests,
  runBounded,
  TOTAL_TIME_CAP_MS,
} from "./pre-push-affected";

const script = path.join(import.meta.dirname, "pre-push-affected.ts");

describe("pre-push affected checks", () => {
  test("selects changed root script tests and the tests beside changed scripts", () => {
    const present = new Set([
      "scripts/ratchet.test.ts",
      "scripts/ci-plan.test.ts",
    ]);
    expect(
      rootScriptTests(
        [
          "scripts/ratchet.ts",
          "scripts/ci-plan.test.ts",
          "scripts/no-test-here.ts",
          "scripts/nested/tool.ts",
          "apps/api/src/index.ts",
          "scripts/ratchet.test.ts",
        ],
        (file) => present.has(file),
      ),
    ).toEqual(["scripts/ci-plan.test.ts", "scripts/ratchet.test.ts"]);
  });

  test("generates first, then runs the affected code check, script tests and the dead-export budget", () => {
    expect(
      prePushCommands({
        base: "origin/main",
        scriptTests: ["scripts/a.test.ts"],
        knipBudget: true,
      }),
    ).toEqual([
      ["bun", "run", "generate"],
      [
        "bun",
        "scripts/code-check-affected.ts",
        "--base",
        "origin/main",
        "--skip-full-fallback",
      ],
      ["bun", "test", "--timeout", "35000", "scripts/a.test.ts"],
      ["bun", "run", "check:knip-exports"],
    ]);
  });

  test("runs no test or budget command when neither is affected", () => {
    expect(
      prePushCommands({
        base: "origin/main",
        scriptTests: [],
        knipBudget: false,
      }),
    ).toHaveLength(2);
  });

  test("any source, manifest or budget change runs the dead-export budget", () => {
    for (const file of [
      "apps/web/src/components/inspector/inspector-store-types.ts",
      "apps/web/src/routes/index.tsx",
      "packages/cli/bin/stella.mjs",
      "scripts/tool.cjs",
      "apps/api/package.json",
      "package.json",
      "knip.json",
      "scripts/knip-exports-baseline.json",
    ]) {
      expect(knipBudgetAffected([file])).toBe(true);
    }
    // A deleted caller can leave an export unused: deletions are in the
    // changed paths too, so they count like any other source change.
    expect(knipBudgetAffected(["README.md", "apps/web/src/old.ts"])).toBe(true);
  });

  test("documentation, styles and data alone skip the dead-export budget", () => {
    expect(
      knipBudgetAffected([
        "README.md",
        "apps/web/src/styles.css",
        "apps/api/src/fixtures/sample.json",
        ".github/workflows/ci.yml",
      ]),
    ).toBe(false);
  });

  test("a missing base ref means the checks could not run, not that they failed", () => {
    const result = Bun.spawnSync(
      ["bun", script, "--base", "refs/missing/pre-push-base", "--dry-run"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(PRE_PUSH_EXIT.unavailable);
    expect(result.stderr.toString()).toContain("git merge-base");
  });

  test("a push with no changes against its base passes without running checks", () => {
    const result = Bun.spawnSync(["bun", script, "--base", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(PRE_PUSH_EXIT.passed);
    expect(result.stdout.toString()).toBe(
      "pre-push affected: no changes against the base\n",
    );
  });

  test("a deletion-only push still selects the checks", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "pre-push-affected-"));
    try {
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", "-C", repo, ...args], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env["PATH"],
            HOME: repo,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
          },
        });
        expect(result.exitCode).toBe(0);
      };
      git("init", "-q", "-b", "main");
      mkdirSync(path.join(repo, "scripts"));
      writeFileSync(path.join(repo, "scripts/tool.ts"), "export {};\n");
      writeFileSync(path.join(repo, "scripts/tool.test.ts"), "export {};\n");
      git("add", ".");
      git("commit", "-q", "--no-gpg-sign", "-m", "base");
      git("branch", "base");
      git("rm", "-q", "scripts/tool.ts");
      git("commit", "-q", "--no-gpg-sign", "-m", "delete");

      const changed = changedPaths("base", repo);
      expect(changed).toEqual(["scripts/tool.ts"]);
      expect(
        rootScriptTests(changed ?? [], (file) =>
          existsSync(path.join(repo, file)),
        ),
      ).toEqual(["scripts/tool.test.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("finds every descendant in a process snapshot", () => {
    const snapshot = [
      "  10   1",
      "  11  10",
      "  12  11",
      "  13  10",
      "  20   1",
      "",
    ].join("\n");
    expect(descendantPids(snapshot, 10)).toEqual([11, 13, 12]);
    expect(descendantPids(snapshot, 20)).toEqual([]);
  });

  test("a command that outlives its time cap is stopped with its descendants", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pre-push-cap-"));
    const pidFile = path.join(directory, "grandchild");
    try {
      const result = await runBounded(
        ["bash", "-c", `sleep 30 & echo $! > "${pidFile}"; wait`],
        { timeoutMs: 500, cwd: directory },
      );
      expect(result.timedOut).toBe(true);
      expect(result.status).not.toBe(0);
      const grandchild = Number(readFileSync(pidFile, "utf-8").trim());
      // A killed orphan stays a zombie until its new parent reaps it, and a
      // container's first process may never do that; only a live state counts.
      const running = () => {
        const state = Bun.spawnSync(
          ["ps", "-o", "stat=", "-p", String(grandchild)],
          {
            stdout: "pipe",
            stderr: "ignore",
          },
        )
          .stdout.toString()
          .trim();
        return state !== "" && !state.startsWith("Z");
      };
      await waitForExternalState({
        description: `grandchild ${String(grandchild)} stops running`,
        intervalMs: 50,
        read: () => !running(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the total time cap is ten minutes", () => {
    expect(TOTAL_TIME_CAP_MS).toBe(600_000);
  });

  test("parses the base and dry-run flags and rejects anything else", () => {
    expect(parsePrePushArgs([])).toEqual({
      base: "origin/main",
      dryRun: false,
    });
    expect(parsePrePushArgs(["--base", "main", "--dry-run"])).toEqual({
      base: "main",
      dryRun: true,
    });
    expect(() => parsePrePushArgs(["--base"])).toThrow(
      "--base requires a git ref",
    );
    expect(() => parsePrePushArgs(["--fast"])).toThrow(
      "Unknown argument: --fast",
    );
  });
});
