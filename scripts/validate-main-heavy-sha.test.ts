import { panic } from "better-result";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { contextFromNested, evaluate } from "./github-expression";

const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
});
const jobSchema = v.looseObject({
  steps: v.optional(v.array(stepSchema)),
});
const workflowSchema = v.object({ jobs: v.object({ validate: jobSchema }) });
const readWorkflow = (name: string) =>
  v.parse(
    workflowSchema,
    Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${name}.yml`, import.meta.url),
        "utf-8",
      ),
    ),
  );
const workflow = readWorkflow("main-heavy");
const validationSteps = workflow.jobs.validate.steps ?? [];
const namedStep = (name: string) => {
  const step = validationSteps.find((candidate) => candidate.name === name);
  if (step?.run === undefined) {
    panic(`main-heavy.yml is missing runnable step ${name}`);
  }
  return step.run;
};
const validateFormat = namedStep("Validate SHA format");
const verifyAncestry = namedStep("Verify main ancestry");

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const runStep = (
  script: string,
  sha: string,
  cwd: string,
  outputPath: string,
) =>
  Bun.spawnSync(["bash", "-euc", script], {
    cwd,
    env: {
      ...process.env,
      SHA: sha,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "stella/stella",
      RUNNER_TEMP: cwd,
      GH_RETRY_SCRIPT: path.join(cwd, "gh-retry.sh"),
    },
  });

test("dispatch SHA validation delegates main and authorized release heads to the shared verifier", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "main-heavy-sha-"));
  try {
    runGit(fixture, "init", "-b", "main");
    runGit(fixture, "config", "user.name", "Fixture");
    runGit(fixture, "config", "user.email", "fixture@example.invalid");
    runGit(fixture, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(fixture, "tracked"), "main\n");
    runGit(fixture, "add", "tracked");
    runGit(fixture, "commit", "-m", "main commit");
    const mainSha = runGit(fixture, "rev-parse", "HEAD");
    runGit(fixture, "update-ref", "refs/remotes/origin/main", mainSha);

    runGit(fixture, "checkout", "--orphan", "sibling");
    runGit(fixture, "rm", "-rf", ".");
    writeFileSync(path.join(fixture, "sibling"), "sibling\n");
    runGit(fixture, "add", "sibling");
    runGit(fixture, "commit", "-m", "unrelated commit");
    const siblingSha = runGit(fixture, "rev-parse", "HEAD");

    runGit(fixture, "checkout", "-b", "release", mainSha);
    writeFileSync(path.join(fixture, "tracked"), "release\n");
    runGit(fixture, "add", "tracked");
    runGit(fixture, "commit", "-m", "release commit");
    const releaseSha = runGit(fixture, "rev-parse", "HEAD");
    writeFileSync(
      path.join(fixture, "verify-release-tree-proof.sh"),
      readFileSync(
        new URL("verify-release-tree-proof.sh", import.meta.url),
        "utf-8",
      ),
    );
    writeFileSync(
      path.join(fixture, "gh-retry.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
endpoint="\${!#}"
case "$endpoint" in
  repos/stella/stella/commits/*/pulls?per_page=100)
    sha="\${endpoint#repos/stella/stella/commits/}"
    sha="\${sha%%/*}"
    if [[ "$sha" == "${releaseSha}" ]]; then
      printf '%s\\n' '[[{"number":1,"title":"chore: release v1.2.3","state":"open","merged_at":null,"head":{"sha":"${releaseSha}","repo":{"full_name":"stella/stella"}},"base":{"sha":"${mainSha}","ref":"main","repo":{"full_name":"stella/stella"}}}]]'
    else printf '%s\\n' '[[]]'; fi
    ;;
  repos/stella/stella/commits/*)
    sha="\${endpoint##*/}"
    tree=$(git rev-parse --verify "$sha^{tree}")
    printf '{"sha":"%s","commit":{"tree":{"sha":"%s"}}}\\n' "$sha" "$tree"
    ;;
  repos/stella/stella/compare/*)
    printf '%s\\n' '{"status":"identical","merge_base_commit":{"sha":"${mainSha}"}}'
    ;;
  *) exit 1 ;;
esac
`,
    );

    const outputPath = path.join(fixture, "github-output");
    const acceptedFormat = runStep(
      validateFormat,
      mainSha,
      fixture,
      outputPath,
    );
    expect(acceptedFormat.exitCode).toBe(0);
    expect(runStep(verifyAncestry, mainSha, fixture, outputPath).exitCode).toBe(
      0,
    );
    expect(readFileSync(outputPath, "utf-8")).toContain(`sha=${mainSha}`);
    expect(readFileSync(outputPath, "utf-8")).toContain(
      "task_cache_producer=validated-main",
    );
    expect(
      runStep(verifyAncestry, releaseSha, fixture, outputPath).exitCode,
    ).toBe(0);
    expect(readFileSync(outputPath, "utf-8")).toContain(`sha=${releaseSha}`);

    const rejectedFormat = [
      mainSha.slice(0, 39),
      "A".repeat(40),
      `${mainSha.slice(0, 39)}g`,
    ];
    for (const sha of rejectedFormat) {
      expect(
        runStep(validateFormat, sha, fixture, outputPath).exitCode,
      ).not.toBe(0);
    }

    const missingSha = "a".repeat(40);
    writeFileSync(outputPath, "");
    expect(
      runStep(validateFormat, missingSha, fixture, outputPath).exitCode,
    ).toBe(0);
    expect(
      runStep(verifyAncestry, missingSha, fixture, outputPath).exitCode,
    ).not.toBe(0);
    expect(
      runStep(verifyAncestry, siblingSha, fixture, outputPath).exitCode,
    ).not.toBe(0);
    expect(readFileSync(outputPath, "utf-8")).toBe("");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("only trusted main tooling is checked out before target verification", () => {
  const names = validationSteps.map(({ name }) => name);
  expect(names).toEqual([
    "Check release candidate",
    "Validate merge queue depth",
    "Checkout trusted release proof tooling",
    // Uncached runtime for the release queue history check; no target code.
    "Setup Bun",
    "Reuse completed release proof",
    "Dispatch release PR-depth checks",
    "Select untested heavy SHA",
    "Validate SHA format",
    "Fetch main history",
    "Verify main ancestry",
  ]);
  const checkouts = validationSteps.filter(({ uses }) =>
    uses?.startsWith("actions/checkout@"),
  );
  expect(checkouts).toHaveLength(1);
  expect(checkouts.at(0)?.with?.["ref"]).toBe("main");
  expect(checkouts.at(0)?.with?.["path"]).toBe(".release-proof");
  expect(checkouts.at(0)?.with?.["persist-credentials"]).toBe(false);
});

test("scheduled main validation delegates ancestry to trusted main tooling before suite checkout", () => {
  for (const name of ["main-heavy", "main-pr-depth"]) {
    const steps = readWorkflow(name).jobs.validate.steps ?? [];
    const names = steps.map((step) => step.name);
    expect(names.indexOf("Validate SHA format"), name).toBeLessThan(
      names.indexOf("Fetch main history"),
    );
    expect(names.indexOf("Fetch main history"), name).toBeLessThan(
      names.indexOf("Verify main ancestry"),
    );
    const checkouts = steps.filter(({ uses }) =>
      uses?.startsWith("actions/checkout@"),
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts.at(0)?.with?.["ref"], name).toBe("main");
    const fetch = steps.find(
      ({ name: stepName }) => stepName === "Fetch main history",
    );
    expect(fetch?.run, name).toContain(
      "show origin/main:scripts/verify-release-tree-proof.sh",
    );
    const ancestry = steps.find(
      ({ name: stepName }) => stepName === "Verify main ancestry",
    );
    expect(ancestry?.run, name).toContain(
      'bash "$RUNNER_TEMP/verify-release-tree-proof.sh" --allow-pr-head "$GITHUB_REPOSITORY" "$SHA" "$SHA"',
    );
  }
});

// The raw steps, with their conditions, for the release dispatch rules.
const rawValidationSteps = v.parse(
  v.array(
    v.looseObject({
      name: v.optional(v.string()),
      if: v.optional(v.string()),
      run: v.optional(v.string()),
    }),
  ),
  v.parse(
    v.object({
      jobs: v.object({
        validate: v.looseObject({ steps: v.array(v.unknown()) }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/main-heavy.yml", import.meta.url),
        "utf-8",
      ),
    ),
  ).jobs.validate.steps,
);
const rawStep = (name: string) =>
  rawValidationSteps.find((step) => step.name === name) ??
  panic(`main-heavy.yml is missing step ${name}`);

test("a version commit's push run and a release candidate dispatch PR depth for that commit", () => {
  const condition =
    rawStep("Dispatch release PR-depth checks").if ??
    panic("the PR-depth dispatch needs a condition");
  // GitHub reads an output a step did not write as an empty string.
  const none = { run: "", heavy_reused: "", depth_passed: "" };
  const decide = (context: { steps: { reuse: { outputs: object } } }) =>
    evaluate(
      condition,
      contextFromNested({
        inputs: { sha: "", release_candidate: false },
        ...context,
        steps: {
          reuse: { outputs: { ...none, ...context.steps.reuse.outputs } },
        },
      }),
    );
  const release = {
    event_name: "push",
    event: { head_commit: { message: "chore: release v0.9.63 (#6740)" } },
  };
  expect(decide({ github: release, steps: { reuse: { outputs: {} } } })).toBe(
    true,
  );
  expect(
    decide({
      github: {
        event_name: "push",
        event: { head_commit: { message: "fix(web): keep one row" } },
      },
      steps: { reuse: { outputs: {} } },
    }),
  ).toBe(false);
  const candidate = {
    github: { event_name: "workflow_dispatch", event: {} },
    inputs: { sha: "a".repeat(40), release_candidate: true },
  };
  expect(decide({ ...candidate, steps: { reuse: { outputs: {} } } })).toBe(
    true,
  );
  // A tree proof covers heavy and PR depth: nothing is dispatched again.
  expect(
    decide({ ...candidate, steps: { reuse: { outputs: { run: "false" } } } }),
  ).toBe(false);
  // A reused heavy run never stands in for PR depth that did not pass.
  const reusedHeavy = { run: "false", heavy_reused: "true" };
  expect(
    decide({ ...candidate, steps: { reuse: { outputs: reusedHeavy } } }),
  ).toBe(true);
  expect(
    decide({
      ...candidate,
      steps: { reuse: { outputs: { ...reusedHeavy, depth_passed: "true" } } },
    }),
  ).toBe(false);
});

test("a dispatch reuses a commit's passed heavy run and a push never asks", () => {
  const script =
    rawStep("Reuse completed release proof").run ??
    panic("the reuse step needs a script");
  const run = (event: string, heavy: string, depth = "none") => {
    const directory = mkdtempSync(path.join(tmpdir(), "main-heavy-reuse-"));
    try {
      const calls = path.join(directory, "calls");
      const output = path.join(directory, "output");
      writeFileSync(output, "");
      mkdirSync(path.join(directory, "scripts"));
      writeFileSync(
        path.join(directory, "scripts/gh-retry.sh"),
        `echo "$*" >> "${calls}"\necho '${heavy} ${depth}'\n`,
      );
      // No tree proof: the step falls through to running the suites.
      writeFileSync(
        path.join(directory, "scripts/verify-release-tree-proof.sh"),
        `echo verify >> "${calls}"\nexit 1\n`,
      );
      const child = Bun.spawnSync(["bash", "-euc", script], {
        cwd: directory,
        env: {
          ...process.env,
          EVENT: event,
          SHA: "b".repeat(40),
          GITHUB_REPOSITORY: "stella/stella",
          GITHUB_OUTPUT: output,
        },
      });
      return {
        exitCode: child.exitCode,
        output: readFileSync(output, "utf-8"),
        calls: readFileSync(calls, "utf-8").trim().split("\n"),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  // Heavy passed, PR depth missing or failed: heavy is reused, depth is not.
  for (const depth of ["none", "failure"]) {
    const reused = run("workflow_dispatch", "success", depth);
    expect(reused.exitCode).toBe(0);
    expect(reused.output).toBe("heavy_reused=true\nrun=false\n");
    expect(reused.calls[0]).toContain(`commits/${"b".repeat(40)}/statuses`);
    expect(reused.calls).not.toContain("verify");
  }
  expect(run("workflow_dispatch", "success", "success").output).toBe(
    "depth_passed=true\nheavy_reused=true\nrun=false\n",
  );
  // A failed or missing heavy result is tested again.
  for (const heavy of ["failure", "none"]) {
    const retried = run("workflow_dispatch", heavy, "success");
    expect(retried.output).toBe("depth_passed=true\n");
    expect(retried.calls.at(-1)).toBe("verify");
  }
  const pushed = run("push", "success");
  expect(pushed.output).toBe("");
  expect(pushed.calls).toEqual(["verify"]);
});
