import { afterAll, expect, test } from "bun:test";
import fc from "fast-check";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import queuedJob from "./__fixtures__/ci-cancellation/queued-job.json";
import supersessionAnnotations from "./__fixtures__/ci-cancellation/supersession.json";
import timeoutAnnotations from "./__fixtures__/ci-cancellation/timeout.json";

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
    ".npmrc",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["true", "true"]);
  }
  for (const file of [
    "apps/api/src/server.ts",
    "apps/api/tsconfig.json",
    "apps/web/package.json",
    "apps/web/src/generated/api-routes.gen.ts",
    "apps/web/src/routes/index.tsx",
    "types/wasm.d.ts",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["true", "false"]);
  }
  for (const file of [
    "scripts/check-published-exports.ts",
    "scripts/prepare-publish.ts",
    "scripts/publish-manifest.ts",
    "scripts/published-export-guards.ts",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["false", "true"]);
  }
});

test("the generated-output guards skip unrelated pull requests but never full depth", () => {
  for (const file of [
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
    steps: v.array(v.unknown()),
  }),
  ciJobs["ci-result"],
);

const cancelStep = {
  name: "Cancel failed merge group",
  if: "failure() && github.event_name == 'merge_group'",
  shell: "bash",
  env: { GH_TOKEN: `\${{ github.token }}` },
  run: 'gh run cancel "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY"',
};

test("only gated jobs cancel failed merge groups, after every other step", () => {
  const gatedJobs = new Set(resultJob.needs);
  const jobSchema = v.object({
    uses: v.optional(v.string()),
    steps: v.optional(v.array(v.unknown())),
    permissions: v.record(v.string(), v.string()),
    if: v.optional(v.string()),
  });
  for (const [id, value] of Object.entries(ciJobs)) {
    const job = v.parse(jobSchema, value);
    const gated = gatedJobs.has(id);
    if (job.uses !== undefined) {
      // Reusable jobs cannot declare steps. Bind their gated implementation
      // to the called workflow instead of exempting it from cancellation.
      expect(id).toBe("marketing-screenshots");
      expect(job.uses).toBe("./.github/workflows/marketing-screenshots.yml");
      expect(gated).toBe(true);
    } else {
      const steps = job.steps ?? [];
      const cancellationSteps = steps.filter((step) =>
        v.is(v.object({ run: v.literal(cancelStep.run) }), step),
      );
      // The partition guard requires unique check names across its legs.
      const expectedStep = {
        ...cancelStep,
        name: id.startsWith("ci-checks-")
          ? `${cancelStep.name} (${id})`
          : cancelStep.name,
      };
      expect(cancellationSteps, id).toEqual(gated ? [expectedStep] : []);
      if (gated) {
        expect(steps.at(-1), id).toEqual(expectedStep);
      }
    }
    expect(job.permissions["actions"] === "write", id).toBe(gated);
    if (gated && job.if?.includes("always()")) {
      expect(job.if, id).toContain(
        "(github.event_name != 'merge_group' || !cancelled())",
      );
    }
  }
  const marketingJobs = workflowJobs(
    readFileSync(
      new URL(
        "../.github/workflows/marketing-screenshots.yml",
        import.meta.url,
      ),
      "utf-8",
    ),
  );
  for (const [id, value] of Object.entries(marketingJobs)) {
    const job = v.parse(jobSchema, value);
    const steps = job.steps ?? [];
    const cancellationSteps = steps.filter((step) =>
      v.is(v.object({ run: v.literal(cancelStep.run) }), step),
    );
    expect(cancellationSteps, id).toEqual(id === "check" ? [cancelStep] : []);
    expect(job.permissions["actions"] === "write", id).toBe(id === "check");
    if (id === "check") {
      expect(steps.at(-1)).toEqual(cancelStep);
    }
  }
});

const evaluationSteps = resultJob.steps.filter((step) =>
  v.is(v.object({ name: v.literal("Evaluate CI outcome") }), step),
);
if (evaluationSteps.length !== 1) {
  throw new TypeError("CI result must have exactly one evaluation step");
}
const resultStep = v.parse(
  v.object({
    run: v.string(),
    env: v.record(v.string(), v.string()),
  }),
  evaluationSteps.at(0),
);

const jobScopes = v.parse(
  v.record(v.string(), v.nullable(v.string())),
  JSON.parse(resultStep.env["JOB_SCOPES"] ?? ""),
);

const foldedSuites = v.parse(
  v.record(v.string(), v.record(v.string(), v.string())),
  JSON.parse(resultStep.env["FOLDED_SUITES"] ?? ""),
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
  suiteResults?: Record<string, string>;
  cancellationEvidence?: "superseded" | "timeout" | "missing" | "wrong-group";
  apiFailure?: "current-run" | "runs" | "jobs" | "annotations";
  newerRun?:
    | "same-group"
    | "none"
    | "other-ref"
    | "other-pr"
    | "other-workflow"
    | "other-event"
    | "older"
    | "same-time";
  queuedCancellation?: "with-check" | "without-check";
  missingJob?: boolean;
  matrixTimeoutSibling?: boolean;
};

const PULL_REQUEST = { repo: "stella/stella", number: "7" } as const;

// Fake only the GitHub endpoints the extracted evaluator actually calls.
const fakeGhDirectory = mkdtempSync(nodePath.join(tmpdir(), "ci-result-gh-"));
writeFileSync(
  nodePath.join(fakeGhDirectory, "gh"),
  `#!/usr/bin/env bash
set -eu
[[ "$1" == "api" ]] || exit 2
shift
while [[ "$1" == "--paginate" || "$1" == "--slurp" ]]; do shift; done
endpoint="$1"
case "$endpoint" in
  "repos/${PULL_REQUEST.repo}/pulls/${PULL_REQUEST.number}")
    [[ -n "\${FAKE_LIVE_DRAFT:-}" ]] || exit 1
    echo "$FAKE_LIVE_DRAFT"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/runs/123")
    [[ "$FAKE_API_FAILURE" != "current-run" ]] || exit 1
    echo "$FAKE_CURRENT_RUN"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/workflows/42/runs?event="*)
    [[ "$FAKE_API_FAILURE" != "runs" ]] || exit 1
    echo "$FAKE_RUNS"
    ;;
  "repos/${PULL_REQUEST.repo}/actions/runs/123/jobs?filter=latest&per_page=100")
    [[ "$FAKE_API_FAILURE" != "jobs" ]] || exit 1
    echo "$FAKE_JOBS"
    ;;
  https://api.github.com/repos/${PULL_REQUEST.repo}/check-runs/*/annotations?per_page=100)
    [[ "$FAKE_API_FAILURE" != "annotations" ]] || exit 1
    check="\${endpoint%/annotations*}"
    check="\${check##*/}"
    jq -e --arg check "$check" '.[$check]' <<< "$FAKE_ANNOTATIONS"
    ;;
  *) exit 2 ;;
esac
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
  suiteResults = {},
  cancellationEvidence = "timeout",
  apiFailure,
  missingJob = false,
  matrixTimeoutSibling = false,
  newerRun = "same-group",
  queuedCancellation,
}: EvaluateResultOptions) => {
  const plan = Object.fromEntries(
    [
      ...Object.values(jobScopes),
      ...Object.values(foldedSuites).flatMap(Object.values),
    ].flatMap((scope) =>
      scope === null
        ? []
        : [[scope, unplannedScopes.includes(scope) ? "false" : "true"]],
    ),
  );
  const needs = Object.fromEntries(
    resultJob.needs.map((job) => [
      job,
      {
        result: results[job] ?? "success",
        outputs: Object.fromEntries(
          Object.keys(foldedSuites[job] ?? {}).map((suite) => [
            suite,
            suiteResults[suite] ?? "success",
          ]),
        ),
      },
    ]),
  );
  const group =
    "CI Checks-ci-dispatch-refs/heads/ci/result-cancellation-signal-proof";
  const annotations = {
    superseded: supersessionAnnotations,
    timeout: timeoutAnnotations,
    missing: [],
    "wrong-group": supersessionAnnotations.map(({ message }) => ({
      message: message.replace(group, "a different concurrency group"),
    })),
  }[cancellationEvidence];
  const jobs = [];
  const checkAnnotations: Record<string, unknown> = {};
  for (const [job, result] of Object.entries(needs)) {
    if (result.result !== "cancelled") {
      continue;
    }
    const name =
      v.parse(v.object({ name: v.optional(v.string()) }), ciJobs[job]).name ??
      job;
    const checkId: string = String(jobs.length + 10);
    jobs.push({
      name:
        name.replace(/\$\{\{[^}]+\}\}/gu, "fixture") +
        (job === "ci-tests" ? " (api-1)" : ""),
      conclusion: "cancelled",
      check_run_url: `https://api.github.com/repos/${PULL_REQUEST.repo}/check-runs/${checkId}`,
    });
    checkAnnotations[checkId] = [annotations];
  }
  if (matrixTimeoutSibling) {
    const checkId = "999";
    jobs.push({
      name: "ci-tests (api-2)",
      conclusion: "cancelled",
      check_run_url: `https://api.github.com/repos/${PULL_REQUEST.repo}/check-runs/${checkId}`,
    });
    checkAnnotations[checkId] = [timeoutAnnotations];
  }
  if (queuedCancellation !== undefined) {
    const checkId = queuedJob.check_run_url.split("/").at(-1);
    if (checkId === undefined) {
      throw new TypeError("Recorded queued job has no check run ID");
    }
    jobs.push({
      name: queuedJob.name,
      conclusion: queuedJob.conclusion,
      check_run_url:
        queuedCancellation === "with-check" ? queuedJob.check_run_url : null,
    });
    checkAnnotations[checkId] = queuedJob.annotations;
  }
  const currentRun = {
    id: 123,
    name: "CI Checks",
    workflow_id: 42,
    run_number: 100,
    created_at: "2026-10-01T17:42:59Z",
    head_branch: "ci/result-job-annotation-proof",
    event,
    pull_requests:
      event === EVENT.pullRequest
        ? [{ number: Number(PULL_REQUEST.number) }]
        : [],
  };
  let createdAt = "2026-10-01T17:43:00Z";
  if (newerRun === "older") {
    createdAt = "2026-10-01T17:42:58Z";
  } else if (newerRun === "same-time") {
    createdAt = currentRun.created_at;
  }
  const successor = {
    ...currentRun,
    id: newerRun === "older" ? 122 : 124,
    workflow_id: newerRun === "other-workflow" ? 43 : 42,
    run_number: newerRun === "older" ? 99 : 101,
    created_at: createdAt,
    head_branch:
      newerRun === "other-ref" ? "other-branch" : currentRun.head_branch,
    event: newerRun === "other-event" ? "push" : event,
    pull_requests:
      newerRun === "other-pr" ? [{ number: 8 }] : currentRun.pull_requests,
  };
  const run = Bun.spawnSync({
    cmd: ["bash", "-eu", "-c", resultStep.run],
    env: {
      EVENT: event,
      GITHUB_RUN_ID: "123",
      FAKE_API_FAILURE: apiFailure ?? "",
      FAKE_CURRENT_RUN: JSON.stringify(currentRun),
      FAKE_RUNS: JSON.stringify([
        { workflow_runs: newerRun === "none" ? [] : [successor] },
      ]),
      FAKE_JOBS: JSON.stringify([{ jobs: missingJob ? [] : jobs }]),
      FAKE_ANNOTATIONS: JSON.stringify(checkAnnotations),
      FAKE_LIVE_DRAFT: liveDraft === undefined ? "" : String(liveDraft),
      JOB_SCOPES: resultStep.env["JOB_SCOPES"] ?? "",
      FOLDED_SUITES: resultStep.env["FOLDED_SUITES"] ?? "",
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

const reportOnlyJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
  v.parse(v.object({ "continue-on-error": v.optional(v.boolean()) }), body)[
    "continue-on-error"
  ]
    ? [job]
    : [],
);
// Jobs that only collect diagnostics after a gated job failed. ci-result does
// not wait for them: the failure they report already fails the run.
const diagnosticJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
  jobIf(body).includes("needs.") &&
  /needs\.[\w-]+\.result == 'failure'/u.test(jobIf(body))
    ? [job]
    : [],
);

test("the result gate evaluates every job in the workflow", () => {
  expect(new Set(resultJob.needs)).toEqual(
    new Set(
      Object.keys(ciJobs).filter(
        (job) =>
          job !== "ci-result" &&
          !reportOnlyJobs.includes(job) &&
          !diagnosticJobs.includes(job),
      ),
    ),
  );
  for (const job of diagnosticJobs) {
    const failedOn = [
      ...jobIf(ciJobs[job]).matchAll(/needs\.([\w-]+)\.result == 'failure'/gu),
    ].map((match) => match[1] ?? "");
    expect(failedOn.length, job).toBeGreaterThan(0);
    for (const gated of failedOn) {
      expect(resultJob.needs, `${job} runs on ${gated}`).toContain(gated);
    }
    expect(jobIf(ciJobs[job]), job).not.toContain("always()");
  }
  expect(reportOnlyJobs).toEqual([]);
  expect(resultJob.needs).not.toContain("migration-exact-base-upgrade");
  expect(jobScopes).not.toHaveProperty("migration-exact-base-upgrade");
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

test("a failed dependency cannot pass with cancelled siblings or supersession evidence", () => {
  for (const event of [EVENT.mergeGroup, EVENT.pullRequest]) {
    for (const failedJob of resultJob.needs) {
      for (const cancellationEvidence of ["missing", "superseded"] as const) {
        const results = Object.fromEntries(
          resultJob.needs.map((job) => [job, "cancelled"]),
        );
        results["ci-plan"] = "success";
        results[failedJob] = "failure";
        expect(
          evaluateResult({ event, results, cancellationEvidence }),
          `${event} ${failedJob} ${cancellationEvidence}`,
        ).toBe(1);
      }
    }
  }
});

test("a self-cancelled merge group fails even when GitHub marks the failing job cancelled", () => {
  for (const cancellationEvidence of ["missing", "superseded"] as const) {
    const results = Object.fromEntries(
      resultJob.needs.map((job) => [
        job,
        job === "ci-plan" ? "success" : "cancelled",
      ]),
    );
    expect(
      evaluateResult({
        event: EVENT.mergeGroup,
        results,
        cancellationEvidence,
      }),
    ).toBe(1);
  }
});

test.each(resultJob.needs)(
  "cancelled %s passes only with a newer run in the same group and no timeout",
  (job) => {
    for (const event of FAST_DEPTH_EVENTS) {
      for (const cancellationEvidence of [
        "superseded",
        "timeout",
        "missing",
        "wrong-group",
      ] as const) {
        expect(
          evaluateResult({
            event,
            results: { [job]: "cancelled" },
            suiteDepth: SUITE_DEPTH.fast,
            cancellationEvidence,
          }),
          `${job} ${event} ${cancellationEvidence}`,
        ).toBe(cancellationEvidence === "timeout" ? 1 : 0);
      }
    }
  },
);

test("cancelled dependencies fail closed on API errors, missing jobs and mixed matrix causes", () => {
  const cancelled = {
    event: EVENT.pullRequest,
    results: { "ci-tests": "cancelled" },
    cancellationEvidence: "superseded",
  } as const;
  for (const apiFailure of [
    "current-run",
    "runs",
    "jobs",
    "annotations",
  ] as const) {
    expect(evaluateResult({ ...cancelled, apiFailure })).toBe(1);
  }
  expect(evaluateResult({ ...cancelled, missingJob: true })).toBe(1);
  expect(evaluateResult({ ...cancelled, matrixTimeoutSibling: true })).toBe(1);
});

test("supersession needs a newer run of the same workflow and concurrency group", () => {
  for (const event of FAST_DEPTH_EVENTS) {
    for (const newerRun of [
      "none",
      "other-workflow",
      "other-event",
      "older",
    ] as const) {
      expect(
        evaluateResult({
          event,
          suiteDepth: SUITE_DEPTH.fast,
          results: { "ci-tests": "cancelled" },
          cancellationEvidence: "missing",
          newerRun,
        }),
      ).toBe(1);
    }
    const otherGroup = event === EVENT.pullRequest ? "other-pr" : "other-ref";
    expect(
      evaluateResult({
        event,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "ci-tests": "cancelled" },
        newerRun: otherGroup,
      }),
    ).toBe(1);
    expect(
      evaluateResult({
        event,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "ci-tests": "cancelled" },
        cancellationEvidence: "missing",
        newerRun: "same-time",
      }),
    ).toBe(0);
  }
});

test("queued cancelled jobs need no annotations or check run when supersession is proved", () => {
  expect(queuedJob.steps).toHaveLength(0);
  expect(queuedJob.annotations.flat()).toHaveLength(0);
  for (const queuedCancellation of ["with-check", "without-check"] as const) {
    expect(
      evaluateResult({
        event: EVENT.workflowDispatch,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "e2e-production-shard": "cancelled" },
        cancellationEvidence: "missing",
        queuedCancellation,
      }),
    ).toBe(0);
    expect(
      evaluateResult({
        event: EVENT.workflowDispatch,
        suiteDepth: SUITE_DEPTH.fast,
        results: { "e2e-production-shard": "cancelled" },
        cancellationEvidence: "missing",
        queuedCancellation,
        newerRun: "none",
      }),
    ).toBe(1);
    expect(
      evaluateResult({
        event: EVENT.workflowDispatch,
        suiteDepth: SUITE_DEPTH.fast,
        results: {
          "ci-tests": "cancelled",
          "e2e-production-shard": "cancelled",
        },
        queuedCancellation,
        matrixTimeoutSibling: true,
      }),
    ).toBe(1);
  }
});

test("a failed dependency stays red beside a cancelled sibling even during supersession", () => {
  for (const event of FAST_DEPTH_EVENTS) {
    for (const cancellationEvidence of ["timeout", "superseded"] as const) {
      expect(
        evaluateResult({
          event,
          results: { "ci-tests": "cancelled", "code-quality-api": "failure" },
          suiteDepth: SUITE_DEPTH.fast,
          cancellationEvidence,
        }),
      ).toBe(1);
    }
  }
});

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
        cancellationEvidence: "superseded",
      }),
      event,
    ).toBe(0);
    // A timed-out sibling reads as cancelled; the failure still stands.
    expect(
      evaluateResult({
        event,
        results: { "ci-tests": "cancelled", "code-quality-api": "failure" },
        suiteDepth: fast,
      }),
      event,
    ).toBe(1);
    expect(
      evaluateResult({
        event,
        results: { "ci-plan": "cancelled" },
        suiteDepth: fast,
        cancellationEvidence: "superseded",
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
    evaluateResult({
      event,
      results: cancelledReadyRun,
      liveDraft: false,
      cancellationEvidence: "superseded",
    }),
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

test("a planned release screenshot check runs and must pass on the release pull request", () => {
  // The planner selects it only for release pull requests and tags, so a
  // full-depth gate would skip it on the pull request every time.
  expect(jobIf(ciJobs["marketing-screenshots"])).toContain(
    "needs.ci-plan.outputs.marketing_screenshots_required == 'true'",
  );
  expect(heavyJobs).not.toContain("marketing-screenshots");
  expect(fastRequired).toContain("marketing-screenshots");
  const event = EVENT.pullRequest;
  expect(
    evaluateResult({ event, results: { "marketing-screenshots": "skipped" } }),
  ).toBe(1);
  expect(
    evaluateResult({
      event,
      results: { "marketing-screenshots": "skipped" },
      unplannedScopes: ["marketing_screenshots_required"],
    }),
  ).toBe(0);
});

test("a fast-depth run requires every selected fast-required job to run", () => {
  expect(fastRequired.length).toBeGreaterThan(0);
  for (const job of fastRequired) {
    expect(jobScopes).toHaveProperty(job);
    const scope = jobScopes[job];
    // A scope-less job always runs; a scoped job must be selected by the plan.
    expect(heavyJobs, job).not.toContain(job);
    const event = EVENT.pullRequest;
    expect(evaluateResult({ event, results: { [job]: "success" } }), job).toBe(
      0,
    );
    expect(evaluateResult({ event, results: { [job]: "skipped" } }), job).toBe(
      1,
    );
    expect(
      evaluateResult({
        event,
        results: { [job]: "cancelled" },
        cancellationEvidence: "superseded",
      }),
      job,
    ).toBe(0);
    if (typeof scope === "string") {
      expect(
        evaluateResult({
          event,
          results: { [job]: "skipped" },
          unplannedScopes: [scope],
        }),
        job,
      ).toBe(0);
    }
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
          if: v.optional(v.string()),
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
        "cancel-in-progress": v.string(),
      }),
    }),
    Bun.YAML.parse(workflow),
  ).concurrency;
  expect(concurrency["cancel-in-progress"]).toBe(
    `\${{ github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' }}`,
  );
  expect(concurrency.group).toContain(
    "github.event_name == 'workflow_dispatch' && format('ci-dispatch-{0}', github.ref)",
  );
  expect(concurrency.group).toContain(
    "format('pr-{0}', github.event.pull_request.number || github.ref)",
  );
  expect(concurrency.group).toContain("format('run-{0}', github.run_id)");
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
    ciJobs["ci-checks-generated"],
  ).steps;
  for (const [name, scope] of [
    ["Web API types determinism guard", "web_api_types_required"],
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

test("marketing screenshots are planned only for ready same-repository releases or release tags", () => {
  const plan = v.parse(
    v.object({
      outputs: v.record(v.string(), v.string()),
      steps: v.array(
        v.object({ name: v.optional(v.string()), run: v.optional(v.string()) }),
      ),
    }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs["marketing_screenshots_required"]).toBe(
    ["$", "{{ steps.marketing-release.outputs.required }}"].join(""),
  );
  const command = v.parse(
    v.string(),
    plan.steps.find(({ name }) => name === "Plan release marketing screenshots")
      ?.run,
  );
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "marketing-release-plan-"),
  );
  const output = nodePath.join(directory, "output");
  const listing = [
    {
      number: 7,
      title: "chore: release v1.2.3",
      isDraft: false,
      isCrossRepository: false,
    },
    {
      number: 8,
      title: "fix: ordinary",
      isDraft: false,
      isCrossRepository: false,
    },
    {
      number: 9,
      title: "chore: release v1.2.3",
      isDraft: true,
      isCrossRepository: false,
    },
    {
      number: 10,
      title: "chore: release v1.2.3",
      isDraft: false,
      isCrossRepository: true,
    },
  ];
  writeFileSync(
    nodePath.join(directory, "listing.json"),
    JSON.stringify(listing),
  );
  writeFileSync(
    nodePath.join(directory, "gh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      '[[ "$*" == "pr list --repo stella/stella --state open --base main --limit 500 --json number,title,isDraft,isCrossRepository" ]] || exit 3',
      'cat "$(dirname "$0")/listing.json"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const cases = [
    {
      event: "pull_request",
      number: "7",
      ref: "refs/pull/7/merge",
      head: "",
      required: true,
    },
    {
      event: "pull_request",
      number: "8",
      ref: "refs/pull/8/merge",
      head: "",
      required: false,
    },
    {
      event: "pull_request",
      number: "9",
      ref: "refs/pull/9/merge",
      head: "",
      required: false,
    },
    {
      event: "pull_request",
      number: "10",
      ref: "refs/pull/10/merge",
      head: "",
      required: false,
    },
    {
      event: "merge_group",
      number: "",
      ref: "refs/heads/gh-readonly-queue/main/pr-7-abcdef",
      head: "refs/heads/gh-readonly-queue/main/pr-7-abcdef",
      required: true,
    },
    {
      event: "merge_group",
      number: "",
      ref: "refs/heads/gh-readonly-queue/main/pr-8-abcdef",
      head: "refs/heads/gh-readonly-queue/main/pr-8-abcdef",
      required: false,
    },
    {
      event: "workflow_dispatch",
      number: "",
      ref: "refs/tags/v1.2.3",
      head: "",
      required: true,
    },
    {
      event: "workflow_dispatch",
      number: "",
      ref: "refs/tags/ordinary",
      head: "",
      required: false,
    },
    {
      event: "workflow_dispatch",
      number: "",
      ref: "refs/heads/main",
      head: "",
      required: false,
    },
  ];
  try {
    for (const { event, number, ref, head, required } of cases) {
      writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-eu", "-c", command], {
        cwd: nodePath.resolve(import.meta.dir, ".."),
        env: {
          PATH: `${directory}:${Bun.env["PATH"] ?? ""}`,
          EVENT_NAME: event,
          PR_NUMBER: number,
          GITHUB_REF: ref,
          MERGE_GROUP_HEAD_REF: head,
          REPOSITORY: "stella/stella",
          GITHUB_OUTPUT: output,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(readFileSync(output, "utf-8"), `${event} ${ref}`).toBe(
        `required=${String(required)}\n`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("direct web compiler checks materialize ignored API contracts before checking", () => {
  const nightly = workflowJobs(
    readFileSync(
      new URL("../.github/workflows/nightly-typecheck.yml", import.meta.url),
      "utf-8",
    ),
  );
  const directCompiler =
    /bun (?:run check:query-cache-types|scripts\/typecheck-coverage\.ts|scripts\/typecheck-baseline\.ts --(?:check(?:-delta)?|measure))/u;
  let consumers = 0;
  for (const [workflowName, jobs] of [
    ["ci", ciJobs],
    ["nightly", nightly],
  ] as const) {
    for (const [job, body] of Object.entries(jobs)) {
      const steps = v.parse(
        v.object({
          steps: v.optional(
            v.array(
              v.object({
                run: v.optional(v.string()),
              }),
            ),
            [],
          ),
        }),
        body,
      ).steps;
      let precedingCommands = "";
      for (const step of steps) {
        const commands = step.run ?? "";
        const consumer = directCompiler.exec(commands);
        if (consumer !== null) {
          consumers += 1;
          const beforeCheck =
            precedingCommands + commands.slice(0, consumer.index);
          expect(
            beforeCheck,
            `${workflowName}/${job} generates before direct compiler checks`,
          ).toContain("bun run generate");
          if (commands.includes("--measure")) {
            expect(
              commands.slice(0, consumer.index),
              `${job} generates in the base checkout`,
            ).toContain("bun --filter @stll/api gen:web-api-types");
          }
        }
        precedingCommands += `${commands}\n`;
      }
    }
  }
  expect(consumers).toBeGreaterThan(0);
});

test("direct web compiler package scripts generate before inspecting types", () => {
  const { tasks } = v.parse(
    v.object({
      tasks: v.record(
        v.string(),
        v.object({
          dependsOn: v.optional(v.array(v.string()), []),
        }),
      ),
    }),
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
  );
  const directCompiler =
    /(?:tsc-native\.ts|code-check-affected\.ts|lint-changed\.ts|query-cache-types\.ts|result-consumption\.ts|oxlint\b.*--type-aware)/u;
  let consumers = 0;
  for (const manifest of ["../package.json", "../apps/web/package.json"]) {
    const { name: owner, scripts } = v.parse(
      v.object({ name: v.string(), scripts: v.record(v.string(), v.string()) }),
      JSON.parse(readFileSync(new URL(manifest, import.meta.url), "utf-8")),
    );
    for (const [name, command] of Object.entries(scripts)) {
      const consumer = directCompiler.exec(command);
      if (consumer === null) {
        continue;
      }
      consumers += 1;
      expect(
        command.slice(0, consumer.index),
        `${manifest} ${name} materializes the API contract`,
      ).toMatch(/bun(?: --cwd \.\.\/\.\.)? run generate/u);
      if (command.includes("$TURBO_HASH")) {
        const task = `${manifest === "../package.json" ? "//" : owner}#${name}`;
        expect(
          tasks[task]?.dependsOn,
          `${task} prepares API types before skipping the nested cache restore`,
        ).toContain(
          manifest === "../package.json"
            ? "@stll/web#generate:api-types"
            : "generate:api-types",
        );
      }
    }
  }
  expect(consumers).toBeGreaterThan(0);
});

test("folded Docker suites keep their scopes and fail independently, including missing or cancelled verdicts", () => {
  expect(foldedSuites["docker-checks"]).toEqual({
    "agent-sandbox-docker": "agent_sandbox_docker_required",
    "api-image-deps": "api_image_deps_required",
  });
  for (const [job, suites] of Object.entries(foldedSuites)) {
    const body = v.parse(
      v.object({
        outputs: v.record(v.string(), v.string()),
        steps: v.array(
          v.object({
            id: v.optional(v.string()),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      }),
      ciJobs[job],
    );
    expect(new Set(Object.keys(body.outputs))).toEqual(
      new Set(Object.keys(suites)),
    );
    for (const [suite, scope] of Object.entries(suites)) {
      expect(
        body.steps.some((step) =>
          step.if?.includes(`needs.ci-plan.outputs.${scope} == 'true'`),
        ),
      ).toBe(true);
      for (const verdict of [
        "failure",
        "cancelled",
        "skipped",
        "timed_out",
        "",
      ]) {
        expect(
          evaluateResult({
            event: EVENT.mergeGroup,
            results: {},
            suiteResults: { [suite]: verdict },
          }),
          `${suite}: ${verdict}`,
        ).toBe(1);
        expect(
          evaluateResult({
            event: EVENT.mergeGroup,
            results: {},
            suiteResults: { [suite]: verdict },
            unplannedScopes: [scope],
          }),
          `${suite}: unplanned ${verdict}`,
        ).toBe(0);
      }
    }
    const sandboxVerdict = body.outputs["agent-sandbox-docker"] ?? "";
    const sandboxSteps = body.steps.filter(
      (step) =>
        step.id !== undefined &&
        step.if?.includes(
          "needs.ci-plan.outputs.agent_sandbox_docker_required == 'true'",
        ),
    );
    const verdictSteps = [
      ...sandboxVerdict.matchAll(/steps\.([\w-]+)\.outcome == 'success'/gu),
    ].map((match) => match.at(1));
    expect(new Set(verdictSteps)).toEqual(
      new Set(sandboxSteps.map((step) => step.id)),
    );
    const api = body.steps.find((step) => step.id === "api-deps");
    expect(api?.if).toContain("!cancelled()");
    expect(api?.run).toContain("--frozen-lockfile --ignore-scripts");
    expect(api?.run).toContain(
      "--production --frozen-lockfile --ignore-scripts",
    );
    expect(api?.run).toContain(
      "bun apps/legal-atlas-runner/dist/index.js smoke",
    );
    expect(body.outputs["agent-sandbox-docker"]).toContain(
      "steps.isolation.outcome == 'success'",
    );
    expect(body.outputs["agent-sandbox-docker"]).toContain(
      "steps.cleanup.outcome == 'success'",
    );
    expect(body.outputs["api-image-deps"]).toBe(
      ["$", "{{ steps.api-deps.outcome }}"].join(""),
    );
  }
});

test("the Docker fold is planned by either original scope without changing the suite selectors", () => {
  for (const files of [
    [],
    ["README.md"],
    ["scripts/retry.sh"],
    ["apps/api/src/index.ts"],
    ["bun.lock"],
  ]) {
    const [sandbox, imageDeps, folded] = runSelector(
      files,
      [
        "agent_sandbox_docker_required",
        "api_image_deps_required",
        "docker_checks_required",
      ],
      "full",
    );
    expect(folded).toBe(
      sandbox === "true" || imageDeps === "true" ? "true" : "false",
    );
  }
});

test("folded image checks preserve separate working directories for frozen installs and production smoke", () => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "folded-image-deps-"));
  const bin = nodePath.join(directory, "bin");
  mkdirSync(bin);
  mkdirSync(nodePath.join(directory, "apps"));
  mkdirSync(nodePath.join(directory, "packages"));
  writeFileSync(nodePath.join(directory, "bun.lock"), "{}");
  writeFileSync(nodePath.join(directory, "package.json"), "{}");
  writeFileSync(
    nodePath.join(bin, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s\n' "$PWD" "$*" >> "$0.log"
case "$*" in
  -p*) echo 2.0.0 ;;
  *'run case-law-ingest __smoke__') echo 'Unknown adapter: __smoke__'; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    nodePath.join(bin, "turbo"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "prune @stll/legal-atlas-runner --docker --out-dir out-runner" ]]
mkdir -p out-runner/full
`,
    { mode: 0o755 },
  );
  const api = jobSteps(ciJobs["docker-checks"]).find(
    ({ name }) => name === "Check image dependency trees and production runner",
  );
  try {
    const result = Bun.spawnSync(["bash", "-eu", "-c", api?.run ?? "exit 1"], {
      cwd: directory,
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    const commands = readFileSync(nodePath.join(bin, "bun.log"), "utf-8");
    expect(commands).toContain(
      `${directory}/api-install:install --filter @stll/api --filter @stll/collab --filter @stll/legal-atlas-runner --frozen-lockfile --ignore-scripts`,
    );
    expect(commands).toContain(
      `${directory}/runner-install:install --filter @stll/legal-atlas-runner --production --frozen-lockfile --ignore-scripts`,
    );
    expect(commands).toContain(
      `${directory}/runner-install:apps/legal-atlas-runner/dist/index.js smoke`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every parallel quality and guard leg fails closed at full depth", () => {
  for (const job of [
    "code-quality-api",
    "code-quality-web",
    "code-quality-rest",
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
  ]) {
    expect(resultJob.needs).toContain(job);
    expect(jobScopes[job]).toBe(
      job.startsWith("code-quality-") ? "package_checks_required" : null,
    );
    for (const event of FULL_DEPTH_EVENTS) {
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        expect(
          evaluateResult({
            event,
            suiteDepth: SUITE_DEPTH.full,
            results: { [job]: result },
          }),
          `${event} ${job} ${result}`,
        ).toBe(1);
      }
    }
  }
});

test("folded service suites preserve both scopes and independent verdicts", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs["service_suites_required"]).toBe(
    `\${{ steps.changed-files.outputs.package_checks_required == 'true' || steps.changed-files.outputs.collab_redis_required == 'true' }}`,
  );
  expect(jobScopes["service-suites"]).toBe("service_suites_required");
  expect(ciJobs).not.toHaveProperty("collab-redis");
  const services = v.parse(
    v.object({
      services: v.record(v.string(), v.object({ ports: v.array(v.string()) })),
      steps: v.array(
        v.object({
          name: v.string(),
          if: v.optional(v.string()),
          run: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    }),
    ciJobs["service-suites"],
  );
  const suites = services.steps.filter(
    ({ run }) => run?.includes("test:") || run?.includes(" test "),
  );
  expect(suites.map(({ name }) => name)).toEqual([
    "Run Postgres-gated API suites",
    "Run corpus engine suites",
    "Run Valkey-gated API suites",
    "Run cross-replica collaboration suite",
  ]);
  for (const suite of suites) {
    const scope = suite.run?.includes("@stll/collab")
      ? "collab_redis_required"
      : "package_checks_required";
    const predicate = `needs.ci-plan.outputs.${scope} == 'true'`;
    expect(suite.if).toBe(
      suite.run === "bun run test:postgres"
        ? predicate
        : `\${{ !cancelled() && ${predicate} }}`,
    );
  }
  const collab = suites.find(({ run }) => run?.includes("@stll/collab"));
  const valkey = suites.find(({ run }) => run === "bun run test:valkey");
  expect(collab?.env?.["STELLA_COLLAB_TEST_REDIS_CONTAINER_ID"]).toBe(
    `\${{ job.services.redis.id }}`,
  );
  const collabPort = new URL(
    collab?.env?.["STELLA_COLLAB_TEST_REDIS_URL"] ?? "",
  ).port;
  const valkeyPort = new URL(valkey?.env?.["REDIS_URL"] ?? "").port;
  expect(collabPort).not.toBe(valkeyPort);
  expect(services.services["redis"]?.ports).toEqual([`${collabPort}:6379`]);
  expect(services.services["valkey"]?.ports).toEqual([`${valkeyPort}:6379`]);
  for (const event of FULL_DEPTH_EVENTS) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(
        evaluateResult({ event, results: { "service-suites": result } }),
      ).toBe(1);
    }
    expect(
      evaluateResult({
        event,
        results: { "service-suites": "skipped" },
        unplannedScopes: ["service_suites_required"],
      }),
    ).toBe(0);
  }
});

test("Bun cache saves are main-only and queue Turbo caches remain readable", () => {
  const configured = v.parse(
    v.object({ env: v.record(v.string(), v.string()) }),
    Bun.YAML.parse(workflow),
  );
  expect(configured.env["TURBO_CACHE"]).toBe(
    `\${{ github.event_name == 'merge_group' && 'local:rw,remote:r' || 'local:rw,remote:rw' }}`,
  );
  const cacheSteps = Object.values(ciJobs)
    .flatMap(
      (job) =>
        v.parse(
          v.object({
            steps: v.optional(
              v.array(
                v.object({
                  uses: v.optional(v.string()),
                  with: v.optional(v.record(v.string(), v.unknown())),
                }),
              ),
              [],
            ),
          }),
          job,
        ).steps,
    )
    .filter(({ uses }) =>
      uses?.startsWith("stella/.github/actions/setup-bun-cached@"),
    );
  expect(cacheSteps.length).toBeGreaterThan(0);
  for (const step of cacheSteps) {
    expect(step.with?.["save"]).toBe(`\${{ github.ref == 'refs/heads/main' }}`);
  }
});

test("property-testing guards run only when dependencies are installed", () => {
  let guardCount = 0;
  for (const job of [
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
  ]) {
    const steps = jobSteps(ciJobs[job]);
    const installCondition = steps.find(
      ({ name }) => name === "Install dependencies",
    )?.if;
    const guards = steps.filter(({ run }) =>
      run?.includes("bun test packages/property-testing/"),
    );
    guardCount += guards.length;
    if (guards.length > 0) {
      expect(installCondition, job).toBeDefined();
    }
    for (const guard of guards) {
      expect(guard.if, `${job}: ${String(guard.name)}`).toBe(installCondition);
    }
  }
  expect(guardCount).toBeGreaterThan(0);
});

test("dependency inputs plan a malware scan and unrelated paths do not", () => {
  for (const depth of ["fast", "full"]) {
    for (const file of [
      "bun.lock",
      ".claude/mcp/bun.lock",
      "package.json",
      "apps/web/package.json",
      "tools/docs/yarn.lock",
    ]) {
      expect(
        runSelector([file], ["dependency_malware_required"], depth),
      ).toEqual(["true"]);
    }
    expect(
      runSelector(
        ["apps/web/src/page.tsx"],
        ["dependency_malware_required"],
        depth,
      ),
    ).toEqual(["false"]);
  }
});

type RunChangedFilesOptions = {
  baseRef?: string;
  changedPath?: "bun.lock" | "package.json" | "e2e-spec" | "documentation";
  gitShim?: string;
};

const runChangedFilesStep = ({
  baseRef = "main",
  changedPath,
  gitShim,
}: RunChangedFilesOptions) => {
  const step = jobSteps(ciJobs["ci-plan"]).find(
    ({ name }) => name === "Check changed file scope",
  );
  expect(step?.run).toBeDefined();
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-diff-"));
  const output = nodePath.join(directory, "output");
  const repository = nodePath.join(directory, "repository");
  mkdirSync(repository);
  symlinkSync(
    new URL("../scripts", import.meta.url),
    nodePath.join(repository, "scripts"),
  );
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "CI plan test",
        GIT_AUTHOR_EMAIL: "ci-plan-test@example.invalid",
        GIT_COMMITTER_NAME: "CI plan test",
        GIT_COMMITTER_EMAIL: "ci-plan-test@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(
      result.exitCode,
      `${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
    ).toBe(0);
    return result.stdout.toString().trim();
  };

  try {
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(nodePath.join(repository, "README.md"), "base\n");
    git(["add", "README.md"]);
    const commit = (message: string, parent?: string) => {
      const tree = git(["write-tree"]);
      const parents = parent === undefined ? [] : ["-p", parent];
      const hash = git(["commit-tree", tree, ...parents, "-m", message]);
      git(["update-ref", "HEAD", hash]);
      return hash;
    };
    const baseCommit = commit("base");
    git(["update-ref", "refs/remotes/origin/main", baseCommit]);

    git(["switch", "--quiet", "-c", "feature"]);
    const unusualDirectory = 'quote"back\\slash\ttab\nnewline';
    const paths =
      changedPath === undefined
        ? []
        : [
            changedPath === "e2e-spec"
              ? nodePath.join(
                  "apps",
                  "web",
                  "e2e",
                  `${unusualDirectory}.spec.ts`,
                )
              : nodePath.join("fixtures", unusualDirectory, changedPath),
          ];
    for (const [index, file] of paths.entries()) {
      const absolute = nodePath.join(repository, file);
      mkdirSync(nodePath.dirname(absolute), { recursive: true });
      writeFileSync(absolute, `fixture ${index}\n`);
    }
    git(["add", "--", ...paths]);
    commit("add unusual path", baseCommit);

    const env = {
      BASE_REF: baseRef,
      EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: output,
      PATH: gitShim
        ? `${nodePath.dirname(gitShim)}:${process.env["PATH"] ?? ""}`
        : (process.env["PATH"] ?? ""),
      PR_TITLE: "",
      SUITE_DEPTH: "fast",
    };
    const run = Bun.spawnSync(["bash", "-e", "-c", step?.run ?? "exit 1"], {
      cwd: repository,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    return new Map(
      readFileSync(output, "utf-8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

for (const changedPath of ["bun.lock", "package.json", "e2e-spec"] as const) {
  test(`the production changed-file step preserves unusual ${changedPath} paths`, () => {
    const outputs = runChangedFilesStep({ changedPath });
    const scope =
      changedPath === "e2e-spec"
        ? "e2e_core_required"
        : "dependency_malware_required";
    expect(outputs.get(scope)).toBe("true");
  });
}

test("the production changed-file step skips scans for unrelated or empty diffs", () => {
  for (const options of [{}, { changedPath: "documentation" }] as const) {
    const outputs = runChangedFilesStep(options);
    expect(outputs.get("dependency_malware_required")).toBe("false");
    expect(outputs.get("e2e_core_required")).toBe("false");
  }
});

test("an unknown diff base plans malware and e2e scans", () => {
  const outputs = runChangedFilesStep({ baseRef: "missing-base" });
  expect(outputs.get("dependency_malware_required")).toBe("true");
  expect(outputs.get("e2e_core_required")).toBe("true");
});

test("a changed-file diff failure plans malware and e2e scans", () => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-git-"));
  const shim = nodePath.join(directory, "git");
  const systemGit = Bun.spawnSync(["which", "git"], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  writeFileSync(
    shim,
    `#!/bin/bash\nif [[ "$1" == diff ]]; then exit 1; fi\nexec ${systemGit} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  try {
    const outputs = runChangedFilesStep({
      changedPath: "bun.lock",
      gitShim: shim,
    });
    expect(outputs.get("dependency_malware_required")).toBe("true");
    expect(outputs.get("e2e_core_required")).toBe("true");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("planned malware scan gates fast PRs and full merge groups", () => {
  expect(jobScopes["dependency-malware"]).toBe("dependency_malware_required");
  expect(fastRequired).toContain("dependency-malware");
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    for (const verdict of ["failure", "cancelled", "skipped"]) {
      expect(
        evaluateResult({ event, results: { "dependency-malware": verdict } }),
      ).toBe(1);
    }
    expect(
      evaluateResult({ event, results: { "dependency-malware": "success" } }),
    ).toBe(0);
    expect(
      evaluateResult({
        event,
        results: { "dependency-malware": "skipped" },
        unplannedScopes: ["dependency_malware_required"],
      }),
    ).toBe(0);
  }
});

test("only the dedicated malware gate activates Safe Chain and keeps Bun packages cold", () => {
  const users = Object.entries(ciJobs)
    .filter(([, job]) => {
      const parsed = v.parse(
        v.object({
          steps: v.optional(
            v.array(v.object({ uses: v.optional(v.string()) })),
            [],
          ),
        }),
        job,
      );
      return parsed.steps.some(
        ({ uses }) => uses === "./.github/actions/safe-chain",
      );
    })
    .map(([name]) => name);
  expect(users).toEqual(["dependency-malware"]);
  const job = v.parse(
    v.object({
      steps: v.array(
        v.object({ uses: v.optional(v.string()), run: v.optional(v.string()) }),
      ),
    }),
    ciJobs["dependency-malware"],
  );
  expect(
    job.steps.some(
      ({ uses }) =>
        uses?.includes("setup-bun-cached") ||
        uses?.startsWith("actions/cache@"),
    ),
  ).toBe(false);
  expect(
    job.steps.some(({ uses }) => uses === "./.github/actions/osv-scanner"),
  ).toBe(true);
  expect(
    job.steps.some(
      ({ run }) => run === "bash scripts/scan-dependency-malware.sh",
    ),
  ).toBe(true);
  expect(
    job.steps.some(
      ({ run }) => run === "bash scripts/test-malware-scanners.sh",
    ),
  ).toBe(true);
});

test("every browser suite belongs to exactly one required matrix leg", () => {
  const browser = v.parse(
    v.object({
      strategy: v.object({
        "fail-fast": v.literal(false),
        matrix: v.object({ suite: v.array(v.string()) }),
      }),
      steps: v.array(
        v.object({
          name: v.string(),
          if: v.optional(v.string()),
          run: v.optional(v.string()),
        }),
      ),
    }),
    ciJobs["ci-browser"],
  );
  expect(new Set(browser.strategy.matrix.suite)).toEqual(
    new Set(["desktop", "ui"]),
  );
  expect(browser.strategy.matrix.suite).toHaveLength(2);
  const suites = browser.steps.filter(
    ({ run }) => run?.includes("test:browser") || run?.includes("test:e2e"),
  );
  expect(
    suites.map(({ name }) => name).toSorted((a, b) => a.localeCompare(b)),
  ).toEqual(
    [
      "Test desktop browser interactions",
      "Test extension browser boundary",
      "Test UI browser interactions",
      "Test UI playground visuals",
    ].toSorted((a, b) => a.localeCompare(b)),
  );
  for (const suite of suites) {
    const legs = browser.strategy.matrix.suite.filter((leg) =>
      suite.if?.includes(`matrix.suite == '${leg}'`),
    );
    expect(legs, suite.name).toHaveLength(1);
    expect(suite.if, suite.name).toContain("outputs.required == 'true'");
  }
  expect(resultJob.needs).toContain("ci-browser");
  expect(jobScopes["ci-browser"]).toBeNull();
  for (const event of FULL_DEPTH_EVENTS) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(evaluateResult({ event, results: { "ci-browser": result } })).toBe(
        1,
      );
    }
  }
});
