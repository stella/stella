/** Reject shell negation statements whose status `set -e` silently ignores. */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SHELL_FILE = /\.(?:sh|bash)$/u;
const WORKFLOW_FILE =
  /^\.github\/(?:workflows\/[^/]+\.ya?ml|actions\/.+\/action\.ya?ml)$/u;
const BASH_SHEBANG = /^#![^\n]*\b(?:\/|\s)bash(?:\s|$)/u;
const NEGATED_STATEMENT = /^\s*!\s+\S/u;
const LIST_CONTINUATION = /(?:&&|\|\|)\s*$/u;
// `<<<` is a here-string, not a heredoc.
const HEREDOC_START = /(?<!<)<<-?(?!<)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u;
const CONDITION_START = /^\s*(?:if|while|until)(?:\s|$)/u;
const CONDITION_END = /(?:^|[;\s])(?:then|do)(?:[;\s]|$)/u;
const FUNCTION_START = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{\s*(?:#.*)?$/u;
const FUNCTION_END = /^\s*\}\s*(?:[;&|].*)?(?:#.*)?$/u;
const RUN_BLOCK = /^(\s*)(?:-\s+)?run:\s*[|>]([+-]?)(?:\s*#.*)?$/u;
const RUN_INLINE = /^\s*(?:-\s+)?run:\s*(?![|>])(\S.*)$/u;

export type StandaloneNegationFinding = {
  readonly file: string;
  readonly line: number;
  readonly source: string;
};

type ShellSource = {
  readonly file: string;
  readonly lineOffset: number;
  readonly source: string;
};

const meaningful = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
};

// Only `||` consumes a failed negation (a non-final `&&` command skips errexit
// too); operators inside quotes or comments do not count.
const consumesStatus = (line: string): boolean => {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/u.test(line[index - 1] ?? ""))) {
      return false;
    }
    if (char === "|" && line[index + 1] === "|") {
      return true;
    }
  }
  return false;
};

const isFinalFunctionStatus = (
  lines: readonly string[],
  index: number,
): boolean => {
  let functionDepth = 0;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (FUNCTION_START.test(line)) {
      functionDepth += 1;
    } else if (FUNCTION_END.test(line) && functionDepth > 0) {
      functionDepth -= 1;
    }
  }
  if (functionDepth === 0) {
    return false;
  }
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (!meaningful(line)) {
      continue;
    }
    return FUNCTION_END.test(line);
  }
  return false;
};

const shellFindings = ({ file, lineOffset, source }: ShellSource) => {
  const findings: StandaloneNegationFinding[] = [];
  const lines = source.split("\n");
  let conditionOpen = false;
  let heredocEnd: string | undefined;
  let previousMeaningful = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (heredocEnd !== undefined) {
      if (line.trim() === heredocEnd) {
        heredocEnd = undefined;
      }
      continue;
    }

    const heredoc = line.match(HEREDOC_START);
    const candidate = NEGATED_STATEMENT.test(line);
    const allowed =
      LIST_CONTINUATION.test(previousMeaningful) ||
      consumesStatus(line) ||
      conditionOpen ||
      isFinalFunctionStatus(lines, index);
    if (candidate && !allowed) {
      findings.push({
        file,
        line: lineOffset + index + 1,
        source: line.trim(),
      });
    }

    if (meaningful(line)) {
      if (CONDITION_START.test(line) && !CONDITION_END.test(line)) {
        conditionOpen = true;
      } else if (conditionOpen && CONDITION_END.test(line)) {
        conditionOpen = false;
      }
      previousMeaningful = line;
    }
    if (heredoc !== null) {
      heredocEnd = heredoc[1];
    }
  }
  return findings;
};

const workflowShellSources = (file: string, source: string): ShellSource[] => {
  const lines = source.split("\n");
  const blocks: ShellSource[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const inline = (lines[index] ?? "").match(RUN_INLINE);
    if (inline !== null) {
      const value: unknown = Bun.YAML.parse(`run: ${inline[1] ?? ""}`);
      const command =
        typeof value === "object" && value !== null
          ? Reflect.get(value, "run")
          : undefined;
      if (typeof command === "string") {
        blocks.push({ file, lineOffset: index, source: command });
      }
      continue;
    }
    const match = (lines[index] ?? "").match(RUN_BLOCK);
    if (match === null) {
      continue;
    }
    const parentIndent = match[1]?.length ?? 0;
    const body: string[] = [];
    let bodyIndent: number | undefined;
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor] ?? "";
      if (line.trim() === "") {
        body.push("");
        cursor += 1;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= parentIndent) {
        break;
      }
      bodyIndent ??= indent;
      body.push(line.slice(bodyIndent));
      cursor += 1;
    }
    blocks.push({ file, lineOffset: index + 1, source: body.join("\n") });
    index = cursor - 1;
  }
  return blocks;
};

const hasBashShebang = (file: string): boolean => {
  const descriptor = openSync(file, "r");
  const buffer = Buffer.alloc(256);
  const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
  closeSync(descriptor);
  return BASH_SHEBANG.test(buffer.toString("utf-8", 0, bytesRead));
};

export const findStandaloneNegatedShellStatements = (
  sources: ReadonlyMap<string, string>,
): StandaloneNegationFinding[] => {
  const findings: StandaloneNegationFinding[] = [];
  for (const [file, source] of sources) {
    if (WORKFLOW_FILE.test(file)) {
      for (const block of workflowShellSources(file, source)) {
        findings.push(...shellFindings(block));
      }
      continue;
    }
    if (SHELL_FILE.test(file) || BASH_SHEBANG.test(source)) {
      findings.push(...shellFindings({ file, lineOffset: 0, source }));
    }
  }
  return findings;
};

const trackedSources = (): Map<string, string> => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .split("\0")
    .filter(Boolean);
  const sources = new Map<string, string>();
  for (const file of files) {
    const absoluteFile = path.join(REPO_ROOT, file);
    if (!existsSync(absoluteFile) || !statSync(absoluteFile).isFile()) {
      continue;
    }
    if (
      !SHELL_FILE.test(file) &&
      !WORKFLOW_FILE.test(file) &&
      !hasBashShebang(absoluteFile)
    ) {
      continue;
    }
    sources.set(file, readFileSync(absoluteFile, "utf-8"));
  }
  return sources;
};

export const checkStandaloneNegatedShellStatements = () =>
  findStandaloneNegatedShellStatements(trackedSources());

if (import.meta.main) {
  const findings = checkStandaloneNegatedShellStatements();
  if (findings.length === 0) {
    process.stdout.write(
      "Standalone negated shell statement guard passed: 0 violations.\n",
    );
  } else {
    for (const finding of findings) {
      process.stderr.write(
        `${finding.file}:${finding.line}: standalone negation cannot enforce failure under set -e: ${finding.source}\n`,
      );
    }
    process.exitCode = 1;
  }
}
