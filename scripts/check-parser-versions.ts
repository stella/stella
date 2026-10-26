import path from "node:path";

/**
 * Parser versions cover the source modules that can shape persisted parser
 * output. Traversal stops before the reviewed infrastructure boundaries below:
 * their imported bindings provide observability, configuration, or connection
 * setup and are never written into a parser result. Keep this list small; the
 * guard rejects missing entries and entries under output-shaping roots.
 */
export const PARSER_OUTPUT_BOUNDARIES = [
  {
    path: "apps/api/src/env-base.ts",
    reason:
      "Environment validation provides configuration and never parser output values.",
  },
  {
    path: "apps/api/src/lib/observability/logger.ts",
    reason: "Structured logging is an output-independent side effect.",
  },
  {
    path: "apps/api/src/lib/version.ts",
    reason:
      "The application version configures request identification and telemetry.",
  },
] as const satisfies readonly { path: string; reason: string }[];

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
/** The root manifest, whose `patchedDependencies` patch npm packages. */
const ROOT_MANIFEST = "package.json";
const PATCH_DIRECTORY = "patches";
const PARSER_VERSION_MODULE =
  "apps/api/src/lib/legal-search/ingestion-constants.ts";
const OUTPUT_SHAPING_ROOTS = [
  ADAPTER_DIRECTORY,
  LEGISLATION_ADAPTER_DIRECTORY,
  ...PARSER_DIRECTORIES,
  CASE_LAW_DIRECTORY,
  "packages/legal-ast/",
  "packages/text-normalize/",
  "packages/sha256/",
];
const OUTPUT_UNCHANGED =
  /^\s*\/\/\s*parser-output-unchanged:\s+(?:\[([a-z\d-]+)\]\s+\S.*|(?!\[)(\S.*))$/u;
const transpiler = new Bun.Transpiler({ loader: "ts" });
const jsxTranspiler = new Bun.Transpiler({ loader: "tsx" });

type SourceTree = ReadonlyMap<string, string>;
export type ParserOutputBoundary = {
  path: string;
  reason: string;
};
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
  /** npm packages imported anywhere in the module's closure. */
  packages: ReadonlySet<string>;
};

/**
 * A version an imported module stamps on records of its own (a collection
 * enrichment cache), declared as a bare constant. It versions what that
 * module's closure reads, the way a registry entry's version does.
 */
type RecordVersionOwner = SourceOwner & {
  /** The constant, named where the guard reports it. */
  name: string;
  /** The file that declares the constant. */
  file: string;
};

/** A dependency patch that `patchedDependencies` applies. */
type DependencyPatch = {
  /** The patch file, as the root manifest names it. */
  file: string;
  /** The manifest entry and the patch content: any change to either counts. */
  identity: string;
};

type DependencyPatchesResult = {
  /** By patched package name (`@libpdf/core`). */
  patches: ReadonlyMap<string, DependencyPatch>;
  errors: readonly string[];
};

type RegisteredParserSource = {
  registry: string;
  key: string;
  module: string;
};

type SourceOwnersResult = {
  owners: ReadonlyMap<string, SourceOwner>;
  /** By a key derived from the constant's name (`sk-collection-parser-version`). */
  recordOwners: ReadonlyMap<string, RecordVersionOwner>;
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
  /** Record versions by constant identity, with the files that stamp them. */
  private readonly recordVersions = new Map<
    string,
    { name: string; file: string; version: number; stampedIn: Set<string> }
  >();
  private readonly codeCache = new Map<string, string>();
  private readonly closureCache = new Map<string, Set<string>>();
  private readonly outputBoundaries: ReadonlySet<string>;

  readonly files: SourceTree;

  constructor(
    files: SourceTree,
    boundaries: readonly ParserOutputBoundary[] = PARSER_OUTPUT_BOUNDARIES,
  ) {
    this.files = files;
    this.outputBoundaries = new Set(boundaries.map(({ path: file }) => file));
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
      if (
        current === undefined ||
        files.has(current) ||
        this.outputBoundaries.has(current)
      ) {
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
          // records (e.g. collection enrichment), not this source's decisions;
          // it is checked as a record version of its own.
          if (file !== module) {
            const identity = `${value.file}::${value.name}`;
            const record = this.recordVersions.get(identity) ?? {
              name: value.name,
              file: value.file,
              version: value.value,
              stampedIn: new Set<string>(),
            };
            record.stampedIn.add(file);
            this.recordVersions.set(identity, record);
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
        (_, start: string) => `${start}0`,
      );
      source = source.replace(
        new RegExp(`(${declaration}\\{)([^}]*)(\\})`, "u"),
        (_, start: string, properties: string, end: string) =>
          `${start}${properties.replace(/(:\s*)\d+\b/gu, (_number, colon: string) => `${colon}0`)}${end}`,
      );
    }
    return printedCode(file, source);
  }

  /** The npm packages a module imports by name, at run time. */
  packageImports(file: string): string[] {
    const source = this.files.get(file);
    if (source === undefined || !SOURCE_MODULE.test(file)) {
      return [];
    }
    return (file.endsWith("x") ? jsxTranspiler : transpiler)
      .scanImports(source)
      .flatMap(({ path: specifier }) => {
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("@/") ||
          /^(?:node|bun):/u.test(specifier) ||
          this.resolve(file, specifier) !== undefined
        ) {
          return [];
        }
        const [scope = "", name = ""] = specifier.split("/");
        return [scope.startsWith("@") ? `${scope}/${name}` : scope];
      });
  }

  /** What a module's output depends on: its output-shaping files and packages. */
  outputOf(module: string): Pick<SourceOwner, "parsers" | "packages"> {
    const parsers = new Set<string>();
    const packages = new Set<string>();
    for (const file of this.closure(module)) {
      for (const name of this.packageImports(file)) {
        packages.add(name);
      }
      // Adapter-local assemblers, stored-raw decoders and case-law helpers
      // determine output even when no dedicated parser module exists.
      if (
        file.startsWith(ADAPTER_DIRECTORY) ||
        file.startsWith(CASE_LAW_DIRECTORY)
      ) {
        parsers.add(file);
      }
      if (PARSER_DIRECTORIES.some((directory) => file.startsWith(directory))) {
        for (const dependency of this.closure(file)) {
          parsers.add(dependency);
        }
      }
    }
    return { parsers, packages };
  }

  /**
   * The dependency patches the root manifest applies, by package. A patch it
   * names that the tree does not hold, or an entry naming no package, fails
   * closed.
   */
  dependencyPatches(): DependencyPatchesResult {
    const patches = new Map<string, DependencyPatch>();
    const source = this.files.get(ROOT_MANIFEST);
    if (source === undefined) {
      return { patches, errors: [] };
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(source);
    } catch {
      return { patches, errors: [`Cannot parse ${ROOT_MANIFEST}`] };
    }
    const entries =
      typeof manifest === "object" && manifest !== null
        ? Reflect.get(manifest, "patchedDependencies")
        : undefined;
    if (entries === undefined) {
      return { patches, errors: [] };
    }
    if (typeof entries !== "object" || entries === null) {
      return {
        patches,
        errors: [`${ROOT_MANIFEST} patchedDependencies is not an object`],
      };
    }
    const errors: string[] = [];
    for (const [entry, file] of Object.entries(entries)) {
      const at = entry.lastIndexOf("@");
      const patch = typeof file === "string" ? this.files.get(file) : undefined;
      if (at <= 0 || typeof file !== "string" || patch === undefined) {
        errors.push(
          `${ROOT_MANIFEST} patchedDependencies entry ${entry} names no package and patch file the tree holds`,
        );
        continue;
      }
      patches.set(entry.slice(0, at), {
        file,
        identity: `${entry}\n${patch}`,
      });
    }
    return { patches, errors };
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
        owners.set(key, {
          module: imported.module,
          version,
          ...this.outputOf(imported.module),
        });
      }
    }
    const recordOwners = new Map<string, RecordVersionOwner>();
    for (const {
      name,
      file,
      version,
      stampedIn,
    } of this.recordVersions.values()) {
      const key = name.toLowerCase().replaceAll("_", "-");
      if (!Number.isSafeInteger(version) || version < 1) {
        errors.push(
          `Record version ${name} in ${file} is not a positive integer`,
        );
        continue;
      }
      if (recordOwners.has(key)) {
        errors.push(
          `Record version ${name} in ${file} shares its name with another; rename one`,
        );
        continue;
      }
      // Every module that stamps the version reads what it versions; the
      // declaring module states the records' shape.
      const parsers = new Set<string>([file]);
      const packages = new Set<string>();
      for (const module of stampedIn) {
        const output = this.outputOf(module);
        for (const parser of output.parsers) {
          parsers.add(parser);
        }
        for (const dependency of output.packages) {
          packages.add(dependency);
        }
      }
      recordOwners.set(key, {
        module: [...stampedIn].toSorted().join(", "),
        version,
        parsers,
        packages,
        name,
        file,
      });
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
    return {
      owners,
      recordOwners,
      registeredSources,
      parserFiles,
      errors,
      registryErrors,
    };
  }
}

/** Read the registered output owners without importing live adapters. */
export const sourceOwners = (
  files: SourceTree,
  boundaries: readonly ParserOutputBoundary[] = PARSER_OUTPUT_BOUNDARIES,
): SourceOwnersResult => new StaticTree(files, boundaries).owners();

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

const NAMED_SPECIFIERS =
  /^((?:import|export)(?: type)? \{)([^}]*)(\} from )/gmu;

// Layout, comments, types and the order of names inside one import never
// change what a parser emits, so a formatting-only edit must not demand a
// version bump. Compare the code the transpiler prints, with named
// specifiers sorted; statement order still counts. Source it cannot parse
// compares verbatim, which still demands the bump.
const printedCode = (file: string, source: string): string => {
  const printer = file.endsWith("x") ? jsxTranspiler : transpiler;
  let printed: string;
  try {
    printed = printer.transformSync(source);
  } catch {
    return source;
  }
  return printed.replace(
    NAMED_SPECIFIERS,
    (_, open: string, names: string, close: string) =>
      `${open}${names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .toSorted()
        .join(", ")}${close}`,
  );
};

const LOCATION_DEPENDENT = /\bimport\.meta\b|\b__dirname\b|\b__filename\b/u;
const SOURCE_MODULE = /\.[cm]?[jt]sx?$/u;

const movedParserSources = (
  baseTree: StaticTree,
  headTree: StaticTree,
): ReadonlySet<string> => {
  const base = baseTree.files;
  const head = headTree.files;
  const addedBySource = new Map<string, string[]>();
  for (const [file, source] of head) {
    if (base.has(file) || !SOURCE_MODULE.test(file)) {
      continue;
    }
    const comparable = withoutOutputUnchangedMarkers(source);
    const paths = addedBySource.get(comparable) ?? [];
    paths.push(file);
    addedBySource.set(comparable, paths);
  }

  const moveDestinations = new Map<string, readonly string[]>();
  for (const [file, source] of base) {
    // Code that reads its own location can change output when moved, so it
    // never qualifies as a verbatim move.
    if (
      head.has(file) ||
      !SOURCE_MODULE.test(file) ||
      LOCATION_DEPENDENT.test(source)
    ) {
      continue;
    }
    const destinations = addedBySource.get(
      withoutOutputUnchangedMarkers(source),
    );
    if (destinations === undefined) {
      continue;
    }
    moveDestinations.set(file, destinations);
  }

  const moved = new Set<string>();
  for (const [file, destinations] of moveDestinations) {
    // The text is identical, so both sides scan the same specifiers; each must
    // resolve to the module its base target moved to (or the same module).
    const specifiers = (file.endsWith("x") ? jsxTranspiler : transpiler)
      .scanImports(base.get(file) ?? "")
      .map(({ path: specifier }) => specifier);
    for (const destination of destinations) {
      const sameBindings = specifiers.every((specifier) => {
        const baseTarget = baseTree.resolve(file, specifier);
        const headTarget = headTree.resolve(destination, specifier);
        if (baseTarget === undefined || headTarget === undefined) {
          return baseTarget === headTarget;
        }
        return (moveDestinations.get(baseTarget) ?? [baseTarget]).includes(
          headTarget,
        );
      });
      if (!sameBindings) {
        continue;
      }
      moved.add(file);
      moved.add(destination);
    }
  }
  return moved;
};

type CheckParserVersionsOptions = {
  base: SourceTree;
  head: SourceTree;
  boundaries?: readonly ParserOutputBoundary[];
};

const boundaryErrors = (
  head: SourceTree,
  boundaries: readonly ParserOutputBoundary[],
): string[] =>
  boundaries.flatMap(({ path: file }) => {
    if (!head.has(file)) {
      return [`Parser output boundary does not exist in head tree: ${file}`];
    }
    if (
      file === PARSER_VERSION_MODULE ||
      OUTPUT_SHAPING_ROOTS.some((root) => file.startsWith(root))
    ) {
      return [`Parser output boundary lies in an output-shaping root: ${file}`];
    }
    return [];
  });

export const checkParserVersions = ({
  base,
  head,
  boundaries = PARSER_OUTPUT_BOUNDARIES,
}: CheckParserVersionsOptions): string[] => {
  const baseTree = new StaticTree(base, boundaries);
  const headTree = new StaticTree(head, boundaries);
  const before = baseTree.owners();
  const after = headTree.owners();
  const errors = [
    ...boundaryErrors(head, boundaries),
    ...before.errors,
    ...after.errors,
  ];
  const movedSources = movedParserSources(baseTree, headTree);
  const deletedReexports = new Set<string>();
  for (const [file, source] of base) {
    if (!head.has(file) && isReexportOnlyModule(source)) {
      deletedReexports.add(file);
    }
  }
  const basePatches = baseTree.dependencyPatches();
  const headPatches = headTree.dependencyPatches();
  errors.push(...basePatches.errors, ...headPatches.errors);

  const compare = (
    key: string,
    /** How the version is named in an error: the source key or the constant. */
    label: string,
    previous: SourceOwner,
    current: SourceOwner,
  ): void => {
    if (current.version < previous.version) {
      errors.push(
        `${label}: parser version ${current.version} must not be lower than base ${previous.version}`,
      );
      return;
    }
    const changed = [
      ...new Set([...previous.parsers, ...current.parsers]),
    ].filter(
      (file) =>
        baseTree.comparableSource(file) !== headTree.comparableSource(file),
    );
    // A patch changes what every module importing its package reads, so it
    // takes a bump no marker can waive.
    const changedPatches = [
      ...new Set([...previous.packages, ...current.packages]),
    ]
      .toSorted()
      .flatMap((name) => {
        const was = basePatches.patches.get(name);
        const now = headPatches.patches.get(name);
        return was?.identity === now?.identity
          ? []
          : [`${now?.file ?? was?.file ?? PATCH_DIRECTORY} (patches ${name})`];
      });
    if (
      (changed.length === 0 && changedPatches.length === 0) ||
      current.version > previous.version
    ) {
      return;
    }
    // A marked parser that still imports a workspace package removed from the
    // repository now gets it from the registry; only that package's deleted
    // files are covered by the marker.
    const externalizedRoots = [...current.parsers].flatMap((file) => {
      const baseLines = new Set((base.get(file) ?? "").split("\n"));
      const marked = (head.get(file) ?? "").split("\n").some((line) => {
        if (baseLines.has(line)) {
          return false;
        }
        const marker = OUTPUT_UNCHANGED.exec(line);
        const owner = marker?.at(1);
        return marker !== null && (owner === undefined || owner === key);
      });
      if (!marked) {
        return [];
      }
      return (file.endsWith("x") ? jsxTranspiler : transpiler)
        .scanImports(head.get(file) ?? "")
        .flatMap(({ path: specifier }) => {
          const name = specifier.startsWith("@stll/")
            ? specifier.slice("@stll/".length).split("/").at(0)
            : undefined;
          const root = `packages/${name ?? ""}/`;
          return name !== undefined &&
            baseTree.resolve(file, specifier) !== undefined &&
            !head.has(`${root}package.json`)
            ? [root]
            : [];
        });
    });
    const unexempted = changed.filter((file) => {
      if (movedSources.has(file) || deletedReexports.has(file)) {
        return false;
      }
      if (
        !head.has(file) &&
        externalizedRoots.some((root) => file.startsWith(root))
      ) {
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
    const unexplained = [...unexempted, ...changedPatches];
    if (unexplained.length > 0) {
      errors.push(
        `${label}: parser version ${current.version} must exceed base ${previous.version}; changed: ${unexplained.join(", ")}`,
      );
    }
  };

  for (const [key, current] of after.owners) {
    const previous = before.owners.get(key);
    if (previous !== undefined) {
      compare(key, key, previous, current);
    }
  }
  for (const [key, current] of after.recordOwners) {
    const previous = before.recordOwners.get(key);
    if (previous !== undefined) {
      compare(key, `${current.name} in ${current.file}`, previous, current);
    }
  }
  return errors;
};

type GitResult =
  { type: "ok"; output: Uint8Array } | { type: "failed"; detail: string };

const gitIn =
  (repository: string) =>
  (args: string[], input?: string): GitResult => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repository,
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0
      ? { type: "ok", output: result.stdout }
      : { type: "failed", detail: result.stderr.toString().trim() };
  };

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const git = gitIn(REPOSITORY_ROOT);

/**
 * CI checks out a blobless clone (`filter: blob:none`), which holds only the
 * blobs its checkout wrote; `cat-file --batch` would fetch every other one in
 * a round trip of its own, so a large diff spent minutes on base versions.
 * One fetch of every missing blob replaces those round trips.
 */
const fetchMissingObjects = (
  objects: readonly string[],
  runGit: typeof git,
): GitResult => {
  const check = runGit(
    ["--no-lazy-fetch", "cat-file", "--batch-check=%(objectname)"],
    `${objects.join("\n")}\n`,
  );
  if (check.type === "failed") {
    return check;
  }
  const missing = new TextDecoder()
    .decode(check.output)
    .split("\n")
    .flatMap((line) => {
      const [object, state] = line.split(" ");
      return state === "missing" && object !== undefined ? [object] : [];
    });
  if (missing.length === 0) {
    return check;
  }
  const promisors = runGit([
    "config",
    "--get-regexp",
    String.raw`^remote\..+\.promisor$`,
  ]);
  const remote =
    promisors.type === "ok"
      ? /^remote\.(.+)\.promisor true$/mu
          .exec(new TextDecoder().decode(promisors.output))
          ?.at(1)
      : undefined;
  if (remote === undefined) {
    return {
      type: "failed",
      detail: `${String(missing.length)} source objects are missing and no promisor remote can supply them`,
    };
  }
  // Match Git's lazy fetch: object IDs may be blobs, so commit negotiation
  // must not interpret them as revision tips.
  return runGit(
    [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
      remote,
    ],
    `${missing.join("\n")}\n`,
  );
};

type ReadGitTreeResult =
  { type: "ok"; files: SourceTree } | { type: "failed"; detail: string };

type ReadGitTreeOptions = {
  repository?: string;
};

// Read immutable git objects in one batch, without checking out either tree.
export const readGitTree = (
  ref: string,
  { repository = REPOSITORY_ROOT }: ReadGitTreeOptions = {},
): ReadGitTreeResult => {
  const runGit = gitIn(repository);
  const listing = runGit([
    "ls-tree",
    "-r",
    "-z",
    ref,
    "--",
    "apps/api/src",
    "packages",
    PATCH_DIRECTORY,
    ROOT_MANIFEST,
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
    // object identity, and so do dependency patches; only code and package
    // manifests need decoding.
    files.set(file, `git-blob:${object}`);
    if (
      /\.[cm]?[jt]sx?$/u.test(file) ||
      file.endsWith("/package.json") ||
      file === ROOT_MANIFEST
    ) {
      sources.push({ file, object });
    }
  }
  if (sources.length === 0) {
    return { type: "ok", files };
  }
  const wanted = sources.map(({ object }) => object);
  const fetched = fetchMissingObjects(wanted, runGit);
  if (fetched.type === "failed") {
    return fetched;
  }
  const objects = runGit(["cat-file", "--batch"], `${wanted.join("\n")}\n`);
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
