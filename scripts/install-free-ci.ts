/**
 * Finds every Bun invocation a workflow can run before or without the
 * dependency install, and classifies what each one loads.
 *
 * Several CI steps run without the install on purpose (a pull request that
 * skips the package checks skips the install too), so whatever they run must
 * work from a bare checkout. `scripts/install-free-ci.test.ts` checks the
 * result: every invocation is classified, and every file it loads imports
 * built-in modules only.
 *
 * Install detection is exact rather than by step name:
 * - An install is a `bun install` / `bun i` / `bun ci` / `bun add` command
 *   (directly or through `bash scripts/retry.sh`) that is not global. It
 *   covers the commands that run in its directory or below it.
 * - Inside a step, the commands after the install are covered. A later step
 *   is covered when its `if:` implies the install step's `if:`: every
 *   top-level `&&` operand of the install condition is an operand of the
 *   step's condition, or is an `||` expression one of whose operands is.
 *   A guard requiring the install step's successful outcome also covers it,
 *   including when that install allows failure with `continue-on-error`.
 * - A local composite action's steps are walked in place, and an
 *   unconditional install inside one counts as an install by the step that
 *   uses it. A job that calls a local reusable workflow is walked as that
 *   workflow.
 *
 * `bun run <script>` and `bun --filter <package> <script>` expand to the
 * package.json script's commands; there, any program besides Bun and a few
 * shell builtins may come from the install. Whatever the walk cannot follow
 * (a computed path, an unknown flag, Bun handed to another program) is
 * unclassified, and the test fails on it. Literal Bun subprocess arrays that
 * launch installed CLIs are checked too. Other subprocess commands remain
 * outside this import walk.
 *
 * Needs no dependency install: node builtins and Bun APIs only.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  mergeWorkflowParallelProofs,
  synchronizeWorkflowBackgroundSteps,
} from "./workflow-steps";

export type Classification =
  /** Files Bun loads: a script, test files and preloads. */
  | {
      readonly type: "files";
      readonly cwd: string;
      readonly entries: readonly string[];
    }
  /** Inline code passed to `bun -e` or `bun -p`. */
  | { readonly type: "eval"; readonly cwd: string; readonly code: string }
  | { readonly type: "install"; readonly dir: string; readonly global: boolean }
  /** `bunx`, `bun x` or `npx`: fetches the named package to run it. */
  | { readonly type: "fetch" }
  | { readonly type: "unclassified"; readonly reason: string };

export type InstallFreeInvocation = {
  readonly job: string;
  readonly step: string;
  /** The command as written; a package script shows its expansion chain. */
  readonly command: string;
  readonly classification: Classification;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Shell lexing

/** A heredoc's body, filled in once the lexer reads past the command's line. */
type Heredoc = { delimiter: string; stripTabs: boolean; body: string };

export type ShellEvent =
  | {
      readonly type: "command";
      readonly words: readonly string[];
      /** The heredoc on the command's standard input, if any. */
      readonly stdin?: { readonly body: string };
    }
  | { readonly type: "subshell-start" }
  | { readonly type: "subshell-end" }
  | { readonly type: "control-flow" }
  | { readonly type: "unparsed"; readonly reason: string };

const OPERATOR_CHARACTERS = new Set([";", "&", "|", "(", ")", "<", ">"]);
const SUBSTITUTION = "$(…)";
// These constructs can skip commands or run them without waiting for completion.
const SHELL_CONTROL_FLOW = new Set([
  "if",
  "elif",
  "else",
  "fi",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "!",
]);

const isBlank = (character: string) =>
  character === " " || character === "\t" || character === "\r";

type AppendShellCommandOptions = {
  events: ShellEvent[];
  words: string[];
  commandStart: number;
  controlFlow: boolean;
  stdin: Heredoc | undefined;
};

const appendShellCommand = ({
  events,
  words,
  commandStart,
  controlFlow,
  stdin,
}: AppendShellCommandOptions) => {
  if (controlFlow || SHELL_CONTROL_FLOW.has(words[0] ?? "")) {
    // Precede substitutions too: they belong to this command's branch.
    events.splice(commandStart, 0, { type: "control-flow" });
  }
  if (words.length > 0) {
    events.push(
      stdin === undefined
        ? { type: "command", words }
        : { type: "command", words, stdin },
    );
  }
};

/** The index just past a `${…}` expansion, which may nest and quote. */
const parameterEnd = (source: string, index: number): number | undefined => {
  let depth = 0;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 1;
    } else if (character === "'" || character === '"') {
      const end = source.indexOf(character, cursor + 1);
      cursor = end === -1 ? source.length : end;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }
  return undefined;
};

type SkipHeredocBodiesOptions = {
  source: string;
  index: number;
  pendingHeredocs: Heredoc[];
};

/** A heredoc on stdin, `null` for another stdin source, `undefined` for neither. */
type Redirected = Heredoc | null | undefined;

const nextStdin = (
  current: Heredoc | undefined,
  redirected: Redirected,
): Heredoc | undefined =>
  redirected === undefined ? current : (redirected ?? undefined);

/** Queues the body a `<<` or `<<-` operator introduces; `null` otherwise. */
const queueHeredoc = (
  operator: string,
  delimiter: string,
  pending: Heredoc[],
): Heredoc | null => {
  if (operator !== "<<" && operator !== "<<-") {
    return null;
  }
  const heredoc = { body: "", delimiter, stripTabs: operator === "<<-" };
  pending.push(heredoc);
  return heredoc;
};

const skipHeredocBodies = ({
  source,
  index: start,
  pendingHeredocs,
}: SkipHeredocBodiesOptions): number => {
  let index = start;
  for (const heredoc of pendingHeredocs.splice(0)) {
    const lines: string[] = [];
    while (index < source.length) {
      const end = source.indexOf("\n", index);
      const raw = source.slice(index, end === -1 ? source.length : end);
      const line = heredoc.stripTabs ? raw.replace(/^\t+/u, "") : raw;
      index = end === -1 ? source.length : end + 1;
      if (line === heredoc.delimiter) {
        break;
      }
      lines.push(line);
    }
    heredoc.body = lines.join("\n");
  }
  return index;
};

const readSingleQuoted = (source: string, start: number) => {
  const end = source.indexOf("'", start + 1);
  return {
    text: end === -1 ? "" : source.slice(start + 1, end),
    index: end === -1 ? source.length : end + 1,
    failure: end === -1 ? "unterminated single quote" : undefined,
  };
};

const readAnsiQuoted = (source: string, start: number) => {
  let text = "";
  let index = start + 2;
  let failure: string | undefined;
  while (index < source.length && source[index] !== "'") {
    const character = source[index] ?? "";
    if (character !== "\\") {
      text += character;
      index += 1;
      continue;
    }
    const escape = source[index + 1] ?? "";
    const octal = /^[0-7]{1,3}/u.exec(source.slice(index + 1))?.[0];
    const hex =
      escape === "x"
        ? /^[0-9a-f]{1,2}/iu.exec(source.slice(index + 2))?.[0]
        : undefined;
    const numeric = octal ?? hex;
    if (numeric !== undefined) {
      text += String.fromCodePoint(
        (octal === undefined
          ? Number.parseInt(numeric, 16)
          : Number.parseInt(numeric, 8)) % 256,
      );
      index += numeric.length + (octal === undefined ? 2 : 1);
      continue;
    }
    switch (escape) {
      case "a":
        text += "\u0007";
        break;
      case "b":
        text += "\b";
        break;
      case "e":
      case "E":
        text += "\u001b";
        break;
      case "f":
        text += "\f";
        break;
      case "n":
        text += "\n";
        break;
      case "r":
        text += "\r";
        break;
      case "t":
        text += "\t";
        break;
      case "v":
        text += "\v";
        break;
      case "'":
      case '"':
      case "\\":
        text += escape;
        break;
      case "u":
      case "U":
      case "c":
        failure ??= `unsupported ANSI-C escape \\${escape}`;
        break;
      default:
        text += `\\${escape}`;
    }
    index += 2;
  }
  if (source[index] !== "'") {
    failure ??= "unterminated ANSI-C quote";
  }
  index += 1;
  // Shell words cannot contain NUL; the rest of this quoted segment is discarded.
  return { text: text.split("\0").at(0) ?? "", index, failure };
};

/**
 * Splits shell source into simple commands, in execution order. Quotes are
 * removed; a command substitution (`$(…)`, backticks) or subshell becomes
 * its own subshell-delimited commands, ahead of the command that uses it.
 * Comments are skipped; a heredoc on a command's standard input becomes its
 * `stdin`, and other heredoc bodies are skipped. It is not a full shell parser: an
 * unterminated quote or substitution yields an `unparsed` event.
 */
export const lexShell = (source: string): ShellEvent[] => {
  const events: ShellEvent[] = [];
  const pendingHeredocs: Heredoc[] = [];
  let index = 0;
  let failure: string | undefined;

  const readSubstitution = (closing: ")" | "`"): void => {
    events.push({ type: "subshell-start" });
    readList(closing);
    if (source[index] !== closing) {
      failure ??= `unterminated ${closing === ")" ? "$(" : "`"}`;
    }
    index += 1;
    events.push({ type: "subshell-end" });
  };

  const readDoubleQuoted = (): string => {
    let text = "";
    index += 1;
    while (index < source.length && source[index] !== '"') {
      const character = source[index] ?? "";
      const next = source[index + 1] ?? "";
      if (character === "\\" && '$`"\\\n'.includes(next)) {
        text += next === "\n" ? "" : next;
        index += 2;
      } else if (character === "$" && next === "(") {
        index += 2;
        readSubstitution(")");
        text += SUBSTITUTION;
      } else if (character === "`") {
        index += 1;
        readSubstitution("`");
        text += SUBSTITUTION;
      } else if (character === "$" && next === "{") {
        const stop = parameterEnd(source, index);
        if (stop === undefined) {
          failure ??= "unterminated ${";
        }
        text += source.slice(index, stop ?? source.length);
        index = stop ?? source.length;
      } else {
        text += character;
        index += 1;
      }
    }
    if (source[index] !== '"') {
      failure ??= "unterminated double quote";
    }
    index += 1;
    return text;
  };

  /** One word with its quotes removed, or undefined when none starts here. */
  const readWord = (): string | undefined => {
    let text = "";
    let consumed = false;
    while (index < source.length && failure === undefined) {
      const character = source[index] ?? "";
      const next = source[index + 1] ?? "";
      if (
        isBlank(character) ||
        character === "\n" ||
        OPERATOR_CHARACTERS.has(character)
      ) {
        break;
      }
      consumed = true;
      if (character === "\\") {
        text += next === "\n" ? "" : next;
        index += 2;
      } else if (character === "'" || (character === "$" && next === "'")) {
        const quoted = (character === "$" ? readAnsiQuoted : readSingleQuoted)(
          source,
          index,
        );
        text += quoted.text;
        index = quoted.index;
        failure ??= quoted.failure;
      } else if (character === '"') {
        text += readDoubleQuoted();
      } else if (character === "$" && next === "(") {
        index += 2;
        readSubstitution(")");
        text += SUBSTITUTION;
      } else if (character === "`") {
        index += 1;
        readSubstitution("`");
        text += SUBSTITUTION;
      } else if (character === "$" && next === "{") {
        const stop = parameterEnd(source, index);
        if (stop === undefined) {
          failure ??= "unterminated ${";
        }
        text += source.slice(index, stop ?? source.length);
        index = stop ?? source.length;
      } else {
        text += character;
        index += 1;
      }
    }
    return consumed ? text : undefined;
  };

  /** Reads one redirection; returns stdin's new source (see `nextStdin`). */
  const readRedirection = (words: string[], adjacent: boolean): Redirected => {
    // A file-descriptor prefix (`2>&1`) belongs to the redirection.
    const descriptor =
      adjacent && /^\d+$/u.test(words.at(-1) ?? "") ? words.pop() : undefined;
    const operator =
      /^(?:<<<|<<-|<<|>>|>&|<&|>\||[<>])/u.exec(source.slice(index))?.[0] ?? "";
    index += operator.length;
    const readsStdin = operator.startsWith("<") && (descriptor ?? "0") === "0";
    while (isBlank(source[index] ?? "")) {
      index += 1;
    }
    if (source[index] === "(") {
      // Process substitution, `<(…)`: the caller reads it as a subshell.
      return readsStdin ? null : undefined;
    }
    const heredoc = queueHeredoc(operator, readWord() ?? "", pendingHeredocs);
    return readsStdin ? heredoc : undefined;
  };

  const readList = (closing: ")" | "`" | "}" | undefined): void => {
    let commandStart = events.length;
    let words: string[] = [];
    let stdin: Heredoc | undefined;
    let wordEnd = -1;
    let compoundStart: number | undefined;
    const flush = (controlFlow = false) => {
      appendShellCommand({
        events,
        words,
        commandStart: compoundStart ?? commandStart,
        controlFlow,
        stdin,
      });
      compoundStart = undefined;
      words = [];
      stdin = undefined;
      commandStart = events.length;
    };
    while (index < source.length) {
      const character = source[index] ?? "";
      // A nested read that fails stops the whole lex.
      if (
        (character === closing &&
          (closing !== "}" || /[\s;&|)]|^$/u.test(source[index + 1] ?? ""))) ||
        failure !== undefined
      ) {
        break;
      }
      if (character === "\n") {
        flush();
        index += 1;
        index = skipHeredocBodies({ source, index, pendingHeredocs });
      } else if (isBlank(character)) {
        index += 1;
      } else if (character === "\\" && source[index + 1] === "\n") {
        index += 2;
      } else if (character === "#") {
        const end = source.indexOf("\n", index);
        index = end === -1 ? source.length : end;
      } else if (character === ";" || character === "&" || character === "|") {
        flush(character !== ";");
        index += 1;
      } else if (character === "(") {
        flush();
        index += 1;
        const start = events.length;
        readSubstitution(")");
        compoundStart = start;
      } else if (
        character === "{" &&
        words.length === 0 &&
        (isBlank(source[index + 1] ?? "") || source[index + 1] === "\n")
      ) {
        flush();
        index += 1;
        const start = events.length;
        readList("}");
        if (source[index] !== "}") {
          failure ??= "unterminated brace group";
        }
        index += 1;
        compoundStart = start;
      } else if (character === ")") {
        // An unmatched `)`, as after a `case` pattern, ends the command.
        flush();
        index += 1;
      } else if (character === "<" || character === ">") {
        stdin = nextStdin(stdin, readRedirection(words, wordEnd === index));
      } else {
        const word = readWord();
        if (word !== undefined) {
          words.push(word);
          wordEnd = index;
        }
      }
    }
    flush();
  };

  readList(undefined);
  if (failure !== undefined) {
    events.push({ reason: failure, type: "unparsed" });
  }
  return events;
};

// ---------------------------------------------------------------------------
// Step conditions

const OUTER_EXPRESSION = /^\$\{\{([\s\S]*)\}\}$/u;

const wrapsWhole = (expression: string): boolean => {
  if (!expression.startsWith("(") || !expression.endsWith(")")) {
    return false;
  }
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === "(") {
      depth += 1;
    } else if (expression[index] === ")") {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) {
        return false;
      }
    }
  }
  return true;
};

const unwrap = (expression: string): string => {
  const collapsed = expression.replaceAll(/\s+/gu, " ").trim();
  let result = (OUTER_EXPRESSION.exec(collapsed)?.[1] ?? collapsed).trim();
  while (wrapsWhole(result)) {
    result = result.slice(1, -1).trim();
  }
  return result;
};

/** Splits on `operator` outside parentheses and quoted strings. */
const splitTopLevel = (expression: string, operator: "&&" | "||"): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "'") {
      quoted = !quoted;
    } else if (!quoted && character === "(") {
      depth += 1;
    } else if (!quoted && character === ")") {
      depth -= 1;
    } else if (
      !quoted &&
      depth === 0 &&
      expression.startsWith(operator, index)
    ) {
      parts.push(expression.slice(start, index));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map(unwrap);
};

/** The top-level `&&` operands of an `if:`; none when there is no `if:`. */
export const conditionOperands = (condition: unknown): string[] => {
  if (condition === undefined || condition === null) {
    return [];
  }
  // A YAML `if:` may also be a bare boolean or number.
  const expression = unwrap(
    typeof condition === "string" ? condition : JSON.stringify(condition),
  );
  if (splitTopLevel(expression, "||").length > 1) {
    return [expression];
  }
  return splitTopLevel(expression, "&&");
};

type ImpliesConditionOptions = {
  /** The install step's `if:` operands. */
  readonly install: readonly string[];
  /** The later step's `if:` operands. */
  readonly step: readonly string[];
};

const impliesOperand = (expression: string, operand: string): boolean => {
  if (expression === operand) {
    return true;
  }
  const alternatives = splitTopLevel(expression, "||");
  if (alternatives.length > 1) {
    return alternatives.every((alternative) =>
      impliesOperand(alternative, operand),
    );
  }
  const conjunction = splitTopLevel(expression, "&&");
  return (
    conjunction.length > 1 &&
    conjunction.some((part) => impliesOperand(part, operand))
  );
};

/** Whether a step guarded by `step` runs only when `install` held. */
export const impliesCondition = ({
  install,
  step,
}: ImpliesConditionOptions): boolean =>
  install.every(
    (operand) =>
      step.some((expression) => impliesOperand(expression, operand)) ||
      splitTopLevel(operand, "||").some((disjunct) =>
        step.some((expression) => impliesOperand(expression, disjunct)),
      ),
  );

// ---------------------------------------------------------------------------
// Bun command classification

const SHELL_PREFIXES = new Set([
  "!",
  "{",
  "}",
  "do",
  "elif",
  "else",
  "exec",
  "fi",
  "if",
  "nohup",
  "then",
  "time",
  "until",
  "while",
]);
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/u;
const BUN_PROGRAMS = new Set(["bun", "bunx", "npx"]);
/** Shell builtins a package script may run besides Bun. */
const SCRIPT_BUILTINS = new Set([
  "[",
  "cd",
  "echo",
  "exit",
  "false",
  "printf",
  "set",
  "test",
  "true",
]);
const INSTALL_SUBCOMMANDS = new Set(["add", "ci", "i", "install"]);
const BUN_BUILTIN_SUBCOMMANDS = new Set([
  "audit",
  "build",
  "create",
  "exec",
  "info",
  "init",
  "link",
  "outdated",
  "patch",
  "pm",
  "publish",
  "remove",
  "repl",
  "unlink",
  "update",
  "upgrade",
  "why",
]);
const BUN_SWITCHES = new Set([
  "--bun",
  "--hot",
  "--no-env-file",
  "--no-install",
  "--no-orphans",
  "--silent",
  "--smol",
  "--watch",
]);
const BUN_VALUE_FLAGS = new Set([
  "--cwd",
  "--env-file",
  "--eval",
  "--filter",
  "--port",
  "--preload",
  "--print",
  "-F",
  "-e",
  "-p",
  "-r",
]);
export const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TEST_FILE = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;

/** A directory only known at run time; never covered by a repository path. */
const isComputed = (dir: string) => dir.includes("$");

type ChangeDirectoryOptions = {
  readonly from: string;
  /** The `cd` argument; undefined for a bare `cd`. */
  readonly to: string | undefined;
};

/** The repo-relative directory after `cd`, or a computed `$…` marker. */
const changeDirectory = ({ from, to }: ChangeDirectoryOptions): string => {
  if (to === undefined || to === "-" || isComputed(from)) {
    return "$PWD";
  }
  if (isComputed(to) || path.posix.isAbsolute(to)) {
    return `$(${to})`;
  }
  const joined = path.posix.normalize(path.posix.join(from, to));
  return joined === "." ? "" : joined;
};

const TIMEOUT_DURATION = /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/u;

/** The program and its arguments, past keywords, assignments and wrappers. */
export const programWords = (words: readonly string[]): readonly string[] => {
  let rest = words;
  for (;;) {
    const first = rest.at(0);
    if (first === undefined) {
      return rest;
    }
    if (SHELL_PREFIXES.has(first) || ASSIGNMENT.test(first)) {
      rest = rest.slice(1);
    } else if (first === "env") {
      rest = rest.slice(1);
      while (rest.at(0)?.startsWith("-") === true) {
        rest = rest.slice(1);
      }
    } else if (first === "timeout") {
      rest = rest.slice(1);
      while (rest.at(0)?.startsWith("-") === true) {
        const option = rest.at(0);
        if (option === "--") {
          rest = rest.slice(1);
          break;
        }
        if (["-k", "--kill-after", "-s", "--signal"].includes(option ?? "")) {
          if (
            ["-k", "--kill-after"].includes(option ?? "") &&
            !TIMEOUT_DURATION.test(rest.at(1) ?? "")
          ) {
            return words;
          }
          rest = rest.slice(2);
        } else if (
          ["--preserve-status", "--foreground", "--verbose", "-v"].includes(
            option ?? "",
          ) ||
          /^(?:--(?:kill-after|signal)=|-[ks].+)/u.test(option ?? "")
        ) {
          if (
            /^(?:--kill-after=|-k.)/u.test(option ?? "") &&
            !TIMEOUT_DURATION.test(
              (option ?? "").replace(/^(?:--kill-after=|-k)/u, ""),
            )
          ) {
            return words;
          }
          rest = rest.slice(1);
        } else {
          // --help/--version can exit successfully without running the child.
          return words;
        }
      }
      if (!TIMEOUT_DURATION.test(rest.at(0) ?? "")) {
        return words;
      }
      rest = rest.slice(1); // Duration precedes the wrapped command.
    } else if (first === "bash" && rest.at(1) === "scripts/retry.sh") {
      rest = rest.slice(2);
    } else {
      return rest;
    }
  }
};

type ResolvedPath =
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "invalid"; readonly reason: string };

type CheckoutSource = {
  readonly prefix: string;
  readonly sparse: readonly string[] | undefined;
  readonly condition: readonly string[];
};

const includedInSparseCheckout = (
  file: string,
  patterns: readonly string[],
) => {
  let included = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = rawPattern
      .replace(/^!/u, "")
      .replace(/^\//u, "")
      .replace(/\/$/u, "");
    if (
      file === pattern ||
      file.startsWith(`${pattern}/`) ||
      new Bun.Glob(pattern).match(file)
    ) {
      included = !excluded;
    }
  }
  return included;
};

type ResolveRepoPathOptions = {
  readonly cwd: string;
  readonly root: string;
  readonly target: string;
  readonly checkouts: readonly CheckoutSource[];
};

const resolveRepoPath = ({
  cwd,
  root,
  target,
  checkouts,
}: ResolveRepoPathOptions): ResolvedPath => {
  if (isComputed(target) || isComputed(cwd)) {
    return { reason: `${target} is computed at run time`, type: "invalid" };
  }
  const runtimePath = path.posix.normalize(path.posix.join(cwd, target));
  const checkout = checkouts.findLast(({ prefix }) =>
    runtimePath.startsWith(`${prefix}/`),
  );
  const joined =
    checkout === undefined
      ? runtimePath
      : runtimePath.slice(checkout.prefix.length + 1);
  if (joined.startsWith("../") || path.posix.isAbsolute(joined)) {
    return { reason: `${target} is outside the repository`, type: "invalid" };
  }
  if (!existsSync(path.join(root, joined))) {
    return { reason: `${joined} does not exist`, type: "invalid" };
  }
  if (checkout?.sparse !== undefined) {
    const unavailable = importProblems({
      root,
      entries: [joined],
      sparseCheckout: checkout.sparse,
    }).filter((problem) => problem.includes("outside sparse checkout"));
    if (unavailable.length > 0) {
      return { reason: unavailable.join("; "), type: "invalid" };
    }
  }
  return { path: joined, type: "file" };
};

const unclassified = (reason: string): Classification => ({
  reason,
  type: "unclassified",
});

type Coverage = "straight-line" | "control-flow";

type Expansion = {
  readonly coverage: Coverage;
  readonly command: string;
  readonly classification: Classification;
};

type ClassifyContext = {
  readonly root: string;
  readonly checkouts: CheckoutSource[];
  /** Package scripts being expanded, to stop a script that calls itself. */
  readonly expanding: ReadonlySet<string>;
};

type ClassifyBunTestOptions = {
  readonly args: readonly string[];
  readonly context: ClassifyContext;
  readonly cwd: string;
  readonly preloads: readonly string[];
};

/** Splits `bun test` arguments into test files, preloads and flags. */
const classifyBunTest = ({
  args,
  context,
  cwd,
  preloads,
}: ClassifyBunTestOptions): Classification => {
  const entries = [...preloads];
  let flagTakesValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--preload" || arg === "-r" || arg.startsWith("--preload=")) {
      index += arg.includes("=") ? 0 : 1;
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : args[index];
      const preload = resolveRepoPath({
        cwd,
        root: context.root,
        checkouts: context.checkouts,
        target: value ?? "",
      });
      if (preload.type === "invalid") {
        return unclassified(`preload ${preload.reason}`);
      }
      entries.push(preload.path);
      flagTakesValue = false;
    } else if (/^--?[a-z][\w-]*(?:=\S+)?$/u.test(arg)) {
      flagTakesValue = !arg.includes("=");
    } else if (TEST_FILE.test(arg)) {
      const file = resolveRepoPath({
        cwd,
        root: context.root,
        checkouts: context.checkouts,
        target: arg,
      });
      if (file.type === "invalid") {
        return unclassified(`test file ${file.reason}`);
      }
      entries.push(file.path);
      flagTakesValue = false;
    } else if (flagTakesValue && /^[\w.:-]+$/u.test(arg)) {
      // A separate flag value, e.g. `--timeout 5000`.
      flagTakesValue = false;
    } else {
      // A directory or name filter selects files this check cannot list.
      return unclassified(`bun test argument ${arg} is not a test file`);
    }
  }
  if (entries.length === preloads.length) {
    return unclassified(
      "bun test without a test file runs every test it finds",
    );
  }
  return { cwd, entries, type: "files" };
};

type RepoFile = {
  readonly root: string;
  /** Relative to `root`. */
  readonly file: string;
};

const readJson = ({ file, root }: RepoFile): unknown =>
  JSON.parse(readFileSync(path.join(root, file), "utf-8"));

type PackageDir = {
  readonly root: string;
  /** Relative to `root`; "" is the root package. */
  readonly dir: string;
};

const manifestScripts = ({
  dir,
  root,
}: PackageDir): Record<string, unknown> => {
  const file = path.posix.join(dir, "package.json");
  if (!existsSync(path.join(root, file))) {
    return {};
  }
  const manifest = readJson({ file, root });
  return isRecord(manifest) && isRecord(manifest["scripts"])
    ? manifest["scripts"]
    : {};
};

type WorkspaceDirOptions = {
  readonly root: string;
  readonly name: string;
};

/** The directory of the workspace package named `name`, if exactly one. */
const workspaceDir = ({
  name,
  root,
}: WorkspaceDirOptions): string | undefined => {
  const manifest = readJson({ file: "package.json", root });
  const workspaces = isRecord(manifest) ? manifest["workspaces"] : undefined;
  const patterns = Array.isArray(workspaces)
    ? workspaces.filter((pattern) => typeof pattern === "string")
    : [];
  const matches = patterns.flatMap((pattern) =>
    [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })].filter(
      (file) => {
        const workspace = readJson({ file, root });
        return isRecord(workspace) && workspace["name"] === name;
      },
    ),
  );
  const [match] = matches;
  return matches.length === 1 && match !== undefined
    ? path.posix.dirname(match)
    : undefined;
};

type ExpandPackageScriptOptions = {
  readonly context: ClassifyContext;
  readonly dir: string;
  readonly name: string;
};

/** Expands `bun run <name>` in `dir` into the commands it runs. */
const expandPackageScript = ({
  context,
  dir,
  name,
}: ExpandPackageScriptOptions): Expansion[] => {
  const key = `${dir === "" ? "." : dir}#${name}`;
  if (context.expanding.has(key)) {
    return [
      {
        classification: unclassified(`${key} calls itself`),
        command: "",
        coverage: "control-flow",
      },
    ];
  }
  const scripts = manifestScripts({ dir, root: context.root });
  if (typeof scripts[name] !== "string") {
    // Bun would fall back to an installed binary of that name.
    return [
      {
        coverage: "control-flow",
        classification: unclassified(`${key} is not a package.json script`),
        command: "",
      },
    ];
  }
  const nested: ClassifyContext = {
    expanding: new Set([...context.expanding, key]),
    root: context.root,
    checkouts: context.checkouts,
  };
  // Bun runs a script's pre and post hooks around it.
  return [`pre${name}`, name, `post${name}`].flatMap((hook) => {
    const body = scripts[hook];
    if (typeof body !== "string") {
      return [];
    }
    return walkCommands({
      context: nested,
      cwd: dir,
      events: lexShell(body),
      installed: new Set(),
      mode: "package-script",
    }).expansions.map(({ classification, command, coverage }) => ({
      coverage,
      classification,
      command: `${hook}: ${command}`,
    }));
  });
};

type BunFlagsOptions = {
  readonly args: readonly string[];
  readonly context: ClassifyContext;
  readonly cwd: string;
  /** The heredoc body on the command's standard input, if any. */
  readonly stdin: string | undefined;
};

type BunFlags =
  | {
      readonly type: "parsed";
      readonly dir: string;
      readonly filter: string | undefined;
      readonly preloads: readonly string[];
      /** What follows the flags: a subcommand, script or file, then its arguments. */
      readonly positional: readonly string[];
      /** After `bun run`, which always names a script or file. */
      readonly viaRun: boolean;
    }
  | { readonly type: "classified"; readonly classification: Classification };

/** Reads the flags before Bun's subcommand, script or file. */
export const parseBunFlags = ({
  args,
  context,
  cwd,
  stdin,
}: BunFlagsOptions): BunFlags => {
  const classified = (classification: Classification): BunFlags => ({
    classification,
    type: "classified",
  });
  let filter: string | undefined;
  let dir = cwd;
  let viaRun = false;
  const preloads: string[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "run" && !viaRun) {
      viaRun = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      break;
    }
    if (arg === "-") {
      // `bun -` runs code from standard input: check it like `bun -e`.
      if (stdin === undefined) {
        return classified(unclassified("reads code from a non-heredoc stdin"));
      }
      return classified(
        preloads.length > 0
          ? unclassified("evaluates code with a preload")
          : { code: stdin, cwd: dir, type: "eval" },
      );
    }
    const [flag = "", inline] = arg.split(/[=](.*)/su);
    if (BUN_SWITCHES.has(flag)) {
      continue;
    }
    if (!BUN_VALUE_FLAGS.has(flag)) {
      return classified(unclassified(`unknown bun flag ${arg}`));
    }
    index += inline === undefined ? 1 : 0;
    const value = inline ?? args[index];
    if (value === undefined) {
      return classified(unclassified(`${flag} has no value`));
    }
    switch (flag) {
      case "--cwd": {
        dir = changeDirectory({ from: cwd, to: value });
        break;
      }
      case "--filter":
      case "-F": {
        filter = value;
        break;
      }
      case "--preload":
      case "-r": {
        const preload = resolveRepoPath({
          cwd,
          root: context.root,
          checkouts: context.checkouts,
          target: value,
        });
        if (preload.type === "invalid") {
          return classified(unclassified(`preload ${preload.reason}`));
        }
        preloads.push(preload.path);
        break;
      }
      case "--eval":
      case "--print":
      case "-e":
      case "-p": {
        return classified(
          preloads.length > 0
            ? unclassified("evaluates code with a preload")
            : { code: value, cwd: dir, type: "eval" },
        );
      }
      default: {
        // --env-file, --port: they do not change what Bun loads.
        break;
      }
    }
  }
  return {
    dir,
    filter,
    positional: args.slice(index),
    preloads,
    type: "parsed",
    viaRun,
  };
};

type ClassifyInstallOptions = {
  readonly args: readonly string[];
  /** The directory the install runs in, before any `--cwd`. */
  readonly dir: string;
};

const classifyInstall = ({
  args,
  dir,
}: ClassifyInstallOptions): Classification => {
  const cwdAt = args.findIndex(
    (arg) => arg === "--cwd" || arg.startsWith("--cwd="),
  );
  const cwdArg = args[cwdAt] ?? "";
  const cwdValue = cwdArg.includes("=")
    ? cwdArg.split(/[=](.*)/su)[1]
    : args[cwdAt + 1];
  return {
    dir: cwdAt === -1 ? dir : changeDirectory({ from: dir, to: cwdValue }),
    global: args.includes("-g") || args.includes("--global"),
    type: "install",
  };
};

type ClassifyBunOptions = {
  readonly context: ClassifyContext;
  readonly cwd: string;
  readonly words: readonly string[];
  /** The heredoc body on the command's standard input, if any. */
  readonly stdin: string | undefined;
};

/** Classifies one `bun`, `bunx` or `npx` command run in `cwd`. */
const classifyBun = ({
  context,
  cwd,
  words,
  stdin,
}: ClassifyBunOptions): Expansion[] => {
  const command = words.join(" ");
  const single = (classification: Classification): Expansion[] => [
    { classification, command, coverage: "straight-line" },
  ];
  const expanded = (script: Omit<ExpandPackageScriptOptions, "context">) =>
    expandPackageScript({ context, ...script }).map((item) => ({
      coverage: item.coverage,
      classification: item.classification,
      command: `${command} › ${item.command}`,
    }));
  const [program, ...args] = words;
  if (program !== "bun") {
    return single({ type: "fetch" });
  }
  const flags = parseBunFlags({ args, context, cwd, stdin });
  if (flags.type === "classified") {
    return single(flags.classification);
  }
  const { dir, filter, positional, preloads, viaRun } = flags;
  const [subcommand, ...rest] = positional;
  if (subcommand === undefined) {
    return single(unclassified("names no script, file or subcommand"));
  }
  if (isComputed(subcommand)) {
    return single(unclassified(`${subcommand} is computed at run time`));
  }
  if (filter !== undefined) {
    const target = workspaceDir({ name: filter, root: context.root });
    return target === undefined
      ? single(
          unclassified(`--filter ${filter} names no single workspace package`),
        )
      : expanded({ dir: target, name: subcommand });
  }
  if (!viaRun && INSTALL_SUBCOMMANDS.has(subcommand)) {
    return single(classifyInstall({ args: rest, dir }));
  }
  if (!viaRun && subcommand === "x") {
    return single({ type: "fetch" });
  }
  if (!viaRun && subcommand === "test") {
    return single(classifyBunTest({ args: rest, context, cwd: dir, preloads }));
  }
  if (!viaRun && BUN_BUILTIN_SUBCOMMANDS.has(subcommand)) {
    return single(unclassified(`bun ${subcommand} is not classified`));
  }
  if (subcommand.includes("/") || SOURCE_FILE.test(subcommand)) {
    const file = resolveRepoPath({
      cwd: dir,
      root: context.root,
      checkouts: context.checkouts,
      target: subcommand,
    });
    if (file.type !== "invalid" && file.path === "scripts/ci-install.ts") {
      return [
        ...single({
          cwd: dir,
          entries: [...preloads, file.path],
          type: "files",
        }),
        ...single(classifyInstall({ args: rest.slice(1), dir })),
      ];
    }
    return single(
      file.type === "invalid"
        ? unclassified(file.reason)
        : { cwd: dir, entries: [...preloads, file.path], type: "files" },
    );
  }
  return expanded({ dir, name: subcommand });
};

type WalkCommandsOptions = {
  readonly context: ClassifyContext;
  readonly cwd: string;
  readonly events: readonly ShellEvent[];
  /** Directories whose install covers the commands from the start. */
  readonly installed: ReadonlySet<string>;
  /** In a package script, any other program may come from the install. */
  readonly mode: "package-script" | "step";
};

type WalkResult = {
  readonly expansions: readonly Expansion[];
  /** Directories that an install in these commands covers afterwards. */
  readonly installs: readonly string[];
};

type ShellScope = {
  cwd: string;
  coverage: Coverage;
};

type ClassifyShellStringOptions = Pick<
  WalkCommandsOptions,
  "context" | "cwd" | "mode"
> & {
  readonly words: readonly string[];
};

/** A short-option cluster such as `-c` or `-ec` that carries the command string. */
const isCommandStringOption = (word: string): boolean =>
  /^-[a-z]+$/u.test(word) && word.includes("c");

const classifyShellString = ({
  context,
  cwd,
  words,
  mode,
}: ClassifyShellStringOptions): Expansion[] => {
  const optionAt = words.findIndex(isCommandStringOption);
  const script = words.at(optionAt + 1);
  const nested =
    script === undefined || isComputed(script)
      ? undefined
      : walkCommands({
          context,
          cwd,
          events: lexShell(script),
          installed: new Set(),
          mode,
        });
  if (nested?.expansions.length === 0) {
    return [];
  }
  return [
    {
      coverage: "control-flow",
      classification: unclassified(
        `${words.at(0) ?? "shell"} runs a shell string this check cannot follow`,
      ),
      command: words.join(" "),
    },
  ];
};

/** Classifies, in order, each Bun command that runs outside every install. */
const walkCommands = ({
  context,
  cwd,
  events,
  installed,
  mode,
}: WalkCommandsOptions): WalkResult => {
  const expansions: Expansion[] = [];
  const installs: string[] = [];
  const covered = new Set(installed);
  const scopes: ShellScope[] = [{ cwd, coverage: "straight-line" }];
  // A lexer cannot prove which branch executes or whether an install finishes.
  // Once control flow appears in a shell scope, later installs cannot establish
  // coverage. An earlier straight-line install still covers subsequent commands.
  const isCovered = (dir: string) =>
    [...covered].some(
      (installedDir) =>
        installedDir === "" ||
        dir === installedDir ||
        dir.startsWith(`${installedDir}/`),
    );
  for (const event of events) {
    const scope = scopes.at(-1) ?? { cwd, coverage: "control-flow" };
    const current = scope.cwd;
    switch (event.type) {
      case "control-flow": {
        scope.coverage = "control-flow";
        break;
      }
      case "subshell-start": {
        scopes.push({ cwd: current, coverage: scope.coverage });
        break;
      }
      case "subshell-end": {
        scopes.pop();
        break;
      }
      case "unparsed": {
        if (!isCovered(current)) {
          expansions.push({
            coverage: "control-flow",
            classification: unclassified(event.reason),
            command: "",
          });
        }
        break;
      }
      case "command": {
        const words = programWords(event.words);
        const [program, target] = words;
        if (program === undefined) {
          break;
        }
        if (program === "cd" || program === "pushd" || program === "popd") {
          scope.cwd =
            program === "cd"
              ? changeDirectory({ from: current, to: target })
              : "$PWD";
          break;
        }
        const looksUp =
          program === "which" ||
          (program === "command" && (target === "-v" || target === "-V"));
        if (isCovered(current) || looksUp) {
          break;
        }
        if (BUN_PROGRAMS.has(program)) {
          for (const expansion of classifyBun({
            context,
            cwd: current,
            stdin: event.stdin?.body,
            words,
          })) {
            const { classification } = expansion;
            if (
              scope.coverage === "straight-line" &&
              expansion.coverage === "straight-line" &&
              classification.type === "install" &&
              !classification.global
            ) {
              covered.add(classification.dir);
              installs.push(classification.dir);
            }
            expansions.push({
              ...expansion,
              coverage:
                scope.coverage === "control-flow"
                  ? "control-flow"
                  : expansion.coverage,
            });
          }
        } else if (
          /^(?:bash|sh|zsh)$/u.test(program) &&
          words.some(isCommandStringOption)
        ) {
          expansions.push(
            ...classifyShellString({ context, cwd: current, words, mode }),
          );
        } else if (
          program !== "echo" &&
          program !== "printf" &&
          words.some((word) => BUN_PROGRAMS.has(word))
        ) {
          expansions.push({
            coverage: "control-flow",
            classification: unclassified(
              `${program} runs Bun with arguments this check cannot follow`,
            ),
            command: words.join(" "),
          });
        } else if (mode === "package-script" && !SCRIPT_BUILTINS.has(program)) {
          expansions.push({
            coverage: "control-flow",
            classification: unclassified(
              `runs ${program}, which the dependency install may provide`,
            ),
            command: words.join(" "),
          });
        }
        break;
      }
    }
  }
  return { expansions, installs };
};

// ---------------------------------------------------------------------------
// Workflow walking

type InstallRecord = {
  readonly dir: string;
  /** The install step's `if:` operands; empty when it always runs. */
  readonly condition: readonly string[];
};

type StepDefaults = {
  readonly shell: unknown;
  readonly workingDirectory: unknown;
};

const POSIX_SHELL = /^(?:bash|sh)\b/u;
const LOCAL_ACTION = "./.github/actions/";
const LOCAL_WORKFLOW = "./.github/workflows/";

const readYaml = ({ file, root }: RepoFile): unknown =>
  Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8"));

const stepCwd = (value: unknown): string =>
  typeof value === "string" ? changeDirectory({ from: "", to: value }) : "";

/** A step's name, else its action, else its one-based position. */
const stepTitle = (step: Record<string, unknown>, position: number): string => {
  if (typeof step["name"] === "string") {
    return step["name"];
  }
  if (typeof step["uses"] === "string") {
    return step["uses"];
  }
  return `step ${position + 1}`;
};

type WalkStepsOptions = {
  readonly cancelled?: ReadonlySet<string>;
  readonly context: ClassifyContext;
  readonly defaults: StepDefaults;
  readonly initial: readonly InstallRecord[];
  readonly job: string;
  readonly prefix: string;
  readonly pending?: Map<string, InstallRecord[]>;
  readonly steps: readonly unknown[];
};

type WalkStepsResult = {
  readonly installs: readonly InstallRecord[];
  readonly invocations: readonly InstallFreeInvocation[];
  readonly pending: ReadonlyMap<string, readonly InstallRecord[]>;
};

type WalkParallelStepsOptions = {
  readonly cancelled: ReadonlySet<string>;
  readonly context: ClassifyContext;
  readonly defaults: StepDefaults;
  readonly initial: readonly InstallRecord[];
  readonly job: string;
  readonly prefix: string;
  readonly pending: Map<string, InstallRecord[]>;
  readonly siblings: readonly unknown[];
};

type WalkParallelStepsResult = {
  readonly installs: readonly InstallRecord[];
  readonly invocations: readonly InstallFreeInvocation[];
};

const walkParallelSteps = ({
  cancelled,
  context,
  defaults,
  initial,
  job,
  prefix,
  pending,
  siblings,
}: WalkParallelStepsOptions): WalkParallelStepsResult => {
  const invocations: InstallFreeInvocation[] = [];
  const additions = mergeWorkflowParallelProofs({
    steps: siblings,
    installs: initial,
    pending,
    cancelled,
    walk: ({
      step,
      installs,
      pending: branchPending,
      cancelled: branchCancelled,
    }) => {
      const branch = walkSteps({
        cancelled: branchCancelled,
        context: { ...context, checkouts: [...context.checkouts] },
        defaults,
        initial: installs,
        job,
        pending: branchPending,
        prefix,
        steps: [step],
      });
      invocations.push(...branch.invocations);
      return branch.installs;
    },
  });
  return { installs: additions, invocations };
};

type WalkWorkflowStepOptions = {
  readonly context: ClassifyContext;
  readonly defaults: StepDefaults;
  readonly job: string;
  readonly prefix: string;
  readonly position: number;
  readonly step: Record<string, unknown>;
  readonly installs: InstallRecord[];
  readonly pending: Map<string, InstallRecord[]>;
};

const updateCheckoutSources = (
  step: Record<string, unknown>,
  context: ClassifyContext,
) => {
  const uses = step["uses"];
  const condition = conditionOperands(step["if"]);
  const checkoutOptions = step["with"];
  if (
    typeof uses === "string" &&
    /^actions\/checkout@[a-f0-9]{40}$/u.test(uses) &&
    isRecord(checkoutOptions)
  ) {
    const repository = checkoutOptions["repository"];
    const prefix = checkoutOptions["path"];
    // A later checkout can replace an earlier source at the same path.
    const replacementPath =
      typeof prefix === "string" ? path.posix.normalize(prefix) : ".";
    for (let index = context.checkouts.length - 1; index >= 0; index -= 1) {
      const checkout = context.checkouts[index];
      if (
        checkout &&
        (replacementPath === "." ||
          checkout.prefix === replacementPath ||
          checkout.prefix.startsWith(`${replacementPath}/`))
      ) {
        context.checkouts.splice(index, 1);
      }
    }
    if (
      (repository === undefined ||
        repository === `\${{ github.repository }}`) &&
      typeof prefix === "string" &&
      !isComputed(prefix) &&
      !path.posix.isAbsolute(prefix) &&
      !prefix.split("/").includes("..")
    ) {
      const sparse = checkoutOptions["sparse-checkout"];
      context.checkouts.push({
        prefix: path.posix.normalize(prefix),
        sparse:
          typeof sparse === "string"
            ? sparse
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
            : undefined,
        condition,
      });
    }
  }
};

const walkWorkflowStep = ({
  context,
  defaults,
  job,
  prefix,
  position,
  step,
  installs,
  pending,
}: WalkWorkflowStepOptions): InstallFreeInvocation[] => {
  const invocations: InstallFreeInvocation[] = [];
  const run = step["run"];
  const uses = step["uses"];
  const label = `${prefix}${stepTitle(step, position)}`;
  const condition = conditionOperands(step["if"]);
  updateCheckoutSources(step, context);
  const stepInstalls: InstallRecord[] = [];
  const installStart = installs.length;
  const covered = new Set(
    installs
      .filter((install) =>
        impliesCondition({ install: install.condition, step: condition }),
      )
      .map((install) => install.dir),
  );
  if (typeof run === "string") {
    const shell = step["shell"] ?? defaults.shell ?? "bash";
    if (typeof shell !== "string" || !POSIX_SHELL.test(shell)) {
      if (!covered.has("") && /\b(?:bunx?|npx)\b/u.test(run)) {
        invocations.push({
          classification: unclassified(
            `runs Bun under ${typeof shell === "string" ? shell : JSON.stringify(shell)}`,
          ),
          command: run.trim(),
          job,
          step: label,
        });
      }
      return invocations;
    }
    const result = walkCommands({
      context: {
        root: context.root,
        expanding: context.expanding,
        checkouts: context.checkouts.filter((checkout) =>
          impliesCondition({ install: checkout.condition, step: condition }),
        ),
      },
      cwd: stepCwd(step["working-directory"] ?? defaults.workingDirectory),
      events: lexShell(run),
      installed: covered,
      mode: "step",
    });
    for (const { classification, command } of result.expansions) {
      invocations.push({ classification, command, job, step: label });
    }
    for (const dir of result.installs) {
      stepInstalls.push({ condition, dir });
    }
  } else if (typeof uses === "string" && uses.startsWith(LOCAL_ACTION)) {
    const actionFile = ["action.yml", "action.yaml"]
      .map((name) => path.posix.join(uses, name))
      .find((file) => existsSync(path.join(context.root, file)));
    if (actionFile === undefined) {
      invocations.push({
        classification: unclassified(`${uses} has no action.yml`),
        command: "",
        job,
        step: label,
      });
      return invocations;
    }
    const action = readYaml({ file: actionFile, root: context.root });
    const runs = isRecord(action) ? action["runs"] : undefined;
    if (!isRecord(runs) || runs["using"] !== "composite") {
      return invocations;
    }
    const inner = walkSteps({
      context,
      defaults: { shell: undefined, workingDirectory: undefined },
      initial: [...covered].map((dir) => ({ condition: [], dir })),
      job,
      prefix: `${label} › `,
      steps: Array.isArray(runs["steps"]) ? runs["steps"] : [],
    });
    invocations.push(...inner.invocations);
    for (const install of inner.installs) {
      if (install.condition.length === 0 && !covered.has(install.dir)) {
        stepInstalls.push({ condition, dir: install.dir });
      }
    }
  }
  if (
    step["continue-on-error"] === undefined ||
    step["continue-on-error"] === false
  ) {
    installs.push(...stepInstalls);
  }
  if (typeof step["id"] === "string") {
    for (const { dir } of stepInstalls) {
      installs.push({
        condition: [`steps.${step["id"]}.outcome == 'success'`],
        dir,
      });
    }
  }
  if (step["background"] === true) {
    const added = installs.splice(installStart);
    if (typeof step["id"] === "string") {
      const records = pending.get(step["id"]);
      if (records === undefined) {
        pending.set(step["id"], added);
      } else {
        records.push(...added);
      }
    }
  }
  return invocations;
};

const walkSteps = ({
  cancelled = new Set<string>(),
  context,
  defaults,
  initial,
  job,
  prefix,
  pending = new Map(),
  steps,
}: WalkStepsOptions): WalkStepsResult => {
  const invocations: InstallFreeInvocation[] = [];
  const installs = [...initial];
  for (const [position, step] of steps.entries()) {
    if (!isRecord(step)) {
      continue;
    }
    const completed = synchronizeWorkflowBackgroundSteps(step, pending);
    if (completed !== undefined) {
      installs.push(...completed);
      continue;
    }
    if ("parallel" in step) {
      if (
        Object.keys(step).some((key) => key !== "parallel") ||
        !Array.isArray(step["parallel"])
      ) {
        invocations.push({
          classification: unclassified("malformed parallel workflow step"),
          command: "",
          job,
          step: `${prefix}step ${position + 1}`,
        });
        continue;
      }
      const parallel = walkParallelSteps({
        cancelled,
        context,
        defaults,
        initial: installs,
        job,
        prefix,
        pending,
        siblings: step["parallel"],
      });
      invocations.push(...parallel.invocations);
      installs.push(...parallel.installs);
      continue;
    }
    invocations.push(
      ...walkWorkflowStep({
        context,
        defaults,
        job,
        prefix,
        position,
        step,
        installs,
        pending,
      }),
    );
  }
  return { installs, invocations, pending };
};

const runDefaults = (owner: unknown): Record<string, unknown> => {
  const defaults = isRecord(owner) ? owner["defaults"] : undefined;
  const run = isRecord(defaults) ? defaults["run"] : undefined;
  return isRecord(run) ? run : {};
};

/**
 * Every Bun invocation `workflowFile` (repo-relative) can run in a
 * directory no dependency install covers, with what it loads.
 */
type InstallFreeInvocationsOptions = {
  readonly root: string;
  /** The workflow file, relative to `root`. */
  readonly workflow: string;
};

export const installFreeInvocations = ({
  root,
  workflow: workflowFile,
}: InstallFreeInvocationsOptions): InstallFreeInvocation[] => {
  const workflow = readYaml({ file: workflowFile, root });
  const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
  if (!isRecord(jobs)) {
    return [
      {
        classification: unclassified(`${workflowFile} has no jobs`),
        command: "",
        job: "",
        step: "",
      },
    ];
  }
  const workflowDefaults = runDefaults(workflow);
  return Object.entries(jobs).flatMap(([id, job]) => {
    const context: ClassifyContext = {
      expanding: new Set(),
      root,
      checkouts: [],
    };
    if (!isRecord(job)) {
      return [];
    }
    const uses = job["uses"];
    if (typeof uses === "string" && uses.startsWith(LOCAL_WORKFLOW)) {
      return installFreeInvocations({
        root,
        workflow: path.posix.normalize(uses),
      }).map(({ classification, command, job: calledJob, step }) => ({
        classification,
        command,
        job: `${id} › ${calledJob}`,
        step,
      }));
    }
    const jobDefaults = runDefaults(job);
    return walkSteps({
      context,
      defaults: {
        shell: jobDefaults["shell"] ?? workflowDefaults["shell"],
        workingDirectory:
          jobDefaults["working-directory"] ??
          workflowDefaults["working-directory"],
      },
      initial: [],
      job: id,
      prefix: "",
      steps: Array.isArray(job["steps"]) ? job["steps"] : [],
    }).invocations;
  });
};

// ---------------------------------------------------------------------------
// Import closures

const LOADERS = {
  ".cjs": "js",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".mts": "ts",
  ".ts": "ts",
  ".tsx": "tsx",
} as const satisfies Record<string, "js" | "jsx" | "ts" | "tsx">;
type Loader = (typeof LOADERS)[keyof typeof LOADERS];

const isLoaderExtension = (
  extension: string,
): extension is keyof typeof LOADERS => Object.hasOwn(LOADERS, extension);

const isBuiltin = (specifier: string): boolean =>
  specifier === "bun" ||
  specifier.startsWith("bun:") ||
  specifier.startsWith("node:");

const resolveRelative = ({
  cwd: from,
  root,
  target: specifier,
}: ResolveRepoPathOptions): string | undefined => {
  const base = path.posix.normalize(path.posix.join(from, specifier));
  return [
    base,
    ...Object.keys(LOADERS).map((extension) => `${base}${extension}`),
  ].find(
    (candidate) =>
      !candidate.startsWith("../") &&
      (candidate.endsWith(".json") ||
        isLoaderExtension(path.posix.extname(candidate))) &&
      existsSync(path.join(root, candidate)),
  );
};

/** Skip quoted fixture source and comments before inspecting executable calls. */
const installedBunSubprocesses = (source: string): string[] => {
  const tokens = [
    ...source.matchAll(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|[^\s]/gu,
    ),
  ]
    .map(([token]) => token)
    .filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const packages: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index] !== "Bun" ||
      tokens[index + 1] !== "." ||
      !["spawn", "spawnSync"].includes(tokens[index + 2] ?? "") ||
      tokens[index + 3] !== "(" ||
      tokens[index + 4] !== "["
    ) {
      continue;
    }
    let cursor = index + 5;
    const literal = (token: string | undefined) => {
      if (token === undefined || !["'", '"', "`"].includes(token.charAt(0))) {
        return undefined;
      }
      // Command names and flags need no escape sequences; reject computed forms.
      if (
        token.includes("\\") ||
        (token.startsWith("`") && token.includes("${"))
      ) {
        return undefined;
      }
      return token.slice(1, -1);
    };
    if (
      tokens[cursor] === "process" &&
      tokens[cursor + 1] === "." &&
      tokens[cursor + 2] === "execPath"
    ) {
      cursor += 3;
    } else if (literal(tokens[cursor]) === "bun") {
      cursor += 1;
    } else {
      continue;
    }
    const args: string[] = [];
    while (tokens[cursor] === ",") {
      const value = literal(tokens[cursor + 1]);
      if (value === undefined) {
        break;
      }
      args.push(value);
      cursor += 2;
    }
    const command = args.filter((arg) => arg !== "--bun");
    const name = command.at(0) === "run" ? command.at(1) : command.at(0);
    if (
      name !== undefined &&
      !name.startsWith("-") &&
      !name.includes("/") &&
      !SOURCE_FILE.test(name) &&
      !BUN_BUILTIN_SUBCOMMANDS.has(name) &&
      !INSTALL_SUBCOMMANDS.has(name) &&
      name !== "test"
    ) {
      packages.push(name);
    }
  }
  return packages;
};

type ImportClosureOptions = {
  readonly root: string;
  /** Repo-relative files Bun loads. */
  readonly entries: readonly string[];
  /** Inline code, evaluated in `cwd`. */
  readonly code?: { readonly cwd: string; readonly source: string };
  readonly sparseCheckout?: readonly string[];
};

/**
 * Every static import reachable from `entries` and `code` that names an
 * installed package or does not resolve. Imports built from run-time values
 * are invisible to it.
 */
export const importProblems = ({
  code,
  entries,
  root,
  sparseCheckout,
}: ImportClosureOptions): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  const pending = [...entries];
  type ScanOptions = {
    /** Directory that relative specifiers resolve from. */
    readonly from: string;
    readonly label: string;
    readonly loader: Loader;
    readonly source: string;
  };
  const scan = ({ from, label, loader, source }: ScanOptions) => {
    for (const binary of installedBunSubprocesses(source)) {
      problems.push(`${label} launches installed Bun CLI ${binary}`);
    }
    const transpiler = new Bun.Transpiler({ loader });
    for (const { path: specifier } of transpiler.scanImports(source)) {
      if (!specifier.startsWith(".")) {
        if (!isBuiltin(specifier)) {
          problems.push(`${label} imports ${specifier}`);
        }
        continue;
      }
      const target = resolveRelative({ cwd: from, root, target: specifier });
      if (target === undefined) {
        problems.push(`${label} imports ${specifier}, which does not resolve`);
      } else {
        pending.push(target);
      }
    }
  };
  if (code !== undefined) {
    scan({
      from: code.cwd,
      label: `inline code in ${code.cwd || "."}`,
      loader: "ts",
      source: code.source,
    });
  }
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (
      sparseCheckout !== undefined &&
      !includedInSparseCheckout(file, sparseCheckout)
    ) {
      problems.push(`${file} is outside sparse checkout`);
      continue;
    }
    const extension = path.posix.extname(file);
    if (extension === ".json") {
      continue;
    }
    if (!isLoaderExtension(extension)) {
      problems.push(`${file} is not a JavaScript or TypeScript module`);
      continue;
    }
    // Executable scripts start with a shebang, which is not TypeScript.
    const source = readFileSync(path.join(root, file), "utf-8").replace(
      /^#![^\n]*/u,
      "",
    );
    scan({
      from: path.posix.dirname(file),
      label: file,
      loader: LOADERS[extension],
      source,
    });
  }
  return problems;
};
