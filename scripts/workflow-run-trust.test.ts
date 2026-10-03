import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A workflow_run workflow runs in the default branch's context, with its
// secrets and cache scope, for any completed run of a workflow with the
// listed name. A name is not an identity, so every job must establish where
// the triggering run came from before it does anything: the same repository,
// the exact workflow file, and the events that workflow is meant to run on.
// A job may instead depend on such a job, as long as its condition cannot run
// it when that job was skipped.

const WORKFLOWS_URL = new URL("../.github/workflows/", import.meta.url);
/** workflow_run workflows today. Fewer means the scan broke. */
const MINIMUM_WORKFLOW_RUN_WORKFLOWS = 5;

const SOURCE_CHECKS = [
  {
    name: "the triggering run's repository",
    pattern:
      /github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository/u,
  },
  {
    name: "the triggering workflow file",
    pattern: /github\.event\.workflow_run\.path\b/u,
  },
  {
    name: "the triggering event",
    pattern: /github\.event\.workflow_run\.event\b/u,
  },
] as const;

/** Status functions that run a job even when a job it needs was skipped. */
const RUNS_AFTER_SKIP = /\b(always|failure|cancelled)\(\)/u;

// Release and deploy jobs restore caches from the default branch's scope.
// pull_request runs save only to their own pull request's scope, but
// pull_request_target runs (and workflow_run runs, gated above) save to the
// default branch's scope while a fork can influence them. So none of their
// jobs may save to any cache, and a reusable workflow they call must be one
// reviewed for that.
const REVIEWED_REUSABLE_WORKFLOWS: Record<string, string> = {
  "stella/.github/.github/workflows/pr-lint.yml@aff5017c264acce5a2bcdf15876da08835e6de70":
    "title, label, size and assignee actions only; no cache",
};

/** Why a step can save to the Actions cache, or null when it cannot. */
const cacheSave = (step: Record<string, unknown>): string | null => {
  const uses = typeof step["uses"] === "string" ? step["uses"] : "";
  const inputs = isRecord(step["with"]) ? step["with"] : {};
  if (uses === "") {
    return null;
  }
  if (uses.startsWith("./")) {
    return `local action ${uses} is not reviewed for cache use`;
  }
  if (/^actions\/cache(\/save)?@/u.test(uses)) {
    return `${uses} saves a cache`;
  }
  if (/setup-bun-cached@|^Swatinem\/rust-cache@/u.test(uses)) {
    return `${uses} saves a cache`;
  }
  if (uses.startsWith("oven-sh/setup-bun@") && inputs["no-cache"] !== true) {
    return `${uses} caches the Bun binary unless no-cache is true`;
  }
  const setupGo = uses.startsWith("actions/setup-go@");
  if (setupGo && inputs["cache"] !== false) {
    return `${uses} caches by default unless cache is false`;
  }
  if (
    /^actions\/setup-[a-z]+@/u.test(uses) &&
    !setupGo &&
    inputs["cache"] !== undefined &&
    inputs["cache"] !== false &&
    inputs["cache"] !== ""
  ) {
    return `${uses} saves a cache through its cache input`;
  }
  return null;
};

/** Why a job of a fork-influenced default-branch workflow could seed a cache. */
const cacheSaveProblems = (workflow: unknown): string[] => {
  if (
    !isRecord(workflow) ||
    !triggers(workflow["on"]).includes("pull_request_target")
  ) {
    return [];
  }
  const jobs = isRecord(workflow["jobs"]) ? workflow["jobs"] : {};
  return Object.entries(jobs).flatMap(([name, job]) => {
    if (!isRecord(job)) {
      return [];
    }
    const reusable = typeof job["uses"] === "string" ? job["uses"] : null;
    if (reusable !== null) {
      return reusable in REVIEWED_REUSABLE_WORKFLOWS
        ? []
        : [
            `job '${name}' calls ${reusable}, which is not reviewed for cache use`,
          ];
    }
    const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
    return steps.flatMap((step) => {
      const reason = isRecord(step) ? cacheSave(step) : null;
      return reason === null ? [] : [`job '${name}': ${reason}`];
    });
  });
};

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
      const missing = SOURCE_CHECKS.filter(
        ({ pattern }) => !pattern.test(condition),
      );
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
        !gatedNeeds.some((need) =>
          new RegExp(
            `needs\\.${need}\\.(outputs\\.[\\w-]+|result)\\s*==`,
            "u",
          ).test(condition),
        )
      ) {
        problems.set(
          name,
          `job '${name}' can run after its gated needs were skipped: its condition uses a status function without requiring a gated job's result or output`,
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
    (file) => ({
      file,
      workflow: Bun.YAML.parse(readFileSync(`${root}/${file}`, "utf-8")),
    }),
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
    expect(workflows.length).toBeGreaterThanOrEqual(
      MINIMUM_WORKFLOW_RUN_WORKFLOWS,
    );
    const problems = workflows.flatMap(({ file, workflow }) =>
      trustProblems(workflow).map((problem) => `${file}: ${problem}`),
    );
    expect(problems).toEqual([]);
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

  test("rejects unknown and cyclic needs", () => {
    const workflow = {
      on: ["workflow_run"],
      jobs: { a: { needs: "b" }, b: { needs: "a" }, c: { needs: "missing" } },
    };
    expect(trustProblems(workflow)).toHaveLength(3);
  });

  test("no pull_request_target job can save to a cache", () => {
    const workflows = allWorkflows().filter(
      ({ workflow }) =>
        isRecord(workflow) &&
        triggers(workflow["on"]).includes("pull_request_target"),
    );
    // cla.yml and pr-lint.yml today. Fewer means the scan broke.
    expect(workflows.length).toBeGreaterThanOrEqual(2);
    const problems = workflows.flatMap(({ file, workflow }) =>
      cacheSaveProblems(workflow).map((problem) => `${file}: ${problem}`),
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
      expect(cacheSaveProblems(workflow), step.uses).toHaveLength(1);
    }
    const unreviewed = {
      on: { pull_request_target: {} },
      jobs: { a: { uses: "someone/repo/.github/workflows/x.yml@abc" } },
    };
    expect(cacheSaveProblems(unreviewed)).toHaveLength(1);
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
    expect(cacheSaveProblems(workflow)).toEqual([]);
    expect(
      cacheSaveProblems({
        on: ["pull_request"],
        jobs: { a: { steps: [{ uses: "actions/cache@abc" }] } },
      }),
    ).toEqual([]);
  });

  test("ignores workflows without a workflow_run trigger", () => {
    expect(trustProblems({ on: ["push"], jobs: { a: {} } })).toEqual([]);
  });
});
