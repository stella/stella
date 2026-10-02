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
 * - A local composite action's steps are walked in place, and an
 *   unconditional install inside one counts as an install by the step that
 *   uses it. A job that calls a local reusable workflow is walked as that
 *   workflow.
 *
 * `bun run <script>` and `bun --filter <package> <script>` expand to the
 * package.json script's commands; there, any program besides Bun and a few
 * shell builtins may come from the install. Whatever the walk cannot follow
 * (a computed path, an unknown flag, Bun handed to another program) is
 * unclassified, and the test fails on it. Out of scope: commands that a shell
 * script or a Bun script starts itself.
 *
 * Needs no dependency install: node builtins and Bun APIs only.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

export type ShellEvent =
  | { readonly type: "command"; readonly words: readonly string[] }
  | { readonly type: "subshell-start" }
  | { readonly type: "subshell-end" }
  | { readonly type: "unparsed"; readonly reason: string };

const OPERATOR_CHARACTERS = new Set([";", "&", "|", "(", ")", "<", ">"]);
const SUBSTITUTION = "$(…)";

const isBlank = (character: string) =>
  character === " " || character === "\t" || character === "\r";

/**
 * Splits shell source into simple commands, in execution order. Quotes are
 * removed; a command substitution (`$(…)`, backticks) or subshell becomes
 * its own subshell-delimited commands, ahead of the command that uses it.
 * Comments and heredoc bodies are skipped. It is not a full shell parser: an
 * unterminated quote or substitution yields an `unparsed` event.
 */
export const lexShell = (source: string): ShellEvent[] => {
  const events: ShellEvent[] = [];
  const pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let index = 0;
  let failure: string | undefined;

  const skipHeredocBodies = () => {
    for (const { delimiter, stripTabs } of pendingHeredocs.splice(0)) {
      while (index < source.length) {
        const end = source.indexOf("\n", index);
        const line = source.slice(index, end === -1 ? source.length : end);
        index = end === -1 ? source.length : end + 1;
        if ((stripTabs ? line.replace(/^\t+/u, "") : line) === delimiter) {
          break;
        }
      }
    }
  };

  const readSubstitution = (closing: ")" | "`"): void => {
    events.push({ type: "subshell-start" });
    readList(closing);
    if (source[index] !== closing) {
      failure ??= `unterminated ${closing === ")" ? "$(" : "`"}`;
    }
    index += 1;
    events.push({ type: "subshell-end" });
  };

  /** The index just past a `${…}` expansion, which may nest and quote. */
  const parameterEnd = (): number => {
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
    failure ??= "unterminated ${";
    return source.length;
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
        const stop = parameterEnd();
        text += source.slice(index, stop);
        index = stop;
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
      } else if (character === "'") {
        const end = source.indexOf("'", index + 1);
        if (end === -1) {
          failure ??= "unterminated single quote";
          break;
        }
        text += source.slice(index + 1, end);
        index = end + 1;
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
        const stop = parameterEnd();
        text += source.slice(index, stop);
        index = stop;
      } else {
        text += character;
        index += 1;
      }
    }
    return consumed ? text : undefined;
  };

  const readRedirection = (words: string[], adjacent: boolean): void => {
    // A file-descriptor prefix (`2>&1`) belongs to the redirection.
    if (adjacent && /^\d+$/u.test(words.at(-1) ?? "")) {
      words.pop();
    }
    const operator =
      /^(?:<<<|<<-|<<|>>|>&|<&|>\||[<>])/u.exec(source.slice(index))?.[0] ?? "";
    index += operator.length;
    while (isBlank(source[index] ?? "")) {
      index += 1;
    }
    if (source[index] === "(") {
      // Process substitution, `<(…)`: the caller reads it as a subshell.
      return;
    }
    const target = readWord() ?? "";
    if (operator === "<<" || operator === "<<-") {
      pendingHeredocs.push({
        delimiter: target,
        stripTabs: operator === "<<-",
      });
    }
  };

  const readList = (closing: ")" | "`" | undefined): void => {
    let words: string[] = [];
    let wordEnd = -1;
    const flush = () => {
      if (words.length > 0) {
        events.push({ type: "command", words });
      }
      words = [];
    };
    while (index < source.length) {
      const character = source[index] ?? "";
      // A nested read that fails stops the whole lex.
      if (character === closing || failure !== undefined) {
        break;
      }
      if (character === "\n") {
        flush();
        index += 1;
        skipHeredocBodies();
      } else if (isBlank(character)) {
        index += 1;
      } else if (character === "\\" && source[index + 1] === "\n") {
        index += 2;
      } else if (character === "#") {
        const end = source.indexOf("\n", index);
        index = end === -1 ? source.length : end;
      } else if (character === ";" || character === "&" || character === "|") {
        flush();
        index += 1;
      } else if (character === "(") {
        flush();
        index += 1;
        readSubstitution(")");
      } else if (character === ")") {
        // An unmatched `)`, as after a `case` pattern, ends the command.
        flush();
        index += 1;
      } else if (character === "<" || character === ">") {
        readRedirection(words, wordEnd === index);
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

/** Whether a step guarded by `step` runs only when `install` held. */
export const impliesCondition = ({
  install,
  step,
}: ImpliesConditionOptions): boolean =>
  install.every(
    (operand) =>
      step.includes(operand) ||
      splitTopLevel(operand, "||").some((disjunct) => step.includes(disjunct)),
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
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
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

/** The program and its arguments, past keywords, assignments and wrappers. */
const programWords = (words: readonly string[]): readonly string[] => {
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

type ResolveRepoPathOptions = {
  readonly cwd: string;
  readonly root: string;
  readonly target: string;
};

const resolveRepoPath = ({
  cwd,
  root,
  target,
}: ResolveRepoPathOptions): ResolvedPath => {
  if (isComputed(target) || isComputed(cwd)) {
    return { reason: `${target} is computed at run time`, type: "invalid" };
  }
  const joined = path.posix.normalize(path.posix.join(cwd, target));
  if (joined.startsWith("../") || path.posix.isAbsolute(joined)) {
    return { reason: `${target} is outside the repository`, type: "invalid" };
  }
  if (!existsSync(path.join(root, joined))) {
    return { reason: `${joined} does not exist`, type: "invalid" };
  }
  return { path: joined, type: "file" };
};

const unclassified = (reason: string): Classification => ({
  reason,
  type: "unclassified",
});

type Expansion = {
  readonly command: string;
  readonly classification: Classification;
};

type ClassifyContext = {
  readonly root: string;
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
      const file = resolveRepoPath({ cwd, root: context.root, target: arg });
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
      { classification: unclassified(`${key} calls itself`), command: "" },
    ];
  }
  const scripts = manifestScripts({ dir, root: context.root });
  if (typeof scripts[name] !== "string") {
    // Bun would fall back to an installed binary of that name.
    return [
      {
        classification: unclassified(`${key} is not a package.json script`),
        command: "",
      },
    ];
  }
  const nested: ClassifyContext = {
    expanding: new Set([...context.expanding, key]),
    root: context.root,
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
    }).expansions.map(({ classification, command }) => ({
      classification,
      command: `${hook}: ${command}`,
    }));
  });
};

type BunFlagsOptions = {
  readonly args: readonly string[];
  readonly context: ClassifyContext;
  readonly cwd: string;
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
const parseBunFlags = ({ args, context, cwd }: BunFlagsOptions): BunFlags => {
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
};

/** Classifies one `bun`, `bunx` or `npx` command run in `cwd`. */
const classifyBun = ({
  context,
  cwd,
  words,
}: ClassifyBunOptions): Expansion[] => {
  const command = words.join(" ");
  const single = (classification: Classification): Expansion[] => [
    { classification, command },
  ];
  const expanded = (script: Omit<ExpandPackageScriptOptions, "context">) =>
    expandPackageScript({ context, ...script }).map((item) => ({
      classification: item.classification,
      command: `${command} › ${item.command}`,
    }));
  const [program, ...args] = words;
  if (program !== "bun") {
    return single({ type: "fetch" });
  }
  const flags = parseBunFlags({ args, context, cwd });
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
      target: subcommand,
    });
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
  const cwdStack = [cwd];
  const isCovered = (dir: string) =>
    [...covered].some(
      (installedDir) =>
        installedDir === "" ||
        dir === installedDir ||
        dir.startsWith(`${installedDir}/`),
    );
  for (const event of events) {
    const current = cwdStack.at(-1) ?? cwd;
    switch (event.type) {
      case "subshell-start": {
        cwdStack.push(current);
        break;
      }
      case "subshell-end": {
        cwdStack.pop();
        break;
      }
      case "unparsed": {
        if (!isCovered(current)) {
          expansions.push({
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
          cwdStack[cwdStack.length - 1] =
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
            words,
          })) {
            const { classification } = expansion;
            if (classification.type === "install" && !classification.global) {
              covered.add(classification.dir);
              installs.push(classification.dir);
            }
            expansions.push(expansion);
          }
        } else if (words.some((word) => BUN_PROGRAMS.has(word))) {
          expansions.push({
            classification: unclassified(
              `${program} runs Bun with arguments this check cannot follow`,
            ),
            command: words.join(" "),
          });
        } else if (mode === "package-script" && !SCRIPT_BUILTINS.has(program)) {
          expansions.push({
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
  readonly context: ClassifyContext;
  readonly defaults: StepDefaults;
  readonly initial: readonly InstallRecord[];
  readonly job: string;
  readonly prefix: string;
  readonly steps: readonly unknown[];
};

type WalkStepsResult = {
  readonly installs: readonly InstallRecord[];
  readonly invocations: readonly InstallFreeInvocation[];
};

const walkSteps = ({
  context,
  defaults,
  initial,
  job,
  prefix,
  steps,
}: WalkStepsOptions): WalkStepsResult => {
  const invocations: InstallFreeInvocation[] = [];
  const installs = [...initial];
  for (const [position, step] of steps.entries()) {
    if (!isRecord(step)) {
      continue;
    }
    const run = step["run"];
    const uses = step["uses"];
    const label = `${prefix}${stepTitle(step, position)}`;
    const condition = conditionOperands(step["if"]);
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
        continue;
      }
      const result = walkCommands({
        context,
        cwd: stepCwd(step["working-directory"] ?? defaults.workingDirectory),
        events: lexShell(run),
        installed: covered,
        mode: "step",
      });
      for (const { classification, command } of result.expansions) {
        invocations.push({ classification, command, job, step: label });
      }
      for (const dir of result.installs) {
        installs.push({ condition, dir });
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
        continue;
      }
      const action = readYaml({ file: actionFile, root: context.root });
      const runs = isRecord(action) ? action["runs"] : undefined;
      if (!isRecord(runs) || runs["using"] !== "composite") {
        continue;
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
      // Only an unconditional install inside the action is sure to run.
      for (const install of inner.installs) {
        if (install.condition.length === 0 && !covered.has(install.dir)) {
          installs.push({ condition, dir: install.dir });
        }
      }
    }
  }
  return { installs, invocations };
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
  const context: ClassifyContext = { expanding: new Set(), root };
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

type ImportClosureOptions = {
  readonly root: string;
  /** Repo-relative files Bun loads. */
  readonly entries: readonly string[];
  /** Inline code, evaluated in `cwd`. */
  readonly code?: { readonly cwd: string; readonly source: string };
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
