import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { definitelyFalse } from "./github-expression";
import {
  MAIN_ONLY_BUN_CACHE_SAVE,
  usesDefaultCacheScope,
  workflowCacheProblems,
} from "./workflow-cache-policy.ts";

// A workflow_run workflow runs in the default branch's context, with its
// secrets and cache scope, for any completed run of a workflow with the
// listed name. A name is not an identity, so every job must establish where
// the triggering run came from before it does anything: the same repository,
// the exact workflow file, and the events that workflow is meant to run on.
// A job may instead depend on such a job, as long as its condition cannot run
// it when that job was skipped.

const WORKFLOWS_URL = new URL("../.github/workflows/", import.meta.url);
const RELEASE_CHAIN_MARKER = "# release-chain-alert";
const PROMOTE_DISPATCH_ACTION = "uses: ./.github/actions/promote-dispatch";
// Pin the current scan so missing or newly added entry points need review.
const WORKFLOW_RUN_WORKFLOWS = [
  "bot-refresh-auto-merge.yml",
  "cla.yml",
  "publish-npm.yml",
  "release-desktop.yml",
  "scheduled-run-alerts.yml",
] as const;

// A source check holds when the job's condition is false, whatever every
// other value is, as soon as ONE of these three facts about the triggering run
// is wrong. Evaluated with three-valued logic, so `||`, `!=` or a check that
// only mentions a field cannot pass.
const RUN = "github.event.workflow_run";
const SOURCE_CHECKS = [
  {
    name: "the triggering run's repository",
    values: {
      "github.repository": "owner/repo",
      [`${RUN}.head_repository.full_name`]: "fork/repo",
    },
  },
  {
    name: "the triggering workflow file",
    values: { [`${RUN}.path`]: ".github/workflows/untrusted.yml" },
  },
  {
    name: "the triggering event",
    values: { [`${RUN}.event`]: "untrusted_event" },
  },
] as const;

const failedSourceChecks = (condition: string) =>
  SOURCE_CHECKS.filter(
    ({ values }) =>
      condition.trim() === "" ||
      !definitelyFalse(condition, {
        values: { "github.event_name": "workflow_run", ...values },
        status: {
          always: true,
          success: true,
          failure: false,
          cancelled: false,
        },
      }),
  );

/**
 * Whether a dependent job's condition can run it although every gated job it
 * needs was skipped: those results are 'skipped' and their outputs empty.
 */
const runsAfterSkippedGate = (condition: string, gatedNeeds: string[]) =>
  !definitelyFalse(condition, {
    values: Object.fromEntries(
      gatedNeeds.map((need) => [`needs.${need}.result`, "skipped"]),
    ),
    fallback: (path) =>
      gatedNeeds.some((need) => path.startsWith(`needs.${need}.outputs.`))
        ? ""
        : undefined,
    status: { always: true },
  });

/** Status functions that run a job even when a job it needs was skipped. */
const RUNS_AFTER_SKIP = /\b(always|failure|cancelled)\(\)/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const triggers = (on: unknown): string[] => {
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.filter((event): event is string => typeof event === "string");
  }
  return isRecord(on) ? Object.keys(on) : [];
};

const needsOf = (job: Record<string, unknown>): string[] => {
  const needs = job["needs"];
  if (typeof needs === "string") {
    return [needs];
  }
  return Array.isArray(needs)
    ? needs.filter((name): name is string => typeof name === "string")
    : [];
};

const conditionOf = (job: Record<string, unknown>): string =>
  typeof job["if"] === "string" ? job["if"] : "";

/** Why the jobs of a workflow_run workflow could act on an untrusted run. */
const trustProblems = (workflow: unknown): string[] => {
  if (
    !isRecord(workflow) ||
    !triggers(workflow["on"]).includes("workflow_run")
  ) {
    return [];
  }
  const jobs = isRecord(workflow["jobs"]) ? workflow["jobs"] : {};
  const gated = new Set<string>();
  const problems = new Map<string, string>();
  // Resolve in dependency order; a cycle or unknown need stays unresolved.
  let progress = true;
  while (progress) {
    progress = false;
    for (const [name, job] of Object.entries(jobs)) {
      if (gated.has(name) || problems.has(name) || !isRecord(job)) {
        continue;
      }
      const condition = conditionOf(job);
      const missing = failedSourceChecks(condition);
      if (missing.length === 0) {
        gated.add(name);
        progress = true;
        continue;
      }
      const needs = needsOf(job);
      const gatedNeeds = needs.filter((need) => gated.has(need));
      if (needs.some((need) => !gated.has(need) && !problems.has(need))) {
        continue;
      }
      if (gatedNeeds.length === 0) {
        problems.set(
          name,
          `job '${name}' checks neither ${missing.map(({ name: check }) => check).join(", ")} nor needs a job that does`,
        );
      } else if (
        RUNS_AFTER_SKIP.test(condition) &&
        runsAfterSkippedGate(condition, gatedNeeds)
      ) {
        problems.set(
          name,
          `job '${name}' can run after its gated needs were skipped: its status function is not paired with a requirement those skipped jobs cannot meet`,
        );
      } else {
        gated.add(name);
      }
      progress = true;
    }
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (isRecord(job) && !gated.has(name) && !problems.has(name)) {
      problems.set(
        name,
        `job '${name}' depends on a job that is missing or in a cycle`,
      );
    }
  }
  return [...problems.values()];
};

const allWorkflows = () => {
  const root = fileURLToPath(WORKFLOWS_URL);
  return [...new Bun.Glob("*.{yml,yaml}").scanSync({ cwd: root })].map(
    (file) => {
      const source = readFileSync(`${root}/${file}`, "utf-8");
      return { file, source, workflow: Bun.YAML.parse(source) };
    },
  );
};

const workflowRunWorkflows = () =>
  allWorkflows().filter(
    ({ workflow }) =>
      isRecord(workflow) && triggers(workflow["on"]).includes("workflow_run"),
  );

const GATE = [
  "github.event.workflow_run.head_repository.full_name == github.repository",
  "github.event.workflow_run.path == '.github/workflows/release.yml'",
  "contains(fromJSON('[\"push\"]'), github.event.workflow_run.event)",
].join(" && ");

describe("workflow_run trust", () => {
  test("every workflow_run workflow checks where its triggering run came from", () => {
    const workflows = workflowRunWorkflows();
    expect(workflows.map(({ file }) => file).toSorted()).toEqual([
      ...WORKFLOW_RUN_WORKFLOWS,
    ]);
    const problems = workflows.flatMap(({ file, workflow }) =>
      trustProblems(workflow).map((problem) => `${file}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  test("every release-chain workflow is covered by failed-run alerts", () => {
    const workflows = allWorkflows();
    const alerting = workflows.find(
      ({ file }) => file === "scheduled-run-alerts.yml",
    )?.workflow;
    if (!isRecord(alerting) || !isRecord(alerting["on"])) {
      expect.unreachable("scheduled run alerts require workflow_run triggers");
    }
    const workflowRun = alerting["on"]["workflow_run"];
    const jobs = alerting["jobs"];
    if (
      !isRecord(workflowRun) ||
      !Array.isArray(workflowRun["workflows"]) ||
      !isRecord(jobs) ||
      !isRecord(jobs["notify"])
    ) {
      expect.unreachable("scheduled run alerts require a notify job");
    }
    const alertedNames = workflowRun["workflows"];
    const condition = conditionOf(jobs["notify"]);
    const releaseChain = workflows.filter(
      ({ source }) =>
        source.includes(RELEASE_CHAIN_MARKER) ||
        source.includes(PROMOTE_DISPATCH_ACTION),
    );

    for (const { file, workflow } of releaseChain) {
      if (!isRecord(workflow) || typeof workflow["name"] !== "string") {
        expect.unreachable(`${file} requires a workflow name`);
      }
      expect(alertedNames, file).toContain(workflow["name"]);
      for (const event of triggers(workflow["on"])) {
        expect(
          definitelyFalse(condition, {
            values: {
              "github.event_name": "workflow_run",
              "github.repository": "owner/repo",
              "github.event.workflow_run.conclusion": "failure",
              "github.event.workflow_run.event": event,
              "github.event.workflow_run.head_repository.full_name":
                "owner/repo",
              "github.event.workflow_run.path": `.github/workflows/${file}`,
            },
            status: {
              always: true,
              success: true,
              failure: false,
              cancelled: false,
            },
          }),
          `${file}: ${event}`,
        ).toBe(false);
      }
    }
  });

  test("reusable network delivery trusts only the main recorder caller", () => {
    const workflows = allWorkflows();
    const delivery = workflows.find(
      ({ file }) => file === "network-baseline-deliver.yml",
    )?.workflow;
    const recording = workflows.find(
      ({ file }) => file === "network-baseline-record.yml",
    )?.workflow;
    if (
      !isRecord(delivery) ||
      !isRecord(delivery["jobs"]) ||
      !isRecord(recording) ||
      !isRecord(recording["jobs"])
    ) {
      expect.unreachable("network baseline workflows require jobs");
    }
    expect(triggers(delivery["on"])).toEqual(["workflow_call"]);
    expect(recording["jobs"]["deliver"]).toMatchObject({
      uses: "./.github/workflows/network-baseline-deliver.yml",
      needs: "record",
    });
    const job = delivery["jobs"]["deliver"];
    if (!isRecord(job) || typeof job["if"] !== "string") {
      expect.unreachable("reusable delivery requires a caller condition");
    }
    const condition = new Script(`Boolean(${job["if"]})`);
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature",
      "refs/pull/42/merge",
    ]) {
      for (const workflow_ref of [
        "owner/repo/.github/workflows/network-baseline-record.yml@refs/heads/main",
        "owner/repo/.github/workflows/ci.yml@refs/heads/main",
        "owner/repo/.github/workflows/network-baseline-record.yml@refs/heads/feature",
        "fork/repo/.github/workflows/network-baseline-record.yml@refs/heads/main",
      ]) {
        for (const event_name of [
          "schedule",
          "workflow_dispatch",
          "pull_request",
          "pull_request_target",
          "workflow_run",
          "push",
        ]) {
          const permitted =
            ref === "refs/heads/main" &&
            workflow_ref ===
              "owner/repo/.github/workflows/network-baseline-record.yml@refs/heads/main" &&
            (event_name === "schedule" || event_name === "workflow_dispatch");
          expect(
            condition.runInNewContext({
              github: {
                ref,
                workflow_ref,
                event_name,
                repository: "owner/repo",
              },
              format: (pattern: string, repository: string) =>
                pattern.replace("{0}", () => repository),
              fromJSON: JSON.parse,
              contains: (values: unknown[], value: unknown) =>
                values.includes(value),
            }),
          ).toBe(permitted);
        }
      }
    }
  });

  test("rejects a job that trusts the run's name and conclusion alone", () => {
    const workflow = {
      on: {
        workflow_run: {
          workflows: ["Release Artifacts"],
          types: ["completed"],
        },
      },
      jobs: {
        "release-trigger": {
          if: "github.event.workflow_run.conclusion == 'success'",
        },
        pack: { needs: "release-trigger" },
      },
    };
    expect(trustProblems(workflow)).toEqual([
      "job 'release-trigger' checks neither the triggering run's repository, the triggering workflow file, the triggering event nor needs a job that does",
      "job 'pack' checks neither the triggering run's repository, the triggering workflow file, the triggering event nor needs a job that does",
    ]);
  });

  test("each source check is required on its own", () => {
    for (const dropped of GATE.split(" && ")) {
      const condition = GATE.split(" && ")
        .filter((part) => part !== dropped)
        .join(" && ");
      const workflow = {
        on: ["workflow_run"],
        jobs: { only: { if: condition } },
      };
      expect(trustProblems(workflow), dropped).toHaveLength(1);
    }
  });

  test("accepts a gated job and jobs that need it", () => {
    const workflow = {
      on: { workflow_run: {}, workflow_dispatch: {} },
      jobs: {
        resolve: {
          if: `github.event_name == 'workflow_dispatch' || (${GATE})`,
        },
        build: {
          needs: "resolve",
          if: "needs.resolve.outputs.should_build == 'true'",
        },
        publish: {
          needs: ["resolve", "build"],
          if: "always() && needs.build.result == 'success'",
        },
      },
    };
    expect(trustProblems(workflow)).toEqual([]);
  });

  test("rejects a dependent that runs after its gated need was skipped", () => {
    const workflow = {
      on: ["workflow_run"],
      jobs: {
        resolve: { if: GATE },
        report: { needs: "resolve", if: "always()" },
        cleanup: { needs: "resolve", if: "!cancelled()" },
      },
    };
    expect(trustProblems(workflow)).toHaveLength(2);
  });

  test("rejects conditions that only mention the source fields", () => {
    const weakened = [
      // Any one check passing admits the run.
      GATE.split(" && ").join(" || "),
      // A comparison that every run satisfies.
      "github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.path != '' && github.event.workflow_run.event != ''",
      // The repository compared with itself.
      "github.event.workflow_run.head_repository.full_name == github.event.workflow_run.head_repository.full_name && github.event.workflow_run.path == '.github/workflows/release.yml' && github.event.workflow_run.event == 'push'",
      // A trusted alternative that a workflow_run event can reach.
      `github.event.workflow_run.conclusion == 'success' || (${GATE})`,
      // Negated.
      `!(${GATE})`,
    ];
    for (const condition of weakened) {
      const workflow = {
        on: ["workflow_run"],
        jobs: { only: { if: condition } },
      };
      expect(trustProblems(workflow), condition).toHaveLength(1);
    }
  });

  test("rejects dependents whose condition selects a skipped gate", () => {
    for (const condition of [
      "always() && needs.resolve.result == 'skipped'",
      "always() && needs.resolve.outputs.should_build == ''",
      "always() && needs.resolve.result != 'success'",
      "failure() || needs.resolve.outputs.channel != 'prod'",
    ]) {
      const workflow = {
        on: ["workflow_run"],
        jobs: {
          resolve: { if: GATE },
          after: { needs: "resolve", if: condition },
        },
      };
      expect(trustProblems(workflow), condition).toHaveLength(1);
    }
  });

  test("rejects unknown and cyclic needs", () => {
    const workflow = {
      on: ["workflow_run"],
      jobs: { a: { needs: "b" }, b: { needs: "a" }, c: { needs: "missing" } },
    };
    expect(trustProblems(workflow)).toHaveLength(3);
  });

  test("no pull_request_target or workflow_run job uses a cache", () => {
    const workflows = allWorkflows().filter(({ workflow }) =>
      usesDefaultCacheScope(workflow),
    );
    expect(workflows.map(({ file }) => file).toSorted()).toEqual(
      [
        ...WORKFLOW_RUN_WORKFLOWS,
        "network-baseline-request.yml",
        "pr-lint.yml",
      ].toSorted(),
    );
    const problems = workflows.flatMap(({ file, workflow }) =>
      workflowCacheProblems(workflow).map((problem) => `${file}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  test("rejects every cache-saving step shape in a pull_request_target job", () => {
    const steps = [
      { uses: "actions/cache@abc" },
      { uses: "actions/cache/save@abc" },
      { uses: "stella/.github/actions/setup-bun-cached@abc" },
      { uses: "Swatinem/rust-cache@abc" },
      { uses: "oven-sh/setup-bun@abc" },
      { uses: "actions/setup-go@abc" },
      { uses: "actions/setup-node@abc", with: { cache: "npm" } },
      { uses: "./.github/actions/local" },
    ];
    for (const step of steps) {
      const workflow = {
        on: ["pull_request_target"],
        jobs: { a: { steps: [step] } },
      };
      expect(workflowCacheProblems(workflow), step.uses).toHaveLength(1);
    }
    const unreviewed = {
      on: { pull_request_target: {} },
      jobs: { a: { uses: "someone/repo/.github/workflows/x.yml@abc" } },
    };
    expect(workflowCacheProblems(unreviewed)).toHaveLength(1);
  });

  test("accepts steps that cannot save to a cache", () => {
    const workflow = {
      on: ["pull_request_target"],
      jobs: {
        a: {
          steps: [
            { uses: "actions/cache/restore@abc" },
            { uses: "oven-sh/setup-bun@abc", with: { "no-cache": true } },
            { uses: "actions/setup-go@abc", with: { cache: false } },
            { uses: "actions/setup-node@abc" },
            { uses: "actions/github-script@abc" },
            { run: "echo ok" },
          ],
        },
      },
    };
    expect(workflowCacheProblems(workflow)).toEqual([]);
    expect(
      workflowCacheProblems({
        on: ["pull_request"],
        jobs: { a: { steps: [{ uses: "actions/cache@abc" }] } },
      }),
    ).toEqual([]);
  });

  test("ignores workflows without a workflow_run trigger", () => {
    expect(trustProblems({ on: ["push"], jobs: { a: {} } })).toEqual([]);
  });
});

test("publishing tokens and their artifact chain reject cached Bun setup", () => {
  const rawSetup = {
    uses: "oven-sh/setup-bun@fixture",
    with: { "bun-version-file": "package.json" },
  };
  const cachedSetup = {
    ...rawSetup,
    uses: "stella/.github/actions/setup-bun-cached@fixture",
    with: { ...rawSetup.with, save: MAIN_ONLY_BUN_CACHE_SAVE },
  };
  for (const permission of ["contents", "packages", "id-token"]) {
    expect(
      workflowCacheProblems({
        jobs: {
          publish: {
            permissions: { [permission]: "write" },
            steps: [cachedSetup],
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      workflowCacheProblems({
        jobs: {
          publish: {
            permissions: { [permission]: "write" },
            steps: [rawSetup],
          },
        },
      }),
    ).toEqual([]);
  }
  expect(
    workflowCacheProblems({
      permissions: "write-all",
      jobs: { publish: { steps: [cachedSetup] } },
    }),
  ).toHaveLength(1);
  expect(
    workflowCacheProblems({
      permissions: { contents: "write" },
      jobs: {
        ordinary: { permissions: { contents: "read" }, steps: [cachedSetup] },
      },
    }),
  ).toEqual([]);
  for (const needs of ["verify", ["verify"]]) {
    const workflow = {
      jobs: {
        build: {
          steps: [cachedSetup, { uses: "actions/upload-artifact@fixture" }],
        },
        verify: { needs: "build", steps: [] },
        publish: { permissions: { "id-token": "write" }, needs, steps: [] },
        ordinary: { steps: [cachedSetup] },
      },
    };
    expect(workflowCacheProblems(workflow)).toHaveLength(1);
    workflow.jobs.build.steps[0] = rawSetup;
    expect(workflowCacheProblems(workflow)).toEqual([]);
  }
  const consumers = {
    jobs: {
      build: {
        permissions: { contents: "write" },
        steps: [rawSetup, { uses: "actions/upload-artifact@fixture" }],
      },
      externalPublish: {
        steps: [cachedSetup, { uses: "actions/download-artifact@fixture" }],
      },
    },
  };
  expect(workflowCacheProblems(consumers)).toHaveLength(1);
  const artifacts = {
    jobs: {
      build: {
        steps: [cachedSetup, { uses: "actions/upload-artifact@fixture" }],
      },
      publish: {
        permissions: { packages: "write" },
        steps: [{ uses: "actions/download-artifact@fixture" }],
      },
    },
  };
  expect(workflowCacheProblems(artifacts)).toHaveLength(1);
});
