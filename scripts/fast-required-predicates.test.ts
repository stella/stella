import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  ALWAYS_PLANNED_PREDICATE,
  fastRequiredJobs,
  MISSING_JOB_PREDICATE,
  unmodeledFastRequiredJobs,
} from "./fast-required-predicates";

const CI_YML = await Bun.file(
  new URL("../.github/workflows/ci.yml", import.meta.url),
).text();

const workflowSchema = v.looseObject({
  jobs: v.record(v.string(), v.record(v.string(), v.unknown())),
});

type Jobs = v.InferOutput<typeof workflowSchema>["jobs"];

/** The real ci.yml with `edit` applied, serialized as JSON (valid YAML). */
function editedCi(edit: (jobs: Jobs) => void): string {
  const workflow = v.parse(workflowSchema, Bun.YAML.parse(CI_YML));
  edit(workflow.jobs);
  return JSON.stringify(workflow);
}

function job(jobs: Jobs, id: string): Record<string, unknown> {
  const found = jobs[id];
  if (found === undefined) {
    throw new TypeError(`ci.yml has no ${id} job`);
  }
  return found;
}

function unmodeledIds(source: string): string[] {
  return unmodeledFastRequiredJobs(source).map(({ job: id }) => id);
}

function fastRequiredIds(source: string): string[] {
  const workflow = v.parse(workflowSchema, Bun.YAML.parse(source));
  const steps = v.parse(
    v.array(
      v.looseObject({ env: v.optional(v.record(v.string(), v.string())) }),
    ),
    job(workflow.jobs, "ci-result")["steps"],
  );
  const declared = steps.find(
    (step) => step.env?.["FAST_REQUIRED"] !== undefined,
  )?.env?.["FAST_REQUIRED"];
  return v.parse(v.array(v.string()), JSON.parse(declared ?? "null"));
}

describe("fast-required predicates", () => {
  test("the merge gate can model every fast-required job in ci.yml", () => {
    expect(unmodeledFastRequiredJobs(CI_YML)).toEqual([]);
  });

  test("enumerates exactly the FAST_REQUIRED jobs", () => {
    expect(fastRequiredJobs(CI_YML).map(({ job: id }) => id)).toEqual(
      fastRequiredIds(CI_YML),
    );
  });

  test("a fast-depth scope takes precedence over the full-depth scope", () => {
    const outputs = new Map(
      fastRequiredJobs(CI_YML).map(({ job: id, output }) => [id, output]),
    );
    expect(outputs.get("web-build")).toBe("web_build_pr_required");
    expect(outputs.get("pr-heavy-gate")).toBeNull();
    expect(outputs.get("ci-tests")).toBe("ci_tests_required");
  });

  test("a fast-required id with no job definition fails", () => {
    const source = editedCi((jobs) => {
      delete jobs["scan-engine-wasm-drift"];
    });
    expect(unmodeledFastRequiredJobs(source)).toEqual([
      { job: "scan-engine-wasm-drift", predicate: MISSING_JOB_PREDICATE },
    ]);
  });

  test("an unknown atom fails", () => {
    const source = editedCi((jobs) => {
      const target = job(jobs, "ci-tests");
      target["if"] =
        `${v.parse(v.string(), target["if"])} && github.actor != 'bot'`;
    });
    expect(unmodeledIds(source)).toEqual(["ci-tests"]);
  });

  test("a job that no longer tests its own gating output fails", () => {
    const source = editedCi((jobs) => {
      const target = job(jobs, "ci-tests");
      const condition = v.parse(v.string(), target["if"]);
      const atom = "needs.ci-plan.outputs.ci_tests_required == 'true'";
      expect(condition).toContain(atom);
      target["if"] = condition.replaceAll(atom, "always()");
    });
    expect(unmodeledIds(source)).toEqual(["ci-tests"]);
  });

  test("another job's output atom fails", () => {
    const source = editedCi((jobs) => {
      const target = job(jobs, "ci-tests");
      target["if"] =
        `${v.parse(v.string(), target["if"])} && needs.ci-plan.outputs.ci_browser_required == 'true'`;
    });
    expect(unmodeledIds(source)).toEqual(["ci-tests"]);
  });

  test("an output atom fails on a job no output gates", () => {
    const source = editedCi((jobs) => {
      job(jobs, "pr-heavy-gate")["if"] =
        "needs.ci-plan.outputs.package_checks_required == 'true'";
    });
    expect(unmodeledIds(source)).toEqual(["pr-heavy-gate"]);
  });

  test("the always-planned predicate with an extra atom fails", () => {
    const source = editedCi((jobs) => {
      job(jobs, "pr-heavy-gate")["if"] = ALWAYS_PLANNED_PREDICATE.replace(
        " }}",
        " && needs.ci-plan.outputs.trusted == 'true' }}",
      );
    });
    expect(unmodeledIds(source)).toEqual(["pr-heavy-gate"]);
  });

  test("the always-planned predicate tolerates reflowed whitespace", () => {
    const source = editedCi((jobs) => {
      job(jobs, "pr-heavy-gate")["if"] = ALWAYS_PLANNED_PREDICATE.replaceAll(
        " && ",
        "\n  && ",
      );
    });
    expect(unmodeledIds(source)).toEqual([]);
  });

  test("a job without ci-plan must use the always-planned predicate", () => {
    const planless = editedCi((jobs) => {
      const target = job(jobs, "pr-heavy-gate");
      delete target["needs"];
      target["if"] = "!cancelled() && inputs.heavy_only != true";
    });
    expect(unmodeledIds(planless)).toEqual(["pr-heavy-gate"]);

    const alwaysPlanned = editedCi((jobs) => {
      delete job(jobs, "pr-heavy-gate")["needs"];
    });
    expect(unmodeledIds(alwaysPlanned)).toEqual([]);
  });

  test.each([
    [
      "a rewritten draft check",
      ALWAYS_PLANNED_PREDICATE.replace(
        "github.event.pull_request.draft != true",
        "github.event.pull_request.draft == false",
      ),
    ],
    [
      "a requoted draft check",
      ALWAYS_PLANNED_PREDICATE.replace("'pull_request'", '"pull_request"'),
    ],
  ])("%s fails", (_name, predicate) => {
    const source = editedCi((jobs) => {
      job(jobs, "pr-heavy-gate")["if"] = predicate;
    });
    expect(unmodeledIds(source)).toEqual(["pr-heavy-gate"]);
  });

  test("the reusable-workflow exception holds only for a reusable workflow", () => {
    const unknownAtom = (keepUses: boolean): string =>
      editedCi((jobs) => {
        const target = job(jobs, "query-perf");
        target["if"] =
          `${v.parse(v.string(), target["if"])} && github.actor != 'bot'`;
        if (!keepUses) {
          delete target["uses"];
          delete target["with"];
          target["runs-on"] = "ubuntu-latest";
          target["steps"] = [];
        }
      });
    expect(unmodeledIds(unknownAtom(true))).toEqual([]);
    expect(unmodeledIds(unknownAtom(false))).toEqual(["query-perf"]);
  });
});
