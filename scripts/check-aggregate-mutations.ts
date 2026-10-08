import { panic } from "better-result";
import { spawnSync } from "node:child_process";
/** Enumerates mutation route registrations without importing the API stack. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

const ROOT = path.resolve(import.meta.dir, "..");
const API = "apps/api/src/";
const SERVER = `${API}server.ts`;
const REGISTRY = `${API}lib/db/aggregate-lock.ts`;
const OWNER = `${API}lib/db/aggregate-mutation-declaration.ts`;
const BASELINE = "scripts/aggregate-mutations-baseline.json";
const MUTATIONS = new Set(["post", "put", "patch", "delete", "all"]);
const baselineSchema = v.array(
  v.object({
    key: v.string(),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
);
export type MutationBaseline = v.InferOutput<typeof baselineSchema>;
type SourceLoader = (file: string) => string | undefined;
export type MutationRegistration = {
  key: string;
  file: string;
  line: number;
  method: string;
  handler: string;
  declared: boolean;
};

type ResolveModuleOptions = { file: string; name: string };
const resolveModule = ({ file, name }: ResolveModuleOptions) => {
  let resolved: string | undefined;
  if (name.startsWith("@/api/")) {
    resolved = `${API}${name.slice("@/api/".length)}`;
  } else if (name.startsWith(".")) {
    resolved = path.posix.join(path.posix.dirname(file), name);
  }
  return resolved === undefined
    ? undefined
    : `${resolved.replace(/\.ts$/u, "")}.ts`;
};

type ParseSourceOptions = { file: string; source: string };
const parse = ({ file, source }: ParseSourceOptions) =>
  ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

type ValidateDeclarationOptions = {
  declaration: ts.ObjectLiteralExpression;
  source: ts.SourceFile;
  file: string;
  registry: ReadonlySet<string>;
};
const validateDeclaration = ({
  declaration,
  source,
  file,
  registry,
}: ValidateDeclarationOptions) => {
  const fields = new Map(
    declaration.properties
      .filter(ts.isPropertyAssignment)
      .map((field) => [field.name.getText(source), field.initializer]),
  );
  const type = fields.get("type");
  if (type === undefined || !ts.isStringLiteral(type)) {
    panic(`Missing mutation declaration type in ${file}`);
  }
  if (type.text === "independent") {
    const reason = fields.get("reason");
    if (
      reason === undefined ||
      !ts.isStringLiteral(reason) ||
      reason.text.trim() === ""
    ) {
      panic(`Missing mutation declaration reason in ${file}`);
    }
  } else if (type.text === "aggregate") {
    const aggregates = fields.get("aggregates");
    if (
      aggregates === undefined ||
      !ts.isArrayLiteralExpression(aggregates) ||
      aggregates.elements.length === 0 ||
      aggregates.elements.some((item) => !ts.isStringLiteral(item))
    ) {
      panic(`Missing literal aggregate registry names in ${file}`);
    }
    for (const aggregate of aggregates.elements) {
      if (!ts.isStringLiteral(aggregate) || !registry.has(aggregate.text)) {
        panic(
          `Unknown aggregate registry name in ${file}: ${aggregate.getText(source)}`,
        );
      }
    }
  } else {
    panic(`Unknown mutation declaration type in ${file}`);
  }
};

const readAggregateRegistry = (load: SourceLoader) => {
  const registry = new Set<string>();
  const registryContent = load(REGISTRY);
  if (registryContent !== undefined) {
    const registrySource = parse({ file: REGISTRY, source: registryContent });
    const collectRegistry = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "AGGREGATE_LOCKS" &&
        node.initializer !== undefined
      ) {
        const initializer = ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (!ts.isObjectLiteralExpression(initializer)) {
          panic("Aggregate registry requires a literal object");
        }
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property)) {
            panic("Aggregate registry cannot use computed spreads");
          }
          registry.add(
            ts.isStringLiteral(property.name)
              ? property.name.text
              : property.name.getText(registrySource),
          );
        }
      }
      ts.forEachChild(node, collectRegistry);
    };
    collectRegistry(registrySource);
  }
  return registry;
};

const createSourceAccess = (sourceLoader: SourceLoader) => {
  const contents = new Map<string, string | undefined>();
  const load: SourceLoader = (file) => {
    if (contents.has(file)) {
      return contents.get(file);
    }
    const content = sourceLoader(file);
    contents.set(file, content);
    return content;
  };
  const resolveSourceModule = ({ file, name }: ResolveModuleOptions) => {
    const local = resolveModule({ file, name });
    if (local !== undefined || !name.startsWith("@stll/")) {
      return local;
    }
    const [packageName, ...subpath] = name.slice("@stll/".length).split("/");
    if (packageName === undefined) {
      return undefined;
    }
    const directory = `packages/${packageName}`;
    const metadataContent = load(`${directory}/package.json`);
    if (metadataContent === undefined) {
      return undefined;
    }
    const metadata: unknown = JSON.parse(metadataContent);
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("exports" in metadata)
    ) {
      return undefined;
    }
    const exports = metadata.exports;
    const key = subpath.length === 0 ? "." : `./${subpath.join("/")}`;
    let target: unknown;
    if (typeof exports === "string") {
      target = exports;
    } else if (typeof exports === "object" && exports !== null) {
      target = Object.entries(exports)
        .find(([entry]) => entry === key)
        ?.at(1);
    }
    return typeof target === "string"
      ? path.posix.join(directory, target)
      : undefined;
  };
  type ResolveValueOptions = {
    node: ts.Expression;
    file: string;
    visited?: Set<string>;
  };
  type ResolvedValue = { node: ts.Expression; file: string } | undefined;
  const resolveValue = ({
    node,
    file,
    visited = new Set<string>(),
  }: ResolveValueOptions): ResolvedValue => {
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      return resolveValue({ node: node.expression, file, visited });
    }
    if (ts.isPropertyAccessExpression(node)) {
      const object = resolveValue({ node: node.expression, file, visited });
      if (object === undefined || !ts.isObjectLiteralExpression(object.node)) {
        return undefined;
      }
      for (const property of object.node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText() === node.name.text
        ) {
          return resolveValue({
            node: property.initializer,
            file: object.file,
            visited,
          });
        }
      }
      return undefined;
    }
    if (!ts.isIdentifier(node)) {
      return { node, file };
    }
    const key = `${file}#${node.text}`;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const content = load(file);
    if (content === undefined) {
      return undefined;
    }
    const source = parse({ file, source: content });
    return resolveBinding({ node, file, visited, source });
  };
  type ResolveBindingOptions = {
    node: ts.Identifier;
    file: string;
    visited: Set<string>;
    source: ts.SourceFile;
  };
  const resolveBinding = ({
    node,
    file,
    visited,
    source,
  }: ResolveBindingOptions): ResolvedValue => {
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const binding of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(binding.name) &&
            binding.name.text === node.text &&
            binding.initializer !== undefined
          ) {
            return resolveValue({ node: binding.initializer, file, visited });
          }
        }
      }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        const binding = statement.importClause.namedBindings.elements.find(
          (item) => item.name.text === node.text,
        );
        const target = resolveSourceModule({
          file,
          name: statement.moduleSpecifier.text,
        });
        if (binding !== undefined && target !== undefined) {
          return resolveValue({
            node: ts.factory.createIdentifier(
              binding.propertyName?.text ?? binding.name.text,
            ),
            file: target,
            visited,
          });
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const binding = statement.exportClause.elements.find(
          (item) => item.name.text === node.text,
        );
        const target = resolveSourceModule({
          file,
          name: statement.moduleSpecifier.text,
        });
        if (binding !== undefined && target !== undefined) {
          return resolveValue({
            node: ts.factory.createIdentifier(
              binding.propertyName?.text ?? binding.name.text,
            ),
            file: target,
            visited,
          });
        }
      }
    }
    return undefined;
  };
  const registry = readAggregateRegistry(load);
  return { load, resolveSourceModule, resolveValue, registry };
};

type SourceAccess = ReturnType<typeof createSourceAccess>;

const elysiaConstructorNames = (source: ts.SourceFile) => {
  const names = new Set(["Elysia"]);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "elysia"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      names.add(clause.name.text);
    }
    if (
      clause?.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings)
    ) {
      for (const item of clause.namedBindings.elements) {
        if ((item.propertyName?.text ?? item.name.text) === "Elysia") {
          names.add(item.name.text);
        }
      }
    }
  }
  return names;
};

const producesRoutes = (source: ts.SourceFile) => {
  const names = elysiaConstructorNames(source);
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

type RouteReceiverOptions = {
  source: ts.SourceFile;
  elysiaNames: ReadonlySet<string>;
};
const createRouteReceiver = ({ source, elysiaNames }: RouteReceiverOptions) => {
  const variables = new Map<string, ts.Expression>();
  const collectVariables = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      variables.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectVariables);
  };
  collectVariables(source);
  const isRouteReceiver = (
    node: ts.Expression,
    visited = new Set<string>(),
  ): boolean => {
    if (
      ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return isRouteReceiver(node.expression, visited);
    }
    if (ts.isNewExpression(node)) {
      return (
        ts.isIdentifier(node.expression) &&
        elysiaNames.has(node.expression.text)
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      return isRouteReceiver(node.expression.expression, visited);
    }
    if (!ts.isIdentifier(node) || visited.has(node.text)) {
      return false;
    }
    visited.add(node.text);
    const initializer = variables.get(node.text);
    if (initializer !== undefined) {
      return isRouteReceiver(initializer, visited);
    }
    let ancestor = node.parent;
    while (!ts.isSourceFile(ancestor)) {
      if (
        (ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)) &&
        ancestor.parameters.some(
          (parameter) =>
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === node.text,
        )
      ) {
        const parent = ancestor.parent;
        if (
          ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression)
        ) {
          return isRouteReceiver(parent.expression.expression, visited);
        }
      }
      ancestor = ancestor.parent;
    }
    return false;
  };
  return isRouteReceiver;
};

type BindingOptions = {
  source: ts.SourceFile;
  file: string;
  access: SourceAccess;
  pending: string[];
};
const collectBindings = ({
  source,
  file,
  access: { load, resolveSourceModule },
  pending,
}: BindingOptions) => {
  const bindings = new Map<string, string>();
  const declarationNames = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveSourceModule({
        file,
        name: statement.moduleSpecifier.text,
      });
      const clause = statement.importClause;
      if (clause?.name !== undefined && target !== undefined) {
        bindings.set(clause.name.text, target);
      }
      if (
        clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const item of clause.namedBindings.elements) {
          if (target !== undefined) {
            bindings.set(
              item.name.text,
              `${target}#${item.propertyName?.text ?? item.name.text}`,
            );
          }
          if (
            target === OWNER &&
            (item.propertyName?.text ?? item.name.text) ===
              "declareAggregateMutation"
          ) {
            declarationNames.add(item.name.text);
          }
        }
      }
      if (
        clause?.namedBindings !== undefined &&
        ts.isNamespaceImport(clause.namedBindings) &&
        target !== undefined
      ) {
        bindings.set(clause.namedBindings.name.text, target);
      }
      if (target !== undefined && target !== OWNER) {
        const producerContent = load(target);
        if (
          producerContent !== undefined &&
          producesRoutes(parse({ file: target, source: producerContent }))
        ) {
          pending.push(target);
        }
      }
    }
  }
  return { bindings, declarationNames };
};

type IdentityOptions = {
  source: ts.SourceFile;
  file: string;
  bindings: ReadonlyMap<string, string>;
};
const createHandlerIdentity = ({ source, file, bindings }: IdentityOptions) => {
  const identity = (handler: ts.Expression) => {
    if (
      ts.isPropertyAccessExpression(handler) &&
      ts.isIdentifier(handler.expression)
    ) {
      return `${bindings.get(handler.expression.text) ?? `${file}#${handler.expression.text}`}.${handler.name.text}`;
    }
    if (ts.isIdentifier(handler)) {
      return bindings.get(handler.text) ?? `${file}#${handler.text}`;
    }
    return handler.getText(source).replace(/\s+/gu, " ");
  };
  return identity;
};

type SourceReferenceOptions = {
  source: ts.SourceFile;
  file: string;
  name: string;
  access: SourceAccess;
};
const importedReference = ({
  source,
  file,
  name,
  access,
}: SourceReferenceOptions) => {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const module = access.resolveSourceModule({
      file,
      name: statement.moduleSpecifier.text,
    });
    const clause = statement.importClause;
    if (clause?.name?.text === name) {
      return { module, exported: "default" };
    }
    if (
      clause?.namedBindings === undefined ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      continue;
    }
    const binding = clause.namedBindings.elements.find(
      (item) => item.name.text === name,
    );
    if (binding !== undefined) {
      return {
        module,
        exported: binding.propertyName?.text ?? binding.name.text,
      };
    }
  }
  return undefined;
};

type HandlerImplementationOptions = {
  handler: ts.Expression;
  source: ts.SourceFile;
  file: string;
  access: SourceAccess;
  visited?: Set<string>;
};
type HandlerImplementation =
  | { body: ts.Node; source: ts.SourceFile; file: string }
  | undefined;
const handlerImplementation = ({
  handler,
  source,
  file,
  access,
  visited = new Set<string>(),
}: HandlerImplementationOptions): HandlerImplementation => {
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
    return { body: handler.body, source, file };
  }
  if (ts.isParenthesizedExpression(handler) || ts.isAsExpression(handler)) {
    return handlerImplementation({
      handler: handler.expression,
      source,
      file,
      access,
      visited,
    });
  }
  if (
    ts.isPropertyAccessExpression(handler) &&
    handler.name.text === "handler"
  ) {
    return handlerImplementation({
      handler: handler.expression,
      source,
      file,
      access,
      visited,
    });
  }
  if (ts.isCallExpression(handler) && ts.isIdentifier(handler.expression)) {
    const factory = importedReference({
      source,
      file,
      name: handler.expression.text,
      access,
    });
    const callback = handler.arguments.at(1);
    if (
      factory?.module !== `${API}lib/api-handlers.ts` ||
      callback === undefined
    ) {
      return undefined;
    }
    return handlerImplementation({
      handler: callback,
      source,
      file,
      access,
      visited,
    });
  }
  if (!ts.isIdentifier(handler)) {
    return undefined;
  }
  const key = `${file}#${handler.text}`;
  if (visited.has(key)) {
    return undefined;
  }
  visited.add(key);
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === handler.text &&
      statement.body !== undefined
    ) {
      return { body: statement.body, source, file };
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const variable = statement.declarationList.declarations.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === handler.text,
    );
    if (variable?.initializer !== undefined) {
      return handlerImplementation({
        handler: variable.initializer,
        source,
        file,
        access,
        visited,
      });
    }
  }
  const imported = importedReference({
    source,
    file,
    name: handler.text,
    access,
  });
  if (imported?.module === undefined) {
    return undefined;
  }
  const content = access.load(imported.module);
  if (content === undefined) {
    return undefined;
  }
  const importedSource = parse({ file: imported.module, source: content });
  let exported = ts.factory.createIdentifier(imported.exported);
  if (imported.exported === "default") {
    const assignment = importedSource.statements.find(ts.isExportAssignment);
    if (assignment === undefined || !ts.isIdentifier(assignment.expression)) {
      return undefined;
    }
    exported = assignment.expression;
  }
  return handlerImplementation({
    handler: exported,
    source: importedSource,
    file: imported.module,
    access,
    visited,
  });
};

type AwaitedAggregateOptions = {
  implementation: Exclude<HandlerImplementation, undefined>;
  access: SourceAccess;
};
const awaitedAggregateNames = ({
  implementation: { body, source, file },
  access,
}: AwaitedAggregateOptions) => {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node)) {
      return;
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      (!ts.isCallExpression(node.parent) ||
        !node.parent.arguments.includes(node))
    ) {
      return;
    }
    if (
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const reference = importedReference({
        source,
        file,
        name: node.expression.expression.text,
        access,
      });
      const options = node.expression.arguments.at(0);
      if (
        reference?.module === REGISTRY &&
        reference.exported === "withAggregateLock" &&
        options !== undefined &&
        ts.isObjectLiteralExpression(options)
      ) {
        const aggregate = options.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === "aggregate",
        );
        if (
          aggregate !== undefined &&
          ts.isPropertyAssignment(aggregate) &&
          ts.isStringLiteral(aggregate.initializer)
        ) {
          names.add(aggregate.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
};

type DeclaredHandlerLocksOptions = ValidateDeclarationOptions & {
  handler: ts.Expression;
  access: SourceAccess;
};
const assertDeclaredHandlerLocks = ({
  declaration,
  handler,
  source,
  file,
  access,
}: DeclaredHandlerLocksOptions) => {
  const fields = new Map(
    declaration.properties
      .filter(ts.isPropertyAssignment)
      .map((field) => [field.name.getText(source), field.initializer]),
  );
  const type = fields.get("type");
  if (
    type !== undefined &&
    ts.isStringLiteral(type) &&
    type.text === "independent"
  ) {
    return;
  }
  const implementation = handlerImplementation({
    handler,
    source,
    file,
    access,
  });
  if (implementation === undefined) {
    panic(
      `Cannot resolve declared aggregate handler implementation in ${file}`,
    );
  }
  const held = awaitedAggregateNames({ implementation, access });
  const aggregates = fields.get("aggregates");
  if (aggregates === undefined || !ts.isArrayLiteralExpression(aggregates)) {
    panic(`Missing declared aggregate list in ${file}`);
  }
  for (const aggregate of aggregates.elements) {
    if (!ts.isStringLiteral(aggregate) || !held.has(aggregate.text)) {
      panic(
        `Declared handler must await withAggregateLock for ${aggregate.getText(source)} in ${file}`,
      );
    }
  }
};

type ImportedDeclarationOptions = {
  bindings: ReadonlyMap<string, string>;
  access: SourceAccess;
};
const collectImportedDeclarations = ({
  bindings,
  access,
}: ImportedDeclarationOptions) => {
  const { load, resolveSourceModule, registry } = access;
  const declared = new Set<string>();
  for (const target of bindings.values()) {
    const [module, exported = "default"] = target.split("#");
    if (module === undefined || !module.startsWith(API) || module === OWNER) {
      continue;
    }
    const ownerContent = load(module);
    if (ownerContent === undefined) {
      continue;
    }
    const ownerSource = parse({ file: module, source: ownerContent });
    const ownerHelpers = new Set<string>();
    let exportedBinding = exported === "default" ? undefined : exported;
    for (const statement of ownerSource.statements) {
      if (
        exported === "default" &&
        ts.isExportAssignment(statement) &&
        !statement.isExportEquals &&
        ts.isIdentifier(statement.expression)
      ) {
        exportedBinding = statement.expression.text;
      }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        resolveSourceModule({
          file: module,
          name: statement.moduleSpecifier.text,
        }) === OWNER &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        for (const item of statement.importClause.namedBindings.elements) {
          if (
            (item.propertyName?.text ?? item.name.text) ===
            "declareAggregateMutation"
          ) {
            ownerHelpers.add(item.name.text);
          }
        }
      }
    }
    const visitOwner = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ownerHelpers.has(node.expression.text)
      ) {
        const handler = node.arguments.at(0);
        const declaration = node.arguments.at(1);
        if (
          handler !== undefined &&
          exportedBinding !== undefined &&
          handler.getText(ownerSource) === `${exportedBinding}.handler` &&
          declaration !== undefined &&
          ts.isObjectLiteralExpression(declaration)
        ) {
          validateDeclaration({
            declaration,
            source: ownerSource,
            file: module,
            registry,
          });
          assertDeclaredHandlerLocks({
            declaration,
            handler,
            source: ownerSource,
            file: module,
            registry,
            access,
          });
          declared.add(`${target}.handler`);
        }
      }
      ts.forEachChild(node, visitOwner);
    };
    visitOwner(ownerSource);
  }
  return declared;
};

type LocalDeclarationOptions = {
  source: ts.SourceFile;
  file: string;
  registry: ReadonlySet<string>;
  declarationNames: ReadonlySet<string>;
  declared: Set<string>;
  identity: (handler: ts.Expression) => string;
  access: SourceAccess;
};
const collectLocalDeclarations = ({
  source,
  file,
  registry,
  declarationNames,
  declared,
  identity,
  access,
}: LocalDeclarationOptions) => {
  const declarationCall = (node: ts.CallExpression) =>
    ts.isIdentifier(node.expression) &&
    declarationNames.has(node.expression.text);
  const collectDeclarations = (node: ts.Node) => {
    if (ts.isCallExpression(node) && declarationCall(node)) {
      const handler = node.arguments.at(0);
      const declaration = node.arguments.at(1);
      if (
        handler === undefined ||
        declaration === undefined ||
        !ts.isObjectLiteralExpression(declaration)
      ) {
        panic(`Invalid aggregate mutation declaration in ${file}`);
      }
      validateDeclaration({ declaration, source, file, registry });
      assertDeclaredHandlerLocks({
        declaration,
        handler,
        source,
        file,
        registry,
        access,
      });
      declared.add(identity(handler));
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(source);
  return declarationCall;
};

type RouteContext = {
  source: ts.SourceFile;
  file: string;
  access: SourceAccess;
  pending: string[];
  registrations: MutationRegistration[];
  bindings: ReadonlyMap<string, string>;
  declared: ReadonlySet<string>;
  identity: (handler: ts.Expression) => string;
  declarationCall: (node: ts.CallExpression) => boolean;
  isRouteReceiver: (node: ts.Expression) => boolean;
};
type RegistrationOptions = { node: ts.CallExpression; context: RouteContext };
const appendMutationRegistration = ({
  node,
  context: {
    source,
    file,
    access: { resolveValue },
    registrations,
    isRouteReceiver,
    identity,
    declarationCall,
    declared,
  },
}: RegistrationOptions) => {
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    MUTATIONS.has(node.expression.name.text) &&
    isRouteReceiver(node.expression.expression)
  ) {
    const route = node.arguments.at(0);
    const handler = node.arguments.at(1);
    // SQL delete(table) and ordinary collections are not route registrations.
    if (handler !== undefined && route !== undefined) {
      const resolved = resolveValue({ node: route, file });
      if (resolved === undefined || !ts.isStringLiteralLike(resolved.node)) {
        panic(
          `Dynamic mutation route path in ${file}: ${route.getText(source)}`,
        );
      }
      const localPath = resolved.node.text;
      const actual =
        ts.isCallExpression(handler) && declarationCall(handler)
          ? handler.arguments.at(0)
          : handler;
      if (actual === undefined) {
        panic(`Missing declared route handler in ${file}`);
      }
      const handlerIdentity = identity(actual);
      const method = node.expression.name.text.toUpperCase();
      registrations.push({
        key: `${file}|${method}|${localPath}|${handlerIdentity}`,
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        method,
        handler: handlerIdentity,
        declared: declared.has(handlerIdentity),
      });
    }
  }
};

const appendInterceptorRegistrations = ({
  node,
  context: { source, file, bindings, registrations },
}: RegistrationOptions) => {
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "onRequest"
  ) {
    const collectInterceptor = (argument: ts.Node) => {
      if (ts.isCallExpression(argument)) {
        const expression = argument.expression;
        let target: string | undefined;
        if (ts.isIdentifier(expression)) {
          target = bindings.get(expression.text);
        } else if (
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression)
        ) {
          target = bindings.get(expression.expression.text);
        }
        if (target?.startsWith(`${API}handlers/`)) {
          registrations.push({
            key: `${file}|INTERCEPT|${target}`,
            file,
            line:
              source.getLineAndCharacterOfPosition(argument.getStart(source))
                .line + 1,
            method: "INTERCEPT",
            handler: target,
            declared: false,
          });
        }
      }
      ts.forEachChild(argument, collectInterceptor);
    };
    for (const argument of node.arguments) {
      collectInterceptor(argument);
    }
  }
};

const enumerateModuleRegistrations = (context: RouteContext) => {
  const {
    source,
    file,
    access: { resolveSourceModule },
    pending,
    registrations,
    bindings,
    isRouteReceiver,
  } = context;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments.at(0);
        if (specifier !== undefined && ts.isStringLiteral(specifier)) {
          const target = resolveSourceModule({ file, name: specifier.text });
          if (target !== undefined) {
            pending.push(target);
          }
        }
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "use"
      ) {
        const collectProducer = (argument: ts.Node) => {
          if (ts.isIdentifier(argument)) {
            const target = bindings.get(argument.text)?.split("#").at(0);
            if (target !== undefined && target !== OWNER) {
              pending.push(target);
            }
          }
          ts.forEachChild(argument, collectProducer);
        };
        for (const argument of node.arguments) {
          collectProducer(argument);
        }
      }
      appendInterceptorRegistrations({ node, context });
      appendMutationRegistration({ node, context });
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "route" &&
        isRouteReceiver(node.expression.expression)
      ) {
        const signature = node.arguments
          .map((argument) => argument.getText(source).replace(/\s+/gu, " "))
          .join("|");
        registrations.push({
          key: `${file}|GENERIC|${signature}`,
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          method: "GENERIC",
          handler: signature,
          declared: false,
        });
      }
      if (
        ts.isElementAccessExpression(node.expression) &&
        isRouteReceiver(node.expression.expression)
      ) {
        panic(
          `Computed route registration requires an explicit aggregate coverage implementation in ${file}`,
        );
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "mount" &&
        isRouteReceiver(node.expression.expression)
      ) {
        const handler = node.arguments.at(0);
        if (handler !== undefined) {
          registrations.push({
            key: `${file}|MOUNT|${handler.getText(source)}`,
            file,
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            method: "MOUNT",
            handler: handler.getText(source),
            declared: false,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};

/** Includes local-dev imports and nested route factories; never initializes them. */
export const enumerateAggregateMutations = (
  sourceLoader: SourceLoader,
): MutationRegistration[] => {
  const access = createSourceAccess(sourceLoader);
  const pending = [SERVER];
  const seen = new Set<string>();
  const registrations: MutationRegistration[] = [];
  while (pending.length !== 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const content = access.load(file);
    if (content === undefined) {
      panic(`Cannot enumerate route module ${file}`);
    }
    const source = parse({ file, source: content });
    const { bindings, declarationNames } = collectBindings({
      source,
      file,
      access,
      pending,
    });
    const isRouteReceiver = createRouteReceiver({
      source,
      elysiaNames: elysiaConstructorNames(source),
    });
    const identity = createHandlerIdentity({ source, file, bindings });
    const declared = collectImportedDeclarations({ bindings, access });
    const declarationCall = collectLocalDeclarations({
      source,
      file,
      registry: access.registry,
      declarationNames,
      declared,
      identity,
      access,
    });
    enumerateModuleRegistrations({
      source,
      file,
      access,
      pending,
      registrations,
      bindings,
      isRouteReceiver,
      identity,
      declared,
      declarationCall,
    });
  }
  return registrations.toSorted((a, b) => compareCodeUnit(a.key, b.key));
};

export const checkAggregateMutationCoverage = ({
  registrations,
  baseline,
  previous,
}: {
  registrations: readonly MutationRegistration[];
  baseline: MutationBaseline;
  previous: MutationBaseline;
}): string[] => {
  const errors: string[] = [];
  const current = new Map(baseline.map((entry) => [entry.key, entry.reason]));
  const prior = new Map(previous.map((entry) => [entry.key, entry.reason]));
  if (current.size !== baseline.length) {
    errors.push("Duplicate aggregate mutation baseline entries");
  }
  const needed = new Set(
    registrations.filter((route) => !route.declared).map((route) => route.key),
  );
  for (const entry of baseline) {
    if (entry.reason.trim() === "") {
      errors.push(`Reason required: ${entry.key}`);
    }
    if (!needed.has(entry.key)) {
      errors.push(`Stale aggregate mutation baseline entry: ${entry.key}`);
    }
    if (prior.get(entry.key) !== entry.reason) {
      errors.push(`Aggregate mutation baseline may only shrink: ${entry.key}`);
    }
  }
  for (const key of needed) {
    if (!current.has(key)) {
      errors.push(`Undeclared aggregate mutation: ${key}`);
    }
  }
  return errors;
};

const legacyReason = (route: MutationRegistration) => {
  switch (route.method) {
    case "MOUNT":
      return "Better Auth owns generated authentication mutations behind the mounted request handler.";
    case "GENERIC":
      return "Derived rate-limit classification router built from the existing route table; no handler execution.";
    case "INTERCEPT":
      return `Request dispatch is owned by ${route.handler}; its transport boundary requires separate ownership enumeration.`;
    default:
      return `Existing ${route.method} route ${route.handler} awaits ownership declaration at its handler boundary.`;
  }
};

const aggregateMutationComparisonCommit = () => {
  const requested =
    process.env["BASE_SHA"] ?? process.env["BASE_REF"] ?? "origin/main";
  const resolved = spawnSync(
    "git",
    ["rev-parse", "--verify", `${requested}^{commit}`],
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (resolved.status !== 0) {
    panic(`Aggregate mutation comparison ref is unavailable: ${requested}`);
  }
  if (process.env["BASE_SHA"] !== undefined) {
    return resolved.stdout.trim();
  }
  const base = spawnSync(
    "git",
    ["merge-base", "HEAD", resolved.stdout.trim()],
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (base.status !== 0) {
    panic(
      `Cannot resolve aggregate mutation comparison merge-base: ${requested}`,
    );
  }
  return base.stdout.trim();
};

if (import.meta.main) {
  const comparisonCommit = aggregateMutationComparisonCommit();
  const load: SourceLoader = (file) =>
    existsSync(path.join(ROOT, file))
      ? readFileSync(path.join(ROOT, file), "utf-8")
      : undefined;
  const registrations = enumerateAggregateMutations(load);
  if (process.argv.includes("--generate")) {
    const existing = spawnSync(
      "git",
      ["cat-file", "-e", `${comparisonCommit}:${BASELINE}`],
      { cwd: ROOT, encoding: "utf-8" },
    );
    if (existing.status === 0) {
      panic(
        "The aggregate mutation baseline is shrink-only; generation is initial-only",
      );
    }
    writeFileSync(
      path.join(ROOT, BASELINE),
      `${JSON.stringify(
        registrations
          .filter((route) => !route.declared)
          .map((route) => ({ key: route.key, reason: legacyReason(route) })),
        null,
        2,
      )}\n`,
    );
  } else {
    const baseline = v.parse(
      baselineSchema,
      JSON.parse(readFileSync(path.join(ROOT, BASELINE), "utf-8")),
    );
    const base = spawnSync("git", ["show", `${comparisonCommit}:${BASELINE}`], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    // On introduction, bind the generated inventory to the base route source tree.
    const previous =
      base.status === 0
        ? v.parse(baselineSchema, JSON.parse(base.stdout))
        : enumerateAggregateMutations((file) => {
            const result = spawnSync(
              "git",
              ["show", `${comparisonCommit}:${file}`],
              {
                cwd: ROOT,
                encoding: "utf-8",
              },
            );
            return result.status === 0 ? result.stdout : undefined;
          })
            .filter((route) => !route.declared)
            .map((route) => ({ key: route.key, reason: legacyReason(route) }));
    const errors = checkAggregateMutationCoverage({
      registrations,
      baseline,
      previous,
    });
    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }
    process.stdout.write(
      `Aggregate mutation coverage: ${registrations.length} registrations, ${baseline.length} legacy entries\n`,
    );
    if (errors.length !== 0) {
      process.exitCode = 1;
    }
  }
}
