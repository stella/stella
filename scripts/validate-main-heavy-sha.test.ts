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
import { Script } from "node:vm";
import * as v from "valibot";

import { contextFromNested, evaluate } from "./github-expression";

const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  if: v.optional(v.string()),
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
const actionStep = (name: string) => {
  const step = validationSteps.find((candidate) => candidate.name === name);
  const script = step?.with?.["script"];
  if (step?.if === undefined || typeof script !== "string") {
    panic(`main-heavy.yml is missing action step ${name}`);
  }
  return { condition: step.if, script };
};
const versionStaging = actionStep("Dispatch version commit staging");

const runActionScript = async (
  script: string,
  context: object,
  github: object,
  env: Record<string, string> = {},
) => {
  const calls: unknown[] = [];
  const api = {
    ...github,
    rest: {
      ...(github as { rest?: object }).rest,
      actions: {
        createWorkflowDispatch: async (input: unknown) => calls.push(input),
      },
    },
  };
  await new Script(`(async () => { ${script} })()`).runInNewContext({
    context,
    core: { info: () => undefined },
    github: api,
    process: { env },
  });
  return calls;
};

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
    writeFileSync(path.join(fixture, "VERSION"), "1.2.2\n");
    writeFileSync(path.join(fixture, "bun.lock"), "{}\n");
    runGit(fixture, "add", "VERSION", "bun.lock");
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
    mkdirSync(path.join(fixture, "docs/changelog"), { recursive: true });
    writeFileSync(path.join(fixture, "VERSION"), "1.2.3\n");
    writeFileSync(path.join(fixture, "docs/changelog/v1.2.3.md"), "release\n");
    runGit(fixture, "add", "VERSION", "docs/changelog/v1.2.3.md");
    runGit(fixture, "commit", "-m", "release commit");
    const releaseSha = runGit(fixture, "rev-parse", "HEAD");
    for (const script of [
      "verify-release-tree-proof.sh",
      "verify-release-candidate-tree.mjs",
    ]) {
      writeFileSync(
        path.join(fixture, script),
        readFileSync(new URL(script, import.meta.url), "utf-8"),
      );
    }
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
    "Dispatch version commit staging",
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

test("version commit staging reuses only an identical head's newest bot proof", async () => {
  expect(
    evaluate(
      versionStaging.condition,
      contextFromNested({
        github: {
          event_name: "push",
          event: { head_commit: { message: "ordinary change" } },
        },
      }),
    ),
  ).toBe(false);
  expect(
    evaluate(
      versionStaging.condition,
      contextFromNested({
        github: {
          event_name: "push",
          event: { head_commit: { message: "chore: release v1.2.3" } },
        },
      }),
    ),
  ).toBe(true);

  const versionSha = "b".repeat(40);
  const headSha = "a".repeat(40);
  const passed = {
    context: "staging/verified",
    creator: { login: "github-actions[bot]" },
    state: "success",
  };
  const dispatchFor = async (headTree: string, statuses: unknown[]) =>
    runActionScript(
      versionStaging.script,
      {
        repo: { owner: "stella", repo: "stella" },
        sha: versionSha,
      },
      {
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: async () => ({
              data: [
                {
                  head: {
                    repo: { full_name: "stella/stella" },
                    sha: headSha,
                  },
                  merge_commit_sha: versionSha,
                  merged_at: "2026-10-24T00:00:00Z",
                  title: "chore: release v1.2.3",
                },
              ],
            }),
            listCommitStatusesForRef: async () => ({ data: statuses }),
          },
          git: {
            getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
              data: {
                tree: { sha: commit_sha === headSha ? headTree : "tree" },
              },
            }),
          },
        },
      },
    );
  const reuse = await dispatchFor("tree", [passed]);
  expect(reuse).toEqual([
    {
      owner: "stella",
      repo: "stella",
      workflow_id: "deploy-staging.yml",
      ref: "main",
      inputs: { proof_sha: headSha, sha: versionSha },
    },
  ]);
  for (const full of [
    await dispatchFor("different", [passed]),
    await dispatchFor("tree", []),
    await dispatchFor("tree", [
      { ...passed, creator: { login: "human" } },
      passed,
    ]),
  ]) {
    expect(full).toEqual([
      {
        owner: "stella",
        repo: "stella",
        workflow_id: "deploy-staging.yml",
        ref: "main",
        inputs: { release_candidate: "true", sha: versionSha },
      },
    ]);
  }
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
    expect(fetch?.run, name).toContain(
      "show origin/main:scripts/verify-release-candidate-tree.mjs",
    );
    const ancestry = steps.find(
      ({ name: stepName }) => stepName === "Verify main ancestry",
    );
    expect(ancestry?.run, name).toContain(
      'bash "$RUNNER_TEMP/verify-release-tree-proof.sh" --allow-pr-head "$GITHUB_REPOSITORY" "$SHA" "$SHA"',
    );
  }
});
