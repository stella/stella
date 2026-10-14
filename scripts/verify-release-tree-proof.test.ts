import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";

const verifier = path.join(import.meta.dir, "verify-release-tree-proof.sh");
const healthGate = path.join(import.meta.dir, "check-release-main-health.sh");
const prepareTag = path.join(import.meta.dir, "prepare-release-tag.sh");
const repository = "stella/stella";

type WorkflowStepBodyOptions = {
  source: string;
  name: string;
  kind: "run" | "script";
};
const workflowStepBody = ({ source, name, kind }: WorkflowStepBodyOptions) => {
  const step = source
    .split(`      - name: ${name}\n`)
    .at(1)
    ?.split("      - name:")
    .at(0);
  const block = step?.split(`${kind}: |\n`).at(1);
  expect(block).toBeDefined();
  return (block ?? "")
    .split("\n")
    .filter((line) => /^ {10,}\S/u.test(line))
    .map((line) => line.slice(kind === "script" ? 12 : 10))
    .join("\n");
};

type WorkflowReuseOptions = {
  fixture: ReturnType<typeof createRepository>;
  workflow: string;
  sha?: string;
  historicalOwnState?: string;
};

const exerciseWorkflowReuse = async ({
  fixture,
  workflow,
  sha = fixture.target,
  historicalOwnState,
}: WorkflowReuseOptions) => {
  const source = readFileSync(
    path.join(import.meta.dir, "../.github/workflows", workflow),
    "utf-8",
  );
  const outputPath = path.join(fixture.directory, "workflow-output");
  writeFileSync(outputPath, "");
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      workflowStepBody({
        source,
        name: "Reuse completed release proof",
        kind: "run",
      }),
    ],
    {
      cwd: fixture.directory,
      env: {
        ...fixture.environment,
        SHA: sha,
        GITHUB_REPOSITORY: repository,
        GITHUB_OUTPUT: outputPath,
      },
    },
  );
  expect(result.exitCode).toBe(0);
  const output = Object.fromEntries(
    readFileSync(outputPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  const selectionOutputs: Record<string, string> = {};
  if (output.run !== "false") {
    const name =
      workflow === "main-heavy.yml"
        ? "Select untested heavy SHA"
        : "Select untested PR-depth SHA";
    const summary = {
      addRaw: (_text: string) => summary,
      write: async () => {},
    };
    await new Script(
      `(async () => { ${workflowStepBody({ source, name, kind: "script" })} })()`,
    ).runInNewContext({
      process: { env: { REUSE_RUN: output.run } },
      context: {
        eventName: "schedule",
        sha,
        repo: { owner: "stella", repo: "stella" },
      },
      github: {
        rest: {
          repos: {
            listCommitStatusesForRef: async () => ({
              data: historicalOwnState
                ? [
                    {
                      context:
                        workflow === "main-heavy.yml"
                          ? "main/heavy"
                          : "main/pr-depth",
                      state: historicalOwnState,
                      creator: { login: "github-actions[bot]" },
                    },
                  ]
                : [],
            }),
          },
        },
      },
      core: {
        summary,
        setOutput: (key: string, value: string) => {
          selectionOutputs[key] = value;
        },
      },
    });
  }
  const publishCondition =
    / {4}if: (always\(\) && needs\.validate\.result[^\n]+)\n/u
      .exec(source)
      ?.at(1);
  expect(publishCondition).toBeDefined();
  const publishes = new Script(publishCondition ?? "false").runInNewContext({
    always: () => true,
    needs: {
      validate: {
        result: "success",
        outputs: { ...output, ...selectionOutputs },
      },
    },
  });
  return { output, publishes, selectionOutputs };
};

type ReceiptOverrides = {
  checkRun?: Record<string, unknown>;
  run?: Record<string, unknown>;
  job?: Record<string, unknown>;
  // The Checks API id; the Actions job id in the run link stays 900 + index.
  checkRunId?: number;
};

const withRepository = async (
  run: (fixture: ReturnType<typeof createRepository>) => void | Promise<void>,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-tree-proof-"));
  try {
    await run(createRepository(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const createRepository = (directory: string) => {
  const responses = path.join(directory, "responses");
  mkdirSync(responses);
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "release-test@example.test",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "release-test@example.test",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    PROOF_TEST_RESPONSES: responses,
    GH_RETRY_SCRIPT: path.join(directory, "gh-retry.sh"),
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: directory,
      env: environment,
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "--quiet", "--initial-branch=main", "--template=");
  writeFileSync(path.join(directory, "VERSION"), "1.2.2\n");
  git("add", "VERSION");
  const commit = (contents: string, message: string) => {
    writeFileSync(path.join(directory, "release.txt"), contents);
    git("add", "release.txt", "VERSION");
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  const base = commit("a", "base");
  git("checkout", "--quiet", "-b", "release");
  writeFileSync(path.join(directory, "VERSION"), "1.2.3\n");
  const proof = commit("b", "release proof");
  git("checkout", "--quiet", "main");
  writeFileSync(path.join(directory, "VERSION"), "1.2.3\n");
  const target = commit("b", "squash release");
  git("update-ref", "refs/remotes/origin/main", target);
  const publishCommit = (sha: string) => {
    writeFileSync(
      path.join(responses, sha),
      JSON.stringify({
        sha,
        commit: { tree: { sha: git("rev-parse", `${sha}^{tree}`) } },
      }),
    );
  };
  for (const sha of [base, proof, target]) {
    publishCommit(sha);
  }
  const mergedPullRequest = {
    number: 1,
    title: "chore: release v1.2.3",
    state: "closed",
    merged_at: "2026-01-01T00:00:00Z",
    merge_commit_sha: target,
    head: { sha: proof, ref: "release", repo: { full_name: repository } },
    base: { sha: base, ref: "main", repo: { full_name: repository } },
  };
  const publishPullRequests = (
    sha: string,
    pullRequests: readonly object[],
  ) => {
    writeFileSync(
      path.join(responses, `${sha}-pulls`),
      JSON.stringify([pullRequests]),
    );
  };
  publishPullRequests(target, [mergedPullRequest]);
  publishPullRequests(proof, [mergedPullRequest]);
  writeFileSync(
    path.join(responses, "pull-files"),
    JSON.stringify([
      git("diff", "--name-only", base, proof)
        .split("\n")
        .map((filename) => ({ filename, status: "modified" })),
    ]),
  );
  symlinkSync(import.meta.dir, path.join(directory, "scripts"), "dir");
  writeFileSync(path.join(responses, `${target}-statuses`), "[[]]");
  const recordTestedBase = (testedBase: string) => {
    writeFileSync(
      path.join(responses, `${proof}-statuses`),
      JSON.stringify([
        [
          ...["staging/verified", "main/heavy", "main/pr-depth"].map(
            (context) => ({
              context,
              description: `Proof; main=${testedBase}`,
              creator: { login: "github-actions[bot]", type: "Bot" },
            }),
          ),
        ],
      ]),
    );
  };
  recordTestedBase(base);
  writeFileSync(
    environment.GH_RETRY_SCRIPT,
    `#!/usr/bin/env bash
set -euo pipefail
endpoint="\${!#}"
case "$endpoint" in
  repos/stella/stella/pulls/1/files?per_page=100)
    cat "$PROOF_TEST_RESPONSES/pull-files"
    ;;
  repos/stella/stella/commits/*/statuses?per_page=100)
    sha="\${endpoint#repos/stella/stella/commits/}"
    sha="\${sha%%/*}"
    cat "$PROOF_TEST_RESPONSES/$sha-statuses"
    ;;
  repos/stella/stella/commits/*/check-runs?*)
    [[ "$endpoint" == *"/check-runs?check_name=ci-result&filter=all&per_page=100" ]] || {
      echo "Unexpected check-run query: $endpoint" >&2; exit 1;
    }
    sha="\${endpoint#repos/stella/stella/commits/}"
    sha="\${sha%%/*}"
    if [[ -f "$PROOF_TEST_RESPONSES/$sha-check-runs" ]]; then
      cat "$PROOF_TEST_RESPONSES/$sha-check-runs"
    else
      printf '[{"total_count":0,"check_runs":[]}]\\n'
    fi
    ;;
  repos/stella/stella/commits/*/pulls?per_page=100)
    sha="\${endpoint#repos/stella/stella/commits/}"
    sha="\${sha%%/*}"
    cat "$PROOF_TEST_RESPONSES/$sha-pulls"
    ;;
  repos/stella/stella/commits/*)
    sha="\${endpoint##*/}"
    cat "$PROOF_TEST_RESPONSES/$sha"
    ;;
  repos/stella/stella/actions/jobs/*)
    job_id="\${endpoint##*/}"
    cat "$PROOF_TEST_RESPONSES/job-$job_id"
    ;;
  repos/stella/stella/actions/runs/*)
    run_id="\${endpoint##*/}"
    cat "$PROOF_TEST_RESPONSES/run-$run_id"
    ;;
  repos/stella/stella/compare/*)
    sha="\${endpoint#repos/stella/stella/compare/}"
    sha="\${sha%...main}"
    base=$(git merge-base "$sha" origin/main)
    printf '{"status":"ahead","merge_base_commit":{"sha":"%s"}}\\n' "$base"
    ;;
  repos/stella/stella/issues?*)
    printf '[[ ]]\\n'
    ;;
  *) echo "Unexpected API endpoint: $endpoint" >&2; exit 1 ;;
esac
`,
  );
  const verify = (
    targetSha = target,
    proofSha = proof,
    allowPullRequest = false,
  ) =>
    Bun.spawnSync(
      [
        "bash",
        verifier,
        ...(allowPullRequest ? ["--allow-pr-head"] : []),
        repository,
        targetSha,
        proofSha,
      ],
      { cwd: directory, env: environment },
    );
  const publishStatuses = (missingContext?: string) => {
    const statuses = [
      ...[
        {
          context: "staging/verified",
          workflow: "deploy-staging.yml",
          title: "Staging release proof ",
          id: 100,
        },
        {
          context: "main/heavy",
          workflow: "main-heavy.yml",
          title: "Main heavy suites ",
          id: 101,
        },
        {
          context: "main/pr-depth",
          workflow: "main-pr-depth.yml",
          title: "Main PR-depth checks ",
          id: 102,
        },
      ].map(({ context, workflow, title, id }) => {
        const url = `https://github.com/${repository}/actions/runs/${String(id)}`;
        writeFileSync(
          path.join(responses, `run-${String(id)}`),
          JSON.stringify({
            id,
            html_url: url,
            repository: { full_name: repository },
            path: `.github/workflows/${workflow}`,
            head_branch: "main",
            event: "workflow_dispatch",
            display_title: `${title}${proof}`,
            head_sha: target,
            status: "completed",
            conclusion: "success",
          }),
        );
        return {
          context,
          state: "success",
          creator: { login: "github-actions[bot]", type: "Bot" },
          target_url: url,
          description: `Proof; main=${base}`,
        };
      }),
    ];
    writeFileSync(
      path.join(responses, `${proof}-statuses`),
      JSON.stringify([
        statuses.filter(({ context }) => context !== missingContext),
      ]),
    );
  };
  const publishTargetStatus = (context: string, state: string) => {
    writeFileSync(
      path.join(responses, `${target}-statuses`),
      JSON.stringify([[{ context, state }]]),
    );
  };
  // One entry per ci-result check run on `sha`, each with its own workflow run.
  const publishReceipts = (
    sha: string,
    receipts: readonly ReceiptOverrides[] = [{}],
  ) => {
    const checkRuns = receipts.map(
      ({ checkRun = {}, run = {}, job = {}, checkRunId }, index) => {
        const runId = 500 + index;
        const jobId = 900 + index;
        const suiteId = 700 + index;
        const id = checkRunId ?? jobId;
        writeFileSync(
          path.join(responses, `job-${String(jobId)}`),
          JSON.stringify({
            id: jobId,
            run_id: runId,
            head_sha: sha,
            name: "ci-result",
            check_run_url: `https://api.github.com/repos/${repository}/check-runs/${String(id)}`,
            ...job,
          }),
        );
        writeFileSync(
          path.join(responses, `run-${String(runId)}`),
          JSON.stringify({
            id: runId,
            html_url: `https://github.com/${repository}/actions/runs/${String(runId)}`,
            repository: { full_name: repository },
            path: ".github/workflows/ci.yml",
            event: "merge_group",
            head_sha: sha,
            head_branch: `gh-readonly-queue/main/pr-1-${base}`,
            status: "completed",
            conclusion: "success",
            check_suite_id: suiteId,
            ...run,
          }),
        );
        return {
          id,
          name: "ci-result",
          head_sha: sha,
          status: "completed",
          conclusion: "success",
          app: { slug: "github-actions" },
          check_suite: { id: suiteId },
          details_url: `https://github.com/${repository}/actions/runs/${String(runId)}/job/${String(jobId)}`,
          ...checkRun,
        };
      },
    );
    writeFileSync(
      path.join(responses, `${sha}-check-runs`),
      JSON.stringify([
        { total_count: checkRuns.length, check_runs: checkRuns },
      ]),
    );
  };
  const checkReceipt = (sha = target) =>
    Bun.spawnSync(
      ["bash", verifier, "--merge-group-receipt", repository, sha],
      { cwd: directory, env: environment },
    );
  const discoverProof = () =>
    Bun.spawnSync(["bash", verifier, "--find-proof", repository, target], {
      cwd: directory,
      env: environment,
    });
  const checkHealth = (discover = false) =>
    Bun.spawnSync(
      ["bash", healthGate, repository, target, ...(discover ? [] : [proof])],
      {
        cwd: directory,
        env: environment,
      },
    );
  const prepareReleaseTag = () =>
    Bun.spawnSync(["bash", prepareTag, "--repo", repository], {
      cwd: directory,
      env: environment,
    });
  return {
    base,
    checkHealth,
    checkReceipt,
    commit,
    directory,
    discoverProof,
    environment,
    git,
    mergedPullRequest,
    prepareReleaseTag,
    proof,
    publishCommit,
    publishPullRequests,
    publishReceipts,
    publishStatuses,
    publishTargetStatus,
    responses,
    target,
    recordTestedBase,
    verify,
  };
};

describe("release proof trust boundary", () => {
  test("accepts identical trees when the same repository verifies the squash parent and PR head", async () =>
    withRepository(({ git, proof, target, verify }) => {
      expect(proof).not.toBe(target);
      const tree = git("rev-parse", `${target}^{tree}`);
      expect(git("rev-parse", `${proof}^{tree}`)).toBe(tree);
      const result = verify();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`tree=${tree}`);
      expect(result.stdout.toString()).toContain(`proof-sha=${proof}`);
    }));

  test("refuses a one-byte difference even with matching PR metadata", async () =>
    withRepository(
      ({
        base,
        commit,
        directory,
        environment,
        git,
        mergedPullRequest,
        proof,
        publishCommit,
        publishPullRequests,
        verify,
      }) => {
        git("checkout", "--quiet", "-B", "main", base);
        writeFileSync(path.join(directory, "VERSION"), "1.2.3\n");
        const changedTarget = commit("c", "changed release");
        git("update-ref", "refs/remotes/origin/main", changedTarget);
        publishCommit(changedTarget);
        publishPullRequests(changedTarget, [
          { ...mergedPullRequest, merge_commit_sha: changedTarget },
        ]);
        expect(git("rev-parse", `${changedTarget}^{tree}`)).not.toBe(
          git("rev-parse", `${proof}^{tree}`),
        );
        expect(verify(changedTarget).exitCode).not.toBe(0);
        const source = readFileSync(verifier, "utf-8");
        const mutant = source.replace(
          '[[ "$tree" == "$(git rev-parse --verify "$proof^{tree}")" ]] || refuse \'trees differ\'',
          "true",
        );
        expect(mutant).not.toBe(source);
        const unchecked = path.join(directory, "unchecked-verifier.sh");
        writeFileSync(unchecked, mutant);
        const result = Bun.spawnSync(
          ["bash", unchecked, repository, changedTarget, proof],
          {
            cwd: directory,
            env: environment,
          },
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      },
    ));

  test.each([
    "missing PR",
    "wrong base",
    "fork head",
    "fork base",
    "unmerged PR",
  ] as const)(
    "refuses identical trees with an unverified chain: %s",
    async (failure) =>
      withRepository(
        ({
          mergedPullRequest,
          proof,
          publishPullRequests,
          recordTestedBase,
          target,
          verify,
        }) => {
          const pullRequest = structuredClone(mergedPullRequest);
          switch (failure) {
            case "missing PR":
              publishPullRequests(target, []);
              break;
            case "wrong base":
              recordTestedBase(proof);
              break;
            case "fork head":
              pullRequest.head.repo.full_name = "outsider/stella";
              publishPullRequests(target, [pullRequest]);
              break;
            case "fork base":
              pullRequest.base.repo.full_name = "outsider/stella";
              publishPullRequests(target, [pullRequest]);
              break;
            case "unmerged PR":
              pullRequest.merged_at = "";
              pullRequest.state = "open";
              publishPullRequests(target, [pullRequest]);
              break;
          }
          expect(verify().exitCode).not.toBe(0);
        },
      ),
  );

  test("accepts the recorded tested base when PR metadata predates a rebase", async () =>
    withRepository(
      ({ mergedPullRequest, proof, publishPullRequests, target, verify }) => {
        publishPullRequests(target, [
          {
            ...mergedPullRequest,
            base: { ...mergedPullRequest.base, sha: proof },
          },
        ]);
        expect(verify().exitCode).toBe(0);
      },
    ));

  test("refuses a locally present proof absent from the repository API", async () =>
    withRepository(({ proof, responses, verify }) => {
      rmSync(path.join(responses, proof));
      expect(verify().exitCode).not.toBe(0);
    }));

  test("refuses a proof SHA that does not exist locally", async () =>
    withRepository(({ target, verify }) => {
      expect(verify(target, "f".repeat(40)).exitCode).not.toBe(0);
    }));

  test("refuses API metadata with a different tree even when local trees match", async () =>
    withRepository(({ proof, responses, verify }) => {
      writeFileSync(
        path.join(responses, proof),
        JSON.stringify({
          sha: proof,
          commit: { tree: { sha: "f".repeat(40) } },
        }),
      );
      expect(verify().exitCode).not.toBe(0);
    }));

  test("refuses a proof that does not descend from the claimed squash base", async () =>
    withRepository(
      ({
        commit,
        git,
        mergedPullRequest,
        publishCommit,
        publishPullRequests,
        target,
        verify,
      }) => {
        git("checkout", "--quiet", "--orphan", "unrelated");
        const unrelatedProof = commit("b", "unrelated release tree");
        publishCommit(unrelatedProof);
        publishPullRequests(target, [
          {
            ...mergedPullRequest,
            head: { ...mergedPullRequest.head, sha: unrelatedProof },
          },
        ]);
        expect(git("rev-parse", `${unrelatedProof}^{tree}`)).toBe(
          git("rev-parse", `${target}^{tree}`),
        );
        expect(verify(target, unrelatedProof).exitCode).not.toBe(0);
      },
    ));

  test("accepts the same SHA on main after repository verification", async () =>
    withRepository(({ target, verify }) => {
      expect(verify(target, target).exitCode).toBe(0);
    }));

  test("accepts an ancestor only while every intervening first-parent tree is identical", async () =>
    withRepository(({ commit, git, target, publishCommit, verify }) => {
      git("commit", "--quiet", "--allow-empty", "--message", "unchanged tree");
      const unchanged = git("rev-parse", "HEAD");
      publishCommit(unchanged);
      git("update-ref", "refs/remotes/origin/main", unchanged);
      expect(verify(unchanged, target).exitCode).toBe(0);
      commit("c", "different intervening tree");
      const reverted = commit("b", "restore release tree");
      publishCommit(reverted);
      git("update-ref", "refs/remotes/origin/main", reverted);
      expect(git("rev-parse", `${reverted}^{tree}`)).toBe(
        git("rev-parse", `${target}^{tree}`),
      );
      expect(verify(reverted, target).exitCode).not.toBe(0);
    }));

  test("accepts an open same-repository release PR only against the tested main tip", async () =>
    withRepository(
      ({
        base,
        git,
        mergedPullRequest,
        proof,
        publishPullRequests,
        target,
        verify,
      }) => {
        const openPullRequest = {
          ...mergedPullRequest,
          state: "open",
          merged_at: null,
          merge_commit_sha: null,
        };
        publishPullRequests(proof, [openPullRequest]);
        git("update-ref", "refs/remotes/origin/main", base);
        expect(verify(proof, proof, true).exitCode).toBe(0);
        expect(verify(proof, proof).exitCode).not.toBe(0);
        git("update-ref", "refs/remotes/origin/main", target);
        expect(verify(proof, proof, true).exitCode).not.toBe(0);
      },
    ));
});

describe("release health with reused proof", () => {
  test("accepts all trusted statuses from a verified tree-identical PR head", async () =>
    withRepository(({ checkHealth, publishStatuses }) => {
      publishStatuses();
      expect(checkHealth().exitCode).toBe(0);
    }));

  test("discovers and validates the merged release head when target evidence is absent", async () =>
    withRepository(({ checkHealth, discoverProof, proof, publishStatuses }) => {
      publishStatuses();
      const discovery = discoverProof();
      expect(discovery.exitCode).toBe(0);
      expect(discovery.stdout.toString().trim()).toBe(proof);
      expect(checkHealth(true).exitCode).toBe(0);
    }));

  test.each(["staging/verified", "main/heavy", "main/pr-depth"])(
    "refuses newer failure and pending target %s evidence over a green proof",
    async (context) =>
      withRepository(
        ({
          checkHealth,
          discoverProof,
          publishStatuses,
          publishTargetStatus,
          proof,
        }) => {
          publishStatuses();
          for (const state of ["failure", "pending"]) {
            publishTargetStatus(context, state);
            expect(discoverProof().stdout.toString().trim()).toBe(proof);
            const result = checkHealth();
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr.toString()).toContain(
              "target has a newer non-green status",
            );
            expect(checkHealth(true).exitCode).not.toBe(0);
          }
        },
      ),
  );

  test.each(["staging/verified", "main/heavy", "main/pr-depth"])(
    "refuses missing proof status %s despite an identical verified tree",
    async (context) =>
      withRepository(({ checkHealth, publishStatuses, verify }) => {
        expect(verify().exitCode).toBe(0);
        publishStatuses(context);
        const result = checkHealth();
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(context);
        const discoveredResult = checkHealth(true);
        expect(discoveredResult.exitCode).not.toBe(0);
        expect(discoveredResult.stderr.toString()).toContain("missing");
      }),
  );
});

describe("merge-group receipt in place of the heavy statuses", () => {
  // staging/verified is green on the release commit; main/heavy is red there
  // and main/pr-depth never ran, so only a receipt can satisfy the gate.
  const publishDirectTargetEvidence = ({
    responses,
    target,
  }: Pick<ReturnType<typeof createRepository>, "responses" | "target">) => {
    writeFileSync(
      path.join(responses, `${target}-statuses`),
      JSON.stringify([
        [
          { context: "staging/verified", state: "success" },
          { context: "main/heavy", state: "failure" },
        ],
      ]),
    );
  };

  test("accepts a merge-group ci-result on the release commit", async () =>
    withRepository((fixture) => {
      const { checkHealth, checkReceipt, discoverProof, publishReceipts } =
        fixture;
      publishDirectTargetEvidence(fixture);
      expect(checkReceipt().exitCode).not.toBe(0);
      expect(checkHealth(true).exitCode).not.toBe(0);
      publishReceipts(fixture.target);
      const receipt = checkReceipt();
      expect(receipt.exitCode, receipt.stderr.toString()).toBe(0);
      expect(receipt.stdout.toString()).toBe("");
      expect(discoverProof().stdout.toString().trim()).toBe(fixture.target);
      const health = checkHealth(true);
      expect(health.exitCode, health.stderr.toString()).toBe(0);
      expect(health.stdout.toString()).toBe("");
      const tag = fixture.prepareReleaseTag();
      expect(tag.exitCode, tag.stderr.toString()).toBe(0);
      expect(tag.stdout.toString()).toContain(`sha=${fixture.target}\n`);
      expect(tag.stdout.toString()).not.toContain("proof-sha=");
    }));

  test("still requires staging/verified next to a receipt", async () =>
    withRepository((fixture) => {
      fixture.publishReceipts(fixture.target);
      for (const state of ["failure", "pending"]) {
        fixture.publishTargetStatus("staging/verified", state);
        expect(fixture.checkReceipt().exitCode).toBe(0);
        expect(fixture.checkHealth(true).exitCode).not.toBe(0);
        const tag = fixture.prepareReleaseTag();
        expect(tag.exitCode).not.toBe(0);
      }
    }));

  test("binds the check run through its Actions job when the two ids differ", async () =>
    withRepository((fixture) => {
      publishDirectTargetEvidence(fixture);
      fixture.publishReceipts(fixture.target, [{ checkRunId: 300 }]);
      const receipt = fixture.checkReceipt();
      expect(receipt.exitCode, receipt.stderr.toString()).toBe(0);
      expect(fixture.checkHealth(true).exitCode).toBe(0);
    }));

  test("ignores ci-result runs of other events beside the merge-group receipt", async () =>
    withRepository((fixture) => {
      publishDirectTargetEvidence(fixture);
      fixture.publishReceipts(fixture.target, [
        { run: { event: "pull_request", conclusion: "failure" } },
        {},
        { run: { event: "push" }, checkRun: { conclusion: "failure" } },
      ]);
      expect(fixture.checkReceipt().exitCode).toBe(0);
      expect(fixture.checkHealth(true).exitCode).toBe(0);
    }));

  test.each<[string, readonly ReceiptOverrides[]]>([
    ["no ci-result check run", []],
    ["another app", [{ checkRun: { app: { slug: "outsider-ci" } } }]],
    ["a pull_request run", [{ run: { event: "pull_request" } }]],
    ["a push run", [{ run: { event: "push" } }]],
    ["another workflow", [{ run: { path: ".github/workflows/other.yml" } }]],
    ["a failed ci-result", [{ checkRun: { conclusion: "failure" } }]],
    ["a neutral ci-result", [{ checkRun: { conclusion: "neutral" } }]],
    ["a skipped ci-result", [{ checkRun: { conclusion: "skipped" } }]],
    ["an unfinished ci-result", [{ checkRun: { status: "in_progress" } }]],
    ["a failed merge-group run", [{ run: { conclusion: "failure" } }]],
    ["a run outside main's queue", [{ run: { head_branch: "feature" } }]],
    ["a run for another commit", [{ run: { head_sha: "f".repeat(40) } }]],
    [
      "a check run for another commit",
      [{ checkRun: { head_sha: "f".repeat(40) } }],
    ],
    ["a run of another check suite", [{ run: { check_suite_id: 1 } }]],
    [
      "a run link to another repository",
      [
        {
          checkRun: {
            details_url:
              "https://github.com/outsider/stella/actions/runs/500/job/900",
          },
        },
      ],
    ],
    [
      "a run link naming another job",
      [
        {
          checkRun: {
            details_url: `https://github.com/${repository}/actions/runs/500/job/901`,
          },
        },
      ],
    ],
    [
      "a job bound to another check run",
      [
        {
          checkRunId: 300,
          job: {
            check_run_url: `https://api.github.com/repos/${repository}/check-runs/301`,
          },
        },
      ],
    ],
    ["a job of another run", [{ job: { run_id: 501 } }]],
    ["a job for another commit", [{ job: { head_sha: "f".repeat(40) } }]],
    ["an unresolvable run link", [{ checkRun: { details_url: null } }]],
    [
      "two merge-group runs with one failing",
      [{}, { checkRun: { conclusion: "failure" } }],
    ],
    [
      "an unbound ci-result next to a green receipt",
      [{}, { checkRun: { details_url: "https://example.test/run" } }],
    ],
  ])("refuses the receipt for %s", async (_name, receipts) =>
    withRepository((fixture) => {
      publishDirectTargetEvidence(fixture);
      fixture.publishReceipts(fixture.target, receipts);
      const receipt = fixture.checkReceipt();
      expect(receipt.exitCode).not.toBe(0);
      expect(receipt.stderr.toString()).toContain(
        "MERGE_GROUP_RECEIPT_REFUSED",
      );
      expect(fixture.checkHealth(true).exitCode).not.toBe(0);
      expect(fixture.prepareReleaseTag().exitCode).not.toBe(0);
    }),
  );

  test("refuses the receipt when the check-run API is unavailable", async () =>
    withRepository((fixture) => {
      publishDirectTargetEvidence(fixture);
      writeFileSync(
        path.join(fixture.responses, `${fixture.target}-check-runs`),
        "not json",
      );
      expect(fixture.checkReceipt().exitCode).not.toBe(0);
      expect(fixture.checkHealth(true).exitCode).not.toBe(0);
    }));

  test("a receipt lets a newer red heavy status on the release commit pass, never a red staging status", async () =>
    withRepository((fixture) => {
      fixture.publishStatuses();
      fixture.publishReceipts(fixture.target);
      for (const context of ["main/heavy", "main/pr-depth"]) {
        fixture.publishTargetStatus(context, "failure");
        const health = fixture.checkHealth();
        expect(health.exitCode, health.stderr.toString()).toBe(0);
      }
      fixture.publishTargetStatus("staging/verified", "failure");
      expect(fixture.checkHealth().exitCode).not.toBe(0);
    }));

  test("a squashed release head needs only its bound staging proof when the merged commit carries a receipt", async () =>
    withRepository((fixture) => {
      fixture.publishStatuses();
      const statusesPath = path.join(
        fixture.responses,
        `${fixture.proof}-statuses`,
      );
      const [statuses] = JSON.parse(readFileSync(statusesPath, "utf-8")) as [
        { context: string }[],
      ];
      writeFileSync(
        statusesPath,
        JSON.stringify([
          statuses.filter(({ context }) => context === "staging/verified"),
        ]),
      );
      expect(fixture.verify().exitCode).not.toBe(0);
      expect(fixture.discoverProof().stdout.toString().trim()).toBe("");
      fixture.publishReceipts(fixture.target);
      const verified = fixture.verify();
      expect(verified.exitCode, verified.stderr.toString()).toBe(0);
      expect(fixture.discoverProof().stdout.toString().trim()).toBe(
        fixture.proof,
      );
      expect(fixture.checkHealth(true).exitCode).toBe(0);
      const tag = fixture.prepareReleaseTag();
      expect(tag.exitCode, tag.stderr.toString()).toBe(0);
      expect(tag.stdout.toString()).toContain(`proof-sha=${fixture.proof}\n`);
      // The staging proof keeps its binding to the squash parent.
      fixture.recordTestedBase(fixture.proof);
      expect(fixture.verify().exitCode).not.toBe(0);
    }));

  test("a receipt on the release head instead of the merged commit is not accepted", async () =>
    withRepository((fixture) => {
      publishDirectTargetEvidence(fixture);
      fixture.publishReceipts(fixture.proof);
      expect(fixture.checkReceipt().exitCode).not.toBe(0);
      expect(fixture.checkHealth(true).exitCode).not.toBe(0);
    }));
});

describe("release tag selection with reused proof", () => {
  test("selects the squash commit using the green tree-identical release head", async () =>
    withRepository(({ prepareReleaseTag, proof, publishStatuses, target }) => {
      publishStatuses();
      const result = prepareReleaseTag();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`sha=${target}\n`);
      expect(result.stdout.toString()).toContain(`proof-sha=${proof}\n`);
      expect(result.stdout.toString()).toContain("tag=v1.2.3\n");
    }));
});

describe.each(["main-heavy.yml", "main-pr-depth.yml"])(
  "%s proof reuse",
  (workflow) => {
    test("runs and publishes fresh evidence for an ordinary squash without release proof", async () =>
      withRepository(async (fixture) => {
        fixture.publishPullRequests(fixture.target, [
          { ...fixture.mergedPullRequest, title: "fix: ordinary change" },
        ]);
        writeFileSync(
          path.join(fixture.responses, `${fixture.proof}-statuses`),
          "[[]]",
        );
        const discovery = fixture.discoverProof();
        expect(discovery.exitCode).toBe(0);
        expect(discovery.stdout.toString().trim()).toBe("");
        const { output, publishes, selectionOutputs } =
          await exerciseWorkflowReuse({
            fixture,
            workflow,
          });
        expect(output.run).toBeUndefined();
        expect(selectionOutputs["run"]).toBe("true");
        expect(output.proof).toBeUndefined();
        expect(publishes).toBe(true);
      }));

    test("reuses a green release VERSION change and suppresses new publication", async () =>
      withRepository(async (fixture) => {
        fixture.publishStatuses();
        expect(fixture.git("show", `${fixture.base}:VERSION`)).toBe("1.2.2");
        expect(fixture.git("show", `${fixture.proof}:VERSION`)).toBe("1.2.3");
        const { output, publishes } = await exerciseWorkflowReuse({
          fixture,
          workflow,
        });
        expect(output.run).toBe("false");
        expect(output.proof).toBe(fixture.proof);
        expect(publishes).toBe(false);
      }));

    test("unchanged ordinary scheduled main skips its already green suite without staging evidence", async () =>
      withRepository(async (fixture) => {
        fixture.publishPullRequests(fixture.target, [
          { ...fixture.mergedPullRequest, title: "fix: ordinary change" },
        ]);
        fixture.publishTargetStatus(
          workflow === "main-heavy.yml" ? "main/heavy" : "main/pr-depth",
          "success",
        );
        const { output, selectionOutputs, publishes } =
          await exerciseWorkflowReuse({
            fixture,
            workflow,
            historicalOwnState: "success",
          });
        expect(output.run).toBeUndefined();
        expect(output.proof).toBeUndefined();
        expect(selectionOutputs["run"]).toBe("false");
        expect(publishes).toBe(false);
      }));

    test("identified direct target evidence with invalid run provenance forces fresh suites", async () =>
      withRepository(async (fixture) => {
        fixture.publishStatuses();
        writeFileSync(
          path.join(fixture.responses, `${fixture.target}-statuses`),
          readFileSync(
            path.join(fixture.responses, `${fixture.proof}-statuses`),
            "utf-8",
          ),
        );
        const discovery = fixture.discoverProof();
        expect(discovery.exitCode).toBe(0);
        expect(discovery.stdout.toString().trim()).toBe(fixture.target);
        const health = fixture.checkHealth(true);
        expect(health.exitCode).not.toBe(0);
        expect(health.stderr.toString()).toContain("run provenance");
        const { output, selectionOutputs, publishes } =
          await exerciseWorkflowReuse({ fixture, workflow });
        expect(output.run).toBe("true");
        expect(output.proof).toBeUndefined();
        expect(selectionOutputs["run"]).toBe("true");
        expect(publishes).toBe(true);
      }));

    test("a one-byte release tree mismatch forces fresh suites and refuses release gates", async () =>
      withRepository(async (fixture) => {
        fixture.publishStatuses();
        fixture.git("checkout", "--quiet", "-B", "main", fixture.base);
        writeFileSync(path.join(fixture.directory, "VERSION"), "1.2.3\n");
        const changedTarget = fixture.commit("c", "changed squash");
        fixture.git("update-ref", "refs/remotes/origin/main", changedTarget);
        fixture.publishCommit(changedTarget);
        fixture.publishPullRequests(changedTarget, [
          { ...fixture.mergedPullRequest, merge_commit_sha: changedTarget },
        ]);
        writeFileSync(
          path.join(fixture.responses, `${changedTarget}-statuses`),
          "[[]]",
        );
        const { output, publishes } = await exerciseWorkflowReuse({
          fixture,
          workflow,
          sha: changedTarget,
        });
        expect(output.run).toBe("true");
        expect(output.proof).toBeUndefined();
        expect(publishes).toBe(true);
        expect(fixture.verify(changedTarget).exitCode).not.toBe(0);
        expect(fixture.prepareReleaseTag().exitCode).not.toBe(0);
      }));

    test("an unavailable proof API forces fresh suites without emitting reusable evidence", async () =>
      withRepository(async (fixture) => {
        rmSync(path.join(fixture.responses, `${fixture.target}-statuses`));
        const { output, publishes, selectionOutputs } =
          await exerciseWorkflowReuse({
            fixture,
            workflow,
          });
        expect(output.run).toBeUndefined();
        expect(selectionOutputs["run"]).toBe("true");
        expect(output.proof).toBeUndefined();
        expect(publishes).toBe(true);
      }));
  },
);
