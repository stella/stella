import { afterAll, describe, expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import {
  appendFileSync,
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
  new URL("check-staged-secrets.ts", import.meta.url),
);

const root = mkdtempSync(path.join(tmpdir(), "staged-secrets-"));
afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

// Hook runs export GIT_DIR and GIT_INDEX_FILE; fixtures must use their own.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      !entry[0].startsWith("GIT_") &&
      entry[0] !== "CLAUDE_CODE_REMOTE" &&
      entry[0] !== "CODEX_CI" &&
      entry[1] !== undefined,
  ),
);

const run = (cwd: string, command: string[]): string => {
  const result = Bun.spawnSync(command, { cwd, env: baseEnv, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// A GitHub token shape the scanner's default rules report, assembled at run
// time so this file never holds one.
const token = (): string =>
  `ghp_${Array.from({ length: 36 }, () => ALNUM[randomInt(ALNUM.length)]).join("")}`;

// The fake scanner reads the staged diff, as the real one does, reports every
// added line holding the token shape as a JSON finding at its line in the
// staged file, and logs its arguments. A behavior file next to it can make it
// fail before scanning (`exit`) or write a given report text (`report`).
const fakeBin = path.join(root, "fake-bin");
const argsLog = path.join(root, "args.log");
const fakeBehavior = path.join(fakeBin, "behavior.json");
type FakeBehavior = { exit?: number; report?: string };
mkdirSync(fakeBin);
writeFileSync(
  path.join(fakeBin, "gitleaks"),
  `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");
const behavior = JSON.parse(readFileSync(${JSON.stringify(fakeBehavior)}, "utf-8"));
if (behavior.exit !== undefined) process.exit(behavior.exit);
const option = (name) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
const diff = Bun.spawnSync(["git", "diff", "--cached", "-U0", "--no-ext-diff", "--no-color"]);
if (diff.exitCode !== 0) process.exit(1);
const findings = [];
let file = "";
let line = 0;
for (const text of diff.stdout.toString().split("\\n")) {
  if (text.startsWith("+++ ")) { file = text.slice(6); continue; }
  const hunk = /^@@ -\\S+ \\+(\\d+)/.exec(text);
  if (hunk) { line = Number(hunk[1]); continue; }
  if (text.startsWith("+")) {
    const match = /ghp_[A-Za-z0-9]{36}/.exec(text.slice(1));
    if (match) findings.push({
      File: file, RuleID: "github-pat", Description: "token",
      StartLine: line, EndLine: line,
      StartColumn: match.index + 1, EndColumn: match.index + match[0].length,
      Match: "REDACTED", Secret: "REDACTED",
    });
    line += 1;
  }
}
const report = option("--report-path");
if (report) writeFileSync(report, behavior.report ?? JSON.stringify(findings));
if (findings.length > 0) console.error("WRN leaks found: " + findings.length);
process.exit(findings.length > 0 ? Number(option("--exit-code") ?? 1) : 0);
`,
);
chmodSync(path.join(fakeBin, "gitleaks"), 0o755);

type Scanner = "fake" | "real";

const scan = (repo: string, scanner: Scanner, behavior: FakeBehavior = {}) => {
  writeFileSync(fakeBehavior, JSON.stringify(behavior));
  const result = Bun.spawnSync([process.execPath, SCRIPT], {
    cwd: repo,
    env: {
      ...baseEnv,
      ...(scanner === "fake"
        ? { PATH: `${fakeBin}:${baseEnv["PATH"] ?? ""}` }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

const scanWithoutGitleaks = (
  repo: string,
  installer: string,
  hosted: boolean,
) => {
  const bin = path.join(repo, "empty-bin");
  const scripts = path.join(repo, "scripts");
  const installerLog = path.join(repo, "installer.log");
  const scanLog = path.join(repo, "scan.log");
  mkdirSync(bin);
  mkdirSync(scripts);
  writeFileSync(
    path.join(scripts, "cloud-env-secret-scanner-setup.sh"),
    `#!/bin/bash\necho run >> ${JSON.stringify(installerLog)}\n${installer}\n`,
  );
  const result = Bun.spawnSync([process.execPath, SCRIPT], {
    cwd: repo,
    env: {
      ...baseEnv,
      PATH: `${bin}:/usr/bin:/bin`,
      ...(hosted ? { CLAUDE_CODE_REMOTE: "true" } : {}),
      TEST_SCAN_LOG: scanLog,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    installerRuns: existsSync(installerLog)
      ? readFileSync(installerLog, "utf-8").trim().split("\n").length
      : 0,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
    scanInvoked: existsSync(scanLog),
  };
};

let repoCount = 0;
const initRepo = (): string => {
  repoCount += 1;
  const dir = path.join(root, `repo-${repoCount}`);
  run(root, ["git", "init", "-q", "-b", "main", dir]);
  for (const [key, value] of [
    ["user.email", "test@example.test"],
    ["user.name", "test"],
    ["commit.gpgsign", "false"],
  ] as const) {
    run(dir, ["git", "config", key, value]);
  }
  writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n");
  run(dir, ["git", "add", "."]);
  run(dir, ["git", "commit", "-q", "-m", "base"]);
  return dir;
};

describe("hosted environment scanner setup", () => {
  test("a hosted session installs a missing scanner once and scans", () => {
    const repo = initRepo();
    const result = scanWithoutGitleaks(
      repo,
      `cat > empty-bin/gitleaks <<'EOF'\n#!/bin/bash\necho scan >> "$TEST_SCAN_LOG"\nexit 0\nEOF\nchmod +x empty-bin/gitleaks`,
      true,
    );
    expect(result.installerRuns).toBe(1);
    expect(result.scanInvoked).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("a developer machine refuses without running the installer", () => {
    const repo = initRepo();
    const result = scanWithoutGitleaks(repo, "exit 0", false);
    expect(result.installerRuns).toBe(0);
    expect(result.output).toContain(
      "error: gitleaks is required for pre-commit secret scanning.",
    );
    expect(result.exitCode).toBe(1);
  });

  test("a hosted session preserves the installer failure reason", () => {
    const repo = initRepo();
    const result = scanWithoutGitleaks(
      repo,
      'echo "gitleaks NOT installed: download failed" >&2',
      true,
    );
    expect(result.installerRuns).toBe(1);
    expect(result.output).toContain("gitleaks NOT installed: download failed");
    expect(result.exitCode).toBe(1);
  });
});

/**
 * A feature branch merging main, where main added a token line after the
 * branch point. Leaves the merge staged and uncommitted.
 */
const mergingRepo = (): string => {
  const repo = initRepo();
  run(repo, ["git", "switch", "-q", "-c", "feature"]);
  writeFileSync(path.join(repo, "feature.ts"), "export const f = 1;\n");
  run(repo, ["git", "add", "."]);
  run(repo, ["git", "commit", "-q", "-m", "feature"]);
  run(repo, ["git", "switch", "-q", "main"]);
  appendFileSync(path.join(repo, "app.ts"), `const key = "${token()}";\n`);
  run(repo, ["git", "add", "."]);
  run(repo, ["git", "commit", "-q", "-m", "main"]);
  run(repo, ["git", "switch", "-q", "feature"]);
  run(repo, ["git", "merge", "-q", "--no-commit", "--no-ff", "main"]);
  return repo;
};

const scanners: Scanner[] =
  Bun.which("gitleaks") === null ? ["fake"] : ["fake", "real"];

describe.each(scanners)("staged secret scan with the %s scanner", (scanner) => {
  test("a secret staged in a plain commit fails", () => {
    const repo = initRepo();
    appendFileSync(path.join(repo, "app.ts"), `const key = "${token()}";\n`);
    run(repo, ["git", "add", "."]);
    expect(scan(repo, scanner).exitCode).not.toBe(0);
  });

  test("a plain commit without secrets passes", () => {
    const repo = initRepo();
    appendFileSync(path.join(repo, "app.ts"), "export const b = 2;\n");
    run(repo, ["git", "add", "."]);
    expect(scan(repo, scanner).exitCode).toBe(0);
  });

  test("a merge passes a secret that is already on the merged branch", () => {
    const repo = mergingRepo();
    const result = scan(repo, scanner);
    expect(result.output).toContain("already committed on a merge head");
    expect(result.exitCode).toBe(0);
  });

  test("a merge fails a secret added while resolving it", () => {
    const repo = mergingRepo();
    // Right after the merged-in line, so the hunk against HEAD spans both
    // lines while the hunk against the merge head holds only this one.
    appendFileSync(path.join(repo, "app.ts"), `const other = "${token()}";\n`);
    writeFileSync(
      path.join(repo, "resolved.ts"),
      `const third = "${token()}";\n`,
    );
    run(repo, ["git", "add", "."]);
    const result = scan(repo, scanner);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("new relative to every merge parent");
    expect(result.output).toContain("app.ts:3");
    expect(result.output).toContain("resolved.ts:1");
  });
});

describe("staged secret scan fails closed", () => {
  test("a plain commit runs the staged scan unchanged", () => {
    const repo = initRepo();
    writeFileSync(argsLog, "");
    expect(scan(repo, "fake").exitCode).toBe(0);
    expect(readFileSync(argsLog, "utf-8").trim()).toBe(
      JSON.stringify([
        "git",
        "--staged",
        "--redact",
        "--no-banner",
        "--no-color",
        ".",
      ]),
    );
  });

  test("a plain commit fails when the scanner fails", () => {
    const repo = initRepo();
    expect(scan(repo, "fake", { exit: 2 }).exitCode).not.toBe(0);
  });

  test("a merge fails when the scanner fails", () => {
    const repo = mergingRepo();
    const result = scan(repo, "fake", { exit: 2 });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("secret scanning refused");
  });

  test("a merge fails when the report is unreadable", () => {
    const repo = mergingRepo();
    const result = scan(repo, "fake", { report: "not json" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("cannot read the gitleaks report");
  });

  test("a merge fails when a finding lacks its location", () => {
    const repo = mergingRepo();
    const result = scan(repo, "fake", {
      report: JSON.stringify([{ File: "app.ts", RuleID: "github-pat" }]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("the gitleaks report is malformed");
  });

  test("a merge fails when a merge head does not resolve", () => {
    const repo = mergingRepo();
    const mergeHead = run(repo, [
      "git",
      "rev-parse",
      "--git-path",
      "MERGE_HEAD",
    ]);
    appendFileSync(path.join(repo, mergeHead), `${"0".repeat(39)}1\n`);
    const result = scan(repo, "fake");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("cannot resolve merge parent");
  });

  test("a merge passes only what is new relative to every merge head", () => {
    // Two heads, each adding its own token line: neither line is new
    // relative to both, so nothing blocks.
    const repo = initRepo();
    for (const branch of ["one", "two"]) {
      run(repo, ["git", "switch", "-q", "-c", branch, "main"]);
      writeFileSync(
        path.join(repo, `${branch}.ts`),
        `const k = "${token()}";\n`,
      );
      run(repo, ["git", "add", "."]);
      run(repo, ["git", "commit", "-q", "-m", branch]);
    }
    run(repo, ["git", "switch", "-q", "-c", "feature", "main"]);
    writeFileSync(path.join(repo, "feature.ts"), "export const f = 1;\n");
    run(repo, ["git", "add", "."]);
    run(repo, ["git", "commit", "-q", "-m", "feature"]);
    run(repo, ["git", "merge", "-q", "--no-commit", "--no-ff", "one", "two"]);
    expect(scan(repo, "fake").exitCode).toBe(0);
  });
});
