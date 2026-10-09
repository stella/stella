import { panic } from "better-result";
import { afterAll, expect, test } from "bun:test";
import fc from "fast-check";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import nodePath from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { drawPropertySamples, propertyConfig } from "@stll/property-testing";

import eventPolicies from "../.github/ci-event-policy.json" with { type: "json" };
import queuedJob from "./__fixtures__/ci-cancellation/queued-job.json" with { type: "json" };
import supersessionAnnotations from "./__fixtures__/ci-cancellation/supersession.json" with { type: "json" };
import timeoutAnnotations from "./__fixtures__/ci-cancellation/timeout.json" with { type: "json" };
import { selectApiTestImpact } from "./api-test-impact";
import { requiresMalwareScan } from "./check-standalone-lockfiles";
import { planCiApiTests } from "./ci-api-test-plan";
import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import {
  markdownReaders,
  requiresDesktopBrowser,
  requiresLandingBuild,
  requiresPackageChecks,
} from "./ci-package-scope";
import { extractPlanSelector } from "./ci-plan-selector";
import { routeSmokeAffected } from "./detect-route-smoke-changes";
import { serviceSuiteCliOutput } from "./detect-service-suite-changes";
import { GENERATORS } from "./generated-files";
import { evaluate } from "./github-expression";
import { mainHeavyJobs, queueAdmittedJobs } from "./main-heavy-plan";
import { flattenWorkflowSteps } from "./workflow-steps";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const selector = extractPlanSelector(workflow);

// The immutable repository census is shared fixture setup. Property budgets
// measure selector cases rather than charging its cold scan to the first case.
markdownReaders();

type BashCase = {
  flags: readonly string[];
  script: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
};

type BashOutcome = { exitCode: number; stdout: string; stderr: string };

// Reads each case as NUL-separated fields: flag count, flags, script, env
// count, KEY=VALUE pairs, argument count, arguments. Every case runs in its
// own bash process, exactly as a separate spawn would, with the driver's
// PATH-only environment plus the case's variables. The test pays one spawn
// per batch rather than one per property sample, and up to `jobs` cases run
// at once.
const BASH_BATCH_DRIVER = `directory=$1
count=$2
jobs=$3
run_case() {
  local index=$1 field position size script
  local fields=() flags=() variables=() arguments=()
  while IFS= read -r -d '' field; do fields+=("$field"); done < "$directory/$index.in"
  position=0
  size=\${fields[position]}
  flags=("\${fields[@]:position+1:size}")
  position=$((position + 1 + size))
  script=\${fields[position]}
  position=$((position + 1))
  size=\${fields[position]}
  variables=("\${fields[@]:position+1:size}")
  position=$((position + 1 + size))
  size=\${fields[position]}
  arguments=("\${fields[@]:position+1:size}")
  (
    if ((\${#variables[@]} > 0)); then export "\${variables[@]}"; fi
    exec "$BASH" "\${flags[@]}" -c "$script" ci-plan-test "\${arguments[@]}"
  ) > "$directory/$index.out" 2> "$directory/$index.err"
  printf '%s' "$?" > "$directory/$index.status"
}
for ((index = 0; index < count; index++)); do
  run_case "$index" &
  if (((index + 1) % jobs == 0)); then
    wait
  fi
done
wait`;

// Cases are independent processes; a small pool keeps a batch well inside a
// test's budget without crowding a shared runner.
const BASH_BATCH_JOBS = Math.min(4, availableParallelism());

const runBashBatch = <T>(
  items: readonly T[],
  toCase: (item: T) => BashCase,
): (BashOutcome & { item: T })[] => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-batch-"));
  try {
    for (const [index, item] of items.entries()) {
      const { flags, script, args, env } = toCase(item);
      const variables = Object.entries(env).map(
        ([name, value]) => `${name}=${value}`,
      );
      const fields = [
        String(flags.length),
        ...flags,
        script,
        String(variables.length),
        ...variables,
        String(args.length),
        ...args,
      ];
      if (fields.some((field) => field.includes("\0"))) {
        throw new TypeError(`A bash case field contains NUL: ${script}`);
      }
      writeFileSync(
        nodePath.join(directory, `${index}.in`),
        fields.map((field) => `${field}\0`).join(""),
      );
    }
    const driver = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        BASH_BATCH_DRIVER,
        "ci-plan-batch",
        directory,
        String(items.length),
        String(BASH_BATCH_JOBS),
      ],
      env: { PATH: Bun.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(driver.exitCode, driver.stderr.toString()).toBe(0);
    return items.map((item, index) => {
      const read = (extension: string) =>
        readFileSync(
          nodePath.join(directory, `${index}.${extension}`),
          "utf-8",
        );
      return {
        item,
        exitCode: Number(read("status")),
        stdout: read("out"),
        stderr: read("err"),
      };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const onlyOutcome = <T>(outcomes: readonly T[]): T => {
  const [outcome, ...rest] = outcomes;
  if (outcome === undefined || rest.length > 0) {
    throw new TypeError(`Expected one outcome, received ${outcomes.length}`);
  }
  return outcome;
};

// The selector's bun detectors, keyed by the script it invokes. Served in
// process, each answer comes from the same function the CLI prints; a bun
// call the selector adds without an entry here fails the plan.
const SELECTOR_BUN_CLIS = {
  "scripts/ci-package-scope.ts": {
    variable: "SERVED_LANDING_BUILD",
    flag: "--landing-build",
    output: (files: readonly string[]) =>
      String(requiresLandingBuild({ changed: files })),
  },
  "scripts/detect-service-suite-changes.ts": {
    variable: "SERVED_SERVICE_SUITE_SCOPES",
    flag: "--scopes",
    output: (files: readonly string[]) =>
      serviceSuiteCliOutput(["--scopes", ...files]),
  },
  "scripts/check-standalone-lockfiles.ts": {
    variable: "SERVED_MALWARE_SCAN",
    flag: "--requires-malware-scan",
    output: (files: readonly string[]) => String(requiresMalwareScan(files)),
  },
  "scripts/detect-route-smoke-changes.ts": {
    variable: "SERVED_ROUTE_SMOKE",
    flag: "",
    output: (files: readonly string[]) => String(routeSmokeAffected(files)),
  },
} as const;

const SERVED_BUN_SHIM = `bun() {
  local script=$1 flag served
  shift
  if [[ "$script" == scripts/ci-package-scope.ts && "\${1-}" == --package-checks ]]; then
    shift
    printf '%s\\n' "$SERVED_PACKAGE_CHECKS"
    return
  fi
  if [[ "$script" == scripts/ci-package-scope.ts && "\${1-}" == --desktop-browser ]]; then
    flag=--desktop-browser; served=$SERVED_DESKTOP_BROWSER
  else
  case "$script" in
${Object.entries(SELECTOR_BUN_CLIS)
  .map(
    ([script, { variable, flag }]) =>
      `    ${script}) flag='${flag}'; served=$${variable} ;;`,
  )
  .join("\n")}
    *) printf 'unserved bun call: %s\\n' "$script" >&2; return 127 ;;
  esac
  fi
  if [[ -n "$flag" ]]; then
    [[ "\${1-}" == "$flag" ]] || { printf 'unserved %s arguments\\n' "$script" >&2; return 127; }
    shift
  fi
  [[ $# -eq \${#changed_files[@]} ]] || { printf 'unserved %s files\\n' "$script" >&2; return 127; }
  local index=0 file
  for file in "$@"; do
    [[ "$file" == "\${changed_files[index]}" ]] || { printf 'unserved %s files\\n' "$script" >&2; return 127; }
    index=$((index + 1))
  done
  printf '%s\\n' "$served"
}
`;

const DETECTORS = { inProcess: "in-process", spawned: "spawned" } as const;
type Detectors = (typeof DETECTORS)[keyof typeof DETECTORS];

type SelectorCase = {
  files: readonly string[];
  outputs: readonly string[];
  suiteDepth?: string;
  e2eLandingRequired?: string;
  event?: string;
  title?: string;
};

const selectorCase = (
  {
    files,
    outputs,
    suiteDepth = "fast",
    e2eLandingRequired = "false",
    event = "pull_request",
    title = "",
  }: SelectorCase,
  detectors: Detectors,
): BashCase => {
  const served =
    detectors === DETECTORS.inProcess
      ? Object.fromEntries(
          Object.values(SELECTOR_BUN_CLIS).map(
            ({ variable, output }) => [variable, output(files)] as const,
          ),
        )
      : {};
  return {
    flags: ["-e"],
    script: `${detectors === DETECTORS.inProcess ? SERVED_BUN_SHIM : ""}changed_files=("$@"); e2e_core_required=$(bash scripts/detect-e2e-changes.sh core "$@")
desktop_rust_checks_required=$(bash scripts/detect-tauri-rust-changes.sh "$@")
e2e_landing_required="$E2E_LANDING_REQUIRED"
package_checks_required=true
${selector}
printf "%s\\n" ${outputs.map((output) => `"$${output}"`).join(" ")}`,
    args: files,
    env: {
      // Image-only cases do not observe package/docs scope; avoid paying the
      // repository reader census for an unrelated selector projection.
      SERVED_PACKAGE_CHECKS: outputs.every((name) =>
        /^(?:api|web)_image_smoke_required$/u.test(name),
      )
        ? "true"
        : String(requiresPackageChecks({ changed: files })),
      E2E_LANDING_REQUIRED: e2eLandingRequired,
      EVENT_NAME: event,
      PATH: Bun.env["PATH"] ?? "",
      PR_TITLE: title,
      SUITE_DEPTH: suiteDepth,
      ...served,
      SERVED_DESKTOP_BROWSER: outputs.includes("desktop_browser_required")
        ? String(requiresDesktopBrowser({ changed: files }))
        : "false",
    },
  };
};

const planSelector = <C extends SelectorCase>(
  cases: readonly C[],
  detectors: Detectors = DETECTORS.inProcess,
) =>
  runBashBatch(cases, (entry) => selectorCase(entry, detectors)).map(
    ({ item, exitCode, stdout, stderr }) => {
      expect(exitCode, stderr).toBe(0);
      return { item, plan: stdout.trim().split("\n") };
    },
  );

const runSelector = (
  files: readonly string[],
  outputs: readonly string[],
  suiteDepth = "fast",
  e2eLandingRequired = "false",
  event = "pull_request",
  title = "",
) =>
  onlyOutcome(
    planSelector([
      { files, outputs, suiteDepth, e2eLandingRequired, event, title },
    ]),
  ).plan;

// Property samples are drawn up front and evaluated as one batch, since each
// evaluation runs bash. Each sample's label carries its replay seed and index.

const IMAGE_SMOKE_OUTPUTS = [
  "api_image_smoke_required",
  "web_image_smoke_required",
] as const;

const imageSmokePlan = (files: readonly string[]) =>
  runSelector(files, IMAGE_SMOKE_OUTPUTS);

const releaseExtraFiles = fc.array(fc.string(), { maxLength: 8 });

test("every release requires both final image smokes regardless of other changed paths", () => {
  const cases = drawPropertySamples(releaseExtraFiles, { numRuns: 30 }).flatMap(
    ({ value: files, label }) => {
      const safeFiles = files.filter((file) => !file.includes("\0"));
      return [
        ["VERSION", ...safeFiles],
        [...safeFiles, "VERSION"],
      ].map((changed) => ({
        files: changed,
        outputs: IMAGE_SMOKE_OUTPUTS,
        label,
      }));
    },
  );
  for (const { item, plan } of planSelector(cases)) {
    expect(plan, `${item.label} ${JSON.stringify(item.files)}`).toEqual([
      "true",
      "true",
    ]);
  }
}, 30_000);

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

const unrelatedDocNames = fc.array(fc.uuid(), { maxLength: 8 });

test("unrelated paths do not schedule final image smokes", () => {
  expect(imageSmokePlan([])).toEqual(["false", "false"]);
  const cases = drawPropertySamples(unrelatedDocNames, { numRuns: 30 }).map(
    ({ value: names, label }) => ({
      files: names.map((name) => `docs/${name}.md`),
      outputs: IMAGE_SMOKE_OUTPUTS,
      label,
    }),
  );
  for (const { item, plan } of planSelector(cases)) {
    expect(plan, `${item.label} ${JSON.stringify(item.files)}`).toEqual([
      "false",
      "false",
    ]);
  }
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

const platformsOf = (plan: readonly string[]) =>
  v
    .parse(v.array(MatrixEntry), JSON.parse(plan.at(0) ?? ""))
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

const apiSourceSiblings = fc.array(fc.uuid(), { maxLength: 4 });

test("a pull request builds the API image for arm64 unless it releases", () => {
  const outputs = ["api_image_platforms"];
  const expectations = drawPropertySamples(apiSourceSiblings, {
    numRuns: 10,
  }).flatMap(({ value: names, label }) => {
    const files = ["apps/api/src/server.ts", ...names.map((n) => `${n}.ts`)];
    return [
      { files, outputs, suiteDepth: "fast", platforms: ["linux/arm64"], label },
      {
        files: [...files, "VERSION"],
        outputs,
        suiteDepth: "fast",
        platforms: ["linux/amd64", "linux/arm64"],
        label,
      },
      {
        files,
        outputs,
        suiteDepth: "full",
        platforms: ["linux/amd64", "linux/arm64"],
        label,
      },
    ];
  });
  for (const {
    item: { files, suiteDepth, platforms, label },
    plan,
  } of planSelector(expectations)) {
    expect(
      platformsOf(plan),
      `${label} ${suiteDepth} ${JSON.stringify(files)}`,
    ).toEqual(platforms);
  }
}, 30_000);

const workflowJobs = (source: string) =>
  v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(source),
  ).jobs;

const jobIf = (job: unknown) =>
  v.parse(v.object({ if: v.optional(v.string()) }), job).if ?? "";

const ciJobs = workflowJobs(workflow);
const releaseJobs = workflowJobs(
  readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf-8",
  ),
);
// An undeclared output becomes an empty string, overriding even an environment
// value established by an earlier step.
test("CI planner output references name declared outputs", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  const declared = new Set(Object.keys(plan.outputs));
  const references = new Set(
    [
      ...JSON.stringify(ciJobs).matchAll(/needs\.ci-plan\.outputs\.([\w-]+)/gu),
    ].flatMap(([, output]) => (output === undefined ? [] : [output])),
  );
  expect(references.size).toBeGreaterThan(0);
  expect(
    [...references].filter((output) => !declared.has(output)).toSorted(),
  ).toEqual([]);
});

const resultJob = v.parse(
  v.object({
    needs: v.array(v.string()),
    steps: v.array(v.unknown()),
  }),
  ciJobs["ci-result"],
);

const CANCEL_REUSABLE_JOB = "marketing-screenshots-cancel";
const MAIN_ONLY_JOBS = new Set(["api-test-durations"]);
const CANCELLATION_EXCEPTIONS = new Set([
  "fix-tests-on-base",
  "heavy-web-build",
  "marketing-screenshots",
  CANCEL_REUSABLE_JOB,
  ...MAIN_ONLY_JOBS,
]);
const cancellationJobSchema = v.looseObject({
  if: v.optional(v.string()),
  permissions: v.optional(v.record(v.string(), v.string())),
  steps: v.optional(
    v.array(
      v.looseObject({
        name: v.optional(v.string()),
        if: v.optional(v.string()),
        uses: v.optional(v.string()),
        run: v.optional(v.string()),
        shell: v.optional(v.string()),
        env: v.optional(v.record(v.string(), v.string())),
        with: v.optional(v.record(v.string(), v.unknown())),
      }),
    ),
  ),
});
const regularCancellationJobs = () =>
  Object.entries(ciJobs).filter(([id]) => !CANCELLATION_EXCEPTIONS.has(id));

test("every eligible CI job cancels a failed merge group in its final step with job-scoped permission", () => {
  expect(ciJobs["merge-group-fail-fast"]).toBeUndefined();
  for (const id of CANCELLATION_EXCEPTIONS) {
    expect(ciJobs[id], id).toBeDefined();
  }
  const eligible = new Set(regularCancellationJobs().map(([id]) => id));
  expect(eligible.size).toBeGreaterThan(0);
  for (const [id, value] of Object.entries(ciJobs)) {
    const body = v.parse(cancellationJobSchema, value);
    expect(body.permissions?.["actions"] === "write", id).toBe(
      eligible.has(id) || id === CANCEL_REUSABLE_JOB || MAIN_ONLY_JOBS.has(id),
    );
    const cancellations =
      body.steps?.filter(({ name }) => name === CANONICAL_CANCEL_STEP.name) ??
      [];
    expect(cancellations.length, id).toBe(
      Number(eligible.has(id) || id === CANCEL_REUSABLE_JOB),
    );
    if (!eligible.has(id)) {
      continue;
    }
    const tail = body.steps?.at(-1);
    expect(tail, id).toEqual({
      ...CANONICAL_CANCEL_STEP,
      if: "failure() && github.event_name == 'merge_group'",
    });
  }
  const permissions = v.parse(
    v.object({ permissions: v.record(v.string(), v.string()) }),
    Bun.YAML.parse(workflow),
  ).permissions;
  expect(permissions["actions"]).not.toBe("write");
  const tests = v.parse(
    v.looseObject({ strategy: v.object({ "fail-fast": v.boolean() }) }),
    ciJobs["ci-tests"],
  );
  expect(tests.strategy["fail-fast"]).toBe(false);
  expect(jobIf(ciJobs["fix-tests-on-base"])).toContain(
    "github.event_name == 'pull_request'",
  );
  expect(jobIf(ciJobs["route-smoke"])).toContain(
    "github.event_name != 'pull_request'",
  );
  expect(jobIf(ciJobs["heavy-web-build"])).toContain(
    "needs.ci-plan.outputs.heavy_web_build_required == 'true'",
  );
  expect(resultJob.needs).not.toContain(CANCEL_REUSABLE_JOB);
  for (const id of [
    "route-smoke",
    "e2e-production-shard",
    "marketing-screenshots",
  ]) {
    expect(jobIf(ciJobs[id]), id).toContain(
      "(github.event_name != 'merge_group' || !cancelled())",
    );
  }
});

test("all failure tails and screenshot cancellation use the canonical same-run API step", async () => {
  const helper = v.parse(
    v.looseObject({
      needs: v.string(),
      if: v.string(),
      "timeout-minutes": v.number(),
      permissions: v.record(v.string(), v.string()),
      steps: v.array(v.unknown()),
    }),
    ciJobs[CANCEL_REUSABLE_JOB],
  );
  expect(helper.needs).toBe("marketing-screenshots");
  expect(helper.if).toBe("failure() && github.event_name == 'merge_group'");
  expect(helper["timeout-minutes"]).toBe(1);
  expect(helper.permissions).toEqual({ actions: "write" });
  expect(helper.steps).toEqual([CANONICAL_CANCEL_STEP]);
  const cancel = CANONICAL_CANCEL_STEP;
  for (const event of [
    "pull_request",
    "push",
    "workflow_dispatch",
    "merge_group",
  ]) {
    for (const failed of [false, true]) {
      const calls: unknown[] = [];
      const enabled: unknown = new Script(
        `Boolean(${helper.if})`,
      ).runInNewContext({
        failure: () => failed,
        github: { event_name: event },
      });
      if (enabled) {
        await new Script(
          `(async () => { ${cancel.with.script} })()`,
        ).runInNewContext({
          context: {
            repo: { owner: "fixture-owner", repo: "fixture-repository" },
            runId: 424_242,
          },
          process: { env: { GITHUB_RUN_ATTEMPT: "1" } },
          setTimeout,
          clearTimeout,
          core: {
            error: () => {},
            summary: { addRaw: () => {}, write: async () => {} },
          },
          github: {
            paginate: async () => [],
            rest: {
              actions: {
                cancelWorkflowRun: async (arguments_: unknown) => {
                  calls.push(arguments_);
                },
              },
            },
          },
        });
      }
      expect(calls, `${event}/${failed}`).toEqual(
        event === "merge_group" && failed
          ? [
              {
                owner: "fixture-owner",
                repo: "fixture-repository",
                run_id: 424_242,
              },
            ]
          : [],
      );
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

const fastJobScopes = v.parse(
  v.record(v.string(), v.string()),
  JSON.parse(resultStep.env["FAST_JOB_SCOPES"] ?? ""),
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
  event: Event | "push";
  results: Record<string, string>;
  suiteDepth?: SuiteDepth | "";
  unplannedScopes?: readonly string[];
  plannedOutputs?: Record<string, string>;
  trusted?: "true" | "false";
  /** The pull request's draft state as the API reports it now; unset fails the lookup. */
  liveDraft?: boolean;
  suiteResults?: Record<string, string>;
  cancellationEvidence?:
    | "superseded"
    | "timeout"
    | "step-timeout"
    | "missing"
    | "wrong-group";
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
  embeddedStepFailure?: boolean;
  jobConclusion?: "cancelled" | "failure" | "timed_out";
  heavyOnly?: boolean;
  outcomeScript?: string;
};

const mainHeavyJobNames = mainHeavyJobs({ jobs: ciJobs });

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
  "repos/${PULL_REQUEST.repo}/actions/runs/123/attempts/1/jobs?per_page=100")
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

// The ci-result step as GitHub would run it, with every job succeeding and
// every scope selected unless the options say otherwise.
const resultGateCase = ({
  event,
  results,
  suiteDepth = event === EVENT.pullRequest
    ? SUITE_DEPTH.fast
    : SUITE_DEPTH.full,
  unplannedScopes = [],
  plannedOutputs = {},
  trusted = "true",
  liveDraft,
  suiteResults = {},
  cancellationEvidence = "timeout",
  apiFailure,
  missingJob = false,
  matrixTimeoutSibling = false,
  embeddedStepFailure = false,
  jobConclusion,
  heavyOnly = false,
  outcomeScript = resultStep.run,
  newerRun = "same-group",
  queuedCancellation,
}: EvaluateResultOptions): BashCase => {
  const plan = Object.fromEntries(
    [
      ...Object.values(jobScopes),
      ...Object.values(fastJobScopes),
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
    "step-timeout": [
      {
        message:
          "The action 'Run Playwright shard' has timed out after 7 minutes.",
      },
    ],
    missing: [],
    "wrong-group": supersessionAnnotations.map(({ message }) => ({
      message: message.replace(group, "a different concurrency group"),
    })),
  }[cancellationEvidence];
  const jobs = [];
  const checkAnnotations: Record<string, unknown> = {};
  for (const [job, result] of Object.entries(needs)) {
    if (
      result.result !== "cancelled" &&
      result.result !== "failure" &&
      result.result !== "timed_out"
    ) {
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
      conclusion: jobConclusion ?? result.result,
      html_url: `https://example.test/jobs/${checkId}`,
      steps: embeddedStepFailure
        ? [{ name: "Validate contract", number: 3, conclusion: "failure" }]
        : [],
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
  return {
    flags: ["-eu"],
    script: outcomeScript,
    args: [],
    env: {
      GH_RETRY_SCRIPT: nodePath.resolve(import.meta.dir, "gh-retry.sh"),
      EVENT: event,
      COVERAGE_PROFILE: "normal-v1",
      PILOT_FAST_JOBS: "[]",
      QUEUE_VALIDATION: "false",
      QUEUE_REQUIRED_JOBS: "[]",
      PR_ACTION: "synchronize",
      QUEUE_DEPTH: "full",
      HEAVY_ONLY: String(heavyOnly),
      HEAVY_JOBS: JSON.stringify(mainHeavyJobNames),
      THIN_JOBS: "[]",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_STEP_SUMMARY: "/dev/null",
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
      FAST_JOB_SCOPES: resultStep.env["FAST_JOB_SCOPES"] ?? "",
      PATH: `${fakeGhDirectory}:${process.env["PATH"] ?? ""}`,
      PR_NUMBER: event === EVENT.pullRequest ? PULL_REQUEST.number : "",
      REPO: PULL_REQUEST.repo,
      PLAN: JSON.stringify({
        ...plan,
        ...plannedOutputs,
        suite_depth: suiteDepth,
        trusted,
      }),
      PLAN_RESULT: needs["ci-plan"]?.result ?? "",
      SUITE_DEPTH: suiteDepth,
      TRUSTED: trusted,
    },
  };
};

const evaluateResults = <T>(
  items: readonly T[],
  toOptions: (item: T) => EvaluateResultOptions,
) => runBashBatch(items, (item) => resultGateCase(toOptions(item)));

const evaluateResult = (options: EvaluateResultOptions) =>
  onlyOutcome(evaluateResults([options], (item) => item)).exitCode;

type ExpectedResultGate = {
  label: string;
  options: EvaluateResultOptions;
  exitCode: number;
};

const expectResultGates = (gates: readonly ExpectedResultGate[]) => {
  for (const { item, exitCode } of evaluateResults(
    gates,
    ({ options }) => options,
  )) {
    expect(exitCode, item.label).toBe(item.exitCode);
  }
};

const FULL_DEPTH_PREDICATE = "needs.ci-plan.outputs.suite_depth == 'full'";
const heavyJobs = Object.entries(ciJobs).flatMap(([job, body]) =>
  jobIf(body).includes(FULL_DEPTH_PREDICATE) ||
  jobIf(body).includes("github.event_name != 'pull_request' && (")
    ? [job]
    : [],
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

const failedGatedJobs = fc.tuple(
  fc.constantFrom(...gatedJobs),
  fc.constantFrom("failure", "timed_out", ""),
  fc.constantFrom(...Object.values(EVENT)),
);

test("the result gate evaluates every job in the workflow", () => {
  expect(new Set(resultJob.needs)).toEqual(
    new Set(
      Object.keys(ciJobs).filter(
        (job) =>
          job !== "ci-result" &&
          // It only shortens a failing run; gating on it would let a failed
          // cancellation request block the result (bound above).
          job !== CANCEL_REUSABLE_JOB &&
          !MAIN_ONLY_JOBS.has(job) &&
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
  for (const job of MAIN_ONLY_JOBS) {
    expect(jobIf(ciJobs[job]), job).toContain(
      "github.ref == 'refs/heads/main'",
    );
  }
  expect(resultJob.needs).not.toContain("migration-exact-base-upgrade");
  expect(jobScopes).not.toHaveProperty("migration-exact-base-upgrade");
  expect(resultStep.env["NEEDS"]).toBe(["$", "{{ toJSON(needs) }}"].join(""));
  for (const {
    item: { label },
    exitCode,
  } of evaluateResults(
    drawPropertySamples(failedGatedJobs, { numRuns: 100 }),
    ({ value: [job, result, event] }) => ({
      event,
      results: { [job]: result },
    }),
  )) {
    expect(exitCode, label).toBe(1);
  }
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
    expect(selectedBy, job).toEqual([
      ...(scope === null ? [] : [scope]),
      ...(fastJobScopes[job] ? [fastJobScopes[job]] : []),
    ]);
  }
});

const unsuccessfulFullDepthJobs = fc.tuple(
  fc.constantFrom(...gatedJobs),
  fc.constantFrom("skipped", "cancelled", "failure"),
  fc.constantFrom(...FULL_DEPTH_EVENTS),
);

test("a full-depth run fails every planned job that did not succeed", () => {
  for (const {
    item: { label },
    exitCode,
  } of evaluateResults(
    drawPropertySamples(unsuccessfulFullDepthJobs, { numRuns: 100 }),
    ({ value: [job, result, event] }) => ({
      event,
      results: { [job]: result },
      suiteDepth: SUITE_DEPTH.full,
    }),
  )) {
    expect(exitCode, label).toBe(1);
  }
});

test("a full-depth run passes jobs whose scope was not planned only when skipped", () => {
  const gates: ExpectedResultGate[] = [];
  for (const job of gatedJobs) {
    const scope = jobScopes[job];
    if (scope === undefined || scope === null) {
      continue;
    }
    for (const event of FULL_DEPTH_EVENTS) {
      const unplanned = { event, unplannedScopes: [scope] };
      gates.push(
        {
          label: `${event} ${job} skipped`,
          options: { ...unplanned, results: { [job]: "skipped" } },
          exitCode: 0,
        },
        {
          label: `${event} ${job} cancelled`,
          options: { ...unplanned, results: { [job]: "cancelled" } },
          exitCode: 1,
        },
      );
    }
  }
  expectResultGates(gates);
});

// A pull request always plans `fast`; a manual run plans the depth it was
// dispatched with. Both can be superseded by a newer run.
const FAST_DEPTH_EVENTS = [EVENT.pullRequest, EVENT.workflowDispatch] as const;

test("CI result rejects a failed check leg after independent guards finish", () => {
  for (const event of [EVENT.mergeGroup, EVENT.pullRequest]) {
    const results = Object.fromEntries(
      resultJob.needs.map((job) => [job, "success"]),
    );
    expect(evaluateResult({ event, results })).toBe(0);
    for (const leg of [
      "ci-checks-generated",
      "ci-checks-policy",
      "ci-checks-rest",
    ]) {
      expect(resultJob.needs).toContain(leg);
      expect(
        evaluateResult({ event, results: { ...results, [leg]: "failure" } }),
        leg,
      ).toBe(1);
    }
  }
});

test.each(resultJob.needs)(
  "failed %s cannot pass with cancelled siblings or supersession evidence",
  (failedJob) => {
    const gates: ExpectedResultGate[] = [];
    for (const event of [EVENT.mergeGroup, EVENT.pullRequest]) {
      for (const cancellationEvidence of ["missing", "superseded"] as const) {
        const results = Object.fromEntries(
          resultJob.needs.map((job) => [job, "cancelled"]),
        );
        results["ci-plan"] = "success";
        results[failedJob] = "failure";
        gates.push({
          label: `${event} ${failedJob} ${cancellationEvidence}`,
          options: { event, results, cancellationEvidence },
          exitCode: 1,
        });
      }
    }
    expectResultGates(gates);
  },
);

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

test("ci-result diagnoses timeouts before main-heavy cancellation or supersession", () => {
  const cases = [false, true].flatMap((heavyOnly) => [
    {
      label: `annotation timeout, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "timeout" as const,
      jobConclusion: undefined,
      embeddedStepFailure: false,
      expectedExit: 1,
      expectedDiagnostic: true,
    },
    {
      label: `step timeout, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "step-timeout" as const,
      jobConclusion: "failure" as const,
      embeddedStepFailure: true,
      expectedExit: 1,
      expectedDiagnostic: true,
    },
    {
      label: `timed_out conclusion, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: "timed_out" as const,
      embeddedStepFailure: false,
      expectedExit: 1,
      expectedDiagnostic: true,
    },
    {
      label: `ordinary supersession, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: undefined,
      embeddedStepFailure: false,
      expectedExit: heavyOnly ? 1 : 0,
      expectedDiagnostic: false,
    },
    {
      label: `failed job, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: "failure" as const,
      embeddedStepFailure: false,
      expectedExit: 1,
      expectedDiagnostic: false,
    },
    {
      label: `failed step, heavy_only=${heavyOnly}`,
      heavyOnly,
      cancellationEvidence: "superseded" as const,
      jobConclusion: undefined,
      embeddedStepFailure: true,
      expectedExit: 1,
      expectedDiagnostic: false,
    },
  ]);
  for (const { item, exitCode, stdout } of evaluateResults(
    cases,
    ({
      heavyOnly,
      cancellationEvidence,
      jobConclusion,
      embeddedStepFailure,
    }) => ({
      event: EVENT.workflowDispatch,
      suiteDepth: heavyOnly ? SUITE_DEPTH.full : SUITE_DEPTH.fast,
      results: {
        "e2e-production-shard":
          jobConclusion === "failure" ? "failure" : "cancelled",
      },
      heavyOnly,
      cancellationEvidence,
      ...(jobConclusion === undefined ? {} : { jobConclusion }),
      embeddedStepFailure,
    }),
  )) {
    expect(exitCode, item.label).toBe(item.expectedExit);
    if (item.expectedDiagnostic) {
      expect(stdout, item.label).toContain(
        "CI job timed out: e2e-production-shard",
      );
    } else {
      expect(stdout, item.label).not.toContain("CI job timed out:");
      if (item.heavyOnly && item.label.startsWith("ordinary supersession")) {
        expect(stdout).toContain("Main heavy suites were cancelled.");
      }
    }
  }

  const timeoutDetectionDisabled = resultStep.run.replace(
    'contains("has exceeded the maximum execution time")',
    "false",
  );
  expect(timeoutDetectionDisabled).not.toBe(resultStep.run);
  const mutated = onlyOutcome(
    evaluateResults([null], () => ({
      event: EVENT.workflowDispatch,
      results: { "e2e-production-shard": "cancelled" },
      heavyOnly: false,
      suiteDepth: SUITE_DEPTH.fast,
      cancellationEvidence: "timeout",
      outcomeScript: timeoutDetectionDisabled,
    })),
  );
  expect(mutated.stdout).not.toContain("CI job timed out:");
});

test("a run that passes as superseded records no completion evidence", () => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-result-evidence-"));
  try {
    const cases = [
      { label: "complete", results: {} },
      ...resultJob.needs
        .filter((job) => job !== "ci-plan")
        .map((job) => ({ label: job, results: { [job]: "cancelled" } })),
    ];
    for (const { item, exitCode, stdout } of runBashBatch(cases, (entry) => {
      const base = resultGateCase({
        event: EVENT.pullRequest,
        results: entry.results,
        suiteDepth: SUITE_DEPTH.fast,
        cancellationEvidence: "superseded",
      });
      return {
        ...base,
        env: {
          ...base.env,
          GITHUB_OUTPUT: nodePath.join(directory, entry.label),
          RUN_REQUIRED: "true",
          COMPLETION_MARKER: "ci-completed-v5-fixture",
          HEAD_SHA: "a".repeat(40),
          BASE_SHA: "b".repeat(40),
          HEAD_REPO_ID: "456",
        },
      };
    })) {
      expect(exitCode, item.label).toBe(0);
      const output = nodePath.join(directory, item.label);
      const written = existsSync(output) ? readFileSync(output, "utf-8") : "";
      expect(written.includes("evidence="), item.label).toBe(
        item.label === "complete",
      );
      if (item.label !== "complete") {
        expect(stdout, item.label).toContain("superseded");
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("cancelled jobs retain failed-step evidence and cannot pass verified supersession", () => {
  const cases = [...FAST_DEPTH_EVENTS, EVENT.mergeGroup].flatMap((event) =>
    resultJob.needs.map((job) => ({ event, job })),
  );
  for (const { item, exitCode, stdout } of evaluateResults(
    cases,
    ({ event, job }) => ({
      event,
      results: { [job]: "cancelled" },
      cancellationEvidence: "superseded",
      embeddedStepFailure: true,
    }),
  )) {
    expect(exitCode, `${item.event}/${item.job}`).toBe(1);
    expect(stdout).toContain("Cancelled CI job contains a failed step:");
    expect(stdout).toContain("3: Validate contract");
  }
  const options = {
    event: EVENT.pullRequest,
    results: { "ci-tests": "cancelled" },
    cancellationEvidence: "superseded",
    embeddedStepFailure: true,
  } as const;
  const outcomeScript = resultStep.run.replace(
    'if [[ -n "$failed_steps" ]]; then',
    "if false; then",
  );
  expect(outcomeScript).not.toBe(resultStep.run);
  expect(evaluateResult({ ...options, outcomeScript })).toBe(0);
});

test("ci-result summary opens with the failed job and step before its cancelled verdict", () => {
  const outcomeScript = `
GITHUB_STEP_SUMMARY=$(mktemp)
trap 'printf "\\nRECORDED_SUMMARY\\n"; cat "$GITHUB_STEP_SUMMARY"; rm "$GITHUB_STEP_SUMMARY"' EXIT
${resultStep.run}`;
  const result = onlyOutcome(
    evaluateResults([EVENT.mergeGroup], (event) => ({
      event,
      results: { "ci-tests": "cancelled" },
      cancellationEvidence: "missing",
      embeddedStepFailure: true,
      outcomeScript,
    })),
  );
  expect(result.exitCode).toBe(1);
  const summary = result.stdout.split("RECORDED_SUMMARY\n").at(1);
  expect(summary).toMatch(
    /^Merge group failed: .+ \/ 3: Validate contract \(https:\/\/example\.test\/jobs\/10\)\. Other jobs were cancelled to free runners\.\n$/u,
  );
  expect(result.stdout.split("RECORDED_SUMMARY").at(0)).toContain(
    summary?.trim() ?? "missing summary",
  );
});

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
      evaluateResult({
        event,
        results: skippedHeavy,
        suiteDepth: fast,
        unplannedScopes: Object.values(fastJobScopes),
      }),
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

test("a planned release screenshot check certifies the merge group", () => {
  // The planner selects it only for release pull requests and tags, so a
  // full-depth gate would skip it on the pull request every time.
  expect(jobIf(ciJobs["marketing-screenshots"])).toContain(
    "needs.ci-plan.outputs.marketing_screenshots_required == 'true'",
  );
  expect(heavyJobs).toContain("marketing-screenshots");
  expect(fastRequired).not.toContain("marketing-screenshots");
  const event = EVENT.mergeGroup;
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

test("path-scoped platform checks run in the merge group", () => {
  for (const job of ["desktop-clippy", "windows-scripts"]) {
    expect(fastRequired, job).not.toContain(job);
    expect(heavyJobs, job).toContain(job);
    expect(typeof jobScopes[job], job).toBe("string");
  }
});

test("every bounded-install implementation and fixture selects Windows", () => {
  const files = [...new Bun.Glob("scripts/ci-install*.ts").scanSync()];
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(runSelector([file], ["windows_scripts_required"]), file).toEqual([
      "true",
    ]);
  }
});

test("a fast-depth run requires every selected fast-required job to run", () => {
  expect(fastRequired.length).toBeGreaterThan(0);
  const gates: ExpectedResultGate[] = [];
  for (const job of fastRequired) {
    expect(jobScopes).toHaveProperty(job);
    const scope = fastJobScopes[job] ?? jobScopes[job];
    // A scope-less job always runs; a scoped job must be selected by the plan.
    if (fastJobScopes[job] === undefined) {
      expect(heavyJobs, job).not.toContain(job);
    }
    const event = EVENT.pullRequest;
    gates.push(
      {
        label: job,
        options: { event, results: { [job]: "success" } },
        exitCode: 0,
      },
      {
        label: job,
        options: { event, results: { [job]: "skipped" } },
        exitCode: 1,
      },
      {
        label: job,
        options: {
          event,
          results: { [job]: "cancelled" },
          cancellationEvidence: "superseded",
        },
        exitCode: 0,
      },
    );
    if (typeof scope === "string") {
      gates.push({
        label: job,
        options: {
          event,
          results: { [job]: "skipped" },
          unplannedScopes: [scope],
        },
        exitCode: 0,
      });
    }
  }
  // Any other planned job may still skip at fast depth.
  for (const job of gatedJobs.filter((name) => !fastRequired.includes(name))) {
    gates.push({
      label: job,
      options: { event: EVENT.pullRequest, results: { [job]: "skipped" } },
      exitCode: 0,
    });
  }
  expectResultGates(gates);
});

const MatrixJob = v.object({
  strategy: v.object({
    matrix: v.object({ include: v.array(MatrixEntry) }),
  }),
});

const jobSteps = (job: unknown) =>
  v.parse(
    v.object({
      steps: v.pipe(
        v.unknown(),
        v.transform(flattenWorkflowSteps),
        v.array(
          v.object({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
            if: v.optional(v.string()),
            env: v.optional(v.record(v.string(), v.string())),
          }),
        ),
      ),
    }),
    job,
  ).steps;

test("UI playground scope covers the component directories rendered by its table bench", () => {
  const bench = readFileSync(
    new URL(
      "../apps/web/src/routes/dev/-components/workspace-table-playground.tsx",
      import.meta.url,
    ),
    "utf-8",
  );
  const tableModulePath =
    "../apps/web/src/features/case-law/components/decision-table.tsx";
  expect(bench).toContain(
    'from "@/features/case-law/components/decision-table"',
  );

  const tableModule = readFileSync(
    new URL(tableModulePath, import.meta.url),
    "utf-8",
  );
  const renderedComponentDirectories = new Set(
    [...tableModule.matchAll(/from "@\/(components\/.+)\/[^/"]+"/gu)].flatMap(
      ([, directory]) =>
        directory === undefined ? [] : [`apps/web/src/${directory}`],
    ),
  );
  expect(renderedComponentDirectories.size).toBeGreaterThan(0);

  const scopeStep = jobSteps(ciJobs["ci-browser"]).find(
    ({ name }) => name === "Check UI browser test scope",
  );
  expect(scopeStep?.run).toBeDefined();
  for (const directory of renderedComponentDirectories) {
    expect(scopeStep?.run, directory).toContain(`  ${directory} \\`);
  }
});

test("CI plan guards see checks nested inside parallel groups", () => {
  const guard = {
    name: "Nested check",
    run: "bun test scripts/ci-plan.test.ts",
    if: "!cancelled() && steps.install.outcome == 'success'",
    env: { CHECK_REQUIRED: "true" },
  };
  expect(jobSteps({ steps: [{ parallel: [{ parallel: [guard] }] }] })).toEqual([
    guard,
  ]);
});

type ResolveDepthOptions = {
  ref?: string;
  allowFull?: string;
  heavyOnly?: string;
};
const resolveDepth = (
  eventName: string,
  dispatchDepth: string,
  options: ResolveDepthOptions = {},
) => {
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
        DISPATCH_REF: options.ref ?? "refs/heads/main",
        ALLOW_FULL: options.allowFull ?? "false",
        HEAVY_ONLY: options.heavyOnly ?? "false",
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

const shellLocals = (script: string): Set<string> => {
  const withoutExpressions = script.replace(/\$\{\{[\s\S]*?\}\}/gu, "");
  const defined = new Set<string>();
  const declarations = /\b(?:local|declare|typeset|readonly)\s+([^\n;]+)/gu;
  for (const [, names] of withoutExpressions.matchAll(declarations)) {
    for (const [, name] of (names ?? "").matchAll(
      /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)(?==|\s|$)/gu,
    )) {
      if (name !== undefined) {
        defined.add(name);
      }
    }
  }
  for (const [, assignment, loop] of withoutExpressions.matchAll(
    /(?:^|[\s;]|\()([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)|\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/gu,
  )) {
    const name = assignment ?? loop;
    if (name !== undefined) {
      defined.add(name);
    }
  }
  for (const [, name] of withoutExpressions.matchAll(
    /\bread\b[^\n;]*?\s([A-Za-z_][A-Za-z0-9_]*)\s*(?:$|;)/gmu,
  )) {
    if (name !== undefined) {
      defined.add(name);
    }
  }
  return defined;
};

const shellVariableReads = (script: string): Set<string> => {
  const reads = new Set<string>();
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (character === "\\" && quote !== "single") {
      index += 1;
      continue;
    }
    if (quote === "single") {
      if (character === "'") {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" && quote === undefined) {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (
      character === "#" &&
      quote === undefined &&
      (index === 0 || /[\s;|&()]/u.test(script[index - 1] ?? ""))
    ) {
      const newline = script.indexOf("\n", index);
      index = newline === -1 ? script.length : newline;
      continue;
    }
    if (character !== "$" || script[index + 1] === "{") {
      if (character === "$" && script[index + 1] === "{") {
        const end = script.indexOf("}", index + 2);
        if (end !== -1) {
          const expansion = script.slice(index + 2, end);
          const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/u.exec(expansion);
          if (match?.[1] !== undefined && !/^:?[-+]/u.test(match[2] ?? "")) {
            reads.add(match[1]);
          }
          index = end;
        }
      }
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(script.slice(index + 1));
    if (match?.[0] !== undefined) {
      reads.add(match[0]);
      index += match[0].length;
    }
  }
  return reads;
};

test("CI shell steps using nounset define every variable they read", () => {
  const parsedWorkflow = v.parse(
    v.looseObject({
      env: v.optional(v.record(v.string(), v.unknown())),
      jobs: v.record(v.string(), v.unknown()),
    }),
    Bun.YAML.parse(workflow),
  );
  const runnerEnvironment = new Set([
    "CI",
    "GITHUB_ACTION",
    "GITHUB_ACTION_PATH",
    "GITHUB_ACTION_REPOSITORY",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "GITHUB_ACTOR_ID",
    "GITHUB_API_URL",
    "GITHUB_BASE_REF",
    "GITHUB_ENV",
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_GRAPHQL_URL",
    "GITHUB_HEAD_REF",
    "GITHUB_JOB",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REF_PROTECTED",
    "GITHUB_REF_TYPE",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_RETENTION_DAYS",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_NUMBER",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_WORKFLOW",
    "GITHUB_WORKSPACE",
    "HOME",
    "ImageOS",
    "ImageVersion",
    "RUNNER_ARCH",
    "RUNNER_NAME",
    "RUNNER_OS",
    "RUNNER_TEMP",
    "RUNNER_TOOL_CACHE",
    "BASH_REMATCH",
    "BASH_SOURCE",
    "BASH_VERSION",
    "BASHOPTS",
    "BASHPID",
    "EUID",
    "FUNCNAME",
    "IFS",
    "OLDPWD",
    "PIPESTATUS",
    "PPID",
    "PWD",
    "SHELLOPTS",
    "UID",
  ]);
  const rawJob = parsedWorkflow.jobs["ci-plan"];
  if (rawJob === undefined) {
    throw new TypeError("Missing ci-plan job");
  }
  const job = v.parse(
    v.looseObject({
      env: v.optional(v.record(v.string(), v.unknown())),
      steps: v.optional(v.unknown()),
    }),
    rawJob,
  );
  const jobEnvironment = new Set([
    ...Object.keys(parsedWorkflow.env ?? {}),
    ...Object.keys(job.env ?? {}),
  ]);
  const failures = flattenWorkflowSteps(job.steps ?? []).flatMap((step) => {
    if (
      typeof step["run"] !== "string" ||
      !/\bset\s+-[^\n]*u/u.test(step["run"])
    ) {
      return [];
    }
    const stepDetails = v.parse(
      v.looseObject({
        name: v.optional(v.string()),
        env: v.optional(v.record(v.string(), v.unknown())),
        run: v.string(),
      }),
      step,
    );
    const defined = new Set([
      ...runnerEnvironment,
      ...jobEnvironment,
      ...Object.keys(stepDetails.env ?? {}),
      ...shellLocals(stepDetails.run),
    ]);
    const shell = stepDetails.run.replace(/\$\{\{[\s\S]*?\}\}/gu, "");
    const missing = [...shellVariableReads(shell)]
      .filter((name) => !defined.has(name))
      .toSorted(compareCodeUnit);
    return missing.length > 0
      ? [`ci-plan/${stepDetails.name ?? "unnamed step"}: ${missing.join(", ")}`]
      : [];
  });
  expect(failures).toEqual([]);
});

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
    `\${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') || (inputs.heavy_only != true && (github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch')) }}`,
  );
  expect(concurrency.group).toContain(
    "github.event_name == 'workflow_dispatch' && format('ci-dispatch-{0}', github.ref)",
  );
  expect(concurrency.group).toContain(
    "format('pr-{0}', github.event.pull_request.number || github.ref)",
  );
  expect(concurrency.group).toContain("format('run-{0}', github.run_id)");
});

test("full feature-branch dispatch requires an explicit opt-in at planning time", () => {
  for (const heavyOnly of ["false", "true"]) {
    expect(
      resolveDepth(EVENT.workflowDispatch, "full", {
        ref: "refs/heads/feature",
        heavyOnly,
      }),
    ).toBe("error");
    expect(
      resolveDepth(EVENT.workflowDispatch, "full", {
        ref: "refs/heads/feature",
        allowFull: "true",
        heavyOnly,
      }),
    ).toBe("suite_depth=full");
    expect(resolveDepth(EVENT.workflowDispatch, "full", { heavyOnly })).toBe(
      "suite_depth=full",
    );
  }
  expect(
    resolveDepth(EVENT.workflowDispatch, "fast", { ref: "refs/heads/feature" }),
  ).toBe("suite_depth=fast");
  expect(
    resolveDepth(EVENT.mergeGroup, "full", { ref: "refs/heads/queue" }),
  ).toBe("suite_depth=full");
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

test("API determinism runs only after installation for its selected scope", () => {
  const condition = jobSteps(ciJobs["ci-checks-generated"]).find(
    ({ name }) => name === "Web API types determinism guard",
  )?.if;
  if (condition === undefined) {
    panic("Missing API determinism guard");
  }
  for (const cancelled of [false, true]) {
    for (const install of ["success", "failure", "skipped"]) {
      for (const packageChecks of [false, true]) {
        for (const apiTypes of [false, true]) {
          expect(
            evaluate(condition, {
              status: { cancelled },
              values: {
                "steps.install.outcome": install,
                "needs.ci-plan.outputs.package_checks_required":
                  String(packageChecks),
                "needs.ci-plan.outputs.web_api_types_required":
                  String(apiTypes),
              },
            }),
          ).toBe(
            !cancelled && install === "success" && packageChecks && apiTypes,
          );
        }
      }
    }
  }
});

const packageScopeStart = workflow.indexOf(
  "          package_checks_required=true\n          if [[",
);
const packageScopeEnd = workflow.indexOf(
  "          docs_checks_required=false",
  packageScopeStart,
);
if (packageScopeStart === -1 || packageScopeEnd <= packageScopeStart) {
  panic("Package scope must be bounded by the documentation scope");
}
const packageScope = workflow.slice(packageScopeStart, packageScopeEnd);

const packageChecksPlan = (files: readonly string[]) => {
  const process = Bun.spawnSync({
    cmd: [
      "bash",
      "-e",
      "-c",
      `changed_files=("$@"); desktop_rust_checks_required=false
${packageScope}
printf "%s\\n" "$package_checks_required"`,
      "ci-plan-test",
      ...files,
    ],
    env: { PATH: Bun.env["PATH"] ?? "", EVENT_NAME: "pull_request" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(process.exitCode, new TextDecoder().decode(process.stderr)).toBe(0);
  return new TextDecoder().decode(process.stdout).trim();
};

test("pull requests and merge groups use the same fail-closed package detector", () => {
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    for (const [fake, expected] of [
      ["printf false", "false"],
      ["printf true", "true"],
      ["printf invalid", "true"],
      ["return 1", "true"],
    ] as const) {
      const result = Bun.spawnSync(
        [
          "bash",
          "-e",
          "-c",
          `bun() { ${fake}; }; changed_files=(docs/guide.md);\n${packageScope}\nprintf '%s' "$package_checks_required"`,
        ],
        {
          env: { PATH: Bun.env["PATH"] ?? "", EVENT_NAME: event },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toBe(expected);
    }
  }
});

test("transfer read guard runs for API-only pull request changes", () => {
  const guard = jobSteps(ciJobs["ci-checks-rest"]).find(
    ({ name }) => name === "Transfer timeout and fixed read guard",
  );
  expect(guard?.if).toContain("steps.install.outcome == 'success'");
  expect(guard?.if).toContain(
    "(needs.ci-plan.outputs.package_checks_required == 'true')",
  );
  expect(guard?.run).toContain("scripts/transfer-read-guard.test.ts");
  expect(guard?.run).toContain("bun scripts/transfer-read-guard.ts");
  expect(packageChecksPlan(["apps/api/src/handlers/files/get.ts"])).toBe(
    "true",
  );
  expect(jobScopes["ci-checks-rest"]).toBe("package_checks_required");
  expect(fastRequired).toContain("ci-checks-rest");
});

// Scope subprocesses take 1.6 s serial and exceed 5 s while CI checks run in parallel.
test("CLI packaging parity runs whenever CLI sources, codegen or generated outputs change", () => {
  expect(packageScopeStart).toBeGreaterThan(-1);
  expect(selector).toContain(packageScope);
  const parity = Object.entries(ciJobs).flatMap(([job, body]) =>
    (v.is(v.object({ steps: v.array(v.unknown()) }), body)
      ? jobSteps(body)
      : []
    )
      .filter(({ run }) => run?.includes("scripts/cli-runtime-pack.test.ts"))
      .map(({ name, if: condition }) => ({ job, name, condition })),
  );
  expect(parity.map(({ job, name }) => `${job}: ${String(name)}`)).toEqual([
    "ci-checks-rest: Test CLI runtime package parity",
  ]);
  expect(parity.at(0)?.condition).toBe(
    `\${{ !cancelled() && steps.install.outcome == 'success' && (needs.ci-plan.outputs.package_checks_required == 'true') }}`,
  );
  expect(jobScopes["ci-checks-rest"]).toBe("package_checks_required");
  expect(fastRequired).toContain("ci-checks-rest");
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-checks-rest": "skipped" },
    }),
  ).toBe(1);

  const generators = GENERATORS.filter(({ id }) =>
    ["cli-registry", "cli-runtime"].includes(id),
  );
  expect(generators).toHaveLength(2);
  const cliPaths = [
    ...generators.flatMap(({ inputs }) => inputs),
    ...generators.flatMap(({ outputs }) => outputs),
    "packages/cli/src/cli.ts",
    "packages/cli/src/codegen-version.ts",
    "scripts/generated-files.ts",
    "scripts/generated-imports.ts",
    "scripts/cli-runtime-pack.test.ts",
  ].map((glob) =>
    glob.replaceAll("**", "example/generated.ts").replaceAll("*", "example"),
  );
  // The scope is not trivially on: provenance-only changes skip it.
  expect(packageChecksPlan(["provenance/attestation.json"])).toBe("false");
  // Every CLI path, alone and on either side of skipped provenance files.
  const provenance = [".provenance.yml", "provenance/attestation.json"];
  for (const cliPath of cliPaths) {
    for (const files of [
      [cliPath],
      [cliPath, ...provenance],
      [...provenance, cliPath],
    ]) {
      expect(packageChecksPlan(files), files.join(" ")).toBe("true");
    }
  }
}, 15_000);

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
    .toSorted((a, b) => compareCodeUnit(a.platform, b.platform));
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
      platforms.toSorted((a, b) => compareCodeUnit(a.platform, b.platform)),
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

test("spec-tree PRs plan production shards and their web build at fast depth", () => {
  for (const file of [
    "apps/web/e2e/specs/new.spec.ts",
    "apps/web/e2e/helpers/test.ts",
    "apps/web/e2e/fixtures/simple.docx",
    "apps/web/e2e/playwright.config.ts",
  ]) {
    const planned = runSelector(
      [file],
      ["e2e_production_required", "web_build_required"],
    );
    expect(planned, file).toEqual(["true", "true"]);
    expect(jobScopes["e2e-production-shard"]).toBe("e2e_production_required");
    expect(fastJobScopes["web-build"]).toBe("browser_spec_selection_required");
    expect(jobIf(ciJobs["web-build"])).toContain(
      "needs.ci-plan.outputs.browser_spec_selection_required == 'true'",
    );
    expect(jobIf(ciJobs["e2e-production-shard"])).toContain(
      "needs.ci-plan.outputs.e2e_production_required == 'true'",
    );
    expect(fastRequired).toContain("e2e-production-shard");
    expect(fastRequired).toContain("web-build");
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { "e2e-production-shard": "skipped" },
      }),
    ).toBe(1);
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { "e2e-production-shard": "failure" },
      }),
    ).toBe(1);
  }
});

test("PR e2e selection schedules its build and shard together", () => {
  const selected = {
    event: EVENT.pullRequest,
    depth: SUITE_DEPTH.fast,
  } as const;
  expect(runsAtDepth(jobIf(ciJobs["web-build"]), selected)).toBe(true);
  expect(runsAtDepth(jobIf(ciJobs["e2e-production-shard"]), selected)).toBe(
    true,
  );

  const values = {
    "github.event_name": EVENT.pullRequest,
    "inputs.heavy_only": false,
    "needs.ci-plan.outputs.run_required": "true",
    "needs.ci-plan.outputs.trusted": "true",
    "needs.ci-plan.outputs.coverage_profile": "normal-v1",
    "needs.ci-plan.outputs.queue_depth": "full",
    "needs.ci-plan.outputs.web_build_required": "false",
    "needs.ci-plan.outputs.browser_spec_selection_required": "false",
    "needs.ci-plan.outputs.e2e_production_required": "false",
    "needs.web-build.result": "skipped",
    "needs.heavy-web-build.result": "skipped",
    "vars.QUEUE_BROWSER_SUITES": "",
  };
  expect(
    evaluate(jobIf(ciJobs["web-build"]), {
      values,
      status: { always: true, success: true, failure: false, cancelled: false },
    }),
  ).toBe(false);
  expect(
    evaluate(jobIf(ciJobs["e2e-production-shard"]), {
      values,
      status: { always: true, success: true, failure: false, cancelled: false },
    }),
  ).toBe(false);
  expect(runSelector(["README.md"], ["e2e_production_required"])).toEqual([
    "false",
  ]);
});

test("Playwright shard generation fails before loading an empty spec list", () => {
  const run = jobSteps(ciJobs["e2e-production-shard"]).find(
    ({ name }) => name === "Run Playwright shard",
  )?.run;
  expect(run).toContain(
    'specs_output=$(bun scripts/e2e-spec-shards-core.ts files "$E2E_SHARD")',
  );
  expect(run).toContain('[[ -n "$specs_output" ]]');
  expect(run).toContain('mapfile -t specs <<< "$specs_output"');
  expect(run).not.toContain(
    "mapfile -t specs < <(bun scripts/e2e-spec-shards-core.ts",
  );
});

test("production shards keep full-depth core coverage and exclude unrelated fast PRs", () => {
  for (const file of [
    "apps/api/src/handlers/tasks/get.ts",
    "apps/web/src/routes/index.tsx",
    "packages/ui/src/button.tsx",
  ]) {
    expect(runSelector([file], ["e2e_production_required"])).toEqual(["false"]);
    expect(
      runSelector(
        [file],
        ["e2e_production_required"],
        "full",
        "false",
        "merge_group",
      ),
    ).toEqual(["true"]);
  }
  for (const file of [
    "README.md",
    "apps/web/e2e/collab/room.spec.ts",
    "apps/web/e2e/playwright.collab.config.ts",
    "apps/web/e2e/marketing/product.spec.ts",
    "apps/web/e2e/playwright.marketing.config.ts",
  ]) {
    expect(runSelector([file], ["e2e_production_required"])).toEqual(["false"]);
  }
  expect(
    runSelector(
      ["apps/web/e2e/specs/new.spec.ts"],
      ["e2e_production_required"],
      "fast",
      "false",
      "workflow_dispatch",
    ),
  ).toEqual(["false"]);
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "e2e-production-shard": "skipped" },
      unplannedScopes: ["e2e_production_required"],
    }),
  ).toBe(0);
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
          ).toMatch(
            /bun run generate|bun scripts\/ci-generated-sources\.ts restore/u,
          );
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
      ).toMatch(
        /bun run(?: --cwd \.\.\/\.\.)? generate|bun scripts\/ci-generated-sources\.ts prepare/u,
      );
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
  const directory = realpathSync(
    mkdtempSync(nodePath.join(tmpdir(), "folded-image-deps-")),
  );
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
      // GitHub sets RUNNER_TEMP; bounded installs write their logs below it.
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: directory,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    const commands = readFileSync(nodePath.join(bin, "bun.log"), "utf-8");
    expect(commands).toContain(
      `${directory}/api-install:../scripts/ci-install.ts ${directory}/bun-install/api-image.log --filter @stll/api --filter @stll/collab --filter @stll/legal-atlas-runner --frozen-lockfile --ignore-scripts`,
    );
    expect(commands).toContain(
      `${directory}/runner-install:../scripts/ci-install.ts ${directory}/bun-install/legal-atlas.log --filter @stll/legal-atlas-runner --production --frozen-lockfile --ignore-scripts`,
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
    "code-quality-web-rest",
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
  ]) {
    expect(resultJob.needs).toContain(job);
    expect(jobScopes[job]).toBe("package_checks_required");
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
    ({ run }) =>
      run?.includes("test:") ||
      run?.includes(" test ") ||
      run === "bun scripts/run-corpus-engine-suites.ts",
  );
  expect(suites.map(({ name }) => name)).toEqual([
    "Run Postgres-gated API suites",
    "Run corpus engine suites",
    "Run Valkey-gated API suites",
    "Run cross-replica collaboration suite",
  ]);
  const suiteScopes = [
    ["Run Postgres-gated API suites", "postgres_suites_required"],
    ["Run corpus engine suites", "corpus_suites_required"],
    ["Run Valkey-gated API suites", "valkey_suites_required"],
    ["Run cross-replica collaboration suite", "collaboration_suite_required"],
  ] as const;
  for (const suite of suites) {
    const scope = suiteScopes.find(([name]) => name === suite.name)?.[1];
    if (scope === undefined) {
      throw new TypeError(`No service scope for ${suite.name}`);
    }
    const predicate = `needs.ci-plan.outputs.${scope} == 'true'`;
    expect(suite.if).toBe(
      scope === "postgres_suites_required"
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
        unplannedScopes: [
          "service_suites_required",
          "service_suites_pr_required",
        ],
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
    const installCondition =
      "needs.ci-plan.outputs.package_checks_required == 'true'";
    const install = steps.find(({ name }) => name === "Install dependencies");
    if (job === "ci-checks-policy") {
      expect(install?.if).toContain("steps.checkout.outcome == 'success'");
    } else {
      expect(install?.if).toContain(`(${installCondition})`);
    }
    const guards = steps.filter(({ run }) =>
      run?.includes("bun test packages/property-testing/"),
    );
    guardCount += guards.length;
    if (guards.length > 0) {
      expect(installCondition, job).toBeDefined();
    }
    for (const guard of guards) {
      expect(guard.if, `${job}: ${String(guard.name)}`).toBe(
        `\${{ !cancelled() && steps.install.outcome == 'success' && (${installCondition}) }}`,
      );
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
  suiteDepth?: SuiteDepth;
  baseRef?: string;
  changedPath?: "bun.lock" | "package.json" | "e2e-spec" | "documentation";
  gitShim?: string;
};

const runChangedFilesStep = ({
  suiteDepth = "fast",
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
      RUNNER_TEMP: directory,
      PATH: gitShim
        ? `${nodePath.dirname(gitShim)}:${process.env["PATH"] ?? ""}`
        : (process.env["PATH"] ?? ""),
      PR_TITLE: "",
      SUITE_DEPTH: suiteDepth,
    };
    const run = Bun.spawnSync(["bash", "-e", "-c", step?.run ?? "exit 1"], {
      cwd: repository,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    expect(
      readFileSync(nodePath.join(directory, "api-test-changed-paths"), "utf-8")
        .split("\0")
        .filter(Boolean),
    ).toEqual(baseRef === "main" && gitShim === undefined ? paths : []);
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
    expect(outputs.get("service_suites_pr_required")).toBe("false");
  }
});

test("an unknown diff base plans malware and e2e scans", () => {
  const outputs = runChangedFilesStep({ baseRef: "missing-base" });
  expect(outputs.get("dependency_malware_required")).toBe("true");
  expect(outputs.get("e2e_core_required")).toBe("true");
  expect(outputs.get("service_suites_pr_required")).toBe("true");
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
        matrix: v.object({ suite: v.string() }),
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
  const matrixSuites = v.parse(
    v.array(v.string()),
    evaluate(browser.strategy.matrix.suite, {
      values: { "github.event_name": "merge_group" },
    }),
  );
  expect(new Set(matrixSuites)).toEqual(new Set(["desktop", "ui"]));
  expect(matrixSuites).toHaveLength(2);
  expect(
    evaluate(browser.strategy.matrix.suite, {
      values: { "github.event_name": "pull_request" },
    }),
  ).toEqual(["desktop"]);
  const suites = browser.steps.filter(
    ({ run }) => run?.includes("test:browser") || run?.includes("test:e2e"),
  );
  expect(suites.map(({ name }) => name).toSorted(compareCodeUnit)).toEqual(
    [
      "Test desktop browser interactions",
      "Test extension browser boundary",
      "Test UI browser interactions",
      "Test UI playground visuals",
    ].toSorted(compareCodeUnit),
  );
  for (const suite of suites) {
    const legs = matrixSuites.filter((leg) =>
      suite.if?.includes(`matrix.suite == '${leg}'`),
    );
    expect(legs, suite.name).toHaveLength(1);
    expect(suite.if, suite.name).toContain("outputs.required == 'true'");
  }
  expect(resultJob.needs).toContain("ci-browser");
  expect(jobScopes["ci-browser"]).toBe("ci_browser_required");
  for (const event of FULL_DEPTH_EVENTS) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(evaluateResult({ event, results: { "ci-browser": result } })).toBe(
        1,
      );
    }
  }
});

test("route-relevant changes plan the required merge-group smoke", () => {
  const scope = "route_smoke_required";
  const selectedBy = jobIf(ciJobs["route-smoke"]);
  expect(selectedBy).toContain(`needs.ci-plan.outputs.${scope} == 'true'`);
  expect(selectedBy).toContain("github.event_name == 'merge_group'");
  expect(selectedBy).toContain("needs.web-build.result == 'success'");
  expect(heavyJobs).toContain("route-smoke");
  expect(jobScopes["route-smoke"]).toBe(scope);
  expect(fastRequired).not.toContain("route-smoke");
  for (const file of [
    "apps/web/src/routes/_authenticated/matters.tsx",
    "apps/web/src/routeTree.gen.ts",
    "apps/web/src/lib/react-query.ts",
    "apps/web/src/components/new-query-component.tsx",
    "apps/api/src/handlers/tasks/get.ts",
    "packages/ui/src/button.tsx",
    "apps/web/e2e/network-baseline.json",
    "scripts/network-baseline-scope.ts",
    "scripts/network-baseline-scope.test.ts",
    "scripts/network-baseline-comparison.test.ts",
    "apps/web/e2e/network-budgets/feature.json",
    ".github/actions/prepare-network-baseline/action.yml",
    ".github/actions/prepare-network-baseline/prepare.sh",
    "apps/web/e2e/specs/route-smoke.spec.ts",
    "apps/web/e2e/helpers/network.ts",
    "apps/web/e2e/helpers/workspace.ts",
    "apps/web/e2e/playwright.config.ts",
  ]) {
    expect(runSelector([file], [scope]), file).toEqual(["true"]);
  }
  expect(runSelector(["docs/example.md"], [scope])).toEqual(["false"]);
  expect(runSelector([], [scope])).toEqual(["false"]);
  for (const event of [EVENT.workflowDispatch]) {
    expect(
      runSelector(
        ["apps/web/src/routes/new.tsx"],
        [scope],
        "full",
        "false",
        event,
      ),
    ).toEqual(["false"]);
  }
  const event = EVENT.mergeGroup;
  expect(evaluateResult({ event, results: { "route-smoke": "skipped" } })).toBe(
    1,
  );
  expect(
    evaluateResult({
      event,
      results: { "route-smoke": "skipped" },
      unplannedScopes: [scope],
    }),
  ).toBe(0);
}, 30_000);

test("a merge group plans both browser suites for app changes and neither for docs", () => {
  const scopes = ["route_smoke_required", "e2e_production_required"];
  const appChange = [
    "apps/api/src/handlers/workspaces/read-activity.ts",
    "apps/web/src/components/app-sidebar.logic.ts",
    "apps/web/src/components/app-sidebar.tsx",
    "apps/web/src/lib/organization/feature-access/access.logic.ts",
    "apps/web/src/lib/organization/feature-access/surfaces.ts",
    "apps/web/src/routes/-legal-lists-route-gates.dom.test.tsx",
  ];
  expect(
    runSelector(appChange, scopes, "full", "false", EVENT.mergeGroup),
  ).toEqual(["true", "true"]);
  expect(
    runSelector(
      ["README.md", "apps/desktop/README.md"],
      scopes,
      "full",
      "false",
      EVENT.mergeGroup,
    ),
  ).toEqual(["false", "false"]);
}, 30_000);

test("route smoke consumes the production build and fails when its stack cannot run", () => {
  const plan = jobSteps(ciJobs["ci-plan"]).find(
    ({ name }) => name === "Check changed file scope",
  );
  // Keep the dependency implication executable: baseline-scope edits need a
  // build even when the ordinary app-source build filter would not select it.
  const implicationStart = workflow.indexOf(
    "          # The production e2e shards",
  );
  const implicationEnd = workflow.indexOf(
    "          printf 'Changed files:",
    implicationStart,
  );
  expect(implicationEnd).toBeGreaterThan(implicationStart);
  const implication = workflow.slice(implicationStart, implicationEnd);
  const result = Bun.spawnSync([
    "bash",
    "-e",
    "-c",
    `e2e_core_required=false; route_smoke_required=true; web_build_required=false
${implication}
[[ "$web_build_required" == true ]]`,
  ]);
  expect(result.exitCode).toBe(0);
  expect(plan?.run).toContain(
    'echo "route_smoke_required=$route_smoke_required"',
  );
  expect(workflow).toContain(
    [
      "route_smoke_required: $",
      "{{ steps.changed-files.outputs.route_smoke_required }}",
    ].join(""),
  );
  const upload = jobSteps(ciJobs["web-build"]).find(
    ({ name }) => name === "Upload production E2E web build",
  );
  expect(upload?.if).toContain(
    "needs.ci-plan.outputs.route_smoke_required == 'true'",
  );
  const steps = jobSteps(ciJobs["route-smoke"]);
  const smoke = steps.find(
    ({ name }) => name === "Check route network baseline",
  );
  expect(smoke?.run).toContain("route-smoke.spec.ts --project=route-smoke");
  const ready = steps.find(
    ({ name }) => name === "Require production browser stack",
  );
  expect(ready?.run).toBeDefined();
  for (const status of ["ready", "rate-limited", ""]) {
    const check = Bun.spawnSync(["bash", "-e", "-c", ready?.run ?? "exit 2"], {
      env: { STACK_STATUS: status },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(check.exitCode, status).toBe(status === "ready" ? 0 : 1);
  }
});

test("an unreadable PR diff requires route smoke while manual and queue runs retain their suites", () => {
  const start = workflow.indexOf(
    "          # An unreadable diff must widen every scope",
  );
  const end = workflow.indexOf(
    "          desktop_rust_checks_required=$(",
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const directory = mkdtempSync(nodePath.join(tmpdir(), "route-smoke-plan-"));
  const output = nodePath.join(directory, "output");
  try {
    for (const event of Object.values(EVENT)) {
      writeFileSync(output, "");
      const result = Bun.spawnSync(
        ["bash", "-e", "-c", workflow.slice(start, end)],
        {
          env: {
            EVENT_NAME: event,
            SUITE_DEPTH: "full",
            scope_unknown: "true",
            GITHUB_OUTPUT: output,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(output, "utf-8"))
        .toContain(`route_smoke_required=${event === EVENT.pullRequest || event === EVENT.mergeGroup}
`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("service-suite scopes remain planned while pull requests skip execution", () => {
  const scope = "service_suites_pr_required";
  const condition = jobIf(ciJobs["service-suites"]);
  expect(condition).toContain("needs.ci-plan.outputs.suite_depth == 'fast'");
  expect(condition).toContain(`needs.ci-plan.outputs.${scope} == 'true'`);
  expect(fastJobScopes["service-suites"]).toBe(scope);
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  expect(plan.outputs[scope]).toBe(
    `\${{ steps.changed-files.outputs.${scope} }}`,
  );
  const cases = [
    { file: "apps/api/src/db/schema/new.ts", required: true },
    { file: "apps/api/drizzle/123_new.sql", required: true },
    { file: "apps/api/src/lib/scheduler/new.ts", required: true },
    {
      file: "apps/api/src/handlers/legislation/new-backfill.ts",
      required: true,
    },
    { file: "apps/api/scripts/run-postgres-tests.ts", required: true },
    { file: "apps/api/src/tests/setup-env.ts", required: true },
    {
      file: "apps/api/src/lib/scheduler/runner.postgres.test.ts",
      required: true,
    },
    { file: "apps/collab/src/server.test.ts", required: true },
    {
      file: "apps/api/src/handlers/case-law/ingestion/citation-extractor.ts",
      required: true,
    },
    { file: "docs/guide.md", required: false },
    { file: "apps/web/src/new.tsx", required: false },
    { file: "apps/api/src/unused-new-handler.ts", required: false },
  ];
  // Plans, job conditions and result gates each run as one batch.
  const planned = planSelector(
    cases.map(({ file, required }) => ({
      file,
      files: [file],
      outputs: [scope],
      required,
    })),
  ).map(({ item: { file, required }, plan: values }) => ({
    file,
    required,
    selected: values.at(0) === "true",
  }));
  for (const { file, required, selected } of planned) {
    expect(selected, file).toBe(required);
  }
  // Evaluate the actual job condition with planner outputs at both depths.
  const conditions = planned.flatMap(({ file, selected }) =>
    ["fast", "full"].map((suiteDepth) => ({
      label: `${file} ${suiteDepth}`,
      executable: condition
        .replaceAll("needs.ci-plan.outputs.service_suites_required", "'true'")
        .replaceAll(
          `needs.ci-plan.outputs.${scope}`,
          () => `'${String(selected)}'`,
        )
        .replaceAll(
          "needs.ci-plan.outputs.suite_depth",
          () => `'${suiteDepth}'`,
        )
        .replaceAll("needs.ci-plan.outputs.trusted", "'true'")
        .replaceAll("github.event_name", "'pull_request'"),
      exitCode: 1,
    })),
  );
  for (const { item, exitCode } of runBashBatch(
    conditions,
    ({ executable }) => ({
      flags: [],
      script: `[[ ${executable} ]]`,
      args: [],
      env: { PATH: Bun.env["PATH"] ?? "" },
    }),
  )) {
    expect(exitCode, item.label).toBe(item.exitCode);
  }
  expectResultGates(
    planned.flatMap(({ file, selected }) =>
      ["success", "failure", "skipped", "cancelled"].map((result) => ({
        label: `${file} ${result}`,
        options: {
          event: EVENT.pullRequest,
          results: { "service-suites": result },
          unplannedScopes: selected ? [] : [scope],
        },
        exitCode: result === "success" || result === "skipped" ? 0 : 1,
      })),
    ),
  );
}, 30_000);

// The one selector run that spawns the real detector CLIs: it proves the
// wiring the in-process plans above stand in for. Each case starts three bun
// processes, and each service-suite process rebuilds its import graph (about
// a second), so a run measures ~1.3 s locally; 30 s leaves a cold runner a
// margin above 20x.
test("the selector plans the same with its detector CLIs spawned as served in process", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  const outputs = Object.entries(plan.outputs).flatMap(([name, value]) =>
    /^\$\{\{ steps\.changed-files\.outputs\.\w+ \}\}$/u.test(value)
      ? [name]
      : [],
  );
  expect(outputs).toContain("service_suites_pr_required");
  expect(outputs).toContain("dependency_malware_required");
  expect(outputs).toContain("route_smoke_required");
  const cases = [
    { files: ["apps/api/src/server.ts"], outputs },
    { files: ["apps/api/src/db/schema/new.ts", "bun.lock"], outputs },
    { files: ["apps/web/src/routes/index.tsx"], outputs },
    { files: ["docs/guide.md", "packages/time/src/index.ts"], outputs },
    { files: ["VERSION"], outputs, event: "merge_group", suiteDepth: "full" },
    {
      files: ["apps/api/src/handlers/chat/stream-chat.test.ts"],
      outputs,
      title: "fix(chat): keep ids",
    },
  ];
  const spawned = planSelector(cases, DETECTORS.spawned).map(
    ({ plan: values }) => values,
  );
  const served = planSelector(cases, DETECTORS.inProcess).map(
    ({ plan: values }) => values,
  );
  expect(served).toEqual(spawned);
  // The cases exercise both answers of every detector.
  for (const name of [
    "service_suites_pr_required",
    "dependency_malware_required",
    "route_smoke_required",
  ]) {
    const index = outputs.indexOf(name);
    expect(new Set(served.map((values) => values[index])), name).toEqual(
      new Set(["true", "false"]),
    );
  }
}, 30_000);

test("drawn property samples are the inputs fc.assert would run", () => {
  // Both sides share one explicit seed: the exploratory tier leaves the
  // default seed unset, which would give each draw an independent one.
  const seed = 20_261_003;
  const drawSamples = <T>(arbitrary: fc.Arbitrary<T>, numRuns: number) =>
    drawPropertySamples(arbitrary, { numRuns, seed }).map(({ value }) => value);
  const draws = <T>(arbitrary: fc.Arbitrary<T>, numRuns: number) => {
    const asserted: T[] = [];
    fc.assert(
      fc.property(arbitrary, (value) => {
        asserted.push(value);
      }),
      propertyConfig({ numRuns, seed }),
    );
    return asserted;
  };
  expect(drawSamples(releaseExtraFiles, 30)).toEqual(
    draws(releaseExtraFiles, 30),
  );
  expect(drawSamples(unrelatedDocNames, 30)).toEqual(
    draws(unrelatedDocNames, 30),
  );
  expect(drawSamples(apiSourceSiblings, 10)).toEqual(
    draws(apiSourceSiblings, 10),
  );
  expect(drawSamples(failedGatedJobs, 100)).toEqual(
    draws(failedGatedJobs, 100),
  );
  expect(drawSamples(unsuccessfulFullDepthJobs, 100)).toEqual(
    draws(unsuccessfulFullDepthJobs, 100),
  );
  // A tuple draws what the same arbitraries passed to fc.property separately do.
  const separate: unknown[] = [];
  fc.assert(
    fc.property(
      fc.constantFrom(...gatedJobs),
      fc.constantFrom("failure", "timed_out", ""),
      fc.constantFrom(...Object.values(EVENT)),
      (job, result, event) => {
        separate.push([job, result, event]);
      },
    ),
    propertyConfig({ numRuns: 100, seed }),
  );
  expect(separate).toEqual(drawSamples(failedGatedJobs, 100));
});

test("image scopes remain planned while pull requests skip execution", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  for (const { job, broad, scope, cases } of [
    {
      job: "docker-checks",
      broad: "docker_checks_required",
      scope: "docker_checks_pr_required",
      cases: [
        {
          file: "packages/agent-engine/docker/sandbox.Dockerfile",
          required: true,
        },
        { file: "apps/api/Dockerfile", required: true },
        { file: "apps/legal-atlas-runner/src/index.ts", required: true },
        { file: "packages/money/package.json", required: true },
        { file: ".dockerignore", required: false },
        { file: "bun.lock", required: true },
        { file: "apps/api/src/handlers/new.ts", required: false },
        { file: "packages/agent-engine/src/new.ts", required: false },
        { file: ".github/workflows/ci.yml", required: false },
        { file: "docs/guide.md", required: false },
      ],
    },
    {
      job: "legal-atlas-image",
      broad: "legal_atlas_image_required",
      scope: "legal_atlas_image_pr_required",
      cases: [
        { file: "apps/legal-atlas-runner/Dockerfile", required: true },
        { file: "apps/legal-atlas-runner/src/index.ts", required: true },
        { file: "packages/legal-atlas/src/new.ts", required: true },
        { file: ".dockerignore", required: true },
        { file: "bun.lock", required: true },
        { file: "apps/api/src/handlers/new.ts", required: false },
        { file: "docs/guide.md", required: false },
      ],
    },
  ]) {
    const condition = jobIf(ciJobs[job]);
    expect(condition, job).toContain(
      "needs.ci-plan.outputs.suite_depth == 'fast'",
    );
    expect(condition, job).toContain(
      `needs.ci-plan.outputs.${scope} == 'true'`,
    );
    expect(fastJobScopes[job], job).toBe(scope);
    expect(fastRequired, job).not.toContain(job);
    expect(plan.outputs[scope], job).toBe(
      `\${{ steps.changed-files.outputs.${scope} }}`,
    );
    for (const { file, required } of cases) {
      const [broadOutput, scopeOutput] = runSelector([file], [broad, scope]);
      const broadPlanned = String(broadOutput);
      const planned = scopeOutput === "true";
      expect(planned, `${job} ${file}`).toBe(required);
      // A pull request never runs an image check the merge queue would skip.
      if (planned) {
        expect(broadPlanned, `${job} ${file}`).toBe("true");
      }
      for (const suiteDepth of ["fast", "full"]) {
        const executable = condition
          .replaceAll(
            `needs.ci-plan.outputs.${broad}`,
            () => `'${broadPlanned}'`,
          )
          .replaceAll(
            `needs.ci-plan.outputs.${scope}`,
            () => `'${String(planned)}'`,
          )
          .replaceAll(
            "needs.ci-plan.outputs.suite_depth",
            () => `'${suiteDepth}'`,
          )
          .replaceAll("needs.ci-plan.outputs.trusted", "'true'")
          .replaceAll("github.event_name", "'pull_request'");
        expect(
          Bun.spawnSync(["bash", "-c", `[[ ${executable} ]]`]).exitCode,
          `${job} ${file} ${suiteDepth}`,
        ).toBe(1);
      }
      for (const result of ["success", "failure", "skipped"]) {
        expect(
          evaluateResult({
            event: EVENT.pullRequest,
            results: { [job]: result },
            unplannedScopes: planned ? [] : [scope],
          }),
          `${job} ${file} ${result}`,
        ).toBe(result === "failure" ? 1 : 0);
      }
    }
  }
}, 30_000);

test("each folded service step follows its own dependency scope at PR depth", () => {
  const scopes = [
    "postgres_suites_required",
    "corpus_suites_required",
    "valkey_suites_required",
    "collaboration_suite_required",
  ];
  const timePlan = runSelector(
    ["packages/time/src/index.ts"],
    [...scopes, "collab_redis_required", "service_suites_pr_required"],
  );
  expect(timePlan.at(3)).toBe("true");
  expect(timePlan.at(4)).toBe("false");
  expect(timePlan.at(5)).toBe("true");
  const collaboration = jobSteps(ciJobs["service-suites"]).find(
    ({ name }) => name === "Run cross-replica collaboration suite",
  );
  expect(collaboration?.if).toBe(
    `\${{ !cancelled() && needs.ci-plan.outputs.collaboration_suite_required == 'true' }}`,
  );
  const planned = Object.fromEntries(
    scopes.map((scope, index) => [scope, timePlan.at(index)]),
  );
  const evaluateStep = (
    predicate: string,
    values: Record<string, string | undefined>,
  ) =>
    Bun.spawnSync([
      "bash",
      "-c",
      `[[ ${predicate
        .replace(/^\$\{\{\s*/u, "")
        .replace(/\s*\}\}$/u, "")
        .replaceAll("!cancelled()", "true")
        .replaceAll("always()", "true")
        .replace(
          /needs\.ci-plan\.outputs\.(\w+)/gu,
          (_, scope: string) => `'${String(values[scope])}'`,
        )} ]]`,
    ]).exitCode;
  expect(evaluateStep(collaboration?.if ?? "false", planned)).toBe(0);
  for (const [name, scope] of [
    ["Run Postgres-gated API suites", "postgres_suites_required"],
    ["Start corpus engine", "corpus_suites_required"],
    ["Run corpus engine suites", "corpus_suites_required"],
    ["Corpus engine diagnostics and cleanup", "corpus_suites_required"],
    ["Run Valkey-gated API suites", "valkey_suites_required"],
    ["Run cross-replica collaboration suite", "collaboration_suite_required"],
  ] as const) {
    const predicate =
      jobSteps(ciJobs["service-suites"]).find((step) => step.name === name)
        ?.if ?? "false";
    for (const selected of scopes) {
      const values = Object.fromEntries(
        scopes.map((key) => [key, String(key === selected)]),
      );
      expect(evaluateStep(predicate, values), `${name}: ${selected}`).toBe(
        scope === selected ? 0 : 1,
      );
    }
  }
  expect(runSelector(["apps/collab/src/server.ts"], scopes, "full")).toEqual([
    "true",
    "true",
    "true",
    "true",
  ]);
  expect(runSelector(["docs/guide.md"], scopes, "full")).toEqual([
    "false",
    "false",
    "false",
    "false",
  ]);
});

test("pull requests leave corpus engine suites to full-depth runs", () => {
  const scopes = [
    "postgres_suites_required",
    "corpus_suites_required",
    "valkey_suites_required",
    "service_suites_pr_required",
  ];
  const changed = ["apps/api/src/handlers/example.test.ts"];
  expect(runSelector(changed, scopes)).toEqual([
    "true",
    "false",
    "true",
    "true",
  ]);
  expect(runSelector(changed, scopes, "full", "false", "merge_group")).toEqual([
    "true",
    "true",
    "true",
    "true",
  ]);
});

test("an empty full-depth diff preserves the original API service-suite selection", () => {
  const outputs = runChangedFilesStep({ suiteDepth: "full" });
  for (const scope of [
    "postgres_suites_required",
    "corpus_suites_required",
    "valkey_suites_required",
  ]) {
    expect(outputs.get(scope)).toBe("true");
  }
  expect(outputs.get("collaboration_suite_required")).toBe("false");
});

test("the production service-scope capture rejects crashed or malformed detectors", () => {
  const start = selector.indexOf("          if ! service_suite_scopes=");
  const end = selector.indexOf("          dependency_malware_required=", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const capture = selector.slice(start, end);
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "service-scope-output-"),
  );
  writeFileSync(
    nodePath.join(directory, "bun"),
    '#!/bin/bash\nprintf "%s" "$DETECTOR_OUTPUT"\nexit "$DETECTOR_EXIT"\n',
    { mode: 0o755 },
  );
  try {
    for (const { output, exit, expected, event = "push", scopes = output } of [
      { output: "false true false false", exit: "0", expected: 0 },
      {
        output: "false true false false",
        exit: "0",
        expected: 0,
        event: "pull_request",
        scopes: "false false false false",
      },
      { output: "false false false false", exit: "0", expected: 0 },
      { output: "true true true true", exit: "1", expected: 1 },
      { output: "", exit: "1", expected: 1 },
      ...[
        "",
        "true",
        "true false false",
        "true false false false false",
        "true false yes false",
        "true false false false\nfalse false false false",
      ].map((malformedOutput) => ({
        output: malformedOutput,
        exit: "0",
        expected: 1,
      })),
    ]) {
      const result = Bun.spawnSync(
        [
          "bash",
          "-eu",
          "-c",
          `changed_files=(docs/guide.md)\n${capture}\nprintf 'SCOPES=%s %s %s %s\\n' "$postgres_suites_required" "$corpus_suites_required" "$valkey_suites_required" "$collaboration_suite_required"`,
        ],
        {
          env: {
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
            DETECTOR_OUTPUT: output,
            DETECTOR_EXIT: exit,
            EVENT_NAME: event,
            package_checks_required: "true",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, `${exit}: ${output}`).toBe(expected);
      const stdout = new TextDecoder().decode(result.stdout);
      if (expected === 0) {
        expect(stdout).toContain(`SCOPES=${scopes}`);
      } else {
        expect(stdout).not.toContain("SCOPES=");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
const queueOnlyJobs = Object.fromEntries(
  Object.entries(eventPolicies.jobs)
    .filter(
      ([key, policy]) =>
        (policy === "queue" || key === "ci.yml/service-suites") &&
        key.startsWith("ci.yml/") &&
        gatedJobs.includes(key.slice("ci.yml/".length)),
    )
    .map(([key]) => [
      key.slice("ci.yml/".length),
      key === "ci.yml/service-suites"
        ? "Postgres PR switch is off by default"
        : "queue-only because its declared event policy certifies the merged tree",
    ]),
);

// Evaluate the actual predicate with a successful trusted plan. Unfamiliar
// expression syntax fails closed instead of silently evading parity.
type DepthContext = {
  event: Event;
  depth: SuiteDepth;
  heavyOnly?: boolean;
  queueDepth?: "full" | "thin";
  proveFix?: boolean;
  /** The QUEUE_BROWSER_SUITES repository variable; GitHub reads unset as ''. */
  queueBrowserSuites?: string;
};
const runsAtDepth = (
  condition: string,
  {
    event,
    depth,
    heavyOnly,
    queueDepth = "full",
    proveFix = false,
    queueBrowserSuites = "",
  }: DepthContext,
) => {
  const selectedQueueDepth = event === EVENT.mergeGroup ? queueDepth : "full";
  return v.parse(
    v.boolean(),
    evaluate(condition, {
      values: {
        "github.event_name": event,
        "github.event.pull_request.labels.*.name": proveFix
          ? ["prove-fix"]
          : [],
        "inputs.heavy_only": heavyOnly === true,
        "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        "needs.ci-plan.outputs.pilot_fast_jobs": "[]",
        "needs.ci-plan.outputs.suite_depth": depth,
        "needs.ci-plan.outputs.queue_depth": selectedQueueDepth,
        "vars.QUEUE_BROWSER_SUITES": queueBrowserSuites,
        "vars.CI_POSTGRES_PR_SELECTION": "off",
        "needs.ci-plan.outputs.postgres_pr_required": "false",
        "needs.ci-plan.outputs.ci_browser_required": browserPlanOutput({
          event,
          depth,
          desktopRequired: "true",
          queueDepth: selectedQueueDepth,
        }),
        "needs.ci-plan.outputs.heavy_web_build_required": String(
          heavyOnly === true,
        ),
      },
      status: { always: true, success: true, failure: false, cancelled: false },
      fallback: (path) => {
        if (path.startsWith("needs.ci-plan.outputs.")) {
          return "true";
        }
        if (/^needs\.[\w-]+\.result$/u.test(path)) {
          return "success";
        }
        throw new TypeError(`Unknown CI predicate context: ${path}`);
      },
    }),
  );
};

type ParityJob = { name: string; condition: string; required: boolean };
const parityViolations = (
  jobs: readonly ParityJob[],
  exceptions: Record<string, string>,
) => {
  const violations: string[] = [];
  for (const name of Object.keys(exceptions)) {
    const job = jobs.find((candidate) => candidate.name === name);
    if (
      job === undefined ||
      !runsAtDepth(job.condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
      }) ||
      runsAtDepth(job.condition, {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      })
    ) {
      violations.push(`${name}: stale queue-only exception`);
    }
  }
  for (const job of jobs) {
    if (
      !runsAtDepth(job.condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
      })
    ) {
      continue;
    }
    if (
      runsAtDepth(job.condition, {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      }) &&
      job.required
    ) {
      continue;
    }
    if (!Object.hasOwn(exceptions, job.name)) {
      violations.push(
        `${job.name}: missing required PR path or queue-only reason`,
      );
    }
  }
  return violations;
};

const parityJobs = gatedJobs.map((name) => ({
  name,
  condition: jobIf(ciJobs[name]),
  required: fastRequired.includes(name),
}));

test("every gated merge-group job has a required PR path or an explicit queue-only reason", () => {
  expect(parityViolations(parityJobs, queueOnlyJobs)).toEqual([]);
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  const pathScopes = new Set<string>();
  for (const { name, condition } of parityJobs) {
    if (
      !runsAtDepth(condition, {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      })
    ) {
      continue;
    }
    expect(jobScopes, name).toHaveProperty(name);
    const scope = fastJobScopes[name] ?? jobScopes[name];
    if (scope !== null && scope !== undefined) {
      expect(plan.outputs, name).toHaveProperty(scope);
      expect(condition, name).toContain(
        `needs.ci-plan.outputs.${scope} == 'true'`,
      );
      // Computed outputs can depend on file scopes as well as event/depth.
      for (const match of (plan.outputs[scope] ?? "").matchAll(
        /steps\.changed-files\.outputs\.(\w+)/gu,
      )) {
        if (match[1] !== undefined) {
          pathScopes.add(match[1]);
        }
      }
    }
  }
  const paths = [
    ".github/workflows/ci.yml",
    "bun.lock",
    "VERSION",
    "apps/landing/src/pages/index.astro",
    "apps/api/src/modules/workspaces/workspace.test.ts",
    "apps/desktop/src-tauri/src/lib.rs",
    "apps/web/e2e/playwright.config.ts",
  ];
  const scopes = [...pathScopes];
  expect(
    runSelector(
      paths,
      scopes,
      "fast",
      "false",
      "pull_request",
      "fix: update checks",
    ),
  ).toEqual(
    scopes.map((scope) =>
      scope === "docs_checks_required" ? "false" : "true",
    ),
  );
  expect(
    runSelector(
      ["README.md", "apps/desktop/README.md"],
      ["docs_checks_required"],
      "fast",
      "false",
      "pull_request",
    ),
  ).toEqual(["true"]);
});

test("parity rejects new queue-only jobs, ungated PR paths and stale exemptions", () => {
  const name = "new-check";
  const condition =
    "needs.ci-plan.outputs.new_required == 'true' && needs.ci-plan.outputs.suite_depth == 'full'";
  expect(
    parityViolations(
      [...parityJobs, { name, condition, required: false }],
      queueOnlyJobs,
    ),
  ).toEqual([`${name}: missing required PR path or queue-only reason`]);
  expect(
    parityViolations(
      [
        {
          name,
          condition: "needs.ci-plan.outputs.new_required == 'true'",
          required: false,
        },
      ],
      {},
    ),
  ).toEqual([`${name}: missing required PR path or queue-only reason`]);
  expect(
    parityViolations([], {
      removed: "queue-only because the removed check used the merged tree",
    }),
  ).toEqual(["removed: stale queue-only exception"]);
  expect(
    parityViolations(
      [
        {
          name,
          condition: "needs.ci-plan.outputs.new_required == 'true'",
          required: true,
        },
      ],
      {
        [name]: "queue-only because this check previously used the merged tree",
      },
    ),
  ).toEqual([`${name}: stale queue-only exception`]);
  expect(() =>
    runsAtDepth("contains(github.ref, 'main')", {
      event: EVENT.pullRequest,
      depth: SUITE_DEPTH.fast,
    }),
  ).toThrow("Unknown CI predicate context");
});

test("thin merge groups intentionally skip heavy jobs while full parity stays enforced", () => {
  const heavy = new Set(mainHeavyJobs({ jobs: ciJobs }));
  const admitted = new Set(queueAdmittedJobs({ jobs: ciJobs }));
  for (const { name, condition } of parityJobs) {
    const full = runsAtDepth(condition, {
      event: EVENT.mergeGroup,
      depth: SUITE_DEPTH.full,
    });
    expect(
      runsAtDepth(condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
        queueDepth: "full",
      }),
      name,
    ).toBe(full);
    expect(
      runsAtDepth(condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
        queueDepth: "thin",
      }),
      name,
    ).toBe(heavy.has(name) && !admitted.has(name) ? false : full);
    // The off switch restores the thin skip for the admitted browser suites.
    expect(
      runsAtDepth(condition, {
        event: EVENT.mergeGroup,
        depth: SUITE_DEPTH.full,
        queueDepth: "thin",
        queueBrowserSuites: "off",
      }),
      `${name}/off`,
    ).toBe(heavy.has(name) ? false : full);
    for (const event of [EVENT.pullRequest, EVENT.workflowDispatch]) {
      expect(
        runsAtDepth(condition, {
          event,
          depth: SUITE_DEPTH.fast,
          queueDepth: "thin",
        }),
        name,
      ).toBe(runsAtDepth(condition, { event, depth: SUITE_DEPTH.fast }));
    }
  }
  expect(parityViolations(parityJobs, queueOnlyJobs)).toEqual([]);
});

test("parity treats absent or false heavy-only input as ordinary event execution", () => {
  for (const event of [
    EVENT.pullRequest,
    EVENT.mergeGroup,
    EVENT.workflowDispatch,
  ]) {
    for (const heavyOnly of [undefined, false, true]) {
      const context = {
        event,
        depth: SUITE_DEPTH.full,
        ...(heavyOnly === undefined ? {} : { heavyOnly }),
      };
      expect(runsAtDepth("inputs.heavy_only == true", context)).toBe(
        heavyOnly === true,
      );
      expect(runsAtDepth("inputs.heavy_only != true", context)).toBe(
        heavyOnly !== true,
      );
      expect(
        runsAtDepth(
          "needs.ci-plan.outputs.heavy_web_build_required == 'true'",
          context,
        ),
      ).toBe(heavyOnly === true);
      expect(runsAtDepth(jobIf(ciJobs["heavy-web-build"]), context)).toBe(
        heavyOnly === true && event !== EVENT.pullRequest,
      );
    }
  }
  expect(() =>
    runsAtDepth("inputs.unknown == true", {
      event: EVENT.pullRequest,
      depth: SUITE_DEPTH.fast,
    }),
  ).toThrow("Unknown CI predicate context");
});

test("parity predicates follow GitHub precedence and reject malformed expressions", () => {
  const context = {
    event: EVENT.pullRequest,
    depth: SUITE_DEPTH.fast,
  } as const;
  for (const left of [true, false]) {
    for (const middle of [true, false]) {
      for (const right of [true, false]) {
        expect(runsAtDepth(`${left} || ${middle} && ${right}`, context)).toBe(
          left || (middle && right),
        );
        expect(
          runsAtDepth(`(${left} || ${middle}) && !${right}`, context),
        ).toBe((left || middle) && !right);
      }
    }
  }
  expect(() => runsAtDepth("true &&", context)).toThrow("expected a token");
  expect(() => runsAtDepth("(true", context)).toThrow("expected )");
  expect(() => runsAtDepth("true false", context)).toThrow("trailing tokens");
  expect(() => runsAtDepth("github.unknown == 'true'", context)).toThrow(
    "Unknown CI predicate context",
  );
});

test("property suites and their budgets select required PR checks", () => {
  for (const file of [
    "packages/property-testing/src/index.ts",
    "packages/property-testing/src/run-factor.ts",
    "packages/property-testing/src/preload.ts",
    "packages/property-testing/property-seeds.json",
    "packages/property-testing/src/index.test.ts",
    "scripts/prepare-maintenance-release.property.test.ts",
    "apps/api/src/handlers/case-law/judges/judge-name.property.test.ts",
    "turbo.json",
  ]) {
    expect(packageChecksPlan([file]), file).toBe("true");
  }
  expect(packageChecksPlan(["provenance/manifest.json"])).toBe("false");
  for (const job of ["ci-tests", "ci-checks-policy", "ci-checks-rest"]) {
    expect(
      runsAtDepth(jobIf(ciJobs[job]), {
        event: EVENT.pullRequest,
        depth: SUITE_DEPTH.fast,
      }),
      job,
    ).toBe(true);
    expect(fastRequired, job).toContain(job);
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { [job]: "skipped" },
      }),
      job,
    ).toBe(1);
  }
  const propertyGuard = jobSteps(ciJobs["ci-checks-rest"]).find(
    ({ name }) => name === "Property-test convention guard",
  );
  expect(propertyGuard?.if).toBe(
    `\${{ !cancelled() && steps.install.outcome == 'success' && (needs.ci-plan.outputs.package_checks_required == 'true') }}`,
  );
  const tests = jobSteps(ciJobs["ci-tests"]).find(
    ({ name }) => name === "Test API or rest",
  );
  expect(tests?.if).toContain(
    "needs.ci-plan.outputs.package_checks_required == 'true'",
  );
});

test("network-baseline PR coverage reuses the route-smoke profile and path scope", () => {
  for (const file of [
    "apps/web/src/routes/__root.tsx",
    "apps/web/e2e/network-baseline.json",
    "scripts/network-baseline-scope.ts",
    "scripts/network-baseline-scope.test.ts",
  ]) {
    expect(
      runSelector([file], ["route_smoke_required", "web_build_required"]),
      file,
    ).toEqual(["true", "true"]);
  }
  // Loose steps keep `env`, which jobSteps' strict schema drops.
  const network = v
    .parse(
      v.object({
        steps: v.array(v.looseObject({ name: v.optional(v.string()) })),
      }),
      ciJobs["route-smoke"],
    )
    .steps.find(({ name }) => name === "Check route network baseline");
  const step = v.parse(
    v.object({ env: v.record(v.string(), v.string()), run: v.string() }),
    network,
  );
  expect(step.env["E2E_EXECUTION_PROFILE"]).toBe("network-baseline");
  expect(step.run).toContain("route-smoke.spec.ts");
  expect(jobIf(ciJobs["route-smoke"])).toContain(
    "needs.ci-plan.outputs.route_smoke_required == 'true'",
  );
  expect(jobScopes["route-smoke"]).toBe("route_smoke_required");
  expect(fastRequired).not.toContain("route-smoke");
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "route-smoke": "skipped" },
    }),
  ).toBe(0);
});

test("the advisory base proof runs only for pull requests opting in with prove-fix", () => {
  const condition = jobIf(ciJobs["fix-tests-on-base"]);
  expect(fastRequired).not.toContain("fix-tests-on-base");
  for (const event of [
    EVENT.pullRequest,
    EVENT.mergeGroup,
    EVENT.workflowDispatch,
  ]) {
    for (const proveFix of [false, true]) {
      expect(
        runsAtDepth(condition, { event, depth: SUITE_DEPTH.fast, proveFix }),
      ).toBe(event === EVENT.pullRequest && proveFix);
    }
  }
});

test("the exact docs-only README change plans only Markdown checks in PRs and merge groups", () => {
  const outputs = [
    ...new Set([
      ...Object.values(jobScopes).filter(
        (scope): scope is string =>
          scope !== null && scope !== "ci_browser_required",
      ),
      "desktop_browser_required",
      ...Object.values(fastJobScopes),
      "docs_changed_files",
    ]),
  ];
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    const depth =
      event === EVENT.pullRequest ? SUITE_DEPTH.fast : SUITE_DEPTH.full;
    const selected = runSelector(
      ["README.md", "apps/desktop/README.md"],
      outputs,
      depth,
      "false",
      event,
    );
    const plan = Object.fromEntries(
      outputs.map((name, index) => [name, selected.at(index) ?? ""]),
    );
    plan["ci_browser_required"] = browserPlanOutput({
      event,
      depth,
      desktopRequired: plan["desktop_browser_required"] ?? "",
      packageChecksRequired: plan["package_checks_required"] ?? "",
    });
    expect(plan["package_checks_required"]).toBe("false");
    expect(plan["docs_checks_required"]).toBe("true");
    expect(JSON.parse(plan["docs_changed_files"] ?? "null")).toEqual([
      "README.md",
      "apps/desktop/README.md",
    ]);
    const values = {
      "github.event_name": event,
      "inputs.heavy_only": false,
      "github.event.pull_request.labels.*.name": [],
      "needs.ci-plan.outputs.trusted": "true",
      "needs.ci-plan.outputs.run_required": "true",
      "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      "needs.ci-plan.outputs.suite_depth": depth,
      "needs.ci-plan.outputs.queue_depth": "full",
      ...Object.fromEntries(
        Object.entries(plan).map(([name, value]) => [
          `needs.ci-plan.outputs.${name}`,
          value,
        ]),
      ),
    };
    const scheduled = gatedJobs.filter(
      (job) =>
        evaluate(jobIf(ciJobs[job]), {
          values,
          status: {
            failure: false,
            cancelled: false,
            always: true,
            success: true,
          },
        }) !== false,
    );
    expect(scheduled).toEqual(["ci-checks-docs"]);
    expect(resultJob.needs).toContain("ci-checks-docs");
    expect(fastRequired).toContain("ci-checks-docs");
    expect(
      evaluateResult({
        event,
        suiteDepth: depth,
        results: Object.fromEntries(
          gatedJobs
            .filter((job) => job !== "ci-checks-docs")
            .map((job) => [job, "skipped"]),
        ),
        unplannedScopes: Object.keys(plan).filter(
          (scope) => plan[scope] !== "true",
        ),
      }),
    ).toBe(0);
    expect(
      evaluateResult({
        event,
        suiteDepth: depth,
        results: { "ci-checks-docs": "failure" },
      }),
    ).toBe(1);
  }
});

test("mixed documentation and code changes retain the complete code plan", () => {
  const outputs = [
    ...new Set([
      ...Object.values(jobScopes).filter(
        (scope): scope is string =>
          scope !== null && scope !== "ci_browser_required",
      ),
      "desktop_browser_required",
      ...Object.values(fastJobScopes),
      "docs_changed_files",
    ]),
  ];
  for (const event of [EVENT.pullRequest, EVENT.mergeGroup]) {
    const depth =
      event === EVENT.pullRequest ? SUITE_DEPTH.fast : SUITE_DEPTH.full;
    const code = ["apps/api/src/index.ts"];
    const selected = runSelector(
      [...code, "README.md", "apps/desktop/README.md"],
      outputs,
      depth,
      "false",
      event,
    );
    expect(selected).toEqual(runSelector(code, outputs, depth, "false", event));
    const plan = Object.fromEntries(
      outputs.map((name, index) => [name, selected.at(index) ?? ""]),
    );
    plan["ci_browser_required"] = browserPlanOutput({
      event,
      depth,
      desktopRequired: plan["desktop_browser_required"] ?? "",
      packageChecksRequired: plan["package_checks_required"] ?? "",
    });
    expect(plan["package_checks_required"]).toBe("true");
    expect(plan["docs_checks_required"]).toBe("false");
    if (event !== EVENT.mergeGroup) {
      continue;
    }
    const values = {
      "github.event_name": event,
      "inputs.heavy_only": false,
      "needs.ci-plan.outputs.trusted": "true",
      "needs.ci-plan.outputs.run_required": "true",
      "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      "needs.ci-plan.outputs.suite_depth": depth,
      "needs.ci-plan.outputs.queue_depth": "full",
      ...Object.fromEntries(
        Object.entries(plan).map(([name, value]) => [
          `needs.ci-plan.outputs.${name}`,
          value,
        ]),
      ),
    };
    for (const [job, scope] of Object.entries(jobScopes)) {
      if (scope === "package_checks_required") {
        expect(
          evaluate(jobIf(ciJobs[job]), {
            values,
            status: {
              failure: false,
              cancelled: false,
              always: true,
              success: true,
            },
          }),
          job,
        ).toBe(true);
      }
    }
  }
});

test("documentation guards run independently of package checks", () => {
  const steps = jobSteps(ciJobs["ci-checks-policy"]);
  for (const name of [
    "Install dependencies",
    "Documentation source policy rule",
    "Instruction references",
  ]) {
    const step = steps.find((entry) => entry.name === name);
    expect(step?.if).not.toContain("package_checks_required");
    expect(step?.if).toContain(
      name === "Install dependencies"
        ? "steps.checkout.outcome == 'success'"
        : "steps.install.outcome == 'success'",
    );
  }
});

test("unavailable or malformed documentation and landing detectors widen workflow scopes", () => {
  const landingStart = selector.indexOf(
    "          landing_build_required=false\n",
  );
  const landingEnd = selector.indexOf(
    "          legal_atlas_image_required=false",
    landingStart,
  );
  expect(landingStart).toBeGreaterThan(-1);
  expect(landingEnd).toBeGreaterThan(landingStart);
  for (const fake of ["return 1", "printf invalid"]) {
    const result = Bun.spawnSync(
      [
        "bash",
        "-e",
        "-c",
        `bun() { ${fake}; }; changed_files=(docs/guide.md);\n${packageScope}\n${selector.slice(landingStart, landingEnd)}\nprintf '%s %s' "$package_checks_required" "$landing_build_required"`,
      ],
      {
        env: { PATH: Bun.env["PATH"] ?? "", EVENT_NAME: "pull_request" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("true true");
  }
});

test("API test matrix drops API shards for web-only scope and keeps four in merge groups", () => {
  const web = planCiApiTests({
    event: "pull_request",
    scopeUnknown: false,
    apiInScope: false,
    select: () => selectApiTestImpact({ changed: ["apps/web/src/page.tsx"] }),
  });
  expect(web.matrix.shard).toEqual(["rest-web"]);
  const queue = planCiApiTests({
    event: "merge_group",
    scopeUnknown: false,
    apiInScope: false,
    select: () => ({ mode: "none", files: [], shards: 0 }),
  });
  expect(queue.matrix.shard).toEqual([
    "api-1",
    "api-2",
    "api-3",
    "api-4",
    "rest-web",
  ]);
  expect(workflow).toContain(
    `matrix: \${{ fromJSON(needs.ci-plan.outputs.ci_tests_matrix) }}`,
  );
  const planner = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Select affected API test files",
  );
  expect(planner?.run).toContain(
    "! timeout --kill-after=10s 120s bun scripts/ci-api-test-plan.ts; then",
  );
  expect(planner?.run).toContain("api_test_shards=4");
  const runner = jobSteps(ciJobs["ci-tests"]).find(
    (step) => step.name === "Test API or rest",
  );
  expect(runner?.env?.["API_TEST_FILES"]).toBe(
    `\${{ needs.ci-plan.outputs.api_test_files }}`,
  );
});

test("a crashed API planner widens the real workflow outputs", () => {
  const planner = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Select affected API test files",
  );
  const directory = mkdtempSync(nodePath.join(tmpdir(), "api-plan-fallback-"));
  const output = nodePath.join(directory, "output");
  try {
    const result = Bun.spawnSync(
      [
        "bash",
        "-e",
        "-c",
        `timeout() { shift 2; "$@"; }; bun() { echo invoked > "$PLANNER_CALLED"; return 1; }\n${planner?.run ?? panic("Missing API test planner")}`,
      ],
      {
        env: {
          PATH: Bun.env["PATH"] ?? "",
          GITHUB_OUTPUT: output,
          EVENT_NAME: "pull_request",
          PACKAGE_CHECKS_REQUIRED: "true",
          API_SCOPE_UNKNOWN: "false",
          PLANNER_CALLED: nodePath.join(directory, "called"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(nodePath.join(directory, "called"), "utf-8")).toBe(
      "invoked\n",
    );
    const values = readFileSync(output, "utf-8");
    expect(values).toContain(
      'ci_tests_matrix={"shard":["api-1","api-2","api-3","api-4","rest-web"]}',
    );
    expect(values).toContain("api_test_shards=4");
    expect(values).toContain("api_test_files=\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a crashed e2e selector widens the real workflow matrix", () => {
  const planner = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Plan changed PR e2e shards",
  );
  const directory = mkdtempSync(nodePath.join(tmpdir(), "e2e-plan-fallback-"));
  const output = nodePath.join(directory, "output");
  try {
    const result = Bun.spawnSync(
      [
        "bash",
        "-e",
        "-c",
        `bun() {
          printf '%s' '{"shard":[1,2,"network-baseline"]}'
        }
        ${planner?.run ?? panic("Missing e2e shard planner")}`,
      ],
      {
        env: {
          PATH: Bun.env["PATH"] ?? "",
          E2E_PRODUCTION_REQUIRED: "true",
          EVENT_NAME: "pull_request",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
          SELECTED_MATRIX: "",
          SELECTOR_OUTCOME: "failure",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(output, "utf-8")).toBe(
      [
        'matrix={"shard":[1,2,"network-baseline"]}',
        "selection_required=true",
        "required=true",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nightly full tests retain the unrestricted API suite and selection enters its cache key", () => {
  const nightly = readFileSync(
    new URL("../.github/workflows/nightly-test.yml", import.meta.url),
    "utf-8",
  );
  const steps = jobSteps(workflowJobs(nightly)["full-test"]);
  const full = steps.find((step) => step.name === "Full test suite");
  expect(full?.run).toBe("bun run test -- --concurrency=2");
  expect(full?.env?.["TURBO_FORCE"]).toBe("true");
  expect(nightly).not.toContain("API_TEST_FILES:");
  const turbo = readFileSync(
    new URL("../turbo.json", import.meta.url),
    "utf-8",
  );
  const tasks = v.parse(
    v.object({
      tasks: v.record(
        v.string(),
        v.looseObject({ env: v.optional(v.array(v.string())) }),
      ),
    }),
    Bun.JSONC.parse(turbo),
  ).tasks;
  expect(tasks["@stll/api#test"]?.env).toEqual(
    expect.arrayContaining(["API_TEST_SHARD", "API_TEST_FILES"]),
  );
});

test("API planning only loads dependencies after installation and emits install-free fallbacks", () => {
  const steps = jobSteps(ciJobs["ci-plan"]);
  const select = steps.find(
    (step) => step.name === "Select affected API test files",
  );
  expect(select?.if).toBe(
    "steps.completed-depth.outputs.run_required != 'false' && github.event_name == 'pull_request' && steps.api-test-deps.outcome == 'success'",
  );
  const plan = steps.find(
    (step) => step.name === "Plan API test files and shards",
  );
  expect(plan?.run).not.toContain("bun ");
  const directory = mkdtempSync(nodePath.join(tmpdir(), "api-plan-output-"));
  const output = nodePath.join(directory, "output");
  try {
    for (const [event, packages, unknown, selected, shards, expected] of [
      ["pull_request", "false", "false", "", "", "0"],
      ["pull_request", "true", "false", "", "", "4"],
      ["pull_request", "false", "true", "", "", "4"],
      ["merge_group", "true", "false", "", "", "4"],
      ["workflow_dispatch", "true", "false", "", "", "4"],
      [
        "pull_request",
        "true",
        "false",
        '{"shard":["api-1","rest-web"]}',
        "1",
        "1",
      ],
    ]) {
      writeFileSync(output, "");
      const result = Bun.spawnSync(
        ["bash", "-e", "-c", plan?.run ?? panic("Missing output planner")],
        {
          env: {
            PATH: Bun.env["PATH"] ?? "",
            GITHUB_OUTPUT: output,
            EVENT_NAME: event,
            PACKAGE_CHECKS_REQUIRED: packages,
            API_SCOPE_UNKNOWN: unknown,
            SELECTED_MATRIX: selected,
            SELECTED_SHARDS: shards,
            SELECTED_FILES: selected ? "src/a.test.ts\nsrc/b.test.ts" : "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const values = readFileSync(output, "utf-8");
      expect(values).toContain(`api_test_shards=${String(expected)}\n`);
      if (selected) {
        expect(values).toContain(`ci_tests_matrix=${selected}\n`);
        expect(values).toContain(
          "api_test_files<<API_TEST_FILES_END\nsrc/a.test.ts\nsrc/b.test.ts\nAPI_TEST_FILES_END\n",
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Postgres plans are visible on PRs while execution requires explicit opt-in", () => {
  const steps = jobSteps(ciJobs["ci-plan"]);
  const planner = steps.find(
    (step) => step.name === "Select affected Postgres test files",
  );
  const runner = jobSteps(ciJobs["service-suites"]).find(
    (step) => step.name === "Run Postgres-gated API suites",
  );
  const runnerSelection =
    runner?.env?.["CI_POSTGRES_TEST_SELECTION"] ??
    panic("Missing Postgres selection wiring");
  const jobCondition = jobIf(ciJobs["service-suites"]);
  for (const mode of ["selected", "all", "none"] as const) {
    const selection = JSON.stringify(
      mode === "selected"
        ? { mode, files: ["src/synthetic.db.test.ts"] }
        : { mode },
    );
    for (const event of [
      EVENT.mergeGroup,
      EVENT.workflowDispatch,
      EVENT.pullRequest,
    ]) {
      for (const prSwitch of ["", "off", "on"]) {
        const enabled = event === EVENT.pullRequest && prSwitch === "on";
        const values = {
          "github.event_name": event,
          "vars.CI_POSTGRES_PR_SELECTION": prSwitch,
          "steps.completed-depth.outputs.run_required": "true",
          "steps.api-test-deps.outcome": "success",
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.queue_depth": "full",
          "needs.ci-plan.outputs.service_suites_required": "true",
          "needs.ci-plan.outputs.service_suites_pr_required": "true",
          "needs.ci-plan.outputs.postgres_suites_required": "true",
          "needs.ci-plan.outputs.trusted": "true",
          "needs.ci-plan.outputs.suite_depth":
            event === EVENT.pullRequest ? "fast" : "full",
          "needs.ci-plan.outputs.postgres_pr_required": String(enabled),
          "needs.ci-plan.outputs.postgres_test_selection": selection,
        };
        expect(evaluate(planner?.if ?? "false", { values })).toBe(
          event === EVENT.mergeGroup || event === EVENT.pullRequest,
        );
        expect(evaluate(jobCondition, { values })).toBe(
          event !== EVENT.pullRequest || enabled,
        );
        expect(evaluate(runner?.if ?? "false", { values })).toBe(true);
        expect(evaluate(runnerSelection, { values })).toBe(
          event === EVENT.mergeGroup || enabled ? selection : '{"mode":"all"}',
        );
        expect(
          evaluate(runnerSelection, {
            values: {
              ...values,
              "needs.ci-plan.outputs.postgres_test_selection": "",
            },
          }),
        ).toBe('{"mode":"all"}');
      }
    }
  }
  expect(planner?.run).toContain('postgres_test_selection={"mode":"all"}');
  for (const result of ["success", "skipped", "failure"]) {
    expect(
      evaluateResult({
        event: EVENT.pullRequest,
        results: { "service-suites": result },
        plannedOutputs: { postgres_pr_required: "true" },
      }),
    ).toBe(result === "success" ? 0 : 1);
  }
});

test("Postgres planning generates ignored runtime inputs and widens when any stage fails", () => {
  const planner = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Select affected Postgres test files",
  );
  const commands = [
    "--cwd=packages/cli run codegen:runtime",
    "--cwd=apps/api run generate:capability-runtime",
    "scripts/ci-postgres-test-plan.ts",
  ];
  const directory = mkdtempSync(
    nodePath.join(tmpdir(), "postgres-runtime-plan-"),
  );
  try {
    for (const failedCommand of ["", ...commands]) {
      const output = nodePath.join(directory, "output");
      const trace = nodePath.join(directory, "trace");
      writeFileSync(output, "");
      writeFileSync(trace, "");
      const result = Bun.spawnSync({
        cmd: [
          "bash",
          "-e",
          "-c",
          `timeout() { shift 2; "$@"; }
bun() {
  printf '%s\\n' "$*" >> "$TRACE"
  if [[ "$*" == "$FAILED_COMMAND" ]]; then return 1; fi
  if [[ "$*" == scripts/ci-postgres-test-plan.ts ]]; then
    printf '%s\\n' 'postgres_test_selection={"mode":"selected","files":["src/db.test.ts"]}' >> "$GITHUB_OUTPUT"
  fi
}
${planner?.run ?? panic("Missing Postgres planner")}`,
        ],
        env: {
          PATH: process.env["PATH"] ?? "",
          TRACE: trace,
          FAILED_COMMAND: failedCommand,
          GITHUB_OUTPUT: output,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const invoked = readFileSync(trace, "utf-8").trim().split("\n");
      expect(invoked).toEqual(
        failedCommand === ""
          ? commands
          : commands.slice(0, commands.indexOf(failedCommand) + 1),
      );
      expect(readFileSync(output, "utf-8")).toContain(
        failedCommand === "" ? '"mode":"selected"' : '"mode":"all"',
      );
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("full Postgres failures trigger selector replay only on main-heavy", () => {
  const steps = jobSteps(ciJobs["service-suites"]);
  const runner = steps.find(
    (step) => step.name === "Run Postgres-gated API suites",
  );
  const missCheck = steps.find(
    (step) => step.name === "Check full Postgres failures for selector misses",
  );
  expect(runner?.run).toContain("--reporter=junit");
  expect(runner?.run).toContain("postgres-tests.xml");
  expect(missCheck?.env?.["POSTGRES_JUNIT_FILE"]).toContain(
    "postgres-tests.xml",
  );
  expect(missCheck?.run).toContain("bun scripts/ci-postgres-selector-miss.ts");
  for (const heavyOnly of [false, true]) {
    for (const outcome of ["success", "failure", "skipped"]) {
      for (const cancelled of [false, true]) {
        expect(
          evaluate(missCheck?.if ?? "false", {
            values: {
              "inputs.heavy_only": heavyOnly,
              "steps.postgres-tests.outcome": outcome,
            },
            status: { always: true, success: false, failure: true, cancelled },
          }),
        ).toBe(heavyOnly && outcome === "failure" && !cancelled);
      }
    }
  }
  const summary = jobSteps(ciJobs["ci-plan"]).find(
    (step) => step.name === "Summarize Postgres test selection",
  );
  expect(summary?.run).toContain("GITHUB_STEP_SUMMARY");
  expect(summary?.run).toContain('"full"');
  expect(summary?.env?.["SELECTION"]).toContain(
    "steps.postgres-test-plan.outputs.postgres_test_selection",
  );
  expect(summary?.env?.["REASON"]).toContain(
    "steps.postgres-test-plan.outputs.postgres_selection_reason",
  );
});

type BrowserPlanOptions = {
  event: Event | "push";
  depth: SuiteDepth;
  desktopRequired: string;
  runRequired?: string;
  trusted?: string;
  queueDepth?: string;
  packageChecksRequired?: string;
};
const browserPlanOutput = ({
  event,
  depth,
  desktopRequired,
  runRequired = "true",
  trusted = "true",
  queueDepth = "full",
  packageChecksRequired = "true",
}: BrowserPlanOptions) => {
  const { outputs } = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  return v.parse(
    v.picklist(["true", "false"]),
    evaluate(outputs["ci_browser_required"] ?? "", {
      values: {
        "github.event_name": event,
        "steps.completed-depth.outputs.run_required": runRequired,
        "steps.check.outputs.trusted": trusted,
        "steps.changed-files.outputs.desktop_browser_required": desktopRequired,
        "steps.changed-files.outputs.package_checks_required":
          packageChecksRequired,
        "steps.depth.outputs.suite_depth": depth,
        "steps.depth.outputs.queue_depth": queueDepth,
      },
    }),
  );
};

test("browser planning, scheduling and result gates agree across events and depths", () => {
  const cases = (
    [
      EVENT.workflowDispatch,
      "push",
      EVENT.mergeGroup,
      EVENT.pullRequest,
    ] as const
  ).flatMap((event) =>
    [SUITE_DEPTH.fast, SUITE_DEPTH.full].flatMap((depth) =>
      ["true", "false"].flatMap((desktopRequired) =>
        ["true", "false"].flatMap((trusted) =>
          ["true", "false"].flatMap((runRequired) =>
            ["full", "thin"].map((queueDepth) => ({
              event,
              depth,
              desktopRequired,
              trusted,
              runRequired,
              queueDepth,
            })),
          ),
        ),
      ),
    ),
  );
  for (const options of cases.flatMap((testCase) =>
    ["true", "false"].map((packageChecksRequired) => ({
      ...testCase,
      packageChecksRequired,
    })),
  )) {
    const planned = browserPlanOutput(options);
    const expected =
      options.runRequired === "true" &&
      options.packageChecksRequired === "true" &&
      (options.trusted === "true" ||
        options.event === EVENT.workflowDispatch) &&
      (options.event === EVENT.pullRequest
        ? options.desktopRequired === "true"
        : options.depth === SUITE_DEPTH.full && options.queueDepth !== "thin");
    expect(planned, JSON.stringify(options)).toBe(expected ? "true" : "false");
    expect(
      evaluate(jobIf(ciJobs["ci-browser"]), {
        values: {
          "needs.ci-plan.outputs.ci_browser_required": planned,
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        },
      }),
      JSON.stringify(options),
    ).toBe(expected);
  }
  expectResultGates(
    (
      [
        EVENT.workflowDispatch,
        "push",
        EVENT.mergeGroup,
        EVENT.pullRequest,
      ] as const
    ).flatMap((event) =>
      [SUITE_DEPTH.fast, SUITE_DEPTH.full].flatMap((depth) =>
        ["true", "false"].flatMap((desktopRequired) => {
          const planned = browserPlanOutput({ event, depth, desktopRequired });
          return ["success", "skipped", "failure"].map((result) => ({
            label: `${event} ${depth} desktop=${desktopRequired} browser=${result}`,
            options: {
              event,
              suiteDepth: depth,
              results: { "ci-browser": result },
              plannedOutputs: { ci_browser_required: planned },
            },
            exitCode:
              (event === EVENT.mergeGroup && depth === SUITE_DEPTH.fast) ||
              result === "failure" ||
              (planned === "true" && result === "skipped")
                ? 1
                : 0,
          }));
        }),
      ),
    ),
  );
}, 30_000);

test("untrusted PRs skip browser CI while the result gate preserves its trust failure", () => {
  const cases = [SUITE_DEPTH.fast, SUITE_DEPTH.full].flatMap((depth) =>
    ["true", "false"].map((desktopRequired) => ({
      depth,
      planned: browserPlanOutput({
        event: EVENT.pullRequest,
        depth,
        desktopRequired,
        trusted: "false",
      }),
    })),
  );
  for (const { planned } of cases) {
    expect(planned).toBe("false");
    expect(
      evaluate(jobIf(ciJobs["ci-browser"]), {
        values: {
          "needs.ci-plan.outputs.ci_browser_required": planned,
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
        },
      }),
    ).toBe(false);
  }
  for (const { exitCode, stdout } of evaluateResults(
    cases,
    ({ depth, planned }) => ({
      event: EVENT.pullRequest,
      suiteDepth: depth,
      trusted: "false",
      results: { "ci-browser": "skipped" },
      plannedOutputs: { ci_browser_required: planned },
    }),
  )) {
    expect(exitCode).toBe(1);
    expect(stdout).toContain("failed the trust check");
    expect(stdout).not.toContain("planned, skipped");
  }
});

test("a planted desktop path plans the PR desktop browser leg while unrelated paths skip it", () => {
  const root = nodePath.resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(
    nodePath.join(root, "apps/desktop/.ci-browser-scope-"),
  );
  const planted = nodePath.relative(
    root,
    nodePath.join(directory, "planted.unclassified"),
  );
  writeFileSync(nodePath.join(root, planted), "new desktop input");
  try {
    for (const [file, expected] of [
      [planted, "true"],
      ["apps/api/src/unrelated.ts", "false"],
    ] as const) {
      const required = runSelector([file], ["desktop_browser_required"]).at(0);
      if (required === undefined) {
        panic("Desktop scope selector returned no value");
      }
      expect(required).toBe(expected);
      for (const runRequired of ["true", "false"]) {
        const planned = browserPlanOutput({
          event: EVENT.pullRequest,
          depth: SUITE_DEPTH.fast,
          desktopRequired: required,
          runRequired,
        });
        expect(planned).toBe(
          expected === "true" && runRequired === "true" ? "true" : "false",
        );
        expect(
          evaluate(jobIf(ciJobs["ci-browser"]), {
            values: {
              "needs.ci-plan.outputs.ci_browser_required": planned,
              "needs.ci-plan.outputs.coverage_profile": "normal-v1",
            },
          }),
        ).toBe(planned === "true");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(fastJobScopes).not.toHaveProperty("ci-browser");
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-browser": "skipped" },
    }),
  ).toBe(1);
  expect(
    evaluateResult({
      event: EVENT.pullRequest,
      results: { "ci-browser": "skipped" },
      unplannedScopes: ["ci_browser_required"],
    }),
  ).toBe(0);
});

test("desktop browser detector failures and malformed output cannot skip the PR leg", () => {
  const start = selector.indexOf("          desktop_browser_required=$(");
  const end = selector.indexOf("          dependency_malware_required=", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const detector = selector.slice(start, end);
  const cases = [
    { output: "false", status: 0, expected: "false" },
    { output: "true", status: 0, expected: "true" },
    { output: "", status: 0, expected: "true" },
    { output: "unclassified", status: 0, expected: "true" },
    { output: "false", status: 1, expected: "true" },
  ];
  for (const { item, stdout, exitCode, stderr } of runBashBatch(
    cases,
    ({ output, status }) => ({
      flags: ["-e"],
      args: [],
      script: `bun() { printf '%s' "$OUTPUT"; return "$STATUS"; }; changed_files=(docs/guide.md);\n${detector}\nprintf '%s' "$desktop_browser_required"`,
      env: {
        PATH: Bun.env["PATH"] ?? "",
        OUTPUT: output,
        STATUS: String(status),
      },
    }),
  )) {
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toBe(item.expected);
  }
});

test("Postgres PR required checks follow trust, run eligibility and the general opt-in", () => {
  const plan = v.parse(
    v.object({ outputs: v.record(v.string(), v.string()) }),
    ciJobs["ci-plan"],
  );
  for (const trusted of ["true", "false"]) {
    for (const runRequired of ["true", "false"]) {
      for (const prSwitch of ["on", "off", ""]) {
        for (const scope of ["true", "false"]) {
          const enabled =
            trusted === "true" &&
            runRequired === "true" &&
            prSwitch === "on" &&
            scope === "true";
          expect(
            evaluate(plan.outputs["postgres_pr_required"] ?? "", {
              values: {
                "github.event_name": EVENT.pullRequest,
                "vars.CI_POSTGRES_PR_SELECTION": prSwitch,
                "steps.completed-depth.outputs.run_required": runRequired,
                "steps.check.outputs.trusted": trusted,
                "steps.changed-files.outputs.service_suites_pr_required": scope,
              },
            }),
          ).toBe(enabled);
        }
      }
    }
  }
});
