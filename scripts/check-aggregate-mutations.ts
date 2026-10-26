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
import ts from "typescript6";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { BASELINE_PATHS } from "./baseline-paths";

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
  const registry = readAggregateRegistry(load);
  return { load, resolveSourceModule, registry };
};

type SourceAccess = ReturnType<typeof createSourceAccess>;

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
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      // Type-only imports have no runtime value; a same-named binding is
      // never trusted.
      if (
        clause.name?.text === name ||
        (clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.some((item) => item.name.text === name))
      ) {
        return undefined;
      }
      continue;
    }
    if (clause?.name?.text === name) {
      return { module, specifier, exported: "default" };
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
    if (binding?.isTypeOnly === true) {
      return undefined;
    }
    if (binding !== undefined) {
      return {
        module,
        specifier,
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
  { body: ts.Node; source: ts.SourceFile; file: string } | undefined;
/** The handler constructor call a local factory returns, as its arrow body or only statement. */
const factoryReturn = (
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): ts.CallExpression | undefined => {
  const { body } = node;
  if (body === undefined) {
    return undefined;
  }
  if (ts.isCallExpression(body)) {
    return body;
  }
  if (!ts.isBlock(body) || body.statements.length !== 1) {
    return undefined;
  }
  const [statement] = body.statements;
  return statement !== undefined &&
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined &&
    ts.isCallExpression(statement.expression)
    ? statement.expression
    : undefined;
};

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
    const factory = trustedBinding({
      identifier: handler.expression,
      access,
    });
    // A local endpoint factory (dependencies injectable for tests) is
    // followed to the handler constructor call it returns.
    const returned =
      factory?.kind === "function" ? factoryReturn(factory.node) : undefined;
    if (returned !== undefined) {
      const key = `${file}#${handler.expression.text}()`;
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
    // The handler callback comes last: `(config, handler)`, and a token
    // handler's `(config, verifyCaller, handler)`.
    const callback = handler.arguments.at(-1);
    if (
      factory?.kind !== "import" ||
      factory.module !== `${API}lib/api-handlers.ts` ||
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
    const assignment = target.statements.find(ts.isExportAssignment);
    return assignment === undefined || !ts.isIdentifier(assignment.expression)
      ? undefined
      : handlerImplementation({
          handler: assignment.expression,
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

const bindingNames = (name: ts.BindingName, names: Set<string>) => {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      bindingNames(element.name, names);
    }
  }
};

const statementNames = (statement: ts.Node, names: Set<string>) => {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      bindingNames(declaration.name, names);
    }
  } else if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    names.add(statement.name.text);
  }
};

/** `var` declarations hoist to the function, whatever block they sit in. */
const hoistedVarNames = (node: ts.Node, names: Set<string>) => {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
    return;
  }
  if (
    ts.isVariableDeclarationList(node) &&
    node.getFirstToken()?.kind === ts.SyntaxKind.VarKeyword
  ) {
    for (const declaration of node.declarations) {
      bindingNames(declaration.name, names);
    }
  }
  ts.forEachChild(node, (child) => hoistedVarNames(child, names));
};

type ScopeNames = { names: Set<string>; parameters: Set<string> };
const scopeNames = (scope: ts.Node): ScopeNames => {
  const names = new Set<string>();
  const parameters = new Set<string>();
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      bindingNames(parameter.name, parameters);
      bindingNames(parameter.name, names);
    }
    if (ts.isFunctionExpression(scope) && scope.name !== undefined) {
      names.add(scope.name.text);
    }
    if (
      (ts.isArrowFunction(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isFunctionDeclaration(scope) ||
        ts.isMethodDeclaration(scope)) &&
      scope.body !== undefined
    ) {
      const hoisted = new Set<string>();
      hoistedVarNames(scope.body, hoisted);
      for (const name of hoisted) {
        names.add(name);
        // A `var` redeclaring a parameter rebinds it; never treat it as one.
        parameters.delete(name);
      }
    }
  }
  if (ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    for (const statement of scope.statements) {
      statementNames(statement, names);
    }
  }
  if (ts.isCaseBlock(scope)) {
    for (const clause of scope.clauses) {
      for (const statement of clause.statements) {
        statementNames(statement, names);
      }
    }
  }
  if (
    (ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    for (const declaration of scope.initializer.declarations) {
      bindingNames(declaration.name, names);
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
    bindingNames(scope.variableDeclaration.name, names);
  }
  return { names, parameters };
};

/**
 * The nearest scope enclosing `node` (below the module top level, and below
 * `stop` when given) that binds `name`; undefined when only the module's
 * top-level imports and definitions can bind it.
 */
const bindingScope = (node: ts.Node, name: string, stop?: ts.Node) => {
  for (
    let scope = node.parent;
    !ts.isSourceFile(scope) && scope !== stop;
    scope = scope.parent
  ) {
    if (scopeNames(scope).names.has(name)) {
      return scope;
    }
  }
  return undefined;
};

/** Plain or compound assignment (`ts.isAssignmentExpression` is internal). */
const isAssignment = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

/**
 * Whether `identifier` sits in a write position: an assignment target (also
 * nested inside array/object destructuring targets), `++`/`--`, a for-in or
 * for-of head, or a `delete` operand.
 */
const isWriteTarget = (identifier: ts.Identifier) => {
  let node: ts.Node = identifier;
  for (;;) {
    const parent = node.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    if (isAssignment(parent)) {
      return parent.left === node;
    }
    if (
      (ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return parent.operand === node;
    }
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
      return parent.initializer === node;
    }
    return ts.isDeleteExpression(parent) && parent.expression === node;
  }
};

/**
 * Whether any reference inside `root` to the binding `name` owned by `owner`
 * (a scope node, or undefined for the module top level) is written. Each
 * reference is resolved through its own enclosing scopes, so same-named
 * bindings in nested scopes are distinct.
 */
const isWritten = (root: ts.Node, name: string, owner: ts.Node | undefined) => {
  const visit = (node: ts.Node): boolean => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !(
        ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
      ) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      bindingScope(node, name) === owner &&
      isWriteTarget(node)
    ) {
      return true;
    }
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(root);
};

const unwrapExpression = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ||
  ts.isAsExpression(expression) ||
  ts.isSatisfiesExpression(expression)
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
      body: ts.ConciseBody;
      node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
    }
  | { kind: "const"; initializer: ts.Expression }
  | {
      kind: "parameter";
      scope: ts.SignatureDeclaration;
      index: number;
      element: ts.BindingElement | undefined;
    };

type TrustedTopLevelOptions = {
  name: string;
  source: ts.SourceFile;
  access: SourceAccess;
};
const trustedTopLevel = ({
  name,
  source,
  access,
}: TrustedTopLevelOptions): TrustedBinding | undefined => {
  if (isWritten(source, name, undefined)) {
    return undefined;
  }
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.body !== undefined
    ) {
      return { kind: "function", body: statement.body, node: statement };
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const variable = statement.declarationList.declarations.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === name,
    );
    if (variable === undefined) {
      continue;
    }
    if (
      statement.declarationList.getFirstToken()?.kind !==
        ts.SyntaxKind.ConstKeyword ||
      variable.initializer === undefined
    ) {
      return undefined;
    }
    const initializer = unwrapExpression(variable.initializer);
    return ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer)
      ? { kind: "function", body: initializer.body, node: initializer }
      : { kind: "const", initializer: variable.initializer };
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
  identifier: ts.Identifier;
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
  const name = identifier.text;
  const scope = bindingScope(identifier, name);
  if (scope === undefined) {
    return trustedTopLevel({
      name,
      source: identifier.getSourceFile(),
      access,
    });
  }
  if (
    !ts.isFunctionLike(scope) ||
    !scopeNames(scope).parameters.has(name) ||
    isWritten(scope, name, scope)
  ) {
    return undefined;
  }
  for (const [index, parameter] of scope.parameters.entries()) {
    if (ts.isIdentifier(parameter.name) && parameter.name.text === name) {
      return parameter.initializer === undefined &&
        parameter.dotDotDotToken === undefined
        ? { kind: "parameter", scope, index, element: undefined }
        : undefined;
    }
    if (ts.isObjectBindingPattern(parameter.name)) {
      const element = parameter.name.elements.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
      if (element !== undefined) {
        return element.initializer === undefined &&
          element.dotDotDotToken === undefined
          ? { kind: "parameter", scope, index, element }
          : undefined;
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
  identifier: ts.Identifier;
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
  call: ts.CallExpression;
  access: SourceAccess;
};
const isYieldedResultAwait = ({ call, access }: JoinedRunnerOptions) => {
  const expression = call.expression;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== "await" ||
    !ts.isIdentifier(expression.expression)
  ) {
    return false;
  }
  return (
    isCanonicalResult({ identifier: expression.expression, access }) &&
    ts.isYieldExpression(call.parent) &&
    call.parent.asteriskToken !== undefined &&
    call.parent.expression === call
  );
};
const isJoinedRunner = ({ call, access }: JoinedRunnerOptions) => {
  let expression: ts.Expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (ts.isAwaitExpression(parent) && parent.expression === expression) {
    return true;
  }
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(expression) &&
    isYieldedResultAwait({ call: parent, access })
  );
};

type TransactionCallbackOptions = {
  callback: ts.ArrowFunction | ts.FunctionExpression;
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
const isCreditableFunction = (
  node: ts.Node,
): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression =>
  (ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)) &&
  node.asteriskToken === undefined;

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
  const call = callback.parent;
  if (!ts.isCallExpression(call) || !isJoinedRunner({ call, access })) {
    return false;
  }
  const expression = call.expression;
  if (!ts.isIdentifier(expression)) {
    return false;
  }
  const binding = trustedBinding({ identifier: expression, access });
  if (expression.text === "safeDb" && call.arguments.at(0) === callback) {
    // The route handler's own destructured `{ safeDb }` parameter.
    return (
      handlerSafeDb &&
      binding?.kind === "parameter" &&
      binding.scope === body.parent &&
      binding.element !== undefined &&
      (binding.element.propertyName === undefined ||
        binding.element.propertyName.getText(source) === "safeDb")
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
  const call = callback.parent;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    !isJoinedTransactionCallback({
      callback,
      implementation,
      access,
      handlerSafeDb: false,
    })
  ) {
    return undefined;
  }
  const binding = trustedBinding({ identifier: call.expression, access });
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
  receiver: ts.Identifier;
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
    (ts.isArrowFunction(binding.scope) ||
      ts.isFunctionExpression(binding.scope)) &&
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
  const call = callback.parent;
  const { transaction } = JOINING_RUNNERS;
  return ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === transaction.method &&
    call.arguments.at(transaction.argument) === callback &&
    ts.isIdentifier(call.expression.expression) &&
    isJoinedRunner({ call, access }) &&
    isTrustedTransactionReceiver({
      receiver: call.expression.expression,
      implementation,
      access,
    })
    ? { suppliesTransaction: transaction.suppliesTransaction }
    : undefined;
};

/** Static key of an object literal member; undefined for computed keys. */
const staticPropertyKey = (member: ts.ObjectLiteralElementLike) => {
  const name = member.name;
  return name !== undefined &&
    (ts.isIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name))
    ? name.text
    : undefined;
};

/**
 * Whether `property` is the final value of its key: it has a static key, and
 * no later member is a spread, a computed key or the same key.
 */
const isFinalProperty = (property: ts.PropertyAssignment) => {
  const key = staticPropertyKey(property);
  const members = property.parent.properties;
  return (
    key !== undefined &&
    members
      .slice(members.indexOf(property) + 1)
      .every(
        (member) =>
          !ts.isSpreadAssignment(member) &&
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
  const property = callback.parent;
  if (
    !ts.isPropertyAssignment(property) ||
    property.initializer !== callback ||
    !ts.isObjectLiteralExpression(property.parent)
  ) {
    return undefined;
  }
  const options = property.parent;
  const call = options.parent;
  if (
    !isFinalProperty(property) ||
    !ts.isCallExpression(call) ||
    call.arguments.at(0) !== options ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !ts.isIdentifier(call.expression.expression) ||
    !isCanonicalResult({ identifier: call.expression.expression, access })
  ) {
    return undefined;
  }
  const method = call.expression.name.text;
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

const hasLockIds = (expression: ts.Expression | undefined): boolean => {
  if (expression === undefined) {
    return false;
  }
  const ids = unwrapExpression(expression);
  return (
    !(ts.isArrayLiteralExpression(ids) && ids.elements.length === 0) &&
    !(ts.isIdentifier(ids) && ids.text === "undefined") &&
    ids.kind !== ts.SyntaxKind.NullKeyword &&
    !ts.isVoidExpression(ids)
  );
};

const hasWorkspaceParentBatch = (
  call: ts.CallExpression,
  access: SourceAccess,
): boolean => {
  if (!ts.isIdentifier(call.expression)) {
    return false;
  }
  const options = call.arguments.at(0);
  if (
    !isTrustedImport({
      identifier: call.expression,
      access,
      module: REGISTRY,
      exported: ["withAggregateParentBatch"],
    }) ||
    options === undefined ||
    !ts.isObjectLiteralExpression(options) ||
    !options.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)) &&
        !ts.isComputedPropertyName(property.name),
    )
  ) {
    return false;
  }
  const workspaceIds = options.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      staticPropertyKey(property) === "workspaceIds",
  );
  const field = workspaceIds.at(0);
  return (
    workspaceIds.length === 1 &&
    field !== undefined &&
    ts.isPropertyAssignment(field) &&
    hasLockIds(field.initializer)
  );
};

type AwaitedAggregateOptions = {
  implementation: Exclude<HandlerImplementation, undefined>;
  access: SourceAccess;
  /** Receives joined direct calls by identifier, for one-level following. */
  calls?: ts.CallExpression[];
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
  const visit = (node: ts.Node) => {
    if (
      calls !== undefined &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isJoinedRunner({ call: node, access })
    ) {
      calls.push(node);
    }
    if (
      ts.isClassLike(node) ||
      (ts.isFunctionLike(node) &&
        !ts.isArrowFunction(node) &&
        !ts.isFunctionExpression(node))
    ) {
      // Declarations, methods, accessors and classes are never joined here.
      return;
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
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
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const options = node.expression.arguments.at(0);
      if (
        isTrustedImport({
          identifier: node.expression.expression,
          access,
          module: REGISTRY,
          exported: ["withInvoiceMatterLocks"],
        }) &&
        hasLockIds(node.expression.arguments.at(1))
      ) {
        names.add("workspace");
      }
      if (hasWorkspaceParentBatch(node.expression, access)) {
        names.add("workspace");
      }
      if (
        isTrustedImport({
          identifier: node.expression.expression,
          access,
          module: REGISTRY,
          exported: ["withAggregateLock", "withAggregateRowQuery"],
        }) &&
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

/** `apps/<name>/` or `packages/<name>/`; callees never cross this boundary. */
const packageRoot = (file: string) => {
  const [scope, name] = file.split("/");
  return (scope === "apps" || scope === "packages") && name !== undefined
    ? `${scope}/${name}/`
    : undefined;
};

type CalleeImplementationOptions = {
  call: ts.CallExpression;
  implementation: Exclude<HandlerImplementation, undefined>;
  access: SourceAccess;
};
const hasModifier = (statement: ts.Statement, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind);

/**
 * Whether `source` exports `name` only through an `export` modifier on its
 * own top-level function declaration or `const`. Default exports,
 * `export =`, export specifiers (`export { … }`, `export … from`, in either
 * position) and namespace re-exports of that name all fail closed, so
 * aliases and barrels never earn credit.
 */
const isDirectNamedExport = (source: ts.SourceFile, name: string) => {
  if (name === "default") {
    return false;
  }
  let declared = false;
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && statement.isExportEquals === true) {
      return false;
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (
        clause !== undefined &&
        (ts.isNamespaceExport(clause)
          ? clause.name.text === name
          : clause.elements.some(
              (element) =>
                element.name.text === name ||
                element.propertyName?.text === name,
            ))
      ) {
        return false;
      }
    }
    const declares =
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (item) => ts.isIdentifier(item.name) && item.name.text === name,
        ));
    if (declares) {
      if (
        declared ||
        !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
        hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      ) {
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
  if (!ts.isIdentifier(call.expression) || root === undefined) {
    return undefined;
  }
  const binding = trustedBinding({ identifier: call.expression, access });
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
  const calls: ts.CallExpression[] = [];
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
  const held = heldAggregateNames({ implementation, access });
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

// --- Declaration sites ----------------------------------------------------------

/** Local names `file` imports the owner's declaration helper under. */
const declarationNames = ({
  source,
  file,
  access,
}: {
  source: ts.SourceFile;
  file: string;
  access: SourceAccess;
}) => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const fromOwner =
      access.resolveSourceModule({
        file,
        name: statement.moduleSpecifier.text,
      }) === OWNER;
    const bindings = statement.importClause?.namedBindings;
    if (fromOwner && bindings !== undefined && ts.isNamespaceImport(bindings)) {
      panic(`Import ${DECLARE} by name from its owner in ${file}`);
    }
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const item of bindings.elements) {
      if ((item.propertyName ?? item.name).text !== DECLARE) {
        continue;
      }
      if (!fromOwner || item.isTypeOnly) {
        panic(`Import ${DECLARE} from ${OWNER} in ${file}`);
      }
      names.add(item.name.text);
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
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      (node.text === DECLARE || names.has(node.text)) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      const call = node.parent;
      if (
        !names.has(node.text) ||
        !ts.isCallExpression(call) ||
        call.expression !== node
      ) {
        panic(`Call ${DECLARE} directly in ${file}: ${call.getText(source)}`);
      }
      const [handler, declaration] = call.arguments;
      if (
        call.arguments.length !== 2 ||
        handler === undefined ||
        declaration === undefined ||
        !ts.isObjectLiteralExpression(declaration)
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
    ts.forEachChild(node, visit);
  };
  visit(source);
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
