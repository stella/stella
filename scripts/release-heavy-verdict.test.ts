import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import * as v from "valibot";

import { heavyVerdict } from "./release-heavy-verdict";

const workflowsDir = nodePath.resolve(
  import.meta.dirname,
  "../.github/workflows",
);

const WorkflowSchema = v.looseObject({
  jobs: v.record(
    v.string(),
    v.looseObject({
      name: v.optional(v.string()),
      uses: v.optional(v.string()),
    }),
  ),
});

const readWorkflow = (file: string) =>
  v.parse(
    WorkflowSchema,
    Bun.YAML.parse(readFileSync(nodePath.join(workflowsDir, file), "utf-8")),
  );

const callerOf = (workflow: ReturnType<typeof readWorkflow>, uses: string) =>
  Object.entries(workflow.jobs).flatMap(([id, job]) =>
    job.uses === uses ? [id] : [],
  );

const job = (name: string, conclusion: string | null) => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
});

const announced = heavyVerdict([]);
const MARKETING = "suites / marketing-screenshots / check";

test("the advisory and aggregate job names are the ones main-heavy.yml reports", () => {
  const heavy = readWorkflow("main-heavy.yml");
  const ci = readWorkflow("ci.yml");
  const screenshots = readWorkflow("marketing-screenshots.yml");
  const [suites, ...otherCallers] = callerOf(
    heavy,
    "./.github/workflows/ci.yml",
  );
  const [marketing, ...otherMarketing] = callerOf(
    ci,
    "./.github/workflows/marketing-screenshots.yml",
  );
  expect(suites).toBeDefined();
  expect(otherCallers).toEqual([]);
  expect(marketing).toBeDefined();
  expect(otherMarketing).toEqual([]);
  expect(Object.keys(screenshots.jobs)).toEqual(["check"]);
  expect(screenshots.jobs["check"]?.name).toBeUndefined();
  // GitHub names a called job `<caller id> / <called job name or id>`.
  expect(announced.advisoryJobs).toEqual([
    `${suites ?? ""} / ${marketing ?? ""} / check`,
  ]);
  const ciResult = ci.jobs["ci-result"];
  expect(ciResult?.name).toBe("ci-result");
  expect(heavy.jobs["status"]?.name).toBeUndefined();
  expect(announced.aggregateJobs).toEqual([
    `${suites ?? ""} / ${ciResult?.name ?? ""}`,
    "status",
  ]);
});

test("only marketing screenshots and the aggregates they trip are advisory", () => {
  const verdict = heavyVerdict([
    job("suites / web-tests", "success"),
    job("suites / docker-checks", "skipped"),
    job(MARKETING, "failure"),
    job("suites / ci-result", "failure"),
    job("status", "failure"),
  ]);
  expect(verdict).toMatchObject({ advisory: [MARKETING], blocking: [] });
  expect(verdict.advisoryOnly).toBe(true);
});

test("any other unsuccessful job blocks", () => {
  const verdict = heavyVerdict([
    job(MARKETING, "failure"),
    job("suites / api-tests (2)", "failure"),
    job("suites / ci-result", "failure"),
  ]);
  expect(verdict.advisoryOnly).toBe(false);
  expect(verdict.blocking).toEqual(["suites / api-tests (2) (failure)"]);
});

test("an aggregate failure without an advisory failure blocks", () => {
  const verdict = heavyVerdict([
    job("suites / ci-result", "failure"),
    job("status", "failure"),
  ]);
  expect(verdict.advisoryOnly).toBe(false);
  expect(verdict.blocking).toHaveLength(2);
});

test.each([
  ["a cancelled advisory job", [job(MARKETING, "cancelled")]],
  ["an unfinished job", [job(MARKETING, "failure"), job("suites / e2e", null)]],
  ["an unknown job name", [job("suites / marketing-shots / check", "failure")]],
  ["a nameless job", [job(MARKETING, "failure"), { conclusion: "failure" }]],
  ["a non-object entry", [job(MARKETING, "failure"), 3]],
  ["a missing job list", "unreadable"],
  ["an empty job list", []],
])("%s is not advisory-only", (_label, jobs) => {
  expect(heavyVerdict(jobs).advisoryOnly).toBe(false);
});
