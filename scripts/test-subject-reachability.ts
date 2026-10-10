import { panic } from "better-result";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

export const REACHABILITY_CATEGORIES = [
  "imported-source-subject",
  "source-factory",
  "e2e-surface",
  "spawned-entry",
  "bundled-entry",
  "sql-or-schema-reader",
  "artifact-or-workflow-guard",
  "repository-text-guard",
] as const;

export type ReachabilityCategory = (typeof REACHABILITY_CATEGORIES)[number];

export type ReachabilityFinding = {
  file: string;
  kind: "no-classified-reachability" | "local-export-collision";
  name?: string;
  attempted?: readonly ReachabilityCategory[];
};

type AnalyzeOptions = { repoRoot: string; files?: readonly string[] };

export const parseReachabilityBaseline = (
  text: string,
  label: string = BASELINE_PATHS.testSubjectReachability,
): Record<string, string[]> => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return panic(`${label} must be an object`);
  }
  const entries: (readonly [string, string[]])[] = [];
  for (const [file, members] of Object.entries(parsed)) {
    if (
      !TEST_FILE.test(file) ||
      !Array.isArray(members) ||
      members.some((member) => typeof member !== "string")
    ) {
      return panic(`Invalid ${label} entry: ${file}`);
    }
    entries.push([file, members]);
  }
  return Object.fromEntries(entries);
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_SUPPORT =
  /(?:^|\/)(?:__tests__|test|tests|fixtures?|mocks?|test-utils?)(?:\/|[.-])/u;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;

const parse = (file: string, text: string) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const trackedTests = (repoRoot: string): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic(`Could not enumerate tests: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => TEST_FILE.test(file));
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
const workspacePackageTarget = (
  packageRoot: string,
  subpath: string,
): string | undefined => {
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest: unknown = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf-8"))
    : undefined;
  const exportsMap: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "exports")
      : undefined;
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
    const rootKind = statSync(
      path.join(repoRoot, "packages", packageName, "package.json"),
      { throwIfNoEntry: false },
    )?.isFile()
      ? "packages"
      : "apps";
    unresolved = workspacePackageTarget(
      path.join(repoRoot, rootKind, packageName),
      rest.join("/"),
    );
  }
  if (!unresolved) {
    return [];
  }
  return [
    unresolved,
    ...[".ts", ".tsx", ".mts", ".cts"].map(
      (extension) => `${unresolved}${extension}`,
    ),
    ...["index.ts", "index.tsx"].map((name) => path.join(unresolved, name)),
  ];
};

const existingSource = (
  repoRoot: string,
  testFile: string,
  specifier: string,
): string | undefined =>
  candidatePaths(repoRoot, testFile, specifier).find((candidate) => {
    const relative = path
      .relative(repoRoot, candidate)
      .replaceAll(path.sep, "/");
    return (
      SOURCE_FILE.test(candidate) &&
      !TEST_FILE.test(candidate) &&
      !TEST_SUPPORT.test(relative) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
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
  (ts.isVariableDeclaration(node.parent) ||
    ts.isFunctionDeclaration(node.parent)) &&
  node.parent.name === node;

const runtimeRoots = (
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): readonly ts.Node[] => {
  const roots: ts.Node[] = [];
  const queuedNodes = new Set<ts.Node>();
  const queuedSymbols = new Set<ts.Symbol>();
  const queue: ts.Node[] = [];

  const enqueueNode = (node: ts.Node): void => {
    if (!queuedNodes.has(node)) {
      queuedNodes.add(node);
      queue.push(node);
    }
  };

  const enqueueFunction = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      enqueueNode(node.body);
      return;
    }
    if (ts.isIdentifier(node)) {
      // `return { refresh }` hands the local helper out, not a new property.
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol === undefined || queuedSymbols.has(symbol)) {
        return;
      }
      queuedSymbols.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (declaration.getSourceFile() !== source) {
          continue;
        }
        if (ts.isFunctionDeclaration(declaration) && declaration.body) {
          enqueueNode(declaration.body);
        }
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          if (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)
          ) {
            enqueueNode(declaration.initializer.body);
            continue;
          }
          if (ts.isSourceFile(declaration.parent.parent.parent)) {
            enqueueNode(declaration.initializer);
          }
        }
        if (ts.isBindingElement(declaration)) {
          const variable = declaration.parent.parent;
          if (
            ts.isVariableDeclaration(variable) &&
            variable.initializer &&
            ts.isSourceFile(variable.parent.parent.parent)
          ) {
            enqueueNode(variable.initializer);
          }
        }
      }
    }
  };

  const findEntries = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = entryPointName(node.expression);
      if (name && TEST_ENTRY_POINTS.has(name)) {
        for (const argument of node.arguments) {
          enqueueFunction(argument);
        }
      }
    }
    ts.forEachChild(node, findEntries);
  };
  findEntries(source);
  for (const statement of source.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text.startsWith("register")
    ) {
      enqueueNode(statement.expression);
    }
  }

  while (queue.length > 0) {
    const root = queue.shift();
    if (root === undefined) {
      return panic("Runtime reachability queue lost an entry");
    }
    roots.push(root);
    const visitCalls = (node: ts.Node): void => {
      if (node !== root && isDeclaredHelper(node)) {
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = calledIdentifier(node);
        if (callee) {
          enqueueFunction(callee);
        }
      }
      if (
        ts.isIdentifier(node) &&
        !isTypePosition(node) &&
        !isDeclarationName(node)
      ) {
        enqueueFunction(node);
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(root);
  }
  return roots;
};

// A helper declared inside a reachable body runs only when called; calls make
// its body a root of its own. Inline callbacks passed as arguments stay counted.
const isDeclaredHelper = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  (ts.isFunctionLike(node) &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node);

const visitRuntime = (root: ts.Node, visit: (node: ts.Node) => void): void => {
  const walk = (node: ts.Node): void => {
    if (node !== root && isDeclaredHelper(node)) {
      return;
    }
    visit(node);
    ts.forEachChild(node, walk);
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
      ts.forEachChild(node, skip);
    };
    skip(root);
    parts.push(source.text.slice(cursor, end));
  }
  return parts.join("\n");
};

const runtimeSymbols = (
  roots: readonly ts.Node[],
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> => {
  const symbols = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isTypePosition(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (
        symbol !== undefined &&
        !ts.isImportSpecifier(node.parent) &&
        !ts.isImportClause(node.parent) &&
        !ts.isNamespaceImport(node.parent)
      ) {
        symbols.add(symbol);
      }
    }
  };
  for (const root of roots) {
    visitRuntime(root, visit);
  }
  return symbols;
};

const includesRuntimeBinding = (
  usedSymbols: ReadonlySet<ts.Symbol>,
  bindings: ReadonlySet<ts.Symbol>,
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

const siblingExportNames = (
  repoRoot: string,
  testFile: string,
): Set<string> => {
  const stem = testFile.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, "");
  const names = new Set<string>();
  for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
    const candidate = path.join(repoRoot, `${stem}${extension}`);
    if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      continue;
    }
    const source = parse(candidate, readFileSync(candidate, "utf-8"));
    for (const statement of source.statements) {
      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
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

type ImportReachability = {
  hasFactory: boolean;
  importedRuntimeBindings: Set<ts.Symbol>;
  reachesSourceFileIndex: boolean;
  reachedSiblingExports: Set<string>;
};

const SOURCE_FILE_INDEX_OWNER = "packages/scripts/src/source-file-index";

type ImportReachabilityOptions = {
  repoRoot: string;
  file: string;
  source: ts.SourceFile;
  checker: ts.TypeChecker;
  usedSymbols: ReadonlySet<ts.Symbol>;
};

const dynamicImportBindings = (
  statement: ts.Statement,
  checker: ts.TypeChecker,
  repoRoot: string,
  file: string,
): readonly ts.Symbol[] => {
  if (
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1
  ) {
    return [];
  }
  const declaration = statement.declarationList.declarations.at(0);
  const awaited = declaration?.initializer;
  const imported =
    awaited && ts.isAwaitExpression(awaited) ? awaited.expression : awaited;
  if (
    !declaration ||
    !ts.isObjectBindingPattern(declaration.name) ||
    !imported ||
    !ts.isCallExpression(imported) ||
    imported.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    imported.arguments.length !== 1
  ) {
    return [];
  }
  const specifier = imported.arguments.at(0);
  if (
    !specifier ||
    !ts.isStringLiteral(specifier) ||
    !existingSource(repoRoot, file, specifier.text)
  ) {
    return [];
  }
  return declaration.name.elements.flatMap((element) => {
    const symbol = checker.getSymbolAtLocation(element.name);
    return symbol ? [symbol] : [];
  });
};

const importReachability = ({
  repoRoot,
  file,
  source,
  checker,
  usedSymbols,
}: ImportReachabilityOptions): ImportReachability => {
  const importedRuntimeBindings = new Set<ts.Symbol>();
  const reachedSiblingExports = new Set<string>();
  const siblingStem = path.resolve(
    repoRoot,
    file.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/u, ""),
  );
  let hasFactory = false;
  let reachesSourceFileIndex = false;
  for (const statement of source.statements) {
    for (const symbol of dynamicImportBindings(
      statement,
      checker,
      repoRoot,
      file,
    )) {
      importedRuntimeBindings.add(symbol);
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const resolvedSource = existingSource(
      repoRoot,
      file,
      statement.moduleSpecifier.text,
    );
    if (!resolvedSource) {
      continue;
    }
    for (const name of namedImports(statement)) {
      const binding = importedBinding(statement, name);
      const symbol = binding && checker.getSymbolAtLocation(binding);
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
      const symbol = checker.getSymbolAtLocation(element.name);
      if (symbol && usedSymbols.has(symbol)) {
        reachedSiblingExports.add(
          element.propertyName?.text ?? element.name.text,
        );
      }
    }
  }
  return {
    hasFactory,
    importedRuntimeBindings,
    reachesSourceFileIndex,
    reachedSiblingExports,
  };
};

const localCollisionFindings = (
  repoRoot: string,
  file: string,
  source: ts.SourceFile,
  reachedSiblingExports: ReadonlySet<string>,
): ReachabilityFinding[] => {
  const findings: ReachabilityFinding[] = [];
  const siblingNames = siblingExportNames(repoRoot, file);
  const addCollision = (name: string): void => {
    if (
      siblingNames.has(name) &&
      !/fixture/iu.test(name) &&
      !reachedSiblingExports.has(name)
    ) {
      findings.push({ file, kind: "local-export-collision", name });
    }
  };
  for (const statement of source.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      addCollision(statement.name.text);
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
        addCollision(declaration.name.text);
      }
    }
  }
  return findings;
};

export const analyzeTestSubjectReachability = ({
  repoRoot,
  files = trackedTests(repoRoot),
}: AnalyzeOptions): ReachabilityFinding[] => {
  const findings: ReachabilityFinding[] = [];
  const program = ts.createProgram(
    files.map((file) => path.join(repoRoot, file)),
    {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noResolve: false,
    },
  );
  const checker = program.getTypeChecker();
  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    const text = readFileSync(absolute, "utf-8");
    const source =
      program.getSourceFile(absolute) ?? panic(`Could not parse ${file}`);
    const reachableRuntime = runtimeRoots(source, checker);
    const usedSymbols = runtimeSymbols(reachableRuntime, checker);
    const {
      hasFactory,
      importedRuntimeBindings,
      reachesSourceFileIndex,
      reachedSiblingExports,
    } = importReachability({
      repoRoot,
      file,
      source,
      checker,
      usedSymbols,
    });
    let category = namedCategory({
      file,
      fileText: text,
      reachableText: runtimeText(reachableRuntime, source),
    });
    if (reachesSourceFileIndex) {
      category = "repository-text-guard";
    } else if (includesRuntimeBinding(usedSymbols, importedRuntimeBindings)) {
      category = hasFactory ? "source-factory" : "imported-source-subject";
    }
    if (!category) {
      let attempted: readonly ReachabilityCategory[] = REACHABILITY_CATEGORIES;
      if (hasFactory) {
        attempted = ["source-factory"];
      } else if (importedRuntimeBindings.size > 0) {
        attempted = ["imported-source-subject"];
      }
      findings.push({
        file,
        kind: "no-classified-reachability",
        attempted,
      });
    }

    findings.push(
      ...localCollisionFindings(repoRoot, file, source, reachedSiblingExports),
    );
  }
  return findings.toSorted((left, right) => {
    const leftKey = `${left.file}:${left.kind}:${left.name ?? ""}`;
    const rightKey = `${right.file}:${right.kind}:${right.name ?? ""}`;
    return compareCodeUnit(leftKey, rightKey);
  });
};

const baselineMembers = (text: string, label: string): string[] =>
  Object.entries(parseReachabilityBaseline(text, label)).flatMap(
    ([file, members]) => members.map((member) => `${file}:${member}`),
  );

export const checkReachabilityBaselineMembership = (
  repoRoot: string,
  args: readonly string[],
): number =>
  runLedgerMembershipGuard({
    ledgerRel: BASELINE_PATHS.testSubjectReachability,
    repoRoot,
    parseLedger: baselineMembers,
    label: "test subject reachability",
    remediation: "remove the new exception and make the test reach its subject",
    args,
  });

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  if (process.argv.includes("--self-test")) {
    const result = Bun.spawnSync(
      ["bun", "test", "scripts/test-subject-reachability.test.ts"],
      {
        cwd: repoRoot,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exit(childExitStatus(result));
  }
  if (!process.argv.includes("--base")) {
    panic(
      "Usage: bun scripts/test-subject-reachability.ts --self-test | --base",
    );
  }
  const membershipStatus = checkReachabilityBaselineMembership(
    repoRoot,
    process.argv.slice(2),
  );
  if (membershipStatus !== 0) {
    process.exit(membershipStatus);
  }
  const findings = analyzeTestSubjectReachability({ repoRoot });
  const baseline = parseReachabilityBaseline(
    readFileSync(
      path.join(repoRoot, "scripts/test-subject-reachability-baseline.json"),
      "utf-8",
    ),
  );
  const current = new Map<string, string[]>();
  for (const finding of findings) {
    const member = `${finding.kind}${finding.name ? `:${finding.name}` : ""}`;
    current.set(finding.file, [...(current.get(finding.file) ?? []), member]);
  }
  const failures: string[] = [];
  for (const [file, members] of current) {
    const allowed = new Set(baseline[file]);
    for (const member of members) {
      if (!allowed.has(member)) {
        const finding = findings.find(
          (candidate) =>
            candidate.file === file &&
            `${candidate.kind}${candidate.name ? `:${candidate.name}` : ""}` ===
              member,
        );
        const attempted = finding?.attempted?.join(", ") ?? "not applicable";
        failures.push(`${file}: ${member} (attempted: ${attempted})`);
      }
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const actual = new Set(current.get(file));
    for (const member of allowed) {
      if (!actual.has(member)) {
        failures.push(`${file}: remove cleaned baseline member ${member}`);
      }
    }
  }
  if (failures.length > 0) {
    panic(`Test subject reachability census failed:\n${failures.join("\n")}`);
  }
}
