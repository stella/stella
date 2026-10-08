import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

import type { FeatureRegistry } from "../../src/lib/feature-access/registry";
import { validateTaskMutationEffectOwner } from "./task-mutation-admission-declarations";

type DeclarationOptions = {
  registry: FeatureRegistry;
  endpoints: readonly { file: string; config: Record<string, unknown> }[];
  sources: ReadonlyMap<string, string>;
};
export type FeatureAccessDeclarationViolation = {
  file: string;
  message: string;
};
type Requirement = "required" | "conditional";

const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  ts
    .getModifiers(node)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
    true;
const runtimeImport = (
  node: ts.Statement,
): node is ts.ImportDeclaration & { moduleSpecifier: ts.StringLiteral } =>
  ts.isImportDeclaration(node) &&
  ts.isStringLiteral(node.moduleSpecifier) &&
  node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword;
const runtimeExport = (
  node: ts.Statement,
): node is ts.ExportDeclaration & { moduleSpecifier: ts.StringLiteral } =>
  ts.isExportDeclaration(node) &&
  !node.isTypeOnly &&
  node.moduleSpecifier !== undefined &&
  ts.isStringLiteral(node.moduleSpecifier) &&
  (node.exportClause === undefined ||
    !ts.isNamedExports(node.exportClause) ||
    node.exportClause.elements.some((element) => !element.isTypeOnly));
const declaresSymbol = (statement: ts.Statement, name: string) => {
  if (!exported(statement)) {
    return false;
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === name,
    );
  }
  return (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name?.text === name
  );
};
const moduleBase = (from: string, specifier: string) => {
  if (specifier.startsWith("@/api/")) {
    return `apps/api/src/${specifier.slice(6)}`;
  }
  if (specifier.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(from), specifier),
    );
  }
  return undefined;
};
const localSourceImport = (specifier: string) =>
  (specifier.startsWith(".") || specifier.startsWith("@/api/")) &&
  (!path.posix.extname(specifier) || /\.(?:ts|tsx|js)$/u.test(specifier));

const unwrapExpression = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isParenthesizedExpression(node)
    ? unwrapExpression(node.expression)
    : node;
// Registry references describe dispatch; each entry is checked independently.
const dispatchRegistry = (node: ts.Node) =>
  ts.isVariableDeclaration(node) &&
  ts.isIdentifier(node.name) &&
  (node.name.text === "CAPABILITY_DISPATCH" ||
    node.name.text === "SCHEDULER_TASKS") &&
  node.initializer !== undefined &&
  ts.isObjectLiteralExpression(unwrapExpression(node.initializer));
const insideDispatchRegistry = (node: ts.Node): boolean => {
  let parent = node;
  while (!ts.isSourceFile(parent)) {
    parent = parent.parent;
    if (dispatchRegistry(parent)) {
      return true;
    }
  }
  return false;
};
const runtimeReferenceIndex = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ts.Identifier[]>
>();
/**
 * Value-position identifiers by name, outside imports and type nodes. One
 * walk per parsed file; binding checks look names up instead of re-walking.
 */
const runtimeReferences = (ast: ts.SourceFile, name: string) => {
  let index = runtimeReferenceIndex.get(ast);
  if (index === undefined) {
    const references = new Map<string, ts.Identifier[]>();
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) {
        return;
      }
      if (ts.isIdentifier(node)) {
        const named = references.get(node.text) ?? [];
        named.push(node);
        references.set(node.text, named);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    index = references;
    runtimeReferenceIndex.set(ast, index);
  }
  return index.get(name) ?? [];
};
const dispatchRegistrationOnly = (ast: ts.SourceFile, name: string) => {
  const references = runtimeReferences(ast, name);
  return references.length > 0 && references.every(insideDispatchRegistry);
};
const literalProperty = (node: ts.Expression, name: string) => {
  const value = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(value)) {
    return undefined;
  }
  for (const property of value.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return undefined;
};

const drizzleConstructors = (ast: ts.SourceFile) => {
  const constructors = new Set<string>();
  for (const statement of ast.statements) {
    if (
      !runtimeImport(statement) ||
      !statement.moduleSpecifier.text.startsWith("drizzle-orm/")
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const binding of bindings.elements) {
      if ((binding.propertyName?.text ?? binding.name.text) === "drizzle") {
        constructors.add(binding.name.text);
      }
    }
  }
  return constructors;
};
const schemaRegistrationReference = (
  node: ts.Identifier,
  constructors: ReadonlySet<string>,
) => {
  const property = node.parent;
  let isOption = false;
  if (
    ts.isPropertyAssignment(property) &&
    property.initializer === node &&
    ts.isIdentifier(property.name)
  ) {
    isOption =
      property.name.text === "schema" || property.name.text === "relations";
  } else if (ts.isShorthandPropertyAssignment(property)) {
    isOption = node.text === "schema" || node.text === "relations";
  }
  const object = property.parent;
  const call = object.parent;
  return (
    isOption &&
    ts.isObjectLiteralExpression(object) &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    constructors.has(call.expression.text)
  );
};
// Registration defines a database handle; it does not consume feature tables.
// Any other runtime use of the same binding keeps the dependency in the graph.
const registrationOnly = (ast: ts.SourceFile, name: string) => {
  const references = runtimeReferences(ast, name);
  if (references.length === 0) {
    return false;
  }
  const constructors = drizzleConstructors(ast);
  return references.every((reference) =>
    schemaRegistrationReference(reference, constructors),
  );
};

/** Parses source once; no handler or runtime dependency is loaded. */
class DeclarationSourceGraph {
  private readonly parsed = new Map<string, ts.SourceFile>();
  private readonly imports = new Map<
    string,
    { targets: string[]; missing: string[] }
  >();
  readonly sources: ReadonlyMap<string, string>;
  private readonly registry: FeatureRegistry;
  constructor(sources: ReadonlyMap<string, string>, registry: FeatureRegistry) {
    this.sources = sources;
    this.registry = registry;
  }
  sourceFile(file: string) {
    const cached = this.parsed.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const source = this.sources.get(file);
    if (source === undefined) {
      return undefined;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    this.parsed.set(file, ast);
    return ast;
  }
  resolve(from: string, specifier: string) {
    const base = moduleBase(from, specifier);
    if (base === undefined) {
      return undefined;
    }
    return [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      base.replace(/\.js$/u, ".ts"),
    ].find((candidate) => this.sources.has(candidate));
  }
  private localExport(
    ast: ts.SourceFile,
    name: string,
    seen: Set<string>,
  ): string[] {
    for (const candidate of ast.statements) {
      if (!runtimeImport(candidate)) {
        continue;
      }
      const bindings = candidate.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) {
        continue;
      }
      const binding = bindings.elements.find(
        (item) => !item.isTypeOnly && item.name.text === name,
      );
      const target = this.resolve(ast.fileName, candidate.moduleSpecifier.text);
      if (binding !== undefined && target !== undefined) {
        return this.symbolModules(
          target,
          binding.propertyName?.text ?? binding.name.text,
          seen,
        );
      }
    }
    return [ast.fileName];
  }
  private exportTargets(
    ast: ts.SourceFile,
    statement: ts.ExportDeclaration,
    name: string,
    seen: Set<string>,
  ): string[] {
    const clause = statement.exportClause;
    const symbol =
      clause !== undefined && ts.isNamedExports(clause)
        ? clause.elements.find(
            (element) => !element.isTypeOnly && element.name.text === name,
          )
        : undefined;
    if (clause !== undefined && symbol === undefined) {
      return [];
    }
    const exportedName = symbol?.propertyName?.text ?? name;
    if (statement.moduleSpecifier === undefined) {
      return this.localExport(ast, exportedName, seen);
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const target = this.resolve(ast.fileName, statement.moduleSpecifier.text);
    return target === undefined
      ? []
      : this.symbolModules(target, exportedName, seen);
  }
  // Named barrel imports follow the selected symbol rather than all schemas.
  symbolModules(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): string[] {
    const key = `${file}#${name}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    const ast = this.sourceFile(file);
    if (ast === undefined) {
      return [];
    }
    for (const statement of ast.statements) {
      if (declaresSymbol(statement, name)) {
        if (ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations.find(
            (item) => ts.isIdentifier(item.name) && item.name.text === name,
          );
          if (
            declaration?.initializer !== undefined &&
            ts.isStringLiteralLike(unwrapExpression(declaration.initializer))
          ) {
            return [];
          }
        }
        const selections = Object.values(this.registry).flatMap(
          ({ ownership }) => {
            const symbols = ownership?.conditionalTableSchemas?.[file];
            return symbols === undefined ? [] : [symbols];
          },
        );
        return selections.length === 0 ||
          selections.some((symbols) => symbols.includes(name))
          ? [file]
          : [];
      }
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
        continue;
      }
      const targets = this.exportTargets(ast, statement, name, seen);
      if (targets.length !== 0) {
        return targets;
      }
    }
    return [];
  }
  private importedTargets(
    ast: ts.SourceFile,
    statement: ts.ImportDeclaration,
    target: string,
  ): string[] {
    const bindings = statement.importClause?.namedBindings;
    const defaultName = statement.importClause?.name;
    if (
      defaultName !== undefined &&
      bindings === undefined &&
      dispatchRegistrationOnly(ast, defaultName.text)
    ) {
      return [];
    }
    if (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      statement.importClause?.name === undefined
    ) {
      const targets: string[] = [];
      for (const binding of bindings.elements) {
        if (
          binding.isTypeOnly ||
          registrationOnly(ast, binding.name.text) ||
          dispatchRegistrationOnly(ast, binding.name.text)
        ) {
          continue;
        }
        const resolved = this.symbolModules(
          target,
          binding.propertyName?.text ?? binding.name.text,
        );
        targets.push(...resolved);
      }
      return targets;
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      if (registrationOnly(ast, bindings.name.text)) {
        return [];
      }
      const members = new Set<string>();
      const dynamicReferences = new Set<ts.Identifier>();
      const visit = (node: ts.Node) => {
        if (
          ts.isIdentifier(node) &&
          node.text === bindings.name.text &&
          node !== bindings.name
        ) {
          const parent = node.parent;
          if (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node
          ) {
            members.add(parent.name.text);
          } else if (
            ts.isElementAccessExpression(parent) &&
            parent.expression === node &&
            ts.isStringLiteral(parent.argumentExpression)
          ) {
            members.add(parent.argumentExpression.text);
          } else {
            dynamicReferences.add(node);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      return dynamicReferences.size !== 0
        ? [target]
        : [...members].flatMap((name) => this.symbolModules(target, name));
    }
    return [target];
  }
  private dynamicTargets(ast: ts.SourceFile): string[] {
    const targets: string[] = [];
    const visit = (node: ts.Node) => {
      if (dispatchRegistry(node)) {
        return;
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const argument = node.arguments.at(0);
        if (argument !== undefined && ts.isStringLiteral(argument)) {
          const target = this.resolve(ast.fileName, argument.text);
          if (target !== undefined) {
            targets.push(target);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return targets;
  }
  dependencies(ast: ts.SourceFile) {
    const cached = this.imports.get(ast.fileName);
    if (cached !== undefined) {
      return cached;
    }
    const missing: string[] = [];
    const result = { targets: this.dynamicTargets(ast), missing };
    for (const statement of ast.statements) {
      if (!runtimeImport(statement) && !runtimeExport(statement)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const target = this.resolve(ast.fileName, specifier);
      if (target === undefined) {
        if (localSourceImport(specifier)) {
          result.missing.push(
            `missing source import ${ast.fileName} -> ${specifier}`,
          );
        }
        continue;
      }
      if (ts.isImportDeclaration(statement)) {
        result.targets.push(...this.importedTargets(ast, statement, target));
      } else {
        result.targets.push(target);
      }
    }
    this.imports.set(ast.fileName, result);
    return result;
  }
}

const exportedTableNames = (ast: ts.SourceFile) => {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "pgTable") ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "pgTable"))
    ) {
      const argument = node.arguments.at(0);
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        names.add(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      visit(statement);
    }
  }
  return names;
};
type DispatchBoundary = NonNullable<
  NonNullable<FeatureRegistry[string]["ownership"]>["dispatchModules"]
>[number];

type OperationalBoundary = Extract<DispatchBoundary, { type: "operational" }>;

const voidReturnType = (type: ts.TypeNode | undefined) =>
  type?.kind === ts.SyntaxKind.VoidKeyword ||
  (type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "Promise" &&
    type.typeArguments?.length === 1 &&
    type.typeArguments.at(0)?.kind === ts.SyntaxKind.VoidKeyword);

const voidFunction = (
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
) => {
  if (
    !voidReturnType(node.type) ||
    node.body === undefined ||
    !ts.isBlock(node.body)
  ) {
    return false;
  }
  let valid = true;
  const visit = (child: ts.Node) => {
    // Callback results stay local; only the exported function's return can escape.
    if (ts.isFunctionLike(child)) {
      return;
    }
    if (ts.isReturnStatement(child) && child.expression !== undefined) {
      valid = false;
    }
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  return valid;
};

const exportedVoidFunction = (ast: ts.SourceFile, name: string) => {
  for (const statement of ast.statements) {
    if (!declaresSymbol(statement, name)) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      return voidFunction(statement);
    }
    if (!ts.isVariableStatement(statement)) {
      return false;
    }
    const declaration = statement.declarationList.declarations.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === name,
    );
    const value =
      declaration?.initializer === undefined
        ? undefined
        : unwrapExpression(declaration.initializer);
    return (
      value !== undefined &&
      (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
      voidFunction(value)
    );
  }
  return false;
};

type OperationalValidationOptions = {
  boundary: OperationalBoundary;
  graph: DeclarationSourceGraph;
  registry: FeatureRegistry;
  tables: readonly {
    matcher: RegExp;
    owners: ReadonlyMap<string, Requirement>;
  }[];
};

const operationalOwners = (
  boundary: OperationalBoundary,
  graph: DeclarationSourceGraph,
) => {
  if (
    boundary.reason.trim().length === 0 ||
    boundary.effects.length === 0 ||
    new Set(boundary.effects).size !== boundary.effects.length ||
    boundary.owners.length !== boundary.effects.length
  ) {
    return undefined;
  }
  const owners = new Map<string, Set<string>>();
  for (const effect of boundary.effects) {
    const matching = boundary.owners.filter((owner) => owner.effect === effect);
    const owner = matching.at(0);
    if (
      matching.length !== 1 ||
      owner === undefined ||
      owner.exports.length === 0 ||
      new Set(owner.exports).size !== owner.exports.length ||
      owner.module === boundary.module
    ) {
      return undefined;
    }
    const ast = graph.sourceFile(owner.module);
    if (
      ast === undefined ||
      !owner.exports.every((name) => exportedVoidFunction(ast, name))
    ) {
      return undefined;
    }
    const exports = owners.get(owner.module) ?? new Set<string>();
    for (const name of owner.exports) {
      exports.add(name);
    }
    owners.set(owner.module, exports);
  }
  return owners;
};

const validOperationalExport = (statement: ts.Statement) => {
  if (!exported(statement)) {
    return true;
  }
  if (ts.isClassDeclaration(statement)) {
    return false;
  }
  if (ts.isFunctionDeclaration(statement)) {
    return voidFunction(statement);
  }
  if (!ts.isVariableStatement(statement)) {
    return true;
  }
  return statement.declarationList.declarations.every((declaration) => {
    if (declaration.initializer === undefined) {
      return false;
    }
    const value = unwrapExpression(declaration.initializer);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return voidFunction(value);
    }
    return (
      ts.isStringLiteralLike(value) ||
      ts.isNumericLiteral(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword
    );
  });
};

const operationalFeatureReachability = ({
  graph,
  registry,
  tables,
}: Omit<OperationalValidationOptions, "boundary">) => {
  const visited = new Set<string>();
  // A wrapper cannot conceal feature reads behind an ordinary-looking import.
  const reachesFeature = (file: string): boolean => {
    if (visited.has(file)) {
      return false;
    }
    visited.add(file);
    if (moduleRequirements(registry, file).size !== 0) {
      return true;
    }
    const source = graph.sourceFile(file);
    if (
      source === undefined ||
      collectModuleUses(source, registry, tables).length !== 0
    ) {
      return true;
    }
    const dependencies = graph.dependencies(source);
    return (
      dependencies.missing.length !== 0 ||
      dependencies.targets.some(reachesFeature)
    );
  };
  return reachesFeature;
};

type OperationalImportOptions = {
  ast: ts.SourceFile;
  statement: ts.Statement;
  graph: DeclarationSourceGraph;
  owners: ReadonlyMap<string, ReadonlySet<string>>;
  usedOwners: Set<string>;
  reachesFeature: (file: string) => boolean;
};

const validOperationalImport = ({
  ast,
  statement,
  graph,
  owners,
  usedOwners,
  reachesFeature,
}: OperationalImportOptions) => {
  if (!runtimeImport(statement) && !runtimeExport(statement)) {
    return true;
  }
  const target = graph.resolve(ast.fileName, statement.moduleSpecifier.text);
  if (target === undefined) {
    return !localSourceImport(statement.moduleSpecifier.text);
  }
  const ownerExports = owners.get(target);
  if (ownerExports === undefined) {
    const modules =
      ts.isImportDeclaration(statement) &&
      statement.importClause !== undefined &&
      statement.importClause.name === undefined &&
      statement.importClause.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
            .filter((binding) => !binding.isTypeOnly)
            .flatMap((binding) =>
              graph.symbolModules(
                target,
                binding.propertyName?.text ?? binding.name.text,
              ),
            )
        : [target];
    return !modules.some(reachesFeature);
  }
  if (
    !ts.isImportDeclaration(statement) ||
    statement.importClause?.name !== undefined ||
    statement.importClause?.namedBindings === undefined ||
    !ts.isNamedImports(statement.importClause.namedBindings)
  ) {
    return false;
  }
  return statement.importClause.namedBindings.elements.every((binding) => {
    if (binding.isTypeOnly) {
      return true;
    }
    const name = binding.propertyName?.text ?? binding.name.text;
    const references = runtimeReferences(ast, binding.name.text);
    if (
      !ownerExports.has(name) ||
      references.length === 0 ||
      !references.every(
        (reference) =>
          ts.isCallExpression(reference.parent) &&
          reference.parent.expression === reference,
      )
    ) {
      return false;
    }
    usedOwners.add(`${target}#${name}`);
    return true;
  });
};

type OperationalDynamicImportOptions = Pick<
  OperationalImportOptions,
  "ast" | "graph" | "owners" | "reachesFeature"
>;
const validOperationalDynamicImports = ({
  ast,
  graph,
  owners,
  reachesFeature,
}: OperationalDynamicImportOptions) => {
  let valid = true;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments.at(0);
      if (specifier === undefined || !ts.isStringLiteral(specifier)) {
        valid = false;
      } else {
        const target = graph.resolve(ast.fileName, specifier.text);
        if (
          target !== undefined &&
          (owners.has(target) || reachesFeature(target))
        ) {
          valid = false;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return valid;
};

const isValidOperationalBoundary = ({
  boundary,
  graph,
  registry,
  tables,
}: OperationalValidationOptions) => {
  const owners = operationalOwners(boundary, graph);
  const ast = graph.sourceFile(boundary.module);
  if (
    owners === undefined ||
    ast === undefined ||
    collectModuleUses(ast, registry, tables).length !== 0
  ) {
    return false;
  }
  const reachesFeature = operationalFeatureReachability({
    graph,
    registry,
    tables,
  });
  const usedOwners = new Set<string>();
  const validStatements = ast.statements.every(
    (statement) =>
      validOperationalExport(statement) &&
      validOperationalImport({
        ast,
        statement,
        graph,
        owners,
        usedOwners,
        reachesFeature,
      }),
  );
  return (
    validStatements &&
    validOperationalDynamicImports({ ast, graph, owners, reachesFeature }) &&
    [...owners].every(([module, exports]) =>
      [...exports].every((name) => usedOwners.has(`${module}#${name}`)),
    )
  );
};

const isValidDispatchBoundary = (
  ast: ts.SourceFile,
  boundary: DispatchBoundary,
) => {
  switch (boundary.type) {
    case "registry":
      return ast.statements.some(
        (statement) =>
          declaresSymbol(statement, boundary.registry) &&
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) =>
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === boundary.registry &&
              declaration.initializer !== undefined &&
              ts.isArrayLiteralExpression(
                unwrapExpression(declaration.initializer),
              ),
          ),
      );
    case "admitted": {
      let valid = false;
      const bindings = new Set<string>();
      for (const statement of ast.statements) {
        if (
          !runtimeImport(statement) ||
          statement.moduleSpecifier.text !==
            (boundary.specifier ?? "@/api/mcp/feature-access")
        ) {
          continue;
        }
        const named = statement.importClause?.namedBindings;
        if (named === undefined || !ts.isNamedImports(named)) {
          continue;
        }
        for (const binding of named.elements) {
          if (
            !binding.isTypeOnly &&
            (binding.propertyName?.text ?? binding.name.text) ===
              boundary.admission
          ) {
            bindings.add(binding.name.text);
          }
        }
      }
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          bindings.has(node.expression.text)
        ) {
          valid = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      return valid;
    }
    case "operational":
      return false; // Operational boundaries need the completed ownership graph.
    default: {
      boundary satisfies never;
      return panic("Unknown dispatch ownership boundary");
    }
  }
};
type CollectTableOwnershipOptions = {
  featureId: string;
  ownership: NonNullable<FeatureRegistry[string]["ownership"]>;
  graph: DeclarationSourceGraph;
  violations: FeatureAccessDeclarationViolation[];
  tableOwners: Map<string, Map<string, Requirement>>;
};

const collectTableOwnership = ({
  featureId,
  ownership,
  graph,
  violations,
  tableOwners,
}: CollectTableOwnershipOptions) => {
  for (const file of [
    ...ownership.tableSchemaFiles,
    ...Object.keys(ownership.conditionalTableSchemas ?? {}),
  ]) {
    const ast = graph.sourceFile(file);
    if (ast === undefined) {
      continue;
    }
    const selectedSymbols = ownership.conditionalTableSchemas?.[file];
    const selectedAst =
      selectedSymbols === undefined
        ? ast
        : ts.factory.updateSourceFile(
            ast,
            ast.statements.filter((statement) =>
              selectedSymbols.some((symbol) =>
                declaresSymbol(statement, symbol),
              ),
            ),
          );
    for (const symbol of selectedSymbols ?? []) {
      if (
        !ast.statements.some((statement) => declaresSymbol(statement, symbol))
      ) {
        violations.push({
          file,
          message: `feature ${featureId} owns a missing table symbol ${symbol}`,
        });
      }
    }
    for (const name of exportedTableNames(selectedAst)) {
      const owners = tableOwners.get(name) ?? new Map<string, Requirement>();
      owners.set(
        featureId,
        ownership.conditionalTableSchemas?.[file] !== undefined
          ? "conditional"
          : "required",
      );
      tableOwners.set(name, owners);
    }
  }
};

const validateOwnership = (
  registry: FeatureRegistry,
  graph: DeclarationSourceGraph,
) => {
  const violations: FeatureAccessDeclarationViolation[] = [];
  const tableOwners = new Map<string, Map<string, Requirement>>();
  const dispatchModules = new Set<string>();
  const operational: { featureId: string; boundary: OperationalBoundary }[] =
    [];
  for (const [featureId, { ownership }] of Object.entries(registry)) {
    if (
      ownership === undefined ||
      [
        ...ownership.handlerDirectories,
        ...ownership.tableSchemaFiles,
        ...Object.keys(ownership.conditionalTableSchemas ?? {}),
        ...ownership.coreModules,
        ...(ownership.conditionalModules ?? []),
      ].length === 0
    ) {
      violations.push({
        file: "feature registry",
        message: `feature ${featureId} requires nonempty ownership`,
      });
      continue;
    }
    for (const directory of ownership.handlerDirectories) {
      if (
        ![...graph.sources.keys()].some((file) =>
          file.startsWith(`${directory.replace(/\/$/u, "")}/`),
        )
      ) {
        violations.push({
          file: directory,
          message: `feature ${featureId} owns a missing handler directory`,
        });
      }
    }
    for (const file of [
      ...ownership.tableSchemaFiles,
      ...Object.keys(ownership.conditionalTableSchemas ?? {}),
      ...ownership.coreModules,
      ...(ownership.conditionalModules ?? []),
    ]) {
      if (!graph.sources.has(file)) {
        violations.push({
          file,
          message: `feature ${featureId} owns a missing source module`,
        });
      }
    }
    collectTableOwnership({
      featureId,
      ownership,
      graph,
      violations,
      tableOwners,
    });
    for (const owner of ownership.taskMutationOwners ?? []) {
      const ast = graph.sourceFile(owner.module);
      const message =
        ast === undefined
          ? `feature ${featureId} owns a missing task mutation module`
          : validateTaskMutationEffectOwner(ast, owner);
      if (message !== undefined) {
        violations.push({ file: owner.module, message });
      }
    }
    for (const boundary of ownership.dispatchModules ?? []) {
      const ast = graph.sourceFile(boundary.module);
      if (ast === undefined) {
        violations.push({
          file: boundary.module,
          message: `feature ${featureId} owns a missing dispatch module`,
        });
        continue;
      }
      if (boundary.type === "operational") {
        operational.push({ featureId, boundary });
        continue;
      }
      if (!isValidDispatchBoundary(ast, boundary)) {
        violations.push({
          file: boundary.module,
          message: `feature ${featureId} has an invalid ${boundary.type} dispatch boundary`,
        });
        continue;
      }
      dispatchModules.add(boundary.module);
    }
  }
  const tables = [...tableOwners].map(([table, owners]) => ({
    matcher: new RegExp(
      `(?<![A-Za-z0-9_])${table.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9_])`,
      "u",
    ),
    owners,
  }));
  for (const { featureId, boundary } of operational) {
    if (!isValidOperationalBoundary({ boundary, graph, registry, tables })) {
      violations.push({
        file: boundary.module,
        message: `feature ${featureId} has an invalid operational dispatch boundary`,
      });
      continue;
    }
    dispatchModules.add(boundary.module);
  }
  return { violations, tables, dispatchModules };
};
const parseDeclaration = (
  config: Record<string, unknown>,
  file: string,
  registry: FeatureRegistry,
) => {
  const violations: FeatureAccessDeclarationViolation[] = [];
  const declaration = config["featureAccess"];
  if (declaration === undefined) {
    return { violations, id: undefined, type: undefined };
  }
  if (
    typeof declaration !== "object" ||
    declaration === null ||
    !("featureId" in declaration) ||
    typeof declaration.featureId !== "string" ||
    !("type" in declaration) ||
    (declaration.type !== "required" && declaration.type !== "conditional")
  ) {
    violations.push({ file, message: "invalid featureAccess declaration" });
    return { violations, id: undefined, type: undefined };
  }
  if (!Object.hasOwn(registry, declaration.featureId)) {
    violations.push({
      file,
      message: `unknown featureAccess identifier ${declaration.featureId}`,
    });
  }
  if (
    declaration.type === "conditional" &&
    (!("usesFeature" in declaration) ||
      typeof declaration.usesFeature !== "function")
  ) {
    violations.push({
      file,
      message: "conditional featureAccess requires usesFeature",
    });
  }
  return {
    violations,
    id: declaration.featureId,
    type: declaration.type,
  } as const;
};
const moduleRequirements = (registry: FeatureRegistry, module: string) => {
  const required = new Map<string, Requirement>();
  for (const [id, { ownership }] of Object.entries(registry)) {
    if (
      ownership?.conditionalModules?.includes(module) ||
      ownership?.conditionalTableSchemas?.[module] !== undefined
    ) {
      required.set(id, "conditional");
    } else if (
      ownership?.handlerDirectories.some((directory) =>
        module.startsWith(`${directory.replace(/\/$/u, "")}/`),
      ) ||
      ownership?.coreModules.includes(module) ||
      ownership?.tableSchemaFiles.includes(module)
    ) {
      required.set(id, "required");
    }
  }
  return required;
};
type ModuleUse = readonly [featureId: string, type: Requirement];
/**
 * Feature uses visible in a module's own source: conditional query symbols
 * and owned table names. Pure per module, so one validation run computes
 * each module once instead of once per endpoint that reaches it.
 */
const isFeatureIdentityMetadata = (
  node: ts.StringLiteralLike,
  registry: FeatureRegistry,
): boolean => {
  const parent = node.parent;
  return (
    ts.isPropertyAssignment(parent) &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) &&
    parent.name.text === "featureId" &&
    parent.initializer === node &&
    Object.hasOwn(registry, node.text)
  );
};

const collectModuleUses = (
  ast: ts.SourceFile,
  registry: FeatureRegistry,
  tables: ReturnType<typeof validateOwnership>["tables"],
): ModuleUse[] => {
  const uses: ModuleUse[] = [];
  const visit = (node: ts.Node) => {
    // Module addresses are inspected by the dependency graph, never as SQL table names.
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      if (isFeatureIdentityMetadata(node, registry)) {
        return;
      }

      if (
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        parent.moduleSpecifier === node
      ) {
        return;
      }
      if (
        ts.isCallExpression(parent) &&
        parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
        parent.arguments.at(0) === node
      ) {
        return;
      }
    }

    if (dispatchRegistry(node)) {
      return;
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression))) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "query"
    ) {
      let symbol: string | undefined;
      if (ts.isPropertyAccessExpression(node)) {
        symbol = node.name.text;
      } else if (ts.isStringLiteral(node.argumentExpression)) {
        symbol = node.argumentExpression.text;
      }
      for (const [id, { ownership }] of Object.entries(registry)) {
        if (
          symbol !== undefined &&
          Object.values(ownership?.conditionalTableSchemas ?? {}).some(
            (symbols) => symbols.includes(symbol),
          )
        ) {
          uses.push([id, "conditional"]);
        }
      }
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const { matcher, owners } of tables) {
        if (matcher.test(node.text)) {
          uses.push(...owners);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return uses;
};
type ModuleFacts = {
  boundary: (module: string) => ReadonlyMap<string, Requirement>;
  uses: (module: string, ast: ts.SourceFile) => readonly ModuleUse[];
};
/**
 * Per-module facts are independent of the endpoint that reaches the module.
 * Endpoints share most of their graph, so compute each fact once per run.
 */
const moduleFacts = (
  registry: FeatureRegistry,
  tables: ReturnType<typeof validateOwnership>["tables"],
): ModuleFacts => {
  const boundaries = new Map<string, ReadonlyMap<string, Requirement>>();
  const uses = new Map<string, readonly ModuleUse[]>();
  return {
    boundary: (module) => {
      const cached = boundaries.get(module);
      if (cached !== undefined) {
        return cached;
      }
      const boundary = moduleRequirements(registry, module);
      boundaries.set(module, boundary);
      return boundary;
    },
    uses: (module, ast) => {
      const cached = uses.get(module);
      if (cached !== undefined) {
        return cached;
      }
      const moduleUses = collectModuleUses(ast, registry, tables);
      uses.set(module, moduleUses);
      return moduleUses;
    },
  };
};
type EndpointOptions = {
  endpoint: DeclarationOptions["endpoints"][number];
  registry: FeatureRegistry;
  graph: DeclarationSourceGraph;
  dispatchModules: ReturnType<typeof validateOwnership>["dispatchModules"];
  modules: ModuleFacts;
};
const inspectEndpoint = ({
  endpoint,
  registry,
  graph,
  dispatchModules,
  modules,
}: EndpointOptions) => {
  const file = endpoint.file.split("#").at(0) ?? endpoint.file;
  const declaration = parseDeclaration(endpoint.config, file, registry);
  const violations = declaration.violations;
  if (Object.keys(registry).length === 0) {
    return violations;
  }
  const required = new Map<string, Set<Requirement>>();
  const add = (id: string, type: Requirement) => {
    const types = required.get(id) ?? new Set<Requirement>();
    types.add(type);
    required.set(id, types);
  };
  for (const [id, { ownership }] of Object.entries(registry)) {
    if (
      ownership?.handlerDirectories.some((directory) =>
        file.startsWith(`${directory.replace(/\/$/u, "")}/`),
      )
    ) {
      add(id, "required");
    }
  }
  const visited = new Set<string>();
  const walk = (module: string) => {
    if (visited.has(module)) {
      return;
    }
    visited.add(module);
    // Descriptor registries do not invoke their handlers. Dispatch owners
    // admit the selected descriptor before invocation, not the whole caller.
    if (dispatchModules.has(module)) {
      return;
    }
    const ast = graph.sourceFile(module);
    if (ast === undefined) {
      violations.push({ file, message: `missing source module ${module}` });
      return;
    }
    const boundary = modules.boundary(module);
    for (const [id, type] of boundary) {
      add(id, type);
    }
    if (boundary.size !== 0) {
      return;
    }
    const dependencies = graph.dependencies(ast);
    for (const message of dependencies.missing) {
      violations.push({ file, message });
    }
    for (const target of dependencies.targets) {
      walk(target);
    }
    for (const [id, type] of modules.uses(module, ast)) {
      add(id, type);
    }
  };
  walk(file);
  for (const [id, types] of required) {
    const conditionalModules = registry[id]?.ownership?.conditionalModules;
    if (
      types.has("conditional") &&
      conditionalModules !== undefined &&
      !conditionalModules.some((module) => visited.has(module))
    ) {
      violations.push({
        file,
        message: `featureAccess ${id} conditional tables require the shared policy module`,
      });
    }
    if (declaration.id !== id) {
      violations.push({
        file,
        message: `source ownership requires featureAccess ${id}`,
      });
    } else if (!types.has(declaration.type) || types.size > 1) {
      violations.push({
        file,
        message: `featureAccess ${id} must match source ownership (${[...types].toSorted().join(", ")})`,
      });
    }
  }
  return violations;
};

const dispatchEntryEndpoints = (sources: DeclarationOptions["sources"]) => {
  const entries: DeclarationOptions["endpoints"][number][] = [];
  const entrySources = new Map(sources);
  for (const [file, source] of sources) {
    if (
      !source.includes("CAPABILITY_DISPATCH") &&
      !source.includes("SCHEDULER_TASKS")
    ) {
      continue;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !dispatchRegistry(node) ||
        node.initializer === undefined
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      const value = unwrapExpression(node.initializer);
      if (!ts.isObjectLiteralExpression(value)) {
        return;
      }
      for (const [index, property] of value.properties.entries()) {
        let initializer: ts.Expression | undefined;
        if (ts.isSpreadAssignment(property)) {
          initializer = property.expression;
        } else if (ts.isPropertyAssignment(property)) {
          initializer = property.initializer;
        } else if (ts.isShorthandPropertyAssignment(property)) {
          initializer = property.name;
        }
        if (initializer === undefined) {
          entries.push({
            file,
            config: { featureAccess: "unsupported dispatch entry" },
          });
          continue;
        }
        const names = new Set<string>();
        const collect = (child: ts.Node) => {
          if (ts.isIdentifier(child)) {
            names.add(child.text);
          }
          ts.forEachChild(child, collect);
        };
        collect(initializer);
        const imports = ast.statements
          .filter(runtimeImport)
          .flatMap((statement) => {
            const clause = statement.importClause;
            const bindings = clause?.namedBindings;
            if (bindings !== undefined && ts.isNamedImports(bindings)) {
              const selected = bindings.elements.filter(
                (binding) =>
                  !binding.isTypeOnly && names.has(binding.name.text),
              );
              return selected.length === 0
                ? []
                : [
                    `import { ${selected.map((binding) => binding.getText(ast)).join(", ")} } from ${statement.moduleSpecifier.getText(ast)};`,
                  ];
            }
            return (clause?.name !== undefined &&
              names.has(clause.name.text)) ||
              (bindings !== undefined &&
                ts.isNamespaceImport(bindings) &&
                names.has(bindings.name.text))
              ? [statement.getText(ast)]
              : [];
          })
          .join("\n");
        const entryFile = `${file}.dispatch-entry-${index}.ts`;
        entrySources.set(
          entryFile,
          `${imports}\nconst entry = ${initializer.getText(ast)};`,
        );
        const featureId = literalProperty(initializer, "featureId");
        const featureAccess =
          literalProperty(initializer, "featureAccess") ?? "required";
        entries.push({
          file: entryFile,
          config:
            featureId === undefined
              ? {}
              : {
                  featureAccess: {
                    type: featureAccess,
                    featureId,
                    ...(featureAccess === "conditional"
                      ? { usesFeature: () => true }
                      : {}),
                  },
                },
        });
      }
    };
    visit(ast);
  }
  return { entries, sources: entrySources };
};

export const validateFeatureAccessDeclarations = ({
  registry,
  endpoints,
  sources,
}: DeclarationOptions): FeatureAccessDeclarationViolation[] => {
  const dispatch = dispatchEntryEndpoints(sources);
  const graph = new DeclarationSourceGraph(dispatch.sources, registry);
  const tasks = new Map<string, DeclarationOptions["endpoints"][number]>();
  for (const entry of dispatch.entries) {
    const ast = graph.sourceFile(entry.file);
    if (ast === undefined) {
      continue;
    }
    for (const file of graph.dependencies(ast).targets) {
      if (!file.includes("/scheduler/tasks/")) {
        continue;
      }
      const task = graph.sourceFile(file);
      let featureId: string | undefined;
      for (const statement of task?.statements ?? []) {
        if (!ts.isVariableStatement(statement) || !exported(statement)) {
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === "featureAccess" &&
            declaration.initializer !== undefined
          ) {
            featureId = literalProperty(declaration.initializer, "featureId");
          }
        }
      }
      tasks.set(file, {
        file,
        config:
          featureId === undefined
            ? {}
            : {
                featureAccess: { type: "required", featureId },
              },
      });
    }
  }
  const ownership = validateOwnership(registry, graph);
  const violations = ownership.violations;
  const modules = moduleFacts(registry, ownership.tables);
  for (const endpoint of [
    ...endpoints,
    ...tasks.values(),
    ...dispatch.entries,
  ]) {
    violations.push(
      ...inspectEndpoint({
        endpoint,
        registry,
        graph,
        dispatchModules: ownership.dispatchModules,
        modules,
      }),
    );
  }
  return violations.toSorted((left, right) =>
    compareCodeUnit(
      `${left.file}:${left.message}`,
      `${right.file}:${right.message}`,
    ),
  );
};
export const assertFeatureAccessDeclarations = (
  options: DeclarationOptions,
): void => {
  const violations = validateFeatureAccessDeclarations(options);
  if (violations.length !== 0) {
    panic(
      `Feature access declarations failed:\n${violations.map(({ file, message }) => `${file}: ${message}`).join("\n")}`,
    );
  }
};
