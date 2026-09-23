import { expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const selectorStart = workflow.indexOf(
  "          # Path scopes for the build/smoke jobs",
);
const selectorEnd = workflow.indexOf(
  "          # The production e2e shards",
  selectorStart,
);
expect(selectorStart).toBeGreaterThan(-1);
expect(selectorEnd).toBeGreaterThan(selectorStart);
const selector = workflow.slice(selectorStart, selectorEnd);

const imageSmokePlan = (files: readonly string[]) => {
  const process = Bun.spawnSync({
    cmd: [
      "bash",
      "-e",
      "-c",
      `changed_files=("$@"); e2e_core_required=false
${selector}
printf "%s\\n" "$api_image_smoke_required" "$web_image_smoke_required"`,
      "ci-plan-test",
      ...files,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(process.exitCode, new TextDecoder().decode(process.stderr)).toBe(0);
  return new TextDecoder().decode(process.stdout).trim().split("\n");
};

test("every release requires both final image smokes regardless of other changed paths", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 8 }), (files) => {
      const safeFiles = files.filter((file) => !file.includes("\0"));
      expect(imageSmokePlan(["VERSION", ...safeFiles])).toEqual([
        "true",
        "true",
      ]);
      expect(imageSmokePlan([...safeFiles, "VERSION"])).toEqual([
        "true",
        "true",
      ]);
    }),
    propertyConfig({ numRuns: 30 }),
  );
});

test("API image construction and smoke orchestration changes require the final image", () => {
  for (const file of [
    "apps/api/Dockerfile",
    "scripts/smoke-api-image.sh",
    ".dockerignore",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    expect(imageSmokePlan([file]).at(0), file).toBe("true");
  }
});

test("Docker context changes require both final image smokes", () => {
  expect(imageSmokePlan([".dockerignore"])).toEqual(["true", "true"]);
});

test("unrelated paths do not schedule final image smokes", () => {
  expect(imageSmokePlan([])).toEqual(["false", "false"]);
  fc.assert(
    fc.property(fc.array(fc.uuid(), { maxLength: 8 }), (names) => {
      expect(imageSmokePlan(names.map((name) => `docs/${name}.md`))).toEqual([
        "false",
        "false",
      ]);
    }),
    propertyConfig({ numRuns: 30 }),
  );
});

const workflowJobs = (source: string) =>
  v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(source),
  ).jobs;

const ciJobs = workflowJobs(workflow);
const releaseJobs = workflowJobs(
  readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf-8",
  ),
);
const resultJob = v.parse(
  v.object({
    needs: v.array(v.string()),
    steps: v.array(
      v.object({
        run: v.string(),
        env: v.record(v.string(), v.string()),
      }),
    ),
  }),
  ciJobs["ci-result"],
);

const resultStep = resultJob.steps.at(0);
if (resultJob.steps.length !== 1 || !resultStep) {
  throw new TypeError("CI result must have exactly one evaluation step");
}

const jobScopes = v.parse(
  v.record(v.string(), v.nullable(v.string())),
  JSON.parse(resultStep.env["JOB_SCOPES"] ?? ""),
);

const EVENT = {
  mergeGroup: "merge_group",
  pullRequest: "pull_request",
  workflowDispatch: "workflow_dispatch",
} as const;
type Event = (typeof EVENT)[keyof typeof EVENT];

const SUITE_DEPTH = { fast: "fast", full: "full" } as const;
type SuiteDepth = (typeof SUITE_DEPTH)[keyof typeof SUITE_DEPTH];

const FULL_DEPTH_EVENTS = [EVENT.mergeGroup, EVENT.workflowDispatch] as const;

type EvaluateResultOptions = {
  event: Event;
  results: Record<string, string>;
  suiteDepth?: SuiteDepth | "";
  unplannedScopes?: readonly string[];
};

// Runs the ci-result step as GitHub would, with every job succeeding and
// every scope selected unless the options say otherwise.
const evaluateResult = ({
  event,
  results,
  suiteDepth = event === EVENT.pullRequest
    ? SUITE_DEPTH.fast
    : SUITE_DEPTH.full,
  unplannedScopes = [],
}: EvaluateResultOptions) => {
  const plan = Object.fromEntries(
    Object.values(jobScopes).flatMap((scope) =>
      scope === null
        ? []
        : [[scope, unplannedScopes.includes(scope) ? "false" : "true"]],
    ),
  );
  const needs = Object.fromEntries(
    resultJob.needs.map((job) => [
      job,
      { result: results[job] ?? "success", outputs: {} },
    ]),
  );
  const run = Bun.spawnSync({
    cmd: ["bash", "-eu", "-c", resultStep.run],
    env: {
      EVENT: event,
      JOB_SCOPES: resultStep.env["JOB_SCOPES"] ?? "",
      NEEDS: JSON.stringify(needs),
      PATH: process.env["PATH"] ?? "",
      PLAN: JSON.stringify({
        ...plan,
        suite_depth: suiteDepth,
        trusted: "true",
      }),
      PLAN_RESULT: needs["ci-plan"]?.result ?? "",
      SUITE_DEPTH: suiteDepth,
      TRUSTED: "true",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  return run.exitCode;
};

const jobIf = (job: unknown) =>
  v.parse(v.object({ if: v.optional(v.string()) }), job).if ?? "";

const FULL_DEPTH_PREDICATE = "needs.ci-plan.outputs.suite_depth == 'full'";
const heavyJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
  jobIf(body).includes(FULL_DEPTH_PREDICATE) ? [job] : [],
);
const gatedJobs = resultJob.needs.filter((job) => job !== "ci-plan");

test("the result gate evaluates every job in the workflow", () => {
  expect(new Set(resultJob.needs)).toEqual(
    new Set(Object.keys(ciJobs).filter((job) => job !== "ci-result")),
  );
  expect(resultStep.env["NEEDS"]).toBe(["$", "{{ toJSON(needs) }}"].join(""));
  fc.assert(
    fc.property(
      fc.constantFrom(...gatedJobs),
      fc.constantFrom("failure", "timed_out", ""),
      fc.constantFrom(...Object.values(EVENT)),
      (job, result, event) => {
        expect(
          evaluateResult({ event, results: { [job]: result } }),
          `${event} ${job} ${result}`,
        ).toBe(1);
      },
    ),
    propertyConfig({ numRuns: 100 }),
  );
});

test("each job's plan scope is the ci-plan output its `if:` selects it by", () => {
  expect(new Set(Object.keys(jobScopes))).toEqual(new Set(gatedJobs));
  for (const job of gatedJobs) {
    const selectedBy = [
      ...jobIf(ciJobs[job]).matchAll(
        /needs\.ci-plan\.outputs\.(\w+_required) == 'true'/gu,
      ),
    ].map((match) => match[1]);
    const scope = jobScopes[job];
    expect(selectedBy, job).toEqual(scope === null ? [] : [scope]);
  }
});

test("a full-depth run fails every planned job that did not succeed", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...gatedJobs),
      fc.constantFrom("skipped", "cancelled", "failure"),
      fc.constantFrom(
        ...FULL_DEPTH_EVENTS,
        // A `ci:full` pull request.
        EVENT.pullRequest,
      ),
      (job, result, event) => {
        expect(
          evaluateResult({
            event,
            results: { [job]: result },
            suiteDepth: SUITE_DEPTH.full,
          }),
          `${event} ${job} ${result}`,
        ).toBe(1);
      },
    ),
    propertyConfig({ numRuns: 100 }),
  );
});

test("a full-depth run passes jobs whose scope was not planned only when skipped", () => {
  for (const job of gatedJobs) {
    const scope = jobScopes[job];
    if (scope === undefined || scope === null) {
      continue;
    }
    for (const event of FULL_DEPTH_EVENTS) {
      const unplanned = { event, unplannedScopes: [scope] };
      expect(
        evaluateResult({ ...unplanned, results: { [job]: "skipped" } }),
        `${event} ${job} skipped`,
      ).toBe(0);
      expect(
        evaluateResult({ ...unplanned, results: { [job]: "cancelled" } }),
        `${event} ${job} cancelled`,
      ).toBe(1);
    }
  }
});

test("only an unlabelled pull request skips heavy suites or passes a superseded run", () => {
  expect(heavyJobs.length).toBeGreaterThan(0);
  const skippedHeavy = Object.fromEntries(
    heavyJobs.map((job) => [job, "skipped"]),
  );
  expect(
    evaluateResult({ event: EVENT.pullRequest, results: skippedHeavy }),
  ).toBe(0);
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-tests": "cancelled" },
    }),
  ).toBe(0);
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-plan": "cancelled" },
    }),
  ).toBe(0);
  for (const event of FULL_DEPTH_EVENTS) {
    expect(evaluateResult({ event, results: {} }), event).toBe(0);
    expect(evaluateResult({ event, results: skippedHeavy }), event).toBe(1);
    expect(
      evaluateResult({ event, results: { "ci-plan": "cancelled" } }),
      event,
    ).toBe(1);
    for (const suiteDepth of [SUITE_DEPTH.fast, ""] as const) {
      expect(
        evaluateResult({ event, results: {}, suiteDepth }),
        `${event} at depth '${suiteDepth}'`,
      ).toBe(1);
    }
  }
});

const imagePlatforms = (job: unknown) =>
  v
    .parse(
      v.object({
        strategy: v.object({
          matrix: v.object({
            include: v.array(v.object({ platform: v.string() })),
          }),
        }),
      }),
      job,
    )
    .strategy.matrix.include.map(({ platform }) => platform)
    .toSorted();

const smokeCommands = (job: unknown) =>
  v
    .parse(
      v.object({
        steps: v.array(v.object({ run: v.optional(v.string()) })),
      }),
      job,
    )
    .steps.flatMap(({ run }) =>
      run?.includes("scripts/smoke-api-image.sh") ? [run] : [],
    );

test("CI rehearses every released API platform with the shared release smoke contract", () => {
  const releasePlatforms = imagePlatforms(releaseJobs["build"]);
  expect(releasePlatforms.length).toBeGreaterThan(0);
  expect(imagePlatforms(ciJobs["api-image-smoke"])).toEqual(releasePlatforms);
  const ciCommands = smokeCommands(ciJobs["api-image-smoke"]);
  const releaseCommands = Object.values(releaseJobs).flatMap(smokeCommands);
  expect(ciCommands).toHaveLength(1);
  expect(releaseCommands).toHaveLength(1);
  for (const command of [...ciCommands, ...releaseCommands]) {
    expect(command).toMatch(/^bash scripts\/smoke-api-image\.sh \S+\s*$/u);
  }
});
