// Shared AST helpers for the rules in this folder.
//
// Oxlint plugin AST nodes are passed in untyped. Each helper narrows from
// `unknown` so rule files can call them without per-call type ceremony or
// shared type-import boilerplate.

import type { ESTree, Ranged, Scope, Variable } from "@oxlint/plugins";

import { isDatabaseHandleName, MUTATION_METHODS } from "./database-access.ts";
import { canonicalModuleId } from "./module-id.ts";

export { canonicalModuleId, exactModuleId } from "./module-id.ts";

type NodeFieldNames<Node> = Node extends unknown ? keyof Node : never;

// Nodes are untrusted at this boundary: declared ESTree fields remain
// unknown until each helper validates them, without an independent field list.
export type AstNode = Ranged & { type: string } & Partial<
    Record<NodeFieldNames<ESTree.Node>, unknown>
  > &
  Record<string, unknown>;

export type FilenameContext = {
  filename?: string;
  getFilename?: () => string;
};

export const filenameForContext = (context: FilenameContext): string =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

export const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string" &&
  "range" in node;

export const isIdentifier = (
  node: unknown,
  name?: string,
): node is AstNode & { type: "Identifier"; name: string } => {
  if (!isAstNode(node) || node.type !== "Identifier") {
    return false;
  }
  if (typeof node.name !== "string") {
    return false;
  }
  return name === undefined || node.name === name;
};

export const isStringLiteral = (
  node: unknown,
): node is AstNode & { type: "Literal"; value: string } =>
  isAstNode(node) && node.type === "Literal" && typeof node.value === "string";

// Resolve the static name of a Property or MemberExpression key:
// Identifier.name or string-Literal.value. Returns null for computed keys
// driven by a non-literal expression.
// The static text of a string literal or a zero-expression template literal:
// `` `jsonb` `` and `"jsonb"` spell the same value, so a backtick literal
// matches too.
export const staticStringValue = (node: unknown): string | null => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (!isAstNode(node) || node.type !== "TemplateLiteral") {
    return null;
  }
  const expressions = node.expressions;
  const quasis = node.quasis;
  if (!Array.isArray(expressions) || expressions.length !== 0) {
    return null;
  }
  if (!Array.isArray(quasis) || quasis.length !== 1) {
    return null;
  }
  const quasi = quasis[0];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value = quasi.value;
  if (typeof value !== "object" || value === null || !("cooked" in value)) {
    return null;
  }
  return typeof value.cooked === "string" ? value.cooked : null;
};

export const getPropertyName = (node: unknown): string | null => {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
};

// Match `<object>.<property>` member access where both halves are
// Identifiers and the access is not computed.
export const isMemberAccess = (
  node: unknown,
  object: string,
  property: string,
): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false &&
  isIdentifier(node.object, object) &&
  isIdentifier(node.property, property);

// Match `CallExpression` whose callee is an Identifier with the given name.
export const isCallTo = (node: unknown, name: string): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee, name);

// Resolve the dot-notation name of a callee: an Identifier, or a
// non-computed MemberExpression chain (e.g. `t.String`, `Schema.is`,
// `process.stderr.write`). Returns null when the chain is computed
// or the property name itself can't be resolved.
//
// If the chain is rooted at a non-Identifier expression (e.g. `foo().bar`),
// returns the bare property name ("bar") rather than null. Callers that
// match the result against a fixed allowlist must consider whether they
// need to distinguish `foo().createSafeHandler` from `createSafeHandler`.
export const getCalleeName = (callee: unknown): string | null => {
  if (isIdentifier(callee)) {
    return callee.name;
  }
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return null;
  }
  if (callee.computed !== false) {
    return null;
  }
  const objectName = getCalleeName(callee.object);
  const propertyName = getPropertyName(callee.property);
  if (propertyName === null) {
    return null;
  }
  return objectName === null ? propertyName : `${objectName}.${propertyName}`;
};

// Nodes that wrap an expression without changing its runtime value:
// `x as T`, `x satisfies T`, `<T>x`, `x!`, `f<T>`, `(x)`, and the optional
// chain container around `a?.b`.
export const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

// Peel value-preserving wrappers so a shape check sees the underlying
// expression. Returns the original node when no wrapping is present.
export const unwrapExpression = (node: unknown): AstNode | null => {
  let current = node;
  while (isAstNode(current) && TRANSPARENT_WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return isAstNode(current) ? current : null;
};

// Resolve an ImportSpecifier's imported binding name (Identifier.name or
// string-Literal.value). Returns null when the specifier shape is unexpected.
export const getImportedName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  const imported = specifier.imported;
  if (isIdentifier(imported)) {
    return imported.name;
  }
  if (isStringLiteral(imported)) {
    return imported.value;
  }
  return null;
};

// Resolve an ImportSpecifier's local binding name. This differs from
// getImportedName for aliased imports such as `import { source as local }`.
export const getImportLocalName = (specifier: unknown): string | null => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  return isIdentifier(specifier.local) ? specifier.local.name : null;
};

// --- Loop and async-boundary shape, shared by the await-in-loop rules -------
//
// `no-network-await-in-loop` and the type-aware `scripts/db-await-in-loop.ts`
// must agree on what counts as per-iteration work; the script mirrors these
// positions on the TypeScript AST.

// Positions of a loop node that re-run on every iteration. A `for`
// initializer and a `for-of` / `for-in` right-hand side are evaluated once, so
// an await there costs one round-trip, not one per item.
// Keyed by node type, so a lookup for any other node type misses: the value
// is optional, not a total map over a closed union.
const PER_ITERATION_LOOP_FIELDS: Record<string, readonly string[] | undefined> =
  {
    ForStatement: ["body", "test", "update"],
    ForOfStatement: ["body"],
    ForInStatement: ["body"],
    WhileStatement: ["body", "test"],
    DoWhileStatement: ["body", "test"],
  };

export const LOOP_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.keys(PER_ITERATION_LOOP_FIELDS),
);

export const isPerIterationLoopPosition = (
  loop: unknown,
  child: unknown,
): boolean => {
  if (!isAstNode(loop)) {
    return false;
  }
  const fields = PER_ITERATION_LOOP_FIELDS[loop.type];
  return fields?.some((field) => loop[field] === child) ?? false;
};

const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// The statement a `break` or `continue` leaves: its labelled statement, or
// else the nearest loop (or `switch`, for an unlabelled `break`). `null` for
// any other node, and when the jump would have to cross a function boundary.
export const abruptCompletionTarget = (node: AstNode): AstNode | null => {
  if (node.type !== "BreakStatement" && node.type !== "ContinueStatement") {
    return null;
  }
  const labelName = isIdentifier(node.label) ? node.label.name : null;
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null) {
    if (
      labelName !== null &&
      current.type === "LabeledStatement" &&
      isIdentifier(current.label, labelName)
    ) {
      return current;
    }
    if (
      labelName === null &&
      (LOOP_NODE_TYPES.has(current.type) ||
        (node.type === "BreakStatement" && current.type === "SwitchStatement"))
    ) {
      return current;
    }
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      return null;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};

const collectReturnArguments = (node: unknown, results: AstNode[]): void => {
  if (!isAstNode(node)) {
    return;
  }
  switch (node.type) {
    case "BlockStatement": {
      if (Array.isArray(node.body)) {
        for (const statement of node.body) {
          collectReturnArguments(statement, results);
        }
      }
      return;
    }
    case "IfStatement": {
      collectReturnArguments(node.consequent, results);
      collectReturnArguments(node.alternate, results);
      return;
    }
    case "SwitchStatement": {
      if (Array.isArray(node.cases)) {
        for (const switchCase of node.cases) {
          if (isAstNode(switchCase) && Array.isArray(switchCase.consequent)) {
            for (const statement of switchCase.consequent) {
              collectReturnArguments(statement, results);
            }
          }
        }
      }
      return;
    }
    case "TryStatement": {
      collectReturnArguments(node.block, results);
      if (isAstNode(node.handler)) {
        collectReturnArguments(node.handler.body, results);
      }
      collectReturnArguments(node.finalizer, results);
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement": {
      collectReturnArguments(node.body, results);
      return;
    }
    case "ReturnStatement": {
      if (isAstNode(node.argument)) {
        results.push(node.argument);
      }
      return;
    }
    default:
      return;
  }
};

// The `argument` of every `return` reachable from `node` without crossing into
// a nested function's body: a `return` inside a callback the function passes
// on is not a return of the function itself.
export const returnArguments = (node: unknown): AstNode[] => {
  const results: AstNode[] = [];
  collectReturnArguments(node, results);
  return results;
};

const isResultTryPromiseArgument = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const call = node.parent;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !isMemberAccess(call.callee, "Result", "tryPromise")
  ) {
    return false;
  }
  return Array.isArray(call.arguments) && call.arguments.includes(node);
};

// `Result.tryPromise(async () => ...)` and its object form
// `Result.tryPromise({ try: async () => ..., catch })` run the callback where
// it stands. Inside a loop that callback is the loop's own work, so a walk
// looking for the enclosing loop passes through this boundary instead of
// stopping at it.
export const isResultTryPromiseCallback = (fnNode: unknown): boolean => {
  if (!isAstNode(fnNode)) {
    return false;
  }
  const parent = fnNode.parent;
  if (
    isAstNode(parent) &&
    parent.type === "Property" &&
    parent.value === fnNode &&
    getPropertyName(parent.key) === "try"
  ) {
    const objectExpression = parent.parent;
    return (
      isAstNode(objectExpression) &&
      objectExpression.type === "ObjectExpression" &&
      isResultTryPromiseArgument(objectExpression)
    );
  }
  return isResultTryPromiseArgument(fnNode);
};

// Leftmost identifier of a member/call chain, descending through
// `CallExpression.callee` and `MemberExpression.object`. Computed access is
// traversed too: a generated route reads `api["copy-to-workspace"].post()`,
// and its root is still the imported client.
export const resolveChainRootName = (node: unknown): string | null => {
  const current = unwrapExpression(node);
  if (!isAstNode(current)) {
    return null;
  }
  if (current.type === "CallExpression") {
    return resolveChainRootName(current.callee);
  }
  if (current.type === "MemberExpression") {
    return resolveChainRootName(current.object);
  }
  return isIdentifier(current) ? current.name : null;
};

// --- Tailwind class strings, shared by the rules that read them -------------
//
// A class string reaches a rule as a `Literal` or a `TemplateElement`, with no
// guarantee it holds only classes: `cn()` arguments, `cva` variant maps, and
// interpolated templates all arrive here. Splitting on whitespace and the
// punctuation that separates expressions keeps the tokens usable across all
// three, and the split deliberately leaves `[` and `]` alone so an arbitrary
// variant stays one token.

const CLASS_TOKEN_SPLIT = /[\s"'`{}()]+/u;

export const classTokens = (value: string): string[] =>
  value.split(CLASS_TOKEN_SPLIT).filter(Boolean);

/**
 * The utility a token applies, with its Tailwind variant prefixes dropped
 * (`sm:`, `hover:`, `group-data-[x=true]/rail:`, `[&_pre]:`). The last colon
 * is the boundary: a colon inside an arbitrary value (`supports-[overflow:
 * clip]:`) is still followed by one.
 */
export const classBaseName = (token: string): string => {
  const boundary = token.lastIndexOf(":");
  return boundary === -1 ? token : token.slice(boundary + 1);
};

/** The variant prefixes of a token, or "" when it carries none. */
export const classVariants = (token: string): string => {
  const boundary = token.lastIndexOf(":");
  return boundary === -1 ? "" : token.slice(0, boundary);
};

// --- JSX shape, shared by the rules that read markup ------------------------

// The name a JSX element is written under, descending through the member and
// namespaced forms: `Dialog.Footer` names `Footer`, `svg:path` names `path`.
export const jsxName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxName(node.name);
  }
  return null;
};

// The name a JSXElement renders, or null for anything that is not one.
export const elementName = (element: unknown): string | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement)
    ? jsxName(element.openingElement.name)
    : null;
};

// Every node under `root`, reached without assuming a shape: asking what a
// component renders means crossing statements, branches, and helper calls that
// a JSX-only traversal never sees.
export const everyNode = (root: unknown): AstNode[] => {
  const out: AstNode[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isAstNode(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    out.push(current);
    for (const [key, value] of Object.entries(current)) {
      // `parent` walks back out of the subtree under inspection.
      if (key !== "parent" && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  return out;
};

// --- Files -------------------------------------------------------------------

// The linted file as a repository-relative, forward-slash path. Oxlint runs
// from the repository root, so the working directory anchors the relative
// form; a path outside it stays absolute.
export const repoRelativeFilename = (context: FilenameContext): string => {
  const filename = filenameForContext(context);
  const root = `${process.cwd().replaceAll("\\", "/")}/`;
  return filename.startsWith(root) ? filename.slice(root.length) : filename;
};

// Whether the linted file is one of `files`, each a repository-relative path
// or path suffix (`lib/s3.ts` names every file ending in it).
export const isFileIn = (
  context: FilenameContext,
  files: readonly string[],
): boolean => {
  const filename = filenameForContext(context);
  return files.some((file) => filename.endsWith(file));
};

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORY_PATTERN = /(?:^|\/)(?:tests?|__tests__)\//u;

// Test sources: `*.test.*` / `*.spec.*` files and anything under a `test/`,
// `tests/` or `__tests__/` directory.
export const isTestFile = (filename: string): boolean =>
  TEST_FILE_PATTERN.test(filename) || TEST_DIRECTORY_PATTERN.test(filename);

// --- Identifiers and scope ---------------------------------------------------

// An Identifier the parser emitted as a value reference (it carries a range,
// which synthetic name nodes do not).
export const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

export type ScopeContext = {
  sourceCode: { getScope: (node: ESTree.Node) => Scope };
};

// The variable an identifier binds to, found by walking the scope chain from
// the identifier outwards. Null for an unresolved (global) name.
export const resolveVariable = (
  context: ScopeContext,
  identifier: ESTree.IdentifierReference | ESTree.JSXIdentifier,
): Variable | null => {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

// Whether a variable is never reassigned after its declaration, so its
// initializer is the only value it can hold.
export const isSingleAssignment = (variable: Variable): boolean =>
  variable.references.every(
    (reference) => !reference.isWrite() || reference.init,
  );

// The initializer of a variable declared exactly once and never reassigned.
export const stableInitializer = (variable: Variable): AstNode | null => {
  const definition = variable.defs.at(0);
  if (
    variable.defs.length !== 1 ||
    definition?.type !== "Variable" ||
    !isAstNode(definition.node) ||
    definition.node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  return isAstNode(definition.node.init) ? definition.node.init : null;
};

// --- Import resolution ------------------------------------------------------
//
// Rules that guard a helper or a primitive must know what a name is bound to,
// not how it is spelled: `import { x as y }`, `import * as ns` with `ns.x`,
// `const { x } = ns`, `const y = x`, `require("m").x` and `await import("m")`
// all reach the same export. The resolver answers "which export of which
// module is this expression?"; a local, a parameter, or a call result
// answers null.

// `imported` is the export name, "default" for a default import, and "*" for
// the module namespace object itself.
export type ImportedBinding = { source: string; imported: string };

export const NAMESPACE_IMPORT = "*";

// The module a `require("m")`, `import("m")` or `await import("m")` loads.
export const dynamicModuleSource = (
  node: unknown,
  context: ScopeContext,
): string | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression)) {
    return null;
  }
  if (expression.type === "AwaitExpression") {
    return dynamicModuleSource(expression.argument, context);
  }
  if (expression.type === "ImportExpression") {
    return isStringLiteral(expression.source) ? expression.source.value : null;
  }
  if (
    expression.type === "CallExpression" &&
    isIdentifierReference(expression.callee) &&
    expression.callee.name === "require" &&
    Array.isArray(expression.arguments) &&
    expression.arguments.length === 1 &&
    isStringLiteral(expression.arguments[0])
  ) {
    const binding = resolveVariable(context, expression.callee);
    if (binding !== null && binding.defs.length !== 0) {
      return null;
    }
    return expression.arguments[0].value;
  }
  return null;
};

// The static key of a member expression: `a.b`, `a["b"]`, `` a[`b`] ``.
export const memberPropertyName = (member: AstNode): string | null => {
  if (member.computed !== true) {
    return getPropertyName(member.property);
  }
  if (isStringLiteral(member.property)) {
    return member.property.value;
  }
  const property = member.property;
  if (
    !isAstNode(property) ||
    property.type !== "TemplateLiteral" ||
    !Array.isArray(property.expressions) ||
    property.expressions.length > 0 ||
    !Array.isArray(property.quasis)
  ) {
    return null;
  }
  const quasi: unknown = property.quasis[0];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value: unknown = quasi.value;
  const cooked =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "cooked")
      : undefined;
  return typeof cooked === "string" ? cooked : null;
};

// The export read by `namespace.property` when `base` is a module namespace.
const memberOfNamespace = (
  base: ImportedBinding | null,
  property: string | null,
): ImportedBinding | null =>
  base?.imported === NAMESPACE_IMPORT && property !== null
    ? { source: base.source, imported: property }
    : null;

// The key a destructuring pattern reads for `binding`: `{ x }`, `{ x: y }`,
// `{ x = d }`, `{ "x": y }`.
export const patternKeyFor = (
  pattern: AstNode,
  binding: unknown,
): string | null => {
  if (!Array.isArray(pattern.properties)) {
    return null;
  }
  for (const property of pattern.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      continue;
    }
    const value = isAstNode(property.value) ? property.value : null;
    const target =
      value?.type === "AssignmentPattern" ? value.left : (value ?? null);
    if (target !== binding) {
      continue;
    }
    if (property.computed === true && !isStringLiteral(property.key)) {
      return null;
    }
    return getPropertyName(property.key);
  }
  return null;
};

const bindingFromVariable = (
  context: ScopeContext,
  variable: Variable,
  seen: Set<unknown>,
): ImportedBinding | null => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition === undefined) {
    return null;
  }
  const node: unknown = definition.node;
  if (definition.type === "ImportBinding") {
    const declaration: unknown = definition.parent;
    if (
      !isAstNode(node) ||
      node.importKind === "type" ||
      !isAstNode(declaration) ||
      declaration.type !== "ImportDeclaration" ||
      declaration.importKind === "type" ||
      !isStringLiteral(declaration.source)
    ) {
      return null;
    }
    const source = declaration.source.value;
    if (node.type === "ImportNamespaceSpecifier") {
      return { source, imported: NAMESPACE_IMPORT };
    }
    if (node.type === "ImportDefaultSpecifier") {
      return { source, imported: "default" };
    }
    const imported = getImportedName(node);
    return imported === null ? null : { source, imported };
  }
  if (
    definition.type !== "Variable" ||
    !isAstNode(node) ||
    node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  const loaded = dynamicModuleSource(node.init, context);
  const init =
    loaded === null
      ? resolveImportedExpression(context, node.init, seen)
      : { source: loaded, imported: NAMESPACE_IMPORT };
  if (init === null) {
    return null;
  }
  if (isIdentifier(node.id)) {
    return init;
  }
  if (isAstNode(node.id) && node.id.type === "ObjectPattern") {
    return memberOfNamespace(init, patternKeyFor(node.id, definition.name));
  }
  return null;
};

// The module export an expression evaluates to, or null when it is anything
// else: a local, a parameter, a call result, an unresolved global.
export const resolveImportedExpression = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<unknown>(),
): ImportedBinding | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression) || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable === null
      ? null
      : bindingFromVariable(context, variable, seen);
  }
  if (expression.type === "MemberExpression") {
    const loaded = dynamicModuleSource(expression.object, context);
    const base =
      loaded === null
        ? resolveImportedExpression(context, expression.object, seen)
        : { source: loaded, imported: NAMESPACE_IMPORT };
    return memberOfNamespace(base, memberPropertyName(expression));
  }
  return null;
};

// A module an import may come from: a bare package specifier or a repository
// path without extension (`apps/api/src/lib/escape-like`), or a predicate over
// the canonical id.
export type ModuleMatcher = string | ((moduleId: string) => boolean);

export const moduleMatches = (
  matcher: ModuleMatcher,
  moduleId: string,
): boolean =>
  typeof matcher === "function" ? matcher(moduleId) : matcher === moduleId;

// The resolved import behind `node` with its module in canonical form.
export type ResolvedImport = { moduleId: string; imported: string };

export const resolveImport = (
  context: ScopeContext & FilenameContext,
  node: unknown,
): ResolvedImport | null => {
  const binding = resolveImportedExpression(context, node);
  if (binding === null) {
    return null;
  }
  return {
    moduleId: canonicalModuleId(binding.source, repoRelativeFilename(context)),
    imported: binding.imported,
  };
};

// Whether `node` evaluates to one of `names` exported by a module accepted by
// `modules`. Use NAMESPACE_IMPORT as a name to accept the namespace object.
export type ImportedFromOptions = {
  context: ScopeContext & FilenameContext;
  node: unknown;
  modules: readonly ModuleMatcher[];
  names: ReadonlySet<string>;
};

export const isImportedFrom = ({
  context,
  node,
  modules,
  names,
}: ImportedFromOptions): boolean => {
  const resolved = resolveImport(context, node);
  return (
    resolved !== null &&
    names.has(resolved.imported) &&
    modules.some((matcher) => moduleMatches(matcher, resolved.moduleId))
  );
};

// The function a call invokes, seen through the forms that call it
// indirectly: `(0, f)()`, `f.call(...)`, `f.apply(...)`.
export const invokedCallee = (call: AstNode): AstNode | null => {
  const callee = unwrapExpression(call.callee);
  if (!isAstNode(callee)) {
    return null;
  }
  if (
    callee.type === "SequenceExpression" &&
    Array.isArray(callee.expressions)
  ) {
    return unwrapExpression(callee.expressions.at(-1));
  }
  if (callee.type === "MemberExpression") {
    const method = memberPropertyName(callee);
    if (method === "call" || method === "apply") {
      return unwrapExpression(callee.object);
    }
  }
  return callee;
};

// --- Database writes --------------------------------------------------------
//
// A Drizzle row write: `<handle>.insert(...)`, `.update(...)` or `.delete(...)`
// where the receiver is a database handle (`tx` / `db` / `trx`, a camel-cased
// name ending in `Tx` / `Db`, a member with such a name, a `getDb()`-style
// call, or a parameter of a `.transaction(...)` callback or typed as a
// transaction), or `<receiver>.execute(sql`...`)` whose static SQL inserts,
// updates or deletes rows.

type DatabaseWriteContext = ImportedFromOptions["context"];

// Guards the identifier-to-initializer walk against cycles.
const MAX_SQL_RESOLVE_DEPTH = 4;

const GET_DB_CALL = /^get[A-Za-z]*Db$/u;
const TRANSACTION_TYPE = /(?:^|[a-z])(?:Transaction|Tx)$|^(?:Db|DbOrTx)$/u;

// Static SQL that writes rows. Interpolations are joined as a placeholder
// token so `UPDATE ${table} AS t SET` still reads as one statement.
const WRITE_SQL = [
  /\bINSERT\s+INTO\b/iu,
  /\bDELETE\s+FROM\b/iu,
  /\bUPDATE\s+(?:ONLY\s+)?\S+(?:\s+(?:AS\s+)?\w+)?\s+SET\b/iu,
];
const SQL_PLACEHOLDER = " __value__ ";

const DRIZZLE_SQL: ReadonlySet<string> = new Set(["sql"]);

const isDrizzleModule = (moduleId: string): boolean =>
  moduleId === "drizzle-orm" || moduleId.startsWith("drizzle-orm/");

const typeAnnotationName = (identifier: unknown): string | null => {
  if (!isAstNode(identifier) || !isAstNode(identifier.typeAnnotation)) {
    return null;
  }
  const annotation = identifier.typeAnnotation.typeAnnotation;
  if (!isAstNode(annotation) || annotation.type !== "TSTypeReference") {
    return null;
  }
  const typeName = annotation.typeName;
  if (isIdentifier(typeName)) {
    return typeName.name;
  }
  return isAstNode(typeName) && typeName.type === "TSQualifiedName"
    ? getCalleeName(typeName.right)
    : null;
};

// Whether a function is the callback of `<handle>.transaction(...)` or of a
// handle-named runner such as `safeDb(...)`, which passes its callback a handle.
const isTransactionCallback = (fn: unknown): boolean => {
  const call = isAstNode(fn) ? fn.parent : null;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !Array.isArray(call.arguments) ||
    !call.arguments.includes(fn)
  ) {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (isIdentifierReference(callee)) {
    return isDatabaseHandleName(callee.name);
  }
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const property = memberPropertyName(callee);
  return (
    property !== null &&
    (property === "transaction" || isDatabaseHandleName(property))
  );
};

const isTransactionParameter = (variable: Variable): boolean => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition?.type !== "Parameter") {
    return false;
  }
  const typeName = typeAnnotationName(definition.name);
  return (
    (typeName !== null && TRANSACTION_TYPE.test(typeName)) ||
    isTransactionCallback(definition.node)
  );
};

const isDatabaseHandle = (
  context: DatabaseWriteContext,
  node: unknown,
): boolean => {
  const receiver = unwrapExpression(node);
  if (receiver === null) {
    return false;
  }
  if (isIdentifierReference(receiver)) {
    if (isDatabaseHandleName(receiver.name)) {
      return true;
    }
    const variable = resolveVariable(context, receiver);
    return variable !== null && isTransactionParameter(variable);
  }
  if (receiver.type === "MemberExpression") {
    const property = memberPropertyName(receiver);
    return property !== null && isDatabaseHandleName(property);
  }
  if (receiver.type === "CallExpression") {
    const name = getCalleeName(receiver.callee)?.split(".").at(-1);
    return name !== undefined && GET_DB_CALL.test(name);
  }
  return false;
};

// The static text of a drizzle `sql` template, or of a const holding one.
const writeSqlText = (
  context: DatabaseWriteContext,
  node: unknown,
  depth = 0,
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_SQL_RESOLVE_DEPTH) {
    return null;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    const init = variable === null ? null : stableInitializer(variable);
    return init === null ? null : writeSqlText(context, init, depth + 1);
  }
  if (
    expression.type !== "TaggedTemplateExpression" ||
    !isImportedFrom({
      context,
      node: expression.tag,
      modules: [isDrizzleModule],
      names: DRIZZLE_SQL,
    }) ||
    !isAstNode(expression.quasi) ||
    !Array.isArray(expression.quasi.quasis)
  ) {
    return null;
  }
  return expression.quasi.quasis
    .map((quasi: unknown) => {
      const value = isAstNode(quasi) ? quasi.value : null;
      return typeof value === "object" &&
        value !== null &&
        "raw" in value &&
        typeof value.raw === "string"
        ? value.raw
        : "";
    })
    .join(SQL_PLACEHOLDER);
};

export const isDatabaseWriteCall = (
  context: DatabaseWriteContext,
  node: unknown,
): boolean => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method !== null && MUTATION_METHODS.has(method)) {
    return isDatabaseHandle(context, callee.object);
  }
  if (method !== "execute" || !Array.isArray(call.arguments)) {
    return false;
  }
  const text = writeSqlText(context, call.arguments.at(0));
  return text !== null && WRITE_SQL.some((pattern) => pattern.test(text));
};

// `a`, `a.b`, `a.b.c`: the dotted name of a table reference, or null.
const dottedName = (node: unknown, depth = 0): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || depth > MAX_SQL_RESOLVE_DEPTH) {
    return null;
  }
  if (isIdentifier(expression)) {
    return expression.name;
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const object = dottedName(expression.object, depth + 1);
  const property = memberPropertyName(expression);
  return object === null || property === null ? null : `${object}.${property}`;
};

const SQL_WRITE_TARGET =
  /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE(?:\s+ONLY)?)\s+([\w."]+)/iu;

/**
 * What a write `isDatabaseWriteCall` accepts touches, as `<verb>:<table>`
 * (`insert:entities`, `update:schema.members`). Raw SQL reads the verb and
 * table from its static text. `?` stands for a table the source does not
 * name statically. Lets a per-owner budget tell one write from another
 * instead of counting them.
 */
export const databaseWriteTarget = (
  context: DatabaseWriteContext,
  node: unknown,
): string => {
  const call = unwrapExpression(node);
  const callee =
    call?.type === "CallExpression" ? unwrapExpression(call.callee) : null;
  const method =
    callee?.type === "MemberExpression" ? memberPropertyName(callee) : null;
  const args =
    call !== null && Array.isArray(call.arguments) ? call.arguments : [];
  if (method !== null && MUTATION_METHODS.has(method)) {
    return `${method}:${dottedName(args.at(0)) ?? "?"}`;
  }
  const text = writeSqlText(context, args.at(0));
  const match = text === null ? null : SQL_WRITE_TARGET.exec(text);
  const verb = match?.at(1)?.split(/\s+/u).at(0)?.toLowerCase();
  const table = match?.at(2)?.replaceAll('"', "");
  const named =
    table === undefined || table === SQL_PLACEHOLDER.trim() ? "?" : table;
  return `${verb ?? "execute"}:${named}`;
};
