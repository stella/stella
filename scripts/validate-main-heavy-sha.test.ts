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
const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    maxBuffer: 2 ** 30,
    cwd,
    encoding: "utf-8",
  }).trim();

const runStep = (
  script: string,
  sha: string,
  cwd: string,
  outputPath: string,
) =>
  Bun.spawnSync(
    ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      cwd,
      env: {
        ...process.env,
        SHA: sha,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "stella/stella",
        RUNNER_TEMP: cwd,
        GH_RETRY_SCRIPT: path.join(cwd, "gh-retry.sh"),
      },
    },
  );

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
    const pullRequestFile = path.join(fixture, "pull-request.json");
    const releasePullRequest = {
      number: 1,
      title: "chore: release v1.2.3",
      state: "open",
      draft: false,
      merged_at: null,
      head: { sha: releaseSha, repo: { full_name: "stella/stella" } },
      base: { sha: mainSha, ref: "main", repo: { full_name: "stella/stella" } },
    };
    writeFileSync(pullRequestFile, JSON.stringify([[releasePullRequest]]));
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
      cat "$RUNNER_TEMP/pull-request.json"
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
    expect(readFileSync(outputPath, "utf-8")).toContain("relation=pr-head");

    for (const invalidPullRequest of [
      {
        ...releasePullRequest,
        state: "closed",
        merged_at: "2026-10-24T00:00:00Z",
      },
      {
        ...releasePullRequest,
        head: { ...releasePullRequest.head, sha: mainSha },
      },
    ]) {
      writeFileSync(pullRequestFile, JSON.stringify([[invalidPullRequest]]));
      writeFileSync(outputPath, "");
      const rejected = runStep(verifyAncestry, releaseSha, fixture, outputPath);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.toString()).toContain(
        "release PR head relation is unverified",
      );
      expect(readFileSync(outputPath, "utf-8")).toBe("");
    }
    writeFileSync(pullRequestFile, JSON.stringify([[releasePullRequest]]));
    const depthAncestry =
      readWorkflow("main-pr-depth").jobs.validate.steps?.find(
        ({ name }) => name === "Verify main ancestry",
      )?.run ?? panic("main-pr-depth.yml is missing its trusted ancestry step");
    for (const sha of [mainSha, releaseSha]) {
      const result = runStep(depthAncestry, sha, fixture, outputPath);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }

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

// Checkouts other than the network retry helper, which is pinned to the
// workflow's own revision and holds only scripts/retry.sh.
const trustedCheckouts = (
  steps: readonly {
    readonly uses?: string | undefined;
    readonly with?: Record<string, unknown> | undefined;
  }[],
) =>
  steps.filter((step) => {
    if (!step.uses?.startsWith("actions/checkout@")) {
      return false;
    }
    if (step.with?.["path"] !== ".network-retry") {
      return true;
    }
    expect(step.with["ref"]).toBe(`\${{ github.workflow_sha }}`);
    expect(step.with["sparse-checkout"]).toBe("scripts/retry.sh");
    expect(step.with["persist-credentials"]).toBe(false);
    return false;
  });

test("only trusted main tooling is checked out before target verification", () => {
  const names = validationSteps.map(({ name }) => name);
  expect(names).toEqual([
    "Checkout network retry helper",
    "Stage network retry helper",
    "Check release candidate",
    "Validate merge queue depth",
    "Checkout trusted release proof tooling",
    // Uncached runtime for the release queue history check; no target code.
    "Setup Bun",
    "Reuse completed release proof",
    "Select untested heavy SHA",
    "Validate SHA format",
    "Fetch main history",
    "Verify main ancestry",
  ]);
  const checkouts = trustedCheckouts(validationSteps);
  expect(checkouts).toHaveLength(1);
  expect(checkouts.at(0)?.with?.["ref"]).toBe("main");
  expect(checkouts.at(0)?.with?.["path"]).toBe(".release-proof");
  expect(checkouts.at(0)?.with?.["persist-credentials"]).toBe(false);
});

test("main validation does not dispatch release proofs owned by the RC artifact run", () => {
  const source = readFileSync(
    new URL("../.github/workflows/main-heavy.yml", import.meta.url),
    "utf-8",
  );
  expect(source).not.toContain("createWorkflowDispatch");
  expect(source).not.toContain("Dispatch version commit staging");
  expect(source).not.toContain("Dispatch release PR-depth checks");
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
    const checkouts = trustedCheckouts(steps);
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
      '"$RUNNER_TEMP/verify-release-tree-proof.sh"',
    );
    expect(ancestry?.run, name).toContain('"$GITHUB_REPOSITORY" "$SHA" "$SHA"');
  }
});
