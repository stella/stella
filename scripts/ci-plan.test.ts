import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
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

const runSelector = (
  files: readonly string[],
  outputs: readonly string[],
  suiteDepth = "fast",
) => {
  const process = Bun.spawnSync({
    cmd: [
      "bash",
      "-e",
      "-c",
      `changed_files=("$@"); e2e_core_required=false
${selector}
printf "%s\\n" ${outputs.map((output) => `"$${output}"`).join(" ")}`,
      "ci-plan-test",
      ...files,
    ],
    env: { PATH: Bun.env["PATH"] ?? "", SUITE_DEPTH: suiteDepth },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(process.exitCode, new TextDecoder().decode(process.stderr)).toBe(0);
  return new TextDecoder().decode(process.stdout).trim().split("\n");
};

const imageSmokePlan = (files: readonly string[]) =>
  runSelector(files, ["api_image_smoke_required", "web_image_smoke_required"]);

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

test("base image pull changes require every image build", () => {
  for (const file of ["scripts/pull-base-images.sh", "scripts/retry.sh"]) {
    expect(
      runSelector(
        [file],
        [
          "api_image_smoke_required",
          "web_image_smoke_required",
          "legal_atlas_image_required",
          "agent_sandbox_docker_required",
        ],
      ),
      file,
    ).toEqual(["true", "true", "true", "true"]);
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

test("everything the API image is built from requires the API image smoke", () => {
  for (const file of [
    "apps/api/src/server.ts",
    "apps/collab/src/index.ts",
    "apps/legal-atlas-runner/src/index.ts",
    "packages/template-packs/src/catalogue.ts",
    "patches/some-package@1.0.0.patch",
    "apps/web/package.json",
    "apps/landing/public/fonts/CabinetGrotesk-Regular.otf",
    "docker/postgres/init.sql",
    ".gitmodules",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    ".npmrc",
    "turbo.json",
    "scripts/retry.sh",
  ]) {
    expect(imageSmokePlan([file]).at(0), file).toBe("true");
  }
});

test("paths outside the API image do not schedule its smoke", () => {
  for (const file of [
    "apps/web/src/routes/index.tsx",
    "apps/landing/src/pages/index.astro",
    "apps/landing/public/fonts/CabinetGrotesk-Bold.otf",
    "apps/desktop/src-tauri/src/main.rs",
    "docker/postgres/README.md",
    "scripts/ci-plan.test.ts",
    ".github/workflows/deploy-staging.yml",
  ]) {
    expect(imageSmokePlan([file]), file).toEqual(["false", "false"]);
  }
  // Ordinary API source is covered by the API image alone.
  expect(imageSmokePlan(["apps/api/src/server.ts"])).toEqual(["true", "false"]);
});

const MatrixEntry = v.object({ runner: v.string(), platform: v.string() });

const apiImagePlatforms = (files: readonly string[], suiteDepth: string) =>
  v
    .parse(
      v.array(MatrixEntry),
      JSON.parse(
        runSelector(files, ["api_image_platforms"], suiteDepth).at(0) ?? "",
      ),
    )
    .map(({ platform }) => platform)
    .toSorted();

test("a pull request builds the API image for arm64 unless it releases", () => {
  fc.assert(
    fc.property(fc.array(fc.uuid(), { maxLength: 4 }), (names) => {
      const files = ["apps/api/src/server.ts", ...names.map((n) => `${n}.ts`)];
      expect(apiImagePlatforms(files, "fast")).toEqual(["linux/arm64"]);
      expect(apiImagePlatforms([...files, "VERSION"], "fast")).toEqual([
        "linux/amd64",
        "linux/arm64",
      ]);
      expect(apiImagePlatforms(files, "full")).toEqual([
        "linux/amd64",
        "linux/arm64",
      ]);
    }),
    propertyConfig({ numRuns: 10 }),
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
      FAST_REQUIRED: resultStep.env["FAST_REQUIRED"] ?? "",
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
  // A timed-out sibling reads as cancelled; the failure still stands.
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-tests": "cancelled", "code-quality": "failure" },
    }),
  ).toBe(1);
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

const fastRequired = v.parse(
  v.array(v.string()),
  JSON.parse(resultStep.env["FAST_REQUIRED"] ?? ""),
);

test("a fast-depth run requires each fast-required job its plan selected", () => {
  expect(fastRequired.length).toBeGreaterThan(0);
  for (const job of fastRequired) {
    const scope = jobScopes[job];
    // A scope-less or depth-gated job would always skip at fast depth.
    expect(typeof scope, job).toBe("string");
    expect(heavyJobs, job).not.toContain(job);
    if (typeof scope !== "string") {
      continue;
    }
    const event = EVENT.pullRequest;
    expect(evaluateResult({ event, results: { [job]: "skipped" } }), job).toBe(
      1,
    );
    expect(
      evaluateResult({ event, results: { [job]: "cancelled" } }),
      job,
    ).toBe(0);
    expect(
      evaluateResult({
        event,
        results: { [job]: "skipped" },
        unplannedScopes: [scope],
      }),
      job,
    ).toBe(0);
  }
  // Any other planned job may still skip at fast depth.
  for (const job of gatedJobs.filter((name) => !fastRequired.includes(name))) {
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { [job]: "skipped" },
      }),
      job,
    ).toBe(0);
  }
});

const MatrixJob = v.object({
  strategy: v.object({
    matrix: v.object({ include: v.array(MatrixEntry) }),
  }),
});

const jobSteps = (job: unknown) =>
  v.parse(
    v.object({
      steps: v.array(
        v.object({
          name: v.optional(v.string()),
          run: v.optional(v.string()),
        }),
      ),
    }),
    job,
  ).steps;

const smokeCommands = (job: unknown) =>
  jobSteps(job).flatMap(({ run }) =>
    (run ?? "")
      .split("\n")
      .filter((line) => line.includes("scripts/smoke-api-image.sh"))
      .map((line) => line.replace(/^run: /u, "").trim()),
  );

const apiImageJob = ciJobs["api-image-smoke"];

test("CI rehearses every released API platform with the shared release smoke contract", () => {
  const releasePlatforms = v
    .parse(MatrixJob, releaseJobs["build"])
    .strategy.matrix.include.map(({ runner, platform }) => ({
      runner,
      platform,
    }))
    .toSorted((a, b) => a.platform.localeCompare(b.platform));
  expect(releasePlatforms.length).toBeGreaterThan(0);
  expect(
    v.parse(
      v.object({
        strategy: v.object({ matrix: v.object({ include: v.string() }) }),
      }),
      apiImageJob,
    ).strategy.matrix.include,
  ).toBe(
    ["$", "{{ fromJSON(needs.ci-plan.outputs.api_image_platforms) }}"].join(""),
  );
  const fullDepthPlatforms = v.parse(
    v.array(MatrixEntry),
    JSON.parse(
      runSelector(["docs/x.md"], ["api_image_platforms"], "full").at(0) ?? "",
    ),
  );
  // workflow_dispatch plans every scope without running the selector.
  const dispatchPlatforms = /echo 'api_image_platforms=(\[.*\])'/u.exec(
    workflow,
  )?.[1];
  for (const platforms of [
    fullDepthPlatforms,
    v.parse(v.array(MatrixEntry), JSON.parse(dispatchPlatforms ?? "")),
  ]) {
    expect(
      platforms.toSorted((a, b) => a.platform.localeCompare(b.platform)),
    ).toEqual(releasePlatforms);
  }
  const ciCommands = smokeCommands(apiImageJob);
  const releaseCommands = Object.values(releaseJobs).flatMap(smokeCommands);
  expect(ciCommands).toHaveLength(1);
  expect(releaseCommands).toHaveLength(1);
  for (const command of [...ciCommands, ...releaseCommands]) {
    expect(command).toMatch(
      /^bash scripts\/smoke-api-image\.sh \S+(?: 2>&1 \| tee "\$RUNNER_TEMP\/[\w.-]+")?$/u,
    );
  }
});

test("an API image step that tees its log keeps the command's exit status", () => {
  const teed = jobSteps(apiImageJob).flatMap(({ run }) =>
    run?.includes("| tee ") ? [run] : [],
  );
  expect(teed).toHaveLength(2);
  for (const run of teed) {
    expect(run.trimStart()).toStartWith("set -euo pipefail\n");
  }
});

const annotateStep = jobSteps(apiImageJob).find(
  ({ name }) => name === "Annotate image failure",
);

const annotate = (logs: { build?: string; smoke?: string }) => {
  const runnerTemp = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-annotate-"));
  try {
    if (logs.build !== undefined) {
      writeFileSync(
        nodePath.join(runnerTemp, "api-image-build.log"),
        logs.build,
      );
    }
    if (logs.smoke !== undefined) {
      writeFileSync(
        nodePath.join(runnerTemp, "api-image-smoke.log"),
        logs.smoke,
      );
    }
    const run = Bun.spawnSync({
      cmd: ["bash", "-e", "-c", annotateStep?.run ?? "exit 1"],
      env: {
        PATH: process.env["PATH"] ?? "",
        PLATFORM: "linux/arm64",
        RUNNER_TEMP: runnerTemp,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    return new TextDecoder().decode(run.stdout).trimEnd().split("\n");
  } finally {
    rmSync(runnerTemp, { force: true, recursive: true });
  }
};

test("a failed API image run annotates the failing lines, escaped", () => {
  expect(
    annotate({
      smoke: [
        "PASS: fresh database migrations",
        "FAIL: /app/backfill.js did not reach 100% of validation\r::warning::x",
        "Cannot find module",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image smoke (linux/arm64)::FAIL: /app/backfill.js did not reach 100%25 of validation%0D::warning::x",
  ]);
  expect(
    annotate({ smoke: "PASS: fresh database migrations\nno ready\n" }),
  ).toEqual([
    "::error title=API image smoke (linux/arm64)::Failed after: PASS: fresh database migrations",
  ]);
  expect(annotate({ smoke: `FAIL: ${"x".repeat(900)}` })).toEqual([
    `::error title=API image smoke (linux/arm64)::FAIL: ${"x".repeat(494)}`,
  ]);
  expect(
    annotate({
      build: [
        "#10 [builder 3/40] RUN bun install",
        "#10 0.512 error: an earlier step that recovered",
        "#10 DONE 1.3s",
        "#45 [runtime-asset-smoke 2/2] RUN /tmp/image-smoke",
        "#45 0.312 image-smoke ok: quickjs sandbox wasm",
        "#45 0.402 Panic: no YARA rule files were compiled",
        "#45 ERROR: process did not complete successfully: exit code: 1",
        "ERROR: failed to solve: exit code: 1",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image build (linux/arm64)::Panic: no YARA rule files were compiled",
    "::error title=API image build (linux/arm64)::ERROR: process did not complete successfully: exit code: 1",
  ]);
  // Bun's uncaught-error report: the headline sits under a caret line.
  expect(
    annotate({
      build: [
        "#76 [runtime-asset-smoke 2/2] RUN /tmp/image-smoke",
        '#76 0.106 1 | (function (opts) {"use strict";',
        "#76 0.106               ^",
        "#76 0.106 ENOENT: no such file or directory, open '/app/yara'",
        '#76 0.106     path: "/app/yara",',
        "#76 0.106       at /$bunfs/root/image-smoke:8478:51",
        "#76 0.106 Bun v1.4.2 (Linux arm64)",
        "#76 ERROR: process did not complete successfully: exit code: 1",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image build (linux/arm64)::ENOENT: no such file or directory, open '/app/yara'",
    "::error title=API image build (linux/arm64)::ERROR: process did not complete successfully: exit code: 1",
  ]);
  expect(
    annotate({
      build: [
        "#20 [builder 9/40] RUN false",
        "#20 0.100 last words",
        "#20 ERROR: process did not complete successfully: exit code: 1",
      ].join("\n"),
    }),
  ).toEqual([
    "::error title=API image build (linux/arm64)::last words",
    "::error title=API image build (linux/arm64)::ERROR: process did not complete successfully: exit code: 1",
  ]);
  expect(annotate({ build: "ERROR: failed to solve: pull failed\n" })).toEqual([
    "::error title=API image build (linux/arm64)::ERROR: failed to solve: pull failed",
  ]);
});
