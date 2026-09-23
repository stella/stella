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

const SUITE_DEPTH_BY_EVENT = {
  merge_group: "full",
  pull_request: "fast",
  workflow_dispatch: "full",
} as const;

type EvaluateResultOptions = {
  event: keyof typeof SUITE_DEPTH_BY_EVENT;
  results: Record<string, string>;
  suiteDepth?: string;
};

const evaluateResult = ({
  event,
  results,
  suiteDepth = SUITE_DEPTH_BY_EVENT[event],
}: EvaluateResultOptions) => {
  const needs = Object.fromEntries(
    resultJob.needs.map((job) => [
      job,
      { result: results[job] ?? "success", outputs: {} },
    ]),
  );
  const run = Bun.spawnSync({
    cmd: ["bash", "-eu", "-c", resultStep.run],
    env: {
      API_IMAGE_SMOKE_REQUIRED: "true",
      API_IMAGE_SMOKE_RESULT: needs["api-image-smoke"]?.result ?? "",
      EVENT: event,
      NEEDS: JSON.stringify(needs),
      PATH: process.env["PATH"] ?? "",
      PLAN_RESULT: needs["ci-plan"]?.result ?? "",
      SUITE_DEPTH: suiteDepth,
      TRUSTED: "true",
      WEB_IMAGE_SMOKE_REQUIRED: "true",
      WEB_IMAGE_SMOKE_RESULT: needs["web-image-smoke"]?.result ?? "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  return run.exitCode;
};

test("the required result gate accepts only successful selected image smokes at full depth", () => {
  expect(resultJob.needs).toContain("api-image-smoke");
  expect(resultJob.needs).toContain("web-image-smoke");
  for (const event of ["merge_group", "workflow_dispatch"] as const) {
    for (const job of ["api-image-smoke", "web-image-smoke"]) {
      for (const result of ["success", "skipped", "cancelled", "failure", ""]) {
        expect(
          evaluateResult({ event, results: { [job]: result } }),
          `${event} ${job} ${result}`,
        ).toBe(result === "success" ? 0 : 1);
      }
    }
  }
});

const workflowIf = (job: unknown) =>
  v.parse(v.object({ if: v.optional(v.string()) }), job).if ?? "";

const FULL_DEPTH_PREDICATE = "needs.ci-plan.outputs.suite_depth == 'full'";

test("the result gate evaluates every job in the workflow", () => {
  expect(new Set(resultJob.needs)).toEqual(
    new Set(Object.keys(ciJobs).filter((job) => job !== "ci-result")),
  );
  expect(resultStep.env["NEEDS"]).toBe(["$", "{{ toJSON(needs) }}"].join(""));
  fc.assert(
    fc.property(
      fc.constantFrom(...resultJob.needs.filter((job) => job !== "ci-plan")),
      fc.constantFrom("failure", "timed_out", ""),
      fc.constantFrom("pull_request", "merge_group", "workflow_dispatch"),
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

test("heavy suites skip on pull requests and run in the merge queue", () => {
  const heavyJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
    workflowIf(body).includes(FULL_DEPTH_PREDICATE) ? [job] : [],
  );
  expect(heavyJobs.length).toBeGreaterThan(0);
  // Both image smokes are selected here, as for a release: skipping them
  // passes a pull request and fails any full-depth run.
  const skippedOnPullRequest = Object.fromEntries(
    heavyJobs.map((job) => [job, "skipped"]),
  );
  expect(
    evaluateResult({ event: "pull_request", results: skippedOnPullRequest }),
  ).toBe(0);
  // A `ci:full` pull request runs at full depth and must run them too.
  expect(
    evaluateResult({
      event: "pull_request",
      results: skippedOnPullRequest,
      suiteDepth: "full",
    }),
  ).toBe(1);
  for (const event of ["merge_group", "workflow_dispatch"] as const) {
    expect(evaluateResult({ event, results: skippedOnPullRequest })).toBe(1);
    for (const suiteDepth of ["fast", ""]) {
      expect(
        evaluateResult({ event, results: {}, suiteDepth }),
        `${event} at depth '${suiteDepth}'`,
      ).toBe(1);
    }
    expect(evaluateResult({ event, results: {} })).toBe(0);
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
