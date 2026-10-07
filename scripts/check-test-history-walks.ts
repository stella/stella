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
// Global options that consume the following argument.
const OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
const GIT_CALLEE = /git$/iu;
const SHELL_HISTORY_WALK =
  /\bgit\s+(?:-[Cc]\s+\S+\s+)*(annotate|blame|log|rev-list|shortlog|whatchanged)\b/u;

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

// The first non-option argument after the global options, or undefined when
// it is not a literal.
const subcommand = (args: readonly ts.Node[]): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      return undefined;
    }
    const text = literalText(arg);
    if (text === undefined) {
      return undefined;
    }
    if (OPTIONS_WITH_VALUE.has(text)) {
      index += 1;
      continue;
    }
    if (!text.startsWith("-")) {
      return text;
    }
  }
  return undefined;
};

const calleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
};

// Arguments a wrapper such as `git(cwd, "log")` or `git(["log"])` passes to
// git, skipping leading non-literal arguments like a working directory.
const wrapperArgs = (call: ts.CallExpression): readonly ts.Node[] => {
  const first = call.arguments.find(
    (arg) => ts.isArrayLiteralExpression(arg) || literalText(arg) !== undefined,
  );
  if (first === undefined) {
    return [];
  }
  if (ts.isArrayLiteralExpression(first)) {
    return first.elements;
  }
  return call.arguments.slice(call.arguments.indexOf(first));
};

const walkedSubcommands = (node: ts.Node): string[] => {
  if (ts.isArrayLiteralExpression(node)) {
    const elements = node.elements;
    const git = elements.findIndex((element) => literalText(element) === "git");
    return git === -1 ? [] : [subcommand(elements.slice(git + 1)) ?? ""];
  }
  if (ts.isCallExpression(node)) {
    const args = node.arguments;
    const git = args.findIndex((arg) => literalText(arg) === "git");
    const next = args[git + 1];
    if (git !== -1 && next !== undefined && ts.isArrayLiteralExpression(next)) {
      return [subcommand(next.elements) ?? ""];
    }
    const name = calleeName(node.expression);
    if (name !== undefined && GIT_CALLEE.test(name)) {
      return [subcommand(wrapperArgs(node)) ?? ""];
    }
    return [];
  }
  if (ts.isTemplateExpression(node)) {
    const text = [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join(" ");
    return [SHELL_HISTORY_WALK.exec(text)?.[1] ?? ""];
  }
  const text = literalText(node);
  return text === undefined ? [] : [SHELL_HISTORY_WALK.exec(text)?.[1] ?? ""];
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
    for (const command of walkedSubcommands(node)) {
      if (HISTORY_SUBCOMMANDS.has(command)) {
        lines.add(
          parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        );
      }
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
  source.includes("git") &&
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
