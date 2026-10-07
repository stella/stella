/**
 * Keep tests off git history walks.
 *
 * CI checks out the full history without blobs, so every blob a history walk
 * touches is fetched lazily, one round trip per commit. Tests read pinned
 * commits (`git show <sha>:path`) instead. A walk that only runs inside a
 * fixture repository the test creates is allowed with a stated reason.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
// Every test convention a CI runner picks up, script and shell tests included.
const SCRIPT_TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;
const SHELL_TEST_FILE = /\.test\.sh$/u;
const HISTORY_SUBCOMMANDS = new Set([
  "annotate",
  "blame",
  "log",
  "rev-list",
  "shortlog",
  "whatchanged",
]);
const GIT_CALLEE = /git$/iu;
// Any history subcommand word in the same shell command as `git`. Matching any
// argument position, not only the first one after the global options, keeps
// option values, quoting and working directories from hiding the subcommand.
const SHELL_HISTORY_WALK =
  /\bgit\b[^\n;&|]*?(?<![\w./-])(?:annotate|blame|log|rev-list|shortlog|whatchanged)(?![\w./-])/u;

// Joins backslash-continued lines so `git \` + `log` reads as one command.
const walksShell = (text: string): boolean =>
  SHELL_HISTORY_WALK.test(text.replaceAll(/\\\r?\n/gu, " "));

export type AllowedHistoryWalk = {
  // The exact number of flagged lines, so a new walk in the file still fails.
  walks: number;
  reason: string;
};

// Shrink-only. Every entry names why its walks cannot reach the CI checkout.
export const ALLOWED_HISTORY_WALKS: Readonly<
  Record<string, AllowedHistoryWalk>
> = {
  "scripts/check-test-history-walks.test.ts": {
    walks: 19,
    reason: "planted fixtures for this guard; nothing is spawned",
  },
  "scripts/check-pushed-secrets.test.ts": {
    walks: 1,
    reason:
      "the walk runs in a stub hook inside a fixture repository the test creates",
  },
  "scripts/staging-source-provenance.test.ts": {
    walks: 2,
    reason: "the walks run in a fixture repository the test creates",
  },
  "scripts/thin-queue.test.ts": {
    walks: 2,
    reason:
      "path-limited log needs no blobs; it stops at the first qualifying revision, normally the newest one",
  },
};

export type HistoryWalkFinding = {
  file: string;
  line: number;
  message: string;
};

const literalText = (node: ts.Node): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;

const calleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
};

// Literal arguments, flattening array literals such as `git(["log"])`.
const literalArgs = (args: readonly ts.Node[]): string[] =>
  args.flatMap((arg) =>
    ts.isArrayLiteralExpression(arg)
      ? literalArgs(arg.elements)
      : (literalText(arg) ?? []),
  );

// Whether git receives a history subcommand in any argument position, so
// global options and a working directory (`git(cwd, "log")`, `-C dir`) never
// hide it.
const walksHistory = (node: ts.Node): boolean => {
  if (ts.isArrayLiteralExpression(node)) {
    const args = literalArgs(node.elements);
    const git = args.indexOf("git");
    return (
      git !== -1 &&
      args.slice(git + 1).some((arg) => HISTORY_SUBCOMMANDS.has(arg))
    );
  }
  if (ts.isCallExpression(node)) {
    const args = literalArgs(node.arguments);
    const name = calleeName(node.expression);
    // A git wrapper passes every argument to git; `spawn("git", [...])`
    // passes what follows the "git" literal.
    const wrapper = name !== undefined && GIT_CALLEE.test(name);
    const git = args.indexOf("git");
    if (!wrapper && git === -1) {
      return false;
    }
    return args
      .slice(wrapper ? 0 : git + 1)
      .some((arg) => HISTORY_SUBCOMMANDS.has(arg));
  }
  if (ts.isTemplateExpression(node)) {
    // Each interpolation stays one argument.
    const text = [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join("ARG");
    return walksShell(text);
  }
  const text = literalText(node);
  return text !== undefined && walksShell(text);
};

const walkFinding = (file: string, line: number): HistoryWalkFinding => ({
  file,
  line,
  message:
    "walks git history; CI fetches one blob per commit. Read a pinned commit with `git show <sha>:path` instead",
});

// Each finding points at the first physical line of its logical command.
const scanShell = (file: string, source: string): HistoryWalkFinding[] => {
  const findings: HistoryWalkFinding[] = [];
  let command = "";
  let start = 0;
  for (const [index, text] of source.split("\n").entries()) {
    if (command === "") {
      start = index;
    }
    if (text.endsWith("\\")) {
      command += `${text.slice(0, -1)} `;
      continue;
    }
    command += text;
    if (!command.trimStart().startsWith("#") && walksShell(command)) {
      findings.push(walkFinding(file, start + 1));
    }
    command = "";
  }
  return findings;
};

const scanSource = (file: string, source: string): HistoryWalkFinding[] => {
  if (SHELL_TEST_FILE.test(file)) {
    return scanShell(file, source);
  }
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = new Set<number>();
  const visit = (node: ts.Node) => {
    if (walksHistory(node)) {
      lines.add(
        parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...lines].map((line) => walkFinding(file, line));
};

const mightWalkHistory = (source: string): boolean =>
  /git/iu.test(source) &&
  /\b(?:annotate|blame|log|rev-list|shortlog|whatchanged)\b/u.test(source);

export const findHistoryWalks = (
  sources: ReadonlyMap<string, string>,
  allowed: Readonly<Record<string, AllowedHistoryWalk>> = ALLOWED_HISTORY_WALKS,
): HistoryWalkFinding[] => {
  const findings: HistoryWalkFinding[] = [];
  for (const [file, source] of sources) {
    const walks = mightWalkHistory(source) ? scanSource(file, source) : [];
    const allowance = Object.hasOwn(allowed, file) ? allowed[file] : undefined;
    if (allowance === undefined || walks.length > allowance.walks) {
      findings.push(...walks);
    } else if (walks.length < allowance.walks) {
      findings.push({
        file,
        line: 1,
        message: `has ${walks.length} of ${allowance.walks} allowed history walks; lower its ALLOWED_HISTORY_WALKS count`,
      });
    }
  }
  for (const file of Object.keys(allowed)) {
    if (!sources.has(file)) {
      findings.push({
        file,
        line: 1,
        message:
          "is not a tracked test file; remove its ALLOWED_HISTORY_WALKS entry",
      });
    }
  }
  return findings;
};

const trackedTests = (): Map<string, string> => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .split("\0")
    .filter(
      (file) => SCRIPT_TEST_FILE.test(file) || SHELL_TEST_FILE.test(file),
    );
  return new Map(
    files.map((file) => [
      file,
      readFileSync(path.join(REPO_ROOT, file), "utf-8"),
    ]),
  );
};

export const checkTestHistoryWalks = (): HistoryWalkFinding[] =>
  findHistoryWalks(trackedTests());

if (import.meta.main) {
  const findings = checkTestHistoryWalks();
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}: ${finding.message}\n`,
    );
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write("Test history walk guard passed.\n");
  }
}
