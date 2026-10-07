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
const TEST_FILE = /\.test\.(?:[cm]?ts|tsx)$/u;
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

// Shrink-only. Every entry names why the walk cannot reach the CI checkout.
export const ALLOWED_HISTORY_WALKS: Readonly<Record<string, string>> = {
  "scripts/check-test-history-walks.test.ts":
    "planted fixtures for this guard; nothing is spawned",
  "scripts/check-pushed-secrets.test.ts":
    "the walk runs in a stub hook inside a fixture repository the test creates",
  "scripts/staging-source-provenance.test.ts":
    "the walk runs in a fixture repository the test creates",
  "scripts/thin-queue.test.ts":
    "path-limited log needs no blobs; it stops at the first qualifying revision, normally the newest one",
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
    return SHELL_HISTORY_WALK.test(text);
  }
  const text = literalText(node);
  return text !== undefined && SHELL_HISTORY_WALK.test(text);
};

const scanSource = (file: string, source: string): HistoryWalkFinding[] => {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
  return [...lines].map((line) => ({
    file,
    line,
    message:
      "walks git history; CI fetches one blob per commit. Read a pinned commit with `git show <sha>:path` instead",
  }));
};

const mightWalkHistory = (source: string): boolean =>
  /git/iu.test(source) &&
  /\b(?:annotate|blame|log|rev-list|shortlog|whatchanged)\b/u.test(source);

export const findHistoryWalks = (
  sources: ReadonlyMap<string, string>,
  allowed: Readonly<Record<string, string>> = ALLOWED_HISTORY_WALKS,
): HistoryWalkFinding[] => {
  const findings: HistoryWalkFinding[] = [];
  for (const [file, source] of sources) {
    const walks = mightWalkHistory(source) ? scanSource(file, source) : [];
    if (Object.hasOwn(allowed, file)) {
      if (walks.length === 0) {
        findings.push({
          file,
          line: 1,
          message:
            "no longer walks git history; remove its ALLOWED_HISTORY_WALKS entry",
        });
      }
      continue;
    }
    findings.push(...walks);
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
    .filter((file) => TEST_FILE.test(file));
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
