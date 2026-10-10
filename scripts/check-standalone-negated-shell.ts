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
const RUN_BLOCK = /^(\s*)(?:-\s+)?run:\s*([|>])([+-]?)(?:\s*#.*)?$/u;
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

type Token = {
  readonly type: "word" | "operator";
  readonly value: string;
  readonly line: number;
  readonly quoted: boolean;
};

const OPERATORS = [
  "<<<",
  "<<-",
  "<<",
  "&&",
  "||",
  "|&",
  ";",
  "&",
  "|",
  "(",
  ")",
  "{",
  "}",
] as const;
const COMMAND_SEPARATORS = new Set([
  ";",
  "&",
  "&&",
  "||",
  "|",
  "|&",
  "\n",
  "(",
  // Closes a case pattern; a subshell's `)` cannot be followed by `!`.
  ")",
  "{",
]);

type Heredoc = { readonly delimiter: string; readonly stripTabs: boolean };

type LexState = {
  readonly source: string;
  readonly tokens: Token[];
  readonly heredocs: Heredoc[];
  index: number;
  line: number;
  heredocOperator: "<<" | "<<-" | undefined;
};

const operatorAt = (source: string, index: number) => {
  for (const candidate of OPERATORS) {
    if (source.startsWith(candidate, index)) {
      return candidate;
    }
  }
  return undefined;
};

// `$(...)` and backticks are opaque words: their contents are not analysed.
const skipSubstitution = (state: LexState, closing: "`" | ")") => {
  const { source } = state;
  let depth = 1;
  while (state.index < source.length && depth > 0) {
    const char = source[state.index];
    if (char === "\\") {
      state.index +=
        source[state.index + 1] === "\n"
          ? 2
          : Math.min(2, source.length - state.index);
      continue;
    }
    if (char === "\n") {
      state.line += 1;
    }
    if (closing === ")" && char === "$" && source[state.index + 1] === "(") {
      depth += 1;
      state.index += 2;
      continue;
    }
    if (char === closing) {
      depth -= 1;
    }
    state.index += 1;
  }
};

const skipHeredocBody = (state: LexState, heredoc: Heredoc) => {
  const { source } = state;
  while (state.index < source.length) {
    const end = source.indexOf("\n", state.index);
    const bodyLine = source.slice(
      state.index,
      end === -1 ? source.length : end,
    );
    const compared = heredoc.stripTabs
      ? bodyLine.replace(/^\t+/u, "")
      : bodyLine;
    state.index = end === -1 ? source.length : end + 1;
    if (end !== -1) {
      state.line += 1;
    }
    if (compared === heredoc.delimiter) {
      return;
    }
  }
};

const readQuoted = (state: LexState, quote: "'" | '"') => {
  const { source } = state;
  let value = "";
  while (state.index < source.length && source[state.index] !== quote) {
    if (quote === '"' && source[state.index] === "\\") {
      value += source[state.index + 1] ?? "";
      state.index += 2;
      continue;
    }
    if (source[state.index] === "\n") {
      state.line += 1;
    }
    value += source[state.index] ?? "";
    state.index += 1;
  }
  state.index += source[state.index] === quote ? 1 : 0;
  return value;
};

const endsWord = (source: string, index: number) => {
  const char = source[index] ?? "";
  return /\s/u.test(char) || operatorAt(source, index) !== undefined;
};

// Reads one word part at the cursor; returns undefined at the end of the word.
const readWordPart = (
  state: LexState,
): { text: string; quoted: boolean } | undefined => {
  const { source } = state;
  const char = source[state.index] ?? "";
  const next = source[state.index + 1];
  if (char === "\\") {
    state.index += 2;
    if (next === "\n") {
      state.line += 1;
      return { text: "", quoted: true };
    }
    return { text: next ?? "", quoted: true };
  }
  if (char === "'" || char === '"') {
    state.index += 1;
    return { text: readQuoted(state, char), quoted: true };
  }
  if (char === "$" && next === "'") {
    state.index += 2;
    return { text: readQuoted(state, "'"), quoted: true };
  }
  if (char === "`" || (char === "$" && next === "(")) {
    state.index += char === "`" ? 1 : 2;
    skipSubstitution(state, char === "`" ? "`" : ")");
    return { text: "substitution", quoted: true };
  }
  if (endsWord(source, state.index)) {
    return undefined;
  }
  state.index += 1;
  return { text: char, quoted: false };
};

const readWord = (state: LexState) => {
  const startLine = state.line;
  let value = "";
  let quoted = false;
  while (state.index < state.source.length) {
    const part = readWordPart(state);
    if (part === undefined) {
      break;
    }
    value += part.text;
    quoted ||= part.quoted;
  }
  state.tokens.push({ type: "word", value, line: startLine, quoted });
  if (state.heredocOperator !== undefined) {
    state.heredocs.push({
      delimiter: value,
      stripTabs: state.heredocOperator === "<<-",
    });
    state.heredocOperator = undefined;
  }
};

const readNewline = (state: LexState) => {
  state.tokens.push({
    type: "operator",
    value: "\n",
    line: state.line,
    quoted: false,
  });
  state.index += 1;
  state.line += 1;
  for (const heredoc of state.heredocs.splice(0)) {
    skipHeredocBody(state, heredoc);
  }
};

const shellTokens = (source: string): Token[] => {
  const state: LexState = {
    source,
    tokens: [],
    heredocs: [],
    index: 0,
    line: 1,
    heredocOperator: undefined,
  };
  while (state.index < source.length) {
    const char = source[state.index] ?? "";
    if (char === "\\" && source[state.index + 1] === "\n") {
      state.index += 2;
      state.line += 1;
      continue;
    }
    if (char === "\n") {
      readNewline(state);
      continue;
    }
    if (/\s/u.test(char)) {
      state.index += 1;
      continue;
    }
    if (char === "#") {
      state.tokens.push({
        type: "operator",
        value: "#",
        line: state.line,
        quoted: false,
      });
      const end = source.indexOf("\n", state.index);
      state.index = end === -1 ? source.length : end;
      continue;
    }
    const operator = operatorAt(source, state.index);
    if (operator === undefined) {
      readWord(state);
      continue;
    }
    state.tokens.push({
      type: "operator",
      value: operator,
      line: state.line,
      quoted: false,
    });
    state.index += operator.length;
    state.heredocOperator =
      operator === "<<" || operator === "<<-" ? operator : undefined;
  }
  return state.tokens;
};

// Quoted words never act as operators, even when their text matches one.
const isOperator = (token: Token | undefined, values: ReadonlySet<string>) =>
  token?.type === "operator" && values.has(token.value);

const CONDITION_OPENERS = new Set(["if", "while", "until"]);
const CONDITION_BODIES = new Set(["then", "do"]);
const CONDITION_CLOSERS = new Set(["fi", "done"]);
const COMMAND_STARTERS = new Set([
  "if",
  "elif",
  "while",
  "until",
  "then",
  "do",
  "else",
]);
const PIPELINE_ENDS = new Set([";", "&", "&&", "||", "\n", "}", ")", "#"]);
const OR = new Set(["||"]);
const AND_OR = new Set(["&&", "||"]);
const STATEMENT_ENDS = new Set([";", "\n"]);
const OPEN_PAREN = new Set(["("]);
const CLOSE_PAREN = new Set([")"]);
const OPEN_BRACE = new Set(["{"]);
const CLOSE_BRACE = new Set(["}"]);

type ConditionState = "condition" | "body";

const trackCondition = (stack: ConditionState[], word: string) => {
  if (word === "elif" && stack.at(-1) === "body") {
    stack[stack.length - 1] = "condition";
    return;
  }
  if (CONDITION_OPENERS.has(word)) {
    stack.push("condition");
    return;
  }
  if (CONDITION_BODIES.has(word) && stack.at(-1) === "condition") {
    stack[stack.length - 1] = "body";
    return;
  }
  if (CONDITION_CLOSERS.has(word)) {
    stack.pop();
  }
};

const opensFunctionBody = (tokens: readonly Token[], index: number) => {
  const previous = tokens[index - 1];
  const beforePrevious = tokens[index - 2];
  const posixDefinition =
    isOperator(previous, CLOSE_PAREN) &&
    isOperator(beforePrevious, OPEN_PAREN) &&
    tokens[index - 3]?.type === "word";
  const keywordDefinition =
    beforePrevious?.type === "word" &&
    !beforePrevious.quoted &&
    beforePrevious.value === "function" &&
    previous?.type === "word";
  return posixDefinition || keywordDefinition;
};

type NegationContext = {
  readonly file: string;
  readonly tokens: readonly Token[];
  readonly index: number;
  readonly inCondition: boolean;
  readonly braces: readonly { functionBody: boolean }[];
};

// A negated pipeline is an assertion only when something consumes its status.
const negationConsumed = ({
  file,
  tokens,
  index,
  inCondition,
  braces,
}: NegationContext) => {
  let end = index + 1;
  while (end < tokens.length && !isOperator(tokens[end], PIPELINE_ENDS)) {
    end += 1;
  }
  let tail = end;
  while (isOperator(tokens[tail], STATEMENT_ENDS)) {
    tail += 1;
  }
  const finalInFunction =
    braces.at(-1)?.functionBody === true &&
    isOperator(tokens[tail], CLOSE_BRACE);
  const finalInScript =
    !braces.some(({ functionBody }) => functionBody) &&
    index > 0 &&
    tail === tokens.length &&
    !WORKFLOW_FILE.test(file);
  const inAndOrList = isOperator(tokens[index - 1], AND_OR);
  return (
    inCondition ||
    isOperator(tokens[end], OR) ||
    ((finalInFunction || finalInScript) && !inAndOrList)
  );
};

const shellFindings = ({ file, lineOffset, source }: ShellSource) => {
  const findings: StandaloneNegationFinding[] = [];
  const lines = source.split("\n");
  const tokens = shellTokens(source);
  const conditions: ConditionState[] = [];
  const braces: { functionBody: boolean }[] = [];
  let commandPosition = true;

  for (const [index, token] of tokens.entries()) {
    const reserved = token.type === "word" && !token.quoted && commandPosition;
    if (reserved) {
      trackCondition(conditions, token.value);
    }
    if (isOperator(token, OPEN_BRACE)) {
      braces.push({ functionBody: opensFunctionBody(tokens, index) });
    } else if (isOperator(token, CLOSE_BRACE)) {
      braces.pop();
    }
    const negation =
      token.type === "word" &&
      token.value === "!" &&
      !token.quoted &&
      commandPosition;
    if (
      negation &&
      !negationConsumed({
        file,
        tokens,
        index,
        inCondition: conditions.at(-1) === "condition",
        braces,
      })
    ) {
      findings.push({
        file,
        line: lineOffset + token.line,
        source: (lines[token.line - 1] ?? "").trim(),
      });
    }
    commandPosition =
      (reserved && COMMAND_STARTERS.has(token.value)) ||
      (token.type === "operator" && COMMAND_SEPARATORS.has(token.value));
  }
  return findings;
};

const decodeYamlRun = (yaml: string): string | undefined => {
  const value: unknown = Bun.YAML.parse(yaml);
  const run =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "run")
      : undefined;
  return typeof run === "string" ? run : undefined;
};

const workflowShellSources = (file: string, source: string): ShellSource[] => {
  const lines = source.split("\n");
  const blocks: ShellSource[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const inline = (lines[index] ?? "").match(RUN_INLINE);
    if (inline !== null) {
      const command = decodeYamlRun(`run: ${inline[1] ?? ""}`);
      if (command !== undefined) {
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
    const text = body.join("\n");
    // A folded block runs as joined lines, so decode it before analysis.
    const blockSource =
      match[2] === ">"
        ? decodeYamlRun(
            `run: >${match[3] ?? ""}\n${body.map((line) => `  ${line}`).join("\n")}`,
          )
        : text;
    if (blockSource !== undefined) {
      blocks.push({ file, lineOffset: index + 1, source: blockSource });
    }
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
