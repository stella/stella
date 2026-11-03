#!/usr/bin/env bun

import { panic, Result, TaggedError } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";

import { parseChangesetEntry, parseChangesetReleases } from "./changeset-entry";
import { assertOfflineCheckPreload } from "./offline-check-startup";
import {
  genericTypeProbe,
  isGenericTypeDeclaration,
  isGenericTypeProbeName,
  normalizeCompatibilityDeclarations,
  withGenericTypeProbes,
} from "./package-api-compatibility";
import { hasRuntimeExport } from "./package-api-export-space";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

// This module is the check under the offline network preload: it spawns
// nothing and never formats. Writing reports lives in package-api-report-write.ts.
export const REPORT_FILE = "api-report.json";
const REGENERATE = "bun run update:package-api";
export const ROOT = path.resolve(import.meta.dirname, "..");

class PackageApiError extends TaggedError("PackageApiError")<{
  message: string;
}> {}

const fail = (message: string): never => {
  throw new PackageApiError({ message });
};

type ExportedName = {
  name: string;
  kind: string;
  space: "type" | "value" | "type+value";
};
type ApiEntrypoint =
  | { type: "module"; file: string; exports: ExportedName[] }
  | { type: "asset"; target: string; files: string[] };
export type ApiReport = {
  package: string;
  entrypoints: Record<string, ApiEntrypoint>;
  declarations: Record<string, string>;
};

const declarationPath = (file: string): string => {
  if (/\.d\.[cm]?ts$/u.test(file)) {
    return file;
  }
  return file
    .replace(/\.mts$/u, ".d.mts")
    .replace(/\.cts$/u, ".d.cts")
    .replace(/\.tsx?$/u, ".d.ts");
};

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  preserveSymlinks: true,
  declaration: true,
  emitDeclarationOnly: true,
  noEmitOnError: false,
  types: ["bun-types"],
};

/**
 * Installed declarations parsed once per process. Every report and declaration
 * program reads the same TypeScript libraries and dependency types, which do
 * not change while a check runs, under the one `compilerOptions`; package
 * sources outside `node_modules` are always read fresh.
 */
const installedSourceFiles = new Map<string, ts.SourceFile>();
const INSTALLED_PATH = `${path.sep}node_modules${path.sep}`;

const compilerHost = (): ts.CompilerHost => {
  const host = ts.createCompilerHost(compilerOptions);
  const parse = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!fileName.includes(INSTALLED_PATH)) {
      return parse(fileName, languageVersion, onError, shouldCreate);
    }
    const cached = installedSourceFiles.get(fileName);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = parse(fileName, languageVersion, onError, shouldCreate);
    if (parsed !== undefined) {
      installedSourceFiles.set(fileName, parsed);
    }
    return parsed;
  };
  return host;
};

// TypeScript exposes symbol categories and modifiers as bitmasks; this is the
// one place that reads them.
const hasFlag = (flags: number, flag: number): boolean =>
  // oxlint-disable-next-line no-bitwise -- TypeScript exposes symbol categories and modifiers as bitmasks.
  (flags & flag) !== 0;

const hasSymbolFlag = (symbol: ts.Symbol, flag: ts.SymbolFlags): boolean =>
  hasFlag(symbol.flags, flag);

const symbolKind = (symbol: ts.Symbol): string => {
  const kinds = [
    [ts.SymbolFlags.Function, "function"],
    [ts.SymbolFlags.Class, "class"],
    [ts.SymbolFlags.Interface, "interface"],
    [ts.SymbolFlags.TypeAlias, "type"],
    [ts.SymbolFlags.Enum, "enum"],
    [ts.SymbolFlags.Module, "namespace"],
    [ts.SymbolFlags.Variable, "variable"],
  ] as const;
  const matched = kinds
    .filter(([flag]) => hasSymbolFlag(symbol, flag))
    .map(([, kind]) => kind);
  if (matched.length === 0) {
    return fail(`Cannot classify exported symbol ${symbol.name}`);
  }
  return matched.join("+");
};

const formatDiagnostics = (diagnostics: readonly ts.Diagnostic[]): string =>
  ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  });

/**
 * The global declaration scripts the package's tsconfig includes (a `.d.ts`
 * with no import or export, such as one that references a styling library's
 * JSX props). They are the environment its declarations type-check in, so
 * every declaration program loads them from the package.
 */
const ambientDeclarationFiles = (packageDir: string): string[] => {
  const configFile = path.join(packageDir, "tsconfig.json");
  if (!existsSync(configFile)) {
    return [];
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configFile,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
        fail(formatDiagnostics([diagnostic])),
    },
  );
  return (parsed?.fileNames ?? [])
    .filter(
      (file) =>
        /\.d\.[cm]?ts$/u.test(file) &&
        !file.includes(INSTALLED_PATH) &&
        !ts.isExternalModule(
          ts.createSourceFile(
            file,
            readFileSync(file, "utf-8"),
            ts.ScriptTarget.Latest,
          ),
        ),
    )
    .toSorted(compareCodeUnit);
};

const declarationProgram = (
  files: Map<string, string>,
  rootNames: string[],
  packageDir: string,
): ts.Program => {
  const host = compilerHost();
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalDirectoryExists = host.directoryExists?.bind(host);
  const directories = new Set<string>();
  for (const file of files.keys()) {
    let directory = path.dirname(file);
    while (!directories.has(directory)) {
      directories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  host.readFile = (file) => files.get(file) ?? originalRead(file);
  host.fileExists = (file) => files.has(file) || originalExists(file);
  host.directoryExists = (directory) =>
    directories.has(directory) ||
    (originalDirectoryExists?.(directory) ?? false);
  return ts.createProgram({
    rootNames: [...rootNames, ...ambientDeclarationFiles(packageDir)],
    options: { ...compilerOptions, skipLibCheck: false },
    host,
  });
};

/**
 * Any semantic error in a compared declaration fails: TypeScript gives an
 * unresolvable reference its error type, which is assignable both ways and has
 * no members, so a break behind it would compare as compatible.
 */
const assertResolvableDeclarations = (
  program: ts.Program,
  source: ts.SourceFile,
): void => {
  const diagnostics = program.getSemanticDiagnostics(source);
  if (diagnostics.length > 0) {
    fail(formatDiagnostics(diagnostics));
  }
};

// A declaration file without explicit exports exports every declaration,
// including the generic type probes the comparison adds.
const publicExports = (symbols: readonly ts.Symbol[]): ts.Symbol[] =>
  symbols.filter(({ name }) => !isGenericTypeProbeName(name));

const exportedSymbols = (program: ts.Program, file: string): ts.Symbol[] => {
  const source = program.getSourceFile(file);
  if (source === undefined) {
    return fail(`Public entrypoint not found: ${file}`);
  }
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(source);
  if (module === undefined) {
    return fail(`Public entrypoint is not a module: ${file}`);
  }
  return publicExports(checker.getExportsOfModule(module)).toSorted((a, b) =>
    compareCodeUnit(a.name, b.name),
  );
};

const unalias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
  hasSymbolFlag(symbol, ts.SymbolFlags.Alias)
    ? checker.getAliasedSymbol(symbol)
    : symbol;

// Conditional branches are independent contracts: changing an import or types
// branch must not hide behind an unchanged default branch.
const exportTargets = (
  value: unknown,
  key: string,
): { key: string; target: string }[] => {
  if (typeof value === "string") {
    return [{ key, target: value }];
  }
  if (value === null) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return fail(`Unsupported export map at ${key}`);
  }
  return Object.entries(value).flatMap(([condition, target]) =>
    exportTargets(target, `${key} [${condition}]`),
  );
};

/**
 * The export map key Node resolves a subpath through: an exact key first,
 * then the pattern with the longest prefix before its `*`, then the longer
 * key. A wildcard match only belongs to its pattern when that pattern wins,
 * so a `null` key or a more specific pattern takes the subpath away from it.
 */
export const resolvingExportKey = (
  keys: readonly string[],
  subpath: string,
): string | undefined => {
  if (keys.includes(subpath)) {
    return subpath;
  }
  let best: string | undefined;
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star === -1 || key.includes("*", star + 1)) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length < key.length ||
      !subpath.startsWith(prefix) ||
      !subpath.endsWith(suffix)
    ) {
      continue;
    }
    const bestStar = best?.indexOf("*") ?? -1;
    if (
      best === undefined ||
      star > bestStar ||
      (star === bestStar && key.length > best.length)
    ) {
      best = key;
    }
  }
  return best;
};

export const generateApiReport = (packageDir: string): ApiReport => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf-8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("name" in manifest) ||
    typeof manifest.name !== "string" ||
    !("exports" in manifest)
  ) {
    return fail(`${packageDir}: expected a named package with exports`);
  }
  const exports = manifest.exports;
  const subpathMap =
    typeof exports === "object" &&
    exports !== null &&
    Object.keys(exports).some((key) => key.startsWith("."));
  const exportKeys = subpathMap ? Object.keys(exports) : ["."];
  const targets = subpathMap
    ? Object.entries(exports).flatMap(([key, value]) =>
        exportTargets(value, key),
      )
    : exportTargets(exports, ".");
  // A pattern's matches, as subpath and file, that Node resolves through it.
  const patternMatches = (key: string, target: string) => {
    const pattern = key.split(" [").at(0) ?? key;
    const condition = key.slice(pattern.length);
    const [prefix = "", suffix = ""] = target.split("*");
    return [...new Bun.Glob(target).scanSync({ cwd: packageDir })]
      .toSorted(compareCodeUnit)
      .flatMap((file) => {
        const relative = file.startsWith("./") ? file : `./${file}`;
        const match = relative.slice(
          prefix.length,
          relative.length - suffix.length,
        );
        const subpath = pattern.replaceAll("*", () => match);
        return resolvingExportKey(exportKeys, subpath) === pattern
          ? [{ key: `${subpath}${condition}`, target: relative, file }]
          : [];
      });
  };
  const expanded = targets.flatMap(({ key, target }) => {
    if (!target.startsWith("./") || target.includes("..")) {
      return fail(`Unsupported export target ${key}: ${target}`);
    }
    if (!target.includes("*")) {
      return [{ key, target }];
    }
    const matches = patternMatches(key, target);
    if (matches.length === 0) {
      return fail(`Export pattern ${key} matches no files: ${target}`);
    }
    if (!/\.(?:tsx?|mts|cts|[cm]?js|jsx)$/u.test(target)) {
      return [{ key, target }];
    }
    return matches.map((match) => ({ key: match.key, target: match.target }));
  });
  const moduleTargets = expanded.filter(({ target }) =>
    /\.(?:tsx?|mts|cts)$/u.test(target),
  );
  const program = ts.createProgram({
    rootNames: moduleTargets.map(({ target }) =>
      path.resolve(packageDir, target),
    ),
    options: compilerOptions,
    host: compilerHost(),
  });
  const checker = program.getTypeChecker();
  const entrypoints = new Map<string, ApiEntrypoint>();
  for (const { key, target } of expanded.toSorted((a, b) =>
    compareCodeUnit(a.key, b.key),
  )) {
    if (target.includes("*")) {
      entrypoints.set(key, {
        type: "asset",
        target,
        files: patternMatches(key, target).map(({ file }) => file),
      });
      continue;
    }
    if (!existsSync(path.resolve(packageDir, target))) {
      return fail(`Public export ${key} does not exist: ${target}`);
    }
    if (/\.(?:[cm]?js|jsx)$/u.test(target)) {
      return fail(
        `Code export ${key} must target TypeScript declarations: ${target}`,
      );
    }
    if (!/\.(?:tsx?|mts|cts)$/u.test(target)) {
      entrypoints.set(key, { type: "asset", target, files: [target] });
      continue;
    }
    entrypoints.set(key, {
      type: "module",
      file: declarationPath(target),
      exports: exportedSymbols(program, path.resolve(packageDir, target)).map(
        (symbol) => {
          const resolved = unalias(checker, symbol);
          const value =
            hasSymbolFlag(resolved, ts.SymbolFlags.Value) &&
            hasRuntimeExport({
              program,
              file: path.resolve(packageDir, target),
              name: symbol.name,
            });
          let space: ExportedName["space"] = "type";
          if (value) {
            space = hasSymbolFlag(resolved, ts.SymbolFlags.Type)
              ? "type+value"
              : "value";
          }
          return { name: symbol.name, kind: symbolKind(resolved), space };
        },
      ),
    });
  }
  const declarations = new Map<string, string>();
  const printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });
  for (const source of program
    .getSourceFiles()
    .toSorted((a, b) => compareCodeUnit(a.fileName, b.fileName))) {
    const relative = repoRelativePath(packageDir, source.fileName);
    if (relative.startsWith("..") || relative.includes("node_modules")) {
      continue;
    }
    if (source.isDeclarationFile) {
      declarations.set(`./${relative}`, printer.printFile(source));
      continue;
    }
    if (relative.endsWith(".json")) {
      declarations.set(
        `./${relative}`,
        `${JSON.stringify(JSON.parse(source.text))}\n`,
      );
      continue;
    }
    const result = program.emit(
      source,
      (file, contents) => {
        if (!/\.d\.[cm]?ts$/u.test(file)) {
          return;
        }
        const declaration = ts.createSourceFile(
          file,
          contents,
          ts.ScriptTarget.Latest,
          true,
        );
        declarations.set(
          `./${declarationPath(relative)}`,
          printer.printFile(declaration),
        );
      },
      undefined,
      true,
    );
    if (result.emitSkipped || result.diagnostics.length > 0) {
      return fail(
        ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
          getCanonicalFileName: (file) => file,
          getCurrentDirectory: () => packageDir,
          getNewLine: () => "\n",
        }),
      );
    }
  }
  const snapshotRoot = path.join(packageDir, "__api_snapshot__");
  const files = new Map(
    [...declarations].map(([file, contents]) => [
      path.resolve(snapshotRoot, file),
      contents,
    ]),
  );
  const roots = [...entrypoints.values()].flatMap((entry) =>
    entry.type === "module" ? [path.resolve(snapshotRoot, entry.file)] : [],
  );
  const surface = declarationProgram(files, roots, packageDir);
  const reachable = new Set(
    surface.getSourceFiles().map(({ fileName }) => fileName),
  );
  const publicDeclarations = [...declarations].filter(([file]) =>
    reachable.has(path.resolve(snapshotRoot, file)),
  );
  for (const [file] of publicDeclarations) {
    const declaration = surface.getSourceFile(path.resolve(snapshotRoot, file));
    if (declaration !== undefined) {
      assertResolvableDeclarations(surface, declaration);
    }
  }
  return {
    package: manifest.name,
    entrypoints: Object.fromEntries(entrypoints),
    declarations: Object.fromEntries(publicDeclarations),
  };
};

const hasModifierFlag = (
  declaration: ts.Declaration,
  flag: ts.ModifierFlags,
): boolean => hasFlag(ts.getCombinedModifierFlags(declaration), flag);

const isNonPublicMember = (member: ts.Symbol): boolean =>
  member.name.startsWith("#") ||
  member.name.startsWith("__#") ||
  (member.declarations ?? []).some(
    (declaration) =>
      hasModifierFlag(declaration, ts.ModifierFlags.Private) ||
      hasModifierFlag(declaration, ts.ModifierFlags.Protected),
  );

const isReadonlyMember = (member: ts.Symbol): boolean => {
  const declarations = member.declarations ?? [];
  return (
    declarations.some((declaration) =>
      hasModifierFlag(declaration, ts.ModifierFlags.Readonly),
    ) ||
    (declarations.some(ts.isGetAccessorDeclaration) &&
      !declarations.some(ts.isSetAccessorDeclaration))
  );
};

type NarrowingComparison = {
  checker: ts.TypeChecker;
  /** Old and new type pairs already compared, so recursive types end. */
  compared: Map<ts.Type, Set<ts.Type>>;
  /** How many types deep below the exported symbol this comparison is. */
  depth: number;
};

// Nested shapes the package declares are walked this deep; a deeper chain is
// a recursive type, already compared at its first occurrence.
const MAX_NESTED_DEPTH = 8;

const signatureKinds = [
  [ts.SignatureKind.Call, ""],
  [ts.SignatureKind.Construct, "new "],
] as const;

/**
 * Assignability lets an optional member disappear and a mutable one become
 * readonly, yet consumers that read or assign that member break. Every public
 * member the old type exposes must stay, and stay writable if it was, at
 * every depth: in member types, and in the parameters and results of call
 * and construct signatures that keep their overload count.
 */
const narrowedTypeMembers = (
  comparison: NarrowingComparison,
  oldType: ts.Type,
  nextType: ts.Type,
  label: string,
): string[] => {
  // One type object on both sides is one declaration (a library or
  // dependency type): nothing in it changed.
  if (oldType === nextType) {
    return [];
  }
  const seen = comparison.compared.get(oldType) ?? new Set<ts.Type>();
  if (seen.has(nextType)) {
    return [];
  }
  seen.add(nextType);
  comparison.compared.set(oldType, seen);
  const { checker } = comparison;
  // Keyed on the escaped name: symbol-keyed members such as
  // `[Symbol.iterator]` have no string name a lookup by name would accept.
  const nextMembers = new Map(
    checker
      .getPropertiesOfType(nextType)
      .map((member) => [member.escapedName, member]),
  );
  const breaks = checker.getPropertiesOfType(oldType).flatMap((member) => {
    if (isNonPublicMember(member)) {
      return [];
    }
    const nextMember = nextMembers.get(member.escapedName);
    if (nextMember === undefined) {
      return [`${label}: removed member ${member.name}`];
    }
    if (isReadonlyMember(nextMember) && !isReadonlyMember(member)) {
      return [`${label}: member ${member.name} became readonly`];
    }
    return nestedNarrowing(
      comparison,
      checker.getNonNullableType(checker.getTypeOfSymbol(member)),
      checker.getNonNullableType(checker.getTypeOfSymbol(nextMember)),
      `${label}.${member.name}`,
    );
  });
  for (const [kind, prefix] of signatureKinds) {
    const oldSignatures = checker.getSignaturesOfType(oldType, kind);
    const nextSignatures = checker.getSignaturesOfType(nextType, kind);
    if (oldSignatures.length !== nextSignatures.length) {
      continue;
    }
    for (const [index, oldSignature] of oldSignatures.entries()) {
      const nextSignature =
        nextSignatures[index] ?? panic("Signature counts differ");
      const signatureLabel = `${prefix}${label}${oldSignatures.length > 1 ? `#${index + 1}` : ""}`;
      breaks.push(
        ...nestedNarrowing(
          comparison,
          checker.getNonNullableType(
            checker.getReturnTypeOfSignature(oldSignature),
          ),
          checker.getNonNullableType(
            checker.getReturnTypeOfSignature(nextSignature),
          ),
          `${signatureLabel}()`,
        ),
      );
      for (const [position, parameter] of oldSignature.parameters.entries()) {
        const nextParameter = nextSignature.parameters[position];
        if (nextParameter === undefined) {
          continue;
        }
        breaks.push(
          ...nestedNarrowing(
            comparison,
            checker.getNonNullableType(checker.getTypeOfSymbol(parameter)),
            checker.getNonNullableType(checker.getTypeOfSymbol(nextParameter)),
            `${signatureLabel}(${parameter.name})`,
          ),
        );
      }
    }
  }
  return breaks;
};

/** A declaration in the compared trees, not one from a dependency or lib. */
const isComparedDeclaration = (declaration: ts.Declaration): boolean =>
  /[\\/]__api_(?:before|after)__[\\/]/u.test(
    declaration.getSourceFile().fileName,
  );

/** A type the compared declarations declare, not one from a dependency or lib. */
const isPackageDeclaredType = (type: ts.Type): boolean =>
  (type.aliasSymbol ?? type.getSymbol())?.declarations?.some(
    isComparedDeclaration,
  ) ?? false;

/**
 * Below the exported symbol only object types the package itself declares
 * are walked. A primitive or a union has the apparent members of its
 * constituents, which widening a type legitimately changes, and assignability
 * already guards them; a dependency's type is the same on both sides.
 */
const nestedNarrowing = (
  comparison: NarrowingComparison,
  oldType: ts.Type,
  nextType: ts.Type,
  label: string,
): string[] =>
  comparison.depth < MAX_NESTED_DEPTH &&
  hasFlag(oldType.flags, ts.TypeFlags.Object) &&
  hasFlag(nextType.flags, ts.TypeFlags.Object) &&
  isPackageDeclaredType(oldType) &&
  isPackageDeclaredType(nextType)
    ? narrowedTypeMembers(
        { ...comparison, depth: comparison.depth + 1 },
        oldType,
        nextType,
        label,
      )
    : [];

const narrowedMembers = (
  checker: ts.TypeChecker,
  oldType: ts.Type,
  nextType: ts.Type,
  label: string,
): string[] =>
  narrowedTypeMembers(
    { checker, compared: new Map(), depth: 0 },
    oldType,
    nextType,
    label,
  );

type SignatureComparisonOptions = {
  checker: ts.TypeChecker;
  old: ts.Symbol;
  next: ts.Symbol;
  label: string;
};

const mutuallyAssignable = (
  checker: ts.TypeChecker,
  oldType: ts.Type,
  nextType: ts.Type,
): boolean =>
  checker.isTypeAssignableTo(oldType, nextType) &&
  checker.isTypeAssignableTo(nextType, oldType);

/**
 * A generic type the package declares is compared through the probe declared
 * beside it (see `withGenericTypeProbes`): the before and after declarations
 * then share their type parameters, position by position. A re-exported
 * dependency type has no probe; it is one declaration on both sides.
 */
const genericTypeComparison = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  label: string,
): { count: number; probe: ts.Type | undefined } | undefined => {
  const declaration = symbol.declarations?.find(isGenericTypeDeclaration);
  if (declaration === undefined) {
    return undefined;
  }
  const count = declaration.typeParameters.length;
  if (!isComparedDeclaration(declaration)) {
    return { count, probe: undefined };
  }
  const probe = genericTypeProbe(declaration);
  if (probe === undefined) {
    return fail(`${label}: generic type has no comparison probe`);
  }
  return { count, probe: checker.getTypeFromTypeNode(probe) };
};

const incompatibleSymbolSignatures = ({
  checker,
  old,
  next,
  label,
}: SignatureComparisonOptions): string[] => {
  const breaks: string[] = [];
  const location = next.valueDeclaration ?? next.declarations?.at(0);
  const oldLocation = old.valueDeclaration ?? old.declarations?.at(0);
  if (location === undefined || oldLocation === undefined) {
    return fail(`${label}: cannot resolve exported declaration`);
  }
  if (hasSymbolFlag(old, ts.SymbolFlags.Value)) {
    const oldType = checker.getTypeOfSymbolAtLocation(old, oldLocation);
    const nextType = checker.getTypeOfSymbolAtLocation(next, location);
    if (!checker.isTypeAssignableTo(nextType, oldType)) {
      breaks.push(`${label}: incompatible value signature`);
    } else if (!hasSymbolFlag(old, ts.SymbolFlags.Module)) {
      // A namespace's members are its exports, compared one by one below.
      breaks.push(...narrowedMembers(checker, oldType, nextType, label));
    }
  }
  if (hasSymbolFlag(old, ts.SymbolFlags.Type)) {
    const oldType = checker.getDeclaredTypeOfSymbol(old);
    const nextType = checker.getDeclaredTypeOfSymbol(next);
    const oldGeneric = genericTypeComparison(checker, old, label);
    const nextGeneric = genericTypeComparison(checker, next, label);
    if ((oldGeneric?.count ?? 0) !== (nextGeneric?.count ?? 0)) {
      breaks.push(`${label}: changed type parameter count`);
    } else if (
      oldGeneric?.probe !== undefined && nextGeneric?.probe !== undefined
        ? !mutuallyAssignable(checker, oldGeneric.probe, nextGeneric.probe)
        : !mutuallyAssignable(checker, oldType, nextType)
    ) {
      breaks.push(`${label}: incompatible type signature`);
    } else {
      breaks.push(...narrowedMembers(checker, oldType, nextType, label));
    }
  }
  return breaks;
};

type ApiBreak = {
  type: "removal" | "signature";
  entrypoint: string;
  message: string;
};

// Both declaration trees live in one checker so assignability uses TypeScript's
// variance rules, overloads and structural types rather than signature strings.
export const breakingApiChanges = ({
  before,
  after,
  packageDir,
}: {
  before: ApiReport;
  after: ApiReport;
  packageDir: string;
}): ApiBreak[] => {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }
  const files = new Map<string, string>();
  const virtualFile = (side: string, file: string): string =>
    path.resolve(packageDir, `__api_${side}__`, file);
  for (const [side, report] of [
    ["before", before],
    ["after", after],
  ] as const) {
    for (const [file, contents] of Object.entries(report.declarations)) {
      files.set(
        virtualFile(side, file),
        file.endsWith(".json")
          ? contents
          : withGenericTypeProbes(
              normalizeCompatibilityDeclarations(contents, file),
              file,
            ),
      );
    }
  }
  const program = declarationProgram(files, [...files.keys()], packageDir);
  const baseRoot = `${virtualFile("before", "")}${path.sep}`;
  const baseDiagnostics: ts.Diagnostic[] = [];
  for (const source of program.getSourceFiles()) {
    if (!files.has(source.fileName)) {
      continue;
    }
    if (source.fileName.startsWith(baseRoot)) {
      baseDiagnostics.push(...program.getSemanticDiagnostics(source));
    } else {
      assertResolvableDeclarations(program, source);
    }
  }
  if (baseDiagnostics.length > 0) {
    // The base API no longer type-checks against the installed dependencies
    // (a dependency dropped a type it names), so no member can be compared
    // reliably. The change is reported as a break that a breaking-release
    // changeset authorizes instead of failing before authorization is read.
    return [
      {
        type: "signature",
        entrypoint: ".",
        message: `base API no longer type-checks against the installed dependencies, so it cannot be compared:\n${formatDiagnostics(baseDiagnostics).trimEnd()}`,
      },
    ];
  }
  const checker = program.getTypeChecker();
  const breaks: ApiBreak[] = [];
  for (const [entry, previous] of Object.entries(before.entrypoints)) {
    const current = after.entrypoints[entry];
    if (current === undefined || current.type !== previous.type) {
      const names =
        previous.type === "module"
          ? previous.exports.map(({ name }) => name).join(", ")
          : "asset";
      breaks.push({
        type: "removal",
        entrypoint: entry,
        message: `${entry}: removed entrypoint (${names})`,
      });
      continue;
    }
    if (previous.type === "asset" && current.type === "asset") {
      for (const file of previous.files) {
        if (!current.files.includes(file)) {
          breaks.push({
            type: "removal",
            entrypoint: entry,
            message: `${entry}: removed asset ${file}`,
          });
        }
      }
      continue;
    }
    if (previous.type !== "module" || current.type !== "module") {
      continue;
    }
    const previousFile = virtualFile("before", previous.file);
    const currentFile = virtualFile("after", current.file);
    const pending = [
      {
        oldSymbols: exportedSymbols(program, previousFile),
        newSymbols: exportedSymbols(program, currentFile),
        prefix: `${entry}#`,
      },
    ];
    // Keyed on the old and new symbol pair: two aliases of one old namespace
    // can resolve to different new namespaces, and each pair needs comparing.
    const compared = new Map<ts.Symbol, Set<ts.Symbol>>();
    for (const pair of pending) {
      const newSymbols = new Map(
        pair.newSymbols.map((symbol) => [symbol.name, symbol]),
      );
      for (const oldSymbol of pair.oldSymbols) {
        const newSymbol = newSymbols.get(oldSymbol.name);
        const label = `${pair.prefix}${oldSymbol.name}`;
        if (newSymbol === undefined) {
          breaks.push({
            type: "removal",
            entrypoint: entry,
            message: `${label}: removed export`,
          });
          continue;
        }
        const oldExport = previous.exports.find(
          ({ name }) => name === oldSymbol.name,
        );
        const newExport = current.exports.find(
          ({ name }) => name === newSymbol.name,
        );
        if (oldExport?.space !== "type" && newExport?.space === "type") {
          breaks.push({
            type: "removal",
            entrypoint: entry,
            message: `${label}: removed runtime export`,
          });
        }
        const old = unalias(checker, oldSymbol);
        const next = unalias(checker, newSymbol);
        if (symbolKind(old) !== symbolKind(next)) {
          breaks.push({
            type: "signature",
            entrypoint: entry,
            message: `${label}: changed export kind`,
          });
          continue;
        }
        const comparedTargets = compared.get(old) ?? new Set<ts.Symbol>();
        if (
          hasSymbolFlag(old, ts.SymbolFlags.Module) &&
          !comparedTargets.has(next)
        ) {
          comparedTargets.add(next);
          compared.set(old, comparedTargets);
          pending.push({
            oldSymbols: publicExports(checker.getExportsOfModule(old)),
            newSymbols: publicExports(checker.getExportsOfModule(next)),
            prefix: `${label}.`,
          });
        }
        breaks.push(
          ...incompatibleSymbolSignatures({ checker, old, next, label }).map(
            (message) =>
              ({ type: "signature", entrypoint: entry, message }) as const,
          ),
        );
      }
    }
  }
  return breaks;
};

/**
 * What the check reads from its Git base, as scripts/package-api-base.sh
 * materialises it: the merge base's package manifests, API reports and changesets under `tree/`,
 * and the changesets added or modified since, one per line, in
 * `changed-changesets`. The check itself reads files only.
 */
type CheckPackageApiOptions = {
  root: string;
  baseDir: string;
  packageDirs: readonly string[];
};

/**
 * The committed report's value; a missing or unreadable file has none. A
 * report is compared as a value, so key order and layout never count.
 */
const committedReportValue = (file: string): unknown => {
  if (!existsSync(file)) {
    return undefined;
  }
  const parsed = Result.try((): unknown =>
    JSON.parse(readFileSync(file, "utf-8")),
  );
  return Result.isOk(parsed) ? parsed.value : undefined;
};

const namesEntrypoint = (
  summary: string,
  name: string,
  entrypoint: string,
): boolean => {
  const entryPath =
    entrypoint.split(" [").at(0) ?? fail("Missing entrypoint path");
  const qualified = entryPath === "." ? name : `${name}${entryPath.slice(1)}`;
  const names = new Set(summary.match(/[\p{L}\p{N}@_./*-]+/gu));
  return names.has(qualified) || (entryPath !== "." && names.has(entryPath));
};

export const checkPackageApi = ({
  root,
  baseDir,
  packageDirs,
}: CheckPackageApiOptions): string[] => {
  const errors: string[] = [];
  const baseTree = path.join(baseDir, "tree");
  const baseText = (file: string): string | undefined =>
    existsSync(path.join(baseTree, file))
      ? readFileSync(path.join(baseTree, file), "utf-8")
      : undefined;
  const changedChangesets = readFileSync(
    path.join(baseDir, "changed-changesets"),
    "utf-8",
  )
    .trim()
    .split("\n");
  const changesets = changedChangesets
    .filter(
      (file) =>
        /^\.changeset\/[^/]+\.md$/u.test(file) && !file.endsWith("README.md"),
    )
    .map((file) => {
      const current = readFileSync(path.join(root, file), "utf-8");
      const previous = baseText(file);
      return {
        releases: parseChangesetReleases(current),
        summary: parseChangesetEntry(current).summary,
        previousReleases:
          previous === undefined ? [] : parseChangesetReleases(previous),
        previousSummary:
          previous === undefined ? "" : parseChangesetEntry(previous).summary,
      };
    });
  const authorized = (
    name: string,
    relative: string,
    change: ApiBreak,
  ): boolean =>
    changesets.some(
      ({ releases, summary, previousReleases, previousSummary }) =>
        releases.some((release) => {
          if (release.name !== name || release.type === "patch") {
            return false;
          }
          if (release.type === "minor") {
            const manifest: unknown = JSON.parse(
              baseText(`${relative}/package.json`) ??
                readFileSync(
                  path.join(root, relative, "package.json"),
                  "utf-8",
                ),
            );
            if (
              typeof manifest !== "object" ||
              manifest === null ||
              !("version" in manifest) ||
              typeof manifest.version !== "string"
            ) {
              return fail(
                `${name}: expected a package version for release authorization`,
              );
            }
            if (!manifest.version.startsWith("0.")) {
              return false;
            }
          }
          const existingRelease = previousReleases.some(
            (previous) =>
              previous.name === name && previous.type === release.type,
          );
          switch (change.type) {
            case "signature":
              return !existingRelease;
            case "removal":
              return (
                namesEntrypoint(summary, name, change.entrypoint) &&
                (!existingRelease ||
                  !namesEntrypoint(previousSummary, name, change.entrypoint))
              );
            default:
              change.type satisfies never;
              return panic("Unsupported API change type");
          }
        }),
    );
  for (const relative of packageDirs) {
    const packageDir = path.join(root, relative);
    const file = `${relative}/${REPORT_FILE}`;
    const report = generateApiReport(packageDir);
    if (
      !isDeepStrictEqual(committedReportValue(path.join(root, file)), report)
    ) {
      errors.push(
        `${report.package}: stale ${file}; regenerate and commit with ${REGENERATE}`,
      );
    }
    const baseReport = baseText(file);
    if (baseReport === undefined) {
      continue;
    }
    const before: ApiReport = JSON.parse(baseReport);
    const breaks = breakingApiChanges({
      before,
      after: report,
      packageDir,
    }).filter((change) => !authorized(report.package, relative, change));
    if (breaks.length > 0) {
      errors.push(
        `${report.package}: published packages have consumers outside this repository. A breaking-release changeset (minor for 0.x, major otherwise), naming removed entrypoints, and committed regenerated report are required:\n  ${breaks.map(({ message }) => message).join("\n  ")}`,
      );
    }
  }
  const basePackages = path.join(baseTree, "packages");
  const basePackageNames = existsSync(basePackages)
    ? readdirSync(basePackages).toSorted(compareCodeUnit)
    : [];
  for (const name of basePackageNames) {
    const relative = `packages/${name}`;
    const baseReport = baseText(`${relative}/${REPORT_FILE}`);
    if (baseReport === undefined || packageDirs.includes(relative)) {
      continue;
    }
    const before: ApiReport = JSON.parse(baseReport);
    if (
      !Object.keys(before.entrypoints).every((entrypoint) =>
        authorized(before.package, relative, {
          type: "removal",
          entrypoint,
          message: `${entrypoint}: removed entrypoint`,
        }),
      )
    ) {
      errors.push(
        `${before.package}: removed published package entrypoints; published packages have consumers outside this repository. A breaking-release changeset naming every removed entrypoint is required.`,
      );
    }
  }
  return errors;
};

export const publishedPackageDirs = (): string[] => {
  const config: { ignore: string[] } = JSON.parse(
    readFileSync(path.join(ROOT, ".changeset/config.json"), "utf-8"),
  );
  const manifests = readdirSync(path.join(ROOT, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const file = path.join(ROOT, "packages", name, "package.json");
      if (!existsSync(file)) {
        return [];
      }
      const manifest: {
        name: string;
        private?: boolean;
        publishConfig?: unknown;
      } = JSON.parse(readFileSync(file, "utf-8"));
      return manifest.private !== true &&
        manifest.publishConfig !== undefined &&
        !config.ignore.includes(manifest.name)
        ? [name]
        : [];
    })
    .toSorted(compareCodeUnit);
  if (
    JSON.stringify(manifests) !==
    JSON.stringify([...ALL_PACKAGE_ORDER].toSorted(compareCodeUnit))
  ) {
    fail(
      "npm release configuration and non-private publishConfig packages disagree; reconcile scripts/publish-packages.ts and .changeset/config.json",
    );
  }
  return manifests
    .toSorted((a, b) => Number(b === "ui") - Number(a === "ui"))
    .map((name) => `packages/${name}`);
};

const USAGE =
  "Usage: bun scripts/package-api-report.ts --check --base-dir <directory from scripts/package-api-base.sh>";

if (import.meta.main) {
  assertOfflineCheckPreload();

  const [mode, option, baseDir, ...extra] = process.argv.slice(2);
  if (
    mode !== "--check" ||
    option !== "--base-dir" ||
    baseDir === undefined ||
    extra.length > 0
  ) {
    throw new PackageApiError({ message: USAGE });
  }
  const errors = checkPackageApi({
    root: ROOT,
    baseDir,
    packageDirs: publishedPackageDirs(),
  });
  for (const error of errors) {
    console.error(error);
  }
  if (errors.length === 0) {
    console.log("Published package API reports: up to date and compatible.");
  }
  process.exit(errors.length === 0 ? 0 : 1);
}
