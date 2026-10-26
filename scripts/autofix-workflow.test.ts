import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { requiresTauriAlignment } from "./check-tauri-package-alignment";
import {
  CI_GENERATION_COMMANDS,
  GENERATORS,
  generatorsForFiles,
  orderGenerators,
} from "./generated-files";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const WORKFLOW_URL = new URL(
  "../.github/workflows/autofix.yml",
  import.meta.url,
);
const HELPER_URL = new URL("dependabot-changeset.ts", import.meta.url);
const HELPER_TEST_URL = new URL(
  "dependabot-changeset.test.ts",
  import.meta.url,
);
const CHANGESET_GUARD_URL = new URL("changeset-guard.ts", import.meta.url);
const RESOLUTION_SCRIPTS = [
  "scripts/check-resolution-ranges.ts",
  "scripts/check-resolutions-only-change.ts",
  "scripts/fix-resolution-ranges.ts",
  "scripts/json-text-edit.ts",
  "scripts/resolution-ranges.ts",
] as const;
const RESOLUTION_SOURCE_URLS = RESOLUTION_SCRIPTS.map(
  (script) => new URL(script.replace("scripts/", ""), import.meta.url),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// This test runs before the dependency install, so it narrows the workflow by
// hand instead of with a schema library. Undefined means no path filter.
const autofixTriggerPaths = (): string[] | undefined => {
  const workflow: unknown = Bun.YAML.parse(readFileSync(WORKFLOW_URL, "utf-8"));
  const on = isRecord(workflow) ? workflow["on"] : undefined;
  const pullRequest = isRecord(on) ? on["pull_request"] : undefined;
  if (!isRecord(pullRequest)) {
    throw new TypeError("autofix must trigger on pull_request");
  }
  expect(pullRequest["paths-ignore"]).toBeUndefined();
  const paths: unknown = pullRequest["paths"];
  if (paths === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(paths) ||
    !paths.every((path): path is string => typeof path === "string")
  ) {
    throw new TypeError("autofix pull_request paths must be strings");
  }
  return paths;
};

// Workflow files are never format or lint targets, so only a workflow that a
// generator or the Tauri alignment reads (or this workflow) can need autofix.
// When every workflow is read, the trigger filters nothing.
test("the PR trigger drops exactly the workflow files autofix never reads", () => {
  const all = readdirSync(new URL("../.github/workflows", import.meta.url))
    .map((name) => `.github/workflows/${name}`)
    .toSorted();
  const workflows = all.filter(
    (file) =>
      file === ".github/workflows/autofix.yml" ||
      generatorsForFiles([file]).length > 0 ||
      requiresTauriAlignment([file]),
  );
  expect(workflows).toContain(".github/workflows/ci.yml");
  expect(autofixTriggerPaths()).toEqual(
    workflows.length === all.length
      ? undefined
      : ["**", "!.github/workflows/**", ...workflows],
  );
});

test("every workflow edit selects the classification digest refresh", () => {
  for (const file of [
    ".github/workflows/deploy-staging.yml",
    ".github/actions/ci-install/action.yml",
    ".github/ci-job-classification-decisions/**",
    "scripts/ci-job-classification/yaml.ts",
  ]) {
    expect(
      generatorsForFiles([file]).map(({ id }) => id),
      file,
    ).toContain("ci-job-classification-digests");
  }
  expect(
    generatorsForFiles(["apps/web/src/main.tsx"]).map(({ id }) => id),
  ).not.toContain("ci-job-classification-digests");
});

const namedCiStep = (workflow: unknown, name: string) => {
  if (!isRecord(workflow)) {
    throw new TypeError("CI workflow must declare jobs");
  }
  const jobs = workflow["jobs"];
  if (!isRecord(jobs)) {
    throw new TypeError("CI workflow must declare jobs");
  }
  const steps = Object.keys(jobs).flatMap((jobId) => {
    const job = jobs[jobId];
    if (!isRecord(job) || !Array.isArray(job["steps"])) {
      return [];
    }
    const jobSteps = workflowJobSteps(workflow, jobId);
    return jobSteps.some((step) => step["name"] === name)
      ? [workflowStepByName(jobSteps, name)]
      : [];
  });
  const step = workflowStepByName(steps.slice(0, 1), name);
  // The same anchored guard runs in mutually exclusive event carriers.
  for (const match of steps.slice(1)) {
    expect(match).toEqual(step);
  }
  return step;
};

describe("Dependabot Bun autofix boundary", () => {
  test("keeps the runner read-only and hands off only verified autofixes", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );
    const trustedSourcesStep = workflow.indexOf(
      "- name: Verify trusted autofix sources",
    );
    const pushStep = workflow.indexOf("- name: Push autofixes");

    expect(workflow).toContain(
      "name: autofix.ci # autofix.ci uses this exact name as a security boundary",
    );
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("secrets.");

    expect(workflow).toContain("github.actor != 'autofix-ci[bot]'");
    expect(workflow).toContain(
      "github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'dependabot/bun/')",
    );
    expect(workflow).toContain(
      `ref: \${{ github.event.pull_request.head.sha }}`,
    );
    expect(workflow).toContain("persist-credentials: false");

    expect(workflow).toContain(
      "bun --no-env-file dedupe --lockfile-only --ignore-scripts",
    );
    expect(workflow).toContain(
      `git diff --name-only "$HEAD_SHA" -- . ':(exclude)bun.lock' ':(exclude)package.json' ":(exclude)$DEPENDABOT_CHANGESET_PATH"`,
    );
    expect(workflow).toContain(
      `git ls-files --others --exclude-standard -- . ":(exclude)$DEPENDABOT_CHANGESET_PATH"`,
    );
    expect(restrictionStep).toBeGreaterThanOrEqual(0);
    expect(trustedSourcesStep).toBeGreaterThanOrEqual(0);
    expect(restrictionStep).toBeGreaterThan(trustedSourcesStep);
    expect(pushStep).toBeGreaterThan(restrictionStep);
    expect(workflow).toContain(
      "autofix-ci/action@c5b2d67aa2274e7b5a18224e8171550871fc7e4a # v1.3.4",
    );
    expect(workflow).toContain("- name: Verify trusted autofix sources");
    expect(workflow).toContain(`git diff --quiet "$BASE_SHA" "$HEAD_SHA" --`);
    expect(workflow).toContain(
      `if [[ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]]; then`,
    );
    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/dependabot-changeset.ts",
    );

    const helperTest = await Bun.file(HELPER_TEST_URL).text();
    const externalTestImports = [...helperTest.matchAll(/from "([^"]+)"/gu)]
      .flatMap((match) => {
        const specifier = match.at(1);
        return specifier === undefined ? [] : [specifier];
      })
      .filter(
        (specifier) =>
          specifier !== "bun:test" &&
          !specifier.startsWith("node:") &&
          !specifier.startsWith("."),
      );
    expect(externalTestImports).toEqual([]);

    const sources = await Promise.all(
      [HELPER_URL, CHANGESET_GUARD_URL, ...RESOLUTION_SOURCE_URLS].map(
        async (url) => await Bun.file(url).text(),
      ),
    );
    // The job never installs, so every script it runs must resolve without
    // node_modules.
    for (const source of sources) {
      expect(source).not.toContain('from "better-result"');
    }
  });

  test("repairs a resolution pin that a bump pushed below its dependents' floor", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const trustedSourcesStep = workflow.indexOf(
      "- name: Verify trusted autofix sources",
    );
    const fixStep = workflow.indexOf(
      "- name: Raise resolutions to their dependents' floors",
    );
    const guardStep = workflow.indexOf("- name: Resolution range guard");
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );

    // The fixer runs only after its own sources are verified against the base,
    // so a Dependabot PR cannot smuggle in a modified fixer.
    for (const script of RESOLUTION_SCRIPTS) {
      expect(workflow.indexOf(script)).toBeGreaterThan(trustedSourcesStep);
      expect(workflow.indexOf(script)).toBeLessThan(fixStep);
    }
    expect(fixStep).toBeGreaterThan(trustedSourcesStep);
    expect(guardStep).toBeGreaterThan(fixStep);
    expect(restrictionStep).toBeGreaterThan(guardStep);

    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/fix-resolution-ranges.ts",
    );
    expect(workflow).toContain("--max-passes 4");
    // The lockfile refresh between passes lives in the fixer, which the
    // trusted-sources step pins to the base revision.
    const fixer = await Bun.file(
      new URL("fix-resolution-ranges.ts", import.meta.url),
    ).text();
    expect(fixer).toContain(`"install", "--lockfile-only", "--ignore-scripts"`);
    expect(workflow).toContain(
      "bun --no-install --no-env-file scripts/check-resolution-ranges.ts",
    );
    expect(workflow).toContain(
      `bun --no-install --no-env-file scripts/check-resolutions-only-change.ts --ref "$HEAD_SHA"`,
    );
    expect(workflow).toContain("git diff --check -- bun.lock package.json");
  });

  test("adds a deterministic changeset for published dependency updates and verifies it before pushing", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const changesetStep = workflow.indexOf(
      "- name: Add missing Dependabot changeset",
    );
    const restrictionStep = workflow.indexOf(
      "- name: Restrict generated changes",
    );
    const pushStep = workflow.indexOf("- name: Push autofixes");
    const writeCall = `bun --no-install --no-env-file scripts/dependabot-changeset.ts
          --base "$BASE_SHA" --head "$HEAD_SHA" --output "$DEPENDABOT_CHANGESET_PATH"`;
    const checkCall = `bun --no-install --no-env-file scripts/dependabot-changeset.ts \\
            --base "$BASE_SHA" --head "$HEAD_SHA" --output "$DEPENDABOT_CHANGESET_PATH" --check`;

    // No path filter, or one that keeps every non-workflow file, so a
    // package.json-only bump still runs; the Dependabot job scopes itself by
    // head ref.
    const paths = autofixTriggerPaths();
    if (paths !== undefined) {
      expect(paths.slice(0, 2)).toEqual(["**", "!.github/workflows/**"]);
    }
    expect(workflow).toContain(
      `DEPENDABOT_CHANGESET_PATH: .changeset/dependabot-dependencies-\${{ github.event.pull_request.number }}.md`,
    );
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain(writeCall);
    expect(workflow).toContain(checkCall);
    expect(workflow).toContain(`":(exclude)$DEPENDABOT_CHANGESET_PATH"`);
    expect(changesetStep).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf(writeCall)).toBeGreaterThan(changesetStep);
    expect(workflow.indexOf(writeCall)).toBeLessThan(restrictionStep);
    expect(workflow.indexOf(checkCall)).toBeGreaterThan(restrictionStep);
    expect(workflow.indexOf(checkCall)).toBeLessThan(pushStep);
    expect(restrictionStep).toBeGreaterThan(changesetStep);
    expect(pushStep).toBeGreaterThan(restrictionStep);
  });
});

describe("changed-file autofix boundary", () => {
  const jobOf = (workflow: string): string => {
    const start = workflow.indexOf("  regenerate-scope:");
    expect(start).toBeGreaterThanOrEqual(0);
    return workflow.slice(start);
  };

  test("autofixes only same-repository pull requests through the app", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());

    // CI dispatches the request; the scope job re-reads the pull request.
    expect(job).toContain(".head.repo.full_name == $repository");
    expect(job).toContain('.user.login != "dependabot[bot]"');
    expect(job).toContain(`ref: \${{ needs.regenerate-scope.outputs.head }}`);
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain('NPM_TOKEN: ""');
    expect(job).not.toContain("secrets.");

    const preparationStep = job.indexOf(
      "- name: Prepare selected MCP app exports",
    );
    const fixesStep = job.indexOf("- name: Fix changed files");
    expect(preparationStep).toBeGreaterThan(0);
    expect(fixesStep).toBeGreaterThan(preparationStep);
    const restrictionStep = job.indexOf("- name: Restrict autofix changes");
    const pushStep = job.indexOf("- name: Push autofixes");
    expect(restrictionStep).toBeGreaterThanOrEqual(0);
    expect(pushStep).toBeGreaterThan(restrictionStep);
    expect(job.indexOf("autofix-ci/action@")).toBeGreaterThan(pushStep);
  });

  test("finds a named CI guard inside a nested parallel group", () => {
    const workflow = {
      jobs: {
        generated: {
          steps: [
            {
              parallel: [
                {
                  parallel: [
                    {
                      name: "Generated files manifest guard",
                      run: "bun scripts/generated-files-guard.ts --guard-b",
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    expect(namedCiStep(workflow, "Generated files manifest guard")["run"]).toBe(
      "bun scripts/generated-files-guard.ts --guard-b",
    );
  });

  test("shared CI guards preserve identical commands and inputs in every carrier", () => {
    const source = `jobs:
  pull-request:
    steps: &shared
      - name: Generated files manifest guard
        run: bun scripts/generated-files-guard.ts --guard-b
        env:
          MODE: check
  other-events:
    steps: *shared
`;
    expect(
      namedCiStep(Bun.YAML.parse(source), "Generated files manifest guard")[
        "run"
      ],
    ).toBe("bun scripts/generated-files-guard.ts --guard-b");
    const changed = `jobs:
  pull-request:
    steps:
      - name: Generated files manifest guard
        run: bun scripts/generated-files-guard.ts --guard-b
        env:
          MODE: check
  other-events:
    steps:
      - name: Generated files manifest guard
        run: bun scripts/generated-files-guard.ts --guard-b
        env:
          MODE: write
`;
    expect(() =>
      namedCiStep(Bun.YAML.parse(changed), "Generated files manifest guard"),
    ).toThrow("toEqual");
    const duplicate = `jobs:
  check:
    steps:
      - &guard
        name: Generated files manifest guard
        run: bun scripts/generated-files-guard.ts --guard-b
      - *guard
`;
    expect(() =>
      namedCiStep(Bun.YAML.parse(duplicate), "Generated files manifest guard"),
    ).toThrow("Expected one workflow step");
  });

  test("every selected generator finishes after every source-rewriting fixer", async () => {
    const steps = workflowJobSteps(
      Bun.YAML.parse(await Bun.file(WORKFLOW_URL).text()),
      "regenerate-derived-files",
    );
    const generatorCommands = GENERATORS.filter(({ autofix }) => autofix).map(
      ({ write }) => write.join(" "),
    );
    const sourceFixer =
      /\boxlint\b[^\n]*--fix\b|\bbun fmt\b|scripts\/fix-[\w-]+\.ts|scripts\/typecheck-coverage\.ts[^\n]*--autofix\b/u;
    const isGenerator = (run: string) =>
      /scripts\/autofix-plan\.ts run\b/u.test(run) ||
      generatorCommands.some((command) => run.includes(command));
    const terminalGenerators = (pipeline: typeof steps) => {
      const positions = new Map<string, number>();
      for (const [position, step] of pipeline.entries()) {
        const run = step["run"];
        if (typeof run !== "string") {
          continue;
        }
        if (/scripts\/autofix-plan\.ts run\b/u.test(run)) {
          positions.set("selected generators", position);
        }
        for (const command of generatorCommands) {
          if (run.includes(command)) {
            positions.set(command, position);
          }
        }
      }
      return [...new Set(positions.values())];
    };
    const violations = (pipeline: typeof steps) => {
      const fixers = pipeline.flatMap((step, position) =>
        typeof step["run"] === "string" && sourceFixer.test(step["run"])
          ? [position]
          : [],
      );
      const generators = terminalGenerators(pipeline);
      expect(fixers.length).toBeGreaterThan(0);
      expect(generators.length).toBeGreaterThan(0);
      return generators.flatMap((generator) =>
        fixers.filter((fixer) => fixer >= generator),
      );
    };
    expect(violations(steps)).toEqual([]);
    // Mutate every enumerated producer/fixer pair, including future manifest
    // generator commands. A new writer must satisfy the same ordering guard.
    for (const [generator, producer] of steps.entries()) {
      if (
        typeof producer["run"] !== "string" ||
        !isGenerator(producer["run"]) ||
        !terminalGenerators(steps).includes(generator)
      ) {
        continue;
      }
      for (const [fixer, writer] of steps.entries()) {
        if (
          typeof writer["run"] !== "string" ||
          !sourceFixer.test(writer["run"])
        ) {
          continue;
        }
        const mutated = [...steps];
        mutated[generator] = writer;
        mutated[fixer] = producer;
        expect(violations(mutated).length).toBeGreaterThan(0);
      }
    }
  });

  test("runs the manifest plan and keeps the generated diff restricted", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());
    const ci = await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text();
    const ciWorkflow = Bun.YAML.parse(ci);
    const preparationStep = job.indexOf(
      "- name: Prepare selected MCP app exports",
    );
    const fixesStep = job.indexOf("- name: Fix changed files");
    expect(preparationStep).toBeGreaterThan(0);
    expect(fixesStep).toBeGreaterThan(preparationStep);
    const restrictionStep = job.indexOf("- name: Restrict autofix changes");
    const fetchStep = job.indexOf("- name: Fetch changed paths");
    const checkoutStep = job.indexOf("- name: Checkout pull request head");
    const planStep = job.indexOf("- name: Match generator inputs");
    const runStep = job.indexOf("- name: Regenerate selected files");
    expect(job).toContain("scripts/autofix-plan.ts plan");
    expect(job).toContain('scripts/autofix-plan.ts run "$GENERATOR_IDS"');
    expect(job).toContain(`allowed: \${{ steps.scope.outputs.allowed }}`);
    expect(job).toContain(
      `GENERATOR_ALLOWED: \${{ needs.regenerate-scope.outputs.allowed }}`,
    );
    expect(job).toContain(
      "IFS='|' read -r -a generated <<< \"$GENERATOR_ALLOWED\"",
    );
    expect(fetchStep).toBeGreaterThanOrEqual(0);
    expect(checkoutStep).toBeGreaterThan(fetchStep);
    expect(planStep).toBeGreaterThan(checkoutStep);
    expect(job.slice(checkoutStep, planStep)).toContain(
      "sparse-checkout-cone-mode: false",
    );
    expect(job.slice(checkoutStep, planStep)).toContain("/scripts/");
    expect(job.slice(checkoutStep, planStep)).toContain("/package.json");
    expect(runStep).toBeGreaterThan(planStep);
    expect(restrictionStep).toBeGreaterThan(runStep);
    expect(job.slice(fetchStep, planStep)).toContain("GH_TOKEN:");
    expect(job.slice(planStep, runStep)).not.toContain("GH_TOKEN:");
    expect(
      job.slice(restrictionStep, job.indexOf("- name: Push autofixes")),
    ).toContain("Autofix cannot recreate the retired ratchet baseline.");
    expect(job).toContain(
      'if [[ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]]; then',
    );
    expect(job).toContain(`git diff --name-only -- . "\${excludes[@]}"`);
    expect(job).toContain(
      `git ls-files --others --exclude-standard -- . "\${excludes[@]}"`,
    );
    expect(job).not.toContain("inputs='^");
    expect(job).not.toContain("generated=(");
    const ordered = orderGenerators(
      GENERATORS.filter((generator) => generator.autofix),
    );
    expect(
      ordered.findIndex(({ id }) => id === "capability-catalog"),
    ).toBeLessThan(ordered.findIndex(({ id }) => id === "capability-runtime"));
    expect(
      ordered.findIndex(({ id }) => id === "capability-runtime"),
    ).toBeLessThan(ordered.findIndex(({ id }) => id === "cli-registry"));
    expect(ordered.findIndex(({ id }) => id === "cli-registry")).toBeLessThan(
      ordered.findIndex(({ id }) => id === "cli-runtime"),
    );
    for (const generator of ordered) {
      if (generator.check) {
        expect(
          namedCiStep(ciWorkflow, "Generated files manifest guard")["run"],
        ).toContain("bun scripts/generated-files-guard.ts --guard-b");
      } else {
        // The null-check families use the named CI guard paired in the manifest.
        expect(generator.checkedBy).toBeDefined();
        expect(
          namedCiStep(ciWorkflow, generator.checkedBy ?? ""),
        ).toBeDefined();
      }
    }
  });

  test("each named CI guard runs its generator command or check form", async () => {
    const ci = await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text();
    const ciWorkflow = Bun.YAML.parse(ci);
    for (const generator of orderGenerators(GENERATORS)) {
      if (!generator.checkedBy) {
        continue;
      }
      const step = namedCiStep(ciWorkflow, generator.checkedBy);
      const run = step["run"];
      if (typeof run !== "string") {
        throw new TypeError(`${generator.checkedBy} has no run command`);
      }
      const commands = new Set(run.split("\n").map((line) => line.trim()));
      if (commands.has("bun scripts/ci-generated-sources.ts prepare")) {
        for (const command of CI_GENERATION_COMMANDS) {
          commands.add(command.join(" "));
        }
      }
      // Runtime flags don't change what a command checks; an improvements-only
      // writer is guarded by the full check.
      const write = generator.write.filter(
        (part) => part !== "--no-install" && part !== "--no-env-file",
      );
      const writesBaseline = (part: string) =>
        part === "--write" || part === "--write-improvements-only";
      const check = write.some(writesBaseline)
        ? write.map((part) => (writesBaseline(part) ? "--check" : part))
        : [...write, "--check"];
      const render = (argv: readonly string[]) => {
        const cwd = argv.at(1);
        if (cwd?.startsWith("--cwd=")) {
          return `(cd ${cwd.slice("--cwd=".length)} && bun ${argv.slice(2).join(" ")})`;
        }
        return argv.join(" ");
      };
      expect(
        [write, generator.check ?? generator.checkedWith ?? check].some(
          (argv) => commands.has(argv.join(" ")) || commands.has(render(argv)),
        ),
        `${generator.id}: ${generator.checkedBy}`,
      ).toBe(true);
    }
  });

  test("runs safe fixes for changed files without a selected generator", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());
    const scopeStep = job.indexOf("- name: Match generator inputs");
    const changedStep = job.indexOf("- name: Record changed paths");
    const generatorStep = job.indexOf("- name: Regenerate selected files");
    const fixStep = job.indexOf("- name: Fix changed files");
    const restrictionStep = job.indexOf("- name: Restrict autofix changes");
    const pushStep = job.indexOf("- name: Push autofixes");
    const fix = job.slice(fixStep, restrictionStep);

    expect(job).toContain("needs: regenerate-scope");
    expect(job).toContain("needs.regenerate-scope.result == 'success'");
    expect(job).toContain("needs.regenerate-scope.outputs.ready == 'true'");
    expect(job).toContain("github.actor != 'autofix-ci[bot]'");
    expect(job.slice(generatorStep, restrictionStep)).toContain(
      "if: needs.regenerate-scope.outputs.run == 'true'",
    );
    expect(job).toContain("scripts/autofix-plan.ts plan");
    expect(job).toContain("scripts/autofix-plan.ts plan --all");
    // A capped file list regenerates rather than skipping.
    expect(job).toContain("-ge 3000");
    expect(changedStep).toBeGreaterThan(scopeStep);
    expect(generatorStep).toBeGreaterThan(changedStep);
    expect(fixStep).toBeGreaterThan(changedStep);
    expect(generatorStep).toBeGreaterThan(fixStep);
    expect(restrictionStep).toBeGreaterThan(fixStep);
    expect(pushStep).toBeGreaterThan(restrictionStep);

    expect(job).toContain(
      'git diff --name-only -z --diff-filter=ACMR "$BASE_SHA"..."$HEAD_SHA" -- > "$RUNNER_TEMP/autofix-changed-paths"',
    );
    expect(fix).toContain("while IFS= read -r -d '' path; do");
    expect(fix).toContain('[[ -f "$path" && ! -L "$path" ]]');
    expect(fix).toContain(
      'if [[ "$path" == .github/workflows/* || "$path" == scripts/ratchet-baseline.json ]]; then',
    );
    expect(fix).toContain(
      `bun --bun oxlint -c oxlint.config.ts --no-error-on-unmatched-pattern --type-aware --fix "\${lint_paths[@]}"`,
    );
    expect(fix).toContain("lint_status > 1");
    // The Astro project has no native-compiler type graph to fix against.
    expect(fix).toContain(
      `if [[ "$path" =~ \\.([cm]?[jt]s|[jt]sx)$ && "$path" != apps/landing/* ]]; then`,
    );
    const prepare = fix.indexOf("bun scripts/ci-generated-sources.ts prepare");
    const typecheck = fix.indexOf(
      "bun scripts/typecheck-coverage.ts --autofix",
    );
    const autofix = fix.indexOf("--type-aware --fix");
    expect(prepare).toBeGreaterThan(0);
    // The fixer runs on the prepared type graph; its rewrites are checked
    // afterwards and restored when their project does not type-check, and
    // the step continues so formatting and generators still push.
    expect(autofix).toBeGreaterThan(prepare);
    expect(typecheck).toBeGreaterThan(autofix);
    expect(fix.slice(typecheck)).toContain("restore_lint_paths");
    expect(fix.slice(typecheck)).not.toContain('exit "$typecheck_status"');
    expect(fix).toContain("set -euo pipefail");
    expect(fix).toContain(`bun fmt --ignore-unknown "\${format_paths[@]}"`);
    for (const unsafe of ["--fix-suggestions", "--fix-dangerously"]) {
      expect(fix).not.toContain(unsafe);
    }
    expect(job.slice(restrictionStep, pushStep)).toContain(
      'excludes+=(":(exclude,literal)$path")',
    );
    expect(job.slice(restrictionStep, pushStep)).toContain(
      'if [[ "$path" == .github/workflows/* || "$path" == scripts/ratchet-baseline.json ]]; then',
    );
    expect(job).not.toContain("git commit");
    expect(job).not.toContain("git push");
    expect(job).toContain(
      "autofix-ci/action@c5b2d67aa2274e7b5a18224e8171550871fc7e4a",
    );
  });

  test("scopes a later push to what changed since the settled commit", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());
    const settledStep = job.indexOf("- name: Find settled autofix commit");
    const planStep = job.indexOf("- name: Match generator inputs");
    const derivedJob = job.indexOf("  regenerate-derived-files:");
    const changedStep = job.indexOf("- name: Record changed paths");
    const tauriStep = job.indexOf("- name: Align Tauri counterparts");
    const fixStep = job.indexOf("- name: Fix changed files");
    const pruneStep = job.indexOf("- name: Prune stale baseline entries");
    const restrictionStep = job.indexOf("- name: Restrict autofix changes");
    const pushStep = job.indexOf("- name: Push autofixes");

    expect(settledStep).toBeGreaterThan(0);
    expect(planStep).toBeGreaterThan(settledStep);
    expect(job.slice(0, derivedJob)).toContain("checks: read");
    expect(job.slice(0, settledStep)).toContain("fetch-depth: 21");
    expect(job.slice(settledStep, planStep)).toContain(
      "if: steps.planner.outputs.ready == 'true'",
    );
    expect(job.slice(settledStep, planStep)).toContain(
      "scripts/autofix-push-scope.ts settled",
    );
    expect(job.slice(planStep, derivedJob)).toContain(
      'scripts/autofix-plan.ts plan --since "$RUNNER_TEMP/push-paths"',
    );
    // An older planner prints no `needed` or `prune`; empty means run.
    expect(job.slice(derivedJob, changedStep)).toContain(
      "needs.regenerate-scope.outputs.needed != 'false'",
    );
    expect(job.slice(pruneStep, restrictionStep)).toContain(
      "if: needs.regenerate-scope.outputs.prune != 'false'",
    );
    // Fixers read the push scope; the rewrite boundary stays the whole PR.
    const changed = job.slice(changedStep, tauriStep);
    expect(changed).toContain(
      'git diff --name-only -z --no-renames "$SINCE_SHA" "$HEAD_SHA"',
    );
    expect(changed).toContain(
      'cp "$RUNNER_TEMP/autofix-changed-paths" "$RUNNER_TEMP/autofix-fix-paths"',
    );
    // A changed fixer input drops the push scope for the fixers.
    expect(changed).toContain(
      `SINCE_SHA: \${{ needs.regenerate-scope.outputs.refix != 'true' && needs.regenerate-scope.outputs.since || '' }}`,
    );
    expect(job.slice(0, derivedJob)).toContain(
      `refix: \${{ steps.scope.outputs.refix }}`,
    );
    expect(job.slice(tauriStep, fixStep)).toContain(
      'done < "$RUNNER_TEMP/autofix-fix-paths"',
    );
    expect(job.slice(fixStep, pruneStep)).toContain(
      'done < "$RUNNER_TEMP/autofix-fix-paths"',
    );
    expect(job.slice(fixStep, pruneStep)).not.toContain(
      "autofix-changed-paths",
    );
    expect(job.slice(restrictionStep, pushStep)).toContain(
      'done < "$RUNNER_TEMP/autofix-changed-paths"',
    );
  });

  test("skips an old head without the planner but detects a broken sparse checkout", async () => {
    const job = jobOf(await Bun.file(WORKFLOW_URL).text());
    const availability = job.indexOf("- name: Check planner availability");
    const plan = job.indexOf("- name: Match generator inputs");
    const scope = job.slice(availability, plan);

    expect(availability).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(availability);
    expect(job).toContain(`ready: \${{ steps.planner.outputs.ready }}`);
    expect(scope).toContain(
      "scripts/autofix-plan.ts scripts/autofix-protected-paths.ts scripts/baseline-paths.ts scripts/generated-files.ts packages/scripts/src/generated-files.ts",
    );
    expect(scope).toContain('git cat-file -e "HEAD:$path"');
    expect(scope).toContain('echo "ready=false" >> "$GITHUB_OUTPUT"');
    expect(scope).toContain('echo "ready=true" >> "$GITHUB_OUTPUT"');
    expect(job.slice(plan)).toContain(
      "if: steps.planner.outputs.ready == 'true'",
    );
    expect(job).toContain("needs.regenerate-scope.outputs.ready == 'true'");
  });
});

test("type-aware autofix fixtures require a successful dependency install", async () => {
  // Pooled checks are steps of their job; see scripts/workflow-steps.ts.
  const steps = workflowJobSteps(
    Bun.YAML.parse(
      await Bun.file(
        new URL("../.github/workflows/ci.yml", import.meta.url),
      ).text(),
    ),
    "ci-checks-rest",
  );
  const named = (name: string) => {
    const step = steps.find((candidate) => candidate["name"] === name);
    expect(step, name).toBeDefined();
    return { condition: String(step?.["if"]), run: String(step?.["run"]) };
  };
  const step = named("Test type-aware autofix");
  expect(step.condition).toContain("steps.install.outcome == 'success'");
  expect(step.condition).toContain(
    "needs.ci-plan.outputs.package_checks_required == 'true'",
  );
  expect(step.run).toContain("bun test scripts/autofix-type-aware.test.ts");
  const invariants = named("Test CI workflow invariants").run;
  expect(invariants).not.toContain("scripts/autofix-type-aware.test.ts");
  expect(invariants).not.toContain(
    "apps/api/scripts/refresh-test-durations.test.ts",
  );
});
