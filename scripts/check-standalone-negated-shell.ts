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

// `>&`, `<&` and `&>` are redirections inside a word, not the `&` operator.
const isRedirectionAmpersand = (source: string, index: number) =>
  source[index] === "&" &&
  (source[index - 1] === ">" ||
    source[index - 1] === "<" ||
    source[index + 1] === ">");

const operatorAt = (source: string, index: number) => {
  if (isRedirectionAmpersand(source, index)) {
    return undefined;
  }
  for (const candidate of OPERATORS) {
    if (source.startsWith(candidate, index)) {
      return candidate;
    }
  }
  return undefined;
};

// `$(...)` and backticks are opaque words: their contents are not analysed,
// but their quotes and parentheses must balance to find the real end.
const skipSubstitution = (state: LexState, closing: "`" | ")") => {
  const { source } = state;
  let depth = 1;
  while (state.index < source.length && depth > 0) {
    const char = source[state.index];
    if (char === "\\") {
      state.index += Math.min(2, source.length - state.index);
      continue;
    }
    if (closing === ")" && (char === "'" || char === '"')) {
      state.index += 1;
      readQuoted(state, char);
      continue;
    }
    if (char === "\n") {
      state.line += 1;
    }
    if (closing === ")" && char === "(") {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
    }
    state.index += 1;
  }
};

const substitutionAt = (source: string, index: number) => {
  if (source[index] === "`") {
    return "`";
  }
  return source[index] === "$" && source[index + 1] === "(" ? ")" : undefined;
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
    // Substitutions nest their own quotes inside a double-quoted string.
    const substitution =
      quote === '"' ? substitutionAt(source, state.index) : undefined;
    if (substitution !== undefined) {
      state.index += substitution === "`" ? 1 : 2;
      skipSubstitution(state, substitution);
      value += "substitution";
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
// Comments sit between a pipeline and whatever consumes its status.
const STATEMENT_ENDS = new Set([";", "\n", "#"]);
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

const NEWLINE = new Set(["\n"]);

const opensFunctionBody = (tokens: readonly Token[], index: number) => {
  // The body brace may sit on its own line after the definition.
  let start = index;
  while (isOperator(tokens[start - 1], NEWLINE)) {
    start -= 1;
  }
  const previous = tokens[start - 1];
  const beforePrevious = tokens[start - 2];
  const posixDefinition =
    isOperator(previous, CLOSE_PAREN) &&
    isOperator(beforePrevious, OPEN_PAREN) &&
    tokens[start - 3]?.type === "word";
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

const GROUP_OPENERS = new Set(["(", "{"]);
const GROUP_CLOSERS = new Set([")", "}"]);
const CONDITION_ENDS = new Set(["then", "do"]);

// The first unnested pipeline boundary after the negation.
const pipelineEnd = (tokens: readonly Token[], index: number) => {
  let depth = 0;
  let end = index + 1;
  for (; end < tokens.length; end += 1) {
    const token = tokens[end];
    if (isOperator(token, GROUP_OPENERS)) {
      depth += 1;
    } else if (depth > 0 && isOperator(token, GROUP_CLOSERS)) {
      depth -= 1;
    } else if (depth === 0 && isOperator(token, PIPELINE_ENDS)) {
      break;
    }
  }
  return end;
};

const isConditionEnd = (token: Token | undefined) =>
  token?.type === "word" && !token.quoted && CONDITION_ENDS.has(token.value);

// A negated pipeline is an assertion only when something consumes its status.
const negationConsumed = ({
  file,
  tokens,
  index,
  inCondition,
  braces,
}: NegationContext) => {
  const end = pipelineEnd(tokens, index);
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
  // In a condition only the final and-or list before `then`/`do` decides, so
  // follow the list containing the negation to its end.
  let listEnd = end;
  while (isOperator(tokens[listEnd], AND_OR)) {
    listEnd = pipelineEnd(tokens, listEnd);
  }
  let listTail = listEnd;
  while (isOperator(tokens[listTail], STATEMENT_ENDS)) {
    listTail += 1;
  }
  const controlsCondition = inCondition && isConditionEnd(tokens[listTail]);
  return (
    controlsCondition ||
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

// Matches a `run:` mapping key line; block scalars start on the next line.
const RUN_KEY = /^\s*(?:-\s+)?run:/u;
const RUN_BLOCK_SCALAR = /^\s*(?:-\s+)?run:\s*[|>]/u;

// Every `run` key in document order; non-string values (e.g. `defaults.run`)
// keep their slot so the order lines up with the key lines.
const collectRunValues = (value: unknown, runs: unknown[]) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRunValues(item, runs);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "run") {
      runs.push(child);
    }
    collectRunValues(child, runs);
  }
};

// YAML decides what each run step executes (folding, chomping, indentation
// indicators); the key line only anchors reported line numbers.
const workflowShellSources = (
  file: string,
  source: string,
): ShellSource[] | undefined => {
  const runs: unknown[] = [];
  collectRunValues(Bun.YAML.parse(source), runs);
  const keyLines = source
    .split("\n")
    .flatMap((line, index) =>
      RUN_KEY.test(line)
        ? [{ index, blockScalar: RUN_BLOCK_SCALAR.test(line) }]
        : [],
    );
  if (keyLines.length !== runs.length) {
    return undefined;
  }
  return runs.flatMap((run, position) => {
    const key = keyLines[position];
    if (typeof run !== "string" || key === undefined) {
      return [];
    }
    return [
      {
        file,
        lineOffset: key.blockScalar ? key.index + 1 : key.index,
        source: run,
      },
    ];
  });
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
      const blocks = workflowShellSources(file, source);
      if (blocks === undefined) {
        // Fails closed: an unmapped run value would otherwise go unchecked.
        findings.push({
          file,
          line: 1,
          source: "run values do not map one-to-one onto `run:` key lines",
        });
        continue;
      }
      for (const block of blocks) {
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
