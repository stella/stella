import { afterAll, expect, test } from "bun:test";
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
  e2eLandingRequired = "false",
  event = "pull_request",
  title = "",
) => {
  const process = Bun.spawnSync({
    cmd: [
      "bash",
      "-e",
      "-c",
      `changed_files=("$@"); e2e_core_required=false
e2e_landing_required="$E2E_LANDING_REQUIRED"
${selector}
printf "%s\\n" ${outputs.map((output) => `"$${output}"`).join(" ")}`,
      "ci-plan-test",
      ...files,
    ],
    env: {
      E2E_LANDING_REQUIRED: e2eLandingRequired,
      EVENT_NAME: event,
      PATH: Bun.env["PATH"] ?? "",
      PR_TITLE: title,
      SUITE_DEPTH: suiteDepth,
    },
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

const generatedOutputGuardPlan = (
  files: readonly string[],
  suiteDepth = "fast",
) =>
  runSelector(
    files,
    ["web_api_types_required", "published_exports_required"],
    suiteDepth,
  );

test("the generated-output guards run when their inputs change", () => {
  for (const file of [
    "packages/ui/src/button.tsx",
    "patches/some-package@1.0.0.patch",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    ".github/workflows/ci.yml",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["true", "true"]);
  }
  for (const file of [
    "apps/api/src/server.ts",
    "apps/api/tsconfig.json",
    "apps/web/package.json",
    "apps/web/src/generated/api-routes.gen.ts",
    "types/wasm.d.ts",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["true", "false"]);
  }
  for (const file of [
    "scripts/check-published-exports.ts",
    "scripts/prepare-publish.ts",
    "scripts/publish-manifest.ts",
    "scripts/published-export-guards.ts",
    ".npmrc",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["false", "true"]);
  }
});

test("the generated-output guards skip unrelated pull requests but never full depth", () => {
  for (const file of [
    "apps/web/src/routes/index.tsx",
    "apps/landing/src/pages/index.astro",
    "scripts/typecheck-baseline.json",
    "docs/changelog/x.md",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["false", "false"]);
    expect(generatedOutputGuardPlan([file], "full"), file).toEqual([
      "true",
      "true",
    ]);
  }
});

test("route tree freshness follows route inputs and full-depth runs", () => {
  for (const file of [
    "apps/web/src/routes/index.tsx",
    "apps/web/src/routes/law/route.tsx",
    "apps/web/vite.config.ts",
    "apps/web/route-tree.config.ts",
    "apps/web/scripts/generate-route-tree.ts",
    "apps/web/src/routeTree.gen.ts",
    "bun.lock",
  ]) {
    expect(runSelector([file], ["route_tree_required"]), file).toEqual([
      "true",
    ]);
  }
  expect(runSelector(["docs/changelog/x.md"], ["route_tree_required"])).toEqual(
    ["false"],
  );
  expect(
    runSelector(["docs/changelog/x.md"], ["route_tree_required"], "full"),
  ).toEqual(["true"]);
});

test("the lockfile release-age guard follows every tracked lockfile", () => {
  for (const file of [
    "bun.lock",
    ".claude/mcp/bun.lock",
    "tools/nested/bun.lock",
    "scripts/check-lockfile-release-ages.ts",
    "scripts/check-lockfile-release-ages.test.ts",
    "scripts/check-stll-quarantine-excludes.ts",
  ]) {
    expect(runSelector([file], ["lockfile_ages_required"]), file).toEqual([
      "true",
    ]);
  }
  for (const file of [
    "package.json",
    "bunfig.toml",
    "apps/web/package.json",
    "docs/bun.lock.md",
  ]) {
    expect(runSelector([file], ["lockfile_ages_required"]), file).toEqual([
      "false",
    ]);
  }
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

test("a fix pull request that changes an API test plans the fix-tests-on-base check", () => {
  const plan = (event: string, title: string, files: readonly string[]) =>
    runSelector(
      files,
      ["fix_tests_on_base_required"],
      "fast",
      "false",
      event,
      title,
    )[0];
  const apiTest = "apps/api/src/handlers/chat/stream-chat.test.ts";
  for (const title of [
    "fix: keep ids",
    "fix(chat): keep ids",
    "fix(api)!: keep ids",
  ]) {
    expect(plan("pull_request", title, ["README.md", apiTest]), title).toBe(
      "true",
    );
  }
  expect(plan("pull_request", "feat(chat): keep ids", [apiTest])).toBe("false");
  expect(plan("pull_request", "fixup: keep ids", [apiTest])).toBe("false");
  expect(plan("merge_group", "", [apiTest])).toBe("false");
  expect(
    plan("pull_request", "fix(chat): keep ids", [
      "apps/api/src/handlers/chat/stream-chat.ts",
      "packages/ai/src/stream.test.ts",
    ]),
  ).toBe("false");
});

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
  /** The pull request's draft state as the API reports it now; unset fails the lookup. */
  liveDraft?: boolean;
};

const PULL_REQUEST = { repo: "stella/stella", number: "7" } as const;

// The step reads the live draft state through `gh`; this stand-in answers
// only the pull request the run belongs to, and fails like the API when told
// nothing.
const fakeGhDirectory = mkdtempSync(nodePath.join(tmpdir(), "ci-result-gh-"));
writeFileSync(
  nodePath.join(fakeGhDirectory, "gh"),
  `#!/usr/bin/env bash
[[ "$*" == "api repos/${PULL_REQUEST.repo}/pulls/${PULL_REQUEST.number} --jq .draft" ]] || exit 2
[[ -n "\${FAKE_LIVE_DRAFT:-}" ]] || exit 1
echo "$FAKE_LIVE_DRAFT"
`,
  { mode: 0o755 },
);
afterAll(() => {
  rmSync(fakeGhDirectory, { force: true, recursive: true });
});

// Runs the ci-result step as GitHub would, with every job succeeding and
// every scope selected unless the options say otherwise.
const evaluateResult = ({
  event,
  results,
  suiteDepth = event === EVENT.pullRequest
    ? SUITE_DEPTH.fast
    : SUITE_DEPTH.full,
  unplannedScopes = [],
  liveDraft,
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
      FAKE_LIVE_DRAFT: liveDraft === undefined ? "" : String(liveDraft),
      JOB_SCOPES: resultStep.env["JOB_SCOPES"] ?? "",
      NEEDS: JSON.stringify(needs),
      FAST_REQUIRED: resultStep.env["FAST_REQUIRED"] ?? "",
      PATH: `${fakeGhDirectory}:${process.env["PATH"] ?? ""}`,
      PR_NUMBER: event === EVENT.pullRequest ? PULL_REQUEST.number : "",
      REPO: PULL_REQUEST.repo,
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

// Jobs that only collect diagnostics after a gated job failed. ci-result does
// not wait for them: the failure they report already fails the run.
const REPORT_ONLY_JOBS = ["e2e-report"];

test("the result gate evaluates every job in the workflow", () => {
  expect(new Set(resultJob.needs)).toEqual(
    new Set(
      Object.keys(ciJobs).filter(
        (job) => job !== "ci-result" && !REPORT_ONLY_JOBS.includes(job),
      ),
    ),
  );
  for (const job of REPORT_ONLY_JOBS) {
    const failedOn = [
      ...jobIf(ciJobs[job]).matchAll(/needs\.([\w-]+)\.result == 'failure'/gu),
    ].map((match) => match[1] ?? "");
    expect(failedOn.length, job).toBeGreaterThan(0);
    for (const gated of failedOn) {
      expect(resultJob.needs, `${job} runs on ${gated}`).toContain(gated);
    }
    expect(jobIf(ciJobs[job]), job).not.toContain("always()");
  }
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
      fc.constantFrom(...FULL_DEPTH_EVENTS),
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

// A pull request always plans `fast`; a manual run plans the depth it was
// dispatched with. Both can be superseded by a newer run.
const FAST_DEPTH_EVENTS = [EVENT.pullRequest, EVENT.workflowDispatch] as const;

test("only a pull request or a manual run skips heavy suites or passes a superseded run", () => {
  expect(heavyJobs.length).toBeGreaterThan(0);
  const skippedHeavy = Object.fromEntries(
    heavyJobs.map((job) => [job, "skipped"]),
  );
  const fast = SUITE_DEPTH.fast;
  for (const event of FAST_DEPTH_EVENTS) {
    expect(
      evaluateResult({ event, results: skippedHeavy, suiteDepth: fast }),
      event,
    ).toBe(0);
    expect(
      evaluateResult({
        event,
        results: { "ci-tests": "cancelled" },
        suiteDepth: fast,
      }),
      event,
    ).toBe(0);
    // A timed-out sibling reads as cancelled; the failure still stands.
    expect(
      evaluateResult({
        event,
        results: { "ci-tests": "cancelled", "code-quality": "failure" },
        suiteDepth: fast,
      }),
      event,
    ).toBe(1);
    expect(
      evaluateResult({
        event,
        results: { "ci-plan": "cancelled" },
        suiteDepth: fast,
      }),
      event,
    ).toBe(0);
    expect(
      evaluateResult({ event, results: {}, suiteDepth: "" }),
      `${event} at no depth`,
    ).toBe(1);
  }
  // A manual full run holds the heavy suites to the merge queue's bar.
  expect(
    evaluateResult({
      event: EVENT.workflowDispatch,
      results: skippedHeavy,
      suiteDepth: SUITE_DEPTH.full,
    }),
  ).toBe(1);
  const event = EVENT.mergeGroup;
  expect(evaluateResult({ event, results: {} })).toBe(0);
  expect(evaluateResult({ event, results: skippedHeavy })).toBe(1);
  expect(evaluateResult({ event, results: { "ci-plan": "cancelled" } })).toBe(
    1,
  );
  for (const suiteDepth of [SUITE_DEPTH.fast, ""] as const) {
    expect(
      evaluateResult({ event, results: {}, suiteDepth }),
      `${event} at depth '${suiteDepth}'`,
    ).toBe(1);
  }
});

test("a skipped plan passes only while the pull request is still a draft", () => {
  const skippedPlan = Object.fromEntries(
    resultJob.needs.map((job) => [job, "skipped"]),
  );
  const event = EVENT.pullRequest;
  // A push to a draft runs nothing, and nothing has to.
  expect(
    evaluateResult({
      event,
      results: skippedPlan,
      suiteDepth: "",
      liveDraft: true,
    }),
  ).toBe(0);

  // A push to a draft, then marking it ready at once: the ready run starts
  // first and is cancelled by the draft run queued after it, whose payload
  // still says draft and whose plan skips. The cancelled run may pass, but
  // the run that stands must not certify a ready pull request unchecked.
  const cancelledReadyRun = Object.fromEntries(
    resultJob.needs.map((job) => [job, "cancelled"]),
  );
  expect(
    evaluateResult({ event, results: cancelledReadyRun, liveDraft: false }),
  ).toBe(0);
  expect(
    evaluateResult({
      event,
      results: skippedPlan,
      suiteDepth: "",
      liveDraft: false,
    }),
  ).toBe(1);

  // An unanswered lookup is not a draft either.
  expect(evaluateResult({ event, results: skippedPlan, suiteDepth: "" })).toBe(
    1,
  );

  // Only a pull request can be a draft.
  for (const other of FULL_DEPTH_EVENTS) {
    expect(
      evaluateResult({
        event: other,
        results: skippedPlan,
        suiteDepth: "",
        liveDraft: true,
      }),
      other,
    ).toBe(1);
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

const resolveDepth = (eventName: string, dispatchDepth: string) => {
  const step = jobSteps(ciJobs["ci-plan"]).find(
    ({ name }) => name === "Resolve suite depth",
  );
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-depth-"));
  const output = nodePath.join(directory, "output");
  writeFileSync(output, "");
  try {
    const run = Bun.spawnSync({
      cmd: ["bash", "-e", "-c", step?.run ?? "exit 1"],
      env: {
        DISPATCH_DEPTH: dispatchDepth,
        EVENT_NAME: eventName,
        GITHUB_OUTPUT: output,
        PATH: process.env["PATH"] ?? "",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    return run.exitCode === 0 ? readFileSync(output, "utf-8").trim() : "error";
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

test("a manual run supersedes only an older manual run on the same branch", () => {
  const concurrency = v.parse(
    v.object({
      concurrency: v.object({
        group: v.string(),
        "cancel-in-progress": v.boolean(),
      }),
    }),
    Bun.YAML.parse(workflow),
  ).concurrency;
  expect(concurrency["cancel-in-progress"]).toBe(true);
  expect(concurrency.group).toBe(
    [
      "$",
      "{{ github.event_name == 'workflow_dispatch'",
      " && format('ci-dispatch-{0}', github.ref)",
      " || format('{0}-{1}', github.workflow, github.ref) }}",
    ].join(""),
  );
});

test("a manual run plans the depth it was dispatched with, the merge queue always full, a pull request always fast", () => {
  expect(resolveDepth(EVENT.workflowDispatch, "fast")).toBe("suite_depth=fast");
  expect(resolveDepth(EVENT.workflowDispatch, "full")).toBe("suite_depth=full");
  expect(resolveDepth(EVENT.workflowDispatch, "")).toBe("error");
  expect(resolveDepth(EVENT.workflowDispatch, "fast; full")).toBe("error");
  for (const dispatchDepth of ["", "fast"]) {
    expect(resolveDepth(EVENT.mergeGroup, dispatchDepth)).toBe(
      "suite_depth=full",
    );
  }
  // The heavy suites run once, in the merge queue; no label or input turns
  // them on for a pull request.
  for (const dispatchDepth of ["", "full"]) {
    expect(resolveDepth(EVENT.pullRequest, dispatchDepth)).toBe(
      "suite_depth=fast",
    );
  }
  expect(resolveDepth("push", "")).toBe("error");
});

test("the landing site is built once when its browser checks are planned", () => {
  const landingBuild = (suiteDepth: string, e2eLandingRequired: string) =>
    runSelector(
      ["apps/landing/src/pages/index.astro"],
      ["landing_build_required"],
      suiteDepth,
      e2eLandingRequired,
    ).at(0);
  // e2e-landing runs only at full depth, and builds the site itself there.
  expect(landingBuild("full", "true")).toBe("false");
  expect(landingBuild("full", "false")).toBe("true");
  expect(landingBuild("fast", "true")).toBe("true");
  expect(landingBuild("fast", "false")).toBe("true");
  expect(ciJobs["e2e-landing"]).toBeDefined();
  expect(jobSteps(ciJobs["e2e-landing"]).map(({ run }) => run)).toContain(
    jobSteps(ciJobs["landing-build"]).find(
      ({ name }) => name === "Build landing",
    )?.run,
  );
  expect(jobIf(ciJobs["e2e-landing"])).toContain(FULL_DEPTH_PREDICATE);
});

test("ci-checks gates each generated-output guard on its planned scope", () => {
  const steps = v.parse(
    v.object({
      steps: v.array(
        v.object({ name: v.optional(v.string()), if: v.optional(v.string()) }),
      ),
    }),
    ciJobs["ci-checks"],
  ).steps;
  for (const [name, scope] of [
    ["Web API types drift guard", "web_api_types_required"],
    ["Route tree drift guard", "route_tree_required"],
    ["Published export map guard", "published_exports_required"],
  ] as const) {
    const condition = steps.find((step) => step.name === name)?.if ?? "";
    expect(condition, name).toContain(
      `needs.ci-plan.outputs.${scope} == 'true'`,
    );
    expect(condition, name).toContain(
      "needs.ci-plan.outputs.package_checks_required == 'true'",
    );
  }
});

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
