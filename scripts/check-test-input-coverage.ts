#!/usr/bin/env bun

// Guard: a package's tests may not read files outside the package unless
// turbo.json declares those files as inputs of that package's `test` task.
//
// CI scopes `bun run test` per package. Turbo selects a package when its own
// files, or a workspace dependency's files, changed — so a test that reaches
// through the filesystem into another package runs only when its own package
// happens to change, and Turbo may replay a cached pass over the file it
// asserts on. A guard in apps/api that asserted on apps/web route source was
// therefore invisible to web-only pull requests until main was already red.
//
// A `$TURBO_ROOT$/...` entry on `<name>#test` fixes both halves at once:
// scripts/test-scope.ts adds the package to the test filter when a changed
// file matches one, and the entry joins the task's cache key.
//
// The guard binds declaration and tests in both directions. An undeclared
// outside read fails, naming the two remedies; a declared input that no test
// in the package reads any more fails as stale, so the table can only shrink.
//
//   bun scripts/check-test-input-coverage.ts

import { panic } from "better-result";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE_PARENTS = ["apps", "packages"] as const;
const TURBO_CONFIG = "turbo.json";
const TURBO_ROOT_INPUT_PREFIX = "$TURBO_ROOT$/";
const RECURSIVE_GLOB_SUFFIX = "/**";
const TEST_TASK_SUFFIX = "#test";
const TEST_FILE_GLOB = "**/*.test.{ts,tsx}";
const WORKSPACE_DEPENDENCY_PROTOCOL = "workspace:";

/**
 * A change to these selects every task and joins every cache key on its own
 * (Turbo's root configuration and lockfile), so a test reading them needs no
 * declaration.
 */
const TURBO_GLOBAL_INPUTS = new Set(["package.json", "bun.lock", TURBO_CONFIG]);

/** Directories no test reads as repository source. */
const IGNORED_SEGMENTS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".astro",
  "coverage",
] as const;

/**
 * Calls whose string arguments are values rather than paths: a matcher compares
 * text the test already read (`expect(configSource).toContain("apps/web/…")`),
 * which renaming that web file cannot break. Every other call, including a
 * `test` or `describe` body where a literal may feed a read through a variable,
 * counts as a read, so the guard fails closed.
 */
const NON_READ_CALLS = new Set([
  "expect",
  "toBe",
  "toContain",
  "toContainEqual",
  "toContainKey",
  "toContainValue",
  "toEndWith",
  "toEqual",
  "toHaveProperty",
  "toInclude",
  "toMatch",
  "toStartWith",
  "toStrictEqual",
]);

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/u;
const WHITESPACE = /\s/u;
const GLOB_CHARACTER = /[*?]/u;
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
/** Bounds brace expansion so a pathological pattern cannot fan out. */
const MAX_BRACE_EXPANSIONS = 64;

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
): readonly SourceLiteral[] => {
  const literals: SourceLiteral[] = [];
  const calls: (string | undefined)[] = [];
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
        literals.push({ callee: calls.at(-1), line, value });
      }
      previousSignificant = char;
      continue;
    }
    if (char === "(") {
      calls.push(calleeBefore(source, state.index));
    } else if (char === ")") {
      calls.pop();
    }
    previousSignificant = char;
    state.index += 1;
  }

  return literals;
};

/** `{apps,packages}/**` expands to `apps/**` and `packages/**`. */
export const expandBraces = (pattern: string): readonly string[] => {
  const open = pattern.indexOf("{");
  if (open === -1) {
    return [pattern];
  }
  let depth = 0;
  let close = -1;
  const alternatives: string[] = [];
  let current = "";
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === "{") {
      depth += 1;
      if (depth === 1) {
        continue;
      }
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
    if (char === "," && depth === 1) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (close === -1) {
    return [pattern];
  }
  alternatives.push(current);
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const expanded = alternatives.flatMap((alternative) =>
    expandBraces(`${prefix}${alternative}${suffix}`),
  );
  return expanded.slice(0, MAX_BRACE_EXPANSIONS);
};

type TargetCandidate = {
  /** The literal was a glob, so this path is the tree it scans. */
  readonly fromGlob: boolean;
  readonly path: string;
};

const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === "/") {
    end -= 1;
  }
  return value.slice(0, end);
};

/**
 * The directory a glob scans from. A wildcard with no directory before it
 * (`**\/*.ts`, `apps*`) scans from wherever the caller resolves it, so there is
 * no repository path to name.
 */
const globDirectory = (expansion: string, wildcard: number): string => {
  const slash = expansion.lastIndexOf("/", wildcard);
  return slash === -1 ? "" : expansion.slice(0, slash);
};

/**
 * The repository paths a literal can reach: a plain path is itself, a glob is
 * the deepest directory above its first wildcard, so a test that scans
 * `{apps,packages}` for test files reaches `apps` and `packages` themselves and
 * only a subtree input at that level covers it.
 */
export const literalTargets = (value: string): readonly TargetCandidate[] => {
  const candidates = new Map<string, TargetCandidate>();
  for (const expansion of expandBraces(value)) {
    const wildcard = expansion.search(GLOB_CHARACTER);
    const candidate =
      wildcard === -1 ? expansion : globDirectory(expansion, wildcard);
    const normalized = trimTrailingSlashes(candidate);
    if (normalized !== "") {
      candidates.set(normalized, {
        fromGlob: wildcard !== -1,
        path: normalized,
      });
    }
  }
  return [...candidates.values()];
};

/**
 * `existsSync` answers case-insensitively on macOS, which makes the root
 * `VERSION` file swallow every `"version"` literal in a test. Paths are matched
 * segment by segment against real directory entries instead, and the listings
 * are cached because one test file resolves hundreds of literals.
 */
const directoryEntries = new Map<string, ReadonlySet<string>>();

const existsExact = (root: string, relativePath: string): boolean => {
  let directory = root;
  for (const segment of relativePath.split("/")) {
    const cached = directoryEntries.get(directory);
    const entries =
      cached ??
      new Set(
        existsSync(directory) ? readdirSync(directory) : ([] as string[]),
      );
    if (cached === undefined) {
      directoryEntries.set(directory, entries);
    }
    if (!entries.has(segment)) {
      return false;
    }
    directory = path.join(directory, segment);
  }
  return true;
};

type TargetClassification =
  | { readonly type: "absent" }
  | { readonly type: "package-local" }
  | { readonly type: "repository"; readonly target: string };

const isRelativeSpecifier = (candidate: string): boolean =>
  candidate === "." ||
  candidate === ".." ||
  candidate.startsWith("./") ||
  candidate.startsWith("../");

const isInside = (target: string, directory: string): boolean =>
  target === directory || target.startsWith(`${directory}/`);

/**
 * A literal resolves against the package that owns the test first: `src/x.ts`
 * and `package.json` are package-relative in every workspace, and only a path
 * that exists at the repository root and nowhere in the package is an outside
 * read. A `./` or `../` specifier resolves from the test file's directory
 * instead (`path.join(import.meta.dirname, "../landing/...")`), so a read that
 * climbs out of the package is classified by where it lands.
 */
export const classifyTarget = ({
  candidate: { fromGlob, path: candidate },
  packageDir,
  root,
  testDir,
}: {
  readonly candidate: TargetCandidate;
  readonly packageDir: string;
  readonly root: string;
  /** Repository-relative directory of the test file. */
  readonly testDir: string;
}): TargetClassification => {
  if (
    candidate.startsWith("/") ||
    candidate
      .split("/")
      .some((segment) =>
        IGNORED_SEGMENTS.some((ignored) => ignored === segment),
      )
  ) {
    return { type: "absent" };
  }
  if (isRelativeSpecifier(candidate)) {
    const resolved = path.posix.normalize(path.posix.join(testDir, candidate));
    if (resolved === ".." || resolved.startsWith("../")) {
      return { type: "absent" };
    }
    if (isInside(resolved, packageDir)) {
      return { type: "package-local" };
    }
    return existsExact(root, resolved)
      ? { target: resolved, type: "repository" }
      : { type: "absent" };
  }
  if (existsExact(path.join(root, packageDir), candidate)) {
    return { type: "package-local" };
  }
  if (!existsExact(root, candidate)) {
    return { type: "absent" };
  }
  // A root-level name with no directory in it ("docs", "docker", ".env") is a
  // field value, a command, or a fixture filename far more often than a read.
  // Only a named file with an extension (`oxlint.config.ts`) reads as a path —
  // unless the literal was a glob, which says outright that it scans a tree.
  if (
    !fromGlob &&
    !candidate.includes("/") &&
    (candidate.lastIndexOf(".") <= 0 ||
      statSync(path.join(root, candidate)).isDirectory())
  ) {
    return { type: "absent" };
  }
  return { target: candidate, type: "repository" };
};

/**
 * Turbo inputs are matched as an exact path or a `dir/**` subtree. A pattern
 * with any other wildcard is rejected rather than guessed at: the guard cannot
 * report coverage it cannot compute.
 */
export const matchesRootInput = (target: string, input: string): boolean => {
  if (input === target) {
    return true;
  }
  if (!input.endsWith(RECURSIVE_GLOB_SUFFIX)) {
    if (GLOB_CHARACTER.test(input)) {
      panic(
        `${TURBO_CONFIG}: test input ${TURBO_ROOT_INPUT_PREFIX}${input} must be an exact path or a "dir/**" subtree`,
      );
    }
    return false;
  }
  const directory = input.slice(0, -RECURSIVE_GLOB_SUFFIX.length);
  return target === directory || target.startsWith(`${directory}/`);
};

type Workspace = {
  readonly dependencies: readonly string[];
  readonly dir: string;
  readonly name: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workspaceDependencies = (manifest: Record<string, unknown>): string[] => {
  const names: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const declared = manifest[field];
    if (!isRecord(declared)) {
      continue;
    }
    for (const [name, range] of Object.entries(declared)) {
      if (
        typeof range === "string" &&
        range.startsWith(WORKSPACE_DEPENDENCY_PROTOCOL)
      ) {
        names.push(name);
      }
    }
  }
  return names;
};

const readWorkspaces = (root: string): readonly Workspace[] => {
  const workspaces: Workspace[] = [];
  for (const parent of WORKSPACE_PARENTS) {
    const parentDir = path.join(root, parent);
    if (!existsSync(parentDir)) {
      continue;
    }
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      const dir = `${parent}/${entry.name}`;
      const manifestFile = path.join(root, dir, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestFile)) {
        continue;
      }
      const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf-8"));
      if (!isRecord(manifest) || typeof manifest["name"] !== "string") {
        panic(`${dir}/package.json must declare a name`);
      }
      workspaces.push({
        dependencies: workspaceDependencies(manifest),
        dir,
        name: manifest["name"],
      });
    }
  }
  return workspaces.toSorted((left, right) => (left.dir < right.dir ? -1 : 1));
};

/** Dependents are selected by Turbo already, so a dependency's files are covered. */
const dependencyClosure = (
  workspace: Workspace,
  byName: ReadonlyMap<string, Workspace>,
): ReadonlySet<string> => {
  const closure = new Set<string>();
  const queue = [...workspace.dependencies];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined) {
      continue;
    }
    const dependency = byName.get(name);
    if (dependency === undefined || closure.has(dependency.dir)) {
      continue;
    }
    closure.add(dependency.dir);
    queue.push(...dependency.dependencies);
  }
  return closure;
};

export const readTestInputs = (
  root: string,
): ReadonlyMap<string, readonly string[]> => {
  const parsed: unknown = Bun.JSONC.parse(
    readFileSync(path.join(root, TURBO_CONFIG), "utf-8"),
  );
  const tasks = isRecord(parsed) ? parsed["tasks"] : undefined;
  if (!isRecord(tasks)) {
    panic(`${TURBO_CONFIG} must declare tasks`);
  }
  const inputs = new Map<string, readonly string[]>();
  for (const [task, definition] of Object.entries(tasks)) {
    if (!task.endsWith(TEST_TASK_SUFFIX) || !isRecord(definition)) {
      continue;
    }
    const declared = definition["inputs"];
    if (!Array.isArray(declared)) {
      continue;
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

const testFiles = (root: string, workspaceDir: string): readonly string[] =>
  [
    ...new Bun.Glob(TEST_FILE_GLOB).scanSync({
      cwd: path.join(root, workspaceDir),
      onlyFiles: true,
    }),
  ]
    .filter(
      (file) =>
        !file
          .split("/")
          .some((segment) =>
            IGNORED_SEGMENTS.some((ignored) => ignored === segment),
          ),
    )
    .toSorted();

type OutsideRead = {
  readonly line: number;
  readonly target: string;
  readonly testFile: string;
  readonly value: string;
};

/** Every repository path the package's tests reach outside their own package. */
const outsideReads = ({
  packageDir,
  root,
  skippedDirs,
}: {
  readonly packageDir: string;
  readonly root: string;
  readonly skippedDirs: ReadonlySet<string>;
}): readonly OutsideRead[] => {
  const reads: OutsideRead[] = [];
  for (const relative of testFiles(root, packageDir)) {
    const testFile = `${packageDir}/${relative}`;
    const source = readFileSync(path.join(root, testFile), "utf-8");
    for (const { callee, line, value } of readStringLiterals(source)) {
      if (callee !== undefined && NON_READ_CALLS.has(callee)) {
        continue;
      }
      for (const candidate of literalTargets(value)) {
        const classification = classifyTarget({
          candidate,
          packageDir,
          root,
          testDir: path.posix.dirname(testFile),
        });
        if (classification.type !== "repository") {
          continue;
        }
        const { target } = classification;
        if (
          TURBO_GLOBAL_INPUTS.has(target) ||
          target === packageDir ||
          target.startsWith(`${packageDir}/`) ||
          [...skippedDirs].some(
            (dir) => target === dir || target.startsWith(`${dir}/`),
          )
        ) {
          continue;
        }
        reads.push({ line, target, testFile, value });
      }
    }
  }
  return reads;
};

export const checkTestInputCoverage = (root: string): readonly string[] => {
  const workspaces = readWorkspaces(root);
  const byName = new Map(
    workspaces.map((workspace) => [workspace.name, workspace]),
  );
  const declared = readTestInputs(root);
  const errors: string[] = [];

  for (const workspace of workspaces) {
    const inputs = declared.get(workspace.name) ?? [];
    const reads = outsideReads({
      packageDir: workspace.dir,
      root,
      skippedDirs: dependencyClosure(workspace, byName),
    });
    const matched = new Set<string>();

    for (const { line, target, testFile, value } of reads) {
      const input = inputs.find((entry) => matchesRootInput(target, entry));
      if (input !== undefined) {
        matched.add(input);
        continue;
      }
      errors.push(
        `${testFile}:${line} reads "${value}" (${target}), which ${workspace.name} does not own.\n` +
          `    Turbo runs ${workspace.name}#test only when ${workspace.dir} or one of its workspace dependencies changes, so this assertion is invisible to a change in ${target}.\n` +
          `    Fix: declare "${TURBO_ROOT_INPUT_PREFIX}${target}" (or a subtree above it) in "${workspace.name}${TEST_TASK_SUFFIX}".inputs in ${TURBO_CONFIG}, or move the assertion into the package that owns ${target}.`,
      );
    }

    for (const input of inputs) {
      if (matched.has(input)) {
        continue;
      }
      errors.push(
        `${TURBO_CONFIG}: "${workspace.name}${TEST_TASK_SUFFIX}".inputs declares "${TURBO_ROOT_INPUT_PREFIX}${input}", which no test in ${workspace.dir} reads any more.\n` +
          `    Fix: delete the input, or narrow it to what the tests still read.`,
      );
    }
  }

  return errors;
};

const main = (): number => {
  const errors = checkTestInputCoverage(REPO_ROOT);
  if (errors.length > 0) {
    console.error("Cross-package test reads are not declared in turbo.json:\n");
    for (const error of errors) {
      console.error(`- ${error}\n`);
    }
    return 1;
  }
  console.log(
    "test input coverage: OK (every cross-package test read is a declared test input).",
  );
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
