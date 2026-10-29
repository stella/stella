import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The receipt coverage check, run against a real repository: the queue
// history it requires starts at the newest earlier commit whose main/heavy
// and main/pr-depth both passed, else at the previous release tag.

const SCRIPT = path.resolve(
  import.meta.dir,
  "check-release-receipt-coverage.sh",
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Hooks export repository selectors such as GIT_DIR, and a developer's own
// configuration may sign or annotate tags; the fixture inherits neither.
const GIT_ENV: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !entry[0].startsWith("GIT_"),
    ),
  ),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

type Statuses = Record<
  string,
  { context: string; state: string; creator?: string }[]
>;

// Release history: v1.0.0, then three main commits, then the version commit.
const fixture = (
  statusesFor: (commits: string[]) => Statuses,
  history = true,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "receipt-coverage-"));
  directories.push(root);
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: GIT_ENV,
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  const commit = (message: string) => {
    git("commit", "--quiet", "--allow-empty", "--no-verify", "-m", message);
    return git("rev-parse", "HEAD");
  };
  commit("previous release");
  git("tag", "v1.0.0");
  const main = ["first", "second", "third"].map(commit);
  const release = commit("chore: release v1.1.0");
  const statuses = statusesFor(main);
  writeFileSync(path.join(root, "statuses.json"), JSON.stringify(statuses));
  // Answers the statuses API like gh with --jq; logs every request.
  writeFileSync(
    path.join(root, "gh-retry.sh"),
    `endpoint=""; filter=""
while (($# > 0)); do
  case "$1" in
    --jq) filter=$2; shift 2 ;;
    api) shift ;;
    *) endpoint=$1; shift ;;
  esac
done
echo "$endpoint" >> "${root}/requests"
sha=$(sed -E 's#.*/commits/([0-9a-f]+)/statuses.*#\\1#' <<< "$endpoint")
jq --arg sha "$sha" '[(.[$sha] // [])[] | {context, state, creator: {login: (.creator // "github-actions[bot]")}}]' "${root}/statuses.json" | jq -r "$filter"
`,
  );
  writeFileSync(path.join(root, "verify.sh"), "exit 0\n");
  // Records the history range the coverage check asks for.
  writeFileSync(
    path.join(bin, "bun"),
    `#!/usr/bin/env bash\necho "$*" > "${root}/history"\nexit ${history ? 0 : 1}\n`,
  );
  chmodSync(path.join(bin, "bun"), 0o755);
  const result = Bun.spawnSync(["bash", SCRIPT, "stella/stella", release], {
    cwd: repo,
    env: {
      ...GIT_ENV,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      GH_RETRY_SCRIPT: path.join(root, "gh-retry.sh"),
      RELEASE_TREE_PROOF_VERIFIER: path.join(root, "verify.sh"),
    },
    stderr: "pipe",
  });
  const from = /--from (\S+)/u.exec(
    readFileSync(path.join(root, "history"), "utf-8"),
  )?.[1];
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    from,
    main,
  };
};

// Each case builds a repository and runs the real script.
const CASE_TIMEOUT_MS = 30_000;

const passed = (context: string) => ({ context, state: "success" });

test(
  "the history starts at the newest earlier commit with both full gates green",
  () => {
    const run = fixture(([first, second]) => ({
      [first ?? ""]: [passed("main/heavy"), passed("main/pr-depth")],
      [second ?? ""]: [passed("main/heavy"), passed("main/pr-depth")],
    }));
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.from).toBe(run.main[1]);
    expect(run.stderr).toContain(
      `validated queue history since ${run.main[1] ?? "missing"}`,
    );
  },
  CASE_TIMEOUT_MS,
);

test(
  "without a fully proven earlier commit the history starts at the previous tag",
  () => {
    for (const statuses of [
      // Heavy alone is not a full proof.
      (commits: string[]) => ({ [commits[2] ?? ""]: [passed("main/heavy")] }),
      // The newest status decides.
      (commits: string[]) => ({
        [commits[2] ?? ""]: [
          { context: "main/heavy", state: "failure" },
          passed("main/heavy"),
          passed("main/pr-depth"),
        ],
      }),
      // Only the workflow's own statuses count.
      (commits: string[]) => ({
        [commits[2] ?? ""]: [
          { ...passed("main/heavy"), creator: "someone" },
          { ...passed("main/pr-depth"), creator: "someone" },
        ],
      }),
      () => ({}),
    ]) {
      const run = fixture(statuses);
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.from).toBe("v1.0.0");
    }
  },
  CASE_TIMEOUT_MS,
);

test(
  "an unvalidated history after the anchor keeps the full gates required",
  () => {
    const run = fixture(
      ([first]) => ({
        [first ?? ""]: [passed("main/heavy"), passed("main/pr-depth")],
      }),
      false,
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      `history since ${run.main[0] ?? "missing"} is not validated`,
    );
  },
  CASE_TIMEOUT_MS,
);
