import { expect, test } from "bun:test";
import assert from "node:assert/strict";
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
// This check also runs for workflow-only changes, without a dependency install.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const workflow: unknown = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/release-pr.yml", import.meta.url),
    "utf-8",
  ),
);
assert.ok(isRecord(workflow) && isRecord(workflow["jobs"]));
const job = workflow["jobs"]["tag-version"];
assert.ok(isRecord(job) && Array.isArray(job["steps"]));
const step = job["steps"].find(
  (value: unknown) =>
    isRecord(value) && value["name"] === "Dispatch the version commit",
);
assert.ok(
  isRecord(step) && typeof step["run"] === "string",
  "Missing version commit dispatch",
);
const dispatch = step["run"];
const candidate = readFileSync(
  new URL("check-release-candidate.sh", import.meta.url),
  "utf-8",
);

const fixture = () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "release-version-dispatch-"),
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.test");
  const commit = (version: string) => {
    writeFileSync(path.join(directory, "VERSION"), version);
    git("add", "VERSION");
    git("commit", "-qm", `Version ${version}`);
    return git("rev-parse", "HEAD");
  };
  const before = commit("1.0.0");
  const version = commit("1.1.0");
  writeFileSync(path.join(directory, "ordinary.txt"), "later merge");
  git("add", "ordinary.txt");
  git("commit", "-qm", "Ordinary merge");
  const after = git("rev-parse", "HEAD");
  const future = commit("1.2.0");
  git("update-ref", "refs/remotes/origin/main", future);
  mkdirSync(path.join(directory, "scripts"));
  writeFileSync(
    path.join(directory, "scripts/check-release-candidate.sh"),
    candidate,
  );
  writeFileSync(
    path.join(directory, "scripts/gh-retry.sh"),
    `printf "%s\\n" "$@" > dispatch-args\nexit "\${API_STATUS:-0}"\n`,
  );
  type PushOptions = {
    beforeSha: string;
    afterSha: string;
    apiStatus?: string;
  };
  const run = ({ beforeSha, afterSha, apiStatus = "0" }: PushOptions) =>
    Bun.spawnSync(["bash", "-c", dispatch], {
      cwd: directory,
      env: {
        ...process.env,
        BEFORE_SHA: beforeSha,
        GITHUB_SHA: afterSha,
        GITHUB_REPOSITORY: "stella/stella",
        API_STATUS: apiStatus,
      },
    });
  return {
    directory,
    before,
    version,
    after,
    run,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

for (const push of ["version", "batch"] as const) {
  test(`a ${push} push dispatches exactly the version commit despite newer main history`, () => {
    const repo = fixture();
    try {
      const result = repo.run({
        beforeSha: repo.before,
        afterSha: push === "version" ? repo.version : repo.after,
      });
      expect(result.exitCode).toBe(0);
      expect(
        readFileSync(path.join(repo.directory, "dispatch-args"), "utf-8")
          .trim()
          .split("\n"),
      ).toEqual([
        "api",
        "--method",
        "POST",
        "repos/stella/stella/actions/workflows/release-tag.yml/dispatches",
        "-f",
        "ref=main",
        "-f",
        `inputs[sha]=${repo.version}`,
      ]);
    } finally {
      repo.cleanup();
    }
  });
}

test("an ordinary push does not dispatch an existing version commit", () => {
  const repo = fixture();
  try {
    const result = repo.run({ beforeSha: repo.version, afterSha: repo.after });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "No version commit landed in this push.",
    );
    expect(existsSync(path.join(repo.directory, "dispatch-args"))).toBe(false);
  } finally {
    repo.cleanup();
  }
});

test("a failed tag dispatch fails the push job", () => {
  const repo = fixture();
  try {
    expect(
      repo.run({
        beforeSha: repo.before,
        afterSha: repo.version,
        apiStatus: "23",
      }).exitCode,
    ).toBe(23);
  } finally {
    repo.cleanup();
  }
});
