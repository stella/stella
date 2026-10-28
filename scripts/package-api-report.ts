#!/usr/bin/env bun

import { TaggedError } from "better-result";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";

import { parseChangesetReleases } from "./changeset-entry";
import { formattedLikeRepository } from "./generated-artifacts";
import { normalizeCompatibilityDeclarations } from "./package-api-compatibility";
import { hasRuntimeExport } from "./package-api-export-space";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const REPORT_FILE = "api-report.json";
const REGENERATE = "bun run update:package-api";
const ROOT = path.resolve(import.meta.dirname, "..");

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

const hasSymbolFlag = (symbol: ts.Symbol, flag: ts.SymbolFlags): boolean =>
  // oxlint-disable-next-line no-bitwise -- TypeScript exposes symbol categories as a bitmask.
  (symbol.flags & flag) !== 0;

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

const declarationProgram = (
  files: Map<string, string>,
  rootNames: string[],
): ts.Program => {
  const host = ts.createCompilerHost(compilerOptions);
  const originalRead = host.readFile;
  const originalExists = host.fileExists;
  const originalDirectoryExists = host.directoryExists;
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
    rootNames,
    options: { ...compilerOptions, skipLibCheck: false },
    host,
  });
};

const assertResolvableDeclarations = (
  program: ts.Program,
  source: ts.SourceFile,
): void => {
  const unresolved = program
    .getSemanticDiagnostics(source)
    .filter(({ code }) => [2304, 2305, 2307, 2503, 2694, 7016].includes(code));
  if (unresolved.length > 0) {
    fail(
      ts.formatDiagnostics(unresolved, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => "\n",
      }),
    );
  }
};

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
  return checker
    .getExportsOfModule(module)
    .toSorted((a, b) => compareCodeUnit(a.name, b.name));
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
  const targets =
    typeof exports === "object" &&
    exports !== null &&
    Object.keys(exports).some((key) => key.startsWith("."))
      ? Object.entries(exports).flatMap(([key, value]) =>
          exportTargets(value, key),
        )
      : exportTargets(exports, ".");
  const expanded = targets.flatMap(({ key, target }) => {
    if (!target.startsWith("./") || target.includes("..")) {
      return fail(`Unsupported export target ${key}: ${target}`);
    }
    if (!target.includes("*")) {
      return [{ key, target }];
    }
    const files = [
      ...new Bun.Glob(target).scanSync({ cwd: packageDir }),
    ].toSorted();
    if (files.length === 0) {
      return fail(`Export pattern ${key} matches no files: ${target}`);
    }
    if (!/\.(?:tsx?|mts|cts|[cm]?js|jsx)$/u.test(target)) {
      return [{ key, target }];
    }
    const [prefix, suffix = ""] = target.split("*");
    return files.map((file) => {
      const relative = file.startsWith("./") ? file : `./${file}`;
      const match = relative.slice(
        prefix?.length ?? 0,
        relative.length - suffix.length,
      );
      return { key: key.replaceAll("*", () => match), target: relative };
    });
  });
  const moduleTargets = expanded.filter(({ target }) =>
    /\.(?:tsx?|mts|cts)$/u.test(target),
  );
  const program = ts.createProgram({
    rootNames: moduleTargets.map(({ target }) =>
      path.resolve(packageDir, target),
    ),
    options: compilerOptions,
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
        files: [...new Bun.Glob(target).scanSync({ cwd: packageDir })].toSorted(
          compareCodeUnit,
        ),
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
  const surface = declarationProgram(files, roots);
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

type SignatureComparisonOptions = {
  checker: ts.TypeChecker;
  old: ts.Symbol;
  next: ts.Symbol;
  label: string;
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
    }
  }
  if (hasSymbolFlag(old, ts.SymbolFlags.Type)) {
    const oldType = checker.getDeclaredTypeOfSymbol(old);
    const nextType = checker.getDeclaredTypeOfSymbol(next);
    if (
      !checker.isTypeAssignableTo(oldType, nextType) ||
      !checker.isTypeAssignableTo(nextType, oldType)
    ) {
      breaks.push(`${label}: incompatible type signature`);
    }
  }
  return breaks;
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
}): string[] => {
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
          : normalizeCompatibilityDeclarations(contents),
      );
    }
  }
  const program = declarationProgram(files, [...files.keys()]);
  for (const source of program.getSourceFiles()) {
    if (files.has(source.fileName)) {
      assertResolvableDeclarations(program, source);
    }
  }
  const checker = program.getTypeChecker();
  const breaks: string[] = [];
  for (const [entry, previous] of Object.entries(before.entrypoints)) {
    const current = after.entrypoints[entry];
    if (current === undefined || current.type !== previous.type) {
      const names =
        previous.type === "module"
          ? previous.exports.map(({ name }) => name).join(", ")
          : "asset";
      breaks.push(`${entry}: removed entrypoint (${names})`);
      continue;
    }
    if (previous.type === "asset" && current.type === "asset") {
      for (const file of previous.files) {
        if (!current.files.includes(file)) {
          breaks.push(`${entry}: removed asset ${file}`);
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
    const compared = new Set<ts.Symbol>();
    for (const pair of pending) {
      const newSymbols = new Map(
        pair.newSymbols.map((symbol) => [symbol.name, symbol]),
      );
      for (const oldSymbol of pair.oldSymbols) {
        const newSymbol = newSymbols.get(oldSymbol.name);
        const label = `${pair.prefix}${oldSymbol.name}`;
        if (newSymbol === undefined) {
          breaks.push(`${label}: removed export`);
          continue;
        }
        const oldExport = previous.exports.find(
          ({ name }) => name === oldSymbol.name,
        );
        const newExport = current.exports.find(
          ({ name }) => name === newSymbol.name,
        );
        if (oldExport?.space !== "type" && newExport?.space === "type") {
          breaks.push(`${label}: removed runtime export`);
        }
        const old = unalias(checker, oldSymbol);
        const next = unalias(checker, newSymbol);
        if (symbolKind(old) !== symbolKind(next)) {
          breaks.push(`${label}: changed export kind`);
          continue;
        }
        if (hasSymbolFlag(old, ts.SymbolFlags.Module) && !compared.has(old)) {
          compared.add(old);
          pending.push({
            oldSymbols: checker.getExportsOfModule(old),
            newSymbols: checker.getExportsOfModule(next),
            prefix: `${label}.`,
          });
        }
        breaks.push(
          ...incompatibleSymbolSignatures({ checker, old, next, label }),
        );
      }
    }
  }
  return breaks;
};

const git = (root: string, args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return fail(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

export const checkPackageApi = async ({
  root,
  base,
  packageDirs,
  write = false,
}: {
  root: string;
  base: string;
  packageDirs: readonly string[];
  write?: boolean;
}): Promise<string[]> => {
  const errors: string[] = [];
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const baseFiles = new Set(
    git(root, ["ls-tree", "-r", "--name-only", mergeBase]).trim().split("\n"),
  );
  const changedChangesets = git(root, [
    "diff",
    "--name-only",
    "--diff-filter=AM",
    mergeBase,
    "--",
    ".changeset",
  ])
    .trim()
    .split("\n");
  const majors = new Set(
    changedChangesets
      .filter(
        (file) =>
          /^\.changeset\/[^/]+\.md$/u.test(file) && !file.endsWith("README.md"),
      )
      .flatMap((file) => {
        const existing = baseFiles.has(file)
          ? parseChangesetReleases(git(root, ["show", `${mergeBase}:${file}`]))
          : [];
        return parseChangesetReleases(
          readFileSync(path.join(root, file), "utf-8"),
        )
          .filter(
            ({ name, type }) =>
              type === "major" &&
              !existing.some(
                (release) => release.name === name && release.type === "major",
              ),
          )
          .map(({ name }) => name);
      }),
  );
  for (const relative of packageDirs) {
    const packageDir = path.join(root, relative);
    const file = `${relative}/${REPORT_FILE}`;
    const report = generateApiReport(packageDir);
    const rendered = await formattedLikeRepository(
      JSON.stringify(report, null, 2),
      "json",
    );
    if (write) {
      writeFileSync(path.join(root, file), rendered);
      continue;
    }
    if (
      !existsSync(path.join(root, file)) ||
      readFileSync(path.join(root, file), "utf-8") !== rendered
    ) {
      errors.push(
        `${report.package}: stale ${file}; regenerate and commit with ${REGENERATE}`,
      );
    }
    if (!baseFiles.has(file)) {
      continue;
    }
    const before: ApiReport = JSON.parse(
      git(root, ["show", `${mergeBase}:${file}`]),
    );
    const breaks = breakingApiChanges({ before, after: report, packageDir });
    if (breaks.length > 0 && !majors.has(report.package)) {
      errors.push(
        `${report.package}: published packages have consumers outside this repository. A major changeset and committed regenerated report are required:\n  ${breaks.join("\n  ")}`,
      );
    }
  }
  if (!write) {
    for (const file of baseFiles) {
      if (
        !/^packages\/[^/]+\/api-report\.json$/u.test(file) ||
        packageDirs.includes(file.slice(0, -`/${REPORT_FILE}`.length))
      ) {
        continue;
      }
      const before: ApiReport = JSON.parse(
        git(root, ["show", `${mergeBase}:${file}`]),
      );
      if (!majors.has(before.package)) {
        errors.push(
          `${before.package}: removed published package entrypoints; published packages have consumers outside this repository. A major changeset is required.`,
        );
      }
    }
  }
  return errors;
};

const publishedPackageDirs = (): string[] => {
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

if (import.meta.main) {
  let base = "origin/main";
  let mode: "write" | "check" | undefined;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") {
      const value = args.at(index + 1);
      if (value === undefined || value.startsWith("--")) {
        fail("--base requires a Git ref");
      }
      base = value;
      index += 1;
      continue;
    }
    if ((arg !== "--write" && arg !== "--check") || mode !== undefined) {
      fail(
        "Usage: bun scripts/package-api-report.ts --write | --check [--base <ref>]",
      );
    }
    mode = arg === "--write" ? "write" : "check";
  }
  if (mode === undefined) {
    fail(
      "Usage: bun scripts/package-api-report.ts --write | --check [--base <ref>]",
    );
  }
  const errors = await checkPackageApi({
    root: ROOT,
    base,
    packageDirs: publishedPackageDirs(),
    write: mode === "write",
  });
  for (const error of errors) {
    console.error(error);
  }
  if (errors.length === 0) {
    console.log(
      `Published package API reports: ${mode === "write" ? "regenerated" : "up to date and compatible"}.`,
    );
  }
  process.exit(errors.length === 0 ? 0 : 1);
}
