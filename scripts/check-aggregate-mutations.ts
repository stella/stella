// Aggregate ownership of every mutation the API serves.
//
// Two halves, each exact:
//
//   - Routes. The route table the API serves (`apiRoutes`) is read as data:
//     every POST, PUT, PATCH and DELETE route's definition either carries an
//     ownership declaration (`declareAggregateMutation`, keyed by definition)
//     or sits in the reasoned, shrink-only baseline, keyed by method and path.
//   - Declarations. Every `declareAggregateMutation` call site in the API
//     source is verified statically: it imports the owner by name and calls
//     it directly with a literal declaration, every aggregate exists in the
//     lock registry, and the declared handler awaits the lock for each one,
//     itself or through a joined direct callee. The owner's registry is only
//     written by those calls, so a route the table reports declared has a
//     verified declaration.
import { panic } from "better-result";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import {
  type Argument,
  type ArrowFunctionExpression,
  type BindingProperty,
  type CallExpression,
  type Expression,
  type Function as SyntaxFunction,
  type Node,
  type ObjectExpression,
  type ObjectProperty as Property,
  type ParsedSource,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { BASELINE_PATHS } from "./baseline-paths";

type Identifier = Extract<Node, { type: "Identifier" }>;

const ROOT = path.resolve(import.meta.dir, "..");
const API = "apps/api/src/";
const REGISTRY = `${API}lib/db/aggregate-lock.ts`;
const OWNER = `${API}lib/db/aggregate-mutation-declaration.ts`;
const DECLARE = "declareAggregateMutation";
const BASELINE = BASELINE_PATHS.aggregateMutations;
const baselineSchema = v.array(
  v.object({
    key: v.string(),
    count: v.pipe(v.number(), v.integer(), v.minValue(1)),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
);
export type MutationBaseline = v.InferOutput<typeof baselineSchema>;
type SourceLoader = (file: string) => string | undefined;

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

type SourceTree = ParsedSource & { fileName: string };
type Callable = SyntaxFunction | ArrowFunctionExpression;
const contexts = new WeakMap<
  Node,
  { parent: Node | undefined; source: SourceTree }
>();
const parentOf = (node: Node) => contexts.get(node)?.parent;
const sourceOf = (node: Node) =>
  contexts.get(node)?.source ?? panic("Missing syntax source context");
const nodeText = (node: Node, source = sourceOf(node)) =>
  source.sourceText.slice(node.start, node.end);
// An array hole (`[a, , b]`) has no node; diagnostics name it instead.
const elementText = (element: Node | null, source: SourceTree) =>
  element === null ? "an empty array slot" : nodeText(element, source);
const isFunctionLike = (node: Node): node is Callable =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";
const isClassLike = (node: Node) =>
  node.type === "ClassDeclaration" || node.type === "ClassExpression";
const isPropertyAssignment = (node: Node): node is Property =>
  node.type === "Property" &&
  !node.method &&
  !node.shorthand &&
  node.kind === "init";
const isStringLiteral = (
  node: Node | null | undefined,
): node is Extract<Node, { type: "Literal" }> & { value: string } =>
  node?.type === "Literal" && typeof node.value === "string";
const visitChildren = (root: Node, visit: (node: Node) => void) => {
  walk(root, (node) => {
    if (node !== root) {
      visit(node);
      return "skip-children";
    }
    return undefined;
  });
};
const statementsOf = (source: SourceTree) =>
  source.program.body.map((statement) =>
    (statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration") &&
    statement.declaration &&
    (statement.declaration.type === "FunctionDeclaration" ||
      statement.declaration.type === "ClassDeclaration" ||
      statement.type === "ExportNamedDeclaration")
      ? statement.declaration
      : statement,
  );
type ParseSourceOptions = { file: string; source: string };
const parse = ({ file, source }: ParseSourceOptions) => {
  const parsed = { ...parseSource(file, source), fileName: file };
  walk(parsed.program, (node, ancestors) => {
    contexts.set(node, { parent: ancestors.at(-1), source: parsed });
  });
  return parsed;
};

type ValidateDeclarationOptions = {
  declaration: ObjectExpression;
  source: SourceTree;
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
      .filter(isPropertyAssignment)
      .map((field) => [nodeText(field.key, source), field.value]),
  );
  const type = fields.get("type");
  if (type === undefined || !isStringLiteral(type)) {
    panic(`Missing mutation declaration type in ${file}`);
  }
  if (type.value === "independent") {
    const reason = fields.get("reason");
    if (
      reason === undefined ||
      !isStringLiteral(reason) ||
      reason.value.trim() === ""
    ) {
      panic(`Missing mutation declaration reason in ${file}`);
    }
  } else if (type.value === "aggregate") {
    const aggregates = fields.get("aggregates");
    if (
      aggregates === undefined ||
      !(aggregates.type === "ArrayExpression") ||
      aggregates.elements.length === 0 ||
      aggregates.elements.some((item) => !isStringLiteral(item))
    ) {
      panic(`Missing literal aggregate registry names in ${file}`);
    }
    for (const aggregate of aggregates.elements) {
      if (!isStringLiteral(aggregate) || !registry.has(aggregate.value)) {
        panic(
          `Unknown aggregate registry name in ${file}: ${elementText(aggregate, source)}`,
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
    const collectRegistry = (node: Node) => {
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.id.name === "AGGREGATE_LOCKS" &&
        node.init !== null
      ) {
        const initializer =
          node.init.type === "TSAsExpression"
            ? node.init.expression
            : node.init;
        if (!(initializer.type === "ObjectExpression")) {
          panic("Aggregate registry requires a literal object");
        }
        for (const property of initializer.properties) {
          if (!isPropertyAssignment(property)) {
            panic("Aggregate registry cannot use computed spreads");
          }
          registry.add(
            isStringLiteral(property.key)
              ? property.key.value
              : nodeText(property.key, registrySource),
          );
        }
      }
      visitChildren(node, collectRegistry);
    };
    collectRegistry(registrySource.program);
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
  const registry = readAggregateRegistry(load);
  return { load, resolveSourceModule, registry };
};

type SourceAccess = ReturnType<typeof createSourceAccess>;

type SourceReferenceOptions = {
  source: SourceTree;
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
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const specifier = statement.source.value;
    const module = access.resolveSourceModule({ file, name: specifier });
    const binding = statement.specifiers.find(
      (item) => item.local.name === name,
    );
    if (!binding || binding.type === "ImportNamespaceSpecifier") {
      continue;
    }
    if (
      statement.importKind === "type" ||
      (binding.type === "ImportSpecifier" && binding.importKind === "type")
    ) {
      return undefined;
    }
    let exported = "default";
    if (binding.type === "ImportSpecifier") {
      exported =
        binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value;
    }
    return { module, specifier, exported };
  }
  return undefined;
};

type HandlerImplementationOptions = {
  handler: Argument;
  source: SourceTree;
  file: string;
  access: SourceAccess;
  visited?: Set<string>;
};
type HandlerImplementation =
  { body: Node; source: SourceTree; file: string } | undefined;
/** The handler constructor call a local factory returns, as its arrow body or only statement. */
const factoryReturn = (node: Callable): CallExpression | undefined => {
  const { body } = node;
  if (body === null) {
    return undefined;
  }
  if (body.type === "CallExpression") {
    return body;
  }
  if (!(body.type === "BlockStatement") || body.body.length !== 1) {
    return undefined;
  }
  const [statement] = body.body;
  return statement?.type === "ReturnStatement" &&
    statement.argument?.type === "CallExpression"
    ? statement.argument
    : undefined;
};

const handlerImplementation = ({
  handler,
  source,
  file,
  access,
  visited = new Set<string>(),
}: HandlerImplementationOptions): HandlerImplementation => {
  if (
    handler.type === "ArrowFunctionExpression" ||
    handler.type === "FunctionExpression"
  ) {
    if (handler.body === null) {
      return undefined;
    }
    return { body: handler.body, source, file };
  }
  if (
    handler.type === "ParenthesizedExpression" ||
    handler.type === "TSAsExpression"
  ) {
    return handlerImplementation({
      handler: handler.expression,
      source,
      file,
      access,
      visited,
    });
  }
  if (
    handler.type === "MemberExpression" &&
    !handler.computed &&
    handler.property.type === "Identifier" &&
    handler.property.name === "handler"
  ) {
    return handlerImplementation({
      handler: handler.object,
      source,
      file,
      access,
      visited,
    });
  }
  if (
    handler.type === "CallExpression" &&
    handler.callee.type === "Identifier"
  ) {
    const factory = trustedBinding({
      identifier: handler.callee,
      access,
    });
    // A local endpoint factory (dependencies injectable for tests) is
    // followed to the handler constructor call it returns.
    const returned =
      factory?.kind === "function" ? factoryReturn(factory.node) : undefined;
    if (returned !== undefined) {
      const key = `${file}#${handler.callee.name}()`;
      if (visited.has(key)) {
        return undefined;
      }
      visited.add(key);
      return handlerImplementation({
        handler: returned,
        source,
        file,
        access,
        visited,
      });
    }
    if (
      factory?.kind !== "import" ||
      factory.module !== `${API}lib/api-handlers.ts`
    ) {
      return undefined;
    }
    // Optional dependencies may follow the callback. Its position belongs to
    // the actual constructor contract, including the token verifier parameter.
    const contractSource = access.load(factory.module);
    if (contractSource === undefined) {
      return undefined;
    }
    const contract = trustedTopLevel({
      name: factory.exported,
      source: parse({ file: factory.module, source: contractSource }),
      access,
    });
    if (contract?.kind !== "function") {
      return undefined;
    }
    const handlerPosition = contract.node.params.findIndex(
      (parameter) =>
        parameter.type === "Identifier" && parameter.name === "handler",
    );
    const callback =
      handlerPosition === -1
        ? undefined
        : handler.arguments.at(handlerPosition);
    if (callback === undefined) {
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
  if (!(handler.type === "Identifier")) {
    return undefined;
  }
  const key = `${file}#${handler.name}`;
  if (visited.has(key)) {
    return undefined;
  }
  visited.add(key);
  return bindingImplementation({
    binding: trustedBinding({ identifier: handler, access }),
    source,
    file,
    access,
    visited,
  });
};

type BindingImplementationOptions = Omit<
  HandlerImplementationOptions,
  "handler"
> & {
  binding: TrustedBinding | undefined;
  visited: Set<string>;
};
/** The handler implementation a trusted top-level binding resolves to. */
const bindingImplementation = ({
  binding,
  source,
  file,
  access,
  visited,
}: BindingImplementationOptions): HandlerImplementation => {
  if (binding?.kind === "function") {
    return { body: binding.body, source, file };
  }
  if (binding?.kind === "const") {
    return handlerImplementation({
      handler: binding.initializer,
      source,
      file,
      access,
      visited,
    });
  }
  if (binding?.kind !== "import" || binding.module === undefined) {
    return undefined;
  }
  const content = access.load(binding.module);
  if (content === undefined) {
    return undefined;
  }
  const target = parse({ file: binding.module, source: content });
  if (binding.exported === "default") {
    const assignment = target.program.body.find(
      (statement) => statement.type === "ExportDefaultDeclaration",
    );
    return assignment?.declaration.type !== "Identifier"
      ? undefined
      : handlerImplementation({
          handler: assignment.declaration,
          source: target,
          file: binding.module,
          access,
          visited,
        });
  }
  const key = `${binding.module}#${binding.exported}`;
  if (visited.has(key)) {
    return undefined;
  }
  visited.add(key);
  return bindingImplementation({
    binding: trustedTopLevel({
      name: binding.exported,
      source: target,
      access,
    }),
    source: target,
    file: binding.module,
    access,
    visited,
  });
};

const bindingNames = (name: Node, names: Set<string>) => {
  if (name.type === "Identifier") {
    names.add(name.name);
    return;
  }
  if (name.type === "AssignmentPattern") {
    bindingNames(name.left, names);
    return;
  }
  if (name.type === "RestElement") {
    bindingNames(name.argument, names);
    return;
  }
  if (name.type === "ArrayPattern") {
    for (const element of name.elements) {
      if (element) {
        bindingNames(element, names);
      }
    }
  }
  if (name.type === "ObjectPattern") {
    for (const property of name.properties) {
      bindingNames(
        property.type === "RestElement" ? property.argument : property.value,
        names,
      );
    }
  }
};
const statementNames = (statement: Node, names: Set<string>) => {
  if (statement.type === "VariableDeclaration") {
    for (const declaration of statement.declarations) {
      bindingNames(declaration.id, names);
    }
  } else if (
    (statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration") &&
    statement.id
  ) {
    names.add(statement.id.name);
  } else if (statement.type === "TSEnumDeclaration") {
    names.add(statement.id.name);
  }
};
/** `var` declarations hoist to the function, whatever block they sit in. */
const hoistedVarNames = (node: Node, names: Set<string>) => {
  if (isFunctionLike(node) || isClassLike(node)) {
    return;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const declaration of node.declarations) {
      bindingNames(declaration.id, names);
    }
  }
  visitChildren(node, (child) => hoistedVarNames(child, names));
};
type ScopeNames = { names: Set<string>; parameters: Set<string> };
const scopeNames = (scope: Node): ScopeNames => {
  const names = new Set<string>();
  const parameters = new Set<string>();
  if (isFunctionLike(scope)) {
    for (const parameter of scope.params) {
      bindingNames(parameter, parameters);
      bindingNames(parameter, names);
    }
    if (scope.type === "FunctionExpression" && scope.id) {
      names.add(scope.id.name);
    }
    if (scope.body) {
      const hoisted = new Set<string>();
      hoistedVarNames(scope.body, hoisted);
      for (const name of hoisted) {
        names.add(name);
        parameters.delete(name);
      }
    }
  }
  if (scope.type === "BlockStatement" || scope.type === "TSModuleBlock") {
    for (const statement of scope.body) {
      statementNames(statement, names);
    }
  }
  if (scope.type === "SwitchStatement") {
    for (const clause of scope.cases) {
      for (const statement of clause.consequent) {
        statementNames(statement, names);
      }
    }
  }
  let initializer: Node | null | undefined;
  if (scope.type === "ForStatement") {
    initializer = scope.init;
  } else if (
    scope.type === "ForInStatement" ||
    scope.type === "ForOfStatement"
  ) {
    initializer = scope.left;
  }
  if (initializer?.type === "VariableDeclaration") {
    for (const declaration of initializer.declarations) {
      bindingNames(declaration.id, names);
    }
  }
  if (scope.type === "CatchClause" && scope.param) {
    bindingNames(scope.param, names);
  }
  return { names, parameters };
};

/**
 * The nearest scope enclosing `node` (below the module top level, and below
 * `stop` when given) that binds `name`; undefined when only the module's
 * top-level imports and definitions can bind it.
 */
const bindingScope = (node: Node, name: string, stop?: Node) => {
  let child = node;
  for (
    let scope = parentOf(node);
    scope !== undefined && scope.type !== "Program" && scope !== stop;
    scope = parentOf(scope)
  ) {
    if (
      !(scope.type === "SwitchStatement" && scope.discriminant === child) &&
      scopeNames(scope).names.has(name)
    ) {
      return scope;
    }
    child = scope;
  }
  return undefined;
};

/** Whether an identifier sits in a write position, including destructuring. */
const isWriteTarget = (identifier: Identifier) => {
  let node: Node = identifier;
  for (;;) {
    const parent = parentOf(node);
    if (!parent) {
      return false;
    }
    if (
      parent.type === "ParenthesizedExpression" ||
      parent.type === "ArrayPattern" ||
      parent.type === "ObjectPattern" ||
      parent.type === "ArrayExpression" ||
      parent.type === "ObjectExpression" ||
      parent.type === "SpreadElement" ||
      parent.type === "RestElement" ||
      (parent.type === "Property" &&
        (parent.shorthand || parent.value === node))
    ) {
      node = parent;
      continue;
    }
    if (parent.type === "AssignmentExpression") {
      return parent.left === node;
    }
    if (parent.type === "AssignmentPattern") {
      if (parent.left !== node) {
        return false;
      }
      node = parent;
      continue;
    }
    if (parent.type === "UpdateExpression") {
      return parent.argument === node;
    }
    if (parent.type === "ForInStatement" || parent.type === "ForOfStatement") {
      return parent.left === node;
    }
    return (
      parent.type === "UnaryExpression" &&
      parent.operator === "delete" &&
      parent.argument === node
    );
  }
};

/**
 * Whether any reference inside `root` to the binding `name` owned by `owner`
 * (a scope node, or undefined for the module top level) is written. Each
 * reference is resolved through its own enclosing scopes, so same-named
 * bindings in nested scopes are distinct.
 */
const isWritten = (root: Node, name: string, owner: Node | undefined) => {
  let written = false;
  walk(root, (node) => {
    if (written) {
      return "skip-children";
    }
    const parent = parentOf(node);
    if (
      node.type === "Identifier" &&
      node.name === name &&
      !(
        parent?.type === "MemberExpression" &&
        !parent.computed &&
        parent.property === node
      ) &&
      !(
        parent?.type === "Property" &&
        !parent.shorthand &&
        parent.key === node
      ) &&
      bindingScope(node, name) === owner &&
      isWriteTarget(node)
    ) {
      written = true;
    }
    return undefined;
  });
  return written;
};

const unwrapExpression = (expression: Expression): Expression =>
  expression.type === "ParenthesizedExpression" ||
  expression.type === "TSAsExpression" ||
  expression.type === "TSSatisfiesExpression"
    ? unwrapExpression(expression.expression)
    : expression;

/**
 * Where a trusted identifier comes from. Only these origins are trusted:
 * an import (renames followed), a top-level function declaration, a
 * top-level `const`, or a plain (or destructured) parameter without default.
 */
type TrustedBinding =
  | {
      kind: "import";
      module: string | undefined;
      specifier: string;
      exported: string;
    }
  | {
      kind: "function";
      body: Node;
      node: Callable;
    }
  | { kind: "const"; initializer: Expression }
  | {
      kind: "parameter";
      scope: Callable;
      index: number;
      element: BindingProperty | undefined;
    };

type TrustedTopLevelOptions = {
  name: string;
  source: SourceTree;
  access: SourceAccess;
};
const trustedTopLevel = ({
  name,
  source,
  access,
}: TrustedTopLevelOptions): TrustedBinding | undefined => {
  if (isWritten(source.program, name, undefined)) {
    return undefined;
  }
  for (const statement of statementsOf(source)) {
    if (
      statement.type === "FunctionDeclaration" &&
      statement.id?.name === name &&
      statement.body !== null
    ) {
      return { kind: "function", body: statement.body, node: statement };
    }
    if (!(statement.type === "VariableDeclaration")) {
      continue;
    }
    const variable = statement.declarations.find(
      (item) => item.id.type === "Identifier" && item.id.name === name,
    );
    if (variable === undefined) {
      continue;
    }
    if (statement.kind !== "const" || variable.init === null) {
      return undefined;
    }
    const initializer = unwrapExpression(variable.init);
    return (initializer.type === "ArrowFunctionExpression" ||
      initializer.type === "FunctionExpression") &&
      initializer.body !== null
      ? { kind: "function", body: initializer.body, node: initializer }
      : { kind: "const", initializer: variable.init };
  }
  const reference = importedReference({
    source,
    file: source.fileName,
    name,
    access,
  });
  return reference === undefined ? undefined : { kind: "import", ...reference };
};

type TrustedBindingOptions = {
  identifier: Identifier;
  access: SourceAccess;
};
/**
 * The single trust check for identifiers the checker relies on: resolved
 * through enclosing scopes (shadowing respected), never written anywhere in
 * its scope (`isWriteTarget`), and declared as an import, a top-level
 * function or `const`, or a parameter. Anything else is untrusted.
 */
const trustedBinding = ({
  identifier,
  access,
}: TrustedBindingOptions): TrustedBinding | undefined => {
  const name = identifier.name;
  const scope = bindingScope(identifier, name);
  if (scope === undefined) {
    return trustedTopLevel({
      name,
      source: sourceOf(identifier),
      access,
    });
  }
  if (
    !isFunctionLike(scope) ||
    !scopeNames(scope).parameters.has(name) ||
    isWritten(scope, name, scope)
  ) {
    return undefined;
  }
  for (const [index, parameter] of scope.params.entries()) {
    if (parameter.type === "Identifier" && parameter.name === name) {
      return { kind: "parameter", scope, index, element: undefined };
    }
    const pattern =
      parameter.type === "AssignmentPattern" ? parameter.left : parameter;
    if (pattern.type === "ObjectPattern") {
      const element = pattern.properties.find(
        (item) =>
          item.type === "Property" &&
          item.value.type === "Identifier" &&
          item.value.name === name,
      );
      if (element?.type === "Property") {
        return { kind: "parameter", scope, index, element };
      }
    }
  }
  return undefined;
};

type TrustedImportOptions = TrustedBindingOptions & {
  module: string;
  exported: readonly string[];
};
/** `identifier` is a trusted import of one of `exported` from `module`. */
const isTrustedImport = ({
  module,
  exported,
  ...options
}: TrustedImportOptions) => {
  const binding = trustedBinding(options);
  return (
    binding?.kind === "import" &&
    (binding.module ?? binding.specifier) === module &&
    exported.includes(binding.exported)
  );
};

type CanonicalResultOptions = {
  identifier: Identifier;
  access: SourceAccess;
};
/** `identifier` is better-result's `Result`, trusted. */
const isCanonicalResult = ({ identifier, access }: CanonicalResultOptions) =>
  isTrustedImport({
    identifier,
    access,
    module: "better-result",
    exported: ["Result"],
  });

/**
 * The single allow-list of runners that await their callback before
 * resolving. A runner earns callback credit only when its binding resolves,
 * scope-aware, to one of these sources; every other call (timers, custom
 * objects, shadowed names, arbitrary helpers) joins nothing.
 */
const JOINING_RUNNERS = {
  /**
   * Imported runners, by resolved module, export and callback position.
   * `suppliesTransaction`: the callback's first parameter is a transaction.
   */
  imported: [
    {
      module: `${API}db/safe-db.ts`,
      exported: "abortableTx",
      argument: 1,
      suppliesTransaction: true,
    },
    {
      module: `${API}db/safe-db.ts`,
      exported: "resultTx",
      argument: 1,
      suppliesTransaction: true,
    },
    {
      module: REGISTRY,
      exported: "withAggregateSavepoint",
      argument: 1,
      suppliesTransaction: true,
    },
    {
      module: REGISTRY,
      exported: "withAggregateTransaction",
      argument: 1,
      suppliesTransaction: true,
    },
  ],
  /**
   * Followed callees only: `<receiver>.transaction(cb)` where the receiver
   * is one of these imported database handles, or the transaction parameter
   * of an enclosing callback whose runner supplies one.
   */
  transaction: {
    method: "transaction",
    argument: 0,
    suppliesTransaction: true,
    handles: { module: `${API}db/root.ts`, exported: ["rootDb", "rlsDb"] },
  },
  /**
   * Followed callees only: better-result `Result.tryPromise({ try })`. It
   * joins `try` but passes it no transaction.
   */
  calleeResultProperties: [
    { method: "tryPromise", property: "try", suppliesTransaction: false },
  ],
} as const;

type JoinedRunnerOptions = {
  call: CallExpression;
  access: SourceAccess;
};
const isYieldedResultAwait = ({ call, access }: JoinedRunnerOptions) => {
  const expression = call.callee;
  const parent = parentOf(call);
  return (
    expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier" &&
    expression.property.name === "await" &&
    expression.object.type === "Identifier" &&
    isCanonicalResult({ identifier: expression.object, access }) &&
    parent?.type === "YieldExpression" &&
    parent.delegate &&
    parent.argument === call
  );
};
const isJoinedRunner = ({ call, access }: JoinedRunnerOptions) => {
  let expression: Node = call;
  let parent = parentOf(expression);
  while (parent?.type === "ParenthesizedExpression") {
    expression = parent;
    parent = parentOf(expression);
  }
  if (parent?.type === "AwaitExpression" && parent.argument === expression) {
    return true;
  }
  return (
    parent?.type === "CallExpression" &&
    parent.arguments.some((argument) => argument === expression) &&
    isYieldedResultAwait({ call: parent, access })
  );
};

type TransactionCallbackOptions = {
  callback: Callable;
  implementation: Exclude<HandlerImplementation, undefined>;
  access: SourceAccess;
};
/**
 * The only function kinds whose bodies earn lock credit when a followed call
 * or a joining runner invokes them: non-generator function declarations,
 * function expressions and arrows. Calling a generator only creates an
 * iterator; methods, accessors, constructors and class members are never
 * credited (`awaitedAggregateNames` does not descend into them). Followed
 * calls must invoke the identifier itself: `.call`, `.apply` and `.bind`
 * are property accesses and are never followed.
 */
const isCreditableFunction = (node: Node): node is Callable =>
  (node.type === "FunctionDeclaration" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression") &&
  !node.generator;

const isJoinedTransactionCallback = ({
  callback,
  implementation: { body, source },
  access,
  handlerSafeDb,
}: TransactionCallbackOptions & {
  /**
   * Only a route handler's own destructured `safeDb` is the injected runner.
   * In a followed callee the caller supplies it, so it never qualifies.
   */
  handlerSafeDb: boolean;
}) => {
  if (!isCreditableFunction(callback)) {
    return false;
  }
  const call = parentOf(callback);
  if (call?.type !== "CallExpression" || !isJoinedRunner({ call, access })) {
    return false;
  }
  const expression = call.callee;
  if (!(expression.type === "Identifier")) {
    return false;
  }
  const binding = trustedBinding({ identifier: expression, access });
  if (expression.name === "safeDb" && call.arguments.at(0) === callback) {
    // The route handler's own destructured `{ safeDb }` parameter.
    return (
      handlerSafeDb &&
      binding?.kind === "parameter" &&
      binding.scope === parentOf(body) &&
      binding.element !== undefined &&
      !binding.element.computed &&
      nodeText(binding.element.key, source) === "safeDb"
    );
  }
  return (
    binding?.kind === "import" &&
    JOINING_RUNNERS.imported.some(
      (runner) =>
        binding.module === runner.module &&
        binding.exported === runner.exported &&
        call.arguments.at(runner.argument) === callback,
    )
  );
};

type CalleeCallbackCredit = { suppliesTransaction: boolean } | undefined;

/** An imported JOINING_RUNNERS entry that receives `callback`, trusted. */
const importedRunnerCredit = ({
  callback,
  implementation,
  access,
}: TransactionCallbackOptions): CalleeCallbackCredit => {
  const call = parentOf(callback);
  if (
    call?.type !== "CallExpression" ||
    !(call.callee.type === "Identifier") ||
    !isJoinedTransactionCallback({
      callback,
      implementation,
      access,
      handlerSafeDb: false,
    })
  ) {
    return undefined;
  }
  const binding = trustedBinding({ identifier: call.callee, access });
  const runner = JOINING_RUNNERS.imported.find(
    (item) =>
      binding?.kind === "import" &&
      binding.module === item.module &&
      binding.exported === item.exported,
  );
  return runner === undefined
    ? undefined
    : { suppliesTransaction: runner.suppliesTransaction };
};

/**
 * Whether the trusted `receiver` is a transaction: a verified database
 * handle import, or the first parameter of a callback whose runner supplies
 * one (`trustedBinding` already rejects defaults, rest and writes).
 */
const isTrustedTransactionReceiver = ({
  receiver,
  implementation,
  access,
}: Omit<TransactionCallbackOptions, "callback"> & {
  receiver: Identifier;
}) => {
  const { handles } = JOINING_RUNNERS.transaction;
  const binding = trustedBinding({ identifier: receiver, access });
  if (binding?.kind === "import") {
    return (
      binding.module === handles.module &&
      handles.exported.some((exported) => exported === binding.exported)
    );
  }
  return (
    binding?.kind === "parameter" &&
    binding.index === 0 &&
    binding.element === undefined &&
    (binding.scope.type === "ArrowFunctionExpression" ||
      binding.scope.type === "FunctionExpression") &&
    calleeCallbackCredit({ callback: binding.scope, implementation, access })
      ?.suppliesTransaction === true
  );
};

/** `<receiver>.transaction(callback)` on a verified handle or transaction. */
const transactionMethodCredit = ({
  callback,
  implementation,
  access,
}: TransactionCallbackOptions): CalleeCallbackCredit => {
  const call = parentOf(callback);
  const { transaction } = JOINING_RUNNERS;
  return call?.type === "CallExpression" &&
    call.callee.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.property.type === "Identifier" &&
    call.callee.property.name === transaction.method &&
    call.arguments.at(transaction.argument) === callback &&
    call.callee.object.type === "Identifier" &&
    isJoinedRunner({ call, access }) &&
    isTrustedTransactionReceiver({
      receiver: call.callee.object,
      implementation,
      access,
    })
    ? { suppliesTransaction: transaction.suppliesTransaction }
    : undefined;
};

/** Static key of an object literal member; undefined for computed keys. */
const staticPropertyKey = (member: Node) => {
  if (member.type !== "Property" || member.computed) {
    return undefined;
  }
  if (member.key.type === "Identifier") {
    return member.key.name;
  }
  if (
    member.key.type === "Literal" &&
    (typeof member.key.value === "string" ||
      typeof member.key.value === "number")
  ) {
    return String(member.key.value);
  }
  return undefined;
};
const isFinalProperty = (property: Property) => {
  const key = staticPropertyKey(property);
  const parent = parentOf(property);
  if (parent?.type !== "ObjectExpression") {
    return false;
  }
  return (
    key !== undefined &&
    parent.properties
      .slice(parent.properties.indexOf(property) + 1)
      .every(
        (member) =>
          member.type !== "SpreadElement" &&
          staticPropertyKey(member) !== undefined &&
          staticPropertyKey(member) !== key,
      )
  );
};

/** A callback in a property of `Result.<method>({ ... })`, e.g. `try`. */
const resultPropertyCredit = ({
  callback,
  access,
}: TransactionCallbackOptions): CalleeCallbackCredit => {
  const property = parentOf(callback);
  if (
    !property ||
    !isPropertyAssignment(property) ||
    property.value !== callback ||
    parentOf(property)?.type !== "ObjectExpression"
  ) {
    return undefined;
  }
  const options = parentOf(property);
  if (options?.type !== "ObjectExpression") {
    return undefined;
  }
  const call = parentOf(options);
  if (
    !isFinalProperty(property) ||
    call?.type !== "CallExpression" ||
    call.arguments.at(0) !== options ||
    !(
      call.callee.type === "MemberExpression" &&
      !call.callee.computed &&
      call.callee.property.type === "Identifier"
    ) ||
    !(call.callee.object.type === "Identifier") ||
    !isCanonicalResult({ identifier: call.callee.object, access })
  ) {
    return undefined;
  }
  const method = call.callee.property.name;
  const name = staticPropertyKey(property);
  const runner = JOINING_RUNNERS.calleeResultProperties.find(
    (item) => item.method === method && item.property === name,
  );
  return runner !== undefined && isJoinedRunner({ call, access })
    ? { suppliesTransaction: runner.suppliesTransaction }
    : undefined;
};

/**
 * In a followed callee, an inline callback earns credit only when a joined
 * call to an allow-listed runner (JOINING_RUNNERS) receives it at its
 * callback position, with the runner's binding resolved through enclosing
 * scopes. The result says whether that runner passes it a transaction.
 */
const calleeCallbackCredit = (
  options: TransactionCallbackOptions,
): CalleeCallbackCredit =>
  isCreditableFunction(options.callback)
    ? (importedRunnerCredit(options) ??
      transactionMethodCredit(options) ??
      resultPropertyCredit(options))
    : undefined;

const hasLockIds = (argument: Argument | undefined): boolean => {
  if (argument === undefined || argument.type === "SpreadElement") {
    return false;
  }
  const ids = unwrapExpression(argument);
  return (
    !(ids.type === "ArrayExpression" && ids.elements.length === 0) &&
    !(ids.type === "Identifier" && ids.name === "undefined") &&
    !(ids.type === "Literal" && ids.value === null) &&
    !(ids.type === "UnaryExpression" && ids.operator === "void")
  );
};

const hasWorkspaceParentBatch = (
  call: CallExpression,
  access: SourceAccess,
): boolean => {
  const options = call.arguments.at(0);
  if (
    call.callee.type !== "Identifier" ||
    !isTrustedImport({
      identifier: call.callee,
      access,
      module: REGISTRY,
      exported: ["withAggregateParentBatch"],
    }) ||
    options?.type !== "ObjectExpression" ||
    !options.properties.every(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        !property.method &&
        property.kind === "init",
    )
  ) {
    return false;
  }
  const workspaceIds = options.properties.filter(
    (property) => staticPropertyKey(property) === "workspaceIds",
  );
  const field = workspaceIds.at(0);
  return (
    workspaceIds.length === 1 &&
    field !== undefined &&
    isPropertyAssignment(field) &&
    hasLockIds(field.value)
  );
};

/** The invoice owner acquires all participating matters before its invoice row. */
const hasInvoiceMatterAcquisition = (
  call: CallExpression,
  access: SourceAccess,
) => {
  const options = call.arguments.at(1);
  if (
    call.callee.type !== "Identifier" ||
    !isTrustedImport({
      identifier: call.callee,
      access,
      module: REGISTRY,
      exported: ["lockInvoiceInStatus"],
    }) ||
    options?.type !== "ObjectExpression" ||
    !options.properties.every(isPropertyAssignment) ||
    options.properties.some((property) => property.computed)
  ) {
    return false;
  }
  const workspaceIds = options.properties.filter(
    (field) => staticPropertyKey(field) === "workspaceId",
  );
  const workspaceId = workspaceIds.at(0);
  const locks = options.properties.filter(
    (field) => staticPropertyKey(field) === "matterLocks",
  );
  const lock = locks.at(0);
  if (
    workspaceIds.length !== 1 ||
    workspaceId === undefined ||
    !hasLockIds(workspaceId.value) ||
    locks.length !== 1 ||
    lock?.value.type !== "ObjectExpression" ||
    lock.value.properties.length !== 1
  ) {
    return false;
  }
  const type = lock.value.properties.at(0);
  return (
    type !== undefined &&
    isPropertyAssignment(type) &&
    staticPropertyKey(type) === "type" &&
    isStringLiteral(type.value) &&
    type.value.value === "acquire"
  );
};

type AwaitedAggregateOptions = {
  implementation: Exclude<HandlerImplementation, undefined>;
  access: SourceAccess;
  /** Receives joined direct calls by identifier, for one-level following. */
  calls?: CallExpression[];
  /** Callee bodies also count locks inside joined inline callbacks. */
  inlineCallbacks?: boolean;
};
const awaitedAggregateNames = ({
  implementation,
  access,
  calls,
  inlineCallbacks = false,
}: AwaitedAggregateOptions) => {
  const { body, source } = implementation;
  const names = new Set<string>();
  const visit = (node: Node) => {
    if (
      calls !== undefined &&
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      isJoinedRunner({ call: node, access })
    ) {
      calls.push(node);
    }
    if (
      isClassLike(node) ||
      (isFunctionLike(node) &&
        !(node.type === "ArrowFunctionExpression") &&
        !(node.type === "FunctionExpression"))
    ) {
      // Declarations, methods, accessors and classes are never joined here.
      return;
    }
    if (
      (node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression") &&
      !(inlineCallbacks
        ? calleeCallbackCredit({ callback: node, implementation, access }) !==
          undefined
        : isJoinedTransactionCallback({
            callback: node,
            implementation,
            access,
            handlerSafeDb: true,
          }))
    ) {
      return;
    }
    if (
      node.type === "AwaitExpression" &&
      node.argument.type === "CallExpression" &&
      node.argument.callee.type === "Identifier"
    ) {
      const options = node.argument.arguments.at(0);
      if (
        isTrustedImport({
          identifier: node.argument.callee,
          access,
          module: REGISTRY,
          exported: ["withInvoiceMatterLocks"],
        }) &&
        hasLockIds(node.argument.arguments.at(1))
      ) {
        names.add("workspace");
      }
      if (hasWorkspaceParentBatch(node.argument, access)) {
        names.add("workspace");
      }
      if (hasInvoiceMatterAcquisition(node.argument, access)) {
        names.add("workspace");
      }
      if (
        isTrustedImport({
          identifier: node.argument.callee,
          access,
          module: REGISTRY,
          exported: ["withAggregateLock", "withAggregateRowQuery"],
        }) &&
        options?.type === "ObjectExpression"
      ) {
        const aggregate = options.properties.find(
          (property) =>
            isPropertyAssignment(property) &&
            nodeText(property.key, source) === "aggregate",
        );
        if (
          aggregate !== undefined &&
          isPropertyAssignment(aggregate) &&
          isStringLiteral(aggregate.value)
        ) {
          names.add(aggregate.value.value);
        }
      }
    }
    visitChildren(node, visit);
  };
  visit(body);
  return names;
};

/** `apps/<name>/` or `packages/<name>/`; callees never cross this boundary. */
const packageRoot = (file: string) => {
  const [scope, name] = file.split("/");
  return (scope === "apps" || scope === "packages") && name !== undefined
    ? `${scope}/${name}/`
    : undefined;
};

type CalleeImplementationOptions = {
  call: CallExpression;
  implementation: Exclude<HandlerImplementation, undefined>;
  access: SourceAccess;
};
/** Only a direct named export of a function or variable earns callee credit. */
const isDirectNamedExport = (source: SourceTree, name: string) => {
  if (name === "default") {
    return false;
  }
  let declared = false;
  for (const statement of source.program.body) {
    if (statement.type === "TSExportAssignment") {
      return false;
    }
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.specifiers.some(
        (element) =>
          (element.exported.type === "Identifier"
            ? element.exported.name
            : element.exported.value) === name ||
          (element.local.type === "Identifier"
            ? element.local.name
            : element.local.value) === name,
      )
    ) {
      return false;
    }
    if (
      statement.type === "ExportAllDeclaration" &&
      statement.exported &&
      (statement.exported.type === "Identifier"
        ? statement.exported.name
        : statement.exported.value) === name
    ) {
      return false;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    const declares =
      (declaration?.type === "FunctionDeclaration" &&
        declaration.id?.name === name) ||
      (declaration?.type === "VariableDeclaration" &&
        declaration.declarations.some(
          (item) => item.id.type === "Identifier" && item.id.name === name,
        ));
    if (declares) {
      if (declared || statement.type !== "ExportNamedDeclaration") {
        return false;
      }
      declared = true;
    }
  }
  return declared;
};

/**
 * Resolves a direct call to a function defined in the caller's file or in a
 * module of the same package. Both the call's binding and the definition
 * must be trusted (`trustedBinding`): a function declaration or a `const`
 * function literal, never written. Default, aliased and re-exported definitions (`isDirectNamedExport`) and further calls
 * are not followed, so lock helpers count only one level below the handler.
 */
const calleeImplementation = ({
  call,
  implementation: { source, file },
  access,
}: CalleeImplementationOptions): HandlerImplementation => {
  const root = packageRoot(file);
  if (!(call.callee.type === "Identifier") || root === undefined) {
    return undefined;
  }
  const binding = trustedBinding({ identifier: call.callee, access });
  if (binding?.kind === "function") {
    return isCreditableFunction(binding.node)
      ? { body: binding.body, source, file }
      : undefined;
  }
  if (
    binding?.kind !== "import" ||
    binding.module === undefined ||
    binding.module === REGISTRY ||
    !binding.module.startsWith(root)
  ) {
    return undefined;
  }
  const content = access.load(binding.module);
  if (content === undefined) {
    return undefined;
  }
  const target = parse({ file: binding.module, source: content });
  if (!isDirectNamedExport(target, binding.exported)) {
    return undefined;
  }
  const definition = trustedTopLevel({
    name: binding.exported,
    source: target,
    access,
  });
  return definition?.kind === "function" &&
    isCreditableFunction(definition.node)
    ? { body: definition.body, source: target, file: binding.module }
    : undefined;
};

type HeldAggregateOptions = {
  implementation: Exclude<HandlerImplementation, undefined>;
  access: SourceAccess;
};
/**
 * The union of aggregates the handler locks itself and those its joined
 * direct calls lock through the aggregate lock owner in their own bodies,
 * including inline callbacks those bodies pass to awaited calls. Named
 * functions a callee calls in turn are never followed.
 */
const heldAggregateNames = ({
  implementation,
  access,
}: HeldAggregateOptions) => {
  const calls: CallExpression[] = [];
  const held = awaitedAggregateNames({ implementation, access, calls });
  for (const call of calls) {
    const callee = calleeImplementation({ call, implementation, access });
    if (callee === undefined) {
      continue;
    }
    for (const name of awaitedAggregateNames({
      implementation: callee,
      access,
      inlineCallbacks: true,
    })) {
      held.add(name);
    }
  }
  return held;
};

type DeclaredHandlerLocksOptions = ValidateDeclarationOptions & {
  handler: Argument;
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
      .filter(isPropertyAssignment)
      .map((field) => [nodeText(field.key, source), field.value]),
  );
  const type = fields.get("type");
  if (
    type !== undefined &&
    isStringLiteral(type) &&
    type.value === "independent"
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
  const held = heldAggregateNames({ implementation, access });
  const aggregates = fields.get("aggregates");
  if (aggregates === undefined || !(aggregates.type === "ArrayExpression")) {
    panic(`Missing declared aggregate list in ${file}`);
  }
  for (const aggregate of aggregates.elements) {
    if (!isStringLiteral(aggregate) || !held.has(aggregate.value)) {
      panic(
        `Declared handler must await withAggregateLock for ${elementText(aggregate, source)} in ${file}`,
      );
    }
  }
};

// --- Declaration sites ----------------------------------------------------------

/** Local names `file` imports the owner's declaration helper under. */
const declarationNames = ({
  source,
  file,
  access,
}: {
  source: SourceTree;
  file: string;
  access: SourceAccess;
}) => {
  const names = new Set<string>();
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const fromOwner =
      access.resolveSourceModule({ file, name: statement.source.value }) ===
      OWNER;
    for (const item of statement.specifiers) {
      if (fromOwner && item.type === "ImportNamespaceSpecifier") {
        panic(`Import ${DECLARE} by name from its owner in ${file}`);
      }
      if (item.type !== "ImportSpecifier") {
        continue;
      }
      const exported =
        item.imported.type === "Identifier"
          ? item.imported.name
          : item.imported.value;
      if (exported !== DECLARE) {
        continue;
      }
      if (!fromOwner || item.importKind === "type") {
        panic(`Import ${DECLARE} from ${OWNER} in ${file}`);
      }
      names.add(item.local.name);
    }
  }
  return names;
};

/**
 * Verifies every declaration in one file and returns how many it holds. Any
 * other use of the helper's name (an alias, a re-export, a value passed on, a
 * namespace member) fails: only a direct call can be verified.
 */
const verifyFileDeclarations = (file: string, access: SourceAccess) => {
  const content = access.load(file);
  if (content === undefined) {
    return panic(`Cannot read aggregate declaration site ${file}`);
  }
  const source = parse({ file, source: content });
  const names = declarationNames({ source, file, access });
  let verified = 0;
  const visit = (node: Node) => {
    if (
      node.type === "Identifier" &&
      (node.name === DECLARE || names.has(node.name)) &&
      parentOf(node)?.type !== "ImportSpecifier"
    ) {
      const call = parentOf(node);
      if (
        !names.has(node.name) ||
        call?.type !== "CallExpression" ||
        call.callee !== node
      ) {
        panic(
          `Call ${DECLARE} directly in ${file}: ${nodeText(call ?? node, source)}`,
        );
      }
      const [handler, declaration] = call.arguments;
      if (
        call.arguments.length !== 2 ||
        handler === undefined ||
        declaration === undefined ||
        !(declaration.type === "ObjectExpression")
      ) {
        panic(`Invalid aggregate mutation declaration in ${file}`);
      }
      validateDeclaration({
        declaration,
        source,
        file,
        registry: access.registry,
      });
      assertDeclaredHandlerLocks({
        declaration,
        handler,
        source,
        file,
        registry: access.registry,
        access,
      });
      verified += 1;
    }
    visitChildren(node, visit);
  };
  visit(source.program);
  return verified;
};

/**
 * Verifies every declaration site among `files` (repo-relative); a file that
 * never names the helper is skipped unparsed. Returns the declarations found.
 */
export const verifyAggregateDeclarations = ({
  files,
  load,
}: {
  files: readonly string[];
  load: SourceLoader;
}): number => {
  const access = createSourceAccess(load);
  let verified = 0;
  for (const file of files) {
    if (file !== OWNER && access.load(file)?.includes(DECLARE) === true) {
      verified += verifyFileDeclarations(file, access);
    }
  }
  return verified;
};

// --- Route coverage -------------------------------------------------------------

const routeReason = (route: string) =>
  `Existing ${route.slice(0, route.indexOf(" "))} route awaits ownership declaration at its route definition.`;

/** One row per undeclared mutation route (`METHOD /path`), counted. */
export const aggregateMutationBaseline = (
  undeclared: readonly string[],
): MutationBaseline => {
  const rows = new Map<string, MutationBaseline[number]>();
  for (const route of undeclared) {
    const existing = rows.get(route);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    rows.set(route, { key: route, count: 1, reason: routeReason(route) });
  }
  return [...rows.values()].toSorted((left, right) =>
    compareCodeUnit(left.key, right.key),
  );
};

export const checkAggregateMutationCoverage = ({
  undeclared,
  baseline,
  previous,
}: {
  /** Mutation routes the served table mounts without a declaration. */
  undeclared: readonly string[];
  baseline: MutationBaseline;
  previous: MutationBaseline;
}): string[] => {
  const errors: string[] = [];
  const current = new Map(baseline.map((entry) => [entry.key, entry]));
  const prior = new Map(previous.map((entry) => [entry.key, entry]));
  if (current.size !== baseline.length) {
    errors.push("Duplicate aggregate mutation baseline entries");
  }
  const needed = new Map(
    aggregateMutationBaseline(undeclared).map((entry) => [entry.key, entry]),
  );
  for (const entry of baseline) {
    if (entry.reason.trim() === "") {
      errors.push(`Reason required: ${entry.key}`);
    }
    if (!Number.isSafeInteger(entry.count) || entry.count <= 0) {
      errors.push(`Positive integer registration count required: ${entry.key}`);
    }
    if (!needed.has(entry.key)) {
      errors.push(`Stale aggregate mutation baseline entry: ${entry.key}`);
    }
    const priorEntry = prior.get(entry.key);
    if (
      priorEntry === undefined ||
      priorEntry.reason !== entry.reason ||
      entry.count > priorEntry.count
    ) {
      errors.push(`Aggregate mutation baseline may only shrink: ${entry.key}`);
    }
    const actualCount = needed.get(entry.key)?.count;
    if (actualCount !== undefined && actualCount !== entry.count) {
      errors.push(
        `Aggregate mutation registration count mismatch: ${entry.key} (actual ${actualCount}, baseline ${entry.count})`,
      );
    }
  }
  for (const key of needed.keys()) {
    if (!current.has(key)) {
      errors.push(`Undeclared aggregate mutation: ${key}`);
    }
  }
  return errors;
};

// --- CLI ------------------------------------------------------------------------

const aggregateMutationComparisonCommit = () => {
  const requested =
    process.env["BASE_SHA"] ?? process.env["BASE_REF"] ?? "origin/main";
  const resolved = spawnSync(
    "git",
    ["rev-parse", "--verify", `${requested}^{commit}`],
    { maxBuffer: 2 ** 30, cwd: ROOT, encoding: "utf-8" },
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
    { maxBuffer: 2 ** 30, cwd: ROOT, encoding: "utf-8" },
  );
  if (base.status !== 0) {
    panic(
      `Cannot resolve aggregate mutation comparison merge-base: ${requested}`,
    );
  }
  return base.stdout.trim();
};

const TEST_FILE = /\.(?:test|type-test)\.ts$/u;

/** API source files a served route can import: everything but tests. */
const apiSourceFiles = (): string[] =>
  [...new Bun.Glob(`${API}**/*.ts`).scanSync({ cwd: ROOT })]
    .filter((file) => !TEST_FILE.test(file))
    .toSorted(compareCodeUnit);

/**
 * Mutation routes the served table mounts without a declaration. The env
 * defaults are seeded first: route modules read the API env when they load.
 */
const undeclaredServedMutations = async (): Promise<string[]> => {
  await import("../apps/api/src/tests/setup-env");
  const { apiRoutes } = await import("../apps/api/src/api-routes");
  const { collectUndeclaredAggregateMutations } =
    await import("../apps/api/src/lib/db/aggregate-mutation-declaration");
  return collectUndeclaredAggregateMutations(apiRoutes);
};

if (import.meta.main) {
  const comparisonCommit = aggregateMutationComparisonCommit();
  const load: SourceLoader = (file) =>
    existsSync(path.join(ROOT, file))
      ? readFileSync(path.join(ROOT, file), "utf-8")
      : undefined;
  const declarations = verifyAggregateDeclarations({
    files: apiSourceFiles(),
    load,
  });
  const undeclared = await undeclaredServedMutations();
  const baseExists =
    spawnSync("git", ["cat-file", "-e", `${comparisonCommit}:${BASELINE}`], {
      maxBuffer: 2 ** 30,
      cwd: ROOT,
      encoding: "utf-8",
    }).status === 0;
  if (process.argv.includes("--generate")) {
    if (baseExists) {
      panic(
        "The aggregate mutation baseline is shrink-only; generation is initial-only",
      );
    }
    writeFileSync(
      path.join(ROOT, BASELINE),
      `${JSON.stringify(aggregateMutationBaseline(undeclared), null, 2)}\n`,
    );
  } else {
    const baseline = v.parse(
      baselineSchema,
      JSON.parse(readFileSync(path.join(ROOT, BASELINE), "utf-8")),
    );
    // On introduction the committed rows must be exactly the generated
    // inventory of the served table: no hand-added row or loosened reason.
    const previous = baseExists
      ? v.parse(
          baselineSchema,
          JSON.parse(
            spawnSync("git", ["show", `${comparisonCommit}:${BASELINE}`], {
              maxBuffer: 2 ** 30,
              cwd: ROOT,
              encoding: "utf-8",
            }).stdout,
          ),
        )
      : aggregateMutationBaseline(undeclared);
    const errors = checkAggregateMutationCoverage({
      undeclared,
      baseline,
      previous,
    });
    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }
    process.stdout.write(
      `Aggregate mutation coverage: ${declarations} verified declarations, ${undeclared.length} undeclared mutation routes, ${baseline.length} legacy entries\n`,
    );
    if (errors.length !== 0) {
      process.exitCode = 1;
    }
  }
  // The route table's modules open Redis clients at import (the rate
  // limiter connects at construction so a server's first requests reach it)
  // and never unref them, so this one-off script's event loop would hang.
  // The work is done here; exit explicitly like export-capability-catalog.ts.
  process.exit();
}
