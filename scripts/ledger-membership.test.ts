import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ledgerGitEnv,
  ledgerMergeBase,
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "./ledger-membership";

// The shared shrink-only guard, run against a real repository: an older
// commit that the base already contains adds nothing, even after the base
// shrank its ledger, while a change on top of any commit is still reported.

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Without the caller's repository selectors (hooks export GIT_DIR).
const GIT_ENV = {
  ...ledgerGitEnv(),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

const fixture = () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "ledger-membership-"));
  directories.push(repoRoot);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      env: GIT_ENV,
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const writeLedger = (entries: string[]) => {
    writeFileSync(
      path.join(repoRoot, "ledger.json"),
      JSON.stringify(entries.map((id) => ({ id, reason: "Fixture site." }))),
    );
  };
  const commit = (entries: string[], message: string) => {
    writeLedger(entries);
    git("add", "ledger.json");
    git("commit", "--quiet", "--no-verify", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const errors: string[] = [];
  const check = (base: string) =>
    runLedgerMembershipGuard({
      repoRoot,
      ledgerRel: "ledger.json",
      parseLedger: parseReasonedLedger,
      label: "fixture",
      remediation: "remove the site",
      args: ["--base", base],
      log: () => {},
      error: (message) => {
        errors.push(message);
      },
    });
  git("init", "--quiet", "--initial-branch=main");
  return { repoRoot, git, writeLedger, commit, check, errors };
};

test("an older commit the base contains passes after the base shrank its ledger", () => {
  const { git, commit, check, errors } = fixture();
  const older = commit(["a::x", "a::y"], "older");
  const shrunk = commit(["a::x"], "shrink");
  git("checkout", "--quiet", "--detach", older);
  expect(check(shrunk), errors.join("\n")).toBe(0);
  expect(errors).toEqual([]);
});

test("an entry added on top of a contained commit is still reported", () => {
  const { git, writeLedger, commit, check, errors } = fixture();
  const older = commit(["a::x", "a::y"], "older");
  const shrunk = commit(["a::x"], "shrink");
  git("checkout", "--quiet", "--detach", older);
  writeLedger(["a::x", "a::y", "a::z"]);
  expect(check(shrunk)).toBe(1);
  expect(errors.filter((line) => line.trim().startsWith("a::"))).toEqual([
    "  a::z",
  ]);
});

test("a commit the base does not contain is compared with the base tip", () => {
  const { git, commit, check, errors } = fixture();
  const older = commit(["a::x"], "older");
  const base = commit(["a::x", "a::w"], "base");
  git("checkout", "--quiet", "--detach", older);
  commit(["a::x", "a::z"], "branch");
  expect(check(base)).toBe(1);
  expect(errors.filter((line) => line.trim().startsWith("a::"))).toEqual([
    "  a::z",
  ]);
});

test("an exported GIT_DIR never redirects the guard away from its repository", () => {
  const other = fixture();
  other.commit(["b::q"], "other");
  const otherGitDir = path.join(
    other.git("rev-parse", "--show-toplevel"),
    ".git",
  );
  const { git, commit } = fixture();
  const older = commit(["a::x", "a::y"], "older");
  const shrunk = commit(["a::x"], "shrink");
  git("checkout", "--quiet", "--detach", older);
  const repoRoot = git("rev-parse", "--show-toplevel");
  // A hook's environment reaches the guard when its process starts.
  const guard = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { parseReasonedLedger, runLedgerMembershipGuard } from ${JSON.stringify(path.join(import.meta.dir, "ledger-membership.ts"))};
process.exit(runLedgerMembershipGuard({
  repoRoot: ${JSON.stringify(repoRoot)},
  ledgerRel: "ledger.json",
  parseLedger: parseReasonedLedger,
  label: "fixture",
  remediation: "remove the site",
  args: ["--base", ${JSON.stringify(shrunk)}],
}));`,
    ],
    { env: { ...GIT_ENV, GIT_DIR: otherGitDir }, stderr: "pipe" },
  );
  expect(guard.exitCode, guard.stderr.toString()).toBe(0);
});

test("diverged branch comparisons use the fork point and name unavailable refs", () => {
  const { repoRoot, git, commit } = fixture();
  const fork = commit(["a::x", "a::y"], "fork");
  commit(["a::x"], "main shrinks");
  git("checkout", "--quiet", "-b", "feature", fork);
  git(
    "commit",
    "--quiet",
    "--allow-empty",
    "--no-verify",
    "-m",
    "feature work",
  );
  expect(ledgerMergeBase({ repoRoot, baseRef: "main" })).toBe(fork);
  expect(() =>
    ledgerMergeBase({ repoRoot, baseRef: "origin/missing" }),
  ).toThrow("requires a fetched origin/missing with shared history");
});
