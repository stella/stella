import { panic, Result } from "better-result";
// Prints the API types apps/web consumes (`WebApiContract` in
// src/web-contract.ts) into apps/web/src/generated/api-routes.gen.ts. apps/web
// type-checks against that snapshot instead of re-inferring the whole API
// graph. The API implementation stays the source of truth: --check asserts,
// through the compiler's identity relation, that each printed type is
// identical to the inferred one. `--check` compares two independently
// generated printouts and fails if the bytes differ; the output is local build
// input rather than committed state.
// Without --check, a run whose compiler inputs are unchanged since the last
// printout restores that printout from .cache/web-api-types instead of
// building the API program (see lib/compiler-input-stamp.ts).
//
// The program is built and read by TypeScript 7 (tsgo) through its API, the
// compiler apps/web type-checks with (see lib/web-api-program.ts). Every
// question to the checker is a request to that process; the printer caches
// each answer, so a type reached twice costs one request.
//
// Modes:
//   bun --filter @stll/api gen:web-api-types           regenerate the file
//   bun --filter @stll/api gen:web-api-types --check   CI determinism guard
//
// Printing rules:
// - Types owned by a package apps/web depends on are imported by name, never
//   expanded: expansion loses generic
//   identity (`X extends UIMessage<infer T>`) and brands keyed by a unique
//   symbol the package does not export.
// - A type reached more than once, or recursively, becomes a local alias named
//   from a hash of its smallest path, with no union or intersection positions
//   in it (see lib/web-api-alias-names.ts), so adding a route renames only a
//   type it reaches along a smaller path than before.
// - Union members print in a canonical order rather than the compiler's
//   type-id order, which follows whichever literal the checker happened to
//   create first (see lib/web-api-union-order.ts). Intersection members and
//   object properties keep declaration order, which the compiler preserves.
// - Anything the printer cannot express structurally falls back to
//   `typeToString` and is reported; the identity check then decides.
// - A route's `response` prints as the client reads it: JSON carries a `Date`
//   as its ISO string and the client never revives it, so every `Date` reached
//   from a response prints as `string` (a package type carrying one is
//   expanded). The identity check runs on the same printout with `Date` kept.
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import typescriptPackage from "typescript/package.json" with { type: "json" };
import type { Node, SourceFile } from "typescript/unstable/ast";
import {
  isComputedPropertyName,
  isParameterDeclaration,
  isPropertySignatureDeclaration,
} from "typescript/unstable/ast/is";
import {
  type Checker,
  type Diagnostic,
  DiagnosticCategory,
  ElementFlags,
  ModifierFlags,
  ObjectFlags,
  type ObjectType,
  type Signature,
  SignatureKind,
  type Symbol as CompilerSymbol,
  SymbolFlags,
  type TemplateLiteralType,
  type TupleType,
  type Type,
  TypeFlags,
  TypePredicateKind,
  type TypeReference,
  type UnionOrIntersectionType,
} from "typescript/unstable/async";
import * as v from "valibot";

import { printError } from "@stll/errors";
import { repoRelativePath } from "@stll/portable-path";
import { sha256Hex } from "@stll/sha256/bun";

import { withGenerationLock } from "../../../packages/scripts/src/generation-lock";
import {
  hasPreparedGeneratedSources,
  preparedGeneratedFile,
} from "../../../packages/scripts/src/prepared-generated-sources";
import { childPeakRssMiB } from "./lib/child-process-rss";
import {
  type CompilerInputRecorder,
  compilerInputStampSchema,
  createCompilerInputRecorder,
  isCompilerInputStampCurrent,
  scriptSourceHash,
} from "./lib/compiler-input-stamp";
import {
  generatedStoreDir,
  publishGeneratedOutput,
  restoreGeneratedOutput,
} from "./lib/generated-output-store";
import {
  ALIAS_NAME,
  type AliasGraphEdge,
  nameAliases,
} from "./lib/web-api-alias-names";
import {
  type ContractProgram,
  openContractProgram,
} from "./lib/web-api-program";
import {
  uncoveredCompilerInputs,
  webApiDependencyOutputs,
  webApiTurboInputs,
} from "./lib/web-api-turbo-inputs";
import {
  orderUnionMembers,
  type UnionMemberKind,
} from "./lib/web-api-union-order";

const API_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(API_DIR, "../..");
const WEB_DIR = path.join(REPO_ROOT, "apps/web");
const CONTRACT_PATH = path.join(API_DIR, "src/web-contract.ts");
const CONTRACT_TYPE = "WebApiContract";
const OUTPUT_PATH = path.join(WEB_DIR, "src/generated/api-routes.gen.ts");
// Served from memory, never written: asserts identity inside the API program.
const CHECK_PATH = path.join(API_DIR, "src/__web-api-contract-check__.ts");
// Served from memory beside the output so its relative imports resolve: the
// written printout, compiled for diagnostics of its own.
const WIRE_CHECK_PATH = path.join(
  WEB_DIR,
  "src/generated/__api-routes-wire-check__.ts",
);
// Local, gitignored: the last printout and the compiler inputs it came from.
const CACHE_DIR = path.join(REPO_ROOT, ".cache/web-api-types");
const STAMP_PATH = path.join(CACHE_DIR, "stamp.json");
const CACHED_OUTPUT_PATH = path.join(CACHE_DIR, "api-routes.gen.ts");
const REGENERATE_COMMAND = "bun --filter @stll/api gen:web-api-types";
const HEADER = [
  "// Generated by apps/api/scripts/generate-web-api-types.ts from",
  `// ${CONTRACT_TYPE} in apps/api/src/web-contract.ts. Do not edit.`,
  `// Regenerate: ${REGENERATE_COMMAND}`,
];
// The program the generator builds: the API's own options, nothing emitted.
const PROGRAM_OPTIONS = { noEmit: true, incremental: false };

// A relative import specifier: forward slashes on every platform, so a
// Windows run neither escapes `\n` into the path nor differs from the snapshot.
const moduleSpecifier = (fromDirectory: string, target: string): string => {
  const relative = repoRelativePath(fromDirectory, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
};

/**
 * Whether a single-bit compiler flag is set. Arithmetic, not `&`: every
 * TypeScript flag enum member used here is one positive bit below 2^31.
 */
const hasFlag = (flags: number, flag: number): boolean =>
  Math.floor(flags / flag) % 2 === 1;

// --- Diagnostics ----------------------------------------------------------------

const lineAndColumn = (text: string, position: number) => {
  const before = text.slice(0, position).split("\n");
  return `(${before.length},${(before.at(-1)?.length ?? 0) + 1})`;
};

const diagnosticMessage = (diagnostic: Diagnostic, depth: number): string =>
  [
    `${"  ".repeat(depth)}${diagnostic.text}`,
    ...(diagnostic.messageChain ?? []).map((chained) =>
      diagnosticMessage(chained, depth + 1),
    ),
  ].join("\n");

const formatDiagnostics = (
  diagnostics: readonly Diagnostic[],
  sourceText: (fileName: string) => string | undefined,
): string =>
  diagnostics
    .map((diagnostic) => {
      const { fileName } = diagnostic;
      const text = fileName === undefined ? undefined : sourceText(fileName);
      const location =
        fileName === undefined
          ? ""
          : `${repoRelativePath(REPO_ROOT, fileName)}${
              text === undefined ? "" : lineAndColumn(text, diagnostic.pos)
            }: `;
      const category =
        diagnostic.category === DiagnosticCategory.Error ? "error" : "warning";
      return `${location}${category} TS${diagnostic.code}: ${diagnosticMessage(diagnostic, 0).trimStart()}`;
    })
    .join("\n");

// --- Package references -------------------------------------------------------

const readWebDependencies = (
  readFile: (fileName: string) => string | undefined,
): ReadonlySet<string> => {
  const manifestPath = path.join(WEB_DIR, "package.json");
  const manifest: unknown = JSON.parse(
    readFile(manifestPath) ??
      panic(`generate-web-api-types: cannot read ${manifestPath}`),
  );
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const dependencies: unknown =
      typeof manifest === "object" && manifest !== null
        ? Reflect.get(manifest, field)
        : undefined;
    if (typeof dependencies === "object" && dependencies !== null) {
      for (const name of Object.keys(dependencies)) {
        names.add(name);
      }
    }
  }
  return names;
};

const WORKSPACE_PACKAGE_SOURCE = /\/packages\/([^/]+)\/src\//u;
const NODE_MODULES_PACKAGE = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//u;
// Compiler libs and runtime globals print by global name, never as imports.
const GLOBAL_TYPE_PACKAGES = new Set([
  "typescript",
  "@typescript/native-preview",
  "bun-types",
  "@types/bun",
]);

export const packageOfFile = (fileName: string): string | undefined => {
  const workspaceDirectory = WORKSPACE_PACKAGE_SOURCE.exec(fileName)?.[1];
  if (workspaceDirectory !== undefined) {
    return `@stll/${workspaceDirectory}`;
  }
  const lastNodeModules = fileName.lastIndexOf("/node_modules/");
  if (lastNodeModules === -1) {
    return undefined;
  }
  const name = NODE_MODULES_PACKAGE.exec(fileName.slice(lastNodeModules))?.[1];
  return name === undefined ||
    GLOBAL_TYPE_PACKAGES.has(name) ||
    name.startsWith("@typescript/")
    ? undefined
    : name;
};

// --- Printer --------------------------------------------------------------------

type TypeNode = {
  body: string;
  references: number;
  recursive: boolean;
};

type PrintResult = {
  declarations: { name: string; text: string }[];
  aliases: { name: string; text: string }[];
  symbolImports: { local: string; name: string; specifier: string }[];
  typeImports: { local: string; name: string; specifier: string }[];
  fallbacks: Map<string, number>;
  packageReferences: Map<string, number>;
};

const TOKEN = /(\d+)/gu;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const NUMERIC_KEY = /^(?:0|[1-9]\d*)$/u;
const FUNCTION_TYPE = /[=]>/u;
// The compiler names a property keyed by a unique symbol `__@name@id`.
const LATE_BOUND_NAME = "__@";
// `CheckFlags.Readonly`: a property a mapped type made readonly carries the
// modifier only here, not on any declaration.
const CHECK_FLAGS_READONLY = 8;
// `TypeFormatFlags.NoTruncation`.
const NO_TRUNCATION = 1;

// Whether route responses print as JSON delivers them or as the API declares
// them; the latter exists only for the identity check.
const RESPONSE_DATES = { wire: "wire", declared: "declared" } as const;
type ResponseDates = (typeof RESPONSE_DATES)[keyof typeof RESPONSE_DATES];

// The members every route carries in the web route tree (`RouteIO`).
const ROUTE_MEMBERS = ["body", "params", "query", "headers", "response"];

const isInterfaceOrClass = (objectFlags: number): boolean =>
  hasFlag(objectFlags, ObjectFlags.Interface) ||
  hasFlag(objectFlags, ObjectFlags.Class);

const modifierFlagsOf = (node: Node): number =>
  "modifierFlags" in node && typeof node.modifierFlags === "number"
    ? node.modifierFlags
    : 0;

const unionMemberKind = (type: Type): UnionMemberKind => {
  if (hasFlag(type.flags, TypeFlags.Null)) {
    return { type: "null" };
  }
  if (hasFlag(type.flags, TypeFlags.Undefined)) {
    return { type: "undefined" };
  }
  if (type.isStringLiteralType()) {
    return { type: "string", value: type.value };
  }
  if (type.isNumberLiteralType()) {
    return { type: "number", value: type.value };
  }
  if (type.isBigIntLiteralType()) {
    return { type: "bigint" };
  }
  return type.isBooleanLiteralType() ? { type: "boolean" } : { type: "other" };
};

// One request per type or symbol: the answer is kept, keyed by its id.
const cachedById = <Key extends { readonly id: number }, Value>(
  fetch: (key: Key) => Promise<Value>,
) => {
  const answers = new Map<number, Promise<Value>>();
  return async (key: Key): Promise<Value> => {
    const known = answers.get(key.id);
    if (known !== undefined) {
      return await known;
    }
    const fetched = fetch(key);
    answers.set(key.id, fetched);
    return await fetched;
  };
};

const createCachedCompiler = (checker: Checker, contractSource: SourceFile) => {
  const resolveAlias = async (
    symbol: CompilerSymbol,
  ): Promise<CompilerSymbol> =>
    !hasFlag(symbol.flags, SymbolFlags.Alias)
      ? symbol
      : await checker.getAliasedSymbol(symbol);
  // Global types (lib.*.d.ts, bun-types) print by name when that name resolves
  // to the same symbol from the contract module, and the module itself binds
  // nothing by that name.
  const globalName = cachedById(
    async (symbol: CompilerSymbol): Promise<string | undefined> => {
      const { name } = symbol;
      const bound = await checker.resolveName(
        name,
        SymbolFlags.Type,
        contractSource,
        true,
      );
      if (bound !== undefined) {
        return undefined;
      }
      const global = await checker.resolveName(
        name,
        SymbolFlags.Type,
        contractSource,
        false,
      );
      return global !== undefined &&
        (await resolveAlias(global)).id === symbol.id
        ? name
        : undefined;
    },
  );
  // Kept apart from the other answers: a whole level of property types is
  // asked for in one request (see `prefetch`).
  const symbolTypes = new Map<number, Promise<Type>>();
  const typeOfSymbol = async (symbol: CompilerSymbol): Promise<Type> => {
    const known = symbolTypes.get(symbol.id);
    if (known !== undefined) {
      return await known;
    }
    const fetched = (async () =>
      (await checker.getTypeOfSymbol(symbol)) ??
      panic(`generate-web-api-types: ${symbol.name} has no type`))();
    symbolTypes.set(symbol.id, fetched);
    return await fetched;
  };
  const typesOfSymbols = async (
    symbols: readonly CompilerSymbol[],
  ): Promise<void> => {
    const missing = [
      ...new Map(
        symbols
          .filter(({ id }) => !symbolTypes.has(id))
          .map((symbol) => [symbol.id, symbol]),
      ).values(),
    ];
    if (missing.length === 0) {
      return;
    }
    const fetched = checker.getTypeOfSymbol(missing);
    for (const [index, symbol] of missing.entries()) {
      symbolTypes.set(
        symbol.id,
        fetched.then(
          (types) =>
            types[index] ??
            panic(`generate-web-api-types: ${symbol.name} has no type`),
        ),
      );
    }
    await fetched;
  };
  const targetOf = cachedById(
    async (type: TypeReference) => await type.getTarget(),
  );
  const symbolOf = cachedById(async (type: Type) => await type.getSymbol());
  // Answered here rather than asked: only a reference is an array or a
  // tuple, and its target says which.
  const isTuple = async (type: Type): Promise<boolean> =>
    type.isTypeReference() && (await targetOf(type)).isTupleType();
  const isArray = async (type: Type): Promise<boolean> => {
    if (!type.isTypeReference()) {
      return false;
    }
    const name = await globalNameOf(await symbolOf(await targetOf(type)));
    return name === "Array" || name === "ReadonlyArray";
  };
  const globalNameOf = async (named: CompilerSymbol | undefined) =>
    named === undefined ? undefined : await globalName(named);
  return {
    resolveAlias,
    globalName,
    globalNameOf,
    properties: cachedById(
      async (type: Type) => await checker.getPropertiesOfType(type),
    ),
    typeOfSymbol,
    typesOfSymbols,
    indexInfos: cachedById(
      async (type: Type) => await checker.getIndexInfosOfType(type),
    ),
    callSignatures: cachedById(
      async (type: Type) =>
        await checker.getSignaturesOfType(type, SignatureKind.Call),
    ),
    constructSignatures: cachedById(
      async (type: Type) =>
        await checker.getSignaturesOfType(type, SignatureKind.Construct),
    ),
    typeArguments: cachedById(
      async (type: TypeReference) => await checker.getTypeArguments(type),
    ),
    target: targetOf,
    symbol: symbolOf,
    aliasSymbol: cachedById(async (type: Type) => await type.getAliasSymbol()),
    aliasTypeArguments: cachedById(
      async (type: Type) => await type.getAliasTypeArguments(),
    ),
    typeParameterCount: cachedById(async (target: Type) =>
      target.isClassOrInterface()
        ? (await target.getTypeParameters()).length
        : 0,
    ),
    members: cachedById(
      async (type: UnionOrIntersectionType | TemplateLiteralType) =>
        await type.getTypes(),
    ),
    isArray,
    isTuple,
    declaration: cachedById(
      async (symbol: CompilerSymbol) =>
        await (symbol.valueDeclaration ?? symbol.declarations.at(0))?.resolve(),
    ),
  };
};

type CachedCompiler = ReturnType<typeof createCachedCompiler>;

// One cache per program: the wire and the declared printouts of one program
// ask the same questions.
const cachedCompilers = new WeakMap<Checker, CachedCompiler>();
const cachedCompiler = ({ checker, contractSource }: ContractProgram) => {
  const known = cachedCompilers.get(checker);
  if (known !== undefined) {
    return known;
  }
  const created = createCachedCompiler(checker, contractSource);
  cachedCompilers.set(checker, created);
  return created;
};

type PrinterOptions = {
  program: ContractProgram;
  webDependencies: ReadonlySet<string>;
  responseDates: ResponseDates;
};

export const printContract = async ({
  program,
  webDependencies,
  responseDates,
}: PrinterOptions): Promise<PrintResult> => {
  const { checker, contractSource, fileNameOf, moduleOfPackage } = program;
  const compiler = cachedCompiler(program);
  const { resolveAlias, globalNameOf } = compiler;
  const undefinedType = await checker.getUndefinedType();
  const fallbacks = new Map<string, number>();
  const packageReferences = new Map<string, number>();
  const count = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);
  const fallback = async (reason: string, type: Type): Promise<string> => {
    count(fallbacks, reason);
    return await checker.typeToString(type, undefined, NO_TRUNCATION);
  };

  const declarationFile = (symbol: CompilerSymbol): string | undefined => {
    const declaration = symbol.declarations.at(0);
    return declaration === undefined ? undefined : fileNameOf(declaration.path);
  };

  const moduleExports = new Map<string, Map<number, string> | null>();
  const exportsOfModule = async (
    specifier: string,
  ): Promise<Map<number, string> | null> => {
    const cached = moduleExports.get(specifier);
    if (cached !== undefined) {
      return cached;
    }
    // Resolved from the API side so the entry is the file this program loaded
    // (and so the same symbols); apps/web resolves the same package by name.
    const moduleSymbol = await moduleOfPackage(specifier);
    let exports: Map<number, string> | null = null;
    if (moduleSymbol !== undefined) {
      exports = new Map();
      for (const exported of await checker.getExportsOfModule(moduleSymbol)) {
        exports.set((await resolveAlias(exported)).id, exported.name);
      }
    }
    moduleExports.set(specifier, exports);
    return exports;
  };

  // Unique symbols key type literals, so they are imported as values. A
  // symbol its package entry does not export is imported from its declaring
  // file.
  const symbolImports = new Map<
    string,
    { local: string; name: string; specifier: string }
  >();
  // The declaring file, reached through the package directory apps/web itself
  // installs, so the import lands on the same declaration file (and so the
  // same unique symbol) as the package's own types in the web program.
  const declaringFileSpecifier = (
    symbol: CompilerSymbol,
    fileName: string,
    packageName: string | undefined,
  ): string => {
    const packageMarker =
      packageName === undefined ? undefined : `/node_modules/${packageName}/`;
    const inPackage =
      packageMarker === undefined ? -1 : fileName.lastIndexOf(packageMarker);
    const webPackage =
      packageName === undefined || !webDependencies.has(packageName)
        ? undefined
        : Result.try(() =>
            realpathSync(path.join(WEB_DIR, "node_modules", packageName)),
          ).unwrapOr(undefined);
    if (
      packageMarker === undefined ||
      inPackage === -1 ||
      webPackage === undefined
    ) {
      return panic(
        `generate-web-api-types: unique symbol ${symbol.name} is declared in ` +
          `${repoRelativePath(REPO_ROOT, fileName)}, which apps/web cannot import. ` +
          "Declare it in a package apps/web depends on.",
      );
    }
    const target = path.join(
      webPackage,
      fileName.slice(inPackage + packageMarker.length),
    );
    return (
      moduleSpecifier(path.dirname(OUTPUT_PATH), target)
        // Import a declaration file by its JavaScript twin: `x.d.mts` as `x.mjs`.
        .replace(/\.d\.([cm]?)ts$/u, ".$1js")
        .replace(/\.tsx?$/u, "")
    );
  };

  const uniqueSymbolLocal = async (type: Type): Promise<string> => {
    const symbol =
      (await compiler.symbol(type)) ??
      panic("generate-web-api-types: unique symbol without a symbol");
    const declaration = symbol.valueDeclaration ?? symbol.declarations.at(0);
    const fileName =
      declaration === undefined
        ? panic("unique symbol without a declaration")
        : fileNameOf(declaration.path);
    const packageName = packageOfFile(fileName);
    let specifier: string;
    if (
      packageName !== undefined &&
      webDependencies.has(packageName) &&
      (await exportsOfModule(packageName))?.get(symbol.id) === symbol.name
    ) {
      specifier = packageName;
    } else {
      specifier = declaringFileSpecifier(symbol, fileName, packageName);
    }
    const key = `${specifier}#${symbol.name}`;
    const existing = symbolImports.get(key);
    if (existing !== undefined) {
      return existing.local;
    }
    const local = `__symbol${symbolImports.size}`;
    symbolImports.set(key, { local, name: symbol.name, specifier });
    return local;
  };

  // Named imports, not inline `import("pkg").Name`: the compiler never marks
  // an alias used when its only reference is an import type's argument.
  const typeImports = new Map<
    string,
    { local: string; name: string; specifier: string }
  >();
  const referenceArguments = async (
    reference: TypeReference,
    target: Type,
  ): Promise<readonly Type[]> =>
    (await compiler.typeArguments(reference)).slice(
      0,
      await compiler.typeParameterCount(target),
    );
  const packageReference = async (type: Type): Promise<string | undefined> => {
    let symbol = await compiler.aliasSymbol(type);
    let typeArguments: readonly Type[] =
      symbol === undefined ? [] : await compiler.aliasTypeArguments(type);
    // A local alias of an imported generic interface still has the
    // interface's identity. Print that reference rather than its expanded
    // members when the alias itself cannot be imported by the browser.
    const aliasFile =
      symbol === undefined ? undefined : declarationFile(symbol);
    const aliasPackage =
      aliasFile === undefined ? undefined : packageOfFile(aliasFile);
    if (
      symbol !== undefined &&
      (aliasPackage === undefined || !webDependencies.has(aliasPackage)) &&
      type.isTypeReference()
    ) {
      const target = await compiler.target(type);
      if (target.isObjectType() && isInterfaceOrClass(target.objectFlags)) {
        symbol = await compiler.symbol(target);
        typeArguments = await referenceArguments(type, target);
      }
    }
    if (symbol === undefined && type.isTypeReference()) {
      const target = await compiler.target(type);
      if (target.isObjectType() && isInterfaceOrClass(target.objectFlags)) {
        symbol = await compiler.symbol(target);
        typeArguments = await referenceArguments(type, target);
      }
    } else if (
      symbol === undefined &&
      type.isObjectType() &&
      isInterfaceOrClass(type.objectFlags)
    ) {
      symbol = await compiler.symbol(type);
      typeArguments = [];
    }
    if (symbol === undefined) {
      return undefined;
    }
    const fileName = declarationFile(symbol);
    const packageName =
      fileName === undefined ? undefined : packageOfFile(fileName);
    if (packageName === undefined || !webDependencies.has(packageName)) {
      return undefined;
    }
    const exportedName = (await exportsOfModule(packageName))?.get(symbol.id);
    if (exportedName === undefined) {
      return undefined;
    }
    count(packageReferences, `${packageName}#${exportedName}`);
    const local = `${packageName.replaceAll(/^@|[^\w$]+/gu, (match) => (match === "@" ? "" : "_"))}_${exportedName}`;
    typeImports.set(local, {
      local,
      name: exportedName,
      specifier: packageName,
    });
    if (typeArguments.length === 0) {
      return local;
    }
    const printedArguments: string[] = [];
    for (const [index, argument] of typeArguments.entries()) {
      printedArguments.push(
        await at(`<${index}>`, async () => print(argument)),
      );
    }
    return `${local}<${printedArguments.join(", ")}>`;
  };

  // --- traversal state: shared nodes become tokens resolved after printing
  const nodes: TypeNode[] = [];
  const nodeIds = new Map<number, number>();
  // A type printed inside a response, where its dates are strings, is a
  // different node from the same type printed as declared.
  const wireNodeIds = new Map<number, number>();
  const onStack = new Set<number>();
  const pathStack: string[] = [];
  // Every reach of a node, relative to the node whose body is printing, so
  // names can use the smallest path rather than the first one visited.
  const edges: AliasGraphEdge[] = [];
  const printing: { id: number; depth: number }[] = [];
  const reach = (id: number) => {
    const parent = printing.at(-1);
    edges.push({
      from: parent?.id,
      to: id,
      path: pathStack.slice(parent?.depth ?? 0).join("/"),
    });
  };
  // The printer walks one path at a time: every step awaits the one before,
  // so the path stack and the node numbering follow the walk exactly.
  const at = async <T>(segment: string, run: () => Promise<T>): Promise<T> => {
    pathStack.push(segment);
    try {
      return await run();
    } finally {
      pathStack.pop();
    }
  };
  // Set while printing a route response in the wire printout.
  let wire = false;
  const withWire = async <T>(
    value: boolean,
    run: () => Promise<T>,
  ): Promise<T> => {
    const outer = wire;
    wire = value;
    try {
      return await run();
    } finally {
      wire = outer;
    }
  };
  const token = (id: number) => `${id}`;
  const memo = async (
    type: Type,
    body: () => Promise<string>,
  ): Promise<string> => {
    const ids = wire ? wireNodeIds : nodeIds;
    const existing = ids.get(type.id);
    if (existing !== undefined) {
      const node = nodes[existing] ?? panic(`missing node ${existing}`);
      reach(existing);
      node.references += 1;
      if (onStack.has(existing)) {
        node.recursive = true;
      }
      return token(existing);
    }
    const id = nodes.length;
    const node: TypeNode = {
      body: "",
      references: 1,
      recursive: false,
    };
    nodes.push(node);
    ids.set(type.id, id);
    reach(id);
    onStack.add(id);
    printing.push({ id, depth: pathStack.length });
    node.body = await body();
    printing.pop();
    onStack.delete(id);
    return token(id);
  };

  const isDate = async (type: Type): Promise<boolean> =>
    type.isObjectType() &&
    isInterfaceOrClass(type.objectFlags) &&
    (await globalNameOf(await compiler.symbol(type))) === "Date";

  // The types a JSON value of `type` is built from. Signatures carry no JSON,
  // and globals other than arrays and tuples (`Response`, `Blob`) are opaque.
  const jsonMembers = async (type: Type): Promise<readonly Type[]> => {
    if (type.isUnionType() || type.isIntersectionType()) {
      return await compiler.members(type);
    }
    if (!type.isObjectType() || (await isDate(type))) {
      return [];
    }
    if ((await compiler.isArray(type)) || (await compiler.isTuple(type))) {
      return type.isTypeReference() ? await compiler.typeArguments(type) : [];
    }
    const globalSymbol = type.isTypeReference()
      ? await compiler.symbol(await compiler.target(type))
      : await compiler.symbol(type);
    if ((await globalNameOf(globalSymbol)) !== undefined) {
      return [];
    }
    const members: Type[] = [];
    for (const property of await compiler.properties(type)) {
      members.push(await compiler.typeOfSymbol(property));
    }
    for (const info of await compiler.indexInfos(type)) {
      members.push(info.valueType);
    }
    return members;
  };

  // Whether a `Date` is reachable from `type`. A `true` holds for every type
  // on the search path; a `false` for the root holds for everything visited.
  const reachesDateCache = new Map<number, boolean>();
  const reachesDate = async (root: Type): Promise<boolean> => {
    const visited = new Set<number>();
    const visit = async (type: Type): Promise<boolean> => {
      const known = reachesDateCache.get(type.id);
      if (known !== undefined) {
        return known;
      }
      if (visited.has(type.id)) {
        return false;
      }
      visited.add(type.id);
      let found = await isDate(type);
      for (const member of found ? [] : await jsonMembers(type)) {
        if (await visit(member)) {
          found = true;
          break;
        }
      }
      if (found) {
        reachesDateCache.set(type.id, true);
      }
      return found;
    };
    const found = await visit(root);
    if (!found) {
      for (const id of visited) {
        reachesDateCache.set(id, false);
      }
    }
    return found;
  };

  const isRouteType = async (type: Type): Promise<boolean> => {
    const names = new Set(
      (await compiler.properties(type)).map(({ name }) => name),
    );
    return ROUTE_MEMBERS.every((name) => names.has(name));
  };

  const propertyKey = async (property: CompilerSymbol): Promise<string> => {
    const { name } = property;
    if (name.startsWith(LATE_BOUND_NAME)) {
      const declaration = await compiler.declaration(property);
      const declaredName =
        declaration !== undefined && isPropertySignatureDeclaration(declaration)
          ? declaration.name
          : undefined;
      const keyType =
        declaredName !== undefined && isComputedPropertyName(declaredName)
          ? await checker.getTypeAtLocation(declaredName.expression)
          : undefined;
      if (
        keyType !== undefined &&
        hasFlag(keyType.flags, TypeFlags.UniqueESSymbol)
      ) {
        return `[${await uniqueSymbolLocal(keyType)}]`;
      }
      return `[${await fallback("unresolved symbol key", await compiler.typeOfSymbol(property))}]`;
    }
    if (IDENTIFIER.test(name) || NUMERIC_KEY.test(name)) {
      return name;
    }
    return JSON.stringify(name);
  };

  // A property is readonly by its declaration's modifier, or, synthesized by
  // a mapped type (`Readonly<T>`, a homomorphic `Omit`), by its check flags.
  const isReadonlyProperty = async (
    property: CompilerSymbol,
  ): Promise<boolean> => {
    if (hasFlag(property.checkFlags, CHECK_FLAGS_READONLY)) {
      return true;
    }
    const declaration = await compiler.declaration(property);
    return (
      declaration !== undefined &&
      hasFlag(modifierFlagsOf(declaration), ModifierFlags.Readonly)
    );
  };

  // `x?: T` reads back as `T | missing`; the missing type is an undefined
  // type distinct from the real `undefined`, dropped again when printing `?`.
  const withoutMissing = async (type: Type): Promise<Type[]> => {
    const isMissing = (member: Type) =>
      hasFlag(member.flags, TypeFlags.Undefined) &&
      member.id !== undefinedType.id;
    if (type.isUnionType()) {
      return (await compiler.members(type)).filter(
        (member) => !isMissing(member),
      );
    }
    return isMissing(type) ? [] : [type];
  };

  const signature = async (sig: Signature, arrow: boolean): Promise<string> =>
    await withWire(false, async () => await declaredSignature(sig, arrow));

  // A parameter is optional when marked `?`, or when it has a default and no
  // required parameter follows it.
  const optionalParameters = async (
    parameters: readonly CompilerSymbol[],
  ): Promise<boolean[]> => {
    const declarations = [];
    for (const parameter of parameters) {
      const declaration = await compiler.declaration(parameter);
      declarations.push(
        declaration !== undefined && isParameterDeclaration(declaration)
          ? declaration
          : undefined,
      );
    }
    let requiredAfter = false;
    const optional = declarations.map(() => false);
    for (const [index, declaration] of [
      ...declarations.entries(),
    ].toReversed()) {
      const isRest = declaration?.dotDotDotToken !== undefined;
      const marked = declaration?.questionToken !== undefined;
      const defaulted = declaration?.initializer !== undefined;
      optional[index] = !isRest && (marked || (defaulted && !requiredAfter));
      if (!isRest && !optional[index]) {
        requiredAfter = true;
      }
    }
    return optional;
  };

  const declaredSignature = async (
    sig: Signature,
    arrow: boolean,
  ): Promise<string> => {
    const typeParameters = await sig.getTypeParameters();
    const printedTypeParameters: string[] = [];
    for (const parameter of typeParameters) {
      const constraint = await checker.getConstraintOfTypeParameter(parameter);
      const name =
        (await compiler.symbol(parameter))?.name ??
        panic("generate-web-api-types: type parameter without a symbol");
      printedTypeParameters.push(
        name +
          (constraint === undefined
            ? ""
            : ` extends ${await at("extends", async () => print(constraint))}`),
      );
    }
    const parameters: string[] = [];
    const thisParameter = await sig.getThisParameter();
    if (thisParameter !== undefined) {
      parameters.push(
        `this: ${await at("this", async () => await print(await compiler.typeOfSymbol(thisParameter)))}`,
      );
    }
    const signatureParameters = await sig.getParameters();
    const optional = await optionalParameters(signatureParameters);
    for (const [index, parameter] of signatureParameters.entries()) {
      const declaration = await compiler.declaration(parameter);
      const isRest =
        declaration !== undefined &&
        isParameterDeclaration(declaration) &&
        declaration.dotDotDotToken !== undefined;
      const name = IDENTIFIER.test(parameter.name)
        ? parameter.name
        : `arg${index}`;
      const printed = await at(
        `(${index})`,
        async () => await print(await compiler.typeOfSymbol(parameter)),
      );
      parameters.push(
        `${isRest ? "..." : ""}${name}${optional[index] === true ? "?" : ""}: ${printed}`,
      );
    }
    const predicate = await checker.getTypePredicateOfSignature(sig);
    let returned: string;
    if (predicate === undefined) {
      const returnType =
        (await checker.getReturnTypeOfSignature(sig)) ??
        panic("generate-web-api-types: signature without a return type");
      returned = await at("=>", async () => print(returnType));
    } else {
      const asserts =
        predicate.kind === TypePredicateKind.AssertsThis ||
        predicate.kind === TypePredicateKind.AssertsIdentifier;
      const subject =
        predicate.kind === TypePredicateKind.This ||
        predicate.kind === TypePredicateKind.AssertsThis
          ? "this"
          : predicate.parameterName;
      const narrowed = predicate.type;
      returned = `${asserts ? "asserts " : ""}${subject}${
        narrowed === undefined
          ? ""
          : ` is ${await at("is", async () => print(narrowed))}`
      }`;
    }
    const generics =
      printedTypeParameters.length === 0
        ? ""
        : `<${printedTypeParameters.join(", ")}>`;
    return `${generics}(${parameters.join(", ")})${arrow ? " => " : ": "}${returned}`;
  };

  const objectBody = async (type: Type): Promise<string> => {
    const members: string[] = [];
    const wireResponse =
      responseDates === RESPONSE_DATES.wire && (await isRouteType(type));
    for (const [index, sig] of (
      await compiler.callSignatures(type)
    ).entries()) {
      members.push(await at(`call${index}`, async () => signature(sig, false)));
    }
    for (const [index, sig] of (
      await compiler.constructSignatures(type)
    ).entries()) {
      members.push(
        `new ${await at(`new${index}`, async () => signature(sig, false))}`,
      );
    }
    for (const info of await compiler.indexInfos(type)) {
      const key = await at("[key]", async () => print(info.keyType));
      members.push(
        `${info.isReadonly ? "readonly " : ""}[key: ${key}]: ${await at(`[${key}]`, async () => print(info.valueType))}`,
      );
    }
    for (const property of await compiler.properties(type)) {
      const optional = hasFlag(property.flags, SymbolFlags.Optional);
      const key = await propertyKey(property);
      const propertyType = await compiler.typeOfSymbol(property);
      if (hasFlag(property.flags, SymbolFlags.Method) && !optional) {
        const signatures = await compiler.callSignatures(propertyType);
        if (
          signatures.length > 0 &&
          (await compiler.properties(propertyType)).length === 0
        ) {
          for (const [index, sig] of signatures.entries()) {
            members.push(
              `${key}${await at(`${key}#${index}`, async () => signature(sig, false))}`,
            );
          }
          continue;
        }
      }
      const printed = await at(key, async () => {
        if (wireResponse && key === "response") {
          return await withWire(true, async () => print(propertyType));
        }
        if (!optional) {
          return await print(propertyType);
        }
        const kept = await withoutMissing(propertyType);
        return kept.length === 0 ? "never" : await unionBody(kept);
      });
      members.push(
        `${(await isReadonlyProperty(property)) ? "readonly " : ""}${key}${optional ? "?" : ""}: ${printed}`,
      );
    }
    return members.length === 0 ? "{}" : `{ ${members.join("; ")} }`;
  };

  const unionMember = async (type: Type): Promise<string> => {
    const printed = await print(type);
    return FUNCTION_TYPE.test(printed) && !printed.startsWith("")
      ? `(${printed})`
      : printed;
  };

  // Printed in the compiler's order, so nodes are numbered as before, and
  // joined in a canonical one (see lib/web-api-union-order.ts).
  const unionBody = async (members: readonly Type[]): Promise<string> => {
    const printed = [];
    for (const member of members) {
      printed.push({
        kind: unionMemberKind(member),
        printed: await at("|", async () => unionMember(member)),
      });
    }
    return orderUnionMembers(printed).join(" | ");
  };

  // Element labels are documentation the compiler's API does not expose;
  // they take no part in a tuple's identity.
  const tuple = async (
    reference: TypeReference,
    target: TupleType,
  ): Promise<string> => {
    const elements: string[] = [];
    for (const [index, element] of (
      await compiler.typeArguments(reference)
    ).entries()) {
      const flags = target.elementFlags[index] ?? ElementFlags.Required;
      const printed = await at(`[${index}]`, async () => print(element));
      const wrapped = /[|&]|=>/u.test(printed) ? `(${printed})` : printed;
      if (hasFlag(flags, ElementFlags.Rest)) {
        elements.push(`...${wrapped}[]`);
      } else if (hasFlag(flags, ElementFlags.Variadic)) {
        elements.push(`...${printed}`);
      } else if (hasFlag(flags, ElementFlags.Optional)) {
        elements.push(`${wrapped}?`);
      } else {
        elements.push(printed);
      }
    }
    return `${target.readonly ? "readonly " : ""}[${elements.join(", ")}]`;
  };

  const print = async (type: Type): Promise<string> => {
    if (wire && !(await reachesDate(type))) {
      return await withWire(false, async () => print(type));
    }
    if (wire && (await isDate(type))) {
      return "string";
    }
    const { flags } = type;
    if (
      !wire &&
      (hasFlag(flags, TypeFlags.Object) ||
        hasFlag(flags, TypeFlags.Union) ||
        hasFlag(flags, TypeFlags.Intersection)) &&
      (await globalNameOf(await compiler.aliasSymbol(type))) === undefined &&
      !(await compiler.isArray(type)) &&
      !(await compiler.isTuple(type))
    ) {
      const reference = await packageReference(type);
      if (reference !== undefined) {
        return reference;
      }
    }
    if (hasFlag(flags, TypeFlags.Any)) {
      return "any";
    }
    if (hasFlag(flags, TypeFlags.Unknown)) {
      return "unknown";
    }
    if (hasFlag(flags, TypeFlags.Never)) {
      return "never";
    }
    if (hasFlag(flags, TypeFlags.String)) {
      return "string";
    }
    if (hasFlag(flags, TypeFlags.Number)) {
      return "number";
    }
    if (hasFlag(flags, TypeFlags.BigInt)) {
      return "bigint";
    }
    if (hasFlag(flags, TypeFlags.ESSymbol)) {
      return "symbol";
    }
    if (hasFlag(flags, TypeFlags.Void)) {
      return "void";
    }
    if (hasFlag(flags, TypeFlags.Undefined)) {
      return "undefined";
    }
    if (hasFlag(flags, TypeFlags.Null)) {
      return "null";
    }
    if (hasFlag(flags, TypeFlags.NonPrimitive)) {
      return "object";
    }
    if (hasFlag(flags, TypeFlags.EnumLiteral)) {
      return await fallback("enum literal", type);
    }
    if (type.isStringLiteralType()) {
      return JSON.stringify(type.value);
    }
    if (type.isNumberLiteralType()) {
      return String(type.value);
    }
    if (type.isBigIntLiteralType()) {
      return `${type.value}n`;
    }
    if (type.isBooleanLiteralType()) {
      return String(type.value);
    }
    if (hasFlag(flags, TypeFlags.UniqueESSymbol)) {
      return `typeof ${await uniqueSymbolLocal(type)}`;
    }
    if (hasFlag(flags, TypeFlags.TypeParameter)) {
      return (
        (await compiler.symbol(type))?.name ??
        panic("generate-web-api-types: type parameter without a symbol")
      );
    }
    if (type.isTemplateLiteralType()) {
      const { texts } = type;
      const escape = (text: string) =>
        text.replaceAll(/[`\\]/gu, "\\$&").replaceAll("${", "\\${");
      let printed = `\`${escape(texts[0] ?? "")}`;
      for (const [index, span] of (await compiler.members(type)).entries()) {
        printed += `\${${await at(`\${${index}}`, async () => print(span))}}${escape(texts[index + 1] ?? "")}`;
      }
      return `${printed}\``;
    }
    if (type.isStringMappingType()) {
      const inner = await type.getTarget();
      const printed = await at("mapping", async () => print(inner));
      const name =
        (await compiler.symbol(type))?.name ??
        panic("generate-web-api-types: string mapping without a symbol");
      return `${name}<${printed}>`;
    }
    if (type.isObjectType()) {
      return await printObject(type);
    }
    if (type.isUnionType()) {
      const members = await compiler.members(type);
      return await memo(type, async () => unionBody(members));
    }
    if (type.isIntersectionType()) {
      const members = await compiler.members(type);
      return await memo(type, async () => {
        const printed: string[] = [];
        for (const member of members) {
          const text = await at("&", async () => print(member));
          printed.push(
            /[|]|=>/u.test(text) &&
              !text.startsWith("") &&
              !text.startsWith("{")
              ? `(${text})`
              : text,
          );
        }
        return printed.join(" & ");
      });
    }
    return await fallback(`type flags ${flags}`, type);
  };

  const printObject = async (type: ObjectType): Promise<string> => {
    if (type.isTypeReference()) {
      const target = await compiler.target(type);
      if (target.isTupleType()) {
        return await memo(type, async () => tuple(type, target));
      }
      if (await compiler.isArray(type)) {
        const element = (await compiler.typeArguments(type)).at(0);
        const name =
          (await compiler.symbol(target))?.name === "ReadonlyArray"
            ? "ReadonlyArray"
            : "Array";
        return `${name}<${element === undefined ? "unknown" : await at("[]", async () => print(element))}>`;
      }
      const name = await globalNameOf(await compiler.symbol(target));
      if (name !== undefined) {
        const typeArguments = await referenceArguments(type, target);
        if (typeArguments.length === 0) {
          return name;
        }
        const printed: string[] = [];
        for (const [index, argument] of typeArguments.entries()) {
          printed.push(await at(`<${index}>`, async () => print(argument)));
        }
        return `${name}<${printed.join(", ")}>`;
      }
    } else if (isInterfaceOrClass(type.objectFlags)) {
      const name = await globalNameOf(await compiler.symbol(type));
      if (name !== undefined) {
        return name;
      }
    }
    // An intersection drops an empty `{}` literal member but keeps an empty
    // mapped type (an `Omit` that removed every key); an empty mapped type
    // keeps the member count, and so the identity, intact.
    if (
      hasFlag(type.objectFlags, ObjectFlags.Mapped) &&
      (await compiler.properties(type)).length === 0 &&
      (await compiler.indexInfos(type)).length === 0
    ) {
      return "Record<never, never>";
    }
    return await memo(type, async () => objectBody(type));
  };

  // Asks for the graph the printer walks a level at a time, every question
  // of a level at once, so printing finds its answers cached instead of
  // waiting on one request after another. It stops where the printer stops:
  // at globals, which print by name. Printing stays the source of truth; a
  // question this misses is asked when printing reaches it.
  const prefetch = async (root: Type): Promise<void> => {
    const seen = new Set<number>([root.id]);
    let level: readonly Type[] = [root];
    while (level.length > 0) {
      const next: Type[] = [];
      const reachAll = (types: readonly Type[]) => {
        for (const type of types) {
          if (!seen.has(type.id)) {
            seen.add(type.id);
            next.push(type);
          }
        }
      };
      const properties: CompilerSymbol[] = [];
      const expand = async (type: Type): Promise<void> => {
        if (
          hasFlag(type.flags, TypeFlags.TypeParameter) ||
          hasFlag(type.flags, TypeFlags.UniqueESSymbol) ||
          type.isStringMappingType()
        ) {
          await compiler.symbol(type);
          return;
        }
        if (
          !type.isObjectType() &&
          !type.isUnionType() &&
          !type.isIntersectionType() &&
          !type.isTemplateLiteralType()
        ) {
          return;
        }
        const alias = await compiler.aliasSymbol(type);
        if (alias !== undefined) {
          await globalNameOf(alias);
          reachAll(await compiler.aliasTypeArguments(type));
        }
        if (
          type.isUnionType() ||
          type.isIntersectionType() ||
          type.isTemplateLiteralType()
        ) {
          reachAll(await compiler.members(type));
          return;
        }
        if (!type.isObjectType()) {
          return;
        }
        const [isArray, isTuple] = await Promise.all([
          compiler.isArray(type),
          compiler.isTuple(type),
        ]);
        if (type.isTypeReference()) {
          const target = await compiler.target(type);
          const [typeArguments, targetSymbol] = await Promise.all([
            compiler.typeArguments(type),
            compiler.symbol(target),
            compiler.typeParameterCount(target),
          ]);
          reachAll(typeArguments);
          if (
            isArray ||
            isTuple ||
            target.isTupleType() ||
            (await globalNameOf(targetSymbol)) !== undefined
          ) {
            return;
          }
        } else if (
          isInterfaceOrClass(type.objectFlags) &&
          (await globalNameOf(await compiler.symbol(type))) !== undefined
        ) {
          return;
        }
        // Signatures are left to printing too: the date search never reads
        // them, and most of the graph is never printed structurally.
        const [own, infos] = await Promise.all([
          compiler.properties(type),
          compiler.indexInfos(type),
        ]);
        properties.push(...own);
        for (const info of infos) {
          reachAll([info.keyType, info.valueType]);
        }
      };
      await Promise.all(level.map(expand));
      // Declarations (for `readonly`) are left to printing: each one fetches
      // its whole source file, and the graph reaches files never printed.
      await compiler.typesOfSymbols(properties);
      reachAll(await Promise.all(properties.map(compiler.typeOfSymbol)));
      level = next;
    }
  };

  // --- contract members
  const contractModule =
    (await checker.getSymbolAtLocation(contractSource)) ??
    panic("generate-web-api-types: web-contract.ts is not a module");
  const contractSymbol =
    (await checker.getExportsOfModule(contractModule)).find(
      (symbol) => symbol.name === CONTRACT_TYPE,
    ) ?? panic(`generate-web-api-types: ${CONTRACT_TYPE} is not exported`);
  const contractType = await checker.getDeclaredTypeOfSymbol(contractSymbol);
  await prefetch(contractType);
  const printedDeclarations: { name: string; text: string }[] = [];
  for (const property of await compiler.properties(contractType)) {
    printedDeclarations.push({
      name: property.name,
      text: await at(
        property.name,
        async () => await print(await compiler.typeOfSymbol(property)),
      ),
    });
  }

  // --- resolve tokens: inline single-use nodes, alias shared or recursive ones
  const aliasNames = nameAliases(nodes, edges);
  const inlined = new Map<number, string>();
  const resolve = (text: string): string =>
    text.replaceAll(TOKEN, (_match, rawId: string) => {
      const id = Number(rawId);
      const alias = aliasNames.get(id);
      if (alias !== undefined) {
        return alias;
      }
      const cached = inlined.get(id);
      if (cached !== undefined) {
        return cached;
      }
      const body = resolve(nodes[id]?.body ?? panic(`missing node ${id}`));
      const wrapped =
        body.startsWith("{") || body.startsWith("[") || !/[|&]|=>/u.test(body)
          ? body
          : `(${body})`;
      inlined.set(id, wrapped);
      return wrapped;
    });

  const declarations = printedDeclarations.map(({ name, text }) => ({
    name,
    text: resolve(text),
  }));
  // Only aliases reachable from the declarations. The walk follows the
  // checker's member order, which varies between runs, so the output is
  // sorted by alias name below.
  const aliases: { name: string; text: string }[] = [];
  const emitted = new Set<number>();
  const aliasIdsByName = new Map(
    [...aliasNames].map(([id, name]) => [name, id]),
  );
  const pending = declarations.map(({ text }) => text);
  while (pending.length > 0) {
    const text = pending.shift() ?? "";
    for (const match of text.matchAll(ALIAS_NAME)) {
      const id = aliasIdsByName.get(match[0]);
      if (id === undefined || emitted.has(id)) {
        continue;
      }
      emitted.add(id);
      const aliasText = resolve(nodes[id]?.body ?? panic(`missing node ${id}`));
      aliases.push({ name: match[0], text: aliasText });
      pending.push(aliasText);
    }
  }

  return {
    declarations,
    // Alias names are unique (a collision panics above), so no tie case.
    aliases: aliases.toSorted((left, right) =>
      left.name < right.name ? -1 : 1,
    ),
    symbolImports: [...symbolImports.values()],
    typeImports: [...typeImports.values()],
    fallbacks,
    packageReferences,
  };
};

// --- Layout ---------------------------------------------------------------------

/**
 * Breaks object types over lines, one member per line, so a route change
 * shows up as a readable diff. String and template literal contents are left
 * untouched.
 */
const layout = (text: string): string => {
  let output = "";
  let depth = 0;
  let index = 0;
  const templateDepths: number[] = [];
  const newline = () => `\n${"  ".repeat(depth)}`;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      output += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "`" || (char === "}" && templateDepths.at(-1) === depth)) {
      if (char === "}") {
        templateDepths.pop();
      }
      // Scan template text up to the closing backtick or the next `${`.
      let end = index + 1;
      while (end < text.length && text[end] !== "`") {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === "$" && text[end + 1] === "{") {
          break;
        }
        end += 1;
      }
      if (text[end] === "`") {
        output += text.slice(index, end + 1);
        index = end + 1;
      } else {
        output += text.slice(index, end + 2);
        templateDepths.push(depth);
        index = end + 2;
      }
      continue;
    }
    if (text.startsWith("{ ", index)) {
      depth += 1;
      output += `{${newline()}`;
      index += 2;
      continue;
    }
    if (text.startsWith(" }", index) && depth > 0) {
      depth -= 1;
      output += `;${newline()}}`;
      index += 2;
      continue;
    }
    if (text.startsWith("; ", index) && depth > 0) {
      output += `;${newline()}`;
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
};

const renderOutput = (result: PrintResult): string => {
  const lines = [...HEADER];
  const bySpecifier = new Map<string, string[]>();
  for (const { local, name, specifier } of [
    ...result.symbolImports,
    ...result.typeImports,
  ]) {
    const names = bySpecifier.get(specifier) ?? [];
    names.push(`${name} as ${local}`);
    bySpecifier.set(specifier, names);
  }
  for (const specifier of [...bySpecifier.keys()].toSorted()) {
    const specifiers = (bySpecifier.get(specifier) ?? []).toSorted();
    lines.push(`import type { ${specifiers.join(", ")} } from "${specifier}";`);
  }
  lines.push("");
  for (const { name, text } of result.declarations) {
    lines.push(`export type ${name} = ${layout(text)};`, "");
  }
  for (const { name, text } of result.aliases) {
    lines.push(`type ${name} = ${layout(text)};`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

// --- Identity check ---------------------------------------------------------------

const renderIdentityCheck = (names: readonly string[]): string => {
  const specifier = moduleSpecifier(
    path.dirname(CHECK_PATH),
    OUTPUT_PATH,
  ).replace(/\.ts$/u, "");
  return [
    `import type * as Generated from "${specifier}";`,
    `import type { ${CONTRACT_TYPE} } from "./web-contract";`,
    // Identity, not mutual assignability: assignability forgives a lost
    // optional or readonly modifier, a dropped brand, and generic identity.
    "type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;",
    "type Assert<T extends true> = T;",
    ...names.map(
      (name) =>
        `export type Check${name} = Assert<Identical<Generated.${name}, ${CONTRACT_TYPE}["${name}"]>>;`,
    ),
  ].join("\n");
};

// --- CLI --------------------------------------------------------------------------

type GenerateOptions = {
  validation:
    | { type: "identity"; declared: string; wire: string | Uint8Array }
    | { type: "print"; includeDeclared?: boolean };
  recorder?: CompilerInputRecorder;
};

type Printed = {
  output: string;
  declared?: string;
  diagnostics?: readonly Diagnostic[];
  sources?: ReadonlyMap<string, string>;
};

// The declarations renderOutput writes: one `export type Name = ` per line.
const EXPORTED_TYPE = /^export type ([A-Za-z_$][\w$]*) = /gmu;

const exportedTypeNames = (output: string): string[] =>
  [...output.matchAll(EXPORTED_TYPE)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

// The route types mark what they cannot type (`UntypedRoutes` in
// src/http/route.ts, `RouteTypeError` in src/http/route-types.ts) instead of
// letting it widen; a printout that carries a marker names the cause.
const ROUTE_TYPE_ERROR_MARKER = "~routeTypeError";

const assertEveryRouteTyped = (output: string): void => {
  const marked = output
    .split("\n")
    .filter((line) => line.includes(ROUTE_TYPE_ERROR_MARKER))
    .map((line) => line.trim());
  if (marked.length > 0) {
    panic(
      `generate-web-api-types: the web route tree has routes the compiler cannot type:\n${marked.join("\n")}`,
    );
  }
};

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

// The compiler process's largest resident size seen by any generation.
let compilerPeakRssMiB = 0;
const sampleCompilerRss = () => {
  compilerPeakRssMiB = Math.max(compilerPeakRssMiB, childPeakRssMiB());
  return compilerPeakRssMiB;
};

// Builds the API program and returns strings only, then closes the compiler
// process, so nothing of the program outlives this call.
const printWithProgram = async ({
  validation,
  recorder,
}: GenerateOptions): Promise<Printed> => {
  const declared =
    validation.type === "identity" ? validation.declared : undefined;
  const wire =
    validation.type === "identity"
      ? Buffer.from(validation.wire).toString("utf-8")
      : undefined;
  const names = declared === undefined ? [] : exportedTypeNames(declared);
  const virtualFiles: ReadonlyMap<string, string> =
    declared === undefined || wire === undefined
      ? new Map()
      : new Map([
          [CHECK_PATH, renderIdentityCheck(names)],
          [OUTPUT_PATH, declared],
          [WIRE_CHECK_PATH, wire],
        ]);
  const webDependencies = readWebDependencies(
    recorder?.readFile ?? ((fileName) => readFileSync(fileName, "utf-8")),
  );
  const programStarted = performance.now();
  const program = await openContractProgram({
    contractPath: CONTRACT_PATH,
    baseConfigPath: path.join(API_DIR, "tsconfig.json"),
    compilerOptions: PROGRAM_OPTIONS,
    virtualFiles,
    ...(recorder === undefined ? {} : { recorder }),
    packageOf: packageOfFile,
    webDependencies,
  });
  const printed = await Result.tryPromise(async () => {
    const programCreated = performance.now();
    const result = await printContract({
      program,
      webDependencies,
      responseDates: RESPONSE_DATES.wire,
    });
    const output = renderOutput(result);
    assertEveryRouteTyped(output);
    const printedAt = performance.now();
    const stage =
      validation.type === "identity" ? "generation 2" : "generation 1";
    console.log(
      `generate-web-api-types: ${stage}: program ${Math.round(programCreated - programStarted)} ms, ` +
        `check/print ${Math.round(printedAt - programCreated)} ms, ` +
        `RSS ${megabytes(process.memoryUsage().rss)} MiB, compiler RSS ${sampleCompilerRss()} MiB`,
    );

    for (const [reason, occurrences] of result.fallbacks) {
      console.error(
        `generate-web-api-types: WARNING printer fallback (${reason}) x${occurrences}`,
      );
    }

    console.log(
      `generate-web-api-types: package references ${[
        ...result.packageReferences,
      ]
        .map(([reference, uses]) => `${reference} x${uses}`)
        .join(", ")}`,
    );

    // Consumer tasks only need the printout. The dedicated CI --check owns
    // identity validation and determinism, without charging each compiler job.
    if (declared === undefined) {
      return validation.type === "print" && validation.includeDeclared === true
        ? {
            output,
            declared: renderOutput(
              await printContract({
                program,
                webDependencies,
                responseDates: RESPONSE_DATES.declared,
              }),
            ),
          }
        : { output };
    }
    const identityStarted = performance.now();
    const diagnostics = await program.diagnosticsOf([
      OUTPUT_PATH,
      WIRE_CHECK_PATH,
      CHECK_PATH,
    ]);
    console.log(
      `generate-web-api-types: identity: check ${Math.round(performance.now() - identityStarted)} ms, ` +
        `RSS ${megabytes(process.memoryUsage().rss)} MiB, compiler RSS ${sampleCompilerRss()} MiB`,
    );
    return { output, diagnostics, sources: virtualFiles };
  });
  sampleCompilerRss();
  await program.close();
  return printed.isOk()
    ? printed.value
    : panic("generate-web-api-types: printing failed", printed.error);
};

const generate = async ({ validation, recorder }: GenerateOptions) => {
  const started = performance.now();
  const { output, declared, diagnostics, sources } = await printWithProgram({
    validation,
    ...(recorder === undefined ? {} : { recorder }),
  });
  const printed = performance.now();
  if (diagnostics === undefined) {
    console.log(
      `generate-web-api-types: printed in ${Math.round(printed - started)} ms`,
    );
    return { output, declared };
  }

  if (diagnostics.length > 0) {
    console.error(
      formatDiagnostics(
        diagnostics,
        (fileName) =>
          sources?.get(fileName) ??
          Result.try(() => readFileSync(fileName, "utf-8")).unwrapOr(undefined),
      ),
    );
    console.error(
      "generate-web-api-types: the printed types are not identical to the inferred API types; the printer needs a fix.",
    );
    process.exit(1);
  }

  console.log(
    `generate-web-api-types: printed and identity verified in ${Math.round(performance.now() - started)} ms`,
  );
  return { output };
};

const writeAtomically = (file: string, bytes: string | Uint8Array) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const readOptional = (file: string): Buffer | undefined => {
  const read = Result.try(() => readFileSync(file));
  return read.isOk() ? read.value : undefined;
};

type VerifyDeterminismOptions = {
  output: string | Uint8Array;
  prepared: Uint8Array | undefined;
  regenerate: () => string | Uint8Array;
};

export const verifyDeterminism = ({
  output,
  prepared,
  regenerate,
}: VerifyDeterminismOptions): "prepared printout" | "two generations" => {
  if (prepared !== undefined) {
    if (!Buffer.from(output).equals(prepared)) {
      panic("generate-web-api-types: prepared printout differs from this run");
    }
    return "prepared printout";
  }
  if (!Buffer.from(output).equals(Buffer.from(regenerate()))) {
    panic(
      "generate-web-api-types: output is not deterministic across two generations",
    );
  }
  return "two generations";
};

const cacheStampSchema = v.strictObject({
  outputHash: v.string(),
  inputs: compilerInputStampSchema,
});

// Everything besides the program's own inputs that decides the printout. No
// absolute path: the host-wide store shares entries between checkouts, and
// the stamp itself pins every path the program read.
const cacheContext = () =>
  sha256Hex(
    JSON.stringify({
      format: 3,
      output: repoRelativePath(REPO_ROOT, OUTPUT_PATH),
      bun: Bun.version,
      typescript: typescriptPackage.version,
      generator: scriptSourceHash(import.meta.path),
      // The Turbo coverage check reads these declarations, so a restored
      // printout must not outlive a change to them.
      turboInputs: webApiTurboInputs(REPO_ROOT),
      dependencyOutputs: webApiDependencyOutputs(REPO_ROOT),
    }),
  );

/**
 * Restores the last printout when the compiler would read exactly the same
 * inputs as when it was printed. Most installs and task runs end here without
 * building the API program.
 */
const reuseCachedOutput = async (context: string): Promise<boolean> => {
  const stampBytes = readOptional(STAMP_PATH);
  const cached = readOptional(CACHED_OUTPUT_PATH);
  if (stampBytes === undefined || cached === undefined) {
    return false;
  }
  const parsed = Result.try(() =>
    v.parse(cacheStampSchema, JSON.parse(stampBytes.toString("utf-8"))),
  );
  if (
    parsed.isErr() ||
    parsed.value.outputHash !== sha256Hex(cached) ||
    !(await isCompilerInputStampCurrent(parsed.value.inputs, context))
  ) {
    return false;
  }
  if (readOptional(OUTPUT_PATH)?.equals(cached) !== true) {
    writeAtomically(OUTPUT_PATH, cached);
  }
  return true;
};

const STORE_DIR = generatedStoreDir("web-api-types");

/**
 * Restores a printout another checkout on this host (or a CI cache) made from
 * inputs this checkout still has, and makes it this checkout's own cache.
 */
const reuseStoredOutput = async (context: string): Promise<boolean> => {
  const stored = await restoreGeneratedOutput({
    storeDir: STORE_DIR,
    root: REPO_ROOT,
    context,
  });
  if (stored === undefined) {
    return false;
  }
  writeAtomically(OUTPUT_PATH, stored.output);
  writeAtomically(CACHED_OUTPUT_PATH, stored.output);
  writeAtomically(
    STAMP_PATH,
    JSON.stringify({ outputHash: stored.outputHash, inputs: stored.stamp }),
  );
  return true;
};

const main = async () => {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  if (args.some((arg) => arg !== "--check")) {
    panic(`generate-web-api-types: unknown arguments ${args.join(" ")}`);
  }
  if (!check && hasPreparedGeneratedSources(REPO_ROOT)) {
    return;
  }
  const started = performance.now();
  const context = cacheContext();
  // --check always builds the program: it owns identity and determinism.
  if (!check && (await reuseCachedOutput(context))) {
    console.log(
      `generate-web-api-types: compiler inputs unchanged; restored ${repoRelativePath(REPO_ROOT, OUTPUT_PATH)} ` +
        `in ${Math.round(performance.now() - started)} ms`,
    );
    return;
  }
  if (!check && (await reuseStoredOutput(context))) {
    console.log(
      `generate-web-api-types: compiler inputs match a stored printout; restored ${repoRelativePath(REPO_ROOT, OUTPUT_PATH)} ` +
        `from ${STORE_DIR} in ${Math.round(performance.now() - started)} ms`,
    );
    return;
  }
  const recorder = createCompilerInputRecorder();
  const first = await generate({
    validation: { type: "print", ...(check ? { includeDeclared: true } : {}) },
    recorder,
  });
  const stamp = recorder.stamp(context);
  const uncovered = uncoveredCompilerInputs(
    stamp,
    REPO_ROOT,
    webApiTurboInputs(REPO_ROOT),
    webApiDependencyOutputs(REPO_ROOT),
  );
  if (uncovered.length > 0) {
    panic(
      `generate-web-api-types: compiler inputs are missing from the Turbo task:\n${uncovered.join("\n")}`,
    );
  }
  let output = first.output;
  let outcome = "wrote";
  if (check) {
    if (first.declared === undefined) {
      panic("generate-web-api-types: declared printout was not produced");
    }
    Bun.gc(true);
    const prepared = preparedGeneratedFile(
      REPO_ROOT,
      repoRelativePath(REPO_ROOT, OUTPUT_PATH),
    );
    const reference = prepared ?? output;
    const second = await generate({
      validation: {
        type: "identity",
        declared: first.declared,
        wire: reference,
      },
    });
    const proof = verifyDeterminism({
      output: second.output,
      prepared,
      regenerate: () => output,
    });
    output = second.output;
    outcome = `verified deterministic against ${proof}`;
  }
  writeAtomically(OUTPUT_PATH, output);
  // The copy first: a stamp never names a printout that is not on disk.
  writeAtomically(CACHED_OUTPUT_PATH, output);
  writeAtomically(
    STAMP_PATH,
    JSON.stringify({
      outputHash: sha256Hex(output),
      inputs: stamp,
    }),
  );
  // A store failure costs only a later rebuild elsewhere, never this run.
  const published = Result.try(() =>
    publishGeneratedOutput({
      storeDir: STORE_DIR,
      stamp: recorder.portableStamp(context, REPO_ROOT),
      output,
    }),
  );
  if (published.isErr()) {
    printError(
      `generate-web-api-types: could not publish to ${STORE_DIR}:`,
      published.error,
    );
  }
  console.log(
    `generate-web-api-types: ${outcome} ${repoRelativePath(REPO_ROOT, OUTPUT_PATH)} ` +
      `(${Buffer.byteLength(output)} bytes) in ${Math.round(performance.now() - started)} ms, ` +
      // maxRSS is in kilobytes on every platform Node and Bun report it for.
      `peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MiB, ` +
      `compiler peak RSS ${compilerPeakRssMiB} MiB`,
  );
};

if (import.meta.main) {
  const generated = await withGenerationLock({
    lockPath: path.join(REPO_ROOT, ".cache/web-api-generation.sqlite"),
    run: main,
  });
  generated.unwrap("API type generation failed");
}
