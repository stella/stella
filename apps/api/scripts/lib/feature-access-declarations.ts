import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";

import type { FeatureRegistry } from "../../src/lib/auth/feature-access/registry";

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
  node.importClause?.isTypeOnly !== true;
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
  const constructors = drizzleConstructors(ast);
  let references = 0;
  let valid = true;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      references += 1;
      if (!schemaRegistrationReference(node, constructors)) {
        valid = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return references > 0 && valid;
};

/** Parses source once; no handler or runtime dependency is loaded. */
class DeclarationSourceGraph {
  private readonly parsed = new Map<string, ts.SourceFile>();
  private readonly imports = new Map<
    string,
    { targets: string[]; missing: string[] }
  >();
  readonly sources: ReadonlyMap<string, string>;
  constructor(sources: ReadonlyMap<string, string>) {
    this.sources = sources;
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
        return [file];
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
    if (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      statement.importClause?.name === undefined
    ) {
      const targets: string[] = [];
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly || registrationOnly(ast, binding.name.text)) {
          continue;
        }
        const resolved = this.symbolModules(
          target,
          binding.propertyName?.text ?? binding.name.text,
        );
        targets.push(...(resolved.length === 0 ? [target] : resolved));
      }
      return targets;
    }
    if (
      bindings !== undefined &&
      ts.isNamespaceImport(bindings) &&
      registrationOnly(ast, bindings.name.text)
    ) {
      return [];
    }
    return [target];
  }
  private dynamicTargets(ast: ts.SourceFile): string[] {
    const targets: string[] = [];
    const visit = (node: ts.Node) => {
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
const validateOwnership = (
  registry: FeatureRegistry,
  graph: DeclarationSourceGraph,
) => {
  const violations: FeatureAccessDeclarationViolation[] = [];
  const tableOwners = new Map<string, Set<string>>();
  for (const [featureId, { ownership }] of Object.entries(registry)) {
    if (
      ownership === undefined ||
      [
        ...ownership.handlerDirectories,
        ...ownership.tableSchemaFiles,
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
    for (const file of ownership.tableSchemaFiles) {
      const ast = graph.sourceFile(file);
      if (ast === undefined) {
        continue;
      }
      for (const name of exportedTableNames(ast)) {
        const owners = tableOwners.get(name) ?? new Set<string>();
        owners.add(featureId);
        tableOwners.set(name, owners);
      }
    }
  }
  const tables = [...tableOwners].map(([table, owners]) => ({
    matcher: new RegExp(
      `(?<![A-Za-z0-9_])${table.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9_])`,
      "u",
    ),
    owners,
  }));
  return { violations, tables };
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
    if (ownership?.conditionalModules?.includes(module)) {
      required.set(id, "conditional");
    } else if (
      ownership?.coreModules.includes(module) ||
      ownership?.tableSchemaFiles.includes(module)
    ) {
      required.set(id, "required");
    }
  }
  return required;
};
type EndpointOptions = {
  endpoint: DeclarationOptions["endpoints"][number];
  registry: FeatureRegistry;
  graph: DeclarationSourceGraph;
  tables: ReturnType<typeof validateOwnership>["tables"];
};
const inspectEndpoint = ({
  endpoint,
  registry,
  graph,
  tables,
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
    const ast = graph.sourceFile(module);
    if (ast === undefined) {
      violations.push({ file, message: `missing source module ${module}` });
      return;
    }
    const boundary = moduleRequirements(registry, module);
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
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        for (const { matcher, owners } of tables) {
          if (matcher.test(node.text)) {
            for (const id of owners) {
              add(id, "required");
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  };
  walk(file);
  for (const [id, types] of required) {
    if (declaration.id !== id) {
      violations.push({
        file,
        message: `source ownership requires featureAccess ${id}`,
      });
    } else if (!types.has(declaration.type ?? "required") || types.size > 1) {
      violations.push({
        file,
        message: `featureAccess ${id} must match source ownership (${[...types].toSorted().join(", ")})`,
      });
    }
  }
  return violations;
};

export const validateFeatureAccessDeclarations = ({
  registry,
  endpoints,
  sources,
}: DeclarationOptions): FeatureAccessDeclarationViolation[] => {
  const graph = new DeclarationSourceGraph(sources);
  const ownership = validateOwnership(registry, graph);
  const violations = ownership.violations;
  for (const endpoint of endpoints) {
    violations.push(
      ...inspectEndpoint({
        endpoint,
        registry,
        graph,
        tables: ownership.tables,
      }),
    );
  }
  return violations.toSorted((left, right) =>
    `${left.file}:${left.message}`.localeCompare(
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
