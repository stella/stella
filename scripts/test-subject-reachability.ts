import { panic } from "better-result";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "tsrs/ast";
import { API, type Checker, type Symbol as CompilerSymbol } from "tsrs/async";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { createProgram } from "../packages/scripts/src/typescript-program";

export const REACHABILITY_CATEGORIES = [
  "imported-source-subject",
  "source-factory",
  "e2e-surface",
  "spawned-entry",
  "bundled-entry",
  "sql-or-schema-reader",
  "artifact-or-workflow-guard",
  "repository-text-guard",
  "patched-dependency-subject",
] as const;

export type ReachabilityCategory = (typeof REACHABILITY_CATEGORIES)[number];

export type ReachabilityFinding = {
  file: string;
  kind: "no-classified-reachability" | "local-export-collision";
  name?: string;
  attempted?: readonly ReachabilityCategory[];
};

type AnalyzeOptions = {
  repoRoot: string;
  files?: readonly string[];
  /** Alternate source provider for equivalence tests. */
  siblingSource?: (
    filename: string,
  ) => ts.SourceFile | undefined | Promise<ts.SourceFile | undefined>;
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
// Lint fixtures deliberately contain rule violations; their owning tests execute them.
const isReachabilityTest = (file: string): boolean =>
  TEST_FILE.test(file) && !file.startsWith(".oxlint-plugins/__fixtures__/");
const TEST_SUPPORT =
  /(?:^|\/)(?:__tests__|test|tests|fixtures?|mocks?|test-utils?)(?:\/|[.-])/u;
const SOURCE_FILE = /(?:\.[cm]?[jt]sx?|\.json)$/u;
const NODE_NEXT_SOURCE_EXTENSION_SUBSTITUTIONS = new Map([
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);

const visitChildren = async (
  node: ts.Node,
  visit: (child: ts.Node) => Promise<void>,
) => {
  for (const child of node.childrenIter()) {
    await visit(child);
  }
};

const trackedTests = (repoRoot: string): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic(`Could not enumerate tests: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().split("\0").filter(isReachabilityTest);
};

const exportTarget = (entry: unknown): string | undefined => {
  if (typeof entry === "string") {
    return entry;
  }
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  for (const condition of ["import", "default", "types"]) {
    const target: unknown = Reflect.get(entry, condition);
    if (typeof target === "string") {
      return target;
    }
  }
  return undefined;
};

// Mirrors Node package resolution for workspace packages: an exports map
// decides every subpath; without one, a subpath is relative to the package
// root and the bare specifier falls back to src/index.
type ResolutionCache = {
  readonly isFile: Map<string, boolean>;
  readonly packageExports: Map<string, unknown>;
};

const createResolutionCache = (): ResolutionCache => ({
  isFile: new Map(),
  packageExports: new Map(),
});

const cachedIsFile = (candidate: string, cache?: ResolutionCache): boolean => {
  if (cache !== undefined) {
    const cached = cache.isFile.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
  }
  const result = existsSync(candidate) && statSync(candidate).isFile();
  cache?.isFile.set(candidate, result);
  return result;
};

const workspacePackageTarget = (
  packageRoot: string,
  subpath: string,
  cache?: ResolutionCache,
): string | undefined => {
  let exportsMap: unknown;
  if (cache?.packageExports.has(packageRoot)) {
    exportsMap = cache.packageExports.get(packageRoot);
  } else {
    const manifestPath = path.join(packageRoot, "package.json");
    const manifest: unknown = cachedIsFile(manifestPath, cache)
      ? JSON.parse(readFileSync(manifestPath, "utf-8"))
      : undefined;
    exportsMap =
      typeof manifest === "object" && manifest !== null
        ? Reflect.get(manifest, "exports")
        : undefined;
    cache?.packageExports.set(packageRoot, exportsMap);
  }
  if (typeof exportsMap === "string") {
    return subpath === ""
      ? path.resolve(packageRoot, exportsMap.replace(/\.[cm]?[jt]sx?$/u, ""))
      : undefined;
  }
  if (typeof exportsMap === "object" && exportsMap !== null) {
    const key = subpath === "" ? "." : `./${subpath}`;
    let target = exportTarget(Reflect.get(exportsMap, key));
    for (const [pattern, entry] of Object.entries(exportsMap)) {
      const [prefix, suffix, ...extra] = pattern.split("*");
      if (
        target !== undefined ||
        prefix === undefined ||
        suffix === undefined ||
        extra.length > 0 ||
        !key.startsWith(prefix) ||
        !key.endsWith(suffix) ||
        key.length < prefix.length + suffix.length
      ) {
        continue;
      }
      const match = key.slice(prefix.length, key.length - suffix.length);
      target = exportTarget(entry)?.replaceAll("*", () => match);
    }
    return target === undefined
      ? undefined
      : path.resolve(packageRoot, target.replace(/\.[cm]?[jt]sx?$/u, ""));
  }
  return path.resolve(packageRoot, subpath === "" ? "src/index" : subpath);
};

const candidatePaths = (
  repoRoot: string,
  testFile: string,
  specifier: string,
  cache?: ResolutionCache,
) => {
  const packageMatch = /^(apps|packages)\/([^/]+)\//u.exec(testFile);
  let unresolved: string | undefined;
  if (specifier.startsWith(".")) {
    unresolved = path.resolve(repoRoot, path.dirname(testFile), specifier);
  } else if (specifier.startsWith("@/") && packageMatch) {
    const rootKind = packageMatch.at(1);
    const packageName = packageMatch.at(2);
    if (rootKind === undefined || packageName === undefined) {
      return panic(`Invalid package path: ${testFile}`);
    }
    const aliasPath =
      packageName === "api" && specifier.startsWith("@/api/")
        ? specifier.slice("@/api/".length)
        : specifier.slice(2);
    unresolved = path.resolve(
      repoRoot,
      rootKind,
      packageName,
      "src",
      aliasPath,
    );
  } else if (specifier.startsWith("@stll/")) {
    const [packageName, ...rest] = specifier.slice("@stll/".length).split("/");
    if (packageName === undefined) {
      return [];
    }
    const rootKind = cachedIsFile(
      path.join(repoRoot, "packages", packageName, "package.json"),
      cache,
    )
      ? "packages"
      : "apps";
    unresolved = workspacePackageTarget(
      path.join(repoRoot, rootKind, packageName),
      rest.join("/"),
      cache,
    );
  }
  if (!unresolved) {
    return [];
  }
  const runtimeExtension = path.extname(unresolved);
  const sourceExtensions =
    NODE_NEXT_SOURCE_EXTENSION_SUBSTITUTIONS.get(runtimeExtension);
  if (sourceExtensions !== undefined) {
    const sourcePath = unresolved.slice(0, -runtimeExtension.length);
    return [
      ...sourceExtensions.map(
        (sourceExtension) => `${sourcePath}${sourceExtension}`,
      ),
      unresolved,
    ];
  }
  return [
    unresolved,
    ...[".ts", ".tsx", ".mts", ".cts"].map(
      (extension) => `${unresolved}${extension}`,
    ),
    ...["index.ts", "index.tsx"].map((name) => path.join(unresolved, name)),
  ];
};

type ExistingSourceOptions = {
  repoRoot: string;
  testFile: string;
  specifier: string;
  includeSupport?: boolean | undefined;
  cache?: ResolutionCache | undefined;
};

const existingSource = ({
  repoRoot,
  testFile,
  specifier,
  includeSupport = false,
  cache,
}: ExistingSourceOptions): string | undefined =>
  candidatePaths(repoRoot, testFile, specifier, cache).find((candidate) => {
    if (!SOURCE_FILE.test(candidate) || TEST_FILE.test(candidate)) {
      return false;
    }
    if (!cachedIsFile(candidate, cache)) {
      return false;
    }
    const relative = repoRelativePath(repoRoot, candidate);
    // A support module is a subject when its own colocated test exercises it;
    // importing unrelated fixtures still does not establish reachability.
    return (
      includeSupport ||
      !TEST_SUPPORT.test(relative) ||
      candidate.replace(/\.[cm]?[jt]sx?$/u, "") ===
        path.resolve(
          repoRoot,
          testFile.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, ""),
        )
    );
  });

const namedImports = (node: ts.ImportDeclaration): string[] => {
  if (node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return [];
  }
  const names: string[] = [];
  if (node.importClause?.name) {
    names.push(node.importClause.name.text);
  }
  const bindings = node.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        names.push(element.name.text);
      }
    }
  } else if (bindings && ts.isNamespaceImport(bindings)) {
    names.push(bindings.name.text);
  }
  return names;
};

const importedBinding = (
  node: ts.ImportDeclaration,
  name: string,
): ts.Identifier | undefined => {
  if (node.importClause?.name?.text === name) {
    return node.importClause.name;
  }
  const bindings = node.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    return bindings.elements.find((element) => element.name.text === name)
      ?.name;
  }
  return bindings?.name;
};

const isTypePosition = (node: ts.Identifier): boolean => {
  for (
    let current: ts.Node = node;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    if (ts.isExpression(current) && current !== node) {
      return false;
    }
  }
  return false;
};

const TEST_ENTRY_POINTS = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "it",
  "test",
]);

const calledIdentifier = (
  node: ts.CallExpression,
): ts.Identifier | undefined =>
  ts.isIdentifier(node.expression) ? node.expression : undefined;

const entryPointName = (node: ts.Expression): string | undefined => {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return entryPointName(node.expression);
  }
  if (ts.isCallExpression(node)) {
    return entryPointName(node.expression);
  }
  return undefined;
};

// The name in `const helper = ...` or `function helper()` declares the
// helper; only a reference elsewhere can make its body run.
const isDeclarationName = (node: ts.Identifier): boolean =>
  ((ts.isVariableDeclaration(node.parent) ||
    ts.isFunctionDeclaration(node.parent) ||
    ts.isBindingElement(node.parent)) &&
    node.parent.name === node) ||
  (ts.isBindingElement(node.parent) && node.parent.propertyName === node);

type SymbolMap = ReadonlyMap<ts.Identifier, CompilerSymbol | undefined>;

const isNonBindingIdentifier = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  ) {
    return true;
  }
  return isTypePosition(node);
};

const runtimeRoots = async (
  source: ts.SourceFile,
  checker: Checker,
  entryNames?: ReadonlySet<string>,
): Promise<{ roots: ts.Node[]; symbolsByIdentifier: SymbolMap }> => {
  const identifiers: ts.Identifier[] = [];
  const localDeclTargets: { name: ts.Identifier; target: ts.Node }[] = [];
  const collectIdentifiers = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (!isNonBindingIdentifier(node)) {
        identifiers.push(node);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      localDeclTargets.push({ name: node.name, target: node.body });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      if (
        ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)
      ) {
        localDeclTargets.push({
          name: node.name,
          target: node.initializer.body,
        });
      } else if (ts.isSourceFile(node.parent.parent.parent)) {
        localDeclTargets.push({ name: node.name, target: node.initializer });
      }
    } else if (
      ts.isBindingElement(node) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      const variable = node.parent.parent;
      if (
        ts.isVariableDeclaration(variable) &&
        variable.initializer &&
        ts.isSourceFile(variable.parent.parent.parent)
      ) {
        localDeclTargets.push({
          name: node.name,
          target: variable.initializer,
        });
      }
    }
    node.forEachChild(collectIdentifiers);
  };
  collectIdentifiers(source);
  const identifierSymbols =
    identifiers.length > 0
      ? await checker.getSymbolAtLocation(identifiers)
      : [];
  const symbolsByIdentifier = new Map(
    identifiers.map(
      (identifier, index) => [identifier, identifierSymbols.at(index)] as const,
    ),
  );
  const targetsBySymbol = new Map<CompilerSymbol, ts.Node[]>();
  for (const { name, target } of localDeclTargets) {
    const symbol = symbolsByIdentifier.get(name);
    if (symbol === undefined) {
      continue;
    }
    const existing = targetsBySymbol.get(symbol);
    if (existing === undefined) {
      targetsBySymbol.set(symbol, [target]);
    } else {
      existing.push(target);
    }
  }
  const roots: ts.Node[] = [];
  const queuedNodes = new Set<ts.Node>();
  const queuedSymbols = new Set<CompilerSymbol>();
  const queue: ts.Node[] = [];

  const enqueueNode = (node: ts.Node): void => {
    if (!queuedNodes.has(node)) {
      queuedNodes.add(node);
      queue.push(node);
    }
  };

  const enqueueFunction = async (node: ts.Node) => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      enqueueNode(node.body);
      return;
    }
    if (ts.isIdentifier(node)) {
      // `return { refresh }` hands the local helper out, not a new property.
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? await checker.getShorthandAssignmentValueSymbol(node.parent)
        : symbolsByIdentifier.get(node);
      if (symbol === undefined || queuedSymbols.has(symbol)) {
        return;
      }
      queuedSymbols.add(symbol);
      for (const target of targetsBySymbol.get(symbol) ?? []) {
        enqueueNode(target);
      }
    }
  };

  const findEntries = async (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = entryPointName(node.expression);
      if (name && TEST_ENTRY_POINTS.has(name)) {
        enqueueNode(node);
        for (const argument of node.arguments) {
          await enqueueFunction(argument);
        }
      }
    }
    await visitChildren(node, findEntries);
  };
  if (entryNames === undefined) {
    await findEntries(source);
  } else {
    for (const statement of source.statements) {
      if (
        !(
          ts.isFunctionDeclaration(statement) ||
          ts.isVariableStatement(statement)
        ) ||
        !statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        continue;
      }
      const names = ts.isFunctionDeclaration(statement)
        ? [statement.name]
        : statement.declarationList.declarations.map(({ name }) => name);
      for (const name of names) {
        if (name && ts.isIdentifier(name) && entryNames.has(name.text)) {
          await enqueueFunction(name);
        }
      }
    }
  }
  for (const statement of entryNames === undefined ? source.statements : []) {
    if (!ts.isExpressionStatement(statement)) {
      continue;
    }
    const expression = ts.isAwaitExpression(statement.expression)
      ? statement.expression.expression
      : statement.expression;
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text.startsWith("register")
    ) {
      enqueueNode(expression);
    }
  }

  while (queue.length > 0) {
    const root = queue.shift();
    if (root === undefined) {
      return panic("Runtime reachability queue lost an entry");
    }
    roots.push(root);
    const visitCalls = async (node: ts.Node) => {
      if (node !== root && isDeclaredHelper(node)) {
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = calledIdentifier(node);
        if (callee) {
          await enqueueFunction(callee);
        }
      }
      if (
        ts.isIdentifier(node) &&
        !isTypePosition(node) &&
        !isDeclarationName(node)
      ) {
        await enqueueFunction(node);
      }
      await visitChildren(node, visitCalls);
    };
    await visitCalls(root);
  }
  return { roots, symbolsByIdentifier };
};

// A helper declared inside a reachable body runs only when called; calls make
// its body a root of its own. Inline callbacks passed as arguments stay counted.
const isDeclaredHelper = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  (ts.isFunctionLikeDeclaration(node) &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node);

const visitRuntime = (root: ts.Node, visit: (node: ts.Node) => void) => {
  const walk = (node: ts.Node) => {
    if (node !== root && isDeclaredHelper(node)) {
      return;
    }
    visit(node);
    node.forEachChild(walk);
  };
  walk(root);
};

// Source text of the reachable code only, so pattern categories (spawn,
// build, file reads) cannot match a helper that never runs.
const runtimeText = (
  roots: readonly ts.Node[],
  source: ts.SourceFile,
): string => {
  const parts: string[] = [];
  for (const root of roots) {
    let cursor = root.getStart(source);
    const end = root.getEnd();
    const skip = (node: ts.Node): void => {
      if (node !== root && isDeclaredHelper(node)) {
        parts.push(source.text.slice(cursor, node.getStart(source)));
        cursor = node.getEnd();
        return;
      }
      node.forEachChild(skip);
    };
    skip(root);
    parts.push(source.text.slice(cursor, end));
  }
  return parts.join("\n");
};

const runtimeSymbols = (
  roots: readonly ts.Node[],
  symbolsByIdentifier: SymbolMap,
) => {
  const symbols = new Set<CompilerSymbol>();
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      !isTypePosition(node) &&
      !isDeclarationName(node) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isImportClause(node.parent) &&
      !ts.isNamespaceImport(node.parent)
    ) {
      const symbol = symbolsByIdentifier.get(node);
      if (symbol !== undefined) {
        symbols.add(symbol);
      }
    }
  };
  for (const root of roots) {
    visitRuntime(root, visit);
  }
  return symbols;
};

const invokedRuntimeSymbols = (
  roots: readonly ts.Node[],
  symbolsByIdentifier: SymbolMap,
) => {
  const symbols = new Set<CompilerSymbol>();
  const record = (identifier: ts.Identifier) => {
    const symbol = symbolsByIdentifier.get(identifier);
    if (symbol !== undefined) {
      symbols.add(symbol);
    }
  };
  for (const root of roots) {
    visitRuntime(root, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }
      const callee = calledIdentifier(node);
      if (callee) {
        record(callee);
      }
      const entry = entryPointName(node.expression);
      if (entry && TEST_ENTRY_POINTS.has(entry)) {
        for (const argument of node.arguments) {
          if (ts.isIdentifier(argument)) {
            record(argument);
          }
        }
      }
    });
  }
  return symbols;
};

const includesRuntimeBinding = (
  usedSymbols: ReadonlySet<CompilerSymbol>,
  bindings: ReadonlySet<CompilerSymbol>,
): boolean => {
  for (const binding of bindings) {
    if (usedSymbols.has(binding)) {
      return true;
    }
  }
  return false;
};

type NamedCategoryOptions = {
  file: string;
  fileText: string;
  // Pattern categories match only code that runs; see `runtimeText`.
  reachableText: string;
};

const namedCategory = ({
  file,
  fileText,
  reachableText: text,
}: NamedCategoryOptions): ReachabilityCategory | undefined => {
  if (/\b(?:lint|run)SingleRule\s*\(/u.test(text)) {
    return "source-factory";
  }
  if (
    /(?:^|\/)(?:e2e|playwright)(?:\/|[.-])/u.test(file) ||
    /["']@playwright\/test["']/u.test(fileText)
  ) {
    return "e2e-surface";
  }
  if (/(?:Bun\.spawn|spawnSync|execFile|execa)\s*\(/u.test(text)) {
    return "spawned-entry";
  }
  if (/\bBun\.build\s*\(/u.test(text)) {
    return "bundled-entry";
  }
  if (
    /readFile(?:Sync)?\s*\([^)]*\.(?:sql|schema)["'`]/su.test(text) ||
    /(?:drizzle|migration|schema)[^\n]*(?:readFile|glob)/iu.test(text) ||
    // A migrated test database runs the committed schema itself.
    (/\bcreateTestPglite\s*\(/u.test(text) &&
      /\.(?:query|exec)\s*\(/u.test(text))
  ) {
    return "sql-or-schema-reader";
  }
  if (
    /(?:\.github\/workflows|artifacts?\/|workflow)[^\n]*(?:readFile|Bun\.file|parse)/iu.test(
      text,
    )
  ) {
    return "artifact-or-workflow-guard";
  }
  if (/(?:readFile(?:Sync)?|Bun\.file|globSync|git\W+show)\s*\(/u.test(text)) {
    return "repository-text-guard";
  }
  return undefined;
};

type SiblingExportOptions = {
  repoRoot: string;
  testFile: string;
  sourceFor: (
    filename: string,
  ) => ts.SourceFile | undefined | Promise<ts.SourceFile | undefined>;
  parser: API;
};

const siblingExportNames = async ({
  repoRoot,
  testFile,
  sourceFor,
  parser,
}: SiblingExportOptions) => {
  const stem = testFile.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, "");
  const names = new Set<string>();
  for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
    const candidate = path.join(repoRoot, `${stem}${extension}`);
    if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      continue;
    }
    const source =
      (await sourceFor(candidate)) ??
      (
        await parser.createSourceFile(
          candidate,
          readFileSync(candidate, "utf-8"),
        )
      ).sourceFile;
    for (const statement of source.statements) {
      if (!(
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isVariableStatement(statement)
      )) {
        continue;
      }
      if (
        !statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        continue;
      }
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        names.add(statement.name.text);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            names.add(declaration.name.text);
          }
        }
      }
    }
  }
  return names;
};

type SupportSubject = { file: string; imported: string };

type ImportReachability = {
  supportSubjects: SupportSubject[];
  hasFactory: boolean;
  importedRuntimeBindings: Set<CompilerSymbol>;
  patchedDependencyBindings: Set<CompilerSymbol>;
  reachesSourceFileIndex: boolean;
  reachedSiblingExports: Set<string>;
};

const SOURCE_FILE_INDEX_OWNER = "packages/scripts/src/source-file-index";

type ImportReachabilityOptions = {
  repoRoot: string;
  file: string;
  source: ts.SourceFile;
  symbolsByIdentifier: SymbolMap;
  usedSymbols: ReadonlySet<CompilerSymbol>;
  invokedSymbols: ReadonlySet<CompilerSymbol>;
  patchedPackages: ReadonlySet<string>;
  cache?: ResolutionCache | undefined;
};

// The repository owns the behaviour its committed dependency patches add, so a
// test that drives a patched package reaches repository code.
const patchedPackageNames = (repoRoot: string): ReadonlySet<string> => {
  const manifestPath = path.join(repoRoot, "package.json");
  if (!existsSync(manifestPath)) {
    return new Set();
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const patched =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "patchedDependencies")
      : undefined;
  if (typeof patched !== "object" || patched === null) {
    return new Set();
  }
  return new Set(
    Object.keys(patched).map((key) => {
      const versionAt = key.lastIndexOf("@");
      return versionAt > 0 ? key.slice(0, versionAt) : key;
    }),
  );
};

const packageNameOf = (specifier: string): string => {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments.at(0) ?? specifier);
};

type DynamicImport = {
  specifier: string;
  bindings: readonly { symbol: CompilerSymbol; imported: string }[];
};

// Destructured imports may initialize a subject inside a test or its helpers.
const dynamicImport = (
  declaration: ts.VariableDeclaration,
  symbolsByIdentifier: SymbolMap,
): DynamicImport | undefined => {
  const awaited = declaration.initializer;
  const imported =
    awaited && ts.isAwaitExpression(awaited) ? awaited.expression : awaited;
  if (
    !ts.isObjectBindingPattern(declaration.name) ||
    !imported ||
    !ts.isCallExpression(imported) ||
    imported.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    imported.arguments.length !== 1
  ) {
    return undefined;
  }
  const specifier = imported.arguments.at(0);
  if (!specifier || !ts.isStringLiteral(specifier)) {
    return undefined;
  }
  const bindingElements = declaration.name.elements.filter(
    (element): element is ts.BindingElement & { name: ts.Identifier } =>
      element.name !== undefined && ts.isIdentifier(element.name),
  );
  const bindings = [];
  for (const element of bindingElements) {
    const symbol = symbolsByIdentifier.get(element.name);
    const exportName = element.propertyName ?? element.name;
    if (symbol && ts.isIdentifier(exportName)) {
      bindings.push({ symbol, imported: exportName.text });
    }
  }
  return { specifier: specifier.text, bindings };
};

type SymbolLookup = (
  node: ts.Identifier | undefined,
) => CompilerSymbol | undefined;

const reachedNamedImports = (
  statement: ts.ImportDeclaration,
  symbolOf: SymbolLookup,
  usedSymbols: ReadonlySet<CompilerSymbol>,
): string[] => {
  const clause = statement.importClause;
  const bindings = clause?.namedBindings;
  if (
    !clause ||
    clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    !bindings ||
    !ts.isNamedImports(bindings)
  ) {
    return [];
  }
  const names: string[] = [];
  for (const element of bindings.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const symbol = symbolOf(element.name);
    if (symbol && usedSymbols.has(symbol)) {
      names.push(element.propertyName?.text ?? element.name.text);
    }
  }
  return names;
};

const resolveImportSymbols =
  (symbolsByIdentifier: SymbolMap): SymbolLookup =>
  (node) =>
    node ? symbolsByIdentifier.get(node) : undefined;

const collectDynamicImportCandidates = (
  source: ts.SourceFile,
): ts.VariableDeclaration[] => {
  const candidates: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      candidates.push(node);
    }
    for (const child of node.childrenIter()) {
      visit(child);
    }
  };
  visit(source);
  return candidates;
};

const recordDynamicImportReachability = ({
  repoRoot,
  file,
  source,
  symbolsByIdentifier,
  usedSymbols,
  invokedSymbols,
  patchedPackages,
  cache,
  siblingStem,
  supportSubjects,
  importedRuntimeBindings,
  patchedDependencyBindings,
  reachedSiblingExports,
}: ImportReachabilityOptions & {
  siblingStem: string;
  supportSubjects: SupportSubject[];
  importedRuntimeBindings: Set<CompilerSymbol>;
  patchedDependencyBindings: Set<CompilerSymbol>;
  reachedSiblingExports: Set<string>;
}): void => {
  for (const candidate of collectDynamicImportCandidates(source)) {
    const dynamic = dynamicImport(candidate, symbolsByIdentifier);
    if (!dynamic) {
      continue;
    }
    const resolved = existingSource({
      repoRoot,
      testFile: file,
      specifier: dynamic.specifier,
      cache,
    });
    const support =
      resolved === undefined
        ? existingSource({
            repoRoot,
            testFile: file,
            specifier: dynamic.specifier,
            includeSupport: true,
            cache,
          })
        : undefined;
    for (const { symbol, imported } of dynamic.bindings) {
      if (patchedPackages.has(packageNameOf(dynamic.specifier))) {
        patchedDependencyBindings.add(symbol);
      } else if (support && invokedSymbols.has(symbol)) {
        supportSubjects.push({ file: support, imported });
      } else if (resolved) {
        importedRuntimeBindings.add(symbol);
        if (
          usedSymbols.has(symbol) &&
          resolved.replace(/\.[cm]?[jt]sx?$/u, "") === siblingStem
        ) {
          reachedSiblingExports.add(imported);
        }
      }
    }
  }
};

const importReachability = ({
  repoRoot,
  file,
  source,
  symbolsByIdentifier,
  usedSymbols,
  invokedSymbols,
  patchedPackages,
  cache,
}: ImportReachabilityOptions): ImportReachability => {
  const supportSubjects: SupportSubject[] = [];
  const importedRuntimeBindings = new Set<CompilerSymbol>();
  const patchedDependencyBindings = new Set<CompilerSymbol>();
  const reachedSiblingExports = new Set<string>();
  const siblingStem = path.resolve(
    repoRoot,
    file.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, ""),
  );
  let hasFactory = false;
  let reachesSourceFileIndex = false;
  recordDynamicImportReachability({
    repoRoot,
    file,
    source,
    symbolsByIdentifier,
    usedSymbols,
    invokedSymbols,
    patchedPackages,
    siblingStem,
    supportSubjects,
    importedRuntimeBindings,
    patchedDependencyBindings,
    reachedSiblingExports,
  });
  const importStatements = source.statements.filter(
    (
      statement,
    ): statement is ts.ImportDeclaration & {
      moduleSpecifier: ts.StringLiteral;
    } =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier),
  );
  const symbolOf = resolveImportSymbols(symbolsByIdentifier);
  for (const statement of importStatements) {
    if (patchedPackages.has(packageNameOf(statement.moduleSpecifier.text))) {
      for (const name of namedImports(statement)) {
        const symbol = symbolOf(importedBinding(statement, name));
        if (symbol) {
          patchedDependencyBindings.add(symbol);
        }
      }
      continue;
    }
    const resolvedSource = existingSource({
      repoRoot,
      testFile: file,
      specifier: statement.moduleSpecifier.text,
      cache,
    });
    if (!resolvedSource) {
      const support = existingSource({
        repoRoot,
        testFile: file,
        specifier: statement.moduleSpecifier.text,
        includeSupport: true,
        cache,
      });
      if (support) {
        for (const imported of reachedNamedImports(
          statement,
          symbolOf,
          invokedSymbols,
        )) {
          supportSubjects.push({ file: support, imported });
        }
      }
      continue;
    }
    for (const name of namedImports(statement)) {
      const symbol = symbolOf(importedBinding(statement, name));
      if (symbol) {
        importedRuntimeBindings.add(symbol);
        const owner = resolvedSource
          .replaceAll(path.sep, "/")
          .replace(/\.[cm]?[jt]sx?$/u, "");
        if (
          owner.endsWith(SOURCE_FILE_INDEX_OWNER) &&
          usedSymbols.has(symbol)
        ) {
          reachesSourceFileIndex = true;
        }
      }
      if (/^(?:create|build|make)|Factory$/u.test(name)) {
        hasFactory = true;
      }
    }
    if (resolvedSource.replace(/\.[cm]?[jt]sx?$/u, "") !== siblingStem) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const symbol = symbolOf(element.name);
      if (symbol && usedSymbols.has(symbol)) {
        reachedSiblingExports.add(
          element.propertyName?.text ?? element.name.text,
        );
      }
    }
  }
  return {
    supportSubjects,
    hasFactory,
    importedRuntimeBindings,
    patchedDependencyBindings,
    reachesSourceFileIndex,
    reachedSiblingExports,
  };
};

type LocalCollisionOptions = {
  repoRoot: string;
  file: string;
  source: ts.SourceFile;
  reachedSiblingExports: ReadonlySet<string>;
  sourceFor: (
    filename: string,
  ) => ts.SourceFile | undefined | Promise<ts.SourceFile | undefined>;
  parser: API;
};

const localCollisionFindings = async ({
  repoRoot,
  file,
  source,
  reachedSiblingExports,
  sourceFor,
  parser,
}: LocalCollisionOptions): Promise<ReachabilityFinding[]> => {
  const candidateNames: string[] = [];
  const addCandidate = (name: string): void => {
    if (!/fixture/iu.test(name) && !reachedSiblingExports.has(name)) {
      candidateNames.push(name);
    }
  };
  for (const statement of source.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      addCandidate(statement.name.text);
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        addCandidate(declaration.name.text);
      }
    }
  }
  if (candidateNames.length === 0) {
    return [];
  }
  const siblingNames = await siblingExportNames({
    repoRoot,
    testFile: file,
    sourceFor,
    parser,
  });
  const findings: ReachabilityFinding[] = [];
  for (const name of candidateNames) {
    if (siblingNames.has(name)) {
      findings.push({ file, kind: "local-export-collision", name });
    }
  }
  return findings;
};

// Include support modules as compiler roots even when their application's alias
// is not part of this repository-wide program. Discovery alone never grants
// reachability: only the imported export's invoked body is inspected below.
const supportSourceRoots = (
  repoRoot: string,
  files: readonly string[],
  cache?: ResolutionCache,
): string[] => {
  const discovered = new Set<string>();
  const queue = [...files];
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  for (const file of queue) {
    const text = readFileSync(path.resolve(repoRoot, file), "utf-8");
    const transpiler = file.endsWith("x") ? transpilers.tsx : transpilers.ts;
    for (const { path: specifier } of transpiler.scanImports(
      text.replace(/^#![^\n]*\n/u, ""),
    )) {
      const resolved = existingSource({
        repoRoot,
        testFile: file,
        specifier,
        includeSupport: true,
        cache,
      });
      if (
        !resolved ||
        resolved.endsWith(".json") ||
        discovered.has(resolved) ||
        !TEST_SUPPORT.test(repoRelativePath(repoRoot, resolved))
      ) {
        continue;
      }
      discovered.add(resolved);
      queue.push(repoRelativePath(repoRoot, resolved));
    }
  }
  return [...discovered];
};

const classifyFileReachability = async ({
  file,
  text,
  reachableRuntime,
  source,
  usedSymbols,
  imports,
  supportReachesSubject,
}: {
  file: string;
  text: string;
  reachableRuntime: readonly ts.Node[];
  source: ts.SourceFile;
  usedSymbols: ReadonlySet<CompilerSymbol>;
  imports: ImportReachability;
  supportReachesSubject: (
    subjects: readonly SupportSubject[],
  ) => Promise<boolean>;
}): Promise<ReachabilityFinding | undefined> => {
  let category = namedCategory({
    file,
    fileText: text,
    reachableText: runtimeText(reachableRuntime, source),
  });
  if (imports.reachesSourceFileIndex) {
    category = "repository-text-guard";
  } else if (
    includesRuntimeBinding(usedSymbols, imports.importedRuntimeBindings)
  ) {
    category = imports.hasFactory
      ? "source-factory"
      : "imported-source-subject";
  } else if (
    !category &&
    includesRuntimeBinding(usedSymbols, imports.patchedDependencyBindings)
  ) {
    category = "patched-dependency-subject";
  }
  if (!category && (await supportReachesSubject(imports.supportSubjects))) {
    category = "source-factory";
  }
  if (category) {
    return undefined;
  }
  let attempted: readonly ReachabilityCategory[] = REACHABILITY_CATEGORIES;
  if (imports.hasFactory) {
    attempted = ["source-factory"];
  } else if (imports.importedRuntimeBindings.size > 0) {
    attempted = ["imported-source-subject"];
  }
  return { file, kind: "no-classified-reachability", attempted };
};

// Chunking large repositories bounds peak memory by closing each tsrs
// project and releasing its AST/symbol proxies between batches.
const PROGRAM_BATCH_SIZE = 1500;

type AnalyzeBatchOptions = {
  repoRoot: string;
  batchFiles: readonly string[];
  siblingSource: AnalyzeOptions["siblingSource"];
  cache: ResolutionCache;
  patchedPackages: ReadonlySet<string>;
  resolvedSupportCache: Map<string, boolean>;
  parser: API;
  findings: ReachabilityFinding[];
};

const analyzeReachabilityBatch = async ({
  repoRoot,
  batchFiles,
  siblingSource,
  cache,
  patchedPackages,
  resolvedSupportCache,
  parser,
  findings,
}: AnalyzeBatchOptions): Promise<void> => {
  const opened = await createProgram({
    rootNames: [
      ...batchFiles.map((file) => path.join(repoRoot, file)),
      ...supportSourceRoots(repoRoot, batchFiles, cache),
    ],
    compilerOptions: {
      allowJs: true,
      jsx: "preserve",
      moduleResolution: "bundler",
      noResolve: true,
      noLib: true,
      types: [],
    },
  });
  try {
    const { program, checker } = opened;
    // The compiler's resolution-aware index already owns imported siblings.
    // Keep reuse inside this scan so changed sources/resolution cannot go stale.
    const sourceFor =
      siblingSource ??
      (async (filename: string) => await program.getSourceFile(filename));
    const supportCache = new Map<string, Promise<boolean>>();
    const supportReachesSubject = async (
      subjects: readonly SupportSubject[],
      visited = new Set<string>(),
    ): Promise<boolean> => {
      for (const subject of subjects) {
        const key = `${subject.file}:${subject.imported}`;
        if (visited.has(key)) {
          continue;
        }
        if (visited.size === 0) {
          const crossBatch = resolvedSupportCache.get(key);
          if (crossBatch !== undefined) {
            if (crossBatch) {
              return true;
            }
            continue;
          }
          const cached = supportCache.get(key);
          if (cached !== undefined) {
            if (await cached) {
              return true;
            }
            continue;
          }
        }
        const evaluate = async (): Promise<boolean> => {
          const nextVisited = new Set(visited);
          nextVisited.add(key);
          const source = await program.getSourceFile(subject.file);
          if (!source) {
            panic(`Could not inspect test support ${subject.file}`);
          }
          const { roots, symbolsByIdentifier } = await runtimeRoots(
            source,
            checker,
            new Set([subject.imported]),
          );
          const usedSymbols = runtimeSymbols(roots, symbolsByIdentifier);
          const invokedSymbols = invokedRuntimeSymbols(
            roots,
            symbolsByIdentifier,
          );
          const file = repoRelativePath(repoRoot, subject.file);
          const imports = importReachability({
            repoRoot,
            file,
            source,
            symbolsByIdentifier,
            usedSymbols,
            invokedSymbols,
            patchedPackages,
            cache,
          });
          return Boolean(
            namedCategory({
              file,
              fileText: source.text,
              reachableText: runtimeText(roots, source),
            }) ||
            includesRuntimeBinding(
              usedSymbols,
              imports.importedRuntimeBindings,
            ) ||
            includesRuntimeBinding(
              usedSymbols,
              imports.patchedDependencyBindings,
            ) ||
            (await supportReachesSubject(imports.supportSubjects, nextVisited)),
          );
        };
        const pending = evaluate();
        if (visited.size === 0) {
          supportCache.set(key, pending);
        }
        const reached = await pending;
        if (visited.size === 0) {
          resolvedSupportCache.set(key, reached);
        }
        if (reached) {
          return true;
        }
      }
      return false;
    };
    const analyzeFile = async (file: string): Promise<void> => {
      const absolute = path.join(repoRoot, file);
      const source =
        (await program.getSourceFile(absolute)) ??
        panic(`Could not parse ${file}`);
      const text = source.text;
      const { roots: reachableRuntime, symbolsByIdentifier } =
        await runtimeRoots(source, checker);
      const usedSymbols = runtimeSymbols(reachableRuntime, symbolsByIdentifier);
      const invokedSymbols = invokedRuntimeSymbols(
        reachableRuntime,
        symbolsByIdentifier,
      );
      const imports = importReachability({
        repoRoot,
        file,
        source,
        symbolsByIdentifier,
        usedSymbols,
        invokedSymbols,
        patchedPackages,
        cache,
      });
      const reachabilityFinding = await classifyFileReachability({
        file,
        text,
        reachableRuntime,
        source,
        usedSymbols,
        imports,
        supportReachesSubject,
      });
      if (reachabilityFinding !== undefined) {
        findings.push(reachabilityFinding);
      }
      const { reachedSiblingExports } = imports;

      findings.push(
        ...(await localCollisionFindings({
          repoRoot,
          file,
          source,
          reachedSiblingExports,
          sourceFor,
          parser,
        })),
      );
    };
    const CONCURRENCY = 8;
    let cursor = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, batchFiles.length) },
        async () => {
          while (cursor < batchFiles.length) {
            const index = cursor;
            cursor += 1;
            const file = batchFiles.at(index);
            if (file !== undefined) {
              await analyzeFile(file);
            }
          }
        },
      ),
    );
  } finally {
    await opened.close();
  }
};

export const analyzeTestSubjectReachability = async ({
  repoRoot,
  files = trackedTests(repoRoot),
  siblingSource,
}: AnalyzeOptions): Promise<ReachabilityFinding[]> => {
  const testFiles = files.filter(isReachabilityTest);
  const findings: ReachabilityFinding[] = [];
  const cache = createResolutionCache();
  const patchedPackages = patchedPackageNames(repoRoot);
  const resolvedSupportCache = new Map<string, boolean>();
  const parser = new API({ cwd: repoRoot });
  try {
    for (
      let batchStart = 0;
      batchStart < testFiles.length ||
      (batchStart === 0 && testFiles.length === 0);
      batchStart += PROGRAM_BATCH_SIZE
    ) {
      const batchFiles = testFiles.slice(
        batchStart,
        batchStart + PROGRAM_BATCH_SIZE,
      );
      await analyzeReachabilityBatch({
        repoRoot,
        batchFiles,
        siblingSource,
        cache,
        patchedPackages,
        resolvedSupportCache,
        parser,
        findings,
      });
      if (batchFiles.length < PROGRAM_BATCH_SIZE) {
        break;
      }
    }
    return findings.toSorted((left, right) => {
      const leftKey = `${left.file}:${left.kind}:${left.name ?? ""}`;
      const rightKey = `${right.file}:${right.kind}:${right.name ?? ""}`;
      return compareCodeUnit(leftKey, rightKey);
    });
  } finally {
    await parser.close();
  }
};

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  if (process.argv.includes("--self-test")) {
    const result = Bun.spawnSync(
      // CI runs this beside other checks; the slowest fixture test took
      // 6.4 s there, so allow about 2.5 times that instead of Bun's 5 s.
      [
        "bun",
        "test",
        "--timeout",
        "15000",
        "scripts/test-subject-reachability.test.ts",
      ],
      {
        cwd: repoRoot,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exit(childExitStatus(result));
  }
  const findings = await analyzeTestSubjectReachability({ repoRoot });
  if (findings.length > 0) {
    const failures = findings.map((finding) => {
      const member = `${finding.kind}${finding.name ? `:${finding.name}` : ""}`;
      const attempted = finding.attempted?.join(", ") ?? "not applicable";
      return `${finding.file}: ${member} (attempted: ${attempted})`;
    });
    panic(`Test subject reachability census failed:\n${failures.join("\n")}`);
  }
}
