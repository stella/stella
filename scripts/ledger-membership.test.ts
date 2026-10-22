import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "./ledger-membership";

type Git = (...args: string[]) => string;

const serialize = (ids: string[]) =>
  JSON.stringify(ids.map((id) => ({ id, reason: "Fixture entry." })));

const withRepo = (body: (repoRoot: string, git: Git) => void) => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "ledger-membership-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--quiet", "--initial-branch=main");
    body(repoRoot, git);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
};

const commitLedger = (
  repoRoot: string,
  git: Git,
  ids: string[],
  message: string,
) => {
  writeFileSync(path.join(repoRoot, "ledger.json"), serialize(ids));
  git("add", "ledger.json");
  const parent = Bun.spawnSync(
    ["git", "rev-parse", "--verify", "--quiet", "HEAD"],
    { cwd: repoRoot },
  );
  const parentArgs =
    parent.exitCode === 0 ? ["-p", parent.stdout.toString().trim()] : [];
  const commit = git(
    "commit-tree",
    git("write-tree"),
    ...parentArgs,
    "-m",
    message,
  );
  git("update-ref", "HEAD", commit);
  return commit;
};

const check = (repoRoot: string, base: string, ids: string[]) => {
  writeFileSync(path.join(repoRoot, "ledger.json"), serialize(ids));
  const errors: string[] = [];
  const code = runLedgerMembershipGuard({
    repoRoot,
    ledgerRel: "ledger.json",
    parseLedger: parseReasonedLedger,
    label: "fixture",
    remediation: "use the owner",
    args: ["--base", base],
    log: () => {},
    error: (message) => errors.push(message),
  });
  return { code, errors };
};

test("entries the base removed after the fork are not counted as added", () => {
  withRepo((repoRoot, git) => {
    const fork = commitLedger(repoRoot, git, ["a::x", "b::y"], "fork");
    git("switch", "--quiet", "-c", "change");
    commitLedger(repoRoot, git, ["a::x", "b::y"], "change");
    git("switch", "--quiet", "main");
    const shrunk = commitLedger(repoRoot, git, ["a::x"], "base shrinks");
    git("switch", "--quiet", "change");

    // The checkout predates the shrink: it still lists b::y, as the fork did.
    expect(check(repoRoot, shrunk, ["a::x", "b::y"]).code).toBe(0);
    expect(check(repoRoot, shrunk, ["a::x"]).code).toBe(0);

    // An entry the change itself adds is reported against the fork point.
    const added = check(repoRoot, shrunk, ["a::x", "b::y", "c::z"]);
    expect(added.code).toBe(1);
    expect(added.errors[0]).toContain(`fork point ${fork.slice(0, 12)}`);
    expect(added.errors.slice(1)).toEqual(["  c::z"]);
  });
});

test("a re-added entry the base removed before the fork is reported", () => {
  withRepo((repoRoot, git) => {
    commitLedger(repoRoot, git, ["a::x", "b::y"], "start");
    const shrunk = commitLedger(repoRoot, git, ["a::x"], "base shrinks");
    git("switch", "--quiet", "-c", "change");
    commitLedger(repoRoot, git, ["a::x"], "change");

    const readded = check(repoRoot, shrunk, ["a::x", "b::y"]);
    expect(readded.code).toBe(1);
    expect(readded.errors.slice(1)).toEqual(["  b::y"]);
  });
});

test("without shared history the base tip is compared, never a laxer base", () => {
  withRepo((repoRoot, git) => {
    commitLedger(repoRoot, git, ["a::x", "b::y"], "start");
    const shrunk = commitLedger(repoRoot, git, ["a::x"], "base shrinks");
    // An orphan HEAD shares no commit with the base.
    git("switch", "--quiet", "--orphan", "unrelated");

    const result = check(repoRoot, shrunk, ["a::x", "b::y"]);
    expect(result.code).toBe(1);
    expect(result.errors[0]).toContain(`fork point ${shrunk.slice(0, 12)}`);
  });
});
