/**
 * Pre-commit secret scan of the staged changes.
 *
 * A plain commit scans the staged diff against HEAD with
 * `gitleaks git --staged`, unchanged.
 *
 * A merge commit has more than one parent. Its staged diff against HEAD also
 * carries every line the merged branch added, content that is already
 * committed there and was scanned when it was. During a merge the same staged
 * scan runs, and a finding still blocks unless its lines are all unchanged
 * relative to one of the merge heads, that is, unless it is already committed
 * on that parent. A secret added while resolving the merge is new relative to
 * HEAD and to every merge head, so it is still caught.
 *
 * A finding is located by its file and its line range in the staged file;
 * both the scanner and `git diff --cached <merge head>` number lines on that
 * same new side. A finding that overlaps any line the staged tree adds or
 * changes relative to a merge head stays new relative to it, so partial
 * overlaps block. Columns are not used: the scanner's columns shift with how
 * the diff splits into hunks, which differs per parent.
 *
 * Any tooling error (scanner failure, unreadable report, a merge head that
 * does not resolve) refuses the commit.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const SCANNER = "gitleaks";
const SCANNER_SETUP = "scripts/cloud-env-secret-scanner-setup.sh";
export const CLAUDE_CODE_REMOTE_ENV = "CLAUDE_CODE_REMOTE";
export const CODEX_CLOUD_TASK_ENV = "CODEX_CI";
const HOSTED_ENV_VALUE = "true";
const CODEX_CLOUD_TASK_VALUE = "1";
const STAGED_SCAN = [
  "git",
  "--staged",
  "--redact",
  "--no-banner",
  "--no-color",
];
/** Exit status the scanner uses for findings; anything else but 0 is an error. */
const FINDINGS_EXIT = 42;

// Hosted sessions run on Linux, and the setup script installs a Linux
// binary. A marker alone is not enough: local agent tools can set the same
// variables on a developer machine.
export const hostedAgentEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): boolean =>
  platform === "linux" &&
  (env[CLAUDE_CODE_REMOTE_ENV] === HOSTED_ENV_VALUE ||
    env[CODEX_CLOUD_TASK_ENV] === CODEX_CLOUD_TASK_VALUE);

export const isHostedAgentEnvironment = (): boolean =>
  hostedAgentEnvironment(process.env, process.platform);

const LINE = v.pipe(v.number(), v.integer(), v.minValue(1));
// Only the fields the merge check reads; the redacted match and secret are
// never read.
const FindingSchema = v.pipe(
  v.object({
    File: v.pipe(v.string(), v.minLength(1)),
    RuleID: v.string(),
    StartLine: LINE,
    EndLine: LINE,
  }),
  v.check(
    (finding) => finding.EndLine >= finding.StartLine,
    "a finding ends before it starts",
  ),
);
const ReportSchema = v.array(FindingSchema);
type Finding = v.InferOutput<typeof FindingSchema>;

type LineRange = { start: number; end: number };

const fail = (message: string): never => {
  console.error(`error: ${message}; secret scanning refused.`);
  process.exit(1);
};

const git = (args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
};

/** The merge heads of an in-progress merge, or undefined outside a merge. */
const mergeHeads = (): string[] | undefined => {
  const file = git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
  if (!existsSync(file)) {
    return undefined;
  }
  const heads = readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (heads.length === 0) {
    fail("MERGE_HEAD names no commit");
  }
  return heads.map((head) => {
    const result = Bun.spawnSync(
      ["git", "rev-parse", "--verify", "--quiet", `${head}^{commit}`],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const oid = result.stdout.toString().trim();
    if (result.exitCode !== 0 || oid === "") {
      fail(`cannot resolve merge parent ${head}`);
    }
    return oid;
  });
};

/** Lines of `file` the staged tree adds or changes relative to `commit`. */
const stagedLines = (commit: string, file: string): LineRange[] => {
  const patch = git([
    "diff",
    "--cached",
    "-U0",
    "--no-ext-diff",
    "--no-color",
    commit,
    "--",
    `:(top,literal)${file}`,
  ]);
  const ranges: LineRange[] = [];
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk === null) {
      continue;
    }
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
};

const runStagedScan = (report: string): Finding[] => {
  const scanner = Bun.which(SCANNER) ?? "/usr/local/bin/gitleaks";
  const result = Bun.spawnSync(
    [
      scanner,
      ...STAGED_SCAN,
      `--exit-code=${FINDINGS_EXIT}`,
      "--report-format=json",
      `--report-path=${report}`,
      ".",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.exitCode !== 0 && result.exitCode !== FINDINGS_EXIT) {
    fail(`${SCANNER} exited with status ${String(result.exitCode)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(report, "utf-8"));
  } catch {
    fail(`cannot read the ${SCANNER} report`);
  }
  const findings = v.safeParse(ReportSchema, parsed);
  if (!findings.success) {
    return fail(`the ${SCANNER} report is malformed`);
  }
  if ((result.exitCode === FINDINGS_EXIT) !== findings.output.length > 0) {
    fail(`the ${SCANNER} exit status disagrees with its report`);
  }
  return findings.output;
};

const scanMerge = (heads: string[]): number => {
  const reports = mkdtempSync(path.join(tmpdir(), "staged-secrets-"));
  let findings: Finding[];
  try {
    findings = runStagedScan(path.join(reports, "report.json"));
  } finally {
    rmSync(reports, { force: true, recursive: true });
  }
  const fresh: Finding[] = [];
  let committed = 0;
  for (const finding of findings) {
    const onMergeHead = heads.some((head) =>
      stagedLines(head, finding.File).every(
        (range) =>
          range.end < finding.StartLine || range.start > finding.EndLine,
      ),
    );
    if (onMergeHead) {
      committed += 1;
    } else {
      fresh.push(finding);
    }
  }
  if (committed > 0) {
    console.error(
      `secrets: ${committed} finding(s) are already committed on a merge head and do not block this merge.`,
    );
  }
  if (fresh.length === 0) {
    return 0;
  }
  console.error(
    `secrets: ${fresh.length} finding(s) are new relative to every merge parent:`,
  );
  for (const finding of fresh) {
    console.error(`  ${finding.File}:${finding.StartLine} ${finding.RuleID}`);
  }
  return 1;
};

let scanner = Bun.which(SCANNER);
if (scanner === null && isHostedAgentEnvironment()) {
  const setup = Bun.spawnSync(["bash", SCANNER_SETUP], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdout.write(setup.stdout);
  process.stderr.write(setup.stderr);
  scanner = Bun.which(SCANNER);
  const setupFailed = setup.stderr
    .toString()
    .split("\n")
    .some((line) => line.startsWith("gitleaks NOT installed: "));
  if (
    scanner === null &&
    !setupFailed &&
    existsSync("/usr/local/bin/gitleaks")
  ) {
    scanner = "/usr/local/bin/gitleaks";
  }
}

if (scanner === null) {
  console.error(
    `error: ${SCANNER} is required for pre-commit secret scanning.`,
  );
  console.error(
    "Install it from https://github.com/gitleaks/gitleaks/releases",
  );
  console.error("  macOS (Homebrew): brew install gitleaks");
  console.error("  Other platforms: use the releases page above");
  process.exit(1);
}

const heads = mergeHeads();
if (heads === undefined) {
  const scan = Bun.spawnSync([scanner, ...STAGED_SCAN, "."], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(childExitStatus(scan));
}
process.exit(scanMerge(heads));
