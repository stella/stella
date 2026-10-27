/**
 * Reject shell statements whose exit status misleads under `set -eo pipefail`:
 * negations that `set -e` silently ignores, and pipelines whose reader can
 * exit before its writer finishes.
 */

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

export type ShellStatusFinding = {
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

// The text inside `$(...)` or backticks, which runs as its own script.
type CommandSubstitution = { readonly source: string; readonly line: number };

type LexState = {
  readonly source: string;
  readonly tokens: Token[];
  readonly heredocs: Heredoc[];
  readonly substitutions: CommandSubstitution[];
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
type SubstitutionClose = "`" | ")" | "}";

const SUBSTITUTION_OPENERS = {
  "`": undefined,
  ")": "(",
  "}": "{",
} as const satisfies Record<SubstitutionClose, string | undefined>;

const skipSubstitution = (state: LexState, closing: SubstitutionClose) => {
  const { source } = state;
  const opener = SUBSTITUTION_OPENERS[closing];
  const start = state.index;
  const startLine = state.line;
  let depth = 1;
  while (state.index < source.length && depth > 0) {
    const char = source[state.index];
    if (char === "\\") {
      state.line += source[state.index + 1] === "\n" ? 1 : 0;
      state.index += Math.min(2, source.length - state.index);
      continue;
    }
    if (closing !== "`" && (char === "'" || char === '"')) {
      state.index += 1;
      readQuoted(state, char);
      continue;
    }
    if (char === "\n") {
      state.line += 1;
    }
    if (char === opener) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
    }
    state.index += 1;
  }
  // `${...}` is a parameter expansion, not a command.
  if (closing !== "}") {
    state.substitutions.push({
      source: source.slice(start, Math.max(start, state.index - 1)),
      line: startLine,
    });
  }
};

const substitutionAt = (
  source: string,
  index: number,
): SubstitutionClose | undefined => {
  if (source[index] === "`") {
    return "`";
  }
  if (source[index] !== "$") {
    return undefined;
  }
  if (source[index + 1] === "(") {
    return ")";
  }
  return source[index + 1] === "{" ? "}" : undefined;
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

// `$'...'` (ANSI-C) closes on `'` but honours backslash escapes like `"..."`.
type QuoteKind = "'" | '"' | "$'";

const readQuoted = (state: LexState, kind: QuoteKind) => {
  const { source } = state;
  const quote = kind === '"' ? '"' : "'";
  let value = "";
  while (state.index < source.length && source[state.index] !== quote) {
    if (kind !== "'" && source[state.index] === "\\") {
      state.line += source[state.index + 1] === "\n" ? 1 : 0;
      value += source[state.index + 1] ?? "";
      state.index += 2;
      continue;
    }
    // Substitutions nest their own quotes inside a double-quoted string.
    const substitution =
      kind === '"' ? substitutionAt(source, state.index) : undefined;
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
    return { text: readQuoted(state, "$'"), quoted: true };
  }
  const substitution = substitutionAt(source, state.index);
  if (substitution !== undefined) {
    state.index += substitution === "`" ? 1 : 2;
    skipSubstitution(state, substitution);
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

// `(( ... ))` is arithmetic: its `!`, `<<` and parentheses are not shell syntax.
const readArithmetic = (state: LexState) => {
  const startLine = state.line;
  state.index += 2;
  skipSubstitution(state, ")");
  if (state.source[state.index] === ")") {
    state.index += 1;
  }
  state.tokens.push({
    type: "word",
    value: "arithmetic",
    line: startLine,
    quoted: true,
  });
};

// `[[ ... ]]` is one conditional command: its `||`, `&&` and `!` are
// expression operators whose result the command itself returns.
const readConditionalExpression = (state: LexState) => {
  const { source } = state;
  const startLine = state.line;
  state.index += 2;
  while (state.index < source.length && !source.startsWith("]]", state.index)) {
    const char = source[state.index];
    if (char === "'" || char === '"') {
      state.index += 1;
      readQuoted(state, char);
      continue;
    }
    if (char === "\\") {
      state.line += source[state.index + 1] === "\n" ? 1 : 0;
      state.index += 2;
      continue;
    }
    if (char === "\n") {
      state.line += 1;
    }
    state.index += 1;
  }
  state.index = Math.min(source.length, state.index + 2);
  state.tokens.push({
    type: "word",
    value: "conditional",
    line: startLine,
    quoted: true,
  });
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

type LexResult = {
  readonly tokens: Token[];
  readonly substitutions: CommandSubstitution[];
};

const lexShell = (source: string): LexResult => {
  const state: LexState = {
    source,
    tokens: [],
    heredocs: [],
    substitutions: [],
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
    if (source.startsWith("((", state.index)) {
      readArithmetic(state);
      continue;
    }
    if (/^\[\[\s/u.test(source.slice(state.index, state.index + 3))) {
      readConditionalExpression(state);
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
  return { tokens: state.tokens, substitutions: state.substitutions };
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
const SEMICOLON = new Set([";"]);
const PIPES = new Set(["|", "|&"]);
const ARM_ENDS = new Set([";", "&"]);
const OPEN_BRACE = new Set(["{"]);
const CLOSE_BRACE = new Set(["}"]);

// `loop` frames (for/select) own their `done` without a condition list.
type ConditionState = "condition" | "body" | "loop";
const LOOP_OPENERS = new Set(["for", "select"]);

const trackCondition = (stack: ConditionState[], word: string) => {
  if (word === "elif" && stack.at(-1) === "body") {
    stack[stack.length - 1] = "condition";
    return;
  }
  if (CONDITION_OPENERS.has(word)) {
    stack.push("condition");
    return;
  }
  if (LOOP_OPENERS.has(word)) {
    stack.push("loop");
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
const LINE_BREAKS = new Set(["\n", "#"]);

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
  readonly groups: readonly GroupFrame[];
};

type GroupFrame = {
  readonly close: ")" | "}";
  readonly functionBody: boolean;
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

type StatusConsumptionContext = Omit<NegationContext, "groups"> & {
  readonly groups: readonly GroupFrame[];
  readonly end: number;
};

// The first operator at or after `from`; redirections between a group and a
// pipe are words, so they do not hide the pipe.
const followingOperator = (tokens: readonly Token[], from: number) =>
  tokens.slice(from).find((token) => token.type === "operator");

const statusConsumed = ({
  file,
  tokens,
  index,
  inCondition,
  groups,
  end,
}: StatusConsumptionContext): boolean => {
  let tail = end;
  while (isOperator(tokens[tail], STATEMENT_ENDS)) {
    tail += 1;
  }
  const enclosingGroup = groups.at(-1);
  const finalInFunction =
    enclosingGroup?.functionBody === true &&
    tokens[tail]?.type === "operator" &&
    tokens[tail]?.value === enclosingGroup.close;
  const finalInScript =
    !groups.some(({ functionBody }) => functionBody) &&
    groups.length === 0 &&
    index > 0 &&
    tail === tokens.length &&
    !WORKFLOW_FILE.test(file);
  // An and-or operator may end the previous line, before comments.
  let before = index - 1;
  while (isOperator(tokens[before], LINE_BREAKS)) {
    before -= 1;
  }
  const inAndOrList = isOperator(tokens[before], AND_OR);
  // In a condition only the final and-or list before `then`/`do` decides, so
  // follow the list containing the negation to its end.
  let listEnd = end;
  while (isOperator(tokens[listEnd], AND_OR)) {
    // An and-or operator continues the list across newlines and comments.
    let next = listEnd + 1;
    while (isOperator(tokens[next], LINE_BREAKS)) {
      next += 1;
    }
    listEnd = pipelineEnd(tokens, next - 1);
  }
  let listTail = listEnd;
  while (isOperator(tokens[listTail], STATEMENT_ENDS)) {
    listTail += 1;
  }
  const controlsCondition = inCondition && isConditionEnd(tokens[listTail]);
  if (
    controlsCondition ||
    isOperator(tokens[end], OR) ||
    ((finalInFunction || finalInScript) && !inAndOrList)
  ) {
    return true;
  }

  if (
    enclosingGroup === undefined ||
    enclosingGroup.functionBody ||
    tokens[tail]?.type !== "operator" ||
    tokens[tail]?.value !== enclosingGroup.close ||
    // Without pipefail a pipeline returns its last command's status, so a
    // group that feeds a pipe hands nothing on.
    isOperator(followingOperator(tokens, tail + 1), PIPES)
  ) {
    return false;
  }

  return statusConsumed({
    file,
    tokens,
    index: tail,
    inCondition,
    groups: groups.slice(0, -1),
    end: pipelineEnd(tokens, tail),
  });
};

// A negated pipeline is an assertion only when something consumes its status.
const negationConsumed = ({
  file,
  tokens,
  index,
  inCondition,
  groups,
}: NegationContext) => {
  const end = pipelineEnd(tokens, index);
  return statusConsumed({ file, tokens, index, inCondition, groups, end });
};

// Whether the token after this one is in command position.
const startsCommand = (token: Token, reserved: boolean): boolean =>
  (reserved && COMMAND_STARTERS.has(token.value)) ||
  (token.type === "operator" && COMMAND_SEPARATORS.has(token.value));

type CasePhase = "word" | "pattern" | "body";

type TrackCaseOptions = {
  readonly cases: CasePhase[];
  readonly token: Token;
  readonly next: Token | undefined;
  readonly reserved: boolean;
};

// Advances the innermost `case` frame; true when the token is pattern syntax.
const trackCase = ({ cases, token, next, reserved }: TrackCaseOptions) => {
  const phase = cases.at(-1);
  // In the pattern phase `case` is a pattern word; only `esac` ends the frame.
  if (reserved && token.value === "case" && phase !== "pattern") {
    cases.push("word");
    return false;
  }
  if (reserved && token.value === "esac") {
    cases.pop();
    return false;
  }
  if (phase === "word" && token.type === "word" && token.value === "in") {
    cases[cases.length - 1] = "pattern";
    return false;
  }
  if (
    phase === "body" &&
    isOperator(token, SEMICOLON) &&
    // `;;`, `;&` and `;;&` all end an arm.
    isOperator(next, ARM_ENDS)
  ) {
    cases[cases.length - 1] = "pattern";
    return false;
  }
  if (phase !== "pattern") {
    return false;
  }
  if (isOperator(token, CLOSE_PAREN)) {
    cases[cases.length - 1] = "body";
    return true;
  }
  return isOperator(token, OPEN_PAREN);
};

// `time` (and its `-p`) prefix a pipeline, so the next word is still a command.
const startsTimedPipeline = (
  token: Token,
  reserved: boolean,
  timePrefix: boolean,
): boolean =>
  reserved && (token.value === "time" || (timePrefix && token.value === "-p"));

const shellFindings = ({ file, lineOffset, source }: ShellSource) => {
  const findings: ShellStatusFinding[] = [];
  const lines = source.split("\n");
  const { tokens } = lexShell(source);
  const conditions: ConditionState[] = [];
  const groups: GroupFrame[] = [];
  // One frame per open `case`: its word, then patterns, then an arm body.
  const cases: CasePhase[] = [];
  let commandPosition = true;
  let timePrefix = false;

  for (const [index, token] of tokens.entries()) {
    const reserved: boolean =
      token.type === "word" && !token.quoted && commandPosition;
    if (reserved) {
      trackCondition(conditions, token.value);
    }
    if (trackCase({ cases, token, next: tokens[index + 1], reserved })) {
      // Pattern syntax: a `(` before or `)` after a case pattern is no group.
    } else if (isOperator(token, OPEN_BRACE)) {
      groups.push({
        close: "}",
        functionBody: opensFunctionBody(tokens, index),
      });
    } else if (isOperator(token, OPEN_PAREN)) {
      groups.push({ close: ")", functionBody: false });
    } else if (isOperator(token, CLOSE_BRACE) && groups.at(-1)?.close === "}") {
      groups.pop();
    } else if (isOperator(token, CLOSE_PAREN) && groups.at(-1)?.close === ")") {
      groups.pop();
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
        groups,
      })
    ) {
      findings.push({
        file,
        line: lineOffset + token.line,
        source: (lines[token.line - 1] ?? "").trim(),
      });
    }
    const timed = startsTimedPipeline(token, reserved, timePrefix);
    commandPosition = timed || startsCommand(token, reserved);
    timePrefix = timed;
  }
  return findings;
};

// Matches a `run:` mapping key line; block scalars start on the next line.
const RUN_KEY = /^\s*(?:-\s+)?run:/u;
const RUN_BLOCK_SCALAR = /^\s*(?:-\s+)?run:\s*[|>]/u;

// Every `run` key in document order; non-string values (e.g. `defaults.run`)
// keep their slot so the order lines up with the key lines. A YAML alias
// (`- *step`) parses to the anchored node itself and writes no key line of
// its own, so each node is walked once, at its anchor, where its key lines
// are. A merge key (`<<: *step`) copies keys into a new node instead; that
// copy has no key line of its own and fails closed.
const collectRunValues = (
  value: unknown,
  runs: unknown[],
  seen = new Set<object>(),
) => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRunValues(item, runs, seen);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "run") {
      runs.push(child);
    }
    collectRunValues(child, runs, seen);
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
  const keyLines: { index: number; blockScalar: boolean }[] = [];
  // Lines inside a block scalar are script text, never mapping keys.
  let scalarIndent: number | undefined;
  for (const [index, line] of source.split("\n").entries()) {
    const indent = line.length - line.trimStart().length;
    if (scalarIndent !== undefined) {
      if (line.trim() === "" || indent > scalarIndent) {
        continue;
      }
      scalarIndent = undefined;
    }
    if (/:\s*[|>][1-9+-]*\s*(?:#.*)?$/u.test(line)) {
      scalarIndent = indent;
    }
    if (RUN_KEY.test(line)) {
      keyLines.push({ index, blockScalar: RUN_BLOCK_SCALAR.test(line) });
    }
  }
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

// Readers that can stop before end of input: `head`, and searches that stop
// at a first match or a match limit.
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);
const EARLY_EXIT_SHORT_OPTIONS = new Set(["q", "m", "l"]);
// Short options whose value is the rest of the cluster or the next word.
const VALUE_SHORT_OPTIONS = new Set(["e", "f", "A", "B", "C", "d", "D"]);
const EARLY_EXIT_LONG_OPTION =
  /^--(?:quiet|silent|max-count|files-with-matches)(?:=|$)/u;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;

// Whether a search's option clusters ask it to stop early. The value of
// `-e`, `-A` and the like is skipped, so `-e -q` searches for "-q".
const searchExitsEarly = (options: readonly string[]): boolean => {
  let valueNext = false;
  for (const value of options) {
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (value === "--") {
      return false;
    }
    if (EARLY_EXIT_LONG_OPTION.test(value)) {
      return true;
    }
    if (!/^-[A-Za-z0-9]/u.test(value)) {
      continue;
    }
    // Short options are ASCII letters, one code unit each.
    for (let index = 1; index < value.length; index += 1) {
      const letter = value.charAt(index);
      if (EARLY_EXIT_SHORT_OPTIONS.has(letter)) {
        return true;
      }
      if (VALUE_SHORT_OPTIONS.has(letter)) {
        valueNext = index === value.length - 1;
        break;
      }
    }
  }
  return false;
};

// Quoting belongs to syntax parsing; readers receive the decoded word values.
const exitsEarly = (words: readonly string[]): boolean => {
  const commandIndex = words.findIndex((word) => !ASSIGNMENT_WORD.test(word));
  if (commandIndex === -1) {
    return false;
  }
  const command = words.at(commandIndex);
  if (command === undefined) {
    return false;
  }
  if (command === "head") {
    return true;
  }
  return (
    SEARCH_COMMANDS.has(command) &&
    searchExitsEarly(words.slice(commandIndex + 1))
  );
};

type EarlyExitSource = ShellSource & {
  // Reports the original line, so substitutions show their whole statement.
  readonly display: (line: number) => string;
};

// Under pipefail a reader that exits before end of input kills its writer
// with SIGPIPE, so a pipeline that found its match can still fail.
const earlyExitPipeFindings = ({
  file,
  lineOffset,
  source,
  display,
}: EarlyExitSource): ShellStatusFinding[] => {
  const { tokens, substitutions } = lexShell(source);
  const findings: ShellStatusFinding[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!isOperator(token, PIPES)) {
      continue;
    }
    // A pipe may end a line; its reader starts after newlines and comments.
    let start = index + 1;
    while (isOperator(tokens[start], LINE_BREAKS)) {
      start += 1;
    }
    const end = tokens.findIndex(
      (candidate, position) =>
        position >= start && candidate.type === "operator",
    );
    const words = tokens.slice(start, end === -1 ? tokens.length : end);
    const reader = words.at(0);
    if (reader === undefined || !exitsEarly(words.map(({ value }) => value))) {
      continue;
    }
    const line = lineOffset + reader.line;
    findings.push({ file, line, source: display(line).trim() });
  }
  for (const substitution of substitutions) {
    findings.push(
      ...earlyExitPipeFindings({
        file,
        lineOffset: lineOffset + substitution.line - 1,
        source: substitution.source,
        display,
      }),
    );
  }
  return findings;
};

const earlyExitPipeBlockFindings = (block: ShellSource) => {
  const lines = block.source.split("\n");
  const findings = earlyExitPipeFindings({
    ...block,
    display: (line) => lines[line - block.lineOffset - 1] ?? "",
  });
  // A substitution nested in a quoted substitution is lexed at both levels.
  return [
    ...new Map(findings.map((finding) => [finding.line, finding])).values(),
  ];
};

type ShellRule = (block: ShellSource) => ShellStatusFinding[];

const findShellRuleViolations = (
  sources: ReadonlyMap<string, string>,
  rule: ShellRule,
): ShellStatusFinding[] => {
  const findings: ShellStatusFinding[] = [];
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
        findings.push(...rule(block));
      }
      continue;
    }
    if (SHELL_FILE.test(file) || BASH_SHEBANG.test(source)) {
      findings.push(...rule({ file, lineOffset: 0, source }));
    }
  }
  return findings;
};

export const findStandaloneNegatedShellStatements = (
  sources: ReadonlyMap<string, string>,
) => findShellRuleViolations(sources, shellFindings);

// `stll-cloud-setup` (from @stll/oxlint-config) renders this file and the
// generated-file check rejects hand edits, so its fix lands in that renderer.
// An entry is reported once its file no longer needs it.
const EARLY_EXIT_PIPE_EXEMPTIONS = new Set([".agents/cloud-setup.sh"]);

export type EarlyExitPipeReport = {
  readonly violations: readonly ShellStatusFinding[];
  readonly staleExemptions: readonly string[];
};

export const findEarlyExitPipelines = (
  sources: ReadonlyMap<string, string>,
): EarlyExitPipeReport => {
  const findings = findShellRuleViolations(sources, earlyExitPipeBlockFindings);
  const flagged = new Set(findings.map(({ file }) => file));
  return {
    violations: findings.filter(
      ({ file }) => !EARLY_EXIT_PIPE_EXEMPTIONS.has(file),
    ),
    staleExemptions: [...EARLY_EXIT_PIPE_EXEMPTIONS].filter(
      (file) => sources.has(file) && !flagged.has(file),
    ),
  };
};

const trackedSources = (): Map<string, string> => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    maxBuffer: 2 ** 30,
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

const RULE_MESSAGES = {
  negation: "standalone negation cannot enforce failure under set -e",
  earlyExitPipe:
    "reader can exit before its writer, so pipefail can fail a matching pipeline; read a here-string or file instead",
  staleExemption: "exempt from the early-exit pipe rule without needing it",
} as const;

if (import.meta.main) {
  const sources = trackedSources();
  const earlyExitPipes = findEarlyExitPipelines(sources);
  const findings = [
    ...findStandaloneNegatedShellStatements(sources).map((finding) => ({
      finding,
      message: RULE_MESSAGES.negation,
    })),
    ...earlyExitPipes.violations.map((finding) => ({
      finding,
      message: RULE_MESSAGES.earlyExitPipe,
    })),
    ...earlyExitPipes.staleExemptions.map((file) => ({
      finding: {
        file,
        line: 1,
        source: "remove its EARLY_EXIT_PIPE_EXEMPTIONS entry",
      },
      message: RULE_MESSAGES.staleExemption,
    })),
  ];
  if (findings.length === 0) {
    process.stdout.write("Shell exit-status guard passed: 0 violations.\n");
  } else {
    for (const { finding, message } of findings) {
      process.stderr.write(
        `${finding.file}:${finding.line}: ${message}: ${finding.source}\n`,
      );
    }
    process.exitCode = 1;
  }
}
