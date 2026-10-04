import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addedEntries, runLedgerMembershipGuard } from "./ledger-membership.ts";

const parseLines = (text: string): string[] => text.trim().split("\n");

const runGit = (root: string, args: string[]): string => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic(result.stderr.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
};

const createBaseRepo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "ledger-membership-"));
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/ledger.txt"), "existing\n");
  runGit(root, ["init", "-q", "--initial-branch=ledger-test"]);
  runGit(root, ["add", "."]);
  const tree = runGit(root, ["write-tree"]);
  const commit = runGit(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit-tree",
    tree,
    "-m",
    "base",
  ]);
  runGit(root, ["symbolic-ref", "HEAD", "refs/heads/ledger-test"]);
  runGit(root, ["update-ref", "refs/heads/ledger-test", commit]);
  return root;
};

test("handler ledger membership only shrinks after its introduction", () => {
  expect(addedEntries(["new::1"], null)).toEqual([]);
  expect(addedEntries(["old::1"], ["old::1", "removed::1"])).toEqual([]);
  expect(addedEntries(["replacement::1"], ["old::1"])).toEqual([
    "replacement::1",
  ]);
});

test("membership is enforced for a resolved base commit", () => {
  const root = createBaseRepo();
  try {
    writeFileSync(
      path.join(root, "scripts/ledger.txt"),
      "existing\nnew-entry\n",
    );
    const errors: string[] = [];
    expect(
      runLedgerMembershipGuard({
        ledgerRel: "scripts/ledger.txt",
        repoRoot: root,
        parseLedger: parseLines,
        label: "test",
        remediation: "remove the entry",
        args: ["--base", "HEAD"],
        log: () => {},
        error: (message) => {
          errors.push(message);
        },
      }),
    ).toBe(1);
    expect(errors.join("\n")).toContain("new-entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unresolved base fails the membership guard", () => {
  const root = createBaseRepo();
  try {
    writeFileSync(
      path.join(root, "scripts/ledger.txt"),
      "existing\nnew-entry\n",
    );
    const errors: string[] = [];
    expect(
      runLedgerMembershipGuard({
        ledgerRel: "scripts/ledger.txt",
        repoRoot: root,
        parseLedger: parseLines,
        label: "test",
        remediation: "remove the entry",
        args: ["--base", "missing-base"],
        log: () => {},
        error: (message) => {
          errors.push(message);
        },
      }),
    ).toBe(2);
    expect(errors.join("\n")).toContain("membership cannot be checked");
    expect(errors.join("\n")).toContain("missing-base");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
