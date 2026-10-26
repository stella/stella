import { panic } from "better-result";
import path from "node:path";

import { DESKTOP_FEATURE_IDS } from "@stll/api-contract/desktop-feature-access";
import { compareCodeUnit } from "@stll/collation";
import {
  type ImportDeclaration,
  type ModuleExportName,
  type Node,
  type ParsedSource,
  parseSource,
  type Program,
  walk,
} from "@stll/scripts/src/syntax-tree";

import { featurePrerequisiteClosure } from "../../src/lib/feature-access/prerequisites";
import type { FeatureRegistry } from "../../src/lib/feature-access/registry";

type DeclarationSource = {
  readonly fileName: string;
  readonly parsed: ParsedSource;
};
type Statement = Program["body"][number];

/**
 * Parsed sources by file name, reused across validations in one process (the
 * capability exporter validates on every export). A hit needs the identical
 * name and source text, so it returns exactly the tree a fresh parse builds.
 * Validation only reads trees.
 */
const parsedSources = new Map<
  string,
  { source: string; ast: DeclarationSource }
>();
export const parseDeclarationSource = (
  file: string,
  source: string,
): DeclarationSource => {
  const cached = parsedSources.get(file);
  if (cached?.source === source) {
    return cached.ast;
  }
  const ast = { fileName: file, parsed: parseSource(file, source) };
  parsedSources.set(file, { source, ast });
  return ast;
};
const statementsOf = (ast: DeclarationSource) => ast.parsed.program.body;
const textOf = (ast: DeclarationSource, node: Node) =>
  ast.parsed.sourceText.slice(node.start, node.end);
const moduleExportName = (name: ModuleExportName) =>
  name.type === "Literal" ? name.value : name.name;

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

/** The declaration an `export` or `export default` statement carries. */
const exportedDeclaration = (statement: Statement) => {
  if (statement.type === "ExportNamedDeclaration") {
    return statement.declaration ?? undefined;
  }
  return statement.type === "ExportDefaultDeclaration"
    ? statement.declaration
    : undefined;
};
const runtimeImport = (node: Statement): node is ImportDeclaration =>
  node.type === "ImportDeclaration" && node.importKind !== "type";
/** A value re-export: `export * from`, `export * as x from`, `export { x } from`. */
const runtimeExportSource = (node: Statement) => {
  if (node.type === "ExportAllDeclaration") {
    return node.exportKind === "type" ? undefined : node.source;
  }
  return node.type === "ExportNamedDeclaration" &&
    node.exportKind !== "type" &&
    node.source !== null &&
    node.specifiers.some((specifier) => specifier.exportKind !== "type")
    ? node.source
    : undefined;
};
const declaresSymbol = (statement: Statement, name: string) => {
  const declaration = exportedDeclaration(statement);
  if (declaration?.type === "VariableDeclaration") {
    return declaration.declarations.some(
      ({ id }) => id.type === "Identifier" && id.name === name,
    );
  }
  return (
    (declaration?.type === "FunctionDeclaration" ||
      declaration?.type === "TSDeclareFunction" ||
      declaration?.type === "ClassDeclaration") &&
    declaration.id?.name === name
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

const unwrapExpression = (node: Node): Node =>
  node.type === "TSAsExpression" ||
  node.type === "TSSatisfiesExpression" ||
  node.type === "ParenthesizedExpression"
    ? unwrapExpression(node.expression)
    : node;
// Registry references describe dispatch; each entry is checked independently.
const dispatchRegistry = (node: Node) =>
  node.type === "VariableDeclarator" &&
  node.id.type === "Identifier" &&
  (node.id.name === "CAPABILITY_DISPATCH" ||
    node.id.name === "SCHEDULER_TASKS") &&
  node.init !== null &&
  unwrapExpression(node.init).type === "ObjectExpression";

/** An identifier and its ancestors (nearest last); oxc nodes have no parents. */
type Reference = { readonly node: Node; readonly ancestors: readonly Node[] };
const insideDispatchRegistry = ({ ancestors }: Reference): boolean =>
  ancestors.some(dispatchRegistry);
// The syntax TypeScript reads as a type: a reference there is not a runtime
// use. Expressions with type arguments (`extends Base<T>`, `fn<T>`) count.
const TYPE_SYNTAX: ReadonlySet<string> = new Set([
  "TSClassImplements",
  "TSInstantiationExpression",
  "TSInterfaceHeritage",
  "TSNamedTupleMember",
  "TSTypeAnnotation",
  "TSTypeLiteral",
  "TSTypeOperator",
  "TSTypeParameterInstantiation",
  "TSTypePredicate",
  "TSTypeQuery",
  "TSTypeReference",
]);
const isTypeSyntax = (node: Node) =>
  TYPE_SYNTAX.has(node.type) ||
  (node.type.startsWith("TS") &&
    (node.type.endsWith("Type") || node.type.endsWith("Keyword")));
/** The name of a non-computed member, spelled as TypeScript's `name.text`. */
const memberName = (node: Node) => {
  if (node.type !== "MemberExpression" || node.computed) {
    return undefined;
  }
  return node.property.type === "PrivateIdentifier"
    ? `#${node.property.name}`
    : node.property.name;
};
const identifierName = (node: Node) =>
  node.type === "Identifier" || node.type === "JSXIdentifier"
    ? node.name
    : undefined;
const runtimeReferenceIndex = new WeakMap<
  DeclarationSource,
  ReadonlyMap<string, readonly Reference[]>
>();
/**
 * Value-position identifiers by name, outside imports and type nodes. One
 * walk per parsed file; binding checks look names up instead of re-walking.
 */
const runtimeReferences = (ast: DeclarationSource, name: string) => {
  let index = runtimeReferenceIndex.get(ast);
  if (index === undefined) {
    const references = new Map<string, Reference[]>();
    const typeSyntax = new Set<Node>();
    walk(ast.parsed.program, (node, ancestors) => {
      if (
        node.type === "ImportDeclaration" ||
        typeSyntax.has(node) ||
        isTypeSyntax(node)
      ) {
        return "skip-children";
      }
      // A heritage clause is a type, value and type arguments alike.
      if (
        (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
        node.superClass !== null
      ) {
        typeSyntax.add(node.superClass);
      }
      const text = identifierName(node);
      if (text !== undefined) {
        const named = references.get(text) ?? [];
        named.push({ node, ancestors: [...ancestors] });
        references.set(text, named);
      }
      return undefined;
    });
    index = references;
    runtimeReferenceIndex.set(ast, index);
  }
  return index.get(name) ?? [];
};
const dispatchRegistrationOnly = (ast: DeclarationSource, name: string) => {
  const references = runtimeReferences(ast, name);
  return references.length > 0 && references.every(insideDispatchRegistry);
};
/** A non-computed `key: value` entry of an object literal. */
const assignedProperty = (node: Node) =>
  node.type === "Property" &&
  node.kind === "init" &&
  !node.method &&
  !node.shorthand &&
  !node.computed
    ? node
    : undefined;
const literalProperty = (node: Node, name: string) => {
  const value = unwrapExpression(node);
  if (value.type !== "ObjectExpression") {
    return undefined;
  }
  for (const entry of value.properties) {
    const property = assignedProperty(entry);
    if (
      property !== undefined &&
      ((property.key.type === "Identifier" && property.key.name === name) ||
        (property.key.type === "Literal" && property.key.value === name)) &&
      property.value.type === "Literal" &&
      typeof property.value.value === "string"
    ) {
      return property.value.value;
    }
  }
  return undefined;
};

const drizzleConstructors = (ast: DeclarationSource) => {
  const constructors = new Set<string>();
  for (const statement of statementsOf(ast)) {
    if (
      !runtimeImport(statement) ||
      !statement.source.value.startsWith("drizzle-orm/")
    ) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (
        binding.type === "ImportSpecifier" &&
        moduleExportName(binding.imported) === "drizzle"
      ) {
        constructors.add(binding.local.name);
      }
    }
  }
  return constructors;
};
const schemaRegistrationReference = (
  { node, ancestors }: Reference,
  constructors: ReadonlySet<string>,
) => {
  const property = ancestors.at(-1);
  let isOption = false;
  if (property?.type === "Property" && property.shorthand) {
    isOption =
      identifierName(node) === "schema" || identifierName(node) === "relations";
  } else if (
    property !== undefined &&
    assignedProperty(property)?.value === node &&
    property.type === "Property" &&
    property.key.type === "Identifier"
  ) {
    isOption =
      property.key.name === "schema" || property.key.name === "relations";
  }
  const object = ancestors.at(-2);
  const call = ancestors.at(-3);
  return (
    isOption &&
    object?.type === "ObjectExpression" &&
    call?.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    constructors.has(call.callee.name)
  );
};
// Registration defines a database handle; it does not consume feature tables.
// Any other runtime use of the same binding keeps the dependency in the graph.
const registrationOnly = (ast: DeclarationSource, name: string) => {
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
  private readonly parsed = new Map<string, DeclarationSource>();
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
    const ast = parseDeclarationSource(file, source);
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
    ast: DeclarationSource,
    name: string,
    seen: Set<string>,
  ): string[] {
    for (const candidate of statementsOf(ast)) {
      if (!runtimeImport(candidate)) {
        continue;
      }
      const binding = candidate.specifiers.find(
        (item) =>
          item.type === "ImportSpecifier" &&
          item.importKind !== "type" &&
          item.local.name === name,
      );
      const target = this.resolve(ast.fileName, candidate.source.value);
      if (binding?.type === "ImportSpecifier" && target !== undefined) {
        return this.symbolModules(
          target,
          moduleExportName(binding.imported),
          seen,
        );
      }
    }
    return [ast.fileName];
  }
  /** `statement` is an `export { … }` list or an `export *` re-export. */
  private exportTargets(
    ast: DeclarationSource,
    statement: Statement,
    name: string,
    seen: Set<string>,
  ): string[] {
    let exportedName = name;
    if (statement.type === "ExportNamedDeclaration") {
      const symbol = statement.specifiers.find(
        (element) =>
          element.exportKind !== "type" &&
          moduleExportName(element.exported) === name,
      );
      if (symbol === undefined) {
        return [];
      }
      const { local: exportedBinding } = symbol;
      exportedName = moduleExportName(exportedBinding);
    } else if (
      statement.type !== "ExportAllDeclaration" ||
      statement.exported !== null
    ) {
      return [];
    }
    if (statement.source === null) {
      return this.localExport(ast, exportedName, seen);
    }
    const target = this.resolve(ast.fileName, statement.source.value);
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
    for (const statement of statementsOf(ast)) {
      if (declaresSymbol(statement, name)) {
        const declared = exportedDeclaration(statement);
        if (declared?.type === "VariableDeclaration") {
          const declaration = declared.declarations.find(
            (item) => item.id.type === "Identifier" && item.id.name === name,
          );
          const init = declaration?.init ?? undefined;
          const value = init === undefined ? undefined : unwrapExpression(init);
          if (
            (value?.type === "Literal" && typeof value.value === "string") ||
            (value?.type === "TemplateLiteral" &&
              value.expressions.length === 0)
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
      const exportList =
        (statement.type === "ExportNamedDeclaration" &&
          statement.declaration === null) ||
        statement.type === "ExportAllDeclaration";
      if (!exportList || statement.exportKind === "type") {
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
    ast: DeclarationSource,
    statement: ImportDeclaration,
    target: string,
  ): string[] {
    const defaultName = statement.specifiers.find(
      (specifier) => specifier.type === "ImportDefaultSpecifier",
    )?.local.name;
    const namespace = statement.specifiers.find(
      (specifier) => specifier.type === "ImportNamespaceSpecifier",
    );
    const named = statement.specifiers.flatMap((specifier) =>
      specifier.type === "ImportSpecifier" ? [specifier] : [],
    );
    if (
      defaultName !== undefined &&
      namespace === undefined &&
      named.length === 0 &&
      dispatchRegistrationOnly(ast, defaultName)
    ) {
      return [];
    }
    if (named.length !== 0 && defaultName === undefined) {
      const targets: string[] = [];
      for (const binding of named) {
        if (
          binding.importKind === "type" ||
          registrationOnly(ast, binding.local.name) ||
          dispatchRegistrationOnly(ast, binding.local.name)
        ) {
          continue;
        }
        const resolved = this.symbolModules(
          target,
          moduleExportName(binding.imported),
        );
        targets.push(...resolved);
      }
      return targets;
    }
    if (namespace !== undefined) {
      const { local: namespaceBinding } = namespace;
      const { name } = namespaceBinding;
      if (registrationOnly(ast, name)) {
        return [];
      }
      const members = new Set<string>();
      const dynamicReferences = new Set<Node>();
      walk(ast.parsed.program, (node, ancestors) => {
        if (identifierName(node) !== name || node === namespaceBinding) {
          return;
        }
        const parent = ancestors.at(-1);
        const member =
          parent?.type === "MemberExpression" && parent.object === node
            ? parent
            : undefined;
        if (
          member?.computed === false &&
          member.property.type === "Identifier"
        ) {
          members.add(member.property.name);
        } else if (
          member?.computed === true &&
          member.property.type === "Literal" &&
          typeof member.property.value === "string"
        ) {
          members.add(member.property.value);
        } else if (
          parent?.type === "JSXMemberExpression" &&
          parent.object === node
        ) {
          members.add(parent.property.name);
        } else {
          dynamicReferences.add(node);
        }
      });
      return dynamicReferences.size !== 0
        ? [target]
        : [...members].flatMap((member) => this.symbolModules(target, member));
    }
    return [target];
  }
  private dynamicTargets(ast: DeclarationSource): string[] {
    const targets: string[] = [];
    walk(ast.parsed.program, (node) => {
      if (dispatchRegistry(node)) {
        return "skip-children";
      }
      if (
        node.type === "ImportExpression" &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        const target = this.resolve(ast.fileName, node.source.value);
        if (target !== undefined) {
          targets.push(target);
        }
      }
      return undefined;
    });
    return targets;
  }
  dependencies(ast: DeclarationSource) {
    const cached = this.imports.get(ast.fileName);
    if (cached !== undefined) {
      return cached;
    }
    const missing: string[] = [];
    const result = { targets: this.dynamicTargets(ast), missing };
    for (const statement of statementsOf(ast)) {
      const source = runtimeImport(statement)
        ? statement.source
        : runtimeExportSource(statement);
      if (source === undefined) {
        continue;
      }
      const specifier = source.value;
      const target = this.resolve(ast.fileName, specifier);
      if (target === undefined) {
        if (localSourceImport(specifier)) {
          result.missing.push(
            `missing source import ${ast.fileName} -> ${specifier}`,
          );
        }
        continue;
      }
      if (statement.type === "ImportDeclaration") {
        result.targets.push(...this.importedTargets(ast, statement, target));
      } else {
        result.targets.push(target);
      }
    }
    this.imports.set(ast.fileName, result);
    return result;
  }
}

const exportedTableNames = (statements: readonly Statement[]) => {
  const names = new Set<string>();
  for (const statement of statements) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration"
    ) {
      continue;
    }
    walk(statement.declaration, (node) => {
      if (
        node.type !== "CallExpression" ||
        !(
          (node.callee.type === "MemberExpression" &&
            !node.callee.computed &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "pgTable") ||
          (node.callee.type === "Identifier" && node.callee.name === "pgTable")
        )
      ) {
        return;
      }
      const argument = node.arguments.at(0);
      if (argument?.type === "Literal" && typeof argument.value === "string") {
        names.add(argument.value);
      }
    });
  }
  return names;
};
type DispatchBoundary = NonNullable<
  NonNullable<FeatureRegistry[string]["ownership"]>["dispatchModules"]
>[number];

const isValidDispatchBoundary = (
  ast: DeclarationSource,
  boundary: DispatchBoundary,
) => {
  switch (boundary.type) {
    case "registry":
      return statementsOf(ast).some((statement) => {
        const declared = exportedDeclaration(statement);
        return (
          declaresSymbol(statement, boundary.registry) &&
          declared?.type === "VariableDeclaration" &&
          declared.declarations.some(
            (declaration) =>
              declaration.id.type === "Identifier" &&
              declaration.id.name === boundary.registry &&
              declaration.init !== null &&
              unwrapExpression(declaration.init).type === "ArrayExpression",
          )
        );
      });
    case "admitted": {
      let valid = false;
      const bindings = new Set<string>();
      for (const statement of statementsOf(ast)) {
        if (
          !runtimeImport(statement) ||
          statement.source.value !==
            (boundary.specifier ?? "@/api/mcp/feature-access")
        ) {
          continue;
        }
        for (const binding of statement.specifiers) {
          if (
            binding.type === "ImportSpecifier" &&
            binding.importKind !== "type" &&
            moduleExportName(binding.imported) === boundary.admission
          ) {
            bindings.add(binding.local.name);
          }
        }
      }
      walk(ast.parsed.program, (node) => {
        if (
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          bindings.has(node.callee.name)
        ) {
          valid = true;
        }
      });
      return valid;
    }
    default: {
      boundary satisfies never;
      return panic("Unknown dispatch ownership boundary");
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
  for (const [featureId, { ownership }] of Object.entries(registry)) {
    // A desktop feature is gated by the client from its served decision, so
    // it may own no API source at all.
    if (
      ownership === undefined &&
      DESKTOP_FEATURE_IDS.some(
        (desktopFeatureId) => desktopFeatureId === featureId,
      )
    ) {
      continue;
    }
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
    for (const file of [
      ...ownership.tableSchemaFiles,
      ...Object.keys(ownership.conditionalTableSchemas ?? {}),
    ]) {
      const ast = graph.sourceFile(file);
      if (ast === undefined) {
        continue;
      }
      const selectedSymbols = ownership.conditionalTableSchemas?.[file];
      const statements = statementsOf(ast);
      const selectedStatements =
        selectedSymbols === undefined
          ? statements
          : statements.filter((statement) =>
              selectedSymbols.some((symbol) =>
                declaresSymbol(statement, symbol),
              ),
            );
      for (const symbol of selectedSymbols ?? []) {
        if (
          !statements.some((statement) => declaresSymbol(statement, symbol))
        ) {
          violations.push({
            file,
            message: `feature ${featureId} owns a missing table symbol ${symbol}`,
          });
        }
      }
      for (const name of exportedTableNames(selectedStatements)) {
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
    for (const boundary of ownership.dispatchModules ?? []) {
      const ast = graph.sourceFile(boundary.module);
      if (ast === undefined) {
        violations.push({
          file: boundary.module,
          message: `feature ${featureId} owns a missing dispatch module`,
        });
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
const collectModuleUses = (
  ast: DeclarationSource,
  registry: FeatureRegistry,
  tables: ReturnType<typeof validateOwnership>["tables"],
): ModuleUse[] => {
  const uses: ModuleUse[] = [];
  walk(ast.parsed.program, (node) => {
    if (dispatchRegistry(node)) {
      return "skip-children";
    }
    if (
      node.type === "MemberExpression" &&
      node.object.type === "MemberExpression" &&
      memberName(node.object) === "query"
    ) {
      // `db.query.table` or `db.query["table"]`.
      let symbol = memberName(node);
      if (
        node.computed &&
        node.property.type === "Literal" &&
        typeof node.property.value === "string"
      ) {
        symbol = node.property.value;
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
    // String literals and each cooked piece of a template.
    let text: string | undefined;
    if (node.type === "Literal" && typeof node.value === "string") {
      text = node.value;
    } else if (node.type === "TemplateElement") {
      text = node.value.cooked ?? node.value.raw;
    }
    if (text !== undefined) {
      for (const { matcher, owners } of tables) {
        if (matcher.test(text)) {
          uses.push(...owners);
        }
      }
    }
    return undefined;
  });
  return uses;
};
type ModuleFacts = {
  boundary: (module: string) => ReadonlyMap<string, Requirement>;
  uses: (module: string, ast: DeclarationSource) => readonly ModuleUse[];
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
  const visitModule = (module: string) => {
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
      visitModule(target);
    }
    for (const [id, type] of modules.uses(module, ast)) {
      add(id, type);
    }
  };
  visitModule(file);
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
    if (
      declaration.id === undefined ||
      !Object.hasOwn(registry, declaration.id) ||
      !featurePrerequisiteClosure(registry, declaration.id).has(id)
    ) {
      violations.push({
        file,
        message: `source ownership requires featureAccess ${id}`,
      });
    } else if (
      declaration.id === id &&
      (!types.has(declaration.type) || types.size > 1)
    ) {
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
    const ast = parseDeclarationSource(file, source);
    walk(ast.parsed.program, (node) => {
      if (
        node.type !== "VariableDeclarator" ||
        !dispatchRegistry(node) ||
        node.init === null
      ) {
        return undefined;
      }
      const value = unwrapExpression(node.init);
      if (value.type !== "ObjectExpression") {
        return "skip-children";
      }
      for (const [index, property] of value.properties.entries()) {
        let initializer: Node | undefined;
        if (property.type === "SpreadElement") {
          initializer = property.argument;
        } else if (property.kind === "init" && !property.method) {
          // A shorthand entry's value is its name.
          initializer = property.value;
        }
        if (initializer === undefined) {
          entries.push({
            file,
            config: { featureAccess: "unsupported dispatch entry" },
          });
          continue;
        }
        const names = new Set<string>();
        walk(initializer, (child) => {
          const name = identifierName(child);
          if (name !== undefined) {
            names.add(name);
          }
        });
        const imports = statementsOf(ast)
          .filter(runtimeImport)
          .flatMap((statement) => {
            const named = statement.specifiers.flatMap((specifier) =>
              specifier.type === "ImportSpecifier" ? [specifier] : [],
            );
            if (named.length !== 0) {
              const selected = named.filter(
                (binding) =>
                  binding.importKind !== "type" &&
                  names.has(binding.local.name),
              );
              return selected.length === 0
                ? []
                : [
                    `import { ${selected.map((binding) => textOf(ast, binding)).join(", ")} } from ${textOf(ast, statement.source)};`,
                  ];
            }
            return statement.specifiers.some((specifier) =>
              names.has(specifier.local.name),
            )
              ? [textOf(ast, statement)]
              : [];
          })
          .join("\n");
        const entryFile = `${file}.dispatch-entry-${index}.ts`;
        entrySources.set(
          entryFile,
          `${imports}\nconst entry = ${textOf(ast, initializer)};`,
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
      return "skip-children";
    });
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
      for (const statement of task === undefined ? [] : statementsOf(task)) {
        if (
          statement.type !== "ExportNamedDeclaration" ||
          statement.declaration?.type !== "VariableDeclaration"
        ) {
          continue;
        }
        for (const declaration of statement.declaration.declarations) {
          if (
            declaration.id.type === "Identifier" &&
            declaration.id.name === "featureAccess" &&
            declaration.init !== null
          ) {
            featureId = literalProperty(declaration.init, "featureId");
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
