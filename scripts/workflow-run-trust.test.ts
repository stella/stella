import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { definitelyFalse, evaluate } from "./github-expression";
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
  "ci-runner-loss-retry.yml",
  "cla.yml",
  "publish-npm.yml",
  "release-desktop.yml",
  "release-tag.yml",
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
    fallback: (expressionPath) =>
      gatedNeeds.some((need) =>
        expressionPath.startsWith(`needs.${need}.outputs.`),
      )
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

const PRIVILEGED_MANUAL_JOB =
  /(?:TAURI_SIGNING_PRIVATE_KEY|AZURE_CLIENT_SECRET|STELLA_[A-Z_]*PRIVATE_KEY|DOCKERHUB_TOKEN|POSTHOG_CLI_API_KEY|create-github-app-token|"(?:attestations|artifact-metadata|deployments|id-token|packages|pages)"\s*:\s*"write")/u;

const canRunOnFeatureDispatch = (
  name: string,
  jobs: Record<string, unknown>,
  seen = new Set<string>(),
): boolean => {
  if (seen.has(name)) {
    return true;
  }
  const job = jobs[name];
  if (!isRecord(job)) {
    return true;
  }
  const condition = conditionOf(job);
  if (
    condition.trim() !== "" &&
    definitelyFalse(condition, {
      values: {
        "github.event_name": "workflow_dispatch",
        "github.ref": "refs/heads/feature",
        "github.repository": "stella/stella",
      },
      fallback: (expressionPath) =>
        expressionPath.startsWith("github.event.workflow_run.")
          ? ""
          : undefined,
      status: {
        always: true,
        success: true,
        failure: false,
        cancelled: false,
      },
    })
  ) {
    return false;
  }
  const nextSeen = new Set(seen).add(name);
  const gatedNeeds = needsOf(job).filter(
    (need) => !canRunOnFeatureDispatch(need, jobs, nextSeen),
  );
  if (gatedNeeds.length === 0) {
    return true;
  }
  return (
    RUNS_AFTER_SKIP.test(condition) &&
    runsAfterSkippedGate(condition, gatedNeeds)
  );
};

const featureDispatchPrivilegeProblems = (
  file: string,
  workflow: unknown,
): string[] => {
  if (
    !isRecord(workflow) ||
    !triggers(workflow["on"]).includes("workflow_dispatch")
  ) {
    return [];
  }
  const jobs = isRecord(workflow["jobs"]) ? workflow["jobs"] : {};
  return Object.entries(jobs).flatMap(([name, job]) =>
    isRecord(job) &&
    PRIVILEGED_MANUAL_JOB.test(JSON.stringify(job)) &&
    canRunOnFeatureDispatch(name, jobs)
      ? [`${file}: privileged job '${name}' can run from a feature ref`]
      : [],
  );
};

// These pre-existing diagnostic and maintenance paths intentionally run on a
// selected ref. Keep each job explicit so new privilege-bearing jobs fail the
// guard, and remove an allowance when that path moves behind a protected-ref
// dispatcher.
const FEATURE_DISPATCH_PRIVILEGE_ALLOWANCES = {
  "audit-branch-protection.yml: privileged job 'audit-fork-approval' can run from a feature ref":
    "Exercises the configured fork-approval policy without mutating it.",
  "catalogue-upstream.yml: privileged job 'catalogue-upstream' can run from a feature ref":
    "Runs the upstream catalogue comparison for an operator-selected revision.",
  "ci.yml: privileged job 'e2e-production-shard' can run from a feature ref":
    "Runs an operator-selected production-mode browser shard.",
  "ci.yml: privileged job 'e2e-vite-canary' can run from a feature ref":
    "Runs the Vite compatibility canary for an operator-selected revision.",
  "ci.yml: privileged job 'marketing-screenshots' can run from a feature ref":
    "Runs screenshot validation for an operator-selected revision.",
  "ci.yml: privileged job 'route-smoke' can run from a feature ref":
    "Runs route smoke checks for an operator-selected revision.",
  "cla.yml: privileged job 'verify-signatures' can run from a feature ref":
    "Supports a manual signature-policy diagnostic.",
  "dated-waiver-healing.yml: privileged job 'heal' can run from a feature ref":
    "Supports a dry-run waiver-healing diagnostic.",
  "dependency-audit.yml: privileged job 'remediate' can run from a feature ref":
    "Supports an operator-triggered dependency remediation branch.",
  "main-heavy.yml: privileged job 'suites' can run from a feature ref":
    "Runs heavy CI suites for an explicitly selected revision.",
  "main-pr-depth.yml: privileged job 'suites' can run from a feature ref":
    "Runs pull-request depth suites for an explicitly selected revision.",
  "model-catalog-check.yml: privileged job 'model-catalog-check' can run from a feature ref":
    "Supports a manual model-catalog compatibility diagnostic.",
  "nightly-test.yml: privileged job 'marketing-screenshots' can run from a feature ref":
    "Runs the nightly screenshot suite for an operator-selected revision.",
  "quarantine-prune.yml: privileged job 'prune' can run from a feature ref":
    "Supports a dry-run quarantine maintenance diagnostic.",
} as const;

// Events that start a run nobody is watching. Pull request, merge queue and
// manual dispatch runs report to the person who started them.
const UNATTENDED_EVENTS = new Set([
  "schedule",
  "push",
  "workflow_run",
  "deployment_status",
  "delete",
]);

// Unattended workflows that deliberately send no failed-run alert. Remove an
// entry when its workflow becomes alerted or attended; the guard fails on a
// stale one.
const UNALERTED_UNATTENDED_WORKFLOWS: Record<string, string> = {
  "bot-refresh-auto-merge.yml":
    "Runs after each pull request's checks; a failure affects one bot pull request and shows on it.",
  "ci-runner-loss-retry.yml":
    "Runs after a failed pull request run; if the retry fails, that pull request's own red CI still shows on it.",
  "cla.yml":
    "Its workflow_run leg posts the signature status on the contributor's pull request, where a failure shows.",
  "scheduled-run-alerts.yml":
    "The alerting workflow itself cannot report its own failed delivery.",
};

const workflowOn = (file: string, workflow: unknown) => {
  if (!isRecord(workflow)) {
    expect.unreachable(`${file} requires a workflow`);
  }
  return workflow["on"];
};

const failedRunAlerting = (workflows: ReturnType<typeof allWorkflows>) => {
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
  const alertedNames: unknown[] = workflowRun["workflows"];
  const condition = conditionOf(jobs["notify"]);
  // GitHub starts the alert run for a listed workflow name; the notify
  // condition must then let a failed run of that file and event through.
  const alerts = (file: string, workflow: unknown, event: string) =>
    isRecord(workflow) &&
    alertedNames.includes(workflow["name"]) &&
    !definitelyFalse(condition, {
      values: {
        "github.event_name": "workflow_run",
        "github.repository": "owner/repo",
        "github.event.workflow_run.conclusion": "failure",
        "github.event.workflow_run.event": event,
        "github.event.workflow_run.head_repository.full_name": "owner/repo",
        "github.event.workflow_run.path": `.github/workflows/${file}`,
      },
      status: {
        always: true,
        success: true,
        failure: false,
        cancelled: false,
      },
    });
  return { alerts };
};

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

  test("high-volume workflow_run entry points filter branches before queuing", () => {
    const workflows = allWorkflows();
    const trigger = (file: string) => {
      const workflow = workflows.find((entry) => entry.file === file)?.workflow;
      if (!isRecord(workflow) || !isRecord(workflow["on"])) {
        expect.unreachable(`${file} requires mapped triggers`);
      }
      return workflow["on"]["workflow_run"];
    };
    expect(trigger("scheduled-run-alerts.yml")).toMatchObject({
      branches: ["main"],
      types: ["completed"],
    });
    expect(trigger("bot-refresh-auto-merge.yml")).toMatchObject({
      branches: ["chore/provenance-update", "bot/model-catalog-refresh"],
      types: ["completed"],
    });
  });

  test("every release-chain workflow is covered by failed-run alerts", () => {
    const workflows = allWorkflows();
    const alerting = failedRunAlerting(workflows);
    const releaseChain = workflows.filter(
      ({ source }) =>
        source.includes(RELEASE_CHAIN_MARKER) ||
        source.includes(PROMOTE_DISPATCH_ACTION),
    );

    for (const { file, workflow } of releaseChain) {
      for (const event of triggers(workflowOn(file, workflow))) {
        expect(
          alerting.alerts(file, workflow, event),
          `${file}: ${event}`,
        ).toBe(true);
      }
    }
  });

  test("every unattended workflow is covered by failed-run alerts", () => {
    const workflows = allWorkflows();
    const alerting = failedRunAlerting(workflows);
    const missing: string[] = [];
    const unattendedFiles: string[] = [];
    for (const { file, workflow } of workflows) {
      const events = triggers(workflowOn(file, workflow)).filter((event) =>
        UNATTENDED_EVENTS.has(event),
      );
      if (events.length === 0) {
        continue;
      }
      unattendedFiles.push(file);
      if (Object.hasOwn(UNALERTED_UNATTENDED_WORKFLOWS, file)) {
        continue;
      }
      for (const event of events) {
        if (!alerting.alerts(file, workflow, event)) {
          missing.push(`${file}: ${event}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // An exemption names an unattended workflow that is really left out,
    // so a stale entry fails here instead of lingering.
    for (const [file, reason] of Object.entries(
      UNALERTED_UNATTENDED_WORKFLOWS,
    )) {
      expect(unattendedFiles, file).toContain(file);
      expect(reason.length, file).toBeGreaterThan(20);
      const workflow = workflows.find((entry) => entry.file === file)?.workflow;
      expect(
        triggers(workflowOn(file, workflow))
          .filter((event) => UNATTENDED_EVENTS.has(event))
          .some((event) => alerting.alerts(file, workflow, event)),
        file,
      ).toBe(false);
    }
  });

  test("the unattended-workflow guard reports a workflow missing from alerts", () => {
    const alerting = failedRunAlerting(allWorkflows());
    const unlisted = { name: "Unlisted nightly", on: { schedule: [] } };
    expect(alerting.alerts("unlisted-nightly.yml", unlisted, "schedule")).toBe(
      false,
    );
    const nightly = allWorkflows().find(
      ({ file }) => file === "nightly-test.yml",
    )?.workflow;
    expect(alerting.alerts("nightly-test.yml", nightly, "schedule")).toBe(true);
    // Listed by name but run from another path: the condition refuses it.
    expect(alerting.alerts("renamed-nightly.yml", nightly, "schedule")).toBe(
      false,
    );
    expect(alerting.alerts("nightly-test.yml", nightly, "pull_request")).toBe(
      false,
    );
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
        "release-proof.yml",
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

// GitHub creates no workflow_run event for a run that GITHUB_TOKEN started,
// so a workflow_run trigger never fires for a workflow this repository
// dispatches with GITHUB_TOKEN, and nothing reports it. The dispatching run
// starts the next step itself and follows it instead. Over-approximated: any
// step that calls a dispatch endpoint and names a followed workflow's file
// (or builds the file name at run time) counts, unless its token is a
// GitHub App token minted in the job.
const DISPATCH_CALL =
  /createWorkflowDispatch|\/dispatches\b|\bgh workflow run\b/u;
const COMPUTED_WORKFLOW_FILE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\.ya?ml\b/u;
const APP_TOKEN = /^\$\{\{\s*steps\.[\w-]+\.outputs\.token\s*\}\}$/u;
// Dispatches whose targets only the failed-run alerting workflow follows,
// keyed by `<workflow file>#<step name>`, with the workflows each starts.
const ALERTING_WORKFLOW = "scheduled-run-alerts.yml";
const ALERT_ONLY_TOKEN_DISPATCHES: Record<string, string[]> = {
  "network-baseline-request.yml#Request main recording": [
    "network-baseline-record.yml",
  ],
  "release.yml#Dispatch release-health.yml": ["release-health.yml"],
};

// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");

type DispatchSite = { site: string; targets: string[]; computed: boolean };

/** Followed workflow file -> the workflow_run workflows that follow it. */
const followersOf = (
  workflows: { file: string; workflow: unknown }[],
): Map<string, string[]> => {
  const fileByName = new Map<string, string>();
  for (const { file, workflow } of workflows) {
    if (isRecord(workflow) && typeof workflow["name"] === "string") {
      fileByName.set(workflow["name"], file);
    }
  }
  const followers = new Map<string, string[]>();
  for (const { file: follower, workflow } of workflows) {
    const on = isRecord(workflow) ? workflow["on"] : undefined;
    const trigger = isRecord(on) ? on["workflow_run"] : undefined;
    const names = isRecord(trigger) ? trigger["workflows"] : undefined;
    for (const name of Array.isArray(names) ? names : []) {
      const file = fileByName.get(String(name));
      if (file !== undefined) {
        followers.set(file, [...(followers.get(file) ?? []), follower]);
      }
    }
  }
  return followers;
};

const tokenDispatchesOfFollowed = (
  workflows: { file: string; workflow: unknown }[],
): DispatchSite[] => {
  const followed = [...followersOf(workflows).keys()];
  const sites: DispatchSite[] = [];
  for (const { file, workflow } of workflows) {
    const jobs =
      isRecord(workflow) && isRecord(workflow["jobs"]) ? workflow["jobs"] : {};
    for (const job of Object.values(jobs)) {
      const steps =
        isRecord(job) && Array.isArray(job["steps"]) ? job["steps"] : [];
      for (const step of steps) {
        if (!isRecord(step)) {
          continue;
        }
        const text = JSON.stringify(step);
        if (!DISPATCH_CALL.test(text)) {
          continue;
        }
        const tokens = [
          isRecord(step["with"]) ? step["with"]["github-token"] : undefined,
          isRecord(step["env"]) ? step["env"]["GH_TOKEN"] : undefined,
          isRecord(step["env"]) ? step["env"]["GITHUB_TOKEN"] : undefined,
        ].filter((token) => token !== undefined);
        if (
          tokens.length > 0 &&
          tokens.every(
            (token) => typeof token === "string" && APP_TOKEN.test(token),
          )
        ) {
          continue;
        }
        const computed = COMPUTED_WORKFLOW_FILE.test(text);
        const targets = computed
          ? followed
          : followed.filter((target) => text.includes(target));
        if (targets.length > 0) {
          sites.push({
            site: `${file}#${String(step["name"])}`,
            targets: targets.toSorted(),
            computed,
          });
        }
      }
    }
  }
  return sites;
};

describe("a followed run is never started with GITHUB_TOKEN", () => {
  test("no workflow_run trigger follows a workflow dispatched with GITHUB_TOKEN", () => {
    const workflows = allWorkflows();
    const sites = tokenDispatchesOfFollowed(workflows);
    expect(
      sites
        .filter(({ site }) => !Object.hasOwn(ALERT_ONLY_TOKEN_DISPATCHES, site))
        .map(({ site, targets }) => `${site} -> ${targets.join(", ")}`),
    ).toEqual([]);
    // An exemption names a dispatch that still exists, so a stale entry
    // fails here instead of lingering.
    expect(Object.keys(ALERT_ONLY_TOKEN_DISPATCHES).toSorted()).toEqual(
      sites.map(({ site }) => site).toSorted(),
    );
    const followers = followersOf(workflows);
    for (const { site, targets, computed } of sites) {
      const declared = ALERT_ONLY_TOKEN_DISPATCHES[site] ?? [];
      // A file name built at run time cannot be read here; the entry
      // declares it, and every declared target is checked below.
      if (!computed) {
        expect(declared, site).toEqual(targets);
      }
      for (const target of declared) {
        expect(followers.get(target), `${site} -> ${target}`).toEqual([
          ALERTING_WORKFLOW,
        ]);
      }
    }
  });

  const fixture = (step: Record<string, unknown>) => [
    {
      file: "publish.yml",
      workflow: {
        name: "Publish",
        on: { workflow_run: { workflows: ["Build"] } },
        jobs: {},
      },
    },
    { file: "build.yml", workflow: { name: "Build", on: "workflow_dispatch" } },
    {
      file: "start.yml",
      workflow: { jobs: { start: { steps: [{ name: "Start", ...step }] } } },
    },
  ];

  test("reports every token shape that starts the followed workflow", () => {
    for (const step of [
      {
        uses: "actions/github-script@fixture",
        with: {
          script:
            "github.rest.actions.createWorkflowDispatch({ workflow_id: 'build.yml' })",
        },
      },
      {
        run: "gh api --method POST repos/o/r/actions/workflows/build.yml/dispatches",
        env: { GH_TOKEN: githubExpression("github.token") },
      },
      {
        run: "gh workflow run build.yml",
        env: { GH_TOKEN: githubExpression("secrets.GITHUB_TOKEN") },
      },
      {
        run: 'for workflow in build; do gh workflow run "$workflow.yml"; done',
        env: { GH_TOKEN: githubExpression("github.token") },
      },
      {
        run: "gh workflow run build.yml",
        env: {
          GH_TOKEN: githubExpression("steps.app.outputs.token"),
          GITHUB_TOKEN: githubExpression("github.token"),
        },
      },
    ]) {
      expect(
        tokenDispatchesOfFollowed(fixture(step)).map(({ site, targets }) => ({
          site,
          targets,
        })),
        JSON.stringify(step),
      ).toEqual([{ site: "start.yml#Start", targets: ["build.yml"] }]);
    }
  });

  test("accepts an App token and dispatches of workflows nothing follows", () => {
    expect(
      tokenDispatchesOfFollowed(
        fixture({
          run: "gh workflow run build.yml",
          env: { GH_TOKEN: githubExpression("steps.app.outputs.token") },
        }),
      ),
    ).toEqual([]);
    expect(
      tokenDispatchesOfFollowed(
        fixture({ run: "gh workflow run publish.yml" }),
      ),
    ).toEqual([]);
  });
});

describe("workflow_dispatch trust", () => {
  test("privileged manual jobs require the protected main workflow ref", () => {
    const problems = allWorkflows().flatMap(({ file, workflow }) =>
      featureDispatchPrivilegeProblems(file, workflow),
    );
    const allowances = new Set(
      Object.keys(FEATURE_DISPATCH_PRIVILEGE_ALLOWANCES),
    );
    const current = new Set(problems);
    const unexpected = problems.filter((problem) => !allowances.has(problem));
    const stale = [...allowances]
      .filter((allowance) => !current.has(allowance))
      .map((allowance) => `stale allowance: ${allowance}`);
    expect([...unexpected, ...stale]).toEqual([]);
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

describe("publication follows the production job receipt", () => {
  const sha = "a".repeat(40);
  const run = {
    head_repository: { full_name: "stella/stella" },
    path: ".github/workflows/release.yml",
    event: "push",
    display_title: "Release Artifacts v1.2.3",
    head_sha: sha,
    conclusion: "failure",
  };
  const check = (upstream: typeof run, conclusion: string) => {
    const work = mkdtempSync(path.join(tmpdir(), "stella-publication-source-"));
    try {
      const stub = path.join(work, "gh-retry.sh");
      writeFileSync(
        stub,
        `case "$*" in
  *'/jobs?'*) printf '%s' "$JOBS" ;;
  *) printf '%s' "$RUN" ;;
esac
`,
      );
      return Bun.spawnSync(
        [
          "bash",
          path.join(import.meta.dir, "check-release-publication-source.sh"),
          "123",
          "v1.2.3",
          sha,
        ],
        {
          env: {
            ...process.env,
            GH_RETRY_SCRIPT: stub,
            GITHUB_REPOSITORY: "stella/stella",
            RUN: JSON.stringify(upstream),
            JOBS: JSON.stringify([
              { jobs: [{ name: "promote-production", conclusion }] },
            ]),
          },
        },
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  test("desktop and npm accept a green promotion in a red run", () => {
    expect(check(run, "success").exitCode).toBe(0);
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral"]) {
      expect(check(run, conclusion).exitCode, conclusion).toBe(1);
    }
  });

  test("publication accepts only the promoted ref and SHA from the trusted workflow", () => {
    for (const upstream of [
      { ...run, display_title: "Release Artifacts v1.2.4" },
      { ...run, head_sha: "b".repeat(40) },
      { ...run, path: ".github/workflows/ci.yml" },
      { ...run, head_repository: { full_name: "fork/stella" } },
      { ...run, event: "pull_request" },
    ]) {
      const result = check(upstream, "success");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "does not own the requested ref and SHA",
      );
    }
  });
});

test("npm and desktop consume the production receipt guard", () => {
  for (const file of ["publish-npm.yml", "release-desktop.yml"]) {
    const source = readFileSync(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      "utf-8",
    );
    expect(source, file).toContain(
      'bash "$RUNNER_TEMP/check-release-publication-source.sh"',
    );
  }
});

describe("desktop recovery", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/release-desktop.yml", import.meta.url),
      "utf-8",
    ),
  );
  const jobs =
    isRecord(workflow) && isRecord(workflow["jobs"]) ? workflow["jobs"] : {};
  const job = (name: string) => {
    const value = jobs[name];
    expect(isRecord(value), name).toBe(true);
    return isRecord(value) ? value : {};
  };
  const stepRun = (jobName: string, stepName: string) => {
    const steps = job(jobName)["steps"];
    const step = Array.isArray(steps)
      ? steps.find(
          (value: unknown) => isRecord(value) && value["name"] === stepName,
        )
      : undefined;
    const run = isRecord(step) ? step["run"] : undefined;
    expect(typeof run, `${jobName}/${stepName}`).toBe("string");
    return typeof run === "string" ? run : "";
  };
  const current = "v1.2.3";
  const previous = "v1.2.2";
  const createFixture = (root: string) => {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    git("init", "-q", "--initial-branch=main", "--template=");
    git("config", "user.name", "Desktop recovery fixture");
    git("config", "user.email", "desktop@example.test");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(path.join(root, "VERSION"), "1.2.2\n");
    git("add", ".");
    git("commit", "-qm", "previous desktop release");
    git("tag", previous);
    writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
    git("add", "VERSION");
    git("commit", "-qm", "API release without desktop changes");
    git("tag", current);
    mkdirSync(path.join(root, "scripts"));
    for (const source of [
      "detect-desktop-release-changes.sh",
      "release-channel.sh",
      "promote-desktop-release.sh",
      "check-desktop-release-policy.sh",
    ]) {
      writeFileSync(
        path.join(root, "scripts", source),
        readFileSync(new URL(source, import.meta.url), "utf-8"),
      );
    }
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(root, "latest"), previous);
    writeFileSync(
      path.join(root, "latest.json"),
      JSON.stringify({ version: current.slice(1) }),
    );
    writeFileSync(
      path.join(root, "gh.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_ROOT/gh-calls"
release_json() {
  jq -nc --arg tag "$1" '{tag_name:$tag,draft:false,prerelease:false,assets:[{name:"Stella-macos-universal.dmg"},{name:"Stella-windows-x64-setup.exe"},{name:"latest.json"}]}'
}
case "$*" in
  'release view '*) printf '%s\\n' latest.json Stella-macos-universal.dmg Stella-windows-x64-setup.exe ;;
  'release download '*)
    mkdir -p assets
    for asset in Stella-macos-universal.dmg Stella-windows-x64-setup.exe latest.json; do printf fixture > "assets/$asset"; done
    ;;
  'release upload '*) printf '%s\\n' "$*" >> "$TEST_ROOT/uploads" ;;
  'release edit '*)
    if [[ "$FAIL_LATEST" == true ]]; then echo 'Latest publication failed after asset upload' >&2; exit 1; fi
    printf '%s' "$CURRENT_TAG" > "$TEST_ROOT/latest"
    ;;
  'api repos/stella/stella/releases/tags/'*) release_json "$CURRENT_TAG" ;;
  'api repos/stella/stella/releases/latest') release_json "$(cat "$TEST_ROOT/latest")" ;;
  *) echo "Unexpected desktop request: $*" >&2; exit 1 ;;
esac
`,
    );
    writeFileSync(
      path.join(bin, "curl"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TEST_ROOT/download-checks"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, "aws"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_ROOT/cdn-calls"
if [[ "$FAIL_CDN" == true ]]; then echo 'Updater publication failed after asset upload' >&2; exit 1; fi
if [[ "$1 $2" == 's3 cp' ]]; then cp latest.json "$TEST_ROOT/updater"; fi
`,
      { mode: 0o755 },
    );
    const run = (script: string, env: Record<string, string> = {}) =>
      Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
        cwd: root,
        env: {
          ...process.env,
          CURRENT_TAG: current,
          PREVIOUS_TAG: previous,
          RELEASE_REF: current,
          GH_REPO: "stella/stella",
          GH_TOKEN: "fixture-token",
          GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
          GITHUB_OUTPUT: path.join(root, "output"),
          BUCKET: "fixture-downloads",
          DIST_ID: "fixture-distribution",
          CHANNEL: "prod",
          TEST_ROOT: root,
          PATH: `${bin}:${process.env.PATH}`,
          FAIL_LATEST: "false",
          FAIL_CDN: "false",
          ...env,
        },
      });
    const read = (file: string) => readFileSync(path.join(root, file), "utf-8");
    const decide = (event: string) => {
      writeFileSync(path.join(root, "output"), "");
      const result = run(
        stepRun("resolve", "Decide whether desktop changed since previous tag"),
        { EVENT_NAME: event },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return Object.fromEntries(
        read("output")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    };
    return { run, read, decide };
  };
  const withFixture = (
    check: (fixture: ReturnType<typeof createFixture>) => void,
  ) => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-desktop-recovery-"));
    try {
      check(createFixture(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("a manual rerun repairs updater and Latest publication after installers already exist", () =>
    withFixture((fixture) => {
      const mirror = stepRun("manifest", "Mirror latest.json to downloads CDN");
      const failed = fixture.run(mirror, { FAIL_CDN: "true" });
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr.toString()).toContain(
        "Updater publication failed after asset upload",
      );
      expect(fixture.read("latest")).toBe(previous);

      const output = fixture.decide("workflow_dispatch");
      expect(output["should_build"]).toBe("true");
      expect(
        evaluate(conditionOf(job("build")), {
          values: {
            "needs.resolve.outputs.should_build": output["should_build"],
          },
        }),
      ).toBe(true);
      const publicationValues = {
        "needs.resolve.outputs.should_build": output["should_build"],
        "needs.resolve.outputs.channel": "prod",
        "needs.build.result": "success",
        "needs.verify-production.result": "success",
        "needs.manifest.result": "failure",
      };
      expect(
        evaluate(conditionOf(job("manifest")), {
          values: publicationValues,
          status: { always: true },
        }),
      ).toBe(true);
      expect(
        evaluate(conditionOf(job("promote-latest")), {
          status: { always: true },
          values: publicationValues,
        }),
      ).toBe(false);
      const mirrored = fixture.run(mirror);
      expect(mirrored.exitCode, mirrored.stderr.toString()).toBe(0);
      expect(JSON.parse(fixture.read("updater"))).toEqual({
        version: current.slice(1),
      });
      expect(
        evaluate(conditionOf(job("promote-latest")), {
          status: { always: true },
          values: { ...publicationValues, "needs.manifest.result": "success" },
        }),
      ).toBe(true);
      const promoted = fixture.run(
        stepRun("promote-latest", "Promote release to latest"),
      );
      expect(promoted.exitCode, promoted.stderr.toString()).toBe(0);
      expect(fixture.read("latest")).toBe(current);
      expect(fixture.read("download-checks")).toContain(
        "releases/latest/download/Stella-macos-universal.dmg",
      );
      expect(fixture.read("download-checks")).toContain(
        "releases/latest/download/Stella-windows-x64-setup.exe",
      );
    }));

  test("a workflow rerun repairs Latest through carry-forward after asset publication succeeded", () =>
    withFixture((fixture) => {
      const promote = stepRun("carry-forward", "Promote release to latest");
      const failed = fixture.run(promote, { FAIL_LATEST: "true" });
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr.toString()).toContain(
        "Latest publication failed after asset upload",
      );
      expect(fixture.read("latest")).toBe(previous);
      const output = fixture.decide("workflow_run");
      expect(output["should_build"]).toBe("false");
      expect(output["previous_tag"]).toBe(previous);
      expect(
        evaluate(conditionOf(job("carry-forward")), {
          values: {
            "needs.resolve.outputs.should_build": output["should_build"],
            "needs.resolve.outputs.channel": "prod",
          },
        }),
      ).toBe(true);
      const copied = fixture.run(
        stepRun("carry-forward", "Copy previous stable desktop assets forward"),
        { PREVIOUS_TAG: output["previous_tag"] },
      );
      expect(copied.exitCode, copied.stderr.toString()).toBe(0);
      expect(fixture.read("uploads")).toContain(
        `release upload ${current} assets/`,
      );
      expect(fixture.read("uploads")).toContain("--clobber");
      const recovered = fixture.run(promote);
      expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
      expect(fixture.read("latest")).toBe(current);
      expect(fixture.read("download-checks")).toContain(
        "releases/latest/download/Stella-macos-universal.dmg",
      );
    }));
});
