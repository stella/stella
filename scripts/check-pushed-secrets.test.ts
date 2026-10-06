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
const REAL_GIT = Bun.which("git") ?? "git";

const root = mkdtempSync(path.join(tmpdir(), "pushed-secrets-"));
afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const spawn = (cwd: string, command: string[]) =>
  Bun.spawnSync(command, { cwd, stderr: "pipe" });

const run = (cwd: string, command: string[]): string => {
  const result = spawn(cwd, command);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

// The fake scanner records the log options it was asked to read, one per
// line, and every argument it received. Like gitleaks (`git log -p -U0
// <log-opts>`), it reads the patch text Git prints for those options and
// keeps it, so a test can see what a scan would have covered. Like gitleaks,
// it logs how many commits it read: FAKE_GITLEAKS_SCANNED when set ("none"
// omits the line), otherwise the commits with a hunk in a kept file. It exits
// with FAKE_GITLEAKS_EXIT (default 0).
const bin = path.join(root, "bin");
const log = path.join(root, "ranges.log");
const argsLog = path.join(root, "args.log");
const patchLog = path.join(root, "patch.log");
mkdirSync(bin);
writeFileSync(
  path.join(bin, "gitleaks"),
  `#!/usr/bin/env bash
scanned=0
for arg in "$@"; do
  echo "$arg" >> "${argsLog}"
  case "$arg" in
    --log-opts=*)
      opts="\${arg#--log-opts=}"
      echo "$opts" >> "${log}"
      read -r -a words <<<"$opts"
      git log -p -U0 "\${words[@]}" >> "${patchLog}" || exit 0
      scanned="$(git log -p -U0 --format=%x01 "\${words[@]}" | awk '/^\\001/ { c = 0; next } /^diff --git / { d = 0; next } /^deleted file mode / { d = 1; next } /^@@ / && !d && !c { n++; c = 1 } END { print n + 0 }')"
      ;;
  esac
done
scanned="\${FAKE_GITLEAKS_SCANNED:-$scanned}"
[[ "$scanned" == none ]] || echo "INF $scanned commits scanned." >&2
exit "\${FAKE_GITLEAKS_EXIT:-0}"
`,
);
chmodSync(path.join(bin, "gitleaks"), 0o755);

// A Git older than 2.36, which rejects --remerge-diff.
const oldGitBin = path.join(root, "old-git-bin");
mkdirSync(oldGitBin);
writeFileSync(
  path.join(oldGitBin, "git"),
  `#!/usr/bin/env bash
for arg in "$@"; do
  [[ "$arg" == --remerge-diff ]] && { echo "fatal: unrecognized argument: $arg" >&2; exit 128; }
done
exec "${REAL_GIT}" "$@"
`,
);
chmodSync(path.join(oldGitBin, "git"), 0o755);

// A Git that resolves every range but cannot print patches, as when a
// partial clone's lazy blob fetch fails.
const unreadableGitBin = path.join(root, "unreadable-git-bin");
mkdirSync(unreadableGitBin);
writeFileSync(
  path.join(unreadableGitBin, "git"),
  `#!/usr/bin/env bash
if [[ "$1" == log ]]; then
  for arg in "$@"; do
    [[ "$arg" == -p ]] && { echo "fatal: remote error: upload-pack: not our ref" >&2; exit 128; }
  done
fi
exec "${REAL_GIT}" "$@"
`,
);
chmodSync(path.join(unreadableGitBin, "git"), 0o755);

// A Git whose merge replay reports an error yet exits 0, as when a partial
// clone cannot fetch a blob the replay needs.
const replayErrorGitBin = path.join(root, "replay-error-git-bin");
mkdirSync(replayErrorGitBin);
writeFileSync(
  path.join(replayErrorGitBin, "git"),
  `#!/usr/bin/env bash
if [[ "$1" == show ]]; then
  for arg in "$@"; do
    if [[ "$arg" == --remerge-diff ]]; then
      echo "fatal: remote error: upload-pack: not our ref" >&2
      exit 0
    fi
  done
fi
exec "${REAL_GIT}" "$@"
`,
);
chmodSync(path.join(replayErrorGitBin, "git"), 0o755);

const initRepo = (name: string): string => {
  const dir = path.join(root, name);
  run(root, ["git", "init", "-q", "-b", "main", dir]);
  for (const [key, value] of [
    ["user.email", "test@example.test"],
    ["user.name", "test"],
    ["commit.gpgsign", "false"],
    ["rerere.enabled", "false"],
  ] as const) {
    run(dir, ["git", "config", key, value]);
  }
  return dir;
};

const repo = initRepo("repo");
run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "base"]);
const base = run(repo, ["git", "rev-parse", "HEAD"]);
run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "change"]);
const head = run(repo, ["git", "rev-parse", "HEAD"]);

/** The log options the script passes for a revision range. */
const scanOf = (range: string): string => `--no-merges ${range}`;

type ScanOptions = {
  cwd?: string;
  pathPrefix?: string;
  scannerExit?: number;
  /** What the scanner logs as read: a count, or "none" for no line. */
  scannerScanned?: string;
};
type ScanResult = {
  exitCode: number;
  patch: string;
  ranges: string[];
  stderr: string;
};

const scan = (
  stdin: string,
  {
    cwd = repo,
    pathPrefix = bin,
    scannerExit = 0,
    scannerScanned,
  }: ScanOptions = {},
): ScanResult => {
  rmSync(log, { force: true });
  rmSync(argsLog, { force: true });
  rmSync(patchLog, { force: true });
  const result = Bun.spawnSync(["bash", SCRIPT], {
    cwd,
    env: {
      ...process.env,
      FAKE_GITLEAKS_EXIT: String(scannerExit),
      ...(scannerScanned === undefined
        ? {}
        : { FAKE_GITLEAKS_SCANNED: scannerScanned }),
      PATH: `${pathPrefix}:${bin}:${process.env["PATH"] ?? ""}`,
    },
    stdin: new TextEncoder().encode(stdin),
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    patch: existsSync(patchLog) ? readFileSync(patchLog, "utf-8") : "",
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
  test("a known remote tip scans only the new unpublished commits", () => {
    expect(
      scannedRanges(`refs/heads/x ${head} refs/heads/x ${base}\n`),
    ).toEqual([scanOf(`${base}..${head} --not --remotes`)]);
  });

  test("a remote tip this clone never fetched scans everything unpublished", () => {
    expect(
      scannedRanges(`refs/heads/x ${head} refs/heads/x ${UNFETCHED_OID}\n`),
    ).toEqual([scanOf(`${head} --not --remotes`)]);
  });

  test("a new remote ref scans everything unpublished", () => {
    expect(
      scannedRanges(`refs/heads/x ${head} refs/heads/x ${ZERO_OID}\n`),
    ).toEqual([scanOf(`${head} --not --remotes`)]);
  });

  // The fake scanner exits 0 for any range, as a real scanner can when Git
  // cannot resolve the commits it was asked to read.
  test("an unresolvable range fails before the scanner runs", () => {
    const result = scan(`refs/heads/x ${UNFETCHED_OID} refs/heads/x ${base}\n`);
    expect(result.exitCode).toBe(1);
    expect(result.ranges).toEqual([]);
    expect(result.stderr).toContain("cannot resolve pushed commit range");
  });

  test("every pushed ref is scanned", () => {
    expect(
      scannedRanges(
        `refs/heads/x ${head} refs/heads/x ${base}\n` +
          `refs/heads/y ${head} refs/heads/y ${ZERO_OID}\n`,
      ),
    ).toEqual([
      scanOf(`${base}..${head} --not --remotes`),
      scanOf(`${head} --not --remotes`),
    ]);
  });

  test("a deleted ref does not stop the refs after it", () => {
    expect(
      scannedRanges(
        `(delete) ${ZERO_OID} refs/heads/old ${base}\n` +
          `refs/heads/x ${head} refs/heads/x ${base}\n`,
      ),
    ).toEqual([scanOf(`${base}..${head} --not --remotes`)]);
  });

  test("a leak the scanner reports fails the push", () => {
    const result = scan(`refs/heads/x ${head} refs/heads/x ${base}\n`, {
      scannerExit: 1,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.ranges).toEqual([scanOf(`${base}..${head} --not --remotes`)]);
  });

  test("the scanner keeps its failing exit code", () => {
    scan(`refs/heads/x ${head} refs/heads/x ${base}\n`);
    const args = readFileSync(argsLog, "utf-8").split("\n");
    expect(args.filter((arg) => arg.startsWith("--exit-code"))).toEqual([]);
  });

  test("one unresolvable ref refuses the whole push", () => {
    const result = scan(
      `refs/heads/x ${head} refs/heads/x ${base}\n` +
        `refs/heads/y ${UNFETCHED_OID} refs/heads/y ${base}\n`,
    );
    expect(result.exitCode).toBe(1);
    expect(result.ranges).toEqual([]);
  });

  test("a Git without --remerge-diff refuses the scan", () => {
    const result = scan(`refs/heads/x ${head} refs/heads/x ${base}\n`, {
      pathPrefix: oldGitBin,
    });
    expect(result.exitCode).toBe(1);
    expect(result.ranges).toEqual([]);
    expect(result.stderr).toContain("--remerge-diff is unsupported");
  });

  test("unreadable patches refuse the scan", () => {
    const result = scan(`refs/heads/x ${head} refs/heads/x ${base}\n`, {
      pathPrefix: unreadableGitBin,
    });
    expect(result.exitCode).toBe(1);
    expect(result.ranges).toEqual([]);
    expect(result.stderr).toContain("cannot read the patches");
  });
});

// Markers stand in for secrets: the fake scanner keeps the patch text a real
// scan would read, so each test asserts which markers that text carries.
const MAIN_ONLY = "MARKER_MAIN_ONLY";
const BRANCH_BEFORE_MERGE = "MARKER_BRANCH_BEFORE_MERGE";
const BRANCH_AFTER_MERGE = "MARKER_BRANCH_AFTER_MERGE";
const CONFLICT_RESOLUTION = "MARKER_CONFLICT_RESOLUTION";
const CLEAN_MERGE_ADDITION = "MARKER_CLEAN_MERGE_ADDITION";

const commitFile = (
  dir: string,
  { file, text }: { file: string; text: string },
): string => {
  writeFileSync(path.join(dir, file), text);
  run(dir, ["git", "add", file]);
  run(dir, ["git", "commit", "-q", "-m", `edit ${file}`]);
  return run(dir, ["git", "rev-parse", "HEAD"]);
};

/** Marks a commit as published on the remote, as a fetch would. */
const publish = (dir: string, { ref, oid }: { ref: string; oid: string }) => {
  run(dir, ["git", "update-ref", `refs/remotes/origin/${ref}`, oid]);
};

describe("a branch that merged main", () => {
  const dir = initRepo("merged-main");
  commitFile(dir, { file: "shared.txt", text: "value = base\n" });
  run(dir, ["git", "switch", "-q", "-c", "feature"]);
  const branchTip = commitFile(dir, {
    file: "feature.txt",
    text: `${BRANCH_BEFORE_MERGE}\n`,
  });
  run(dir, ["git", "switch", "-q", "main"]);
  const mainTip = commitFile(dir, {
    file: "main.txt",
    text: `${MAIN_ONLY}\n`,
  });
  publish(dir, { ref: "main", oid: mainTip });
  run(dir, ["git", "switch", "-q", "feature"]);
  run(dir, ["git", "merge", "-q", "--no-edit", "main"]);
  const pushedTip = commitFile(dir, {
    file: "feature.txt",
    text: `${BRANCH_BEFORE_MERGE}\n${BRANCH_AFTER_MERGE}\n`,
  });

  test("a new remote ref scans the branch's commits, not main's", () => {
    const result = scan(
      `refs/heads/feature ${pushedTip} refs/heads/feature ${ZERO_OID}\n`,
      { cwd: dir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.patch).toContain(BRANCH_BEFORE_MERGE);
    expect(result.patch).toContain(BRANCH_AFTER_MERGE);
    expect(result.patch).not.toContain(MAIN_ONLY);
  });

  test("an update scans the branch's new commits, not the merged main", () => {
    publish(dir, { ref: "feature", oid: branchTip });
    const result = scan(
      `refs/heads/feature ${pushedTip} refs/heads/feature ${branchTip}\n`,
      { cwd: dir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.patch).toContain(BRANCH_AFTER_MERGE);
    expect(result.patch).not.toContain(MAIN_ONLY);
  });
});

describe("a merge resolution", () => {
  const dir = initRepo("resolution");
  commitFile(dir, { file: "shared.txt", text: "value = base\n" });
  run(dir, ["git", "switch", "-q", "-c", "feature"]);
  const branchTip = commitFile(dir, {
    file: "shared.txt",
    text: "value = feature\n",
  });
  publish(dir, { ref: "feature", oid: branchTip });
  run(dir, ["git", "switch", "-q", "main"]);
  const mainTip = commitFile(dir, {
    file: "shared.txt",
    text: "value = main\n",
  });
  publish(dir, { ref: "main", oid: mainTip });
  run(dir, ["git", "switch", "-q", "feature"]);
  // Conflicts exit non-zero; the resolution below completes the merge.
  spawn(dir, ["git", "merge", "-q", "--no-edit", "main"]);
  writeFileSync(path.join(dir, "shared.txt"), `${CONFLICT_RESOLUTION}\n`);
  writeFileSync(path.join(dir, "added.txt"), `${CLEAN_MERGE_ADDITION}\n`);
  run(dir, ["git", "add", "shared.txt", "added.txt"]);
  run(dir, ["git", "commit", "-q", "--no-edit"]);
  const mergeTip = run(dir, ["git", "rev-parse", "HEAD"]);

  test("anything a merge adds while resolving it is scanned", () => {
    const result = scan(
      `refs/heads/feature ${mergeTip} refs/heads/feature ${branchTip}\n`,
      { cwd: dir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.patch).toContain(CONFLICT_RESOLUTION);
    expect(result.patch).toContain(CLEAN_MERGE_ADDITION);
  });

  test("a merge Git cannot replay is scanned against its first parent", () => {
    const result = scan(
      `refs/heads/feature ${mergeTip} refs/heads/feature ${branchTip}\n`,
      { cwd: dir, pathPrefix: replayErrorGitBin },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("cannot replay merge");
    expect(result.ranges).toContain(
      `--diff-merges=first-parent -n 1 ${mergeTip}`,
    );
    expect(result.patch).toContain(CONFLICT_RESOLUTION);
    expect(result.patch).toContain(CLEAN_MERGE_ADDITION);
  });

  test("a merge the scanner did not read refuses", () => {
    const result = scan(
      `refs/heads/feature ${mergeTip} refs/heads/feature ${branchTip}\n`,
      { cwd: dir, scannerScanned: "0" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `read 0 of 1 changed commits in merge ${mergeTip}`,
    );
  });

  test("an unresolvable remote range with merges fails closed", () => {
    const result = scan(
      `refs/heads/feature ${UNFETCHED_OID} refs/heads/feature ${branchTip}\n`,
      { cwd: dir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.ranges).toEqual([]);
  });
});

describe("what the scanner read", () => {
  const dir = initRepo("scanner-count");
  const before = commitFile(dir, { file: "kept.txt", text: "one\n" });
  publish(dir, { ref: "main", oid: before });
  const changed = commitFile(dir, { file: "kept.txt", text: "two\n" });
  const push = `refs/heads/x ${changed} refs/heads/x ${before}\n`;

  test("a scanner that read fewer changed commits than the range refuses", () => {
    const result = scan(push, { cwd: dir, scannerScanned: "0" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("read 0 of 1 changed commits");
  });

  test("a scanner that read only part of a multi-commit push refuses", () => {
    const second = commitFile(dir, { file: "kept.txt", text: "three\n" });
    const result = scan(`refs/heads/x ${second} refs/heads/x ${before}\n`, {
      cwd: dir,
      scannerScanned: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("read 1 of 2 changed commits");
    run(dir, ["git", "reset", "-q", "--hard", changed]);
  });

  test("a scanner that reports no count refuses", () => {
    const result = scan(push, { cwd: dir, scannerScanned: "none" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("did not report how many commits");
  });

  test("a scanner that read every changed commit passes", () => {
    expect(scan(push, { cwd: dir }).exitCode).toBe(0);
  });

  // gitleaks counts none of these: no text line changes in a file it keeps.
  test("commits without a text change in a kept file expect no scan", () => {
    run(dir, ["git", "commit", "-q", "--allow-empty", "-m", "empty"]);
    run(dir, ["git", "mv", "kept.txt", "moved.txt"]);
    run(dir, ["git", "commit", "-q", "-m", "rename"]);
    chmodSync(path.join(dir, "moved.txt"), 0o755);
    run(dir, ["git", "commit", "-q", "-am", "mode"]);
    writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2]));
    run(dir, ["git", "add", "blob.bin"]);
    run(dir, ["git", "commit", "-q", "-m", "binary"]);
    run(dir, ["git", "rm", "-q", "moved.txt"]);
    run(dir, ["git", "commit", "-q", "-m", "delete"]);
    const tip = run(dir, ["git", "rev-parse", "HEAD"]);
    const result = scan(`refs/heads/x ${tip} refs/heads/x ${changed}\n`, {
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
  });
});
