import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const verifier = path.join(import.meta.dir, "verify-release-tree-proof.sh");
const healthGate = path.join(import.meta.dir, "check-release-main-health.sh");
const prepareTag = path.join(import.meta.dir, "prepare-release-tag.sh");
const repository = "stella/stella";

const withRepository = (
  run: (fixture: ReturnType<typeof createRepository>) => void,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-tree-proof-"));
  try {
    run(createRepository(directory));
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
  writeFileSync(path.join(directory, "VERSION"), "1.2.3\n");
  git("add", "VERSION");
  const commit = (contents: string, message: string) => {
    writeFileSync(path.join(directory, "release.txt"), contents);
    git("add", "release.txt");
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  const base = commit("a", "base");
  git("checkout", "--quiet", "-b", "release");
  const proof = commit("b", "release proof");
  git("checkout", "--quiet", "main");
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
    title: "chore: release v1.0.0",
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
  repos/stella/stella/commits/*/statuses?per_page=100)
    sha="\${endpoint#repos/stella/stella/commits/}"
    sha="\${sha%%/*}"
    cat "$PROOF_TEST_RESPONSES/$sha-statuses"
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
    publishStatuses,
    publishTargetStatus,
    responses,
    target,
    recordTestedBase,
    verify,
  };
};

describe("release proof trust boundary", () => {
  test("accepts identical trees when the same repository verifies the squash parent and PR head", () => {
    withRepository(({ git, proof, target, verify }) => {
      expect(proof).not.toBe(target);
      const tree = git("rev-parse", `${target}^{tree}`);
      expect(git("rev-parse", `${proof}^{tree}`)).toBe(tree);
      const result = verify();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`tree=${tree}`);
      expect(result.stdout.toString()).toContain(`proof-sha=${proof}`);
    });
  });

  test("refuses a one-byte difference even with matching PR metadata", () => {
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
    );
  });

  test.each([
    "missing PR",
    "wrong base",
    "fork head",
    "fork base",
    "unmerged PR",
  ] as const)(
    "refuses identical trees with an unverified chain: %s",
    (failure) => {
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
      );
    },
  );

  test("accepts the recorded tested base when PR metadata predates a rebase", () => {
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
    );
  });

  test("refuses a locally present proof absent from the repository API", () => {
    withRepository(({ proof, responses, verify }) => {
      rmSync(path.join(responses, proof));
      expect(verify().exitCode).not.toBe(0);
    });
  });

  test("refuses a proof SHA that does not exist locally", () => {
    withRepository(({ target, verify }) => {
      expect(verify(target, "f".repeat(40)).exitCode).not.toBe(0);
    });
  });

  test("refuses API metadata with a different tree even when local trees match", () => {
    withRepository(({ proof, responses, verify }) => {
      writeFileSync(
        path.join(responses, proof),
        JSON.stringify({
          sha: proof,
          commit: { tree: { sha: "f".repeat(40) } },
        }),
      );
      expect(verify().exitCode).not.toBe(0);
    });
  });

  test("refuses a proof that does not descend from the claimed squash base", () => {
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
    );
  });

  test("accepts the same SHA on main after repository verification", () => {
    withRepository(({ target, verify }) => {
      expect(verify(target, target).exitCode).toBe(0);
    });
  });

  test("accepts an ancestor only while every intervening first-parent tree is identical", () => {
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
    });
  });

  test("accepts an open same-repository release PR only against the tested main tip", () => {
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
    );
  });
});

describe("release health with reused proof", () => {
  test("accepts all trusted statuses from a verified tree-identical PR head", () => {
    withRepository(({ checkHealth, publishStatuses }) => {
      publishStatuses();
      expect(checkHealth().exitCode).toBe(0);
    });
  });

  test("discovers and validates the merged release head when target evidence is absent", () => {
    withRepository(({ checkHealth, discoverProof, proof, publishStatuses }) => {
      publishStatuses();
      const discovery = discoverProof();
      expect(discovery.exitCode).toBe(0);
      expect(discovery.stdout.toString().trim()).toBe(proof);
      expect(checkHealth(true).exitCode).toBe(0);
    });
  });

  test.each(["staging/verified", "main/heavy", "main/pr-depth"])(
    "refuses newer failure and pending target %s evidence over a green proof",
    (context) => {
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
      );
    },
  );

  test.each(["staging/verified", "main/heavy", "main/pr-depth"])(
    "refuses missing proof status %s despite an identical verified tree",
    (context) => {
      withRepository(({ checkHealth, publishStatuses, verify }) => {
        expect(verify().exitCode).toBe(0);
        publishStatuses(context);
        const result = checkHealth();
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(context);
        const discoveredResult = checkHealth(true);
        expect(discoveredResult.exitCode).not.toBe(0);
        expect(discoveredResult.stderr.toString()).toContain(context);
      });
    },
  );
});

describe("release tag selection with reused proof", () => {
  test("selects the squash commit using the green tree-identical release head", () => {
    withRepository(({ prepareReleaseTag, proof, publishStatuses, target }) => {
      publishStatuses();
      const result = prepareReleaseTag();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`sha=${target}\n`);
      expect(result.stdout.toString()).toContain(`proof-sha=${proof}\n`);
      expect(result.stdout.toString()).toContain("tag=v1.2.3\n");
    });
  });
});
