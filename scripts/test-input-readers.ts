import { readFileSync } from "node:fs";
import path from "node:path";

// This reader also runs before CI installs dependencies.
class TestInputDeclarationError extends Error {
  override name = "TestInputDeclarationError";
  readonly _tag = "TestInputDeclarationError";
}

const TURBO_CONFIG = "turbo.json";
const TURBO_ROOT_INPUT_PREFIX = "$TURBO_ROOT$/";
const TEST_TASK_SUFFIX = "#test";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/u;
const WHITESPACE = /\s/u;
/** A `/` here opens a regular expression rather than continuing an expression. */
const REGEX_PRECEDING = new Set([
  "!",
  "&",
  "(",
  ",",
  ":",
  ";",
  "=",
  "?",
  "[",
  "{",
  "|",
  "}",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
  "\n",
]);

type SourceLiteral = {
  readonly callee: string | undefined;
  readonly line: number;
  readonly value: string;
};

const calleeBefore = (source: string, open: number): string | undefined => {
  let end = open - 1;
  while (end >= 0 && WHITESPACE.test(source.charAt(end))) {
    end -= 1;
  }
  let start = end;
  while (start >= 0 && IDENTIFIER_CHARACTER.test(source.charAt(start))) {
    start -= 1;
  }
  return start === end ? undefined : source.slice(start + 1, end + 1);
};

type ScanState = {
  index: number;
  line: number;
};

/**
 * Consumes a quoted or template literal, returning its static text. A quote
 * that never closes on its line is JSX prose (`don't`), not a literal: the scan
 * rewinds past it rather than swallowing the rest of the file.
 */
const readQuoted = (
  source: string,
  state: ScanState,
  quote: string,
): string | undefined => {
  const start = state.index;
  const startLine = state.line;
  let value = "";
  let dynamic = false;
  state.index += 1;
  while (state.index < source.length) {
    const char = source.charAt(state.index);
    if (char === "\\") {
      value += source.charAt(state.index + 1);
      state.index += 2;
      continue;
    }
    if (char === quote) {
      state.index += 1;
      return dynamic ? undefined : value;
    }
    if (char === "\n") {
      if (quote !== "`") {
        break;
      }
      state.line += 1;
    }
    if (
      quote === "`" &&
      char === "$" &&
      source.charAt(state.index + 1) === "{"
    ) {
      dynamic = true;
    }
    value += char;
    state.index += 1;
  }
  state.index = start + 1;
  state.line = startLine;
  return undefined;
};

/**
 * Every static string literal in a TypeScript source, tagged with the callee of
 * the innermost call that encloses it. Comments and regular expressions are
 * skipped so a commented-out path or a character class cannot be read as one.
 */
export const readStringLiterals = (
  source: string,
  onCall?: (callee: string | undefined, source: string, start: number) => void,
): readonly SourceLiteral[] => {
  const literals: SourceLiteral[] = [];
  const calls: { callee: string | undefined; start: number }[] = [];
  const state: ScanState = { index: 0, line: 1 };
  let previousSignificant = "\n";

  while (state.index < source.length) {
    const char = source.charAt(state.index);
    const next = source.charAt(state.index + 1);

    if (char === "\n") {
      state.line += 1;
      state.index += 1;
      continue;
    }
    if (WHITESPACE.test(char)) {
      state.index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", state.index);
      state.index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", state.index + 2);
      const stop = end === -1 ? source.length : end + 2;
      state.line += source.slice(state.index, stop).split("\n").length - 1;
      state.index = stop;
      continue;
    }
    if (char === "/" && REGEX_PRECEDING.has(previousSignificant)) {
      state.index += 1;
      let inClass = false;
      while (state.index < source.length) {
        const regexChar = source.charAt(state.index);
        if (regexChar === "\\") {
          state.index += 2;
          continue;
        }
        if (regexChar === "[") {
          inClass = true;
        } else if (regexChar === "]") {
          inClass = false;
        } else if (regexChar === "/" && !inClass) {
          state.index += 1;
          break;
        } else if (regexChar === "\n") {
          break;
        }
        state.index += 1;
      }
      previousSignificant = "/";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const line = state.line;
      const value = readQuoted(source, state, char);
      if (value !== undefined) {
        literals.push({ callee: calls.at(-1)?.callee, line, value });
      }
      previousSignificant = char;
      continue;
    }
    if (char === "(") {
      calls.push({
        callee: calleeBefore(source, state.index),
        start: state.index,
      });
    } else if (char === ")") {
      const call = calls.pop();
      if (call) {
        onCall?.(
          call.callee,
          source.slice(call.start, state.index + 1),
          call.start,
        );
      }
    }
    previousSignificant = char;
    state.index += 1;
  }

  return literals;
};

/** A flat call options object containing only static string values. */
export const readLiteralCallOptions = (
  source: string,
): ReadonlyMap<string, string> | undefined => {
  const state: ScanState = { index: 0, line: 1 };
  const skipSpace = () => {
    while (
      WHITESPACE.test(source.charAt(state.index)) &&
      state.index < source.length
    ) {
      state.index += 1;
    }
  };
  const take = (token: string) => {
    skipSpace();
    if (source.charAt(state.index) !== token) {
      return false;
    }
    state.index += 1;
    return true;
  };
  if (!take("(") || !take("{")) {
    return undefined;
  }
  const options = new Map<string, string>();
  skipSpace();
  while (source.charAt(state.index) !== "}") {
    const start = state.index;
    while (IDENTIFIER_CHARACTER.test(source.charAt(state.index))) {
      state.index += 1;
    }
    const key = source.slice(start, state.index);
    if (!key || options.has(key) || !take(":")) {
      return undefined;
    }
    skipSpace();
    const quote = source.charAt(state.index);
    if (quote !== '"' && quote !== "'") {
      return undefined;
    }
    const quotedStart = state.index;
    const value = readQuoted(source, state, quote);
    if (
      value === undefined ||
      source.slice(quotedStart, state.index).includes("\\")
    ) {
      return undefined;
    }
    options.set(key, value);
    skipSpace();
    if (source.charAt(state.index) === "}") {
      break;
    }
    if (!take(",")) {
      return undefined;
    }
    skipSpace();
  }
  if (!take("}") || !take(")")) {
    return undefined;
  }
  skipSpace();
  return state.index === source.length ? options : undefined;
};

export const readTestInputs = (
  root: string,
): ReadonlyMap<string, readonly string[]> => {
  const parsed: unknown = Bun.JSONC.parse(
    readFileSync(path.join(root, TURBO_CONFIG), "utf-8"),
  );
  const tasks = isRecord(parsed) ? parsed["tasks"] : undefined;
  if (!isRecord(tasks)) {
    throw new TestInputDeclarationError(`${TURBO_CONFIG} must declare tasks`);
  }
  const inputs = new Map<string, readonly string[]>();
  for (const [task, definition] of Object.entries(tasks)) {
    if (!task.endsWith(TEST_TASK_SUFFIX) || !isRecord(definition)) {
      continue;
    }
    const declared = definition["inputs"];
    if (declared === undefined) {
      continue;
    }
    if (
      !Array.isArray(declared) ||
      declared.some((entry) => typeof entry !== "string")
    ) {
      throw new TestInputDeclarationError(
        `${TURBO_CONFIG}: ${task}.inputs must be strings`,
      );
    }
    inputs.set(
      task.slice(0, -TEST_TASK_SUFFIX.length),
      declared
        .filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            entry.startsWith(TURBO_ROOT_INPUT_PREFIX),
        )
        .map((entry) => entry.slice(TURBO_ROOT_INPUT_PREFIX.length)),
    );
  }
  return inputs;
};

// Split call arguments without treating commas inside literals or nested calls
// as separators. Unknown/computed expressions remain source for the caller.
export const readCallArguments = (source: string): readonly string[] => {
  const args: string[] = [];
  const state = { index: 1, line: 1 };
  let start = 1;
  let depth = 0;
  while (state.index < source.length - 1) {
    const char = source.charAt(state.index);
    if (char === '"' || char === "'" || char === "`") {
      readQuoted(source, state, char);
      continue;
    }
    if (["(", "[", "{"].includes(char)) {
      depth += 1;
    }
    if ([")", "]", "}"].includes(char)) {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      args.push(source.slice(start, state.index).trim());
      start = state.index + 1;
    }
    state.index += 1;
  }
  const last = source.slice(start, -1).trim();
  if (last) {
    args.push(last);
  }
  return args;
};
