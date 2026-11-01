import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHECK = path.join(import.meta.dir, "check-release-source-on-main.sh");
const BRANCH = path.join(import.meta.dir, "release-branch.sh");
const REPOSITORY = "stella/stella";
const RECORDED: unknown = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dir,
      "fixtures/release-source-on-main/commit-8464c9e6-pulls.json",
    ),
    "utf-8",
  ),
);

type Pull = {
  number: number;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
};

const isPull = (value: unknown): value is Pull =>
  typeof value === "object" && value !== null && "head" in value;

let work = "";
let repo = "";
const commits = { onMain: "", releaseHead: "", squash: "", offMain: "" };

const git = (...args: string[]): string => {
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    },
  );
  expect(result.stderr.toString(), `git ${args.join(" ")}`).not.toContain(
    "fatal:",
  );
  expect(result.success).toBeTrue();
  return result.stdout.toString().trim();
};

const commit = (file: string, message: string): string => {
  writeFileSync(path.join(repo, file), message);
  git("add", file);
  git("commit", "--quiet", "--no-gpg-sign", "-m", message);
  return git("rev-parse", "HEAD");
};

// main: base -> squash of the release branch. The release branch head and
// an unrelated commit stay off main, as after a squash merge.
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "stella-release-source-"));
  repo = path.join(work, "repo");
  Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", repo]);
  commits.onMain = commit("VERSION", "base");
  git("switch", "--quiet", "-c", "release/v0.9.72");
  commits.releaseHead = commit("VERSION", "chore: release v0.9.72");
  git("switch", "--quiet", "main");
  commits.squash = commit("CHANGELOG", "chore: release v0.9.72 (#7578)");
  git("switch", "--quiet", "-c", "elsewhere", commits.onMain);
  commits.offMain = commit("OTHER", "unrelated");
  git("update-ref", "refs/remotes/origin/main", commits.squash);
  writeFileSync(
    path.join(work, "gh-retry.sh"),
    `if [ -n "\${API_FAIL:-}" ]; then echo 'HTTP 502' >&2; exit 1; fi
case "$*" in
  "api repos/${REPOSITORY}/commits/\${EXPECTED_SHA}/pulls") printf '%s' "$PULLS" ;;
  *) echo "unexpected call: $*" >&2; exit 1 ;;
esac
`,
  );
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

// The recorded v0.9.72 response, re-pointed at the fixture's release-branch
// commit and squash commit.
const recorded = (): Pull[] =>
  (Array.isArray(RECORDED) ? RECORDED : []).filter(isPull).map((pull) => ({
    ...pull,
    merge_commit_sha: commits.squash,
    head: { ...pull.head, sha: commits.releaseHead },
  }));

type CheckOptions = {
  sha?: string;
  releaseRef?: string;
  pulls?: unknown;
  apiFails?: boolean;
};

const check = ({
  sha = commits.releaseHead,
  releaseRef = "v0.9.72",
  pulls = recorded(),
  apiFails = false,
}: CheckOptions = {}) => {
  const result = Bun.spawnSync(
    ["bash", CHECK, sha, ...(releaseRef === "" ? [] : [releaseRef])],
    {
      cwd: repo,
      env: {
        ...process.env,
        GH_RETRY_SCRIPT: path.join(work, "gh-retry.sh"),
        GITHUB_REPOSITORY: REPOSITORY,
        EXPECTED_SHA: sha,
        PULLS: JSON.stringify(pulls),
        ...(apiFails ? { API_FAIL: "1" } : {}),
      },
    },
  );
  return { code: result.exitCode, stderr: result.stderr.toString() };
};

const withPull = (change: (pull: Pull) => Pull): Pull[] =>
  recorded().map(change);

describe("release source on protected main", () => {
  test("the recorded fixture is the squash-merged v0.9.72 release", () => {
    const [pull] = Array.isArray(RECORDED) ? RECORDED.filter(isPull) : [];
    expect(pull?.number).toBe(7578);
    expect(pull?.head.ref).toBe("release/v0.9.72");
    expect(pull?.head.sha).toBe("8464c9e631150b801530dc854a7155d209f66e33");
    expect(pull?.merge_commit_sha).toBe(
      "34036ec80f5ca121ee0bb000462df0b0afb3a070",
    );
  });

  test("accepts a commit on main without a release ref", () => {
    expect(check({ sha: commits.onMain, releaseRef: "" }).code).toBe(0);
  });

  test("accepts the head of the merged release pull request", () => {
    expect(check().code).toBe(0);
  });

  test("refuses a commit off main without a release ref", () => {
    expect(check({ releaseRef: "" }).code).toBe(1);
  });

  test("refuses a merged pull request from a branch other than the release branch", () => {
    const feature = withPull((pull) => ({
      ...pull,
      head: { ...pull.head, ref: "feature/example" },
    }));
    expect(check({ pulls: feature }).code).toBe(1);
    expect(check({ releaseRef: "v0.9.73" }).code).toBe(1);
  });

  test("refuses an open pull request", () => {
    const open = withPull((pull) => ({
      ...pull,
      state: "open",
      merged_at: null,
    }));
    expect(check({ pulls: open }).code).toBe(1);
  });

  test("refuses a closed pull request that was not merged", () => {
    const closed = withPull((pull) => ({ ...pull, merged_at: null }));
    expect(check({ pulls: closed }).code).toBe(1);
  });

  test("refuses a pull request into another base", () => {
    const base = withPull((pull) => ({
      ...pull,
      base: { ...pull.base, ref: "next" },
    }));
    expect(check({ pulls: base }).code).toBe(1);
  });

  test("refuses two pull requests", () => {
    expect(check({ pulls: [...recorded(), ...recorded()] }).code).toBe(1);
  });

  test("refuses a merge commit that is not on main", () => {
    const merged = withPull((pull) => ({
      ...pull,
      merge_commit_sha: commits.offMain,
    }));
    expect(check({ pulls: merged }).code).toBe(1);
  });

  test("refuses when the API read fails", () => {
    const result = check({ apiFails: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not list the pull requests");
  });
});

describe("release branch name", () => {
  test("names the branch for a stable version only", () => {
    const name = (version: string) =>
      Bun.spawnSync(["bash", BRANCH, version]).stdout.toString().trim();
    expect(name("0.9.72")).toBe("release/v0.9.72");
    expect(Bun.spawnSync(["bash", BRANCH, "0.9.72-rc.1"]).exitCode).toBe(1);
  });

  test("the release cut creates the branch through the shared name", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "prepare-maintenance-release.ts"),
      "utf-8",
    );
    expect(source).toContain('"scripts/release-branch.sh"');
    expect(source).not.toMatch(/`release\/v\$\{/u);
  });

  test("both publication paths run the shared check", () => {
    const workflow = readFileSync(
      path.join(import.meta.dir, "../.github/workflows/publish-npm.yml"),
      "utf-8",
    );
    expect(workflow).toContain(
      'bash "$RUNNER_TEMP/check-release-source-on-main.sh" "$release_sha" "$release_ref"',
    );
    expect(workflow).toContain(
      'bash "$GITHUB_WORKSPACE/.pack-tooling/scripts/check-release-source-on-main.sh" "$source_sha"',
    );
    expect(workflow).not.toContain("merge-base --is-ancestor");
  });
});
