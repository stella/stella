import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("check-pushed-secrets.sh", import.meta.url),
);
const ZERO_OID = "0".repeat(40);
/** A commit id no clone has: what a remote tip looks like before a fetch. */
const UNFETCHED_OID = "1".repeat(40);

const root = mkdtempSync(path.join(tmpdir(), "pushed-secrets-"));
afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const run = (cwd: string, command: string[]): string => {
  const result = Bun.spawnSync(command, { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

// The fake scanner records the range it was asked to read, one per line.
const bin = path.join(root, "bin");
const log = path.join(root, "ranges.log");
mkdirSync(bin);
writeFileSync(
  path.join(bin, "gitleaks"),
  `#!/usr/bin/env bash\nfor arg in "$@"; do\n  case "$arg" in --log-opts=*) echo "\${arg#--log-opts=}" >> "${log}" ;; esac\ndone\n`,
);
chmodSync(path.join(bin, "gitleaks"), 0o755);

const repo = path.join(root, "repo");
run(root, ["git", "init", "-q", repo]);
for (const [key, value] of [
  ["user.email", "test@example.test"],
  ["user.name", "test"],
  ["commit.gpgsign", "false"],
] as const) {
  run(repo, ["git", "config", key, value]);
}
run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "base"]);
const base = run(repo, ["git", "rev-parse", "HEAD"]);
run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "change"]);
const head = run(repo, ["git", "rev-parse", "HEAD"]);

const scannedRanges = (stdin: string): string[] => {
  rmSync(log, { force: true });
  const result = Bun.spawnSync(["bash", SCRIPT], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    stdin: new TextEncoder().encode(stdin),
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [];
};

describe("pushed-secret scan ranges", () => {
  test("a known remote tip scans only the new commits", () => {
    expect(
      scannedRanges(`refs/heads/x ${head} refs/heads/x ${base}\n`),
    ).toEqual([`${base}..${head}`]);
  });

  test("a remote tip this clone never fetched scans everything unpublished", () => {
    expect(
      scannedRanges(`refs/heads/x ${head} refs/heads/x ${UNFETCHED_OID}\n`),
    ).toEqual([`${head} --not --remotes`]);
  });

  test("a new remote ref scans everything unpublished", () => {
    expect(
      scannedRanges(`refs/heads/x ${head} refs/heads/x ${ZERO_OID}\n`),
    ).toEqual([`${head} --not --remotes`]);
  });
});
