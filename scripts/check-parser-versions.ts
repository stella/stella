import path from "node:path";

const REGISTRY_PATH =
  "apps/api/src/handlers/case-law/ingestion/adapters/adapter-registry.ts";
const LEGISLATION_REGISTRY_PATH =
  "apps/api/src/handlers/legislation/ingestion/adapter-registry.ts";
const ADAPTER_DIRECTORY = "apps/api/src/handlers/case-law/ingestion/adapters/";
const LEGISLATION_DIRECTORY = "apps/api/src/handlers/legislation/";
const LEGISLATION_ADAPTER_DIRECTORY = `${LEGISLATION_DIRECTORY}ingestion/adapters/`;
const CASE_LAW_DIRECTORY = "apps/api/src/lib/case-law/";
const PARSER_DIRECTORIES = [
  "apps/api/src/handlers/case-law/ingestion/parsers/",
  "apps/api/src/lib/legal-search/parsers/",
];
const OUTPUT_UNCHANGED =
  /^\s*\/\/\s*parser-output-unchanged:\s+(?:\[([a-z\d-]+)\]\s+\S.*|(?!\[)(\S.*))$/u;
const transpiler = new Bun.Transpiler({ loader: "ts" });
const jsxTranspiler = new Bun.Transpiler({ loader: "tsx" });

type SourceTree = ReadonlyMap<string, string>;
type StaticValue =
  | { type: "number"; file: string; name: string; value: number }
  | {
      type: "map";
      file: string;
      name: string;
      entries: ReadonlyMap<string, string>;
    };
type SourceOwner = {
  /** Module imported by a live entry in ADAPTER_REGISTRY or IMPORT_REGISTRY. */
  module: string;
  version: number;
  /** Output-affecting source files reached from this registered adapter. */
  parsers: ReadonlySet<string>;
};

type RegisteredParserSource = {
  registry: string;
  key: string;
  module: string;
};

type SourceOwnersResult = {
  owners: ReadonlyMap<string, SourceOwner>;
  registeredSources: readonly RegisteredParserSource[];
  parserFiles: ReadonlySet<string>;
  errors: readonly string[];
  registryErrors: readonly string[];
};

// Only source is read: no importing the registry, adapter initialization,
// dependencies, fixtures, or publisher clients into this check.
class StaticTree {
  private readonly importErrors = new Set<string>();
  private readonly versionDeclarations = new Map<string, Set<string>>();
  private readonly codeCache = new Map<string, string>();
  private readonly closureCache = new Map<string, Set<string>>();

  readonly files: SourceTree;

  constructor(files: SourceTree) {
    this.files = files;
  }

  code(file: string): string {
    const cached = this.codeCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const source = this.files.get(file);
    if (source === undefined || !/\.[cm]?[jt]sx?$/u.test(file)) {
      return "";
    }
    const code = (
      file.endsWith("x") ? jsxTranspiler : transpiler
    ).transformSync(source);
    this.codeCache.set(file, code);
    return code;
  }

  resolve(file: string, specifier: string): string | undefined {
    let target: string;
    if (specifier.startsWith("@/api/")) {
      target = `apps/api/src/${specifier.slice("@/api/".length)}`;
    } else if (specifier.startsWith(".")) {
      target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      );
    } else if (specifier.startsWith("@stll/")) {
      const [name, ...subpath] = specifier.slice("@stll/".length).split("/");
      if (name === undefined) {
        return undefined;
      }
      const root = `packages/${name}`;
      const manifestSource = this.files.get(`${root}/package.json`);
      if (manifestSource === undefined) {
        return undefined;
      }
      const manifest: unknown = JSON.parse(manifestSource);
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("exports" in manifest)
      ) {
        return undefined;
      }
      const exports = manifest.exports;
      const exportKey = subpath.length === 0 ? "." : `./${subpath.join("/")}`;
      let entry: unknown;
      if (typeof exports === "string" && exportKey === ".") {
        entry = exports;
      } else if (typeof exports === "object" && exports !== null) {
        entry = Reflect.get(exports, exportKey);
      }
      if (typeof entry === "object" && entry !== null) {
        entry =
          Reflect.get(entry, "bun") ??
          Reflect.get(entry, "import") ??
          Reflect.get(entry, "default") ??
          Reflect.get(entry, "types");
      }
      if (typeof entry !== "string") {
        return undefined;
      }
      target = path.posix.join(root, entry);
    } else {
      return undefined;
    }
    return [
      target,
      target.replace(/\.js$/u, ".ts"),
      `${target}.ts`,
      `${target}.tsx`,
      `${target}/index.ts`,
      `${target}/index.js`,
    ].find((candidate) => this.files.has(candidate));
  }

  imports(file: string): string[] {
    const source = this.files.get(file);
    if (source === undefined || !/\.[cm]?[jt]sx?$/u.test(file)) {
      return [];
    }
    return (file.endsWith("x") ? jsxTranspiler : transpiler)
      .scanImports(source)
      .flatMap(({ path: specifier }) => {
        const target = this.resolve(file, specifier);
        if (
          target === undefined &&
          (specifier.startsWith(".") ||
            specifier.startsWith("@/api/") ||
            (specifier.startsWith("@stll/") &&
              // Only packages/ is resolved; an app-hosted package fails closed.
              ["packages", "apps"].some((workspace) =>
                this.files.has(
                  `${workspace}/${specifier.slice("@stll/".length).split("/").at(0) ?? ""}/package.json`,
                ),
              )))
        ) {
          this.importErrors.add(
            `Unresolved repository import ${specifier} in ${file}`,
          );
        }
        return target === undefined ? [] : [target];
      });
  }

  closure(file: string): Set<string> {
    const cached = this.closureCache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const files = new Set<string>();
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || files.has(current)) {
        continue;
      }
      files.add(current);
      queue.push(...this.imports(current));
    }
    this.closureCache.set(file, files);
    return files;
  }

  namedImport(
    file: string,
    local: string,
  ): { module: string; name: string } | undefined {
    for (const match of this.code(file).matchAll(
      /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/gu,
    )) {
      const [, bindings, specifier] = match;
      if (bindings === undefined || specifier === undefined) {
        continue;
      }
      for (const binding of bindings.split(",")) {
        // The transpiler normalizes whitespace around import aliases.
        const [name, alias] = binding.trim().split(" as ");
        if ((alias ?? name) !== local || name === undefined) {
          continue;
        }
        const module = this.resolve(file, specifier);
        if (module !== undefined) {
          return { module, name };
        }
      }
    }
    return undefined;
  }

  value(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): StaticValue | undefined {
    const identity = `${file}::${name}`;
    if (seen.has(identity)) {
      return undefined;
    }
    seen.add(identity);
    const code = this.code(file);
    const declaration = new RegExp(
      `\\b(?:const|let|var)\\s+${name}\\s*=\\s*`,
      "u",
    ).exec(code);
    if (declaration !== null) {
      const expression = code.slice(declaration.index + declaration[0].length);
      const number = /^(\d+)\s*;/u.exec(expression)?.at(1);
      if (number !== undefined) {
        return { type: "number", file, name, value: Number(number) };
      }
      if (expression.startsWith("{")) {
        const end = expression.indexOf("}");
        if (end === -1) {
          return undefined;
        }
        const entries = new Map<string, string>();
        for (const property of expression.slice(1, end).split(",")) {
          if (property.trim() === "") {
            continue;
          }
          const entry =
            /^\s*(?:\[([\w.]+)\]|([\w]+))\s*:\s*("[^"]*"|[\w]+)\s*$/u.exec(
              property,
            );
          const key = entry?.at(1) ?? entry?.at(2);
          const value = entry?.at(3);
          if (key === undefined || value === undefined || entries.has(key)) {
            return undefined;
          }
          entries.set(key, value);
        }
        return { type: "map", file, name, entries };
      }
      return undefined;
    }
    const imported = this.namedImport(file, name);
    if (imported !== undefined) {
      return this.value(imported.module, imported.name, seen);
    }
    for (const match of code.matchAll(
      /export\s*(?:\*|\{([^}]+)\})\s*from\s*"([^"]+)"/gu,
    )) {
      const [, bindings, specifier] = match;
      if (specifier === undefined) {
        continue;
      }
      const exported =
        bindings === undefined
          ? name
          : bindings
              .split(",")
              .map((binding) => binding.trim())
              .find((binding) => binding === name);
      if (exported === undefined) {
        continue;
      }
      const module = this.resolve(file, specifier);
      if (module === undefined) {
        continue;
      }
      const value = this.value(module, exported, seen);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }

  key(file: string, expression: string): string | undefined {
    const [constant, member] = expression.split(".");
    if (constant === undefined || member === undefined) {
      return undefined;
    }
    const values = this.value(file, constant);
    const literal =
      values?.type === "map" ? values.entries.get(member) : undefined;
    return literal?.startsWith('"') ? JSON.parse(literal) : undefined;
  }

  version(module: string, sourceKey: string): number | undefined {
    const versions = new Set<number>();
    for (const file of this.closure(module)) {
      if (!file.startsWith(ADAPTER_DIRECTORY)) {
        continue;
      }
      for (const match of this.code(file).matchAll(
        /\bparserVersion\s*:\s*(\w+)(?:\s*\[\s*([\w.]+)\s*\])?/gu,
      )) {
        const [, constant, index] = match;
        if (constant === undefined) {
          return undefined;
        }
        const value = this.value(file, constant);
        let version: number | undefined;
        if (value !== undefined) {
          const declarations =
            this.versionDeclarations.get(value.file) ?? new Set<string>();
          declarations.add(value.name);
          this.versionDeclarations.set(value.file, declarations);
        }
        if (index === undefined && value?.type === "number") {
          // A bare constant in an imported module versions that module's own
          // records (e.g. collection enrichment), not this source's decisions.
          if (file !== module) {
            continue;
          }
          version = value.value;
        } else if (index !== undefined && value?.type === "map") {
          const key = index.endsWith(".key")
            ? sourceKey
            : this.key(file, index);
          // An imported adapter declares its own source's version; that one
          // versions another source, not this one.
          if (key !== undefined && key !== sourceKey) {
            continue;
          }
          for (const [entryKey, entryValue] of value.entries) {
            if (
              this.key(value.file, entryKey) === key &&
              /^\d+$/u.test(entryValue)
            ) {
              version = Number(entryValue);
            }
          }
        }
        if (
          version === undefined ||
          !Number.isSafeInteger(version) ||
          version < 1
        ) {
          return undefined;
        }
        versions.add(version);
      }
    }
    return versions.size === 1 ? versions.values().next().value : undefined;
  }

  comparableSource(file: string): string | undefined {
    let source = this.files.get(file);
    if (source === undefined) {
      return undefined;
    }
    // Version declarations may share a module with parser helpers. Ignore only
    // their numeric values, so a bump does not demand another bump elsewhere.
    for (const name of this.versionDeclarations.get(file) ?? []) {
      const declaration = `\\b(?:const|let|var)\\s+${name}(?:\\s*:[^=;]+)?\\s*=\\s*`;
      source = source.replace(
        new RegExp(`(${declaration})\\d+\\b`, "u"),
        "$1<VERSION>",
      );
      source = source.replace(
        new RegExp(`(${declaration}\\{)([^}]*)(\\})`, "u"),
        (_, start: string, properties: string, end: string) =>
          `${start}${properties.replace(/(:\s*)\d+\b/gu, "$1<VERSION>")}${end}`,
      );
    }
    return source;
  }

  owners(): SourceOwnersResult {
    const owners = new Map<string, SourceOwner>();
    const errors: string[] = [];
    for (const registry of ["ADAPTER_REGISTRY", "IMPORT_REGISTRY"]) {
      const entries = this.value(REGISTRY_PATH, registry);
      if (entries?.type !== "map") {
        errors.push(`Cannot statically read ${registry} in ${REGISTRY_PATH}`);
        continue;
      }
      for (const [keyExpression, binding] of entries.entries) {
        const key = this.key(REGISTRY_PATH, keyExpression);
        const imported = this.namedImport(REGISTRY_PATH, binding);
        const version =
          key === undefined || imported === undefined
            ? undefined
            : this.version(imported.module, key);
        if (
          key === undefined ||
          imported === undefined ||
          version === undefined
        ) {
          errors.push(
            `Registry entry ${keyExpression} has no resolvable adapter or parser version`,
          );
          continue;
        }
        const parsers = new Set<string>();
        for (const file of this.closure(imported.module)) {
          // Adapter-local assemblers, stored-raw decoders and case-law helpers
          // determine output even when no dedicated parser module exists.
          if (
            file.startsWith(ADAPTER_DIRECTORY) ||
            file.startsWith(CASE_LAW_DIRECTORY)
          ) {
            parsers.add(file);
          }
          if (
            PARSER_DIRECTORIES.some((directory) => file.startsWith(directory))
          ) {
            for (const dependency of this.closure(file)) {
              parsers.add(dependency);
            }
          }
        }
        owners.set(key, { module: imported.module, version, parsers });
      }
    }
    errors.push(...this.importErrors);
    const registeredSources: RegisteredParserSource[] = [];
    const parserFiles = new Set<string>();
    const registryErrors: string[] = [];
    for (const [registry, file, name] of [
      ["case-law-crawl", REGISTRY_PATH, "ADAPTER_REGISTRY"],
      ["case-law-import", REGISTRY_PATH, "IMPORT_REGISTRY"],
      [
        "legislation",
        LEGISLATION_REGISTRY_PATH,
        "LEGISLATION_ADAPTER_REGISTRY",
      ],
    ] as const) {
      const entries = this.value(file, name);
      if (entries?.type !== "map") {
        registryErrors.push(`Cannot statically read ${name} in ${file}`);
        continue;
      }
      for (const [keyExpression, binding] of entries.entries) {
        const key = this.key(file, keyExpression);
        const imported = this.namedImport(file, binding);
        if (key === undefined || imported === undefined) {
          registryErrors.push(
            `Registry entry ${keyExpression} has no resolvable module in ${file}`,
          );
          continue;
        }
        registeredSources.push({ registry, key, module: imported.module });
        for (const source of this.closure(imported.module)) {
          if (
            source.startsWith(ADAPTER_DIRECTORY) ||
            source.startsWith(LEGISLATION_ADAPTER_DIRECTORY) ||
            PARSER_DIRECTORIES.some((directory) =>
              source.startsWith(directory),
            ) ||
            (source.startsWith(LEGISLATION_DIRECTORY) &&
              source.includes("/parsers/"))
          ) {
            parserFiles.add(source);
          }
        }
      }
    }
    registryErrors.push(...this.importErrors);
    return { owners, registeredSources, parserFiles, errors, registryErrors };
  }
}

/** Read the registered output owners without importing live adapters. */
export const sourceOwners = (files: SourceTree): SourceOwnersResult =>
  new StaticTree(files).owners();

// Match the original source rather than transpiled output: local types and
// unused imports can be erased, but deleting them still needs a version decision.
const isReexportOnlyModule = (source: string): boolean => {
  const tokenPattern =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*|[{}*,;]/uy;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    tokenPattern.lastIndex = offset;
    const token = tokenPattern.exec(source)?.at(0);
    if (token === undefined) {
      return false;
    }
    offset = tokenPattern.lastIndex;
    if (
      /^\s/u.test(token) ||
      token.startsWith("//") ||
      token.startsWith("/*")
    ) {
      continue;
    }
    tokens.push(
      token.startsWith('"') || token.startsWith("'") ? '"specifier"' : token,
    );
  }
  const identifier = "[$_\\p{ID_Start}][$_\\u200c\\u200d\\p{ID_Continue}]*";
  const name = `(?:${identifier}|"specifier")`;
  const binding = `(?:type )?${name}(?: as ${name})?`;
  const bindings = `\\{(?: ${binding}(?: , ${binding})*(?: ,)?)? \\}`;
  const reexport = `export (?:type )?(?:\\*|${bindings}) from "specifier"(?: ;)?`;
  return new RegExp(`^(?:${reexport}(?: |$))*$`, "u").test(tokens.join(" "));
};

const withoutOutputUnchangedMarkers = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !OUTPUT_UNCHANGED.test(line))
    .join("\n");

const movedParserSources = (
  base: SourceTree,
  head: SourceTree,
): ReadonlySet<string> => {
  const addedBySource = new Map<string, string[]>();
  for (const [file, source] of head) {
    if (base.has(file)) {
      continue;
    }
    const comparable = withoutOutputUnchangedMarkers(source);
    const paths = addedBySource.get(comparable) ?? [];
    paths.push(file);
    addedBySource.set(comparable, paths);
  }

  const moved = new Set<string>();
  for (const [file, source] of base) {
    if (head.has(file)) {
      continue;
    }
    const destinations = addedBySource.get(
      withoutOutputUnchangedMarkers(source),
    );
    if (destinations === undefined) {
      continue;
    }
    moved.add(file);
    for (const destination of destinations) {
      moved.add(destination);
    }
  }
  return moved;
};

type CheckParserVersionsOptions = { base: SourceTree; head: SourceTree };

export const checkParserVersions = ({
  base,
  head,
}: CheckParserVersionsOptions): string[] => {
  const baseTree = new StaticTree(base);
  const headTree = new StaticTree(head);
  const before = baseTree.owners();
  const after = headTree.owners();
  const errors = [...before.errors, ...after.errors];
  const movedSources = movedParserSources(base, head);
  const deletedReexports = new Set<string>();
  for (const [file, source] of base) {
    if (!head.has(file) && isReexportOnlyModule(source)) {
      deletedReexports.add(file);
    }
  }
  for (const [key, current] of after.owners) {
    const previous = before.owners.get(key);
    if (previous === undefined) {
      continue;
    }
    if (current.version < previous.version) {
      errors.push(
        `${key}: parser version ${current.version} must not be lower than base ${previous.version}`,
      );
      continue;
    }
    const changed = [
      ...new Set([...previous.parsers, ...current.parsers]),
    ].filter(
      (file) =>
        baseTree.comparableSource(file) !== headTree.comparableSource(file),
    );
    if (changed.length === 0 || current.version > previous.version) {
      continue;
    }
    const unexempted = changed.filter((file) => {
      if (movedSources.has(file) || deletedReexports.has(file)) {
        return false;
      }
      const baseLines = new Set((base.get(file) ?? "").split("\n"));
      return !(head.get(file) ?? "").split("\n").some((line) => {
        if (baseLines.has(line)) {
          return false;
        }
        const marker = OUTPUT_UNCHANGED.exec(line);
        const owner = marker?.at(1);
        return marker !== null && (owner === undefined || owner === key);
      });
    });
    if (unexempted.length > 0) {
      errors.push(
        `${key}: parser version ${current.version} must exceed base ${previous.version}; changed: ${unexempted.join(", ")}`,
      );
    }
  }
  return errors;
};

type GitResult =
  | { type: "ok"; output: Uint8Array }
  | { type: "failed"; detail: string };

const git = (args: string[], input?: string): GitResult => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0
    ? { type: "ok", output: result.stdout }
    : { type: "failed", detail: result.stderr.toString().trim() };
};

type ReadGitTreeResult =
  | { type: "ok"; files: SourceTree }
  | { type: "failed"; detail: string };

// Read immutable git objects in one batch, without checking out either tree.
export const readGitTree = (ref: string): ReadGitTreeResult => {
  const listing = git([
    "ls-tree",
    "-r",
    "-z",
    ref,
    "--",
    "apps/api/src",
    "packages",
  ]);
  if (listing.type === "failed") {
    return listing;
  }
  const files = new Map<string, string>();
  const sources: { file: string; object: string }[] = [];
  for (const row of new TextDecoder().decode(listing.output).split("\0")) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/u.exec(row);
    const object = match?.at(1);
    const file = match?.at(2);
    if (object === undefined || file === undefined) {
      continue;
    }
    // Other imports (JSON, wasm, etc.) still enter the dependency graph by
    // object identity; only code and package export maps need decoding.
    files.set(file, `git-blob:${object}`);
    if (/\.[cm]?[jt]sx?$/u.test(file) || file.endsWith("/package.json")) {
      sources.push({ file, object });
    }
  }
  const objects = git(
    ["cat-file", "--batch"],
    `${sources.map(({ object }) => object).join("\n")}\n`,
  );
  if (objects.type === "failed") {
    return objects;
  }
  const decoder = new TextDecoder();
  let offset = 0;
  for (const { file, object } of sources) {
    const headerEnd = objects.output.indexOf(10, offset);
    if (headerEnd === -1) {
      return { type: "failed", detail: "Truncated git object batch" };
    }
    const header = decoder.decode(objects.output.subarray(offset, headerEnd));
    const size = Number(header.split(" ").at(2));
    if (
      !header.startsWith(`${object} blob `) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      return {
        type: "failed",
        detail: `Invalid git object header for ${file}`,
      };
    }
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= objects.output.length || objects.output.at(end) !== 10) {
      return { type: "failed", detail: `Truncated git object for ${file}` };
    }
    files.set(file, decoder.decode(objects.output.subarray(start, end)));
    offset = end + 1;
  }
  return { type: "ok", files };
};

type ComparisonBaseOptions = {
  event: string;
  base: string;
  head: string;
  /** The pull request's own head; identifies GitHub's test merge commit. */
  pullRequestHead?: string;
  runGit?: typeof git;
};

export const comparisonBase = ({
  event,
  base,
  head,
  pullRequestHead = "",
  runGit = git,
}: ComparisonBaseOptions): GitResult => {
  if (event === "merge_group") {
    if (base === "") {
      return {
        type: "failed",
        detail: "merge_group requires its exact base SHA",
      };
    }
    // No merge-base here: the exact queue base includes every earlier bump.
    return runGit(["rev-parse", "--verify", `${base}^{commit}`]);
  }
  if (event !== "pull_request" && event !== "workflow_dispatch") {
    return {
      type: "failed",
      detail: `Unsupported parser-version event: ${event}`,
    };
  }
  if (event === "pull_request" && base === "") {
    return { type: "failed", detail: "pull_request requires its base SHA" };
  }
  // A pull request is tested on GitHub's test merge commit, whose first parent
  // is the base it merged onto; the event's base SHA can lag behind that, which
  // would attribute later base commits to the pull request. Only a merge whose
  // second parent is the pull request head is that test merge: a branch head
  // can itself be a merge commit.
  if (event === "pull_request" && pullRequestHead !== "") {
    const second = runGit(["rev-parse", "--verify", "--quiet", `${head}^2`]);
    if (
      second.type === "ok" &&
      new TextDecoder().decode(second.output).trim() === pullRequestHead &&
      runGit(["merge-base", "--is-ancestor", base, `${head}^1`]).type === "ok"
    ) {
      return runGit(["rev-parse", "--verify", `${head}^1^{commit}`]);
    }
  }
  return runGit(["merge-base", base === "" ? "origin/main" : base, head]);
};

const main = (): number => {
  const head = process.env["HEAD_SHA"] ?? "HEAD";
  const base = comparisonBase({
    event: process.env["EVENT_NAME"] ?? "workflow_dispatch",
    base: process.env["BASE_SHA"] ?? "",
    head,
    pullRequestHead: process.env["PR_HEAD_SHA"] ?? "",
  });
  if (base.type === "failed") {
    console.error(base.detail);
    return 1;
  }
  const before = readGitTree(new TextDecoder().decode(base.output).trim());
  const after = readGitTree(head);
  if (before.type === "failed") {
    console.error(before.detail);
    return 1;
  }
  if (after.type === "failed") {
    console.error(after.detail);
    return 1;
  }
  const errors = checkParserVersions({ base: before.files, head: after.files });
  for (const error of errors) {
    console.error(`parser-version-guard: ${error}`);
  }
  if (errors.length === 0) {
    console.log(
      "parser-version-guard: registered parser versions cover the changed source files",
    );
  }
  return errors.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `parser-version-guard: static source analysis failed: ${String(error)}`,
    );
    process.exitCode = 1;
  }
}
