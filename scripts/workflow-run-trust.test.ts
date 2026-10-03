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

const workflowRunWorkflows = () => {
  const root = fileURLToPath(WORKFLOWS_URL);
  return [...new Bun.Glob("*.{yml,yaml}").scanSync({ cwd: root })]
    .map((file) => ({
      file,
      workflow: Bun.YAML.parse(readFileSync(`${root}/${file}`, "utf-8")),
    }))
    .filter(
      ({ workflow }) =>
        isRecord(workflow) && triggers(workflow["on"]).includes("workflow_run"),
    );
};

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

  test("ignores workflows without a workflow_run trigger", () => {
    expect(trustProblems({ on: ["push"], jobs: { a: {} } })).toEqual([]);
  });
});
