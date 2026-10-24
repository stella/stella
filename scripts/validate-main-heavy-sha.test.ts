import { panic } from "better-result";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { contextFromNested, evaluate, UNKNOWN } from "./github-expression";

const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  if: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
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
    "Dispatch release candidate staging",
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

const candidateSha = "a".repeat(40);
const versionSha = "b".repeat(40);
const candidateStaging = "Dispatch release candidate staging";
const versionStaging = "Dispatch version commit staging";
const releasePull = {
  title: "chore: release v1.2.3",
  state: "closed",
  merged_at: "2026-10-24T10:00:00Z",
  merge_commit_sha: versionSha,
  head: { sha: candidateSha, repo: { full_name: "stella/stella" } },
  base: { ref: "main", repo: { full_name: "stella/stella" } },
};
const passedStaging = {
  context: "staging/verified",
  state: "success",
  creator: { login: "github-actions[bot]" },
};

type StagingDispatchOptions = {
  stepName: typeof candidateStaging | typeof versionStaging;
  eventName?: string;
  message?: string;
  releaseCandidate?: boolean;
  requestedSha?: string;
  reuseRun?: string;
  statuses?: {
    context: string;
    state: string;
    creator?: { login: string };
  }[];
  pulls?: (typeof releasePull)[];
  headTree?: string;
  versionTree?: string;
};
const runStagingDispatch = async ({
  stepName,
  eventName = "push",
  message = "chore: release v1.2.3",
  releaseCandidate = true,
  requestedSha = candidateSha,
  reuseRun = "",
  statuses = [passedStaging],
  pulls = [releasePull],
  headTree = "c".repeat(40),
  versionTree = headTree,
}: StagingDispatchOptions) => {
  const step = validationSteps.find(({ name }) => name === stepName);
  const condition = v.parse(v.string(), step?.if);
  const script = v.parse(v.string(), step?.with?.["script"]);
  const expressionContext = contextFromNested({
    github: {
      event_name: eventName,
      sha: versionSha,
      event: { head_commit: { message } },
    },
    inputs: { sha: requestedSha, release_candidate: releaseCandidate },
    steps: { reuse: { outputs: { run: reuseRun } } },
  });
  const enabled = evaluate(condition, expressionContext);
  expect(enabled).not.toBe(UNKNOWN);
  const calls: unknown[] = [];
  const reads: unknown[] = [];
  if (!enabled) {
    return { calls, reads };
  }

  const repo = { owner: "stella", repo: "stella" };
  const listStatuses = () => panic("Status history must be paginated");
  const listPulls = () => panic("Associated pull requests must be paginated");
  await new Script(`(async () => { ${script} })()`).runInNewContext({
    context: { repo, sha: versionSha },
    process: {
      env: Object.fromEntries(
        Object.entries(step?.env ?? {}).map(([key, expression]) => [
          key,
          evaluate(expression, expressionContext),
        ]),
      ),
    },
    github: {
      paginate: async (method: unknown, query: unknown) => {
        reads.push(query);
        if (method === listStatuses) {
          expect(query).toEqual({ ...repo, ref: candidateSha, per_page: 100 });
          return statuses;
        }
        expect(method).toBe(listPulls);
        expect(query).toEqual({
          ...repo,
          commit_sha: versionSha,
          per_page: 100,
        });
        return pulls;
      },
      rest: {
        repos: {
          listCommitStatusesForRef: listStatuses,
          listPullRequestsAssociatedWithCommit: listPulls,
        },
        git: {
          getCommit: async ({
            commit_sha,
            ...repository
          }: {
            commit_sha: string;
            owner: string;
            repo: string;
          }) => {
            reads.push(commit_sha);
            expect(repository).toEqual(repo);
            expect([candidateSha, versionSha]).toContain(commit_sha);
            return {
              data: {
                tree: {
                  sha: commit_sha === candidateSha ? headTree : versionTree,
                },
              },
            };
          },
        },
        actions: {
          createWorkflowDispatch: async (query: unknown) => {
            calls.push(query);
          },
        },
      },
    },
  });
  return { calls, reads };
};

const stagingDispatch = (inputs: Record<string, string>) => ({
  owner: "stella",
  repo: "stella",
  workflow_id: "deploy-staging.yml",
  ref: "main",
  inputs,
});

test("the cut starts candidate staging only for a pinned release-candidate dispatch", async () => {
  for (const eventName of ["workflow_dispatch", "schedule", "push"]) {
    const { calls, reads } = await runStagingDispatch({
      stepName: candidateStaging,
      eventName,
      message: "fix: ordinary change",
      statuses: [],
    });
    expect(calls).toEqual(
      eventName === "workflow_dispatch"
        ? [stagingDispatch({ release_candidate: "true", sha: candidateSha })]
        : [],
    );
    if (eventName !== "workflow_dispatch") {
      expect(reads).toEqual([]);
    }
  }
  for (const options of [
    { releaseCandidate: false },
    { requestedSha: "" },
    { reuseRun: "false" },
  ]) {
    expect(
      await runStagingDispatch({
        stepName: candidateStaging,
        eventName: "workflow_dispatch",
        statuses: [],
        ...options,
      }),
    ).toEqual({ calls: [], reads: [] });
  }
});

test("a version push reuses passed candidate staging only for an identical tree", async () => {
  const { calls } = await runStagingDispatch({ stepName: versionStaging });
  expect(calls).toEqual([
    stagingDispatch({ sha: versionSha, proof_sha: candidateSha }),
  ]);

  const headTree = "c".repeat(40);
  const versionTree = "d".repeat(40);
  expect(headTree).not.toBe(versionTree);
  const changed = await runStagingDispatch({
    stepName: versionStaging,
    headTree,
    versionTree,
  });
  expect(changed.calls).toEqual([
    stagingDispatch({ release_candidate: "true", sha: versionSha }),
  ]);
});

test("version staging is dispatched even when the heavy release proof was reused", async () => {
  const { calls } = await runStagingDispatch({
    stepName: versionStaging,
    reuseRun: "false",
  });
  expect(calls).toEqual([
    stagingDispatch({ sha: versionSha, proof_sha: candidateSha }),
  ]);
});

test("version staging dispatches nothing for ordinary pushes, schedules or manual runs", async () => {
  for (const options of [
    { eventName: "push", message: "fix: ordinary change" },
    { eventName: "schedule" },
    { eventName: "workflow_dispatch" },
  ]) {
    expect(
      await runStagingDispatch({ stepName: versionStaging, ...options }),
    ).toEqual({ calls: [], reads: [] });
  }
});

test("only the newest bot staging result can skip candidate staging or authorize version reuse", async () => {
  const failed = { ...passedStaging, state: "failure" };
  const human = { ...passedStaging, creator: { login: "maintainer" } };
  const unrelated = { ...passedStaging, context: "main/heavy" };
  const cases = [
    { statuses: [], passed: false },
    { statuses: [passedStaging], passed: true },
    { statuses: [failed], passed: false },
    {
      statuses: [{ ...passedStaging, state: "pending" }, passedStaging],
      passed: false,
    },
    { statuses: [failed, passedStaging], passed: false },
    { statuses: [passedStaging, failed], passed: true },
    { statuses: [human], passed: false },
    { statuses: [{ ...passedStaging, creator: undefined }], passed: false },
    { statuses: [human, failed, passedStaging], passed: false },
    { statuses: [{ ...human, state: "failure" }, passedStaging], passed: true },
    { statuses: [unrelated], passed: false },
    {
      statuses: [
        ...Array.from({ length: 100 }, () => unrelated),
        passedStaging,
      ],
      passed: true,
    },
  ];
  for (const { statuses, passed } of cases) {
    const expected = {
      [candidateStaging]: passed
        ? []
        : [stagingDispatch({ release_candidate: "true", sha: candidateSha })],
      [versionStaging]: [
        stagingDispatch(
          passed
            ? { sha: versionSha, proof_sha: candidateSha }
            : { release_candidate: "true", sha: versionSha },
        ),
      ],
    };
    for (const stepName of [candidateStaging, versionStaging] as const) {
      const { calls } = await runStagingDispatch({
        stepName,
        eventName: stepName === candidateStaging ? "workflow_dispatch" : "push",
        statuses,
      });
      expect(calls, `${stepName}: ${JSON.stringify(statuses)}`).toEqual(
        expected[stepName],
      );
    }
  }
});

test("version staging falls back when no unambiguous merged release PR binds the head to main", async () => {
  for (const pulls of [
    [],
    [{ ...releasePull, state: "open" }],
    [{ ...releasePull, merged_at: "" }],
    [{ ...releasePull, merge_commit_sha: candidateSha }],
    [{ ...releasePull, title: "fix: ordinary change" }],
    [
      {
        ...releasePull,
        head: { ...releasePull.head, repo: { full_name: "fork/stella" } },
      },
    ],
    [{ ...releasePull, base: { ...releasePull.base, ref: "other" } }],
    [releasePull, releasePull],
  ]) {
    const { calls } = await runStagingDispatch({
      stepName: versionStaging,
      pulls,
    });
    expect(calls).toEqual([
      stagingDispatch({ release_candidate: "true", sha: versionSha }),
    ]);
  }
  const { calls } = await runStagingDispatch({
    stepName: versionStaging,
    pulls: [{ ...releasePull, merge_commit_sha: candidateSha }, releasePull],
  });
  expect(calls).toEqual([
    stagingDispatch({ sha: versionSha, proof_sha: candidateSha }),
  ]);
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
