import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repository = "stella/stella";
const version = "1.2.4";
const releaseTag = `v${version}`;
const rcTag = `${releaseTag}-rc.1`;
const scriptPath = (name: string) => new URL(name, import.meta.url).pathname;

type SelectOptions = {
  requestedSha?: string;
  recordedHead?: string;
  state?: "open" | "closed";
  headRepository?: string;
};

const createFixture = (root: string) => {
  const realGit = Bun.which("git");
  if (realGit === null) {
    throw new Error("Git is required for release selection fixtures");
  }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync([realGit, ...args], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const receipt = (name: string) =>
    existsSync(path.join(root, name))
      ? readFileSync(path.join(root, name), "utf-8")
      : "";
  git("init", "-q", "--initial-branch=main", "--template=");
  git("config", "user.name", "Release selection fixture");
  git("config", "user.email", "release@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
  writeFileSync(path.join(root, "bun.lock"), "{}\n");
  git("add", ".");
  git("commit", "-qm", "main base");
  const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  git("switch", "-qc", `release/${releaseTag}`);
  mkdirSync(path.join(root, "docs/changelog"), { recursive: true });
  writeFileSync(path.join(root, "VERSION"), `${version}\n`);
  writeFileSync(
    path.join(root, `docs/changelog/${releaseTag}.md`),
    "# Maintenance release\n",
  );
  git("add", ".");
  git("commit", "-qm", `chore: release ${releaseTag}`);
  const sha = git("rev-parse", "HEAD");
  expect(sha).not.toBe(main);
  writeFileSync(path.join(root, "statuses.json"), "[[]]");
  writeFileSync(path.join(root, "draft"), "true");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == push ]]; then
  printf '%s\\n' "$*" >> "$TEST_ROOT/pushes"
  exit 0
fi
exec "$REAL_GIT" "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(root, "gh.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_ROOT/$PHASE-requests"
# Selection must not require evidence that the RC build has not produced yet.
if [[ "$PHASE" == selection ]]; then
  case "$*" in
    *statuses?*|*check-runs?*|*actions/runs/*|*issues?*) echo "Selection requested proof evidence: $*" >&2; exit 1 ;;
  esac
fi
case "$*" in
  *pulls?*) cat "$TEST_ROOT/pulls.json" ;;
  *statuses?*) cat "$TEST_ROOT/statuses.json" ;;
  *actions/runs/*) endpoint="\u0024{!#}"; cat "$TEST_ROOT/run-\u0024{endpoint##*/}.json" ;;
  *issues?*) printf '[[]]\\n' ;;
  *commits/*)
    endpoint="\u0024{!#}"
    commit="\u0024{endpoint##*/}"
    tree=$("$REAL_GIT" rev-parse "$commit^{tree}")
    jq -nc --arg sha "$commit" --arg tree "$tree" '{sha:$sha,commit:{tree:{sha:$tree}}}'
    ;;
  'release view '*) cat "$TEST_ROOT/draft" ;;
  'release edit '*) printf '%s\\n' "$*" >> "$TEST_ROOT/publications"; printf false > "$TEST_ROOT/draft" ;;
  *) echo "Unexpected release API request: $*" >&2; exit 1 ;;
esac
`,
  );
  type RunOptions = {
    script: "prepare-release-tag.sh" | "finalize-release.sh";
    requestedSha: string;
    phase: "selection" | "finalization";
  };
  const run = ({ script, requestedSha, phase }: RunOptions) =>
    Bun.spawnSync(
      [
        "bash",
        scriptPath(script),
        ...(script === "prepare-release-tag.sh"
          ? ["--repo", repository, "--sha", requestedSha]
          : [repository, requestedSha]),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GH_TOKEN: "fixture-write-token",
          RELEASE_HEALTH_TOKEN: "fixture-read-token",
          GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
          RELEASE_TREE_PROOF_VERIFIER: scriptPath(
            "verify-release-tree-proof.sh",
          ),
          RELEASE_CANDIDATE_TREE_VERIFIER: scriptPath(
            "verify-release-candidate-tree.mjs",
          ),
          TEST_ROOT: root,
          REAL_GIT: realGit,
          PHASE: phase,
          PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        },
      },
    );
  const select = (options: SelectOptions = {}) => {
    writeFileSync(
      path.join(root, "pulls.json"),
      JSON.stringify([
        [
          {
            number: 1,
            state: options.state ?? "open",
            draft: false,
            merged_at: null,
            title: `chore: release ${releaseTag}`,
            head: {
              sha: options.recordedHead ?? sha,
              ref: `release/${releaseTag}`,
              repo: { full_name: options.headRepository ?? repository },
            },
            base: { ref: "main", sha: main, repo: { full_name: repository } },
          },
        ],
      ]),
    );
    return run({
      script: "prepare-release-tag.sh",
      requestedSha: options.requestedSha ?? sha,
      phase: "selection",
    });
  };
  const publishEvidence = (proofSha = sha) => {
    const contexts = [
      {
        context: "staging/verified",
        workflow: "deploy-staging.yml",
        title: "Staging release proof ",
      },
      {
        context: "main/heavy",
        workflow: "main-heavy.yml",
        title: "Main heavy suites ",
      },
      {
        context: "main/pr-depth",
        workflow: "main-pr-depth.yml",
        title: "Main PR-depth checks ",
      },
    ];
    const statuses = contexts.map(({ context, workflow, title }, index) => {
      const id = index + 1;
      const htmlUrl = `https://github.com/${repository}/actions/runs/${id}`;
      writeFileSync(
        path.join(root, `run-${id}.json`),
        JSON.stringify({
          id,
          html_url: htmlUrl,
          repository: { full_name: repository },
          head_repository: { full_name: repository },
          head_sha: main,
          path: `.github/workflows/${workflow}`,
          head_branch: "main",
          event: "workflow_dispatch",
          display_title: `${title}${proofSha}`,
          status: "completed",
          conclusion: "success",
        }),
      );
      return {
        context,
        state: "success",
        creator: { login: "github-actions[bot]", type: "Bot" },
        target_url: htmlUrl,
      };
    });
    writeFileSync(path.join(root, "statuses.json"), JSON.stringify([statuses]));
  };
  return {
    sha,
    main,
    git,
    receipt,
    select,
    publishEvidence,
    finalize: () =>
      run({
        script: "finalize-release.sh",
        requestedSha: sha,
        phase: "finalization",
      }),
  };
};

const withFixture = (
  check: (fixture: ReturnType<typeof createFixture>) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-rc-selection-"));
  try {
    check(createFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("an unproved open release head selects an RC; only green exact-SHA proof finalizes it", () =>
  withFixture((fixture) => {
    const selected = fixture.select();
    expect(selected.exitCode, selected.stderr.toString()).toBe(0);
    expect(selected.stdout.toString()).toBe(
      `sha=${fixture.sha}\nvalue=${version}\ntag=${rcTag}\nexisting=false\n`,
    );
    const selectionRequests = fixture.receipt("selection-requests");
    expect(selectionRequests).toContain(`/commits/${fixture.sha}`);
    expect(selectionRequests).toContain(`/commits/${fixture.sha}/pulls?`);
    expect(selectionRequests).not.toMatch(
      /statuses\?|check-runs\?|actions\/runs\/|issues\?/u,
    );
    expect(fixture.git("tag", "--list")).toBe("");
    fixture.git("tag", "-a", rcTag, fixture.sha, "-m", rcTag);

    const missingProof = fixture.finalize();
    expect(missingProof.exitCode).toBe(1);
    expect(missingProof.stderr.toString()).toContain(
      "staging/verified = missing",
    );
    expect(fixture.git("tag", "--list", releaseTag)).toBe("");
    expect(fixture.receipt("pushes")).toBe("");
    expect(fixture.receipt("publications")).toBe("");
    expect(fixture.receipt("draft")).toBe("true");

    fixture.publishEvidence();
    const finalized = fixture.finalize();
    expect(finalized.exitCode, finalized.stderr.toString()).toBe(0);
    expect(fixture.git("rev-parse", `${releaseTag}^{commit}`)).toBe(
      fixture.sha,
    );
    expect(fixture.git("rev-parse", `${rcTag}^{commit}`)).toBe(fixture.sha);
    expect(fixture.receipt("pushes")).toContain(`refs/tags/${releaseTag}`);
    expect(fixture.receipt("publications")).toContain(`release edit ${rcTag}`);
    expect(fixture.receipt("draft")).toBe("false");
  }));

test("the same release head reuses its RC without reading proof evidence", () =>
  withFixture((fixture) => {
    fixture.git("tag", "-a", rcTag, fixture.sha, "-m", rcTag);
    const selected = fixture.select();
    expect(selected.exitCode, selected.stderr.toString()).toBe(0);
    expect(selected.stdout.toString()).toBe(
      `sha=${fixture.sha}\nvalue=${version}\ntag=${rcTag}\nexisting=true\n`,
    );
    expect(fixture.receipt("selection-requests")).not.toMatch(
      /statuses\?|check-runs\?|actions\/runs\/|issues\?/u,
    );
  }));

for (const [name, options] of [
  ["stale recorded PR head", { recordedHead: "f".repeat(40) }],
  ["a commit that is only on main", { requestedSha: "main" }],
  ["a closed release PR", { state: "closed" }],
  ["a fork release PR", { headRepository: "contributor/stella" }],
] as const) {
  test(`${name} cannot select an RC`, () =>
    withFixture((fixture) => {
      const selected = fixture.select({
        ...options,
        ...("requestedSha" in options ? { requestedSha: fixture.main } : {}),
      });
      expect(selected.exitCode).toBe(1);
      expect(selected.stderr.toString()).toContain(
        "release PR head relation is unverified",
      );
      expect(selected.stdout.toString()).toBe("");
      expect(fixture.git("tag", "--list")).toBe("");
      expect(fixture.receipt("pushes")).toBe("");
    }));
}

test("an existing final tag prevents selecting another RC", () =>
  withFixture((fixture) => {
    fixture.git("tag", releaseTag, fixture.sha);
    const selected = fixture.select();
    expect(selected.exitCode).toBe(1);
    expect(selected.stderr.toString()).toContain(
      `Release tag ${releaseTag} already exists`,
    );
    expect(fixture.git("tag", "--list", `${releaseTag}-rc.*`)).toBe("");
  }));

test("green workflow receipts for another SHA cannot finalize the selected RC", () =>
  withFixture((fixture) => {
    const selected = fixture.select();
    expect(selected.exitCode, selected.stderr.toString()).toBe(0);
    fixture.git("tag", rcTag, fixture.sha);
    fixture.publishEvidence(fixture.main);
    const finalized = fixture.finalize();
    expect(finalized.exitCode).toBe(1);
    expect(finalized.stderr.toString()).toContain(
      "run provenance or conclusion does not match",
    );
    expect(fixture.git("tag", "--list", releaseTag)).toBe("");
    expect(fixture.receipt("pushes")).toBe("");
    expect(fixture.receipt("publications")).toBe("");
  }));

for (const flag of ["--candidate-only", "--proof-sha"]) {
  test(`RC identity selection exposes no legacy evidence mode ${flag}`, () => {
    const selected = Bun.spawnSync([
      "bash",
      scriptPath("prepare-release-tag.sh"),
      "--repo",
      repository,
      "--sha",
      "a".repeat(40),
      flag,
    ]);
    expect(selected.exitCode).toBe(2);
    expect(selected.stderr.toString()).toContain(`Unknown argument: ${flag}`);
    expect(selected.stdout.toString()).toBe("");
  });
}
