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
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    expect(imageSmokePlan([file]).at(0), file).toBe("true");
  }
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

test("the required result gate accepts only successful selected image smokes", () => {
  expect(resultJob.needs).toContain("api-image-smoke");
  expect(resultJob.needs).toContain("web-image-smoke");
  expect(resultJob.steps).toHaveLength(1);
  const step = resultJob.steps.at(0);
  if (!step) {
    throw new TypeError("CI result must have an evaluation step");
  }

  for (const event of ["pull_request", "workflow_dispatch"]) {
    for (const image of ["API", "WEB"]) {
      for (const result of ["success", "skipped", "cancelled", "failure", ""]) {
        const env = Object.fromEntries(
          Object.keys(step.env).map((key) => [key, "success"]),
        );
        env["EVENT"] = event;
        env["TRUSTED"] = "true";
        env["API_IMAGE_SMOKE_REQUIRED"] = "true";
        env["WEB_IMAGE_SMOKE_REQUIRED"] = "true";
        env[`${image}_IMAGE_SMOKE_RESULT`] = result;
        const run = Bun.spawnSync({
          cmd: ["bash", "-eu", "-c", step.run],
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(
          run.exitCode,
          `${event} ${image} ${result}: ${new TextDecoder().decode(run.stderr)}`,
        ).toBe(result === "success" ? 0 : 1);
      }
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
