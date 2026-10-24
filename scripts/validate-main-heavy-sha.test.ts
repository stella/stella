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
    // Reads statuses only, through trusted main tooling.
    "Reuse this commit's passed heavy run",
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

// The raw workflow, with conditions and job outputs, for the release rules.
const rawWorkflow = v.parse(
  v.object({
    jobs: v.object({
      validate: v.looseObject({
        outputs: v.record(v.string(), v.string()),
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/main-heavy.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const rawStep = (name: string) =>
  rawWorkflow.jobs.validate.steps.find((step) => step.name === name) ??
  panic(`main-heavy.yml is missing step ${name}`);

type ReleaseContext = {
  github: object;
  inputs?: object;
  reuse?: object;
  commitHeavy?: object;
};
// GitHub reads an output a step did not write as an empty string.
const releaseContext = ({
  github,
  inputs = {},
  reuse = {},
  commitHeavy = {},
}: ReleaseContext) =>
  contextFromNested({
    github,
    inputs: { sha: "", release_candidate: false, ...inputs },
    steps: {
      reuse: { outputs: { run: "", proof: "", ...reuse } },
      "commit-heavy": {
        outputs: { heavy_passed: "", depth_passed: "", ...commitHeavy },
      },
      selection: { outputs: { run: "true" } },
    },
  });
const releasePush = {
  github: {
    event_name: "push",
    event: { head_commit: { message: "chore: release v0.9.63 (#6740)" } },
  },
};
const candidate = {
  github: { event_name: "workflow_dispatch", event: {} },
  inputs: { sha: "a".repeat(40), release_candidate: true },
};

test("a version commit's push run and a release candidate dispatch PR depth unless it passed", () => {
  const condition =
    rawStep("Dispatch release PR-depth checks").if ??
    panic("the PR-depth dispatch needs a condition");
  const decide = (context: ReleaseContext) =>
    evaluate(condition, releaseContext(context));
  expect(decide(releasePush)).toBe(true);
  expect(
    decide({
      github: {
        event_name: "push",
        event: { head_commit: { message: "fix(web): keep one row" } },
      },
    }),
  ).toBe(false);
  expect(decide(candidate)).toBe(true);
  // A passed heavy run never stands in for PR depth that did not pass.
  expect(decide({ ...candidate, commitHeavy: { heavy_passed: "true" } })).toBe(
    true,
  );
  expect(
    decide({
      ...candidate,
      commitHeavy: { heavy_passed: "true", depth_passed: "true" },
    }),
  ).toBe(false);
  // A tree proof covers heavy and PR depth: nothing is dispatched again.
  expect(decide({ ...candidate, reuse: { run: "false" } })).toBe(false);
});

test("a passed heavy run of the commit skips the suites", () => {
  const output =
    rawWorkflow.jobs.validate.outputs["run"] ??
    panic("validate needs a run output");
  expect(
    evaluate(
      output,
      releaseContext({ ...candidate, commitHeavy: { heavy_passed: "true" } }),
    ),
  ).toBe("false");
  expect(evaluate(output, releaseContext(candidate))).toBe("true");
  expect(
    evaluate(output, releaseContext({ ...candidate, reuse: { run: "false" } })),
  ).toBe("false");
});

test("the commit's heavy and PR-depth results come from the workflow's own statuses", () => {
  const script =
    rawStep("Reuse this commit's passed heavy run").run ??
    panic("the commit reuse step needs a script");
  const outputsFor = (statuses: object[]) => {
    const directory = mkdtempSync(path.join(tmpdir(), "main-heavy-commit-"));
    try {
      const output = path.join(directory, "output");
      const fixture = path.join(directory, "statuses.json");
      writeFileSync(output, "");
      writeFileSync(fixture, JSON.stringify(statuses));
      mkdirSync(path.join(directory, "scripts"));
      // Answers like gh: the --jq filter runs over the status list.
      writeFileSync(
        path.join(directory, "scripts/gh-retry.sh"),
        `filter=""
while (($# > 0)); do
  case "$1" in
    --jq) filter=$2; shift 2 ;;
    *) shift ;;
  esac
done
jq -r "$filter" "${fixture}"
`,
      );
      const child = Bun.spawnSync(["bash", "-euc", script], {
        cwd: directory,
        env: {
          ...process.env,
          SHA: "b".repeat(40),
          GITHUB_REPOSITORY: "stella/stella",
          GITHUB_OUTPUT: output,
        },
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      return readFileSync(output, "utf-8");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const own = (context: string, state: string) => ({
    context,
    state,
    creator: { login: "github-actions[bot]" },
  });
  expect(outputsFor([own("main/heavy", "success")])).toBe(
    "heavy_passed=true\ndepth_passed=false\n",
  );
  expect(
    outputsFor([own("main/heavy", "success"), own("main/pr-depth", "success")]),
  ).toBe("heavy_passed=true\ndepth_passed=true\n");
  // The newest status decides, and only the workflow's own statuses count.
  expect(
    outputsFor([
      own("main/heavy", "failure"),
      own("main/heavy", "success"),
      { ...own("main/pr-depth", "success"), creator: { login: "someone" } },
    ]),
  ).toBe("heavy_passed=false\ndepth_passed=false\n");
  expect(outputsFor([])).toBe("heavy_passed=false\ndepth_passed=false\n");
});
