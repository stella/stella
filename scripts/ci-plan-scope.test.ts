import { expect, test } from "bun:test";
import fc from "fast-check";
import {
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
import { computeChangedFileScope } from "./ci-plan-scope";
import { GENERATORS } from "./generated-files";

markdownReaders();

type SelectorCase = {
  files: readonly string[];
  outputs: readonly string[];
  suiteDepth?: string;
  event?: string;
  title?: string;
};
const planSelector = <C extends SelectorCase>(cases: readonly C[]) =>
  cases.map((item) => {
    const scope = computeChangedFileScope({
      changedFiles: item.files,
      comparisonBase: "",
      scopeUnknown: false,
      eventName: item.event ?? "pull_request",
      suiteDepth: item.suiteDepth ?? "fast",
      heavyOnly: false,
      prTitle: item.title ?? "",
    });
    return {
      item,
      plan: item.outputs.map(
        (output) => scope[output as keyof typeof scope] ?? "",
      ),
    };
  });
const runSelector = (
  files: readonly string[],
  outputs: readonly string[],
  suiteDepth = "fast",
  _e2eLandingRequired = "false",
  event = "pull_request",
  title = "",
) => planSelector([{ files, outputs, suiteDepth, event, title }])[0]!.plan;

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

test("desktop Windows dry run follows release inputs and skips unrelated changes", () => {
  const output = "desktop_windows_dry_run_required";
  for (const file of [
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
    "scripts/run-oxfmt.ts",
  ]) {
    expect(runSelector([file], [output]), file).toEqual(["true"]);
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
});

test("the real changed-file step runs end to end in a fixture repository", () => {
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
    writeFileSync(nodePath.join(repository, "documentation"), "fixture\n");
    git("add", "documentation");
    git("commit", "--quiet", "-m", "change");
    const run = Bun.spawnSync(["bun", "scripts/ci-plan-scope.ts"], {
      cwd: repository,
      env: {
        ...process.env,
        BASE_REF: "main",
        EVENT_NAME: "pull_request",
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: directory,
        SUITE_DEPTH: "fast",
        PR_TITLE: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const lines = readFileSync(output, "utf-8");
    expect(lines).toContain("dependency_malware_required=false");
    expect(lines).toContain("e2e_core_required=false");
    expect(lines).toContain("service_suites_pr_required=false");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
