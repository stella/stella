import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkOnlineWorkLifecycle,
  findMigrateStepsWithoutMode,
  ONLINE_WORK_LIFECYCLE_PATH,
  type OnlineWorkLifecycleGit,
  parseOnlineWorkLifecycle,
} from "./check-online-work-lifecycle";
import { parseWorkflowYaml } from "./check-workflow-yaml";

type States = Readonly<Record<string, "pending" | "finalized">>;

const CONSTANT = { pending: "PENDING", finalized: "FINALIZED" } as const;

const source = (entries: States) =>
  `export const ONLINE_WORK_LIFECYCLE = {\n${Object.entries(entries)
    .map(([name, state]) => `  ${name}: ${CONSTANT[state]},`)
    .join("\n")}\n} as const;\n`;

const lifecycleOf = (entries: States) =>
  Object.fromEntries(
    Object.entries(entries).map(([name, state]) => [name, { state }]),
  );

type FakeGitOptions = {
  base: States | null;
  tags?: readonly string[];
  calls?: string[][];
};

const fakeGit =
  ({ base, tags = [], calls = [] }: FakeGitOptions): OnlineWorkLifecycleGit =>
  (args) => {
    calls.push([...args]);
    const command = args.at(0);
    switch (command) {
      case "show":
        return base === null
          ? { exitCode: 128, stdout: "", stderr: "missing" }
          : { exitCode: 0, stdout: source(base), stderr: "" };
      case "log":
        return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      case "tag":
        return { exitCode: 0, stdout: `${tags.join("\n")}\n`, stderr: "" };
      case undefined:
        throw new Error("Missing fake git command");
      default:
        throw new Error(`Unexpected fake git command: ${command}`);
    }
  };

const check = (current: States, options: FakeGitOptions) =>
  checkOnlineWorkLifecycle({
    git: fakeGit(options),
    base: "base",
    lifecycle: lifecycleOf(current),
    source: source(current),
  });

describe("online work lifecycle release check", () => {
  test("finalizes work once a stable tag contains its registration", () => {
    const calls: string[][] = [];
    expect(
      check(
        { work_idx: "finalized" },
        { base: { work_idx: "pending" }, tags: ["v1.2.3"], calls },
      ),
    ).toEqual([]);
    expect(calls.find((call) => call.at(0) === "log")).toEqual([
      "log",
      "--reverse",
      "--format=%H",
      "--pickaxe-regex",
      '-S[[:space:]"]work_idx"?: ',
      "--",
      ONLINE_WORK_LIFECYCLE_PATH,
    ]);
  });

  test("a pre-release tag does not finalize", () => {
    expect(
      check(
        { work_idx: "finalized" },
        { base: { work_idx: "pending" }, tags: ["v1.2.3-rc.1"] },
      ),
    ).toEqual([
      `work_idx: finalize it in a PR after a stable release contains ${"a".repeat(7)}`,
    ]);
  });

  test("new work must start pending", () => {
    expect(check({ work_idx: "finalized" }, { base: {} })).toHaveLength(1);
    expect(check({ work_idx: "pending" }, { base: {} })).toEqual([]);
  });

  test("unchanged and already finalized work passes without a lookup", () => {
    const calls: string[][] = [];
    expect(
      check(
        { work_idx: "finalized" },
        { base: { work_idx: "finalized" }, calls },
      ),
    ).toEqual([]);
    expect(calls.filter((call) => call.at(0) !== "show")).toEqual([]);
  });

  test("the PR that introduces the lifecycle file registers existing work", () => {
    expect(check({ work_idx: "finalized" }, { base: null })).toEqual([]);
  });

  test("an entry the file does not spell as one line fails instead of being skipped", () => {
    const wrapped = `export const ONLINE_WORK_LIFECYCLE = {\n  long_work_idx: {\n    state: "finalized",\n  },\n};\n`;
    expect(parseOnlineWorkLifecycle(wrapped).size).toBe(0);
    expect(
      checkOnlineWorkLifecycle({
        git: fakeGit({ base: {} }),
        base: "base",
        lifecycle: lifecycleOf({ long_work_idx: "finalized" }),
        source: wrapped,
      }),
    ).toEqual([
      "long_work_idx: write its entry as one `long_work_idx: PENDING,` or `long_work_idx: FINALIZED,` line",
    ]);
  });
});

describe("against a real repository", () => {
  const run = (cwd: string, args: readonly string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  const commit = (cwd: string, states: States, message: string) => {
    writeFileSync(path.join(cwd, ONLINE_WORK_LIFECYCLE_PATH), source(states));
    run(cwd, ["add", "."]);
    run(cwd, ["commit", "-q", "--no-gpg-sign", "-m", message]);
    return run(cwd, ["rev-parse", "HEAD"]).stdout.trim();
  };

  test("finds the registering commit, not one that names a longer entry", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "online-work-lifecycle-"));
    try {
      run(cwd, ["init", "-q"]);
      mkdirSync(path.join(cwd, path.dirname(ONLINE_WORK_LIFECYCLE_PATH)), {
        recursive: true,
      });
      commit(cwd, { prefix_work_idx: "finalized" }, "longer name first");
      const registered = commit(
        cwd,
        { prefix_work_idx: "finalized", work_idx: "pending" },
        "register",
      );
      const pendingBase = run(cwd, ["rev-parse", "HEAD"]).stdout.trim();
      const git: OnlineWorkLifecycleGit = (args) => run(cwd, args);
      const finalized = {
        prefix_work_idx: "finalized",
        work_idx: "finalized",
      } as const;
      const finalize = () =>
        checkOnlineWorkLifecycle({
          git,
          base: pendingBase,
          lifecycle: lifecycleOf(finalized),
          source: source(finalized),
        });

      expect(finalize()).toEqual([
        `work_idx: finalize it in a PR after a stable release contains ${registered.slice(0, 7)}`,
      ]);
      run(cwd, ["tag", "v0.1.0-rc.1", registered]);
      expect(finalize()).toHaveLength(1);
      run(cwd, ["tag", "v0.1.0", registered]);
      expect(finalize()).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("CI migrate steps name their online work mode", () => {
  const workflow = (env: {
    workflow?: boolean;
    job?: boolean;
    step?: boolean;
  }) => ({
    ...(env.workflow === true && {
      env: { STELLA_MIGRATE_ONLINE_WORK: "build_finalized" },
    }),
    jobs: {
      suites: {
        ...(env.job === true && {
          env: { STELLA_MIGRATE_ONLINE_WORK: "build_finalized" },
        }),
        steps: [
          { name: "Checkout", uses: "actions/checkout@v4" },
          {
            name: "Prepare the database",
            run: "(cd apps/api && bun run src/db/migrate.ts)",
            ...(env.step === true && {
              env: { STELLA_MIGRATE_ONLINE_WORK: "build_all" },
            }),
          },
          { name: "Seed", run: "bun --filter @stll/api db:migrate" },
        ],
      },
    },
  });

  test("a step that migrates without a mode is named", () => {
    expect(
      findMigrateStepsWithoutMode([{ file: "ci.yml", workflow: workflow({}) }]),
    ).toEqual([
      'ci.yml suites "Prepare the database": runs migrate without STELLA_MIGRATE_ONLINE_WORK; set build_finalized or build_all',
      'ci.yml suites "Seed": runs migrate without STELLA_MIGRATE_ONLINE_WORK; set build_finalized or build_all',
    ]);
  });

  test("the step's own env covers only that step", () => {
    expect(
      findMigrateStepsWithoutMode([
        { file: "ci.yml", workflow: workflow({ step: true }) },
      ]),
    ).toEqual([
      'ci.yml suites "Seed": runs migrate without STELLA_MIGRATE_ONLINE_WORK; set build_finalized or build_all',
    ]);
  });

  test("a job or workflow env covers every step in it", () => {
    for (const scope of [{ job: true }, { workflow: true }]) {
      expect(
        findMigrateStepsWithoutMode([
          { file: "ci.yml", workflow: workflow(scope) },
        ]),
      ).toEqual([]);
    }
  });

  test("every repository workflow names the mode wherever it migrates", async () => {
    const files = [
      ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync(),
    ].toSorted();
    const workflows = await Promise.all(
      files.map(async (file) => ({
        file,
        workflow: await parseWorkflowYaml(file),
      })),
    );
    expect(findMigrateStepsWithoutMode(workflows)).toEqual([]);
  });
});
