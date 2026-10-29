import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseContractDomainLedger } from "./contract-domain-ledger";
import {
  relocateLedgerEntries,
  runLedgerMembershipGuard,
} from "./ledger-membership";

test("moving a source preserves existing sites but cannot add or replace constraints", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "contract-domain-move-"));
  const original = "apps/web/src/settings.tsx";
  const moved = "apps/web/src/admin.tsx";
  const suffix = "::Form::maxLength:64::1";
  const originalEntry = `${original}${suffix}`;
  const movedEntry = `${moved}${suffix}`;
  const serialize = (entries: string[]) =>
    JSON.stringify(
      entries.map((id) => ({ id, reason: "Existing fixture constraint." })),
    );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--quiet");
    mkdirSync(path.join(repoRoot, "apps/web/src"), { recursive: true });
    writeFileSync(path.join(repoRoot, original), "export const bound = 64;\n");
    writeFileSync(
      path.join(repoRoot, "ledger.json"),
      serialize([originalEntry]),
    );
    git("add", ".");
    const tree = git("write-tree");
    const commit = Bun.spawnSync(
      ["git", "commit-tree", tree, "-m", "fixture"],
      {
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
      },
    );
    expect(commit.exitCode).toBe(0);
    const baseCommit = commit.stdout.toString().trim();
    // A checkout stands on a commit: the guard reads the fork point from HEAD.
    git("update-ref", "HEAD", baseCommit);
    renameSync(path.join(repoRoot, original), path.join(repoRoot, moved));
    git("add", "-A");
    const check = (entries: string[]) => {
      writeFileSync(path.join(repoRoot, "ledger.json"), serialize(entries));
      return runLedgerMembershipGuard({
        repoRoot,
        ledgerRel: "ledger.json",
        parseLedger: (text, label) =>
          parseContractDomainLedger(text, label).map(({ id }) => id),
        normalizeBaseEntries: (baseEntries, resolvedCommit) =>
          relocateLedgerEntries({
            entries: baseEntries,
            baseCommit: resolvedCommit,
            repoRoot,
          }),
        label: "fixture",
        remediation: "use the contract",
        args: ["--base", baseCommit],
        log: () => {},
        error: () => {},
      });
    };
    expect(check([movedEntry])).toBe(0);
    expect(check([])).toBe(0);
    expect(check([movedEntry, `${moved}::Form::maxLength:64::2`])).toBe(1);
    expect(check([`${moved}::Form::maxLength:128::1`])).toBe(1);
    expect(check([`${moved}::OtherForm::maxLength:64::1`])).toBe(1);

    // A route cutover can leave a wrapper at the old path, which makes Git
    // report the extracted implementation as a copy rather than a rename.
    writeFileSync(
      path.join(repoRoot, original),
      'export { bound } from "./admin";\n',
    );
    git("add", "-A");
    expect(check([movedEntry])).toBe(0);

    const reviewedEntry = `${moved}::Form::maxLength:64::2`;
    writeFileSync(
      path.join(repoRoot, "ledger.json"),
      serialize([reviewedEntry]),
    );
    const logs: string[] = [];
    const runReviewed = (reason: string | undefined) =>
      runLedgerMembershipGuard({
        repoRoot,
        ledgerRel: "ledger.json",
        parseLedger: (text, label) =>
          parseContractDomainLedger(text, label).map(({ id }) => id),
        normalizeBaseEntries: (baseEntries, resolvedCommit) =>
          relocateLedgerEntries({
            entries: baseEntries,
            baseCommit: resolvedCommit,
            repoRoot,
          }),
        label: "fixture",
        remediation: "use the contract",
        args: ["--base", baseCommit],
        reviewedEntryAdmission: {
          type: "reasoned",
          entries: [{ id: reviewedEntry, reason: reason ?? "" }],
        },
        log: (message) => {
          logs.push(message);
        },
        error: () => {},
      });
    expect(runReviewed("Intentional boundary.")).toBe(0);
    expect(logs).toContain(
      `reviewed entry admitted: ${reviewedEntry} (Intentional boundary.)`,
    );
    expect(runReviewed(undefined)).toBe(1);
    expect(check([reviewedEntry])).toBe(1);
    // A copy leaves the original owner in place and earns no exception.
    writeFileSync(path.join(repoRoot, original), "export const bound = 64;\n");
    git("add", "-A");
    expect(check([movedEntry, originalEntry])).toBe(1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
