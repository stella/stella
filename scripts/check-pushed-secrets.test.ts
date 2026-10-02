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

type ScanResult = { exitCode: number; ranges: string[]; stderr: string };

const scan = (stdin: string): ScanResult => {
  rmSync(log, { force: true });
  const result = Bun.spawnSync(["bash", SCRIPT], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    stdin: new TextEncoder().encode(stdin),
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    ranges: existsSync(log)
      ? readFileSync(log, "utf-8").trim().split("\n")
      : [],
    stderr: result.stderr.toString(),
  };
};

const scannedRanges = (stdin: string): string[] => {
  const result = scan(stdin);
  expect(result.exitCode).toBe(0);
  return result.ranges;
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

  // The fake scanner exits 0 for any range, as a real scanner can when Git
  // cannot resolve the commits it was asked to read.
  test("an unresolvable range fails before the scanner runs", () => {
    const result = scan(`refs/heads/x ${UNFETCHED_OID} refs/heads/x ${base}\n`);
    expect(result.exitCode).toBe(1);
    expect(result.ranges).toEqual([]);
    expect(result.stderr).toContain("cannot resolve pushed commit range");
  });

  test("one unresolvable ref refuses the whole push", () => {
    const result = scan(
      `refs/heads/x ${head} refs/heads/x ${base}\n` +
        `refs/heads/y ${UNFETCHED_OID} refs/heads/y ${base}\n`,
    );
    expect(result.exitCode).toBe(1);
    expect(result.ranges).toEqual([]);
  });
});
