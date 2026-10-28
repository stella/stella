import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  chmodSync,
  existsSync,
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

import { drawPropertySamples } from "@stll/property-testing";

import { markdownReaders } from "./ci-package-scope";
import {
  type ChangedFileScopeDetectors,
  type ChangedFileScopeInput,
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  type ScopeOutput,
} from "./ci-plan-scope";
import { sourceImportClosure } from "./detect-route-smoke-changes";
import { GENERATORS } from "./generated-files";

markdownReaders();

type SelectorCase = {
  files: readonly string[];
  outputs: readonly ScopeOutput[];
  suiteDepth?: string;
  // What the landing deploy scope answers; it reads git, so tests pin it.
  e2eLandingRequired?: string;
  event?: string;
  title?: string;
  armed?: boolean;
};
const planSelector = <C extends SelectorCase>(cases: readonly C[]) =>
  cases.map((item) => {
    const scope = computeChangedFileScope(
      {
        changedFiles: item.files,
        comparisonBase: "",
        scopeUnknown: false,
        eventName: item.event ?? "pull_request",
        suiteDepth: item.suiteDepth ?? "fast",
        heavyOnly: false,
        prTitle: item.title ?? "",
        armed: item.armed ?? false,
      },
      {
        ...DEFAULT_DETECTORS,
        landingDeploy: () => item.e2eLandingRequired === "true",
      },
    );
    return {
      item,
      plan: item.outputs.map((output) => scope[output]),
    };
  });
const runSelector = (
  files: readonly string[],
  outputs: readonly ScopeOutput[],
  suiteDepth = "fast",
  e2eLandingRequired = "false",
  event = "pull_request",
  title = "",
) =>
  planSelector([
    { files, outputs, suiteDepth, e2eLandingRequired, event, title },
  ])[0]!.plan;

const detectorInput = (eventName: string): ChangedFileScopeInput => ({
  changedFiles: ["apps/api/src/server.ts"],
  comparisonBase: "base",
  scopeUnknown: false,
  eventName,
  suiteDepth: "fast",
  heavyOnly: false,
  prTitle: "",
});

const detectors = (
  overrides: Partial<ChangedFileScopeDetectors> = {},
): ChangedFileScopeDetectors => ({
  packageChecks: () => true,
  landingBuild: () => false,
  landingDeploy: () => false,
  desktopBrowser: () => false,
  ...overrides,
});

test("pull requests and merge groups fail closed when package detection is unavailable or malformed", () => {
  for (const eventName of ["pull_request", "merge_group"]) {
    for (const { packageChecks, expected } of [
      { packageChecks: () => false, expected: "false" },
      { packageChecks: () => true, expected: "true" },
      {
        packageChecks: () => {
          throw new Error("package detector unavailable");
        },
        expected: "true",
      },
      { packageChecks: () => "invalid", expected: "true" },
    ]) {
      const scope = computeChangedFileScope(
        detectorInput(eventName),
        detectors({ packageChecks }),
      );
      expect(scope.package_checks_required).toBe(expected);
    }
  }
});

test("documentation and landing detector failures widen their workflow scopes", () => {
  for (const failure of [
    () => {
      throw new Error("detector unavailable");
    },
    () => "invalid",
  ]) {
    const documentation = computeChangedFileScope(
      { ...detectorInput("pull_request"), changedFiles: ["docs/guide.md"] },
      detectors({ packageChecks: failure }),
    );
    expect(documentation.package_checks_required).toBe("true");

    const landing = computeChangedFileScope(
      { ...detectorInput("pull_request"), changedFiles: ["docs/guide.md"] },
      detectors({ landingBuild: failure }),
    );
    expect(landing.landing_build_required).toBe("true");

    const deploy = computeChangedFileScope(
      { ...detectorInput("pull_request"), changedFiles: ["docs/guide.md"] },
      detectors({ landingBuild: () => true, landingDeploy: failure }),
    );
    expect(deploy.e2e_landing_required).toBe("true");
    expect(deploy.landing_build_required).toBe("false");
  }
});

test("an armed pull request builds the landing at merge-group scope", () => {
  const scope = (armed: boolean) =>
    computeChangedFileScope(
      {
        ...detectorInput("pull_request"),
        // A landing input outside e2e-landing, which builds the landing itself.
        changedFiles: ["docs/changelog/v1.md"],
        armed,
      },
      detectors({ landingBuild: () => false, landingDeploy: () => false }),
    ).landing_build_required;
  expect(scope(false)).toBe("false");
  expect(scope(true)).toBe("true");
});

// The path list covers the landing's own tree; the deploy scope adds every
// workspace it depends on, transitively, and the packages they resolve to.
test("e2e-landing follows the landing's whole dependency graph", () => {
  const ranges: unknown[] = [];
  const scope = computeChangedFileScope(
    { ...detectorInput("pull_request"), changedFiles: ["docs/guide.md"] },
    detectors({
      landingBuild: () => true,
      landingDeploy: (range) => {
        ranges.push(range);
        return true;
      },
    }),
  );
  expect(ranges).toEqual([{ base: "base", head: "HEAD" }]);
  expect(scope.e2e_landing_required).toBe("true");
  expect(scope.landing_build_required).toBe("false");
});

test("graph detectors read the dependency-classified file list", () => {
  const changed: (readonly string[])[] = [];
  computeChangedFileScope(
    {
      ...detectorInput("pull_request"),
      changedFiles: ["bun.lock"],
      dependencyScope: {
        type: "runtime",
        files: ["apps/desktop/src/mainview/app.ts"],
      },
    },
    detectors({
      desktopBrowser: (options) => {
        changed.push(options.changed);
        return false;
      },
    }),
  );
  expect(changed).toEqual([["apps/desktop/src/mainview/app.ts"]]);
});

test("desktop browser detector failures and malformed results cannot skip the PR leg", () => {
  for (const failure of [
    () => {
      throw new Error("desktop browser detector unavailable");
    },
    () => "invalid",
  ]) {
    const scope = computeChangedFileScope(
      detectorInput("pull_request"),
      detectors({ desktopBrowser: failure }),
    );
    expect(scope.desktop_browser_required).toBe("true");
  }
});

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
  const block = GENERATORS.find(
    ({ id }) => id === "api-image-install-tooling",
  )?.blocks?.at(0);
  if (block === undefined) {
    panic("Missing API install tooling generator");
  }
  const dockerfile = readFileSync(
    new URL(`../${block.path}`, import.meta.url),
    "utf-8",
  );
  const copies = dockerfile.slice(
    dockerfile.indexOf(block.begin),
    dockerfile.indexOf(block.end),
  );
  const toolingFiles = [...copies.matchAll(/^COPY (\S+) \S+$/gmu)].map(
    (match) => match.at(1) ?? panic("Missing generated COPY source"),
  );
  expect(toolingFiles.length).toBeGreaterThan(0);
  for (const file of [
    "apps/api/Dockerfile",
    "scripts/smoke-api-image.sh",
    ".dockerignore",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ...toolingFiles,
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
    "docker/postgres/prod-parity.conf",
    "docker/postgres/server.conf",
    "scripts/configure-test-postgres.sh",
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

test("path patterns match changed names containing newlines, tabs, quotes and backslashes", () => {
  // Bash case wildcards match every character, so a newline in a name cannot
  // move a file out of its scope.
  const unusual = 'quote"back\\slash\ttab\nnewline';
  for (const file of [
    `apps/api/src/${unusual}.ts`,
    `apps/api/src/new\nfile.ts`,
    `docker/postgres/${unusual}.sql`,
  ]) {
    expect(imageSmokePlan([file]).at(0), JSON.stringify(file)).toBe("true");
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
    "packages/sha256/src/index.ts",
    "packages/api-contract/src/index.ts",
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
    "types/wasm.d.ts",
  ]) {
    expect(generatedOutputGuardPlan([file]), file).toEqual(["true", "false"]);
  }
  // Web and UI sources are outside the API type graph the generator reads, so
  // they no longer run the API types guard (the published-exports guard still
  // follows packages).
  expect(generatedOutputGuardPlan(["apps/web/src/routes/index.tsx"])).toEqual([
    "false",
    "false",
  ]);
  expect(generatedOutputGuardPlan(["packages/ui/src/button.tsx"])).toEqual([
    "false",
    "true",
  ]);
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

test("dependency jobs follow dependency inputs and skip unrelated changes", () => {
  const dependencyInputs = [
    "scripts/dependency-audit.ts",
    "scripts/dependency-audit-baseline.json",
    "scripts/dependency-audit-assessment.ts",
    "scripts/dependency-audit-acceptance.ts",
    "scripts/check-trusted-dependencies.ts",
    "scripts/retry.sh",
    "bun.lock",
    "package.json",
    "apps/web/package.json",
    "bunfig.toml",
    "patches/example.patch",
    "Cargo.lock",
    "apps/desktop/Cargo.toml",
    "pyproject.toml",
    "uv.lock",
    "requirements.txt",
    ".github/workflows/ci.yml",
    ".github/actions/example/action.yml",
    "action.yml",
    "action.yaml",
  ];
  const cases = [
    ...dependencyInputs.map((file) => ({ files: [file], expected: "true" })),
    { files: ["apps/web/src/example.ts"], expected: "false" },
  ];
  for (const { item, plan } of planSelector(
    cases.map(({ files }) => ({
      files,
      outputs: ["dependency_changes_required"] as const,
    })),
  )) {
    const expected = cases.find(({ files }) => files[0] === item.files[0]);
    if (!expected) {
      throw new TypeError(
        `Missing dependency selector case: ${String(item.files[0])}`,
      );
    }
    expect(plan, item.files[0]).toEqual([expected.expected]);
  }
});

test("wide scopes plan dependency checks only for events that run them", () => {
  const wide = (eventName: string) =>
    computeChangedFileScope({
      changedFiles: [],
      comparisonBase: "",
      scopeUnknown: true,
      eventName,
      suiteDepth: "fast",
      heavyOnly: false,
      prTitle: "",
    })["dependency_changes_required"];
  expect(wide("workflow_dispatch")).toBe("false");
  for (const eventName of ["pull_request", "merge_group"]) {
    expect(wide(eventName), eventName).toBe("true");
  }
});

test("migration checks follow migration inputs and skip unrelated changes", () => {
  for (const file of [
    "apps/api/drizzle/0001_example.sql",
    "apps/api/src/db/schema.ts",
    "scripts/check-migrations.sh",
    "docker/postgres/init.sql",
    ".github/workflows/ci.yml",
  ]) {
    expect(runSelector([file], ["database_migrations_required"]), file).toEqual(
      ["true"],
    );
  }
  expect(
    runSelector(["apps/web/src/example.ts"], ["database_migrations_required"]),
  ).toEqual(["false"]);
});

test("migration detector skips only on a successful explicit false answer", () => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "migration-detector-"));
  mkdirSync(nodePath.join(root, "scripts"));
  try {
    for (const { answer, exitCode, expected } of [
      { answer: "false", exitCode: 0, expected: "false" },
      { answer: "true", exitCode: 0, expected: "true" },
      { answer: "false", exitCode: 1, expected: "true" },
      { answer: "unknown", exitCode: 0, expected: "true" },
      { answer: "", exitCode: 0, expected: "true" },
    ]) {
      writeFileSync(
        nodePath.join(root, "scripts/detect-security-workflow-changes.sh"),
        `printf '%s\n' '${answer}'\nexit ${exitCode}\n`,
      );
      const scope = computeChangedFileScope({
        ...detectorInput("pull_request"),
        changedFiles: ["README.md"],
        root,
      });
      expect(
        scope["database_migrations_required"],
        `${answer}/${exitCode}`,
      ).toBe(expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("desktop Windows dry run follows release inputs and skips unrelated changes", () => {
  const output = "desktop_windows_dry_run_required";
  for (const file of [
    "VERSION",
    ".github/workflows/release-desktop.yml",
    ".github/actions/desktop-windows-build/action.yml",
    "scripts/desktop-release-step.ts",
    "apps/desktop/src-tauri/tauri.conf.json",
  ]) {
    expect(runSelector([file], [output]), file).toEqual(["true"]);
  }
  for (const file of [
    "docs/guide.md",
    "scripts/check-marketing-content.ts",
    "scripts/ci-plan.ts",
  ]) {
    expect(runSelector([file], [output]), file).toEqual(["false"]);
  }
  for (const file of [
    "scripts/ci-windows-dry-run-result.ts",
    "scripts/wasm-toolchain.sh",
  ]) {
    expect(runSelector([file], [output]), file).toEqual(["true"]);
  }
});

test("desktop Windows dry run scopes merge groups but stays fail closed elsewhere", () => {
  const output = ["desktop_windows_dry_run_required"] as const;
  expect(
    runSelector(
      ["apps/desktop/src/mainview/app.ts"],
      output,
      "full",
      "false",
      "merge_group",
    ),
  ).toEqual(["true"]);
  expect(
    runSelector(
      ["apps/api/src/server.ts"],
      output,
      "full",
      "false",
      "merge_group",
    ),
  ).toEqual(["false"]);

  const unknown = computeChangedFileScope(
    {
      ...detectorInput("merge_group"),
      changedFiles: [],
      scopeUnknown: true,
      suiteDepth: "full",
    },
    detectors(),
  );
  expect(unknown.desktop_windows_dry_run_required).toBe("true");

  for (const input of [
    { event: "push", heavyOnly: false },
    { event: "schedule", heavyOnly: true },
  ]) {
    const scope = computeChangedFileScope(
      {
        ...detectorInput(input.event),
        changedFiles: ["apps/api/src/server.ts"],
        suiteDepth: "full",
        heavyOnly: input.heavyOnly,
      },
      detectors(),
    );
    expect(scope.desktop_windows_dry_run_required, input.event).toBe("true");
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

test("a pull request builds the API image for arm64 unless it releases or is armed", () => {
  const outputs = ["api_image_platforms"] as const;
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
      // An armed pull request proves the image at merge-group scope.
      {
        files,
        outputs,
        suiteDepth: "fast",
        armed: true,
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

test("changed-file scope handles former shell edge cases in process", () => {
  for (const changedPath of [
    "bun.lock",
    "package.json",
    "apps/web/e2e/unusual.spec.ts",
  ]) {
    const scope = computeChangedFileScope({
      changedFiles: [changedPath],
      comparisonBase: "base",
      scopeUnknown: false,
      eventName: "pull_request",
      suiteDepth: "fast",
      heavyOnly: false,
      prTitle: "",
    });
    expect(
      scope[
        changedPath.includes("e2e")
          ? "e2e_core_required"
          : "dependency_malware_required"
      ],
    ).toBe("true");
  }
  const unknown = computeChangedFileScope({
    changedFiles: [],
    comparisonBase: "",
    scopeUnknown: true,
    eventName: "pull_request",
    suiteDepth: "fast",
    heavyOnly: false,
    prTitle: "",
  });
  expect(unknown["dependency_malware_required"]).toBe("true");
  expect(unknown["e2e_core_required"]).toBe("true");
  expect(unknown["service_suites_pr_required"]).toBe("true");
});

test("the real changed-file step preserves paths and fails closed on git failures", () => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "ci-plan-scope-"));
  const repository = nodePath.join(directory, "repository");
  const output = nodePath.join(directory, "output");
  mkdirSync(repository);
  symlinkSync(
    new URL("../scripts", import.meta.url),
    nodePath.join(repository, "scripts"),
  );
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CI test",
        GIT_AUTHOR_EMAIL: "ci@example.invalid",
        GIT_COMMITTER_NAME: "CI test",
        GIT_COMMITTER_EMAIL: "ci@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    expect(git("init", "--quiet", "--initial-branch=main").exitCode).toBe(0);
    writeFileSync(nodePath.join(repository, "README.md"), "base\n");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.toString().trim();
    git("update-ref", "refs/remotes/origin/main", base);
    git("switch", "--quiet", "-c", "feature");
    const runScope = (baseRef = "main", path = process.env["PATH"] ?? "") => {
      const run = Bun.spawnSync(["bun", "scripts/ci-plan-scope.ts"], {
        cwd: repository,
        env: {
          ...process.env,
          // The planner prefers BASE_SHA and skips the diff on heavy runs;
          // pin both so the job's own values cannot change what is exercised.
          BASE_SHA: "",
          HEAVY_ONLY: "false",
          BASE_REF: baseRef,
          EVENT_NAME: "pull_request",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
          SUITE_DEPTH: "fast",
          PR_TITLE: "",
          PATH: path,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      return readFileSync(output, "utf-8");
    };
    const expectScans = (lines: string, expected: boolean) => {
      for (const outputName of [
        "dependency_malware_required",
        "e2e_core_required",
        "service_suites_pr_required",
      ]) {
        expect(lines).toContain(`${outputName}=${String(expected)}`);
      }
    };

    expectScans(runScope(), false);
    writeFileSync(nodePath.join(repository, "documentation"), "fixture\n");
    git("add", "documentation");
    git("commit", "--quiet", "-m", "unrelated change");
    expectScans(runScope(), false);

    const unusual = 'quote"back\\slash\ttab\nnewline';
    const changedPaths = [
      nodePath.join("fixtures", unusual, "bun.lock"),
      nodePath.join("fixtures", unusual, "package.json"),
      nodePath.join("apps", "web", "e2e", `${unusual}.spec.ts`),
    ];
    for (const changedPath of changedPaths) {
      mkdirSync(nodePath.dirname(nodePath.join(repository, changedPath)), {
        recursive: true,
      });
      writeFileSync(nodePath.join(repository, changedPath), "fixture\n");
    }
    git("add", "--", ...changedPaths);
    git("commit", "--quiet", "-m", "unusual paths");
    const unusualOutput = runScope();
    expect(unusualOutput).toContain("dependency_malware_required=true");
    expect(unusualOutput).toContain("e2e_core_required=true");
    expect(
      readFileSync(nodePath.join(directory, "api-test-changed-paths"), "utf-8")
        .split("\0")
        .filter(Boolean)
        .toSorted(),
    ).toEqual(["documentation", ...changedPaths].toSorted());

    expectScans(runScope("missing-base"), true);
    const shimDirectory = nodePath.join(directory, "shim");
    mkdirSync(shimDirectory);
    const gitShim = nodePath.join(shimDirectory, "git");
    const systemGit = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
    writeFileSync(
      gitShim,
      `#!/bin/bash\nif [[ "$1" == diff ]]; then exit 1; fi\nexec "${systemGit}" "$@"\n`,
    );
    chmodSync(gitShim, 0o755);
    expectScans(
      runScope("main", `${shimDirectory}:${process.env["PATH"] ?? ""}`),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Five planner processes; two build the repository's service graph cold.
}, 30_000);

// The planner selects every check, so a change to it or any module it imports
// runs at least what an unknown scope runs.
test("a change to the planner or a module it imports plans every wide check", () => {
  const root = nodePath.resolve(import.meta.dir, "..");
  const planner = [
    ...sourceImportClosure(["scripts/ci-plan-scope.ts"], root),
  ].filter((file) => existsSync(nodePath.join(root, file)));
  expect(planner).toContain("scripts/ci-package-scope.ts");
  const plan = (changedFiles: readonly string[], scopeUnknown: boolean) => {
    const {
      api_scope_unknown: _unknown,
      changed_files: _files,
      ...outputs
    } = computeChangedFileScope(
      {
        changedFiles,
        comparisonBase: "",
        scopeUnknown,
        eventName: "pull_request",
        suiteDepth: "fast",
        heavyOnly: false,
        prTitle: "",
      },
      // A standalone landing build is selected, so the widened plan must
      // still leave it to e2e-landing.
      {
        ...DEFAULT_DETECTORS,
        landingBuild: () => true,
        landingDeploy: () => false,
      },
    );
    return outputs;
  };
  const wide = plan([], true);
  expect(wide.route_tree_required).toBe("true");
  expect(wide.model_catalog_drift_required).toBe("true");
  expect(wide.web_api_types_required).toBe("true");
  expect(wide.e2e_landing_required).toBe("true");
  expect(wide.landing_build_required).toBe("false");
  const widePlanned = Object.entries(wide).filter(
    ([output, value]) =>
      value === "true" ||
      output === "api_image_platforms" ||
      output === "landing_build_required",
  );
  for (const file of planner) {
    expect(plan([file], false), file).toMatchObject(
      Object.fromEntries(widePlanned),
    );
  }
});
