// Where the owner connection (`rootDb`) is supplied implicitly, and which
// modules can reach it at all.
//
// Both questions cover the two owner-level handles `apps/api/src/db/root.ts`
// exports: `rootDb`, and `rlsDb`, the pool scoped transactions run on, whose
// transactions start as the owner until they switch role. Every example below
// written with `rootDb` holds for `rlsDb` too.
//
// The per-file import count (`countRootConnectionImports`, gated per file by
// `scripts/ratchet.ts`) says which modules can
// reach the owner connection. It cannot say how they hand it on: a module that
// imports `rootDb` once and passes it explicitly to the one operation that
// needs it looks the same as one that makes it the default of every
// dependency. This counter finds the second kind, the shapes that let a caller
// receive owner access without asking for it:
//
//   - a parameter or destructured default:    (db = rootDb) / { db = rootDb }
//   - a fallback operand:                      db ?? rootDb / s ??= make(rootDb)
//   - a conditional operand:                   cond ? rootDb.transaction(f) : ...
//                                              given ? given : createStore(rootDb)
//   - an assignment:                           store = createStore(rootDb)
//                                              holder.db = rootDb
//   - an object-literal dependency property:   { db: rootDb } / { rootDb }
//   - a module-level call taking it:           const store = createStore(rootDb)
//   - an alias or a returned handle:           const db = rootDb / () => rootDb
//                                              return createStore(rootDb)
//
// An operand counts when it IS the handle or reaches it through a member or
// call chain (`rootDb.transaction(fn)`), so wrapping the handle in a method
// call does not hide it.
//
// Bindings are resolved, not matched by name: a renamed import
// (`rootDb as owner`), a namespace import (`root.rootDb`), and a destructured
// dynamic import (`const { rootDb } = await import(...)`) all count, while a
// local parameter or variable that happens to be called `rootDb` does not.
// Type-only imports are ignored.
//
// Limits, stated so nobody reads more into a zero than it proves: this is a
// syntax check over one file. It does not follow a handle through a helper in
// another module, a re-export, an alias assigned after its declaration, or a
// value stored in a collection. A direct call on the handle inside a function
// (`rootDb.select()`), or an explicit argument inside a function
// (`notify(rows, rootDb)`), is not a shape here: that is an explicit use,
// which the import ratchet and the door list account for. A declaration
// inside a function (`const store = createStore(rootDb)`) binds a fresh local
// and counts only once it is assigned over another value or returned.
//
// Awaiting a call proves nothing about its value: `await createStore(rootDb)`
// is still a store built from the handle, so a returned, assigned or
// conditional call taking the handle counts awaited or not (the fallback
// `s ??= await make(rootDb)` always has). The only exemptions are the owner
// operations in ROOT_OPERATION_RESULTS, each named with the one file it may
// be awaited in and why its result is not a handle.

import { panic } from "better-result";
import nodePath from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/node";

import {
  type BindingIdentifier as Identifier,
  type BindingPattern,
  type BindingRestElement,
  type CallExpression,
  type Directive,
  type Expression,
  type FormalParameterRest,
  type ImportExpression,
  isObjectLiteralProperty,
  type MemberExpression,
  type Node,
  parseSource,
  type Program,
  type Statement,
  staticPropertyName,
  type TSImportType,
  walk,
} from "../packages/scripts/src/syntax-tree";

// `apps/api/src/db/root.ts`, by alias or path. `./root` is how a sibling in
// `apps/api/src/db/` names it; no other API module is called `root`.
const ROOT_CONNECTION_MODULE =
  /(?:^|\/)db\/root(?:\.[cm]?[jt]sx?)?$|^\.\/root(?:\.[cm]?[jt]sx?)?$/u;

/** The owner-level handles the root connection module exports. */
const ROOT_CONNECTION_EXPORTS = ["rootDb", "rlsDb"] as const;

const ROOT_CONNECTION_EXPORT_NAMES: ReadonlySet<string> = new Set(
  ROOT_CONNECTION_EXPORTS,
);

const isRootConnectionExport = (name: string): boolean =>
  ROOT_CONNECTION_EXPORT_NAMES.has(name);

export const ROOT_CONNECTION_SHAPE = {
  parameterDefault: "parameter-default",
  fallbackOperand: "fallback-operand",
  conditionalOperand: "conditional-operand",
  dependencyProperty: "dependency-property",
  moduleLevelCall: "module-level-call",
  assignment: "assignment",
  alias: "alias",
} as const;

type RootOperationResult = {
  /** The one file whose awaited call to this operation is exempt. */
  readonly file: string;
  /** Why the awaited result carries no owner access. */
  readonly reason: string;
};

/**
 * Owner operations whose awaited result a function returns or assigns: the
 * operation runs on the handle and hands back rows or a verdict, never the
 * handle or something bound to it. Keyed by callee name, matched only as a
 * plain identifier call that is awaited and takes the handle, in the named
 * file. An entry that no longer matches a site fails the guard's test, so the
 * list can only shrink.
 */
export const ROOT_OPERATION_RESULTS = {
  consumeConfirmationOtp: {
    file: "apps/api/src/lib/confirmation-otp.ts",
    reason: "Burns the code on its own connection and returns the verdict.",
  },
  ensureDefaultDocumentTypes: {
    file: "apps/api/src/lib/auth.ts",
    reason: "Seeds a new organization's document types; returns nothing.",
  },
  readOrganizationMachineApiKeyPage: {
    file: "apps/api/src/lib/machine-api-key-queries.ts",
    reason: "Returns one page of an organization's machine key rows.",
  },
  recordNewOrganizationAccessState: {
    file: "apps/api/src/lib/usage/organization-access-state-owner.ts",
    reason: "Records a new organization's access state; returns nothing.",
  },
  readUserProfessionalUse: {
    file: "apps/api/src/lib/auth.ts",
    reason: "Returns the signed-in account's professional-use state.",
  },
  resolveMemberAuthorization: {
    file: "apps/api/src/lib/auth.ts",
    reason: "Returns a credential's member authorization, or null.",
  },
  resolveUserRealtimeAuthorization: {
    file: "apps/api/src/lib/auth.ts",
    reason: "Returns the user's event stream authorization.",
  },
  resolveWorkspaceRealtimeAudience: {
    file: "apps/api/src/lib/auth.ts",
    reason: "Returns a workspace event stream's audience.",
  },
  writeUserGuideProgress: {
    file: "apps/api/src/lib/guide-progress.ts",
    reason: "Writes the session user's guide progress and returns its value.",
  },
} as const satisfies Record<string, RootOperationResult>;

type RootOperationName = keyof typeof ROOT_OPERATION_RESULTS;

const isRootOperationName = (name: string): name is RootOperationName =>
  Object.hasOwn(ROOT_OPERATION_RESULTS, name);

export type RootConnectionShape =
  (typeof ROOT_CONNECTION_SHAPE)[keyof typeof ROOT_CONNECTION_SHAPE];

export type RootConnectionShapeHit = {
  shape: RootConnectionShape;
  /** 1-based line of the offending expression. */
  line: number;
};

/** A module specifier naming the root connection module, by alias or path. */
export const isRootConnectionModule = (node: Node | undefined): boolean => {
  const text = stringValue(node);
  return text !== undefined && ROOT_CONNECTION_MODULE.test(text);
};

const stringValue = (node: Node | undefined): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const bindingIdentifiers = (
  name: BindingPattern | BindingRestElement | FormalParameterRest,
): Identifier[] => {
  switch (name.type) {
    case "Identifier":
      return [name];
    case "AssignmentPattern":
      return bindingIdentifiers(name.left);
    case "RestElement":
      return bindingIdentifiers(name.argument);
    case "ArrayPattern":
      return name.elements.flatMap((element) =>
        element === null ? [] : bindingIdentifiers(element),
      );
    case "ObjectPattern":
      return name.properties.flatMap((property) =>
        bindingIdentifiers(
          property.type === "RestElement" ? property.argument : property.value,
        ),
      );
    default:
      name satisfies never;
      return panic("Unknown binding pattern");
  }
};

const isFunction = (node: Node): boolean =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "TSDeclareFunction";

const isDynamicRootImport = (node: Expression): boolean => {
  const unwrapped = node.type === "AwaitExpression" ? node.argument : node;
  return (
    unwrapped.type === "ImportExpression" &&
    isRootConnectionModule(unwrapped.source)
  );
};

type RootBindings = { handles: Set<Identifier>; namespaces: Set<Identifier> };
const collectRootBindings = (source: Program): RootBindings => {
  const handles = new Set<Identifier>();
  const namespaces = new Set<Identifier>();
  walk(source, (node) => {
    if (
      node.type === "ImportDeclaration" &&
      isRootConnectionModule(node.source) &&
      node.importKind !== "type"
    ) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          namespaces.add(specifier.local);
        }
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type" &&
          isRootConnectionExport(
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value,
          )
        ) {
          handles.add(specifier.local);
        }
      }
      return "skip-children";
    }
    if (
      node.type === "VariableDeclarator" &&
      node.init !== null &&
      isDynamicRootImport(node.init)
    ) {
      if (node.id.type === "Identifier") {
        namespaces.add(node.id);
      }
      if (node.id.type === "ObjectPattern") {
        for (const element of node.id.properties) {
          if (
            element.type !== "Property" ||
            element.key.type !== "Identifier" ||
            !isRootConnectionExport(element.key.name)
          ) {
            continue;
          }
          const local =
            element.value.type === "AssignmentPattern"
              ? element.value.left
              : element.value;
          if (local.type === "Identifier") {
            handles.add(local);
          }
        }
      }
    }
    return undefined;
  });
  return { handles, namespaces };
};

const statementDeclarations = function* (
  statements: readonly (Statement | Directive)[],
): Generator<Identifier> {
  for (let statement of statements) {
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration !== null
    ) {
      statement = statement.declaration;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        yield* bindingIdentifiers(declaration.id);
      }
    } else if (
      (statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration") &&
      statement.id !== null
    ) {
      yield statement.id;
    } else if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        yield specifier.local;
      }
    }
  }
};

const scopeDeclarations = function* (scope: Node): Generator<Identifier> {
  if (
    scope.type === "FunctionDeclaration" ||
    scope.type === "FunctionExpression" ||
    scope.type === "ArrowFunctionExpression" ||
    scope.type === "TSDeclareFunction"
  ) {
    for (const parameter of scope.params) {
      yield* bindingIdentifiers(
        parameter.type === "TSParameterProperty"
          ? parameter.parameter
          : parameter,
      );
    }
    if (scope.type === "FunctionExpression" && scope.id !== null) {
      yield scope.id;
    }
    return;
  }
  if (
    scope.type === "Program" ||
    scope.type === "BlockStatement" ||
    scope.type === "TSModuleBlock"
  ) {
    yield* statementDeclarations(scope.body);
    return;
  }
  if (scope.type === "SwitchStatement") {
    for (const clause of scope.cases) {
      yield* statementDeclarations(clause.consequent);
    }
    return;
  }
  if (scope.type === "CatchClause" && scope.param !== null) {
    yield* bindingIdentifiers(scope.param);
    return;
  }
  let initializer;
  if (scope.type === "ForStatement") {
    initializer = scope.init;
  } else if (
    scope.type === "ForOfStatement" ||
    scope.type === "ForInStatement"
  ) {
    initializer = scope.left;
  }
  if (initializer?.type === "VariableDeclaration") {
    for (const declaration of initializer.declarations) {
      yield* bindingIdentifiers(declaration.id);
    }
  }
};

const unwrapTypes = (node: Expression): Expression => {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "ChainExpression"
  ) {
    current = current.expression;
  }
  return current;
};
const unwrap = (node: Expression): Expression => {
  let current = unwrapTypes(node);
  while (current.type === "AwaitExpression") {
    current = unwrapTypes(current.argument);
  }
  return current;
};

type ParentMap = ReadonlyMap<Node, Node>;
const scopeDeclarationIndexes = new WeakMap<
  ParentMap,
  WeakMap<Node, ReadonlyMap<string, Identifier>>
>();

const scopeDeclaration = ({
  scope,
  name,
  parents,
}: {
  scope: Node;
  name: string;
  parents: ParentMap;
}): Identifier | undefined => {
  let scopes = scopeDeclarationIndexes.get(parents);
  if (scopes === undefined) {
    scopes = new WeakMap();
    scopeDeclarationIndexes.set(parents, scopes);
  }
  let declarations = scopes.get(scope);
  if (declarations === undefined) {
    const indexed = new Map<string, Identifier>();
    for (const binding of scopeDeclarations(scope)) {
      // Preserve the resolver's existing first-declaration precedence.
      if (!indexed.has(binding.name)) {
        indexed.set(binding.name, binding);
      }
    }
    declarations = indexed;
    scopes.set(scope, declarations);
  }
  return declarations.get(name);
};

const resolveDeclaration = (
  reference: Identifier,
  parents: ParentMap,
): Identifier | undefined => {
  for (
    let scope = parents.get(reference);
    scope !== undefined;
    scope = parents.get(scope)
  ) {
    const declared = scopeDeclaration({ scope, name: reference.name, parents });
    if (declared !== undefined) {
      return declared;
    }
  }
  return undefined;
};
const isReferencePosition = (
  identifier: Identifier,
  parents: ParentMap,
): boolean => {
  const parent = parents.get(identifier);
  if (
    parent?.type === "MemberExpression" &&
    !parent.computed &&
    parent.property === identifier
  ) {
    return false;
  }
  if (
    parent?.type === "ImportSpecifier" &&
    parent.imported === identifier &&
    parent.local !== identifier
  ) {
    return false;
  }
  if (
    parent?.type === "Property" &&
    !parent.shorthand &&
    parent.key === identifier
  ) {
    return false;
  }
  return true;
};
const createRootReferenceTest = (
  bindings: RootBindings,
  parents: ParentMap,
) => {
  const isBoundIdentifier = (
    node: Node,
    declarations: Set<Identifier>,
  ): boolean => {
    if (node.type !== "Identifier") {
      return false;
    }
    const declaration = resolveDeclaration(node, parents);
    return declaration !== undefined && declarations.has(declaration);
  };
  const isHandle = (node: Expression): boolean => {
    const expression = unwrap(node);
    if (
      isReferencePositionCandidate(expression) &&
      isBoundIdentifier(expression, bindings.handles)
    ) {
      return true;
    }
    if (expression.type !== "MemberExpression") {
      return false;
    }
    let member;
    if (expression.computed) {
      member = stringValue(expression.property);
    } else if (expression.property.type === "Identifier") {
      member = expression.property.name;
    }
    return (
      member !== undefined &&
      isRootConnectionExport(member) &&
      isBoundIdentifier(unwrap(expression.object), bindings.namespaces)
    );
  };
  const isReferencePositionCandidate = (node: Node): boolean =>
    node.type === "Identifier" && isReferencePosition(node, parents);
  const reachesHandle = (node: Expression): boolean => {
    let current = unwrap(node);
    for (;;) {
      if (isHandle(current)) {
        return true;
      }
      if (current.type === "CallExpression") {
        current = unwrap(current.callee);
      } else if (current.type === "MemberExpression") {
        current = unwrap(current.object);
      } else {
        return false;
      }
    }
  };
  const buildsFromHandle = (node: Expression): boolean => {
    const expression = unwrap(node);
    return (
      (expression.type === "CallExpression" ||
        expression.type === "NewExpression") &&
      expression.arguments.some(
        (argument) => argument.type !== "SpreadElement" && isHandle(argument),
      )
    );
  };
  return { buildsFromHandle, isHandle, reachesHandle };
};

const exemptRootOperation = (
  node: Expression,
  file: string,
): RootOperationName | undefined => {
  const awaited = unwrapTypes(node);
  if (awaited.type !== "AwaitExpression") {
    return undefined;
  }
  const call = unwrapTypes(awaited.argument);
  if (call.type !== "CallExpression" || call.callee.type !== "Identifier") {
    return undefined;
  }
  const name = call.callee.name;
  return isRootOperationName(name) && ROOT_OPERATION_RESULTS[name].file === file
    ? name
    : undefined;
};
const FALLBACK_OPERATORS = new Set(["??", "||", "??=", "||="]);
const isInsideFunction = (node: Node, parents: ParentMap): boolean => {
  for (
    let parent = parents.get(node);
    parent !== undefined;
    parent = parents.get(parent)
  ) {
    if (isFunction(parent)) {
      return true;
    }
  }
  return false;
};

type RootConnectionScan = {
  hits: RootConnectionShapeHit[];
  exemptOperations: RootOperationName[];
};
const scanRootConnectionShapes = (
  content: string,
  file: string,
): RootConnectionScan => {
  const source = parseSource(file, content);
  const parents = new Map<Node, Node>();
  walk(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });
  const bindings = collectRootBindings(source.program);
  if (bindings.handles.size === 0 && bindings.namespaces.size === 0) {
    return { hits: [], exemptOperations: [] };
  }
  const { buildsFromHandle, isHandle, reachesHandle } = createRootReferenceTest(
    bindings,
    parents,
  );
  const exemptOperations: RootOperationName[] = [];
  const buildsInFunction = (node: Expression): boolean => {
    if (!isInsideFunction(node, parents) || !buildsFromHandle(node)) {
      return false;
    }
    const exempt = exemptRootOperation(node, file);
    if (exempt === undefined) {
      return true;
    }
    exemptOperations.push(exempt);
    return false;
  };
  const hits: RootConnectionShapeHit[] = [];
  const record = (shape: RootConnectionShape, node: Node): void => {
    hits.push({ shape, line: source.locate(node.start).line });
  };
  walk(source.program, (node) => {
    if (node.type === "AssignmentPattern" && reachesHandle(node.right)) {
      record(ROOT_CONNECTION_SHAPE.parameterDefault, node.right);
    } else if (
      (node.type === "LogicalExpression" ||
        node.type === "AssignmentExpression") &&
      FALLBACK_OPERATORS.has(node.operator) &&
      (reachesHandle(node.right) || buildsFromHandle(node.right))
    ) {
      record(ROOT_CONNECTION_SHAPE.fallbackOperand, node.right);
    } else if (node.type === "ConditionalExpression") {
      for (const operand of [node.consequent, node.alternate]) {
        if (reachesHandle(operand) || buildsInFunction(operand)) {
          record(ROOT_CONNECTION_SHAPE.conditionalOperand, operand);
        }
      }
    } else if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      (isHandle(node.right) || buildsInFunction(node.right))
    ) {
      record(ROOT_CONNECTION_SHAPE.assignment, node.right);
    } else if (
      isObjectLiteralProperty(node, parents.get(node)) &&
      isHandle(node.value)
    ) {
      record(ROOT_CONNECTION_SHAPE.dependencyProperty, node.value);
    } else if (
      (node.type === "CallExpression" || node.type === "NewExpression") &&
      !isInsideFunction(node, parents)
    ) {
      for (const argument of node.arguments) {
        if (argument.type !== "SpreadElement" && isHandle(argument)) {
          record(ROOT_CONNECTION_SHAPE.moduleLevelCall, argument);
        }
      }
    } else if (
      node.type === "VariableDeclarator" &&
      node.init !== null &&
      isHandle(node.init)
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.init);
    } else if (
      node.type === "ReturnStatement" &&
      node.argument !== null &&
      (isHandle(node.argument) || buildsInFunction(node.argument))
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.argument);
    } else if (
      node.type === "ArrowFunctionExpression" &&
      node.body.type !== "BlockStatement" &&
      (isHandle(node.body) || buildsInFunction(node.body))
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.body);
    }
  });
  return { hits, exemptOperations };
};

export const findRootConnectionShapes = (
  content: string,
  file: string,
): RootConnectionShapeHit[] => scanRootConnectionShapes(content, file).hits;
export const findStaleRootOperations = (
  readSource: (file: string) => string,
): RootOperationName[] =>
  Object.keys(ROOT_OPERATION_RESULTS)
    .filter(isRootOperationName)
    .filter((operation) => {
      const { file } = ROOT_OPERATION_RESULTS[operation];
      return !scanRootConnectionShapes(
        readSource(file),
        file,
      ).exemptOperations.includes(operation);
    });
export const countRootConnectionShapes = (
  content: string,
  file: string,
): number => findRootConnectionShapes(content, file).length;

const ORG_SCOPE_MODULE = /(?:^|\/)db\/org-scope(?:\.[cm]?[jt]sx?)?$/u;
const SCHEMA_MODULE =
  /(?:^|\/)db\/(?:schema(?:\/[^.]+)?|auth-schema|agent-auth-schema)(?:\.[cm]?[jt]sx?)?$/u;
const ORG_WRITE_METHODS = new Set(["insert", "update", "delete"]);

const accessName = (access: MemberExpression): string | undefined =>
  !access.computed && access.property.type === "Identifier"
    ? access.property.name
    : stringValue(access.property);

type ImportedValue = { type: "member"; name: string } | { type: "namespace" };
type ModulePattern = RegExp | ((specifier: string) => boolean);

const matchesModule = (
  specifier: string,
  modulePattern: ModulePattern,
): boolean =>
  modulePattern instanceof RegExp
    ? modulePattern.test(specifier)
    : modulePattern(specifier);

const isDynamicModuleImport = (
  expression: Expression,
  modulePattern: ModulePattern,
): boolean => {
  const value = unwrap(expression);
  const source =
    value.type === "ImportExpression" ? stringValue(value.source) : undefined;
  return source !== undefined && matchesModule(source, modulePattern);
};

// Resolve imports and immutable aliases using the same lexical declarations
// as the owner-handle scanner. Mutable aliases never establish admission.
const importedValue = (
  expression: Expression | Extract<Node, { type: "Identifier" }>,
  modulePattern: ModulePattern,
  parents: ParentMap,
  seen = new Set<Identifier>(),
): ImportedValue | undefined => {
  const value =
    expression.type === "Identifier" ? expression : unwrap(expression);
  if (value.type === "MemberExpression") {
    const name = accessName(value);
    return name !== undefined &&
      importedValue(value.object, modulePattern, parents, seen)?.type ===
        "namespace"
      ? { type: "member", name }
      : undefined;
  }
  if (value.type !== "Identifier") {
    return undefined;
  }
  const declaration = resolveDeclaration(value, parents);
  if (declaration === undefined || seen.has(declaration)) {
    return undefined;
  }
  seen.add(declaration);
  const parent = parents.get(declaration);
  if (
    parent?.type === "ImportSpecifier" ||
    parent?.type === "ImportNamespaceSpecifier"
  ) {
    const imported = parents.get(parent);
    const source =
      imported?.type === "ImportDeclaration"
        ? stringValue(imported.source)
        : undefined;
    if (
      imported?.type !== "ImportDeclaration" ||
      imported.importKind === "type" ||
      source === undefined ||
      !matchesModule(source, modulePattern) ||
      (parent.type === "ImportSpecifier" && parent.importKind === "type")
    ) {
      return undefined;
    }
    return parent.type === "ImportSpecifier"
      ? {
          type: "member",
          name:
            parent.imported.type === "Identifier"
              ? parent.imported.name
              : parent.imported.value,
        }
      : { type: "namespace" };
  }
  const property =
    parent?.type === "AssignmentPattern" ? parents.get(parent) : parent;
  if (property?.type === "Property") {
    const pattern = parents.get(property);
    const variable = pattern && parents.get(pattern);
    const name = property.computed ? undefined : staticPropertyName(property);
    if (
      pattern?.type === "ObjectPattern" &&
      variable?.type === "VariableDeclarator" &&
      variable.init !== null &&
      isDynamicModuleImport(variable.init, modulePattern) &&
      name !== undefined
    ) {
      return { type: "member", name };
    }
    return undefined;
  }
  if (parent?.type !== "VariableDeclarator" || parent.init === null) {
    return undefined;
  }
  const declarations = parents.get(parent);
  if (
    declarations?.type !== "VariableDeclaration" ||
    declarations.kind !== "const"
  ) {
    return undefined;
  }
  return isDynamicModuleImport(parent.init, modulePattern)
    ? { type: "namespace" }
    : importedValue(parent.init, modulePattern, parents, seen);
};

export type ImportedCallSite = {
  readonly line: number;
  readonly arguments: readonly Node[];
};

export type ImportedCallInventory = {
  readonly imported: boolean;
  readonly calls: readonly ImportedCallSite[];
};

const mayReferenceRuntimeRequire = (content: string): boolean => {
  if (/\brequire\b/u.test(content)) {
    return true;
  }
  if (!content.includes("\\u")) {
    return false;
  }
  const decoded = content.replace(
    /\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4})/gu,
    (escape) => {
      const hex = escape.startsWith("\\u{")
        ? escape.slice(3, -1)
        : escape.slice(2);
      const codePoint = Number.parseInt(hex, 16);
      // Comments and raw text may contain out-of-range escape-shaped content.
      return codePoint <= 0x10_ff_ff ? String.fromCodePoint(codePoint) : escape;
    },
  );
  return /\brequire\b/u.test(decoded);
};

/** Resolve direct calls to one imported function through lexical bindings. */
const referencesImportedModule = (
  source: ReturnType<typeof parseSource>,
  modulePattern: ModulePattern,
): boolean => {
  const staticSpecifiers = [
    ...source.module.staticImports.map(
      ({ moduleRequest }) => moduleRequest.value,
    ),
    ...source.module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest.value],
      ),
    ),
  ];
  let referencesModule = staticSpecifiers.some((specifier) =>
    matchesModule(specifier, modulePattern),
  );
  // Parsing and native module records still cover every file. Only dynamic
  // imports or a possible decoded require token need AST materialization.
  const mayHaveNonStaticImport =
    source.module.dynamicImports.length > 0 ||
    mayReferenceRuntimeRequire(source.sourceText);
  if (!referencesModule && mayHaveNonStaticImport) {
    walk(source.program, (node) => {
      if (referencesModule) {
        return "skip-children";
      }
      let specifier: string | undefined;
      if (node.type === "ImportExpression") {
        specifier = stringValue(node.source);
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        specifier = stringValue(node.arguments.at(0));
      }
      if (
        node.type === "TSImportEqualsDeclaration" &&
        node.moduleReference.type === "TSExternalModuleReference"
      ) {
        specifier = stringValue(node.moduleReference.expression);
      }
      if (specifier !== undefined && matchesModule(specifier, modulePattern)) {
        referencesModule = true;
      }
      return undefined;
    });
  }
  return referencesModule;
};

export const findImportedFunctionCalls = ({
  content,
  exportName,
  file,
  modulePattern,
}: {
  readonly content: string;
  readonly exportName: string;
  readonly file: string;
  readonly modulePattern: ModulePattern;
}): ImportedCallInventory => {
  const source = parseSource(file, content);
  if (!referencesImportedModule(source, modulePattern)) {
    return { imported: false, calls: [] };
  }
  const parents = new Map<Node, Node>();
  walk(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });

  let imported = false;
  const calls: ImportedCallSite[] = [];
  const canBeDirectCallOrConstAlias = (expression: Node): boolean => {
    let current = expression;
    for (;;) {
      const parent = parents.get(current);
      if (
        parent?.type === "ParenthesizedExpression" ||
        parent?.type === "TSAsExpression" ||
        parent?.type === "TSSatisfiesExpression" ||
        parent?.type === "TSNonNullExpression" ||
        parent?.type === "TSTypeAssertion"
      ) {
        current = parent;
        continue;
      }
      if (parent?.type === "CallExpression" && parent.callee === current) {
        return true;
      }
      if (
        parent?.type === "VariableDeclarator" &&
        parent.init === current &&
        parent.id.type === "Identifier"
      ) {
        const declaration = parents.get(parent);
        return (
          declaration?.type === "VariableDeclaration" &&
          declaration.kind === "const"
        );
      }
      return false;
    }
  };
  walk(source.program, (node) => {
    const importSpecifier =
      node.type === "ImportDeclaration" ? stringValue(node.source) : undefined;
    if (
      node.type === "ImportDeclaration" &&
      importSpecifier !== undefined &&
      matchesModule(importSpecifier, modulePattern) &&
      node.importKind !== "type"
    ) {
      const runtimeSpecifiers = node.specifiers.filter(
        (specifier) =>
          specifier.type !== "ImportSpecifier" ||
          specifier.importKind !== "type",
      );
      imported ||= node.specifiers.length === 0 || runtimeSpecifiers.length > 0;
      for (const specifier of runtimeSpecifiers) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type" &&
          (specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value) !== exportName
        ) {
          panic(`${file} imports an unowned export from ${importSpecifier}`);
        }
        if (specifier.type === "ImportDefaultSpecifier") {
          panic(
            `${file} must use a named or namespace import for ${exportName}`,
          );
        }
      }
    }
    if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source !== null &&
      matchesModule(stringValue(node.source) ?? "", modulePattern)
    ) {
      panic(`${file} cannot re-export ${exportName}`);
    }
    if (
      node.type === "ImportExpression" &&
      matchesModule(stringValue(node.source) ?? "", modulePattern)
    ) {
      panic(`${file} cannot dynamically import ${exportName}`);
    }
    if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference.type === "TSExternalModuleReference" &&
      matchesModule(
        stringValue(node.moduleReference.expression) ?? "",
        modulePattern,
      )
    ) {
      panic(`${file} cannot use import-equals for ${exportName}`);
    }
    if (node.type !== "CallExpression") {
      return;
    }
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      matchesModule(stringValue(node.arguments.at(0)) ?? "", modulePattern)
    ) {
      panic(`${file} cannot require ${exportName}`);
    }
    const callee = importedValue(node.callee, modulePattern, parents);
    if (callee?.type === "member" && callee.name === exportName) {
      calls.push({
        line: source.locate(node.start).line,
        arguments: node.arguments,
      });
    }
  });

  // Every runtime use must stay a direct call or an immutable const alias
  // whose own uses pass this same check. Counting calls alone would let one
  // valid call mask an escaped function reference in the same module.
  walk(source.program, (node) => {
    if (node.type === "MemberExpression") {
      const importedMember = importedValue(node, modulePattern, parents);
      if (
        importedMember?.type === "member" &&
        importedMember.name === exportName &&
        !canBeDirectCallOrConstAlias(node)
      ) {
        panic(
          `${file} must use ${exportName} only as a direct call or const alias`,
        );
      }
      return;
    }
    if (
      node.type !== "Identifier" ||
      !isReferencePosition(node, parents) ||
      resolveDeclaration(node, parents) === node
    ) {
      return;
    }
    const importedValueForReference = importedValue(
      node,
      modulePattern,
      parents,
    );
    if (
      importedValueForReference?.type === "member" &&
      importedValueForReference.name === exportName &&
      !canBeDirectCallOrConstAlias(node)
    ) {
      panic(
        `${file} must use ${exportName} only as a direct call or const alias`,
      );
    }
    if (importedValueForReference?.type !== "namespace") {
      return;
    }
    const parent = parents.get(node);
    if (parent?.type === "MemberExpression" && parent.object === node) {
      const member = importedValue(parent, modulePattern, parents);
      if (member?.type === "member" && member.name === exportName) {
        return;
      }
    }
    panic(`${file} cannot use the ${exportName} namespace as a runtime value`);
  });
  return { imported, calls };
};

const resolvesToBinding = (
  expression: Expression,
  binding: Identifier,
  parents: ParentMap,
  seen = new Set<Identifier>(),
): boolean => {
  const value = unwrap(expression);
  if (value.type !== "Identifier") {
    return false;
  }
  const declaration = resolveDeclaration(value, parents);
  if (declaration === binding) {
    return true;
  }
  if (declaration === undefined || seen.has(declaration)) {
    return false;
  }
  seen.add(declaration);
  const parent = parents.get(declaration);
  const declarations = parent && parents.get(parent);
  return (
    parent?.type === "VariableDeclarator" &&
    parent.init !== null &&
    declarations?.type === "VariableDeclaration" &&
    declarations.kind === "const" &&
    resolvesToBinding(parent.init, binding, parents, seen)
  );
};

const scopedReceiver = (
  call: CallExpression,
  receiver: Expression,
  parents: ParentMap,
): boolean => {
  for (
    let node = parents.get(call);
    node !== undefined;
    node = parents.get(node)
  ) {
    if (
      node.type !== "ArrowFunctionExpression" &&
      node.type !== "FunctionExpression"
    ) {
      continue;
    }
    const property = parents.get(node);
    const object = property && parents.get(property);
    if (
      property === undefined ||
      !isObjectLiteralProperty(property, object) ||
      property.method ||
      property.computed ||
      property.kind !== "init" ||
      staticPropertyName(property) !== "fn" ||
      object?.type !== "ObjectExpression"
    ) {
      continue;
    }
    const invocation = parents.get(object);
    if (
      invocation?.type !== "CallExpression" ||
      invocation.arguments.at(0) !== object
    ) {
      continue;
    }
    const imported = importedValue(
      invocation.callee,
      ORG_SCOPE_MODULE,
      parents,
    );
    const parameter = node.params.at(0);
    if (
      imported?.type === "member" &&
      imported.name === "withOrgScope" &&
      parameter?.type === "Identifier" &&
      resolvesToBinding(receiver, parameter, parents)
    ) {
      return true;
    }
  }
  return false;
};

export type OrgWriteScopeHit = {
  line: number;
  table: string;
  operation: string;
  fingerprint: string;
};

// Keep node structure and semantic values, omitting offsets and literal spelling.
// Template raw text stays significant because a tag may read it directly.
const writeStatementFingerprint = (
  call: CallExpression,
  parents: ParentMap,
): string => {
  let statement: Node = call;
  for (
    let node: Node | undefined = call;
    node !== undefined;
    node = parents.get(node)
  ) {
    if (
      node.type === "ExpressionStatement" ||
      node.type === "ReturnStatement" ||
      node.type === "VariableDeclaration"
    ) {
      statement = node;
      break;
    }
  }
  const canonical = (value: unknown): unknown => {
    if (typeof value === "bigint") {
      return { bigint: value.toString() };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { number: value.toString() };
    }
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            key !== "start" &&
            key !== "end" &&
            !(key === "raw" && "type" in value && value.type === "Literal"),
        )
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  return sha256Hex(JSON.stringify(canonical(statement)));
};

type FindUnscopedOrgWritesOptions = {
  content: string;
  file: string;
  orgTables: ReadonlySet<string>;
};

/** ORG table writes in owner modules require the scoped callback's receiver. */
export const findUnscopedOrgWrites = ({
  content,
  file,
  orgTables,
}: FindUnscopedOrgWritesOptions): OrgWriteScopeHit[] => {
  const source = parseSource(file, content);
  const parents = new Map<Node, Node>();
  walk(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });
  const hits: OrgWriteScopeHit[] = [];
  walk(source.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = unwrap(node.callee);
    if (callee.type !== "MemberExpression") {
      return;
    }
    const operation = accessName(callee);
    const target = node.arguments.at(0);
    if (target === undefined || target.type === "SpreadElement") {
      return;
    }
    const imported = importedValue(target, SCHEMA_MODULE, parents);
    let table: string;
    if (
      operation !== undefined &&
      ORG_WRITE_METHODS.has(operation) &&
      imported?.type === "member" &&
      orgTables.has(imported.name)
    ) {
      table = imported.name;
    } else if (
      operation === "execute" &&
      /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\b/iu.test(
        content
          .slice(target.start, target.end)
          .replace(/\bFOR\s+UPDATE\b/giu, ""),
      )
    ) {
      // SQL mutations have no Drizzle target; retain their independent debt.
      table = "<raw-sql>";
    } else {
      return;
    }
    if (!scopedReceiver(node, callee.object, parents)) {
      hits.push({
        line: source.locate(node.start).line,
        table,
        operation,
        fingerprint: writeStatementFingerprint(node, parents),
      });
    }
  });
  return hits;
};

/** Scope registries are read from the measured source tree, not the live tree. */
export const scopeTableExportNames = (
  content: string,
  file: string,
  registryName: "ORG_SCOPE_TABLES" | "GLOBAL_SCOPE_TABLES",
): string[] => {
  const source = parseSource(file, content);
  const declarations = source.program.body.flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration" &&
    statement.declaration.kind === "const"
      ? statement.declaration.declarations.filter(
          (declaration) =>
            declaration.id.type === "Identifier" &&
            declaration.id.name === registryName,
        )
      : [],
  );
  if (declarations.length !== 1) {
    return panic(`${registryName} requires one exported const binding`);
  }
  const initializer = declarations.at(0)?.init;
  if (initializer === null || initializer === undefined) {
    return panic(`${registryName} requires an explicit object literal`);
  }
  const value = unwrap(initializer);
  if (value.type !== "ObjectExpression") {
    return panic(`${registryName} requires explicit export keys`);
  }
  const names = value.properties.map((property) => {
    const name =
      property.type === "Property" &&
      !property.computed &&
      !property.shorthand &&
      !property.method &&
      property.kind === "init"
        ? staticPropertyName(property)
        : undefined;
    return name ?? panic(`${registryName} requires explicit export keys`);
  });
  if (new Set(names).size !== names.length) {
    return panic(`${registryName} repeats an export key`);
  }
  return names;
};

export const orgScopeTableExportNames = (
  content: string,
  file: string,
): string[] => scopeTableExportNames(content, file, "ORG_SCOPE_TABLES");

// --- Which modules reach the handles ----------------------------------------
//
// One count per handle a module names from the root connection module, so a
// module that already imports `rootDb` rises when it adds `rlsDb`:
//
//   - a named import or re-export:     import { rootDb } / export { rlsDb as x }
//   - a destructured dynamic import:   const { rootDb } = await import(...)
//   - an import type query:            typeof import("@/api/db/root").rootDb
//                                      typeof import("@/api/db/root")["rootDb"]
//
// A form that reaches the whole module counts both handles: a namespace import
// or re-export (`import * as root`, `export *`, `export * as root`), an
// `import = require(...)`, a dynamic import that is not destructured, and a
// bare `typeof import(...)`.
//
// Runtime and type-only references are counted apart, each gated per file, so
// a module that turns `import type { rootDb }` into a value import rises in
// the runtime count instead of spending the allowance its type had. A type
// taken from a handle (`db: Pick<typeof rootDb, "select">`) grants nothing by
// itself, but it is the parameter an owner handle is passed into, so it is
// listed too. `Transaction`, the transaction type scoped handles share, is not
// a handle and does not count.
const HANDLES_PER_MODULE = ROOT_CONNECTION_EXPORTS.length;
type RootConnectionReferences = {
  readonly value: number;
  readonly type: number;
};
const dynamicImportHandles = (
  call: ImportExpression,
  parents: ParentMap,
): number => {
  let holder = parents.get(call);
  while (
    holder?.type === "AwaitExpression" ||
    holder?.type === "ParenthesizedExpression"
  ) {
    holder = parents.get(holder);
  }
  if (
    holder?.type !== "VariableDeclarator" ||
    holder.id.type !== "ObjectPattern" ||
    holder.id.properties.some((element) => element.type === "RestElement")
  ) {
    return HANDLES_PER_MODULE;
  }
  return holder.id.properties.filter(
    (element) =>
      element.type === "Property" &&
      isRootConnectionExport(
        element.key.type === "Identifier"
          ? element.key.name
          : (stringValue(element.key) ?? ""),
      ),
  ).length;
};
const importTypeHandles = (node: TSImportType, parents: ParentMap): number => {
  let head = node.qualifier;
  while (head?.type === "TSQualifiedName") {
    head = head.left;
  }
  if (head !== null) {
    return isRootConnectionExport(head.name) ? 1 : 0;
  }
  let selected: Node = node;
  let parent = parents.get(selected);
  while (
    parent?.type === "TSParenthesizedType" ||
    parent?.type === "TSTypeQuery"
  ) {
    selected = parent;
    parent = parents.get(selected);
  }
  if (
    parent?.type === "TSIndexedAccessType" &&
    parent.objectType === selected &&
    parent.indexType.type === "TSLiteralType"
  ) {
    return isRootConnectionExport(stringValue(parent.indexType.literal) ?? "")
      ? 1
      : 0;
  }
  return HANDLES_PER_MODULE;
};
const countRootConnectionReferences = (
  content: string,
  file: string,
): RootConnectionReferences => {
  const source = parseSource(file, content);
  const parents = new Map<Node, Node>();
  walk(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });
  let value = 0;
  let type = 0;
  const add = (count: number, typeOnly: boolean): void => {
    if (typeOnly) {
      type += count;
    } else {
      value += count;
    }
  };
  walk(source.program, (node) => {
    if (
      node.type === "ImportDeclaration" &&
      isRootConnectionModule(node.source)
    ) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          add(HANDLES_PER_MODULE, node.importKind === "type");
        } else if (
          specifier.type === "ImportSpecifier" &&
          isRootConnectionExport(
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value,
          )
        ) {
          add(1, node.importKind === "type" || specifier.importKind === "type");
        }
      }
      return "skip-children";
    }
    if (
      node.type === "ExportAllDeclaration" &&
      isRootConnectionModule(node.source)
    ) {
      add(HANDLES_PER_MODULE, node.exportKind === "type");
      return "skip-children";
    }
    if (
      node.type === "ExportNamedDeclaration" &&
      isRootConnectionModule(node.source ?? undefined)
    ) {
      for (const specifier of node.specifiers) {
        if (
          isRootConnectionExport(
            specifier.local.type === "Identifier"
              ? specifier.local.name
              : specifier.local.value,
          )
        ) {
          add(1, node.exportKind === "type" || specifier.exportKind === "type");
        }
      }
      return "skip-children";
    }
    if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference.type === "TSExternalModuleReference" &&
      isRootConnectionModule(node.moduleReference.expression)
    ) {
      add(HANDLES_PER_MODULE, node.importKind === "type");
      return "skip-children";
    }
    if (
      node.type === "ImportExpression" &&
      isRootConnectionModule(node.source)
    ) {
      value += dynamicImportHandles(node, parents);
    }
    if (node.type === "TSImportType" && isRootConnectionModule(node.source)) {
      type += importTypeHandles(node, parents);
    }
    return undefined;
  });
  return { value, type };
};
export const countRootConnectionImports = (
  content: string,
  file: string,
): number => countRootConnectionReferences(content, file).value;
export const countRootConnectionTypeImports = (
  content: string,
  file: string,
): number => countRootConnectionReferences(content, file).type;

const graphPath = nodePath.posix;
const DATA_IMPORT_TYPES = new Set(["text", "json", "file"]);
const isDataImport = ({
  attributes,
}: Extract<Node, { type: "ImportDeclaration" }>): boolean =>
  attributes.some(
    ({ key, value }) =>
      (key.type === "Identifier" ? key.name : key.value) === "type" &&
      DATA_IMPORT_TYPES.has(value.value),
  );

const GRAPH_NATIVE_GLOBALS = new Set([
  "Array",
  "Object",
  "JSON",
  "String",
  "RegExp",
  "Set",
  "URL",
  "Reflect",
]);
const GRAPH_GLOBAL_ALIASES = new Set([
  "globalThis",
  "global",
  "window",
  "self",
]);
const TAGGED_ERROR_BASE_PREFIX = "<result:tagged-error-base:";
const TAGGED_ERROR_CLASS_PREFIX = "<result:tagged-error-class:";

const GRAPH_NATIVE_MODULES = new Set([
  "node:fs",
  "fs",
  "node:path",
  "path",
  "valibot",
  "drizzle-orm",
  "bun:test",
  "better-result",
]);

const GRAPH_GLOBAL_BINDINGS = new Set([
  "Array",
  "Object",
  "Reflect",
  "globalThis",
  "Promise",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "Error",
  "TypeError",
  "RangeError",
  "Uint8Array",
  "Buffer",
  "URL",
  "URLSearchParams",
  "Headers",
  "Request",
  "Response",
  "AbortController",
  "TextEncoder",
  "TextDecoder",
  "structuredClone",
  "parseInt",
  "parseFloat",
  "isFinite",
  "isNaN",
  "encodeURIComponent",
  "decodeURIComponent",
  "setTimeout",
  "clearTimeout",
  "console",
  "Bun",
  "process",
  "crypto",
  "performance",
]);

// A syntax-only abstract interpreter. Unknown mutation-bearing behavior is an
// analysis error, rather than evidence that the module performs no writes.
type OrgGraphFunction = Extract<
  Node,
  {
    type:
      | "ArrowFunctionExpression"
      | "FunctionExpression"
      | "FunctionDeclaration"
      | "TSDeclareFunction"
      | "TSEmptyBodyFunctionExpression";
  }
>;
type OrgGraphReferenceExpression = Extract<
  Node,
  {
    type:
      | "Identifier"
      | "Literal"
      | "AwaitExpression"
      | "TSAsExpression"
      | "TSSatisfiesExpression"
      | "TSNonNullExpression"
      | "TSTypeAssertion"
      | "ChainExpression"
      | "ParenthesizedExpression"
      | "TSInstantiationExpression"
      | "MemberExpression"
      | "CallExpression"
      | "ImportExpression";
  }
>;
type OrgGraphContainerExpression = Extract<
  Node,
  {
    type:
      | "ObjectExpression"
      | "ArrayExpression"
      | "TaggedTemplateExpression"
      | "TemplateLiteral"
      | "SequenceExpression";
  }
>;
type OrgGraphOperatorExpression = Extract<
  Node,
  {
    type:
      | "ConditionalExpression"
      | "LogicalExpression"
      | "BinaryExpression"
      | "UnaryExpression";
  }
>;
type OrgGraphBindingPattern = Extract<
  Node,
  {
    type: "Identifier" | "AssignmentPattern" | "ObjectPattern" | "ArrayPattern";
  }
>;
type OrgGraphOtherExpression = Extract<
  Node,
  {
    type:
      | "AssignmentExpression"
      | "UpdateExpression"
      | "ClassExpression"
      | "ClassDeclaration"
      | "NewExpression"
      | "TSTypeAliasDeclaration"
      | "TSInterfaceDeclaration"
      | "TSDeclareFunction";
  }
>;
type OrgGraphStatement = Extract<
  Node,
  {
    type:
      | "Program"
      | "BlockStatement"
      | "ExportNamedDeclaration"
      | "ExportDefaultDeclaration"
      | "VariableDeclaration"
      | "FunctionDeclaration"
      | "ExpressionStatement"
      | "ReturnStatement"
      | "ThrowStatement"
      | "BreakStatement"
      | "ContinueStatement"
      | "IfStatement"
      | "SwitchStatement"
      | "ForOfStatement"
      | "ForStatement"
      | "ForInStatement"
      | "WhileStatement"
      | "DoWhileStatement"
      | "TryStatement"
      | "ImportDeclaration"
      | "ExportAllDeclaration"
      | "EmptyStatement";
  }
>;

const isOrgGraphReferenceExpression = (
  node: Node,
): node is OrgGraphReferenceExpression =>
  node.type === "Identifier" ||
  node.type === "Literal" ||
  node.type === "AwaitExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSSatisfiesExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSTypeAssertion" ||
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSInstantiationExpression" ||
  node.type === "MemberExpression" ||
  node.type === "CallExpression" ||
  node.type === "ImportExpression";

const isOrgGraphContainerExpression = (
  node: Node,
): node is OrgGraphContainerExpression =>
  node.type === "ObjectExpression" ||
  node.type === "ArrayExpression" ||
  node.type === "TaggedTemplateExpression" ||
  node.type === "TemplateLiteral" ||
  node.type === "SequenceExpression";

const isOrgGraphOperatorExpression = (
  node: Node,
): node is OrgGraphOperatorExpression =>
  node.type === "ConditionalExpression" ||
  node.type === "LogicalExpression" ||
  node.type === "BinaryExpression" ||
  node.type === "UnaryExpression";

const isOrgGraphBindingPattern = (node: Node): node is OrgGraphBindingPattern =>
  node.type === "Identifier" ||
  node.type === "AssignmentPattern" ||
  node.type === "ObjectPattern" ||
  node.type === "ArrayPattern";

const isOrgGraphOtherExpression = (
  node: Node,
): node is OrgGraphOtherExpression =>
  node.type === "AssignmentExpression" ||
  node.type === "UpdateExpression" ||
  node.type === "ClassExpression" ||
  node.type === "ClassDeclaration" ||
  node.type === "NewExpression" ||
  node.type === "TSTypeAliasDeclaration" ||
  node.type === "TSInterfaceDeclaration" ||
  node.type === "TSDeclareFunction";

const isOrgGraphStatement = (node: Node): node is OrgGraphStatement =>
  node.type === "Program" ||
  node.type === "BlockStatement" ||
  node.type === "ExportNamedDeclaration" ||
  node.type === "ExportDefaultDeclaration" ||
  node.type === "VariableDeclaration" ||
  node.type === "FunctionDeclaration" ||
  node.type === "ExpressionStatement" ||
  node.type === "ReturnStatement" ||
  node.type === "ThrowStatement" ||
  node.type === "BreakStatement" ||
  node.type === "ContinueStatement" ||
  node.type === "IfStatement" ||
  node.type === "SwitchStatement" ||
  node.type === "ForOfStatement" ||
  node.type === "ForStatement" ||
  node.type === "ForInStatement" ||
  node.type === "WhileStatement" ||
  node.type === "DoWhileStatement" ||
  node.type === "TryStatement" ||
  node.type === "ImportDeclaration" ||
  node.type === "ExportAllDeclaration" ||
  node.type === "EmptyStatement";
const VALIBOT_SCHEMA_FACTORY_NAMES = [
  "object",
  "record",
  "variant",
  "pipe",
  "optional",
  "picklist",
  "boolean",
  "number",
  "literal",
  "unknown",
] as const;
const VALIBOT_ACTION_NAMES = [
  "integer",
  "minLength",
  "maxLength",
  "minValue",
  "maxValue",
] as const;
type OrgGraphValibotActionName = (typeof VALIBOT_ACTION_NAMES)[number];
type OrgGraphPropertyPresence = "closed" | "known-values" | "open";

type OrgGraphArrayExtent =
  { type: "finite"; maximum: number } | { type: "unknown" };

type OrgGraphValue =
  | { kind: "bottom" }
  | { kind: "chain-short-circuit" }
  | { kind: "unknown"; reason: string }
  | { kind: "input"; primitive?: "string" | "boolean" }
  | { kind: "literal"; value: string | number | boolean | null | undefined }
  | { kind: "tx"; scope: "raw" | "scoped" }
  | { kind: "org-scoped-handle" }
  | { kind: "table"; name: string; scope: "org" | "global" }
  | { kind: "column"; table: string; name: string }
  | {
      kind: "object";
      prototypeDisposition: "ordinary" | "unmodeled";
      fields: Map<string, OrgGraphValue>;
      unknownFields: OrgGraphValue;
      keyStability?: "fixed" | "mutable";
      propertyPresence: OrgGraphPropertyPresence;
      // Distinguish a potentially absent key from an own undefined value.
      optionalFields?: Set<string>;
      validation?: { id: string; output: OrgGraphValue };
    }
  | {
      kind: "array";
      stability: "fixed" | "mutable";
      extent: OrgGraphArrayExtent;
      values: OrgGraphValue[];
    }
  | { kind: "set"; stability: "fixed" | "mutable"; values: OrgGraphValue[] }
  | { kind: "schema"; output: OrgGraphValue }
  | { kind: "valibot-action"; name: OrgGraphValibotActionName }
  | { kind: "union"; values: readonly OrgGraphValue[] }
  | { kind: "module"; file: string }
  | {
      kind: "external";
      module: string;
      name: string;
      regexp?: RegExp;
      nativeState?: true;
    }
  | {
      kind: "sql";
      text: string;
      targets: ReadonlyMap<string, OrgGraphValue>;
      unresolved: boolean;
    }
  | { kind: "query"; receiver: OrgGraphValue }
  | { kind: "method"; receiver: OrgGraphValue; name: string }
  | {
      kind: "function";
      file: string;
      node: OrgGraphFunction;
      captures: ReadonlyMap<Identifier, OrgGraphValue>;
      freeBindings: readonly Identifier[];
    };

type OrgGraphHeapValue = Extract<
  OrgGraphValue,
  {
    kind: "object" | "array" | "set" | "function" | "schema";
  }
>;
type OrgGraphHeapSite = {
  frame: OrgGraphFrame;
  node: Node;
  role: string;
};

type OrgGraphNativeStringMethod =
  | "replace"
  | "toLowerCase"
  | "toUpperCase"
  | "slice"
  | "trim"
  | "split"
  | "indexOf";

type OrgGraphArrayValue = Extract<OrgGraphValue, { kind: "array" }>;
type OrgGraphObjectValue = Extract<OrgGraphValue, { kind: "object" }>;

type OrgGraphMemberReference = {
  value: OrgGraphValue;
  receiver: OrgGraphValue | undefined;
  name: string | undefined;
};

type OrgGraphModule = {
  file: string;
  content: string;
  parsed: ReturnType<typeof parseSource>;
  parents: Map<Node, Node>;
};
type OrgGraphExportTarget =
  | {
      kind: "binding";
      declarationFile: string;
      evaluationKey: string;
      binding: Identifier | undefined;
      exportName: string;
      viaExportStar: boolean;
    }
  | {
      kind: "expression";
      declarationFile: string;
      evaluationKey: string;
      expression: Node;
      exportName: string;
      viaExportStar: boolean;
    }
  | {
      kind: "namespace";
      declarationFile: string;
      evaluationKey: string;
      targetFile: string;
      exportName: string;
      viaExportStar: boolean;
    }
  | {
      kind: "external";
      declarationFile: string;
      evaluationKey: string;
      specifier: string;
      name: string;
      exportName: string;
      viaExportStar: boolean;
    };
type OrgGraphDependencyWork =
  | { kind: "node"; file: string; node: Node }
  | { kind: "binding"; file: string; binding: Identifier };
type OrgGraphDependencyState = {
  pending: OrgGraphDependencyWork[];
  exports: Set<string>;
};

const ORG_GRAPH_FINITE_WORK_BUDGET = 100_000;

type OrgGraphCountedIteration = {
  loop: Extract<Node, { type: "ForStatement" }>;
  counter: Identifier;
  position: number;
};
type OrgGraphLoopAllocation = { start: number; end: number; position: number };
type OrgGraphNumberRange = { minimum: number; maximum: number };
type OrgGraphAllocationShape =
  string | number | boolean | readonly OrgGraphAllocationShape[];

type OrgGraphFrame = {
  executionMode: "ordinary" | "array-sort";
  module: OrgGraphModule;
  values: Map<Identifier, OrgGraphValue>;
  lexicalParents?: readonly ReadonlyMap<Identifier, OrgGraphValue>[];
  entry: string;
  // A set representation keeps recursive call traces finite.
  trace: ReadonlyMap<string, string>;
  context: string | undefined;
  allocationContext?: string;
  countedIteration?: OrgGraphCountedIteration;
  loopAllocations?: readonly OrgGraphLoopAllocation[];
};
type OrgGraphContextInputs = {
  signature: string;
  heap: ReadonlyMap<string, string>;
  roots: readonly OrgGraphValue[];
};
type OrgGraphExecution =
  | { type: "unseen" }
  | { type: "running" }
  | { type: "repeat" }
  | { type: "cached"; inputs: OrgGraphContextInputs };
type OrgGraphContext = {
  fn: Extract<OrgGraphValue, { kind: "function" }>;
  args: readonly OrgGraphValue[];
  caller: OrgGraphFrame;
  allocationContext: string;
  result: OrgGraphValue;
  execution: OrgGraphExecution;
  dependents: Set<string>;
};
type OrgGraphCompletion = { frame: OrgGraphFrame } & (
  | { type: "normal" }
  | { type: "return"; value: OrgGraphValue }
  | { type: "throw"; value: OrgGraphValue }
  | { type: "break" | "continue"; target: Node }
);
type OrgGraphFlow = readonly OrgGraphCompletion[];
type OrgGraphDiscriminantCondition = {
  property: string;
  value: string | number | boolean | null;
  equalsWhenTrue: boolean;
};
type OrgGraphDiscriminantFact = {
  property: string;
  value: string | number | boolean | null;
  equals: boolean;
  source: Extract<Node, { type: "IfStatement" }>;
  excludedBranchTruth: boolean;
};
export type OrgWriteGraphHit = OrgWriteScopeHit & {
  file: string;
  entry: string;
};
export type OrgWriteGraphEntry = {
  file: string;
  reasons: readonly (
    | "root-import"
    | "root-door"
    | "policy-owner"
    | "recovery-caller"
    | "delegate-import"
    | "unresolved-import"
  )[];
};
export type SchedulerWriteGraphContract = {
  table: string;
  ownerFile: string;
  globalOwnerFile: string;
  dispositions: ReadonlyMap<string, "organization" | "platform" | "by-task">;
  taskOwnership: ReadonlyMap<string, "organization" | "platform">;
  globalJobs: ReadonlyMap<string, string>;
};

export type ScanOrgWriteGraphOptions = {
  schedulerWriteIntents?: SchedulerWriteGraphContract;

  sources: ReadonlyMap<string, string>;
  entryFiles?: ReadonlySet<string>;
  rootDoorFiles: ReadonlySet<string>;
  // Existing source-class policy entries remain enrolled beside newly derived roots.
  policyEntryFiles: ReadonlySet<string>;
  recoveryOwnerFiles: ReadonlySet<string>;
  orgTables: ReadonlySet<string>;
  globalTables: ReadonlySet<string>;
  // Projected from the actual schema declarations, not camelCase conversion.
  // Maps PostgreSQL relation names to their schema export names.
  sqlTables: ReadonlyMap<string, string>;
};
export type OrgWriteGraphResult = {
  entries: readonly OrgWriteGraphEntry[];
  analyzedEntries: readonly string[];
  reachedRecoveryOwners: readonly string[];
  hits: readonly OrgWriteGraphHit[];
};

type OrgGraphWriteOptions = {
  call: CallExpression;
  frame: OrgGraphFrame;
  receiver: OrgGraphValue;
  target: OrgGraphValue;
  operation: string;
};

type OrgGraphSqlConstructorOptions = {
  node: CallExpression;
  frame: OrgGraphFrame;
  args: readonly OrgGraphValue[];
};

type OrgGraphArrayGuardSite =
  CallExpression | Extract<Node, { type: "ForOfStatement" }>;
type OrgGraphArrayGuardOptions = {
  call: OrgGraphArrayGuardSite;
  receiver: Node;
  frame: OrgGraphFrame;
};

class OrgWriteGraphEngine {
  readonly #options: ScanOrgWriteGraphOptions;

  constructor(options: ScanOrgWriteGraphOptions) {
    this.#options = options;
  }

  readonly #bottom: OrgGraphValue = { kind: "bottom" };

  readonly #raw: OrgGraphValue = { kind: "tx", scope: "raw" };

  readonly #scoped: OrgGraphValue = { kind: "tx", scope: "scoped" };

  readonly #unknown = (reason: string): OrgGraphValue => ({
    kind: "unknown",
    reason,
  });

  readonly #modules = new Map<string, OrgGraphModule>();

  readonly #resolving = new Set<string>();

  readonly #reachedRecovery = new Set<string>();
  readonly #analyzedRecoveryFunctions = new Set<string>();
  readonly #reachedNativeExports = new Set<string>();

  readonly #hits = new Map<string, OrgWriteGraphHit>();

  readonly #analyzed = new Set<string>();

  readonly #rootFile = "apps/api/src/db/root.ts";

  readonly #scopeFile = "apps/api/src/db/org-scope.ts";

  readonly #clientFile = "apps/api/src/db/sql-client.ts";

  readonly #contexts = new Map<string, OrgGraphContext>();

  readonly #pending = new Set<string>();

  #loopSteps = 0;

  // Heap identity is independent of mutable contents and worklist reruns.
  readonly #heapIds = new WeakMap<OrgGraphHeapValue, string>();
  readonly #heap = new Map<string, OrgGraphHeapValue>();
  readonly #heapOrigins = new Map<string, string>();
  readonly #captureProofs = new WeakMap<
    OrgGraphFunction,
    WeakMap<Identifier, boolean>
  >();
  readonly #evalProofs = new WeakMap<OrgGraphFunction, boolean>();
  #nextHeapId = 0;
  readonly #transientIds = new WeakMap<OrgGraphHeapValue, number>();
  #nextTransientId = 0;
  readonly #moduleHeap = new Set<OrgGraphHeapValue>();
  readonly #heapBirthState = new Map<string, string>();
  readonly #cycleEdges = new WeakMap<
    OrgGraphHeapValue,
    readonly OrgGraphHeapValue[]
  >();
  readonly #captureEnvironments = new Map<
    Extract<OrgGraphValue, { kind: "function" }>,
    Map<string, ReadonlyMap<Identifier, OrgGraphValue>>
  >();

  readonly #rootDependencies = new Map<string, boolean>();

  readonly #fail: (frame: OrgGraphFrame, node: Node, reason: string) => never =
    (frame: OrgGraphFrame, node: Node, reason: string): never =>
      panic(
        `Unresolved organization write graph: ${frame.module.file}:${frame.module.parsed.locate(node.start).line}: ${reason}; entry ${frame.entry}; calls ${[...frame.trace.keys()].join(" -> ")}`,
      );

  readonly #moduleAt = (file: string): OrgGraphModule => {
    const existing = this.#modules.get(file);
    if (existing !== undefined) {
      return existing;
    }
    const content =
      this.#options.sources.get(file) ??
      panic(`Unresolved organization write graph: missing source ${file}`);
    const parsed = parseSource(file, content);
    const parents = new Map<Node, Node>();
    walk(parsed.program, (node, ancestors) => {
      const parent = ancestors.at(-1);
      if (parent !== undefined) {
        parents.set(node, parent);
      }
    });
    const result = { file, content, parsed, parents };
    this.#modules.set(file, result);
    return result;
  };

  readonly #localPath = ({
    from,
    specifier,
  }: {
    from: string;
    specifier: string;
  }): string | undefined => {
    if (specifier.endsWith(".json")) {
      return undefined;
    }
    let base: string;
    if (specifier.startsWith("@/api/")) {
      base = `apps/api/src/${specifier.slice(6)}`;
    } else if (specifier.startsWith(".")) {
      base = graphPath.join(graphPath.dirname(from), specifier);
    } else {
      return undefined;
    }
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}/index.ts`,
    ]) {
      if (this.#options.sources.has(candidate)) {
        return candidate;
      }
    }
    const withoutJs = base.replace(/\.[cm]?jsx?$/u, "");
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      if (this.#options.sources.has(`${withoutJs}${extension}`)) {
        return `${withoutJs}${extension}`;
      }
    }
    // Keep the missing local identity: resolving a called export must reject it.
    return base.endsWith(".ts") ? base : `${base}.ts`;
  };

  readonly #alternatives = (value: OrgGraphValue): readonly OrgGraphValue[] => {
    if (value.kind === "union") {
      return value.values;
    }
    if (value.kind === "bottom") {
      return [];
    }
    return [value];
  };

  readonly #isHeapValue = (value: OrgGraphValue): value is OrgGraphHeapValue =>
    value.kind === "object" ||
    value.kind === "array" ||
    value.kind === "set" ||
    value.kind === "schema" ||
    value.kind === "function";

  readonly #referenceKey = (value: OrgGraphHeapValue): string => {
    const owned = this.#heapIds.get(value);
    if (owned !== undefined) {
      return owned;
    }
    // Temporary values can meet in native joins before their allocation boundary.
    // These keys never enter a call context: invocation owns its inputs first.
    let temporary = this.#transientIds.get(value);
    if (temporary === undefined) {
      temporary = this.#nextTransientId++;
      this.#transientIds.set(value, temporary);
    }
    return `unowned:${temporary}`;
  };

  readonly #allocationShape = ({
    value,
    seen = new Set<OrgGraphValue>(),
    depth = 0,
  }: {
    value: OrgGraphValue;
    seen?: Set<OrgGraphValue>;
    depth?: number;
  }): OrgGraphAllocationShape => {
    if (seen.has(value)) {
      return `recursive:${value.kind}`;
    }
    if (depth > 32) {
      panic(
        "Organization allocation provenance exceeds supported finite depth",
      );
    }
    const descendants = new Set(seen);
    descendants.add(value);
    const shape = (child: OrgGraphValue) =>
      this.#allocationShape({
        value: child,
        seen: descendants,
        depth: depth + 1,
      });
    switch (value.kind) {
      case "union": {
        const unique = new Map<string, OrgGraphAllocationShape>();
        for (const child of value.values) {
          const profile = shape(child);
          unique.set(JSON.stringify(profile), profile);
        }
        return [
          "union",
          ...[...unique.keys()]
            .toSorted(compareCodeUnit)
            .map(
              (key) =>
                unique.get(key) ??
                panic("Missing allocation alternative profile"),
            ),
        ];
      }
      case "object":
        return [
          value.kind,
          value.prototypeDisposition,
          [...value.fields]
            .toSorted(([left], [right]) => compareCodeUnit(left, right))
            .map(([key, child]) => [key, shape(child)]),
          shape(value.unknownFields),
        ];
      case "array":
        return [
          value.kind,
          value.stability,
          value.extent.type === "finite"
            ? ["finite", value.extent.maximum]
            : ["unknown"],
          value.values.map((child, index) => [index, shape(child)]),
        ];
      case "set":
        return [
          value.kind,
          value.stability,
          value.values.map((child, index) => [index, shape(child)]),
        ];
      case "function": {
        const captures = this.#captureSnapshot(value);
        return [
          value.kind,
          value.file,
          value.node.start,
          value.freeBindings.map((binding) => [
            binding.start,
            shape(captures.get(binding) ?? this.#bottom),
          ]),
        ];
      }
      case "schema":
        return [value.kind, shape(value.output)];
      case "query":
        return [value.kind, shape(value.receiver)];
      case "method":
        return [value.kind, value.name, shape(value.receiver)];
      case "sql":
        return [
          value.kind,
          value.unresolved,
          value.text,
          [...value.targets]
            .toSorted(([left], [right]) => compareCodeUnit(left, right))
            .map(([key, child]) => [key, shape(child)]),
        ];
      case "bottom":
      case "chain-short-circuit":
      case "unknown":
      case "input":
      case "literal":
      case "tx":
      case "org-scoped-handle":
      case "table":
      case "column":
      case "module":
      case "external":
      case "valibot-action":
        return this.#signature({
          value,
        });
      default:
        value satisfies never;
        return panic("Unknown allocation provenance value");
    }
  };

  readonly #isModuleAllocation = ({
    frame,
    node,
  }: OrgGraphHeapSite): boolean => {
    let ancestor = frame.module.parents.get(node);
    while (ancestor !== undefined && !this.#isFunctionNode(ancestor)) {
      ancestor = frame.module.parents.get(ancestor);
    }
    return ancestor === undefined;
  };

  readonly #allocationOrigin = ({
    frame,
    node,
    role,
  }: OrgGraphHeapSite): string =>
    // Module bindings are shared by every exported entry and imported caller.
    JSON.stringify(
      this.#isModuleAllocation({ frame, node, role })
        ? [frame.module.file, node.start, node.end, role, "module"]
        : [
            frame.entry,
            frame.module.file,
            node.start,
            node.end,
            role,
            frame.allocationContext ?? "module",
            [...frame.trace.keys()].toSorted(compareCodeUnit),
            frame.loopAllocations ?? [],
          ],
    );

  readonly #forkFrame = (frame: OrgGraphFrame): OrgGraphFrame => ({
    ...frame,
    values: new Map(frame.values),
    lexicalParents: [frame.values, ...(frame.lexicalParents ?? [])],
  });

  readonly #captureSnapshot = (
    value: Extract<OrgGraphValue, { kind: "function" }>,
  ): Map<Identifier, OrgGraphValue> => {
    const captures = new Map(value.captures);
    for (const environment of this.#captureEnvironments.get(value)?.values() ??
      []) {
      for (const binding of value.freeBindings) {
        const incoming = environment.get(binding);
        if (incoming !== undefined) {
          captures.set(
            binding,
            this.#join(captures.get(binding) ?? this.#bottom, incoming),
          );
        }
      }
    }
    return captures;
  };

  readonly #rememberCaptureEnvironment = ({
    value,
    environment,
    site,
  }: {
    value: Extract<OrgGraphValue, { kind: "function" }>;
    environment: ReadonlyMap<Identifier, OrgGraphValue>;
    site: OrgGraphHeapSite;
  }): void => {
    const environments = this.#captureEnvironments.get(value) ?? new Map();
    const activation =
      site.frame.context ??
      `module:${site.frame.entry}:${site.frame.module.file}`;
    // Branches keep local bindings, while later declarations initialize their
    // enclosing activation. Both environments remain live for escaping closures.
    for (const [depth, lexicalEnvironment] of [
      environment,
      ...(site.frame.lexicalParents ?? []),
    ].entries()) {
      const key = `${activation}:lexical:${depth}`;
      const previous = environments.get(key);
      if (previous !== undefined && previous !== lexicalEnvironment) {
        const captures = new Map(value.captures);
        for (const binding of value.freeBindings) {
          const incoming = previous.get(binding);
          if (incoming !== undefined) {
            captures.set(
              binding,
              this.#join(captures.get(binding) ?? this.#bottom, incoming),
            );
          }
        }
        value.captures = captures;
      }
      environments.set(key, lexicalEnvironment);
    }
    this.#captureEnvironments.set(value, environments);
  };

  readonly #ownHeapChildren = (
    value: OrgGraphHeapValue,
    site: OrgGraphHeapSite,
  ): void => {
    const own = (child: OrgGraphValue, role: string) =>
      this.#ownValue(child, { ...site, role: `${site.role}/${role}` });
    switch (value.kind) {
      case "object":
        for (const [key, child] of value.fields) {
          value.fields.set(key, own(child, `field:${key}`));
        }
        value.unknownFields = own(value.unknownFields, "unknown");
        if (value.validation !== undefined) {
          value.validation.output = own(
            value.validation.output,
            "validated-output",
          );
        }
        return;
      case "array":
      case "set":
        value.values = value.values.map((child, index) =>
          own(child, `item:${index}`),
        );
        return;
      case "schema":
        value.output = own(value.output, "schema-output");
        return;
      case "function":
        // Captures are live lexical environments, not copied object allocations.
        return;
      default:
        value satisfies never;
        return panic("Unknown owned allocation value");
    }
  };

  readonly #joinPropertyPresence = ({
    left,
    right,
  }: {
    left: OrgGraphPropertyPresence;
    right: OrgGraphPropertyPresence;
  }): OrgGraphPropertyPresence => {
    switch (left) {
      case "closed":
        return right;
      case "open":
        return "open";
      case "known-values":
        switch (right) {
          case "closed":
          case "known-values":
            return "known-values";
          case "open":
            return "open";
          default:
            right satisfies never;
            return panic("Unknown object property presence");
        }
      default:
        left satisfies never;
        return panic("Unknown object property presence");
    }
  };

  readonly #unknownOwnValues = (value: OrgGraphObjectValue): OrgGraphValue => {
    switch (value.propertyPresence) {
      case "closed":
      case "known-values":
        return value.unknownFields;
      case "open":
        return this.#join(value.unknownFields, { kind: "input" });
      default:
        value.propertyPresence satisfies never;
        return panic("Unknown own-value coverage");
    }
  };

  readonly #mergeHeapObject = ({
    target,
    incoming,
  }: {
    target: OrgGraphObjectValue;
    incoming: OrgGraphObjectValue;
  }): void => {
    if (incoming.prototypeDisposition === "unmodeled") {
      target.prototypeDisposition = "unmodeled";
    }
    const oldKeys = new Set(target.fields.keys());
    const optional = new Set([
      ...(target.optionalFields ?? []),
      ...(incoming.optionalFields ?? []),
    ]);
    for (const key of oldKeys) {
      if (!incoming.fields.has(key)) {
        optional.add(key);
      }
    }
    for (const [key, child] of incoming.fields) {
      if (!oldKeys.has(key)) {
        optional.add(key);
      }
      target.fields.set(
        key,
        this.#join(target.fields.get(key) ?? this.#bottom, child),
      );
    }
    target.unknownFields = this.#join(
      target.unknownFields,
      incoming.unknownFields,
    );
    target.optionalFields = optional;
    target.propertyPresence = this.#joinPropertyPresence({
      left: target.propertyPresence,
      right: incoming.propertyPresence,
    });
    if (
      target.keyStability === "mutable" ||
      incoming.keyStability === "mutable" ||
      oldKeys.size !== incoming.fields.size ||
      [...oldKeys].some((key) => !incoming.fields.has(key))
    ) {
      target.keyStability = "mutable";
    }
    if (target.validation !== undefined) {
      if (incoming.validation?.id !== target.validation.id) {
        delete target.validation;
      } else {
        target.validation.output = this.#join(
          target.validation.output,
          incoming.validation.output,
        );
      }
    }
  };

  readonly #maximumArrayExtent = ({
    left,
    right,
  }: {
    left: OrgGraphArrayExtent;
    right: OrgGraphArrayExtent;
  }): OrgGraphArrayExtent =>
    left.type === "finite" && right.type === "finite"
      ? { type: "finite", maximum: Math.max(left.maximum, right.maximum) }
      : { type: "unknown" };

  readonly #sumArrayExtent = ({
    left,
    right,
  }: {
    left: OrgGraphArrayExtent;
    right: OrgGraphArrayExtent;
  }): OrgGraphArrayExtent => {
    if (left.type !== "finite" || right.type !== "finite") {
      return { type: "unknown" };
    }
    const maximum = left.maximum + right.maximum;
    return Number.isSafeInteger(maximum)
      ? { type: "finite", maximum }
      : { type: "unknown" };
  };

  readonly #arrayReceiverExtent = (
    value: OrgGraphValue,
  ): OrgGraphArrayExtent => {
    let extent: OrgGraphArrayExtent = { type: "finite", maximum: 0 };
    for (const part of this.#alternatives(value)) {
      if (part.kind !== "array") {
        return { type: "unknown" };
      }
      extent = this.#maximumArrayExtent({ left: extent, right: part.extent });
    }
    return extent;
  };

  readonly #mergeHeapValue = ({
    target,
    incoming,
  }: {
    target: OrgGraphHeapValue;
    incoming: OrgGraphHeapValue;
  }): void => {
    if (target.kind === "object" && incoming.kind === "object") {
      this.#mergeHeapObject({
        target,
        incoming,
      });
    } else if (target.kind === "array" && incoming.kind === "array") {
      target.extent = this.#maximumArrayExtent({
        left: target.extent,
        right: incoming.extent,
      });
      if (
        target.stability !== incoming.stability ||
        target.values.length !== incoming.values.length
      ) {
        target.stability = "mutable";
      }
      for (const [index, child] of incoming.values.entries()) {
        const previous = target.values.at(index);
        target.values[index] = this.#join(previous ?? this.#bottom, child);
      }
    } else if (target.kind === "set" && incoming.kind === "set") {
      const before = new Set(
        target.values.map((value) =>
          this.#signature({
            value,
          }),
        ),
      );
      if (
        incoming.stability === "mutable" ||
        incoming.values.length !== before.size ||
        incoming.values.some(
          (value) =>
            !before.has(
              this.#signature({
                value,
              }),
            ),
        )
      ) {
        target.stability = "mutable";
      }
      target.values = [
        ...this.#alternatives(this.#join(...target.values, ...incoming.values)),
      ];
    } else if (target.kind === "schema" && incoming.kind === "schema") {
      target.output = this.#join(target.output, incoming.output);
    } else if (target.kind !== incoming.kind) {
      panic("Organization graph allocation changed its value kind");
    }
  };

  readonly #ownValue = (
    value: OrgGraphValue,
    site: OrgGraphHeapSite,
  ): OrgGraphValue => {
    if (value.kind === "union") {
      return this.#join(
        ...value.values.map((part, index) =>
          this.#ownValue(part, {
            ...site,
            role: `${site.role}/alternative:${index}`,
          }),
        ),
      );
    }
    if (!this.#isHeapValue(value)) {
      return value;
    }
    const known = this.#heapIds.get(value);
    if (known !== undefined) {
      return (
        this.#heap.get(known) ??
        panic("Missing canonical organization heap cell")
      );
    }
    const origin = this.#allocationOrigin({
      ...site,
      role: `${site.role}/${value.kind}`,
    });
    const existingId = this.#heapOrigins.get(origin);
    const existing =
      existingId === undefined
        ? undefined
        : (this.#heap.get(existingId) ??
          panic("Missing interned organization heap cell"));
    const id = existingId ?? `heap:${this.#nextHeapId++}`;
    if (existing !== undefined && existing.kind !== value.kind) {
      return this.#fail(
        site.frame,
        site.node,
        "allocation origin changes mutable kind",
      );
    }
    const target = existing ?? value;
    this.#heapOrigins.set(origin, id);
    this.#heapIds.set(value, id);
    this.#heapIds.set(target, id);
    this.#heap.set(id, target);
    if (value.kind === "function" && target.kind === "function") {
      const environment = value.captures;
      if (existing === undefined) {
        value.captures = new Map();
      }
      this.#rememberCaptureEnvironment({
        value: target,
        environment,
        site,
      });
    }
    this.#ownHeapChildren(value, site);
    if (existing !== undefined) {
      this.#mergeHeapValue({
        target: existing,
        incoming: value,
      });
    } else {
      this.#heapBirthState.set(id, this.#heapCellState(target));
    }
    if (this.#isModuleAllocation(site) && target.kind !== "function") {
      this.#moduleHeap.add(target);
    }
    return target;
  };

  readonly #assertNoContainerCycles = (): void => {
    const updates = new Map<OrgGraphHeapValue, readonly OrgGraphHeapValue[]>();
    const pending = [...this.#heap.values()];
    const scanned = new Set<OrgGraphHeapValue>();
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const value = pending.at(cursor) ?? panic("Missing cycle graph node");
      if (value.kind === "function" || scanned.has(value)) {
        continue;
      }
      scanned.add(value);
      const children: OrgGraphHeapValue[] = [];
      let activeUnions: Set<OrgGraphValue> | undefined;
      const collect = (child: OrgGraphValue): void => {
        if (child.kind === "union") {
          activeUnions ??= new Set();
          if (activeUnions.has(child)) {
            panic(
              "Unresolved organization write graph: cyclic abstract object",
            );
          }
          activeUnions.add(child);
          for (const part of child.values) {
            collect(part);
          }
          activeUnions.delete(child);
        } else if (this.#isHeapValue(child) && child.kind !== "function") {
          children.push(child);
        }
      };
      switch (value.kind) {
        case "object":
          for (const child of value.fields.values()) {
            collect(child);
          }
          collect(value.unknownFields);
          break;
        case "array":
        case "set":
          for (const child of value.values) {
            collect(child);
          }
          break;
        case "schema":
          collect(value.output);
          break;
        default:
          value satisfies never;
          return panic("Unknown cycle graph value");
      }
      for (const child of children) {
        pending.push(child);
      }
      const previous = this.#cycleEdges.get(value);
      if (
        previous === undefined ||
        previous.length !== children.length ||
        children.some((child, index) => previous.at(index) !== child)
      ) {
        updates.set(value, children);
      }
    }
    // A new cycle contains a changed edge. Validate those roots against the
    // complete current graph, and commit cached edges only after success.
    const completed = new Set<OrgGraphHeapValue>();
    const active = new Set<OrgGraphHeapValue>();
    const visit = (value: OrgGraphHeapValue): void => {
      if (completed.has(value)) {
        return;
      }
      if (active.has(value)) {
        panic("Unresolved organization write graph: cyclic abstract object");
      }
      active.add(value);
      const children =
        updates.get(value) ??
        this.#cycleEdges.get(value) ??
        panic("Missing cycle graph edges");
      for (const child of children) {
        visit(child);
      }
      active.delete(value);
      completed.add(value);
    };
    for (const value of updates.keys()) {
      visit(value);
    }
    for (const [value, children] of updates) {
      this.#cycleEdges.set(value, children);
    }
  };

  readonly #heapCellState = (value: OrgGraphHeapValue): string => {
    switch (value.kind) {
      case "object":
        return JSON.stringify([
          value.prototypeDisposition,
          value.propertyPresence,
          value.keyStability,
          [...value.fields]
            .map(([key, child]) => [
              key,
              this.#signature({
                value: child,
              }),
            ])
            .toSorted(([a], [b]) => compareCodeUnit(a ?? "", b ?? "")),
          this.#signature({
            value: value.unknownFields,
          }),
          [...(value.optionalFields ?? [])].toSorted(compareCodeUnit),
          value.validation === undefined
            ? null
            : [
                value.validation.id,
                this.#signature({
                  value: value.validation.output,
                }),
              ],
        ]);
      case "array":
        return JSON.stringify([
          value.stability,
          value.extent,
          value.values.map((child) => this.#signature({ value: child })),
        ]);
      case "set":
        return JSON.stringify([
          value.stability,
          value.values.map((child) =>
            this.#signature({
              value: child,
            }),
          ),
        ]);
      case "schema":
        return this.#signature({
          value: value.output,
        });
      case "function": {
        const captures = this.#captureSnapshot(value);
        return JSON.stringify(
          value.freeBindings.map((binding) => [
            binding.start,
            this.#signature({
              value: captures.get(binding) ?? this.#bottom,
            }),
          ]),
        );
      }
      default:
        value satisfies never;
        return panic("Unknown organization heap value");
    }
  };

  readonly #persistentHeapSnapshot = (
    roots: readonly OrgGraphValue[],
  ): Map<string, string> => {
    this.#assertNoContainerCycles();
    const result = new Map<string, string>();
    const seen = new Set<OrgGraphValue>();
    const visit = (value: OrgGraphValue): void => {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      if (this.#isHeapValue(value)) {
        result.set(this.#referenceKey(value), this.#heapCellState(value));
      }
      switch (value.kind) {
        case "object":
          for (const child of value.fields.values()) {
            visit(child);
          }
          visit(value.unknownFields);
          if (value.validation !== undefined) {
            visit(value.validation.output);
          }
          return;
        case "array":
        case "set":
        case "union":
          for (const child of value.values) {
            visit(child);
          }
          return;
        case "function": {
          const captures = this.#captureSnapshot(value);
          for (const binding of value.freeBindings) {
            const child = captures.get(binding);
            if (child !== undefined) {
              visit(child);
            }
          }
          return;
        }
        case "schema":
          visit(value.output);
          return;
        case "query":
        case "method":
          visit(value.receiver);
          return;
        case "sql":
          for (const child of value.targets.values()) {
            visit(child);
          }
          return;
        case "bottom":
        case "chain-short-circuit":
        case "column":
        case "external":
        case "input":
        case "literal":
        case "module":
        case "table":
        case "tx":
        case "org-scoped-handle":
        case "unknown":
        case "valibot-action":
          return;
        default:
          value satisfies never;
          return panic("Unknown relevant graph value");
      }
    };
    for (const root of roots) {
      visit(root);
    }
    return result;
  };

  readonly #persistentHeapChanged = (
    before: ReadonlyMap<string, string>,
    roots: readonly OrgGraphValue[],
  ): boolean => {
    const after = this.#persistentHeapSnapshot([...roots, ...this.#moduleHeap]);
    for (const [id, state] of after) {
      // Lazy module declarations may be first evaluated inside this call. Their
      // creation is not a mutation; compare a newly reachable cell to its birth.
      const previous = before.get(id) ?? this.#heapBirthState.get(id);
      if (previous !== state) {
        return true;
      }
    }
    return false;
  };

  readonly #queueCompletedContexts = (): void => {
    for (const [key, context] of this.#contexts) {
      if (context.execution.type !== "running") {
        this.#pending.add(key);
      }
    }
  };

  readonly #signature = ({
    value,
    depth = 0,
    seen = new Set<OrgGraphValue>(),
  }: {
    value: OrgGraphValue;
    depth?: number;
    seen?: Set<OrgGraphValue>;
  }): string => {
    const reference = this.#isHeapValue(value)
      ? this.#referenceKey(value)
      : undefined;
    if (reference !== undefined) {
      return `${value.kind}:ref:${reference}`;
    }
    if (seen.has(value)) {
      if (value.kind === "function") {
        return `recursive-fn:${value.file}:${value.node.start}`;
      }
      return panic(
        "Unresolved organization write graph: cyclic abstract object",
      );
    }
    const descendants = new Set(seen);
    descendants.add(value);
    if (depth > 32) {
      return panic(
        "Unresolved organization write graph: abstract value depth exceeds supported finite domain",
      );
    }
    const encode = (child: OrgGraphValue) =>
      this.#signature({
        value: child,
        depth: depth + 1,
        seen: descendants,
      });
    switch (value.kind) {
      case "bottom":
        return "bottom";
      case "chain-short-circuit":
        return "chain-short-circuit";
      case "unknown":
        return "unknown";
      case "input":
        return value.primitive === undefined
          ? "input"
          : `input:${value.primitive}`;
      case "literal":
        if (typeof value.value === "number") {
          let number = String(value.value);
          if (Number.isNaN(value.value)) {
            number = "NaN";
          }
          if (Object.is(value.value, -0)) {
            number = "-0";
          }
          return `literal:number:${number}`;
        }
        return `literal:${JSON.stringify(value.value)}`;
      case "org-scoped-handle":
        return "org-scoped-handle";
      case "tx":
        return `tx:${value.scope}`;
      case "table":
        return `table:${value.scope}:${value.name}`;
      case "column":
        return `column:${value.table}:${value.name}`;
      case "external":
        return `external:${value.module}:${value.name}:${value.nativeState === true}:${value.regexp === undefined ? "" : JSON.stringify({ source: value.regexp.source, flags: value.regexp.flags })}`;
      case "module":
        return `module:${value.file}`;
      case "schema":
        return `schema:${encode(value.output)}`;
      case "valibot-action":
        return `valibot-action:${value.name}`;
      case "query":
        return `query:${encode(value.receiver)}`;
      case "method":
        return `method:${encode(value.receiver)}:${value.name}`;
      case "sql":
        return `sql:${value.unresolved}:${value.text}:${[...value.targets].map(([key, child]) => `${key}=${encode(child)}`).join(";")}`;
      case "object":
        return `object:${value.prototypeDisposition}:${value.propertyPresence}:${value.keyStability ?? "fixed"}:${[
          ...value.fields,
        ]
          .toSorted(([a], [b]) => compareCodeUnit(a, b))
          .map(([key, child]) => `${JSON.stringify(key)}=${encode(child)}`)
          .join(
            ";",
          )};*=${encode(value.unknownFields)};optional=${JSON.stringify([...(value.optionalFields ?? [])].toSorted(compareCodeUnit))};validated=${value.validation === undefined ? "" : `${value.validation.id}:${encode(value.validation.output)}`}`;
      case "array":
        return `${value.kind}:${value.stability}:${JSON.stringify(value.extent)}:${value.values.map(encode).join(";")}`;
      case "set":
        return `${value.kind}:${value.stability}:${value.values.map(encode).join(";")}`;
      case "union":
        return `union:${value.values.map(encode).toSorted().join(";")}`;
      case "function":
        return `fn:${value.file}:${value.node.start}:${value.freeBindings
          .map(
            (binding) =>
              `${binding.start}=${encode(value.captures.get(binding) ?? this.#unknown("uninitialized lexical binding"))}`,
          )
          .toSorted()
          .join(";")}`;
      default:
        value satisfies never;
        return panic("Unknown organization write graph value");
    }
  };

  readonly #join = (...values: readonly OrgGraphValue[]): OrgGraphValue => {
    const distinct = new Map<string, OrgGraphValue>();
    for (const value of values) {
      for (const part of this.#alternatives(value)) {
        distinct.set(
          this.#signature({
            value: part,
          }),
          part,
        );
      }
    }
    if (distinct.size === 0) {
      return this.#bottom;
    }
    if (distinct.size === 1) {
      return distinct.values().next().value ?? this.#bottom;
    }
    if (distinct.size > 128) {
      return panic(
        "Unresolved organization write graph: abstract union exceeds supported finite domain",
      );
    }
    return { kind: "union", values: [...distinct.values()] };
  };

  readonly #relevant = (
    value: OrgGraphValue,
    seen = new Set<OrgGraphValue>(),
  ): boolean => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    switch (value.kind) {
      case "org-scoped-handle":
      case "tx":
      case "query":
      case "method":
        return true;
      case "schema":
        return this.#relevant(value.output, seen);
      case "object":
        return [value.unknownFields, ...value.fields.values()].some((child) =>
          this.#relevant(child, seen),
        );
      case "array":
      case "set":
      case "union":
        return value.values.some((child) => this.#relevant(child, seen));
      case "function": {
        const captures = this.#captureSnapshot(value);
        return value.freeBindings.some((binding) =>
          this.#relevant(captures.get(binding) ?? this.#bottom, seen),
        );
      }
      case "bottom":
      case "chain-short-circuit":
      case "unknown":
      case "input":
      case "literal":
      case "table":
      case "column":
      case "module":
      case "external":
      case "sql":
      case "valibot-action":
        return false;
      default:
        value satisfies never;
        return panic("Unknown organization write graph value");
    }
  };

  readonly #containsScopedCapability = (
    value: OrgGraphValue,
    seen = new Set<OrgGraphValue>(),
  ): boolean => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    switch (value.kind) {
      case "org-scoped-handle":
        return true;
      case "tx":
        return value.scope === "scoped";
      case "query":
      case "method":
        return this.#containsScopedCapability(value.receiver, seen);
      case "schema":
        return this.#containsScopedCapability(value.output, seen);
      case "object":
        return [value.unknownFields, ...value.fields.values()].some((child) =>
          this.#containsScopedCapability(child, seen),
        );
      case "array":
      case "set":
      case "union":
        return value.values.some((child) =>
          this.#containsScopedCapability(child, seen),
        );
      case "function": {
        const captures = this.#captureSnapshot(value);
        return value.freeBindings.some((binding) =>
          this.#containsScopedCapability(
            captures.get(binding) ?? this.#bottom,
            seen,
          ),
        );
      }
      case "bottom":
      case "chain-short-circuit":
      case "unknown":
      case "input":
      case "literal":
      case "table":
      case "column":
      case "module":
      case "external":
      case "sql":
      case "valibot-action":
        return false;
      default:
        value satisfies never;
        return panic("Unknown organization write graph value");
    }
  };

  readonly #containsCallable = (
    value: OrgGraphValue,
    seen = new Set<OrgGraphValue>(),
  ): boolean => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (value.kind === "function") {
      return true;
    }
    if (value.kind === "schema") {
      return this.#containsCallable(value.output, seen);
    }
    if (
      value.kind === "array" ||
      value.kind === "set" ||
      value.kind === "union"
    ) {
      return value.values.some((child) => this.#containsCallable(child, seen));
    }
    if (value.kind === "object") {
      return [value.unknownFields, ...value.fields.values()].some((child) =>
        this.#containsCallable(child, seen),
      );
    }
    return false;
  };

  readonly #isFunctionNode = (node: Node): node is OrgGraphFunction =>
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration";

  readonly #functionValue = (
    node: OrgGraphFunction,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const freeBindings = new Set<Identifier>();
    walk(node, (child) => {
      if (
        child.type !== "Identifier" ||
        !isReferencePosition(child, frame.module.parents)
      ) {
        return;
      }
      const binding = resolveDeclaration(child, frame.module.parents);
      if (
        binding === undefined ||
        (binding.start >= node.start && binding.end <= node.end)
      ) {
        return;
      }
      freeBindings.add(binding);
    });
    // JavaScript closures retain their lexical environment, including constants
    // initialized after closure creation. Invocation freezes that environment.
    return this.#ownValue(
      {
        kind: "function",
        file: frame.module.file,
        node,
        captures: frame.values,
        freeBindings: [...freeBindings],
      },
      { frame, node, role: "function" },
    );
  };

  readonly #tableValue = (name: string): OrgGraphValue => {
    if (this.#options.schedulerWriteIntents?.table === name) {
      return { kind: "table", name, scope: "org" };
    }
    if (this.#options.orgTables.has(name)) {
      return { kind: "table", name, scope: "org" };
    }
    if (this.#options.globalTables.has(name)) {
      return { kind: "table", name, scope: "global" };
    }
    return this.#unknown(`unclassified schema export ${name}`);
  };

  readonly #imported = ({
    from,
    specifier,
    name,
  }: {
    from: string;
    specifier: string;
    name: string;
  }): OrgGraphValue => {
    const file = this.#localPath({
      from,
      specifier,
    });
    if (this.#nativeMutationExport(file, name)) {
      return {
        kind: "external",
        module: file ?? panic("Native mutation owner has no file"),
        name,
      };
    }
    if (file === this.#rootFile && isRootConnectionExport(name)) {
      this.#moduleAt(this.#rootFile);
      return this.#raw;
    }
    if (
      file === this.#clientFile &&
      (name === "createDatabase" || name === "createSqlClient")
    ) {
      this.#moduleAt(this.#clientFile);
      return { kind: "external", module: this.#clientFile, name };
    }
    if (file === this.#scopeFile && name === "withOrgScope") {
      this.#moduleAt(this.#scopeFile);
      return { kind: "external", module: this.#scopeFile, name };
    }
    if (SCHEMA_MODULE.test(specifier)) {
      const table = this.#tableValue(name);
      if (table.kind !== "unknown") {
        return table;
      }
    }
    if (file === undefined) {
      return { kind: "external", module: specifier, name };
    }
    if (name === "*") {
      return { kind: "module", file };
    }
    return this.#exported(file, name);
  };

  readonly #runtimeExportNames = (
    file: string,
    resolving = new Set<string>(),
  ): ReadonlySet<string> => {
    if (resolving.has(file)) {
      return panic(
        `Unresolved organization write graph: cyclic export namespace ${file}`,
      );
    }
    resolving.add(file);
    const module = this.#moduleAt(file);
    const names = new Set<string>();
    for (const statement of module.parsed.program.body) {
      if (statement.type === "ExportDefaultDeclaration") {
        names.add("default");
      }
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.exportKind !== "type"
      ) {
        if (statement.declaration !== null) {
          for (const binding of statementDeclarations([statement])) {
            names.add(binding.name);
          }
        }
        for (const specifier of statement.specifiers) {
          if (specifier.exportKind === "type") {
            continue;
          }
          names.add(
            specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : specifier.exported.value,
          );
        }
      }
      if (
        statement.type !== "ExportAllDeclaration" ||
        statement.exportKind === "type"
      ) {
        continue;
      }
      if (statement.exported !== null) {
        names.add(
          statement.exported.type === "Identifier"
            ? statement.exported.name
            : statement.exported.value,
        );
        continue;
      }
      const targetFile = this.#localPath({
        from: file,
        specifier: statement.source.value,
      });
      if (targetFile === undefined) {
        continue;
      }
      for (const name of this.#runtimeExportNames(targetFile, resolving)) {
        if (name !== "default") {
          names.add(name);
        }
      }
    }
    resolving.delete(file);
    return names;
  };

  readonly #exportStarTargets = ({
    file,
    evaluationKey,
    viaExportStar,
    resolving,
  }: {
    file: string;
    evaluationKey: string;
    viaExportStar: boolean;
    resolving: Set<string>;
  }): readonly OrgGraphExportTarget[] => {
    const key = `${file}#*`;
    const module = this.#moduleAt(file);
    const targets: OrgGraphExportTarget[] = [];
    for (const exportName of this.#runtimeExportNames(file)) {
      targets.push(
        ...this.#exportTargets({
          file,
          name: exportName,
          viaExportStar,
          resolving,
        }),
      );
    }
    for (const statement of module.parsed.program.body) {
      if (
        statement.type !== "ExportAllDeclaration" ||
        statement.exportKind === "type" ||
        statement.exported !== null ||
        this.#localPath({
          from: file,
          specifier: statement.source.value,
        }) !== undefined
      ) {
        continue;
      }
      targets.push({
        kind: "external",
        declarationFile: file,
        evaluationKey,
        specifier: statement.source.value,
        name: "*",
        exportName: "*",
        viaExportStar,
      });
    }
    resolving.delete(key);
    return targets;
  };

  readonly #exportTargets = ({
    file,
    name,
    viaExportStar = false,
    evaluationKey = file,
    resolving = new Set<string>(),
  }: {
    file: string;
    name: string;
    viaExportStar?: boolean;
    evaluationKey?: string;
    resolving?: Set<string>;
  }): readonly OrgGraphExportTarget[] => {
    const key = `${file}#${name}`;
    if (resolving.has(key)) {
      return panic(`Unresolved organization write graph: cyclic export ${key}`);
    }
    resolving.add(key);
    if (name === "*") {
      return this.#exportStarTargets({
        file,
        evaluationKey,
        viaExportStar,
        resolving,
      });
    }
    const module = this.#moduleAt(file);
    const targets: OrgGraphExportTarget[] = [];

    for (const statement of module.parsed.program.body) {
      if (statement.type === "ExportDefaultDeclaration" && name === "default") {
        targets.push({
          kind: "expression",
          declarationFile: file,
          evaluationKey,
          expression: statement.declaration,
          exportName: name,
          viaExportStar,
        });
      }
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.exportKind !== "type"
      ) {
        if (statement.declaration !== null) {
          for (const binding of statementDeclarations([statement])) {
            if (binding.name === name) {
              targets.push({
                kind: "binding",
                declarationFile: file,
                evaluationKey,
                binding,
                exportName: name,
                viaExportStar,
              });
            }
          }
        }
        for (const specifier of statement.specifiers) {
          if (specifier.exportKind === "type") {
            continue;
          }
          const exportedName =
            specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : specifier.exported.value;
          if (exportedName !== name) {
            continue;
          }
          const local =
            specifier.local.type === "Identifier"
              ? specifier.local.name
              : specifier.local.value;
          if (statement.source !== null) {
            const source = statement.source.value;
            const targetFile = this.#localPath({
              from: file,
              specifier: source,
            });
            if (
              targetFile === undefined ||
              SCHEMA_MODULE.test(source) ||
              targetFile === this.#rootFile ||
              targetFile === this.#scopeFile
            ) {
              targets.push({
                kind: "external",
                declarationFile: file,
                evaluationKey,
                specifier: source,
                name: local,
                exportName: name,
                viaExportStar,
              });
              continue;
            }
            const inherited = this.#exportTargets({
              file: targetFile,
              name: local,
              viaExportStar,
              evaluationKey: `${evaluationKey}#${file}:${specifier.start}`,
              resolving,
            });
            if (inherited.length === 0) {
              return panic(
                `Unresolved organization write graph: missing export ${targetFile}#${local}`,
              );
            }
            targets.push(
              ...inherited.map((target) => ({ ...target, exportName: name })),
            );
            continue;
          }
          const binding = [
            ...statementDeclarations(module.parsed.program.body),
          ].find((candidate) => candidate.name === local);
          targets.push({
            kind: "binding",
            declarationFile: file,
            evaluationKey,
            binding,
            exportName: name,
            viaExportStar,
          });
        }
      }
      if (
        statement.type !== "ExportAllDeclaration" ||
        statement.exportKind === "type"
      ) {
        continue;
      }
      const targetFile = this.#localPath({
        from: file,
        specifier: statement.source.value,
      });
      if (statement.exported !== null) {
        const exportedName =
          statement.exported.type === "Identifier"
            ? statement.exported.name
            : statement.exported.value;
        if (exportedName === name) {
          if (targetFile === undefined) {
            targets.push({
              kind: "external",
              declarationFile: file,
              evaluationKey,
              specifier: statement.source.value,
              name: "*",
              exportName: name,
              viaExportStar,
            });
          } else {
            targets.push({
              kind: "namespace",
              declarationFile: file,
              evaluationKey,
              targetFile,
              exportName: name,
              viaExportStar,
            });
          }
        }
        continue;
      }
      if (targetFile === undefined) {
        continue;
      }
      const inherited = this.#exportTargets({
        file: targetFile,
        name,
        viaExportStar: true,
        evaluationKey: `${evaluationKey}#${file}:${statement.start}`,
        resolving,
      });
      targets.push(
        ...inherited.map((target) => ({ ...target, exportName: name })),
      );
    }
    resolving.delete(key);
    return targets;
  };

  readonly #exported = (file: string, name: string): OrgGraphValue => {
    const key = `${file}#${name}`;
    if (this.#resolving.has(key)) {
      return panic(`Unresolved organization write graph: cyclic export ${key}`);
    }
    this.#resolving.add(key);
    const module = this.#moduleAt(file);
    const frame: OrgGraphFrame = {
      executionMode: "ordinary",
      module,
      values: new Map(),
      entry: file,
      trace: new Map(),
      context: undefined,
    };
    const frames = new Map([[file, frame]]);
    const frameFor = (
      evaluationKey: string,
      declarationFile: string,
    ): OrgGraphFrame => {
      const known = frames.get(evaluationKey);
      if (known !== undefined) {
        return known;
      }
      const targetModule = this.#moduleAt(declarationFile);
      const targetFrame: OrgGraphFrame = {
        executionMode: "ordinary",
        module: targetModule,
        values: new Map(),
        entry: declarationFile,
        trace: new Map(),
        context: undefined,
      };
      frames.set(evaluationKey, targetFrame);
      return targetFrame;
    };
    let value: OrgGraphValue = this.#bottom;
    for (const target of this.#exportTargets({ file, name })) {
      let candidate: OrgGraphValue;
      switch (target.kind) {
        case "binding":
          candidate =
            target.binding === undefined
              ? this.#unknown(`missing export binding ${key}`)
              : this.#bindingValue(
                  target.binding,
                  frameFor(target.evaluationKey, target.declarationFile),
                );
          break;
        case "expression":
          candidate = this.#evaluate(
            target.expression,
            frameFor(target.evaluationKey, target.declarationFile),
          );
          break;
        case "namespace":
          candidate = { kind: "module", file: target.targetFile };
          break;
        case "external":
          candidate = this.#imported({
            from: target.declarationFile,
            specifier: target.specifier,
            name: target.name,
          });
          break;
        default: {
          target satisfies never;
          return panic(
            `Unresolved organization write graph: unknown export target ${String(target)}`,
          );
        }
      }
      if (
        target.viaExportStar &&
        (candidate.kind === "unknown" || candidate.kind === "bottom")
      ) {
        continue;
      }
      value = candidate;
    }
    this.#resolving.delete(key);
    return value.kind === "bottom"
      ? panic(`Unresolved organization write graph: missing export ${key}`)
      : value;
  };

  readonly #taggedErrorClassTag = ({
    node,
    frame,
  }: {
    node: Extract<Node, { type: "ClassDeclaration" }>;
    frame: OrgGraphFrame;
  }): string | undefined => {
    const superclass = node.superClass;
    if (superclass?.type !== "Identifier") {
      return undefined;
    }
    const baseBinding = resolveDeclaration(superclass, frame.module.parents);
    const baseHolder =
      baseBinding === undefined
        ? undefined
        : frame.module.parents.get(baseBinding);
    const baseDeclaration =
      baseHolder?.type === "VariableDeclarator"
        ? frame.module.parents.get(baseHolder)
        : undefined;
    if (
      baseHolder?.type !== "VariableDeclarator" ||
      baseDeclaration?.type !== "VariableDeclaration" ||
      baseDeclaration.kind !== "const" ||
      baseHolder.init?.type !== "CallExpression" ||
      baseHolder.init.optional ||
      baseHolder.init.arguments.length !== 1
    ) {
      return undefined;
    }
    const factory = this.#evaluate(baseHolder.init.callee, frame);
    const factories = this.#alternatives(factory);
    const isCanonicalFactory =
      factories.length > 0 &&
      factories.every(
        (part) =>
          part.kind === "external" &&
          part.module === "better-result" &&
          part.name === "TaggedError",
      );
    const tagArgument = baseHolder.init.arguments.at(0);
    if (
      !isCanonicalFactory ||
      tagArgument === undefined ||
      tagArgument.type === "SpreadElement" ||
      tagArgument.type !== "Literal" ||
      typeof tagArgument.value !== "string"
    ) {
      return undefined;
    }
    return tagArgument.value;
  };

  readonly #hasTaggedErrorConstructorShape = ({
    node,
    frame,
  }: {
    node: Extract<Node, { type: "ClassDeclaration" }>;
    frame: OrgGraphFrame;
  }): boolean => {
    const constructor = node.body.body.at(0);
    const validClassShape =
      node.decorators.length === 0 &&
      node.body.body.length === 1 &&
      constructor?.type === "MethodDefinition" &&
      constructor.kind === "constructor" &&
      constructor.computed === false &&
      constructor.static === false &&
      constructor.decorators.length === 0 &&
      constructor.key.type === "Identifier" &&
      constructor.key.name === "constructor" &&
      constructor.value.async === false &&
      constructor.value.generator === false &&
      constructor.value.params.length === 1 &&
      constructor.value.params.at(0)?.type === "Identifier" &&
      constructor.value.body?.body.length === 1 &&
      constructor.value.body.body.at(0)?.type === "ExpressionStatement";
    if (!validClassShape || constructor?.type !== "MethodDefinition") {
      return false;
    }
    const parameter = constructor.value.params.at(0);
    const statement = constructor.value.body?.body.at(0);
    if (
      parameter?.type !== "Identifier" ||
      parameter.decorators.length !== 0 ||
      statement?.type !== "ExpressionStatement" ||
      statement.expression.type !== "CallExpression" ||
      statement.expression.callee.type !== "Super" ||
      statement.expression.optional ||
      statement.expression.arguments.length !== 1
    ) {
      return false;
    }
    const metadata = statement.expression.arguments.at(0);
    if (
      metadata?.type !== "ObjectExpression" ||
      metadata.properties.length !== 1
    ) {
      return false;
    }
    const property = metadata.properties.at(0);
    if (
      property === undefined ||
      !isObjectLiteralProperty(property, metadata) ||
      property.kind !== "init" ||
      property.computed ||
      !property.shorthand ||
      staticPropertyName(property) !== "message" ||
      property.value.type !== "Identifier" ||
      resolveDeclaration(property.value, frame.module.parents) !== parameter
    ) {
      return false;
    }
    return true;
  };

  readonly #taggedErrorClassValue = (
    node: Extract<Node, { type: "ClassDeclaration" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const tag = this.#taggedErrorClassTag({ node, frame });
    if (tag === undefined) {
      return this.#unknown("unmodeled source class constructor");
    }
    if (!this.#hasTaggedErrorConstructorShape({ node, frame })) {
      return this.#fail(
        frame,
        node,
        "tagged-error subclass has unsupported constructor behavior",
      );
    }
    return {
      kind: "external",
      module: "better-result",
      name: `${TAGGED_ERROR_CLASS_PREFIX}${tag}>`,
      nativeState: true,
    };
  };

  readonly #bindingValue = (
    binding: Identifier,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const known = frame.values.get(binding);
    if (known !== undefined) {
      return known;
    }
    const holder = frame.module.parents.get(binding);
    if (holder === undefined) {
      return this.#unknown(`unbound ${binding.name}`);
    }
    if (
      holder.type === "ImportSpecifier" ||
      holder.type === "ImportDefaultSpecifier" ||
      holder.type === "ImportNamespaceSpecifier"
    ) {
      const declaration = frame.module.parents.get(holder);
      if (
        declaration?.type !== "ImportDeclaration" ||
        declaration.importKind === "type" ||
        (holder.type === "ImportSpecifier" && holder.importKind === "type")
      ) {
        return this.#unknown("type-only import");
      }
      let name = "*";
      if (holder.type === "ImportDefaultSpecifier") {
        name = "default";
      }
      if (holder.type === "ImportSpecifier") {
        name =
          holder.imported.type === "Identifier"
            ? holder.imported.name
            : holder.imported.value;
      }
      if (isDataImport(declaration)) {
        return { kind: "input" };
      }
      return this.#imported({
        from: frame.module.file,
        specifier: declaration.source.value,
        name,
      });
    }
    if (holder.type === "VariableDeclarator") {
      const declaration = frame.module.parents.get(holder);
      if (
        declaration?.type !== "VariableDeclaration" ||
        declaration.kind !== "const"
      ) {
        return this.#unknown(`mutable binding ${binding.name}`);
      }
      if (holder.init === null) {
        return this.#unknown(`uninitialized ${binding.name}`);
      }
      const key = `${frame.module.file}:${binding.start}:${frame.context ?? "module"}`;
      if (this.#resolving.has(key)) {
        return this.#unknown(`recursive value ${binding.name}`);
      }
      this.#resolving.add(key);
      const value = this.#evaluate(holder.init, frame);
      this.#bind({
        pattern: holder.id,
        value,
        frame,
      });
      this.#resolving.delete(key);
      return frame.values.get(binding) ?? value;
    }
    if (holder.type === "ClassDeclaration" && holder.id === binding) {
      return this.#taggedErrorClassValue(holder, frame);
    }
    if (this.#isFunctionNode(holder)) {
      return holder.id === binding
        ? this.#functionValue(holder, frame)
        : this.#unknown(`unbound parameter ${binding.name}`);
    }
    // A destructured declaration is bound from its full initializer, never by
    // guessing a field from the identifier's spelling.
    let ancestor: Node | undefined = holder;
    while (
      ancestor !== undefined &&
      ancestor.type !== "VariableDeclarator" &&
      !this.#isFunctionNode(ancestor)
    ) {
      ancestor = frame.module.parents.get(ancestor);
    }
    if (ancestor?.type === "VariableDeclarator" && ancestor.init !== null) {
      this.#bind({
        pattern: ancestor.id,
        value: this.#evaluate(ancestor.init, frame),
        frame,
      });
      return (
        frame.values.get(binding) ??
        this.#unknown(`unresolved destructuring ${binding.name}`)
      );
    }
    return this.#unknown(`external parameter ${binding.name}`);
  };

  readonly #absentOwnFieldValue = (
    value: OrgGraphObjectValue,
    name: string,
  ): OrgGraphValue =>
    value.prototypeDisposition === "unmodeled" ||
    Object.hasOwn(Object.prototype, name)
      ? this.#unknown(`unmodeled inherited object field ${name}`)
      : { kind: "literal", value: undefined };

  readonly #arrayElementValue = ({
    array,
    index,
  }: {
    array: OrgGraphArrayValue;
    index: OrgGraphValue;
  }): OrgGraphValue => {
    if (
      array.stability === "fixed" &&
      index.kind === "literal" &&
      (typeof index.value === "number" || index.value === undefined)
    ) {
      return (
        array.values.at(index.value ?? 0) ?? {
          kind: "literal",
          value: undefined,
        }
      );
    }
    // An uncertain extent or index can miss. Absence belongs to the lookup
    // result; it does not become a stored value observed by array iteration.
    return this.#join(...array.values, { kind: "literal", value: undefined });
  };

  readonly #field = ({
    value,
    name,
    frame,
  }: {
    value: OrgGraphValue;
    name: string;
    frame: OrgGraphFrame;
  }): OrgGraphValue =>
    this.#join(
      ...this.#alternatives(value).map((part): OrgGraphValue => {
        const reflected = this.#nativeReflectionField({ value: part, name });
        if (reflected !== undefined) {
          return reflected;
        }
        if (name === "length") {
          if (part.kind === "literal" && typeof part.value === "string") {
            return { kind: "literal", value: part.value.length };
          }
          if (part.kind === "array") {
            return part.stability === "fixed"
              ? { kind: "literal", value: part.values.length }
              : { kind: "input" };
          }
        }
        if (part.kind === "org-scoped-handle") {
          return name === "tx"
            ? this.#scoped
            : { kind: "literal", value: undefined };
        }
        if (part.kind === "object") {
          const unknownValues = part.fields.has(name)
            ? part.unknownFields
            : this.#unknownOwnValues(part);
          const field = this.#join(
            part.fields.get(name) ?? this.#bottom,
            unknownValues,
          );
          if (!part.fields.has(name) && unknownValues.kind !== "bottom") {
            return this.#join(field, this.#absentOwnFieldValue(part, name));
          }
          if (field.kind !== "bottom") {
            return part.optionalFields?.has(name)
              ? this.#join(field, this.#absentOwnFieldValue(part, name))
              : field;
          }
          if (
            part.propertyPresence === "closed" &&
            part.keyStability !== "mutable" &&
            part.prototypeDisposition === "ordinary" &&
            !Object.hasOwn(Object.prototype, name)
          ) {
            return { kind: "literal", value: undefined };
          }
          return this.#unknown(`missing object field ${name}`);
        }
        if (part.kind === "module") {
          if (SCHEMA_MODULE.test(part.file)) {
            const table = this.#tableValue(name);
            if (table.kind !== "unknown") {
              return table;
            }
          }
          if (this.#nativeMutationExport(part.file, name)) {
            return { kind: "external", module: part.file, name };
          }
          if (part.file === this.#rootFile && isRootConnectionExport(name)) {
            this.#moduleAt(this.#rootFile);
            return this.#raw;
          }
          if (
            part.file === this.#clientFile &&
            (name === "createDatabase" || name === "createSqlClient")
          ) {
            this.#moduleAt(this.#clientFile);
            return { kind: "external", module: this.#clientFile, name };
          }
          if (part.file === this.#scopeFile && name === "withOrgScope") {
            this.#moduleAt(this.#scopeFile);
            return { kind: "external", module: this.#scopeFile, name };
          }
          return this.#exported(part.file, name);
        }
        if (part.kind === "array" && /^(?:0|[1-9]\d*)$/u.test(name)) {
          return this.#arrayElementValue({
            array: part,
            index: { kind: "literal", value: Number(name) },
          });
        }
        if (part.kind === "input") {
          return { kind: "input" };
        }
        if (part.kind === "external") {
          if (
            part.module === "global" &&
            part.name === "globalThis" &&
            (GRAPH_NATIVE_GLOBALS.has(name) || GRAPH_GLOBAL_ALIASES.has(name))
          ) {
            return {
              kind: "external",
              module: "global",
              name: GRAPH_GLOBAL_ALIASES.has(name) ? "globalThis" : name,
            };
          }
          return {
            kind: "external",
            module: part.module,
            name: part.name === "*" ? name : `${part.name}.${name}`,
            ...(part.nativeState === true ? { nativeState: true } : {}),
          };
        }
        if (part.kind === "table") {
          return { kind: "column", table: part.name, name };
        }
        if (part.kind === "tx") {
          return { kind: "method", receiver: part, name };
        }
        if (part.kind === "method") {
          return {
            kind: "method",
            receiver: part.receiver,
            name: `${part.name}.${name}`,
          };
        }
        return this.#unknown(
          `unresolved member ${name} on ${part.kind === "unknown" ? part.reason : part.kind} in ${frame.module.file}`,
        );
      }),
    );

  readonly #objectRestValue = ({
    value,
    excluded,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    excluded: ReadonlySet<string>;
    frame: OrgGraphFrame;
    node: Node;
  }): OrgGraphValue => {
    const alternatives = this.#alternatives(value);
    if (alternatives.length === 0) {
      return this.#fail(frame, node, "unresolved object rest source");
    }
    return this.#join(
      ...alternatives.map((part): OrgGraphValue => {
        if (part.kind === "input") {
          return {
            kind: "object",
            prototypeDisposition: "ordinary",
            fields: new Map<string, OrgGraphValue>(),
            unknownFields: part,
            propertyPresence: "open",
            keyStability: "mutable",
          };
        }
        if (
          part.kind !== "object" ||
          part.prototypeDisposition === "unmodeled"
        ) {
          return this.#fail(
            frame,
            node,
            `object rest requires a plain object or opaque input data (source: ${part.kind === "unknown" ? part.reason : this.#signature({ value: part })})`,
          );
        }
        const fields = new Map(part.fields);
        const optionalFields = new Set(part.optionalFields);
        for (const name of excluded) {
          fields.delete(name);
          optionalFields.delete(name);
        }
        return {
          kind: "object",
          prototypeDisposition: "ordinary",
          fields,
          // Unknown key/value associations cannot be removed by a named exclusion.
          unknownFields: this.#unknownOwnValues(part),
          propertyPresence: part.propertyPresence,
          keyStability: part.keyStability ?? "fixed",
          optionalFields,
        };
      }),
    );
  };

  readonly #bindingDefaultValue = ({
    value,
    fallback,
    frame,
  }: {
    value: OrgGraphValue;
    fallback: Node;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    const alternatives = this.#alternatives(value);
    const needsDefault =
      alternatives.length === 0 ||
      alternatives.some(
        (part) =>
          part.kind === "unknown" ||
          part.kind === "input" ||
          part.kind === "external" ||
          (part.kind === "literal" && part.value === undefined),
      );
    const retained = alternatives.filter(
      (part) => !(part.kind === "literal" && part.value === undefined),
    );
    return this.#join(
      ...retained,
      needsDefault ? this.#evaluate(fallback, frame) : this.#bottom,
    );
  };

  readonly #bind = ({
    pattern,
    value: inputValue,
    frame,
  }: {
    pattern: Node;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): void => {
    const value = this.#ownValue(inputValue, {
      frame,
      node: pattern,
      role: "binding",
    });
    if (!isOrgGraphBindingPattern(pattern)) {
      return this.#fail(frame, pattern, "unsupported binding pattern");
    }
    switch (pattern.type) {
      case "Identifier":
        frame.values.set(pattern, value);
        return;
      case "AssignmentPattern": {
        const boundValue = this.#bindingDefaultValue({
          value,
          fallback: pattern.right,
          frame,
        });
        this.#bind({
          pattern: pattern.left,
          value: boundValue,
          frame,
        });
        return;
      }
      case "ObjectPattern": {
        const excluded = new Set<string>();
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            this.#bind({
              pattern: property.argument,
              value: this.#objectRestValue({
                value,
                excluded,
                frame,
                node: property,
              }),
              frame,
            });
            continue;
          }
          const name = staticPropertyName(property);
          if (name === undefined) {
            return this.#fail(frame, property, "dynamic destructuring key");
          }
          excluded.add(name);
          this.#bind({
            pattern: property.value,
            value: this.#field({
              value,
              name,
              frame,
            }),
            frame,
          });
        }
        return;
      }
      case "ArrayPattern":
        for (const [index, element] of pattern.elements.entries()) {
          if (element !== null) {
            if (element.type === "RestElement") {
              const iterable = this.#iterableValues({
                value,
                frame,
                node: element,
              });
              this.#bind({
                pattern: element.argument,
                value: {
                  kind: "array",
                  extent:
                    iterable.extent.type === "finite"
                      ? {
                          type: "finite",
                          maximum: Math.max(0, iterable.extent.maximum - index),
                        }
                      : { type: "unknown" },
                  stability: iterable.stability,
                  values:
                    iterable.stability === "fixed"
                      ? iterable.values.slice(index)
                      : [...iterable.values],
                },
                frame,
              });
              continue;
            }
            this.#bind({
              pattern: element,
              value: this.#field({
                value,
                name: String(index),
                frame,
              }),
              frame,
            });
          }
        }
        return;
      default:
        pattern satisfies never;
        return panic("Unknown organization binding pattern");
    }
  };

  readonly #traceCall = (
    frame: OrgGraphFrame,
    call: CallExpression,
  ): OrgGraphFrame => {
    const trace = new Map(frame.trace);
    const identity = `${frame.module.file}:${call.start}`;
    trace.set(
      identity,
      `${frame.module.file}:${writeStatementFingerprint(call, frame.module.parents)}`,
    );
    return { ...frame, trace };
  };

  readonly #truth = (value: OrgGraphValue): boolean | undefined =>
    value.kind === "literal" ? Boolean(value.value) : undefined;

  readonly #awaitValue = ({
    value,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): OrgGraphValue =>
    this.#join(
      ...this.#alternatives(value).map((part): OrgGraphValue => {
        if (part.kind === "query") {
          return {
            kind: "array",
            extent: { type: "unknown" },
            stability: "mutable",
            values: [{ kind: "input" }],
          };
        }
        if (part.kind === "unknown") {
          return this.#fail(
            frame,
            node,
            "awaited value requires an explicit owner model",
          );
        }
        if (part.kind === "object") {
          if (
            !part.fields.has("then") &&
            part.propertyPresence === "closed" &&
            part.unknownFields.kind === "bottom" &&
            part.prototypeDisposition === "ordinary"
          ) {
            return part;
          }
          const then = this.#field({ value: part, name: "then", frame });
          for (const candidate of this.#alternatives(then)) {
            if (
              candidate.kind === "function" ||
              candidate.kind === "method" ||
              candidate.kind === "external" ||
              candidate.kind === "unknown" ||
              candidate.kind === "tx"
            ) {
              return this.#fail(
                frame,
                node,
                "awaited thenable requires an explicit call model",
              );
            }
          }
        }
        return part;
      }),
    );

  readonly #nativeExternalIdentity = (value: OrgGraphValue): boolean => {
    if (value.kind !== "external") {
      return false;
    }
    if (value.nativeState === true || value.regexp !== undefined) {
      return true;
    }
    if (
      value.name.startsWith("<result:") ||
      value.name.startsWith("<instance:")
    ) {
      return false;
    }
    if (GRAPH_NATIVE_MODULES.has(value.module)) {
      return true;
    }
    if (value.module !== "global") {
      return false;
    }
    return (
      value.name === "globalThis" ||
      [...GRAPH_NATIVE_GLOBALS].some(
        (name) => value.name === name || value.name.startsWith(`${name}.`),
      )
    );
  };

  readonly #containsNativeIdentity = (
    value: OrgGraphValue,
    seen = new Set<OrgGraphValue>(),
  ): boolean => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (this.#nativeExternalIdentity(value)) {
      return true;
    }
    if (value.kind === "schema") {
      return this.#containsNativeIdentity(value.output, seen);
    }
    if (value.kind === "query" || value.kind === "method") {
      return this.#containsNativeIdentity(value.receiver, seen);
    }
    if (value.kind === "object") {
      return [value.unknownFields, ...value.fields.values()].some((child) =>
        this.#containsNativeIdentity(child, seen),
      );
    }
    if (
      value.kind === "array" ||
      value.kind === "set" ||
      value.kind === "union"
    ) {
      return value.values.some((child) =>
        this.#containsNativeIdentity(child, seen),
      );
    }
    return false;
  };

  readonly #containsValidationResult = (
    value: OrgGraphValue,
    seen = new Set<OrgGraphValue>(),
  ): boolean => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (value.kind === "object") {
      return (
        value.validation !== undefined ||
        [value.unknownFields, ...value.fields.values()].some((child) =>
          this.#containsValidationResult(child, seen),
        )
      );
    }
    if (value.kind === "schema") {
      return this.#containsValidationResult(value.output, seen);
    }
    if (value.kind === "query" || value.kind === "method") {
      return this.#containsValidationResult(value.receiver, seen);
    }
    return (
      (value.kind === "array" ||
        value.kind === "set" ||
        value.kind === "union") &&
      value.values.some((child) => this.#containsValidationResult(child, seen))
    );
  };

  readonly #opaqueEscapeKind = (
    value: OrgGraphValue,
    seen: Set<OrgGraphValue>,
  ): "schema" | "mutable" | undefined => {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    let kind: "mutable" | undefined;
    let children: readonly OrgGraphValue[];
    switch (value.kind) {
      case "schema":
        return "schema";
      case "object":
        kind = "mutable";
        children = [value.unknownFields, ...value.fields.values()];
        break;
      case "array":
      case "set":
        kind = "mutable";
        children = value.values;
        break;
      case "union":
        children = value.values;
        break;
      case "table":
      case "column":
      case "sql":
      case "module":
      case "org-scoped-handle":
      case "tx":
      case "query":
      case "method":
      case "function":
      case "valibot-action":
      case "unknown":
        return "mutable";
      case "bottom":
      case "chain-short-circuit":
      case "input":
      case "literal":
      case "external":
        return undefined;
      default:
        value satisfies never;
        return panic("Unknown opaque escape value");
    }
    for (const child of children) {
      const nested = this.#opaqueEscapeKind(child, seen);
      if (nested === "schema") {
        return nested;
      }
      if (nested === "mutable") {
        kind = nested;
      }
    }
    return kind;
  };

  readonly #assertOperatorCoercionIsPrimitive = ({
    values,
    frame,
    node,
  }: {
    values: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: Node;
  }): void => {
    for (const value of values) {
      for (const part of this.#alternatives(value)) {
        if (
          part.kind === "bottom" ||
          part.kind === "chain-short-circuit" ||
          part.kind === "input" ||
          part.kind === "literal"
        ) {
          continue;
        }
        return this.#fail(
          frame,
          node,
          `operator coercion may invoke mutable tracked data (source: ${part.kind === "unknown" ? part.reason : this.#signature({ value: part })})`,
        );
      }
    }
  };

  readonly #assertNoOpaqueDataEscape = ({
    values,
    frame,
    node,
  }: {
    values: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: Node;
  }): void => {
    const seen = new Set<OrgGraphValue>();
    let mutable = false;
    for (const value of values) {
      const kind = this.#opaqueEscapeKind(value, seen);
      if (kind === "schema") {
        return this.#fail(
          frame,
          node,
          "opaque delegate receives a native schema",
        );
      }
      if (kind === "mutable") {
        mutable = true;
      }
    }
    if (mutable) {
      return this.#fail(
        frame,
        node,
        "opaque delegate receives mutable tracked data",
      );
    }
  };

  readonly #nativeExternalWrite = ({
    receiver,
    key,
    value,
    target,
    frame,
    node,
  }: {
    receiver: OrgGraphValue;
    key: OrgGraphValue;
    value: OrgGraphValue;
    target: Extract<Node, { type: "MemberExpression" }>;
    frame: OrgGraphFrame;
    node: Node;
  }): void => {
    const name =
      this.#graphAccessName(target) ??
      (key.kind === "literal" && typeof key.value === "string"
        ? key.value
        : undefined);
    const parts = this.#alternatives(receiver);
    const protectedTarget = parts.some((part) => {
      if (
        part.kind === "external" &&
        part.module === "global" &&
        part.name === "globalThis"
      ) {
        return (
          name === undefined ||
          GRAPH_NATIVE_GLOBALS.has(name) ||
          GRAPH_GLOBAL_ALIASES.has(name)
        );
      }
      return this.#nativeExternalIdentity(part);
    });
    if (protectedTarget || this.#containsNativeIdentity(key)) {
      return this.#fail(frame, node, "native external mutation is not modeled");
    }
    if (
      this.#containsValidationResult(value) &&
      parts.some((part) => part.kind === "input" || part.kind === "external")
    ) {
      return this.#fail(
        frame,
        node,
        "validation result cannot escape through an opaque external write",
      );
    }
    if (
      this.#containsNativeIdentity(value) &&
      parts.some((part) => part.kind === "input" || part.kind === "external")
    ) {
      return this.#fail(
        frame,
        node,
        "native identity cannot escape through an opaque external write",
      );
    }
    if (
      parts.some((part) => part.kind === "input" || part.kind === "external") &&
      ![receiver, key, value].some(
        (part) => this.#relevant(part) || this.#containsCallable(part),
      )
    ) {
      this.#assertNoOpaqueDataEscape({ values: [value], frame, node });
    }
  };

  readonly #dataDescriptor = (value: OrgGraphValue | undefined): boolean => {
    if (
      value?.kind !== "object" ||
      value.prototypeDisposition !== "ordinary" ||
      value.propertyPresence !== "closed" ||
      value.unknownFields.kind !== "bottom"
    ) {
      return false;
    }
    return [...value.fields.keys()].every((key) =>
      ["value", "writable", "enumerable", "configurable"].includes(key),
    );
  };

  readonly #nativeStoredValues = ({
    name,
    args,
    frame,
    node,
  }: {
    name: string;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): readonly OrgGraphValue[] => {
    const stored: OrgGraphValue[] = [];
    switch (name) {
      case "Object.assign":
        for (const source of args.slice(1)) {
          for (const part of this.#alternatives(source)) {
            if (part.kind === "object") {
              stored.push(part.unknownFields, ...part.fields.values());
            } else if (part.kind === "array") {
              stored.push(...part.values);
            } else if (part.kind !== "set") {
              // Unsupported source objects cannot hide aliases in own fields.
              this.#assertNoOpaqueDataEscape({ values: [part], frame, node });
              stored.push(part);
            }
          }
        }
        break;
      case "Object.defineProperty":
      case "Reflect.defineProperty": {
        const descriptor = args.at(2);
        if (descriptor?.kind !== "object") {
          return panic("Native data descriptor validation was not retained");
        }
        stored.push(descriptor.fields.get("value") ?? this.#bottom);
        break;
      }
      case "Object.defineProperties": {
        const descriptors = args.at(1);
        if (descriptors?.kind !== "object") {
          return panic("Native data descriptors validation was not retained");
        }
        for (const descriptor of descriptors.fields.values()) {
          if (descriptor.kind !== "object") {
            return panic("Native data descriptor validation was not retained");
          }
          stored.push(descriptor.fields.get("value") ?? this.#bottom);
        }
        break;
      }
      case "Reflect.set":
        stored.push(args.at(2) ?? this.#bottom);
        break;
      case "Object.setPrototypeOf":
      case "Reflect.setPrototypeOf": {
        const prototype = args.at(1) ?? this.#bottom;
        for (const part of this.#alternatives(prototype)) {
          if (part.kind === "object") {
            stored.push(part.unknownFields, ...part.fields.values());
          } else {
            stored.push(part);
          }
        }
        break;
      }
      case "Reflect.deleteProperty":
        break;
      default:
        return panic("Missing native data mutation storage contract");
    }
    return stored;
  };

  readonly #nativeMutationMayChangePrototype = (
    name: string,
    args: readonly OrgGraphValue[],
  ): boolean => {
    if (name === "Object.setPrototypeOf" || name === "Reflect.setPrototypeOf") {
      return true;
    }
    if (name === "Reflect.set") {
      const key = args.at(1);
      return key?.kind !== "literal" || String(key.value) === "__proto__";
    }
    if (name !== "Object.assign") {
      return false;
    }
    return args.slice(1).some((source) =>
      this.#alternatives(source).some((part) => {
        if (part.kind === "object") {
          return (
            part.prototypeDisposition === "unmodeled" ||
            part.fields.has("__proto__") ||
            part.unknownFields.kind !== "bottom" ||
            part.propertyPresence !== "closed"
          );
        }
        if (part.kind === "array") {
          return part.stability !== "fixed";
        }
        return part.kind !== "literal" && part.kind !== "set";
      }),
    );
  };

  readonly #nativeDataMutation = ({
    fn,
    args,
    frame,
    node,
  }: {
    fn: Extract<OrgGraphValue, { kind: "external" }>;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (
      fn.module !== "global" ||
      ![
        "Object.assign",
        "Object.defineProperty",
        "Object.defineProperties",
        "Object.setPrototypeOf",
        "Reflect.set",
        "Reflect.defineProperty",
        "Reflect.deleteProperty",
        "Reflect.setPrototypeOf",
      ].includes(fn.name)
    ) {
      return undefined;
    }
    if (
      (fn.name === "Object.defineProperty" ||
        fn.name === "Reflect.defineProperty") &&
      !this.#dataDescriptor(args.at(2))
    ) {
      return this.#fail(
        frame,
        node,
        "unmodeled accessor or opaque property descriptor",
      );
    }
    if (fn.name === "Object.defineProperties") {
      const descriptors = args.at(1);
      if (
        descriptors?.kind !== "object" ||
        descriptors.prototypeDisposition !== "ordinary" ||
        descriptors.propertyPresence !== "closed" ||
        descriptors.unknownFields.kind !== "bottom" ||
        [...descriptors.fields.values()].some(
          (value) => !this.#dataDescriptor(value),
        )
      ) {
        return this.#fail(
          frame,
          node,
          "unmodeled accessor or opaque property descriptors",
        );
      }
    }
    const target =
      (fn.name === "Reflect.set" && args.length > 3
        ? args.at(3)
        : args.at(0)) ?? this.#bottom;
    const parts = this.#alternatives(target);
    if (parts.length === 0) {
      return this.#fail(frame, node, "unresolved native data mutation target");
    }
    const stored = this.#nativeStoredValues({
      name: fn.name,
      args,
      frame,
      node,
    });
    for (const part of parts) {
      if (
        (part.kind === "input" && part.primitive !== "string") ||
        part.kind === "external"
      ) {
        this.#assertNoOpaqueDataEscape({ values: stored, frame, node });
        continue;
      }
      if (part.kind !== "object") {
        return this.#fail(
          frame,
          node,
          "native mutator requires a tracked plain data object",
        );
      }
      delete part.validation;
      if (this.#nativeMutationMayChangePrototype(fn.name, args)) {
        part.prototypeDisposition = "unmodeled";
      }
      // Opaque data writes may replace any field, but never erase an existing
      // capability alternative or leave a stale literal trusted by later reads.
      for (const [key, value] of part.fields) {
        part.fields.set(key, this.#join(value, { kind: "input" }));
        if (fn.name === "Reflect.deleteProperty") {
          part.optionalFields ??= new Set<string>();
          part.optionalFields.add(key);
        }
      }
      // Retain every copied/stored reference before widening ordinary data.
      // A later field read must not turn a known mutable alias into input.
      part.unknownFields = this.#join(part.unknownFields, ...stored, {
        kind: "input",
      });
      part.keyStability = "mutable";
      part.propertyPresence = "open";
    }
    return fn.name.startsWith("Reflect.") ? { kind: "input" } : target;
  };

  readonly #nativeReflectionField = ({
    value,
    name,
  }: {
    value: OrgGraphValue;
    name: string;
  }): OrgGraphValue | undefined => {
    if (
      name !== "constructor" &&
      name !== "__proto__" &&
      name !== "prototype"
    ) {
      return undefined;
    }
    if (value.kind === "module" || this.#nativeExternalIdentity(value)) {
      return undefined;
    }
    if (
      value.kind === "object" &&
      value.fields.has(name) &&
      !value.optionalFields?.has(name) &&
      !(name === "__proto__" && value.prototypeDisposition === "unmodeled")
    ) {
      return undefined;
    }
    if (value.kind === "literal" && typeof value.value === "string") {
      if (name === "constructor") {
        return { kind: "external", module: "global", name: "String" };
      }
      if (name === "__proto__") {
        return { kind: "external", module: "global", name: "String.prototype" };
      }
      return { kind: "literal", value: undefined };
    }
    const reflected: OrgGraphValue = {
      kind: "external",
      module: "global",
      name: "<native-reflection>",
      nativeState: true,
    };
    return value.kind === "object"
      ? this.#join(
          value.fields.get(name) ?? this.#bottom,
          value.unknownFields,
          reflected,
        )
      : reflected;
  };

  readonly #assertNativeEvaluationOwner = ({
    fn,
    frame,
    node,
  }: {
    fn: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): void => {
    if (
      this.#alternatives(fn).some(
        (part) =>
          part.kind === "external" &&
          (part.module === "node:vm" ||
            part.module === "vm" ||
            (part.module === "global" &&
              /(?:^|\.)(?:eval|Function|constructor)(?:\.|$)/u.test(
                part.name,
              ))),
      )
    ) {
      this.#fail(
        frame,
        node,
        "native code evaluation requires an explicit owner model",
      );
    }
  };

  readonly #invokeNonFunction = ({
    part,
    receiver,
    args,
    caller,
    call,
  }: {
    part: OrgGraphValue;
    receiver: OrgGraphValue | undefined;
    args: readonly OrgGraphValue[];
    caller: OrgGraphFrame;
    call: CallExpression;
  }): OrgGraphValue => {
    if (part.kind === "method") {
      this.#fail(
        caller,
        call,
        `unsupported detached/indirect transaction method ${part.name}`,
      );
    }
    if (part.kind === "unknown") {
      this.#fail(caller, call, `unresolved callable: ${part.reason}`);
    }
    if (part.kind === "literal") {
      this.#fail(caller, call, "unresolved callable: non-callable literal");
    }
    const escaped =
      receiver === undefined ||
      receiver.kind === "external" ||
      receiver.kind === "input" ||
      receiver.kind === "literal"
        ? args
        : [receiver, ...args];
    if (
      escaped.some(
        (argument) =>
          this.#relevant(argument) || this.#containsCallable(argument),
      )
    ) {
      this.#fail(
        caller,
        call,
        `unresolved delegate ${this.#signature({
          value: part,
        })} receives a transaction or callable`,
      );
    }
    if (escaped.some((argument) => this.#containsValidationResult(argument))) {
      this.#fail(
        caller,
        call,
        "unmodeled delegate receives a validation result",
      );
    }
    if (escaped.some((argument) => this.#containsNativeIdentity(argument))) {
      this.#fail(caller, call, "unmodeled delegate receives a native identity");
    }
    if (part.kind === "external") {
      const mutation = this.#nativeDataMutation({
        fn: part,
        args,
        frame: caller,
        node: call,
      });
      if (mutation !== undefined) {
        return mutation;
      }
      if (
        part.nativeState === true ||
        (part.module === "global" &&
          (part.name.includes(".prototype.") ||
            (part.name.startsWith("RegExp.literal.") &&
              part.name !== "RegExp.literal.test" &&
              part.name !== "RegExp.literal.exec")))
      ) {
        this.#fail(caller, call, "unmodeled native prototype call");
      }
      const reflection =
        part.module === "global" &&
        (part.name === "Object.getPrototypeOf" ||
          part.name === "Reflect.getPrototypeOf");
      if (!reflection) {
        this.#assertNoOpaqueDataEscape({
          values: escaped,
          frame: caller,
          node: call,
        });
      }
      return reflection
        ? {
            kind: "external",
            module: "global",
            name: "<native-prototype>",
            nativeState: true,
          }
        : {
            kind: "external",
            module: part.module,
            name: `<result:${part.name}>`,
          };
    } else if (part.kind === "input") {
      this.#assertNoOpaqueDataEscape({
        values: escaped,
        frame: caller,
        node: call,
      });
      return part;
    }
    return this.#unknown("non-callable result");
  };

  readonly #invoke = ({
    fn: inputFn,
    args: inputArgs,
    caller,
    call,
    receiver,
  }: {
    fn: OrgGraphValue;
    args: readonly OrgGraphValue[];
    caller: OrgGraphFrame;
    call: CallExpression;
    receiver?: OrgGraphValue;
  }): OrgGraphValue => {
    const fn = this.#ownValue(inputFn, {
      frame: caller,
      node: call,
      role: "callee",
    });
    this.#assertNativeEvaluationOwner({ fn, frame: caller, node: call });
    const args = inputArgs.map((argument, index) =>
      this.#ownValue(argument, {
        frame: caller,
        node: call,
        role: `argument:${index}`,
      }),
    );
    const result: OrgGraphValue[] = [];
    for (const part of this.#alternatives(fn)) {
      if (part.kind !== "function") {
        result.push(
          this.#invokeNonFunction({ part, receiver, args, caller, call }),
        );
        continue;
      }
      if (
        caller.executionMode === "array-sort" &&
        (part.node.async ||
          (part.node.type !== "ArrowFunctionExpression" && part.node.generator))
      ) {
        return this.#fail(
          caller,
          call,
          "native array toSorted comparator requires synchronous source calls",
        );
      }
      if (this.#options.recoveryOwnerFiles.has(part.file)) {
        this.#reachedRecovery.add(part.file);
      }
      const frozen = { ...part, captures: this.#captureSnapshot(part) };
      const traced = this.#traceCall(caller, call);
      const key = `${caller.entry}|${caller.executionMode}|${this.#signature({
        value: part,
      })}|${args
        .map((argument) =>
          this.#signature({
            value: argument,
          }),
        )
        .join(";")}|${[...traced.trace.values()].toSorted().join(";")}`;
      let context = this.#contexts.get(key);
      if (context === undefined) {
        if (this.#contexts.size >= 20_000) {
          this.#fail(
            caller,
            call,
            "context domain exceeds supported finite limit",
          );
        }
        context = {
          fn: frozen,
          args,
          caller: traced,
          allocationContext: JSON.stringify([
            frozen.file,
            frozen.node.start,
            args.map((argument) =>
              this.#allocationShape({
                value: argument,
              }),
            ),
          ]),
          result: this.#bottom,
          execution: { type: "unseen" },
          dependents: new Set(),
        };
        this.#contexts.set(key, context);
      } else {
        const captures = new Map(context.fn.captures);
        for (const [binding, value] of frozen.captures) {
          captures.set(
            binding,
            this.#join(captures.get(binding) ?? this.#bottom, value),
          );
        }
        context.fn = { ...context.fn, captures };
        context.args = context.args.map((value, index) =>
          this.#join(value, args.at(index) ?? this.#bottom),
        );
      }
      if (caller.context !== undefined) {
        context.dependents.add(caller.context);
      }
      switch (context.execution.type) {
        case "running":
          break;
        case "unseen":
        case "repeat":
          this.#runContext(key);
          break;
        case "cached": {
          if (this.#pending.has(key)) {
            this.#runContext(key);
            break;
          }
          const inputs = this.#contextInputs(context);
          if (!this.#sameContextInputs(context.execution.inputs, inputs)) {
            this.#runContext(key, inputs);
          }
          break;
        }
        default:
          context.execution satisfies never;
          return panic("Unknown graph execution state");
      }
      result.push(context.result);
    }
    return this.#join(...result);
  };

  readonly #contextInputs = (
    context: OrgGraphContext,
  ): OrgGraphContextInputs => {
    const roots = [
      ...this.#moduleHeap,
      ...context.args,
      ...context.fn.captures.values(),
      context.result,
    ];
    return {
      roots,
      signature: JSON.stringify([
        context.args.map((value) => this.#signature({ value })),
        context.fn.freeBindings.map((binding) => [
          binding.start,
          this.#signature({
            value: context.fn.captures.get(binding) ?? this.#bottom,
          }),
        ]),
      ]),
      heap: this.#persistentHeapSnapshot(roots),
    };
  };

  readonly #sameContextInputs = (
    left: OrgGraphContextInputs,
    right: OrgGraphContextInputs,
  ): boolean =>
    left.signature === right.signature &&
    left.heap.size === right.heap.size &&
    [...left.heap].every(([id, state]) => right.heap.get(id) === state);

  readonly #runContext = (
    key: string,
    prepared?: OrgGraphContextInputs,
  ): void => {
    const context =
      this.#contexts.get(key) ?? panic("Missing organization graph context");
    if (context.execution.type === "running") {
      return;
    }
    this.#pending.delete(key);
    const inputs = prepared ?? this.#contextInputs(context);
    context.execution = { type: "running" };
    if (this.#options.recoveryOwnerFiles.has(context.fn.file)) {
      this.#analyzedRecoveryFunctions.add(
        `${context.fn.file}:${context.fn.node.start}`,
      );
    }
    const frame: OrgGraphFrame = {
      executionMode: context.caller.executionMode,
      module: this.#moduleAt(context.fn.file),
      values: new Map(context.fn.captures),
      entry: context.caller.entry,
      trace: context.caller.trace,
      context: key,
      // Allocation sites use the input abstraction captured at context creation,
      // not fields later mutated by this very execution.
      allocationContext: context.allocationContext,
    };
    for (const [index, parameter] of context.fn.node.params.entries()) {
      this.#bind({
        pattern: parameter,
        value: context.args.at(index) ?? { kind: "literal", value: undefined },
        frame,
      });
    }
    const body = context.fn.node.body;
    if (body === null) {
      return this.#fail(
        frame,
        context.fn.node,
        "function declaration has no executable body",
      );
    }
    const value =
      body.type === "BlockStatement"
        ? this.#functionFlowValue({
            flow: this.#execute(body, frame),
            frame,
            node: body,
          })
        : this.#evaluate(body, frame);
    const result = this.#join(context.result, value);
    context.execution = { type: "repeat" };
    if (this.#persistentHeapChanged(inputs.heap, inputs.roots)) {
      // Arguments, module state and prior returned cells survive this activation.
      this.#queueCompletedContexts();
    } else {
      // Reuse only an unchanged abstract transition, never its mutating effects.
      context.execution = { type: "cached", inputs };
    }
    if (
      this.#signature({
        value: result,
      }) !==
      this.#signature({
        value: context.result,
      })
    ) {
      context.result = result;
      for (const dependent of context.dependents) {
        // An active caller consumes this result synchronously. Recursive readers
        // that have already completed are still invalidated by the new summary.
        if (this.#contexts.get(dependent)?.execution.type !== "running") {
          this.#pending.add(dependent);
        }
      }
    }
  };

  readonly #recordWrite = ({
    call,
    frame,
    receiver,
    target,
    operation,
  }: OrgGraphWriteOptions): void => {
    const tables = this.#alternatives(target);
    if (tables.length === 0) {
      return;
    }
    for (const table of tables) {
      if (table.kind !== "table") {
        this.#fail(
          frame,
          call,
          `unresolved ${operation} table (${this.#signature({
            value: table,
          })})`,
        );
      }
      if (table.scope === "global") {
        continue;
      }
      const receivers = this.#alternatives(receiver);
      if (receivers.length === 0) {
        continue;
      }
      if (
        receivers.every((part) => part.kind === "tx" && part.scope === "scoped")
      ) {
        continue;
      }
      const sink = writeStatementFingerprint(call, frame.module.parents);
      const fingerprint =
        frame.trace.size === 0
          ? sink
          : sha256Hex(
              JSON.stringify({
                sink,
                calls: [...frame.trace.values()].toSorted(),
              }),
            );
      const hit = {
        file: frame.module.file,
        entry: frame.entry,
        line: frame.module.parsed.locate(call.start).line,
        table: table.name,
        operation,
        fingerprint,
      };
      this.#hits.set(
        `${hit.entry}#${hit.file}#${hit.table}#${hit.operation}#${hit.fingerprint}`,
        hit,
      );
    }
  };

  readonly #sqlTargets = ({
    value,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): OrgGraphValue => {
    const targets: OrgGraphValue[] = [];
    for (const part of this.#alternatives(value)) {
      if (
        part.kind !== "sql" &&
        !(part.kind === "literal" && typeof part.value === "string")
      ) {
        this.#fail(
          frame,
          node,
          "execute argument is not resolved SQL; mutation absence cannot be proved",
        );
      }
      if (part.kind === "sql" && part.unresolved) {
        this.#fail(
          frame,
          node,
          "SQL contains unresolved interpolations that may be SQLWrapper fragments",
        );
      }
      const text = part.kind === "sql" ? part.text : String(part.value);
      // FOR UPDATE is a lock clause. Comments/string literals require a real SQL
      // lexer before this prototype is ready for arbitrary SQL sources.
      const normalized = text.replace(
        /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/giu,
        "",
      );
      if (
        !/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|COPY|CALL|DO)\b/iu.test(
          normalized,
        )
      ) {
        continue;
      }
      if (
        /\b(?:MERGE|TRUNCATE|CREATE|ALTER|DROP|COPY|CALL|DO)\b/iu.test(
          normalized,
        )
      ) {
        this.#fail(frame, node, "unsupported SQL mutation/procedure form");
      }
      const matches = [
        ...normalized.matchAll(
          /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?((?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?)/giu,
        ),
      ];
      if (matches.length === 0) {
        this.#fail(frame, node, "unsupported SQL mutation form");
      }
      for (const match of matches) {
        const relation = match.at(1) ?? panic("Missing SQL mutation target");
        const token =
          part.kind === "sql" ? part.targets.get(relation) : undefined;
        if (token !== undefined) {
          targets.push(token);
          continue;
        }
        const name =
          relation.split(".").at(-1)?.replaceAll('"', "") ?? relation;
        const exportedName = this.#options.sqlTables.get(name);
        if (exportedName === undefined) {
          this.#fail(
            frame,
            node,
            `SQL relation ${relation} has no declaration-derived classification`,
          );
        }
        targets.push(this.#tableValue(exportedName));
      }
    }
    return this.#join(...targets);
  };

  readonly #callbackCall = ({
    callback,
    args,
    frame,
    call,
  }: {
    callback: OrgGraphValue;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    call: CallExpression;
  }): OrgGraphValue => {
    if (this.#alternatives(callback).some((part) => part.kind !== "function")) {
      this.#fail(frame, call, "unresolved database/callback delegate");
    }
    return this.#invoke({ fn: callback, args, caller: frame, call });
  };

  readonly #freshSchemaOutput = (value: OrgGraphValue): OrgGraphValue => {
    if (value.kind === "array") {
      return {
        kind: "array",
        extent: value.extent,
        stability: value.stability,
        values: value.values.map(this.#freshSchemaOutput),
      };
    }
    if (value.kind === "object") {
      return {
        ...value,
        fields: new Map(
          [...value.fields].map(([key, field]) => [
            key,
            this.#freshSchemaOutput(field),
          ]),
        ),
        unknownFields: this.#freshSchemaOutput(value.unknownFields),
        ...(value.optionalFields === undefined
          ? {}
          : { optionalFields: new Set(value.optionalFields) }),
      };
    }
    if (value.kind === "union") {
      return this.#join(...value.values.map(this.#freshSchemaOutput));
    }
    return value;
  };

  readonly #assertFreshValidationOutput = ({
    output,
    input,
    frame,
    node,
  }: {
    output: OrgGraphValue;
    input: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): void => {
    const collect = (
      value: OrgGraphValue,
      seen: Set<OrgGraphValue>,
    ): Set<string> => {
      const refs = new Set<string>();
      if (seen.has(value)) {
        return refs;
      }
      seen.add(value);
      if (this.#isHeapValue(value)) {
        refs.add(this.#referenceKey(value));
      }
      let children: readonly OrgGraphValue[];
      if (value.kind === "object") {
        children = [...value.fields.values(), value.unknownFields];
      } else if (
        value.kind === "array" ||
        value.kind === "set" ||
        value.kind === "union"
      ) {
        children = value.values;
      } else {
        children = [];
      }
      for (const child of children) {
        for (const ref of collect(child, seen)) {
          refs.add(ref);
        }
      }
      return refs;
    };
    const inputs = collect(input, new Set());
    for (const outputRef of collect(output, new Set())) {
      if (inputs.has(outputRef)) {
        this.#fail(
          frame,
          node,
          "fresh validation output collides with summarized input allocation",
        );
      }
    }
  };

  readonly #containsStringOutput = (value: OrgGraphValue): boolean =>
    (value.kind === "input" && value.primitive === "string") ||
    ((value.kind === "array" || value.kind === "union") &&
      value.values.some(this.#containsStringOutput)) ||
    (value.kind === "object" &&
      [...value.fields.values()].some(this.#containsStringOutput));

  readonly #freshStringSchemaOutput = (value: OrgGraphValue): boolean => {
    if (value.kind === "input") {
      return value.primitive === "string";
    }
    return (
      value.kind === "array" &&
      value.values.every(this.#freshStringSchemaOutput)
    );
  };

  readonly #assertValidationInputAliases = ({
    output,
    input,
    frame,
    node,
  }: {
    output: OrgGraphValue;
    input: OrgGraphValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): void => {
    if (this.#freshStringSchemaOutput(output)) {
      return;
    }
    for (const part of this.#alternatives(input)) {
      if (output.kind === "array" && part.kind === "array") {
        const item = output.values.at(0);
        if (output.values.length !== 1 || item === undefined) {
          return panic("Native array schema requires one modeled item output");
        }
        // The native array parser owns this new outer container. Opaque item
        // validators can still retain references, so check each actual element.
        for (const value of part.values) {
          this.#assertValidationInputAliases({
            output: item,
            input: value,
            frame,
            node,
          });
        }
      } else {
        this.#assertNoOpaqueDataEscape({ values: [part], frame, node });
      }
    }
  };

  readonly #validatedOutputs = ({
    result,
    fallback,
  }: {
    result: OrgGraphValue;
    fallback: OrgGraphValue;
  }): OrgGraphValue => {
    const results = this.#alternatives(result);
    if (results.length === 0) {
      return fallback;
    }
    const outputs: OrgGraphValue[] = [];
    for (const part of results) {
      if (part.kind !== "object" || part.validation === undefined) {
        return fallback;
      }
      outputs.push(part.validation.output);
    }
    return this.#join(...outputs);
  };

  readonly #validationReadStatement = (
    node: Extract<Node, { type: "MemberExpression" }>,
    frame: OrgGraphFrame,
  ): Statement | undefined => {
    let read: Node = node;
    const member = frame.module.parents.get(node);
    if (member?.type === "MemberExpression" && unwrap(member.object) === node) {
      if (member.optional || accessName(member) === undefined) {
        return undefined;
      }
      const call = frame.module.parents.get(member);
      if (
        call?.type !== "CallExpression" ||
        unwrap(call.callee) !== member ||
        call.optional
      ) {
        return undefined;
      }
      // Keep this local success proof limited to inert argument creation;
      // effectful statements need a separate control-flow proof.
      if (
        call.arguments.some(
          (argument) =>
            argument.type === "SpreadElement" ||
            (unwrap(argument).type !== "Literal" &&
              !this.#isFunctionNode(unwrap(argument))),
        )
      ) {
        return undefined;
      }
      read = call;
    }
    const parent = frame.module.parents.get(read);
    if (
      parent?.type === "ReturnStatement" &&
      parent.argument !== null &&
      unwrap(parent.argument) === read
    ) {
      return parent;
    }
    if (
      parent?.type === "ExpressionStatement" &&
      unwrap(parent.expression) === read
    ) {
      return parent;
    }
    if (parent?.type === "ForOfStatement" && unwrap(parent.right) === read) {
      return parent;
    }
    if (
      parent?.type !== "VariableDeclarator" ||
      parent.init === null ||
      unwrap(parent.init) !== read
    ) {
      return undefined;
    }
    const declaration = frame.module.parents.get(parent);
    return declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const" &&
      declaration.declarations.length === 1
      ? declaration
      : undefined;
  };

  readonly #validatedReadOutput = ({
    node,
    receiver,
    value,
    frame,
  }: {
    node: Extract<Node, { type: "MemberExpression" }>;
    receiver: OrgGraphValue;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    if (accessName(node) !== "output" || node.optional) {
      return value;
    }
    const statement = this.#validationReadStatement(node, frame);
    if (statement === undefined) {
      return value;
    }
    const block = frame.module.parents.get(statement);
    if (block?.type !== "BlockStatement") {
      return value;
    }
    const index = block.body.indexOf(statement);
    const guard = block.body.at(index - 1);
    if (
      index <= 0 ||
      guard?.type !== "IfStatement" ||
      guard.alternate !== null
    ) {
      return value;
    }
    const predicate = unwrap(guard.test);
    if (predicate.type !== "UnaryExpression" || predicate.operator !== "!") {
      return value;
    }
    const check = unwrap(predicate.argument);
    if (
      check.type !== "MemberExpression" ||
      accessName(check) !== "success" ||
      check.optional
    ) {
      return value;
    }
    const exit =
      guard.consequent.type === "BlockStatement"
        ? guard.consequent.body.at(-1)
        : guard.consequent;
    if (exit?.type !== "ReturnStatement" && exit?.type !== "ThrowStatement") {
      return value;
    }
    const checked = this.#staticReference(check.object, frame);
    const returned = this.#staticReference(node.object, frame);
    if (
      checked === undefined ||
      returned === undefined ||
      checked.binding !== returned.binding ||
      JSON.stringify(checked.keys) !== JSON.stringify(returned.keys)
    ) {
      return value;
    }
    return this.#validatedOutputs({
      result: receiver,
      fallback: value,
    });
  };

  readonly #simpleConstBinding = (
    reference: Identifier,
    frame: OrgGraphFrame,
  ): Identifier | undefined => {
    const binding = resolveDeclaration(reference, frame.module.parents);
    if (binding === undefined) {
      return undefined;
    }
    const declarator = this.#bindingDeclarator(binding, frame);
    if (declarator === undefined || declarator.init === null) {
      return undefined;
    }
    const declaration = frame.module.parents.get(declarator);
    return declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
      ? binding
      : undefined;
  };

  readonly #typeofStringValue = (value: OrgGraphValue): OrgGraphValue =>
    this.#join(
      ...this.#alternatives(value).map((part): OrgGraphValue => {
        switch (part.kind) {
          case "literal":
            return typeof part.value === "string" ? part : this.#bottom;
          case "input":
            return { kind: "input", primitive: "string" };
          case "unknown":
          case "external":
            return part;
          case "bottom":
          case "chain-short-circuit":
          case "tx":
          case "org-scoped-handle":
          case "table":
          case "column":
          case "object":
          case "array":
          case "set":
          case "schema":
          case "valibot-action":
          case "module":
          case "sql":
          case "query":
          case "method":
          case "function":
            return this.#bottom;
          case "union":
            return panic("Nested organization graph alternative");
          default:
            part satisfies never;
            return panic("Unknown typeof conditional output");
        }
      }),
    );

  readonly #typeofStringConditionProves = ({
    test,
    binding,
    truth,
    frame,
  }: {
    test: Node;
    binding: Identifier;
    truth: boolean;
    frame: OrgGraphFrame;
  }): boolean => {
    const condition = unwrap(test);
    if (condition.type === "UnaryExpression" && condition.operator === "!") {
      return this.#typeofStringConditionProves({
        test: condition.argument,
        binding,
        truth: !truth,
        frame,
      });
    }
    if (condition.type === "LogicalExpression") {
      if (
        (condition.operator === "&&" && truth) ||
        (condition.operator === "||" && !truth)
      ) {
        return (
          this.#typeofStringConditionProves({
            test: condition.left,
            binding,
            truth,
            frame,
          }) ||
          this.#typeofStringConditionProves({
            test: condition.right,
            binding,
            truth,
            frame,
          })
        );
      }
      return false;
    }
    return (
      condition.type === "BinaryExpression" &&
      (condition.operator === "===" || condition.operator === "!==") &&
      (condition.operator === "===") === truth &&
      condition.left.type === "UnaryExpression" &&
      condition.left.operator === "typeof" &&
      condition.left.argument.type === "Identifier" &&
      condition.right.type === "Literal" &&
      condition.right.value === "string" &&
      resolveDeclaration(condition.left.argument, frame.module.parents) ===
        binding
    );
  };

  readonly #immediateTruthyConditionalRead = ({
    reference,
    binding,
    value,
    frame,
  }: {
    reference: Identifier;
    binding: Identifier;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    let current: Node = reference;
    while (true) {
      const parent = frame.module.parents.get(current);
      if (parent?.type === "MemberExpression" && parent.object === current) {
        current = parent;
        continue;
      }
      if (
        parent !== undefined &&
        (parent.type === "ChainExpression" ||
          parent.type === "ParenthesizedExpression" ||
          parent.type === "TSAsExpression" ||
          parent.type === "TSSatisfiesExpression" ||
          parent.type === "TSNonNullExpression" ||
          parent.type === "TSTypeAssertion" ||
          parent.type === "TSInstantiationExpression") &&
        parent.expression === current
      ) {
        current = parent;
        continue;
      }
      if (
        parent?.type !== "ConditionalExpression" ||
        parent.consequent !== current
      ) {
        return value;
      }
      const test = unwrapTypes(parent.test);
      if (
        test.type !== "Identifier" ||
        resolveDeclaration(test, frame.module.parents) !== binding
      ) {
        return value;
      }
      // Only the first receiver read follows this test without an intervening
      // effect. Do not change the binding or lend the fact to later arm reads.
      return this.#join(
        ...this.#alternatives(value).filter(
          (part) => part.kind !== "literal" || Boolean(part.value),
        ),
      );
    }
  };

  readonly #guardedStringIdentifier = ({
    reference,
    value,
    frame,
  }: {
    reference: Identifier;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    const binding = this.#simpleConstBinding(reference, frame);
    if (binding === undefined) {
      return value;
    }
    let current: Node = reference;
    while (true) {
      const parent = frame.module.parents.get(current);
      // A function body may execute after its enclosing guard. Only an
      // explicitly passed checked value carries the proof across that boundary.
      if (parent === undefined || this.#isFunctionNode(parent)) {
        return value;
      }
      if (parent.type === "BlockStatement") {
        const index = parent.body.indexOf(current);
        for (const statement of parent.body.slice(0, Math.max(0, index))) {
          if (statement.type !== "IfStatement") {
            continue;
          }
          let truth: boolean | undefined;
          if (this.#singleFunctionExit(statement.consequent)) {
            truth = false;
          } else if (this.#singleFunctionExit(statement.alternate)) {
            truth = true;
          }
          if (
            truth !== undefined &&
            this.#typeofStringConditionProves({
              test: statement.test,
              binding,
              truth,
              frame,
            })
          ) {
            return this.#typeofStringValue(value);
          }
        }
      }
      if (
        parent.type === "IfStatement" &&
        parent.consequent === current &&
        this.#typeofStringConditionProves({
          test: parent.test,
          binding,
          truth: true,
          frame,
        })
      ) {
        return this.#typeofStringValue(value);
      }
      if (
        parent.type === "LogicalExpression" &&
        parent.right === current &&
        (parent.operator === "&&" || parent.operator === "||") &&
        this.#typeofStringConditionProves({
          test: parent.left,
          binding,
          truth: parent.operator === "&&",
          frame,
        })
      ) {
        return this.#typeofStringValue(value);
      }
      current = parent;
    }
  };

  readonly #typeofStringConditionalOutput = ({
    node,
    value,
    frame,
  }: {
    node: Extract<Node, { type: "ConditionalExpression" }>;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    const test = node.test;
    const output = node.consequent;
    if (
      test.type !== "BinaryExpression" ||
      test.operator !== "===" ||
      test.left.type !== "UnaryExpression" ||
      test.left.operator !== "typeof" ||
      test.left.argument.type !== "Identifier" ||
      test.right.type !== "Literal" ||
      test.right.value !== "string" ||
      output.type !== "Identifier"
    ) {
      return value;
    }
    const binding = this.#simpleConstBinding(test.left.argument, frame);
    if (
      binding === undefined ||
      resolveDeclaration(output, frame.module.parents) !== binding
    ) {
      return value;
    }
    return this.#typeofStringValue(value);
  };

  readonly #validatedConditionalOutput = ({
    node,
    value,
    frame,
  }: {
    node: Extract<Node, { type: "ConditionalExpression" }>;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    const test = unwrap(node.test);
    const output = unwrap(node.consequent);
    if (
      test.type !== "MemberExpression" ||
      output.type !== "MemberExpression" ||
      accessName(test) !== "success" ||
      accessName(output) !== "output"
    ) {
      return value;
    }
    const checked = this.#staticReference(test.object, frame);
    const returned = this.#staticReference(output.object, frame);
    if (
      checked === undefined ||
      returned === undefined ||
      checked.binding !== returned.binding ||
      JSON.stringify(checked.keys) !== JSON.stringify(returned.keys)
    ) {
      return value;
    }
    return this.#validatedOutputs({
      result: this.#evaluate(test.object, frame),
      fallback: value,
    });
  };

  readonly #opaqueValibotSchema = (): OrgGraphValue => ({
    kind: "schema",
    output: { kind: "input" },
  });

  readonly #isValibotSchema = (value: OrgGraphValue): boolean => {
    const parts = this.#alternatives(value);
    return parts.length > 0 && parts.every((part) => part.kind === "schema");
  };

  readonly #valibotObjectEntries = (
    value: OrgGraphValue,
  ): OrgGraphObjectValue | undefined => {
    const parts = this.#alternatives(value);
    if (parts.length !== 1 || parts[0]?.kind !== "object") {
      return undefined;
    }
    const object = parts[0];
    if (
      object.prototypeDisposition !== "ordinary" ||
      object.propertyPresence !== "closed" ||
      object.keyStability === "mutable" ||
      object.unknownFields.kind !== "bottom" ||
      [...object.fields.values()].some((field) => !this.#isValibotSchema(field))
    ) {
      return undefined;
    }
    return object;
  };

  readonly #valibotObjectFactory = ({
    args,
    frame,
    node,
  }: {
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const entries = this.#valibotObjectEntries(args.at(0) ?? this.#bottom);
    if (args.length !== 1 || entries === undefined) {
      return this.#fail(
        frame,
        node,
        "Valibot object requires fixed schema entries",
      );
    }
    const fields = new Map<string, OrgGraphValue>();
    for (const [key, schema] of entries.fields) {
      fields.set(
        key,
        this.#join(
          ...this.#alternatives(schema).map((part) => {
            if (part.kind !== "schema") {
              return panic("Object schema entry lost native provenance");
            }
            return part.output;
          }),
        ),
      );
    }
    const optionalFields = new Set<string>();
    for (const [key, output] of fields) {
      const parts = this.#alternatives(output);
      if (
        parts.length === 0 ||
        parts.some(
          (part) =>
            part.kind !== "array" &&
            part.kind !== "object" &&
            !(part.kind === "input" && part.primitive === "string"),
        )
      ) {
        optionalFields.add(key);
      }
    }
    return {
      kind: "schema",
      output: {
        kind: "object",
        prototypeDisposition: "ordinary",
        propertyPresence: "closed",
        keyStability: "fixed",
        fields,
        unknownFields: this.#bottom,
        optionalFields,
      },
    };
  };

  readonly #valibotOptionalFactory = ({
    args,
    frame,
    node,
  }: {
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    if (
      (args.length !== 1 && args.length !== 2) ||
      !this.#isValibotSchema(args.at(0) ?? this.#bottom)
    ) {
      return this.#fail(
        frame,
        node,
        "Valibot optional requires a wrapped schema",
      );
    }
    if (args.length === 2) {
      const defaults = this.#alternatives(args.at(1) ?? this.#bottom);
      if (
        defaults.length === 0 ||
        defaults.some((part) => part.kind !== "literal")
      ) {
        return this.#fail(
          frame,
          node,
          "Valibot optional default cannot alias mutable data",
        );
      }
    }
    const outputs = this.#alternatives(args.at(0) ?? this.#bottom).map(
      (part) => {
        if (part.kind !== "schema") {
          return panic("Optional schema lost native provenance");
        }
        return part.output;
      },
    );
    if (
      outputs.length > 0 &&
      outputs.every(
        (output) => output.kind === "array" || output.kind === "object",
      )
    ) {
      // Preserve native container structure without granting opaque scalar proof.
      return {
        kind: "schema",
        output: this.#join(
          ...outputs,
          args.at(1) ?? { kind: "literal", value: undefined },
        ),
      };
    }
    return this.#opaqueValibotSchema();
  };

  readonly #valibotFactoryCall = ({
    name,
    args,
    frame,
    node,
  }: {
    name: string;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    const actionName = VALIBOT_ACTION_NAMES.find(
      (candidate) => candidate === name,
    );
    const schemaFactory = VALIBOT_SCHEMA_FACTORY_NAMES.some(
      (candidate) => candidate === name,
    );
    if (!schemaFactory && actionName === undefined) {
      return undefined;
    }
    if (
      args.some(
        (argument) =>
          this.#relevant(argument) ||
          this.#containsCallable(argument) ||
          this.#containsNativeIdentity(argument),
      )
    ) {
      return this.#fail(
        frame,
        node,
        "Valibot schema factory receives a transaction capability, callable, or native identity",
      );
    }
    const fixedArray = (
      value: OrgGraphValue,
    ): OrgGraphArrayValue | undefined => {
      const parts = this.#alternatives(value);
      if (
        parts.length !== 1 ||
        parts[0]?.kind !== "array" ||
        parts[0].stability !== "fixed"
      ) {
        return undefined;
      }
      return parts[0];
    };
    if (actionName !== undefined) {
      const noArgAction = actionName === "integer";
      if (noArgAction && args.length === 0) {
        return { kind: "valibot-action", name: "integer" };
      }
      const requirement = args.at(0);
      if (
        !noArgAction &&
        args.length === 1 &&
        requirement?.kind === "literal" &&
        typeof requirement.value === "number" &&
        Number.isFinite(requirement.value)
      ) {
        return {
          kind: "valibot-action",
          name: actionName,
        };
      }
      return this.#fail(
        frame,
        node,
        `Valibot ${name} requires its literal requirement`,
      );
    }
    switch (name) {
      case "object":
        return this.#valibotObjectFactory({ args, frame, node });
      case "record":
        if (
          args.length !== 2 ||
          args.some((argument) => !this.#isValibotSchema(argument))
        ) {
          return this.#fail(
            frame,
            node,
            "Valibot record requires key and value schemas",
          );
        }
        return this.#opaqueValibotSchema();
      case "variant": {
        const key = args.at(0);
        const options = fixedArray(args.at(1) ?? this.#bottom);
        if (
          args.length !== 2 ||
          key?.kind !== "literal" ||
          typeof key.value !== "string" ||
          options === undefined ||
          options.values.some((option) => !this.#isValibotSchema(option))
        ) {
          return this.#fail(
            frame,
            node,
            "Valibot variant requires a literal key and fixed schema options",
          );
        }
        return this.#opaqueValibotSchema();
      }
      case "pipe":
        if (
          args.length === 0 ||
          !this.#isValibotSchema(args.at(0) ?? this.#bottom) ||
          args.slice(1).some((action) => action.kind !== "valibot-action")
        ) {
          return this.#fail(
            frame,
            node,
            "Valibot pipe requires a schema followed by modeled validation actions",
          );
        }
        return this.#opaqueValibotSchema();
      case "optional":
        return this.#valibotOptionalFactory({ args, frame, node });
      case "picklist": {
        const options = fixedArray(args.at(0) ?? this.#bottom);
        if (
          args.length !== 1 ||
          options === undefined ||
          options.values.some(
            (option) =>
              option.kind !== "literal" || typeof option.value !== "string",
          )
        ) {
          return this.#fail(
            frame,
            node,
            "Valibot picklist requires a fixed string literal array",
          );
        }
        return this.#opaqueValibotSchema();
      }
      case "boolean":
      case "number":
      case "unknown":
        if (args.length !== 0) {
          return this.#fail(
            frame,
            node,
            `Valibot ${name} schema requires zero arguments`,
          );
        }
        return this.#opaqueValibotSchema();
      case "literal": {
        const value = args.at(0);
        if (args.length !== 1 || value?.kind !== "literal") {
          return this.#fail(
            frame,
            node,
            "Valibot literal schema requires one primitive literal",
          );
        }
        return this.#opaqueValibotSchema();
      }
      default:
        return panic("Unreachable Valibot schema factory name");
    }
  };

  readonly #valibotCall = ({
    fn,
    args,
    frame,
    node,
  }: {
    fn: OrgGraphValue;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (fn.kind !== "external" || fn.module !== "valibot") {
      return undefined;
    }
    if (fn.name === "string") {
      if (args.length !== 0) {
        return this.#fail(
          frame,
          node,
          "Valibot string schema requires zero arguments",
        );
      }
      return { kind: "schema", output: { kind: "input", primitive: "string" } };
    }
    if (fn.name === "array") {
      const element = args.at(0);
      if (element === undefined) {
        return undefined;
      }
      if (
        args.some(
          (argument) =>
            this.#relevant(argument) ||
            this.#containsCallable(argument) ||
            this.#containsNativeIdentity(argument),
        )
      ) {
        return this.#fail(
          frame,
          node,
          "Valibot array schema receives a transaction capability or callable",
        );
      }
      return {
        kind: "schema",
        output: {
          kind: "array",
          extent: { type: "unknown" },
          stability: "mutable",
          values: [
            element.kind === "schema" ? element.output : { kind: "input" },
          ],
        },
      };
    }
    const factory = this.#valibotFactoryCall({
      name: fn.name,
      args,
      frame,
      node,
    });
    if (factory !== undefined) {
      return factory;
    }
    if (fn.name !== "safeParse" && fn.name !== "parse") {
      return undefined;
    }
    const schema = args.at(0);
    if (schema?.kind !== "schema") {
      return undefined;
    }
    if (
      args.some(
        (argument) =>
          this.#relevant(argument) ||
          this.#containsCallable(argument) ||
          this.#containsNativeIdentity(argument),
      )
    ) {
      return this.#fail(
        frame,
        node,
        "Valibot validation receives a transaction capability or callable",
      );
    }
    const input =
      args.at(1) ??
      ({ kind: "literal", value: undefined } satisfies OrgGraphValue);
    this.#assertValidationInputAliases({
      output: schema.output,
      input,
      frame,
      node,
    });
    this.#assertNoOpaqueDataEscape({ values: args.slice(2), frame, node });
    const output = this.#ownValue(this.#freshSchemaOutput(schema.output), {
      frame,
      node,
      role: "validation-output",
    });
    this.#assertFreshValidationOutput({ output, input, frame, node });
    if (fn.name === "parse") {
      return output;
    }
    const fields = new Map<string, OrgGraphValue>();
    // A failed safeParse does not establish the string schema's output proof.
    // Retain original input aliases until this exact result's success branch is used.
    const hasOutputProof =
      this.#containsStringOutput(output) || output.kind === "array";
    fields.set("success", { kind: "input" });
    fields.set("output", this.#join(output, input));
    return {
      kind: "object",
      prototypeDisposition: "ordinary",
      propertyPresence: "open",
      fields,
      // Unmodeled issues/path fields can also refer to the original input.
      unknownFields: input,
      ...(hasOutputProof
        ? {
            validation: {
              id: sha256Hex(
                JSON.stringify({
                  file: frame.module.file,
                  start: node.start,
                  entry: frame.entry,
                  context: frame.context,
                  args: args.map((argument) =>
                    this.#signature({
                      value: argument,
                    }),
                  ),
                }),
              ),
              output,
            },
          }
        : {}),
    };
  };

  readonly #staticReference = (
    node: Node,
    frame: OrgGraphFrame,
  ): { binding: Identifier; keys: readonly string[] } | undefined => {
    let current = unwrap(node);
    const keys: string[] = [];
    while (current.type === "MemberExpression") {
      const key = accessName(current);
      if (key === undefined) {
        return undefined;
      }
      keys.unshift(key);
      current = unwrap(current.object);
    }
    if (current.type !== "Identifier") {
      return undefined;
    }
    const binding = resolveDeclaration(current, frame.module.parents);
    return binding === undefined ? undefined : { binding, keys };
  };

  readonly #arrayExitStatement = (
    call: OrgGraphArrayGuardSite,
    frame: OrgGraphFrame,
  ): Statement | undefined => {
    if (call.type === "ForOfStatement") {
      return call;
    }
    const parent = frame.module.parents.get(call);
    if (
      parent?.type === "ReturnStatement" &&
      parent.argument !== null &&
      unwrap(parent.argument) === call
    ) {
      return parent;
    }
    if (
      parent?.type === "ExpressionStatement" &&
      unwrap(parent.expression) === call
    ) {
      return parent;
    }
    if (
      parent?.type !== "VariableDeclarator" ||
      parent.init === null ||
      unwrap(parent.init) !== call
    ) {
      return undefined;
    }
    const declaration = frame.module.parents.get(parent);
    return declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const" &&
      declaration.declarations.length === 1
      ? declaration
      : undefined;
  };

  readonly #arrayLengthComparison = ({
    test,
    predicate,
    frame,
  }: {
    test: Node;
    predicate: Node;
    frame: OrgGraphFrame;
  }): boolean => {
    if (
      predicate.type !== "CallExpression" ||
      predicate.arguments.length !== 1
    ) {
      return false;
    }
    const argument = predicate.arguments.at(0);
    const comparison = unwrap(test);
    if (
      argument === undefined ||
      argument.type === "SpreadElement" ||
      comparison.type !== "BinaryExpression" ||
      !["===", "!==", "<", "<=", ">", ">="].includes(comparison.operator)
    ) {
      return false;
    }
    const length = unwrap(comparison.left);
    const bound = unwrap(comparison.right);
    if (
      length.type !== "MemberExpression" ||
      accessName(length) !== "length" ||
      bound.type !== "Literal" ||
      typeof bound.value !== "number"
    ) {
      return false;
    }
    const source = this.#staticReference(argument, frame);
    const checked = this.#staticReference(length.object, frame);
    return (
      source !== undefined &&
      checked !== undefined &&
      source.binding === checked.binding &&
      JSON.stringify(source.keys) === JSON.stringify(checked.keys)
    );
  };

  readonly #inertArrayGuardDeclaration = (
    node: Node,
    checked: Identifier,
  ): boolean => {
    if (
      node.type !== "VariableDeclaration" ||
      node.kind !== "const" ||
      node.declarations.length === 0
    ) {
      return false;
    }
    return node.declarations.every((declaration) => {
      if (
        declaration.id.type !== "Identifier" ||
        declaration.id === checked ||
        declaration.init === null
      ) {
        return false;
      }
      const value = unwrap(declaration.init);
      if (value.type === "ArrayExpression") {
        return value.elements.length === 0;
      }
      if (value.type === "ObjectExpression") {
        return value.properties.length === 0;
      }
      return (
        value.type === "Literal" &&
        (value.value === null ||
          typeof value.value === "string" ||
          typeof value.value === "number" ||
          typeof value.value === "boolean")
      );
    });
  };

  readonly #precedingArrayExitGuard = ({
    call,
    receiver,
    frame,
  }: OrgGraphArrayGuardOptions): Node | undefined => {
    const checked = this.#staticReference(receiver, frame);
    if (checked === undefined) {
      return undefined;
    }
    const statement = this.#arrayExitStatement(call, frame);
    if (statement === undefined) {
      return undefined;
    }
    const block = frame.module.parents.get(statement);
    if (block?.type !== "BlockStatement") {
      return undefined;
    }
    const index = block.body.indexOf(statement);
    if (index <= 0) {
      return undefined;
    }
    let precedingIndex = index - 1;
    while (precedingIndex >= 0) {
      const candidate = block.body.at(precedingIndex);
      if (
        candidate === undefined ||
        !this.#inertArrayGuardDeclaration(candidate, checked.binding)
      ) {
        break;
      }
      precedingIndex -= 1;
    }
    const rejection =
      precedingIndex < 0 ? undefined : block.body.at(precedingIndex);
    if (rejection?.type !== "IfStatement" || rejection.alternate !== null) {
      return undefined;
    }
    const exit =
      rejection.consequent.type === "BlockStatement" &&
      rejection.consequent.body.length === 1
        ? rejection.consequent.body.at(0)
        : rejection.consequent;
    if (exit?.type !== "ReturnStatement" && exit?.type !== "ThrowStatement") {
      return undefined;
    }
    let test = unwrap(rejection.test);
    let bound: Node | undefined;
    if (test.type === "LogicalExpression" && test.operator === "||") {
      bound = unwrap(test.right);
      test = unwrap(test.left);
    }
    if (test.type !== "UnaryExpression" || test.operator !== "!") {
      return undefined;
    }
    const predicate = unwrap(test.argument);
    if (
      bound !== undefined &&
      !this.#arrayLengthComparison({ test: bound, predicate, frame })
    ) {
      return undefined;
    }
    return predicate;
  };

  readonly #immediateArrayGuard = ({
    call,
    receiver,
    frame,
  }: OrgGraphArrayGuardOptions): Node | undefined => {
    const preceding = this.#precedingArrayExitGuard({ call, receiver, frame });
    if (preceding !== undefined) {
      return preceding;
    }
    if (call.type === "ForOfStatement") {
      return undefined;
    }
    const parent = frame.module.parents.get(call);
    if (
      parent?.type === "ConditionalExpression" &&
      unwrap(parent.consequent) === call
    ) {
      return parent.test;
    }
    if (parent?.type === "LogicalExpression" && unwrap(parent.right) === call) {
      const left = unwrap(parent.left);
      if (parent.operator === "&&") {
        return left;
      }
      if (
        parent.operator === "||" &&
        left.type === "UnaryExpression" &&
        left.operator === "!"
      ) {
        return left.argument;
      }
    }
    if (
      parent?.type !== "ReturnStatement" ||
      parent.argument === null ||
      unwrap(parent.argument) !== call
    ) {
      return undefined;
    }
    const holder = frame.module.parents.get(parent);
    if (holder?.type === "IfStatement" && holder.consequent === parent) {
      return holder.test;
    }
    if (holder?.type !== "BlockStatement" || holder.body.at(0) !== parent) {
      return undefined;
    }
    const branch = frame.module.parents.get(holder);
    return branch?.type === "IfStatement" && branch.consequent === holder
      ? branch.test
      : undefined;
  };

  readonly #arrayValue = (value: OrgGraphValue): OrgGraphValue =>
    this.#join(
      ...this.#alternatives(value).map((part): OrgGraphValue => {
        if (part.kind === "array") {
          return part;
        }
        if (this.#nativeExternalIdentity(part)) {
          return part;
        }
        if (part.kind === "input" && part.primitive === "string") {
          return this.#bottom;
        }
        if (
          part.kind === "input" ||
          part.kind === "unknown" ||
          part.kind === "external"
        ) {
          return {
            kind: "array",
            extent: { type: "unknown" },
            stability: "mutable",
            values: [{ kind: "input" }],
          };
        }
        return this.#bottom;
      }),
    );

  readonly #pureTypeofPredicate = (
    node: Node,
    frame: OrgGraphFrame,
  ): boolean => {
    const callback = unwrap(node);
    if (
      callback.type !== "ArrowFunctionExpression" ||
      callback.params.length !== 1
    ) {
      return false;
    }
    const parameter = callback.params.at(0);
    const body = unwrap(callback.body);
    if (
      parameter?.type !== "Identifier" ||
      body.type !== "BinaryExpression" ||
      body.operator !== "==="
    ) {
      return false;
    }
    const left = unwrap(body.left);
    const right = unwrap(body.right);
    return (
      left.type === "UnaryExpression" &&
      left.operator === "typeof" &&
      left.argument.type === "Identifier" &&
      right.type === "Literal" &&
      typeof right.value === "string" &&
      resolveDeclaration(left.argument, frame.module.parents) === parameter
    );
  };

  readonly #arrayReturnValue = ({
    node,
    value,
    frame,
  }: {
    node: Extract<Node, { type: "ConditionalExpression" }>;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    let predicate = unwrap(node.test);
    let every: Node | undefined;
    if (predicate.type === "LogicalExpression" && predicate.operator === "&&") {
      every = unwrap(predicate.right);
      predicate = unwrap(predicate.left);
    }
    if (
      predicate.type !== "CallExpression" ||
      predicate.arguments.length !== 1
    ) {
      return value;
    }
    const argument = predicate.arguments.at(0);
    if (argument === undefined || argument.type === "SpreadElement") {
      return value;
    }
    const source = this.#staticReference(argument, frame);
    const target = this.#staticReference(node.consequent, frame);
    if (
      source === undefined ||
      target === undefined ||
      source.binding !== target.binding ||
      JSON.stringify(source.keys) !== JSON.stringify(target.keys)
    ) {
      return value;
    }
    const callee = unwrap(predicate.callee);
    if (callee.type !== "Identifier" && callee.type !== "MemberExpression") {
      return value;
    }
    if (
      callee.type === "MemberExpression" &&
      unwrap(callee.object).type !== "Identifier"
    ) {
      return value;
    }
    const fn = this.#evaluate(callee, frame);
    if (
      fn.kind !== "external" ||
      fn.module !== "global" ||
      fn.name !== "Array.isArray"
    ) {
      return value;
    }
    if (every !== undefined) {
      if (every.type !== "CallExpression" || every.arguments.length !== 1) {
        return value;
      }
      const member = unwrap(every.callee);
      const callback = every.arguments.at(0);
      if (
        member.type !== "MemberExpression" ||
        accessName(member) !== "every" ||
        callback === undefined ||
        callback.type === "SpreadElement" ||
        !this.#pureTypeofPredicate(callback, frame)
      ) {
        return value;
      }
      const checked = this.#staticReference(member.object, frame);
      if (
        checked === undefined ||
        checked.binding !== target.binding ||
        JSON.stringify(checked.keys) !== JSON.stringify(target.keys)
      ) {
        return value;
      }
    }
    // Return the same proven array, keeping known transaction/callable values.
    // The optional every check is a pure typeof predicate, so it cannot mutate
    // the reference between native admission and this direct return branch.
    return this.#arrayValue(value);
  };

  readonly #enclosingArrayGuard = ({
    call,
    receiver,
    frame,
  }: OrgGraphArrayGuardOptions): Node | undefined => {
    const target = unwrapTypes(receiver);
    if (target.type !== "Identifier") {
      return undefined;
    }
    const binding = resolveDeclaration(target, frame.module.parents);
    if (binding === undefined) {
      return undefined;
    }
    const owner =
      frame.context === undefined
        ? undefined
        : this.#contexts.get(frame.context)?.fn.node;
    if (owner !== undefined && this.#hasDirectEval(owner)) {
      return undefined;
    }
    if (!this.#stableReadBinding(binding, frame)) {
      return undefined;
    }
    let current: Node = call;
    while (true) {
      const parent = frame.module.parents.get(current);
      if (parent === undefined || this.#isFunctionNode(parent)) {
        return undefined;
      }
      if (parent.type === "IfStatement" && parent.consequent === current) {
        const test = unwrapTypes(parent.test);
        const argument =
          test.type === "CallExpression" && test.arguments.length === 1
            ? test.arguments.at(0)
            : undefined;
        if (
          test.type === "CallExpression" &&
          argument?.type === "Identifier" &&
          resolveDeclaration(argument, frame.module.parents) === binding
        ) {
          const fn = this.#evaluate(test.callee, frame);
          if (
            fn.kind === "external" &&
            fn.module === "global" &&
            fn.name === "Array.isArray"
          ) {
            return test;
          }
        }
      }
      current = parent;
    }
  };

  readonly #guardedArrayReceiver = ({
    call,
    receiver,
    value,
    frame,
  }: {
    call: OrgGraphArrayGuardSite;
    receiver: Node;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    const test =
      this.#immediateArrayGuard({ call, receiver, frame }) ??
      this.#enclosingArrayGuard({ call, receiver, frame });
    if (test === undefined) {
      return value;
    }
    const predicate = unwrap(test);
    if (
      predicate.type !== "CallExpression" ||
      predicate.arguments.length !== 1
    ) {
      return value;
    }
    const argument = predicate.arguments.at(0);
    if (argument === undefined || argument.type === "SpreadElement") {
      return value;
    }
    const source = this.#staticReference(argument, frame);
    const target = this.#staticReference(receiver, frame);
    if (
      source === undefined ||
      target === undefined ||
      source.binding !== target.binding ||
      JSON.stringify(source.keys) !== JSON.stringify(target.keys)
    ) {
      return value;
    }
    const fn = this.#evaluate(predicate.callee, frame);
    if (
      fn.kind !== "external" ||
      fn.module !== "global" ||
      fn.name !== "Array.isArray"
    ) {
      return value;
    }
    // The use must follow this native predicate's continuing branch. Empty
    // allocations and scalar declarations do not alter the checked binding;
    // aliases and intervening effects cannot carry this proof forward.
    return this.#arrayValue(value);
  };

  readonly #callSetMethod = ({
    receiver,
    name,
    args,
    frame,
    node,
  }: {
    receiver: OrgGraphValue;
    name: string;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const results: OrgGraphValue[] = [];
    for (const set of this.#alternatives(receiver)) {
      if (set.kind !== "set") {
        return panic("Native Set receiver narrowing failed");
      }
      const item =
        args.at(0) ??
        ({ kind: "literal", value: undefined } satisfies OrgGraphValue);
      switch (name) {
        case "add": {
          if (this.#containsScopedCapability(item)) {
            return this.#fail(
              frame,
              node,
              "scoped capability cannot enter a mutable container",
            );
          }
          set.stability = "mutable";
          if (
            !set.values.some(
              (known) =>
                known === item ||
                (known.kind === "literal" &&
                  (known.value === item.value ||
                    Object.is(known.value, item.value))),
            )
          ) {
            set.values.push(item);
          }
          if (set.values.length > 128) {
            return this.#fail(
              frame,
              node,
              "abstract mutable Set exceeds its finite domain",
            );
          }
          results.push(set);
          break;
        }
        case "has":
        case "delete": {
          const exact =
            set.stability === "fixed" &&
            item.kind === "literal" &&
            set.values.every((known) => known.kind === "literal");
          const present = exact
            ? set.values.some(
                (known) =>
                  known.kind === "literal" &&
                  (known.value === item.value ||
                    Object.is(known.value, item.value)),
              )
            : undefined;
          // Branch frames share containers: removal must not erase values that
          // another possible path still reaches through an alias or closure.
          if (name === "delete") {
            set.stability = "mutable";
          }
          results.push(
            present === undefined
              ? { kind: "input" }
              : { kind: "literal", value: present },
          );
          break;
        }
        case "clear":
          set.stability = "mutable";
          results.push({ kind: "literal", value: undefined });
          break;
        default:
          return this.#fail(
            frame,
            node,
            `unsupported native Set method ${name}`,
          );
      }
    }
    return this.#join(...results);
  };

  readonly #objectFieldNames = (
    fields: ReadonlyMap<string, OrgGraphValue>,
  ): string[] =>
    Object.keys(
      Object.fromEntries([...fields.keys()].map((key) => [key, null])),
    );

  readonly #objectEnumeration = ({
    value,
    projection,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    projection: "entries" | "values";
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const alternatives = this.#alternatives(value);
    if (alternatives.length === 0) {
      return this.#fail(frame, node, "unresolved object enumeration source");
    }
    const entryValue = (
      key: OrgGraphValue,
      item: OrgGraphValue,
    ): OrgGraphValue =>
      projection === "entries"
        ? {
            kind: "array",
            extent: { type: "finite", maximum: 2 },
            stability: "fixed",
            values: [key, item],
          }
        : item;
    return this.#join(
      ...alternatives.map((part): OrgGraphValue => {
        if (part.kind === "input") {
          return {
            kind: "array",
            extent: { type: "unknown" },
            stability: "mutable",
            values: [entryValue({ kind: "input", primitive: "string" }, part)],
          };
        }
        if (part.kind === "array") {
          // Sparse slots are not distinguished from undefined values, and
          // mutable positions may move: retain possibilities without fixing extent.
          return {
            kind: "array",
            extent: { type: "unknown" },
            stability: "mutable",
            values: part.values.map((item, index) =>
              entryValue(
                part.stability === "fixed"
                  ? { kind: "literal", value: String(index) }
                  : { kind: "input", primitive: "string" },
                item,
              ),
            ),
          };
        }
        if (
          part.kind !== "object" ||
          part.prototypeDisposition === "unmodeled"
        ) {
          return this.#fail(
            frame,
            node,
            `object enumeration requires a plain object or opaque input data (source kind: ${part.kind}${part.kind === "unknown" ? `; reason: ${part.reason}` : ""})`,
          );
        }
        const values = this.#objectFieldNames(part.fields).map((key) =>
          entryValue(
            { kind: "literal", value: key },
            this.#join(
              part.fields.get(key) ?? panic("Missing enumerated own field"),
              part.unknownFields,
            ),
          ),
        );
        const unknownValues = this.#unknownOwnValues(part);
        if (unknownValues.kind !== "bottom") {
          values.push(
            entryValue({ kind: "input", primitive: "string" }, unknownValues),
          );
        }
        if (values.length > 128) {
          return this.#fail(
            frame,
            node,
            "object enumeration exceeds its finite key domain",
          );
        }
        const exact =
          part.propertyPresence === "closed" &&
          part.keyStability !== "mutable" &&
          part.unknownFields.kind === "bottom" &&
          (part.optionalFields?.size ?? 0) === 0;
        return {
          kind: "array",
          extent: exact
            ? { type: "finite", maximum: values.length }
            : { type: "unknown" },
          stability: exact ? "fixed" : "mutable",
          values,
        };
      }),
    );
  };

  readonly #objectHasOwn = ({
    value,
    key,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    key: OrgGraphValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const keys = this.#alternatives(key).map((part): string | undefined => {
      if (part.kind === "literal" && typeof part.value === "string") {
        return part.value;
      }
      if (
        part.kind === "literal" &&
        (part.value === null ||
          part.value === undefined ||
          typeof part.value === "boolean" ||
          typeof part.value === "number")
      ) {
        return String(part.value);
      }
      if (part.kind === "input" && part.primitive === "string") {
        return undefined;
      }
      return this.#fail(
        frame,
        node,
        "Object.hasOwn key requires a primitive literal or proven string",
      );
    });
    if (keys.length === 0) {
      return this.#fail(frame, node, "Object.hasOwn key is unresolved");
    }
    const alternatives = this.#alternatives(value);
    if (alternatives.length === 0) {
      return this.#fail(frame, node, "Object.hasOwn target is unresolved");
    }
    const results: OrgGraphValue[] = [];
    for (const part of alternatives) {
      if (part.kind === "input") {
        results.push({ kind: "input" });
        continue;
      }
      if (part.kind !== "object" || part.prototypeDisposition === "unmodeled") {
        return this.#fail(
          frame,
          node,
          `Object.hasOwn requires a tracked object or opaque input object (source kind: ${part.kind})`,
        );
      }
      for (const property of keys) {
        if (
          property === undefined ||
          part.propertyPresence !== "closed" ||
          part.keyStability !== "fixed" ||
          part.unknownFields.kind !== "bottom" ||
          part.optionalFields?.has(property)
        ) {
          results.push({ kind: "input" });
          continue;
        }
        results.push({
          kind: "literal",
          value: part.fields.has(property),
        });
      }
    }
    return this.#join(...results);
  };

  readonly #objectFromEntries = ({
    value,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const sources = this.#alternatives(value);
    if (
      sources.length === 0 ||
      sources.some((part) => part.kind !== "array" && part.kind !== "set")
    ) {
      return this.#fail(
        frame,
        node,
        "Object.fromEntries requires a native array or Set iterable",
      );
    }
    const iterable = this.#iterableValues({ value, frame, node });
    const fields = new Map<string, OrgGraphValue>();
    const optionalFields = new Set<string>();
    let unknownFields = this.#bottom;
    let keyStability: "fixed" | "mutable" = iterable.stability;
    let propertyPresence: OrgGraphPropertyPresence = "closed";
    for (const entry of iterable.values) {
      const pairs = this.#alternatives(entry);
      if (pairs.length === 0) {
        return this.#fail(
          frame,
          node,
          "Object.fromEntries requires modeled native entries",
        );
      }
      for (const pair of pairs) {
        if (pair.kind !== "array" || pair.stability !== "fixed") {
          return this.#fail(
            frame,
            node,
            "Object.fromEntries requires fixed native array entries",
          );
        }
        const keys = this.#computedOwnPropertyKeys({
          key: this.#arrayElementValue({
            array: pair,
            index: { kind: "literal", value: 0 },
          }),
          frame,
          node,
        });
        const stored = this.#arrayElementValue({
          array: pair,
          index: { kind: "literal", value: 1 },
        });
        const definite =
          iterable.stability === "fixed" &&
          pairs.length === 1 &&
          keys.presence === "closed" &&
          keys.names.length === 1;
        if (!definite) {
          keyStability = "mutable";
        }
        if (keys.presence === "open") {
          unknownFields = this.#join(unknownFields, stored);
          propertyPresence = "known-values";
        }
        for (const name of keys.names) {
          if (definite) {
            fields.set(name, stored);
            optionalFields.delete(name);
          } else {
            const present = fields.has(name) && !optionalFields.has(name);
            fields.set(
              name,
              this.#join(fields.get(name) ?? this.#bottom, stored),
            );
            if (!present) {
              optionalFields.add(name);
            }
          }
        }
      }
    }
    return {
      kind: "object",
      prototypeDisposition: "ordinary",
      fields,
      optionalFields,
      unknownFields,
      keyStability,
      propertyPresence,
    };
  };

  readonly #objectKeys = ({
    value,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const alternatives = this.#alternatives(value);
    if (alternatives.length === 0) {
      return this.#fail(frame, node, "unresolved Object.keys input");
    }
    return this.#join(
      ...alternatives.map((part): OrgGraphValue => {
        let keys: string[] = [];
        let exact = false;
        if (part.kind === "object") {
          // Use native own-key ordering without reading stored values.
          // Stored values are neither read nor invoked by Object.keys.
          keys = this.#objectFieldNames(part.fields);
          exact =
            part.propertyPresence === "closed" &&
            part.unknownFields.kind === "bottom" &&
            part.keyStability !== "mutable" &&
            (part.optionalFields?.size ?? 0) === 0 &&
            part.prototypeDisposition === "ordinary";
        } else if (part.kind === "literal") {
          if (part.value === null || part.value === undefined) {
            return this.#fail(
              frame,
              node,
              `Object.keys requires a non-null input (received ${String(part.value)})`,
            );
          }
          keys =
            typeof part.value === "string"
              ? Array.from({ length: part.value.length }, (_, index) =>
                  String(index),
                )
              : [];
          exact = true;
        }
        // Arrays may be sparse: the values domain cannot prove present indices.
        // Other opaque objects likewise expose only possible string-key data.
        const values: OrgGraphValue[] = keys.map((key) => ({
          kind: "literal",
          value: key,
        }));
        if (!exact) {
          values.push({ kind: "input", primitive: "string" });
        }
        if (values.length > 128) {
          return this.#fail(
            frame,
            node,
            "Object.keys exceeds its finite key domain",
          );
        }
        return {
          kind: "array",
          extent: exact
            ? { type: "finite", maximum: values.length }
            : { type: "unknown" },
          stability: exact ? "fixed" : "mutable",
          values,
        };
      }),
    );
  };

  readonly #callValue = (
    node: CallExpression,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const callee = unwrap(node.callee);
    const reference =
      callee.type === "MemberExpression"
        ? this.#memberReference(callee, frame)
        : undefined;
    const member =
      reference?.receiver !== undefined && callee.type === "MemberExpression"
        ? {
            ...reference,
            receiver: this.#guardedArrayReceiver({
              call: node,
              receiver: callee.object,
              value: reference.receiver,
              frame,
            }),
          }
        : reference;
    // GetValue and the receiver reference are captured before argument effects.
    const alternatives = this.#alternatives(
      reference === undefined ? this.#evaluate(callee, frame) : reference.value,
    );
    const shortCircuited = alternatives.some(
      (part) =>
        part.kind === "chain-short-circuit" ||
        (node.optional &&
          part.kind === "literal" &&
          (part.value === null || part.value === undefined)),
    );
    const fn = this.#join(
      ...alternatives.filter(
        (part) =>
          part.kind !== "chain-short-circuit" &&
          !(
            node.optional &&
            part.kind === "literal" &&
            (part.value === null || part.value === undefined)
          ),
      ),
    );
    const value =
      fn.kind === "bottom"
        ? this.#bottom
        : this.#callLiveValue({ node, frame, callee, fn, member });
    return shortCircuited
      ? this.#join(value, { kind: "chain-short-circuit" })
      : value;
  };

  readonly #utf8ReadOptions = (
    value: OrgGraphValue,
    method: "readdirSync" | "readFileSync",
  ): boolean => {
    const alternatives = this.#alternatives(value);
    return (
      alternatives.length > 0 &&
      alternatives.every((part) => {
        if (part.kind === "literal") {
          return (
            part.value === "utf-8" ||
            /^utf8$/u.test(String(part.value)) ||
            (method === "readdirSync" && part.value === undefined)
          );
        }
        if (
          part.kind !== "object" ||
          part.propertyPresence !== "closed" ||
          part.keyStability === "mutable" ||
          part.unknownFields.kind !== "bottom"
        ) {
          return false;
        }
        if (
          [...part.fields.keys()].some(
            (key) =>
              key !== "encoding" &&
              (method !== "readdirSync" ||
                (key !== "withFileTypes" && key !== "recursive")),
          )
        ) {
          return false;
        }
        const encoding =
          part.fields.get("encoding") ??
          ({ kind: "literal", value: undefined } satisfies OrgGraphValue);
        const encodings = this.#alternatives(encoding);
        if (
          encodings.length === 0 ||
          encodings.some(
            (option) =>
              option.kind !== "literal" ||
              (option.value !== "utf-8" &&
                !/^utf8$/u.test(String(option.value)) &&
                !(method === "readdirSync" && option.value === undefined)),
          )
        ) {
          return false;
        }
        for (const key of ["withFileTypes", "recursive"]) {
          const flag = part.fields.get(key);
          if (flag === undefined) {
            continue;
          }
          const values = this.#alternatives(flag);
          if (
            values.length === 0 ||
            values.some(
              (option) =>
                option.kind !== "literal" ||
                (option.value !== undefined &&
                  option.value !== false &&
                  !(key === "recursive" && option.value === true)),
            )
          ) {
            return false;
          }
        }
        return true;
      })
    );
  };

  readonly #nativePathCall = ({
    fn,
    args,
    frame,
    node,
  }: {
    fn: OrgGraphValue;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (
      fn.kind !== "external" ||
      (fn.module !== "node:path" && fn.module !== "path")
    ) {
      return undefined;
    }
    const name = fn.name.startsWith("default.") ? fn.name.slice(8) : fn.name;
    if (name !== "join" && name !== "resolve") {
      return undefined;
    }
    for (const argument of args) {
      if (this.#relevant(argument) || this.#containsCallable(argument)) {
        return this.#fail(
          frame,
          node,
          "native path construction cannot receive a transaction capability or callable",
        );
      }
      const values = this.#alternatives(argument);
      if (
        values.length === 0 ||
        values.some(
          (part) =>
            part.kind !== "input" &&
            !(part.kind === "literal" && typeof part.value === "string"),
        )
      ) {
        return this.#fail(
          frame,
          node,
          `native path construction requires string data (source: ${this.#signature(
            {
              value: argument,
            },
          )})`,
        );
      }
    }
    // join/resolve consume only strings; no filesystem reads or user callbacks.
    return { kind: "input", primitive: "string" };
  };

  readonly #nativeDataCall = ({
    fn,
    args,
    frame,
    node,
  }: {
    fn: OrgGraphValue;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (fn.kind !== "external") {
      return undefined;
    }
    const method = fn.name.startsWith("default.") ? fn.name.slice(8) : fn.name;
    const fileRead =
      (fn.module === "node:fs" || fn.module === "fs") &&
      (method === "readdirSync" || method === "readFileSync");
    if (fn.module === "global" && fn.name === "String") {
      if (args.length === 0) {
        return { kind: "literal", value: "" };
      }
      if (args.length !== 1) {
        return this.#fail(
          frame,
          node,
          "native String conversion requires one data value",
        );
      }
      const converted = this.#nativeReplacementResult({
        value: args.at(0) ?? this.#bottom,
        frame,
        node,
      });
      return "dynamic" in converted
        ? { kind: "input", primitive: "string" }
        : { kind: "literal", value: converted.literal };
    }
    const jsonParse = fn.module === "global" && fn.name === "JSON.parse";
    if (!fileRead && !jsonParse) {
      return undefined;
    }
    if (
      args.some(
        (value) => this.#relevant(value) || this.#containsCallable(value),
      )
    ) {
      return this.#fail(
        frame,
        node,
        "native data read cannot receive a transaction capability or callable",
      );
    }
    if (args.length === 0 || args.length > 2) {
      return this.#fail(
        frame,
        node,
        "native data read requires a modeled argument shape",
      );
    }
    const value = args.at(0) ?? this.#bottom;
    const options =
      args.at(1) ??
      ({ kind: "literal", value: undefined } satisfies OrgGraphValue);
    if (jsonParse) {
      const inputs = this.#alternatives(value);
      const revivers = this.#alternatives(options);
      if (
        inputs.length === 0 ||
        inputs.some(
          (part) =>
            part.kind !== "input" &&
            !(part.kind === "literal" && typeof part.value === "string"),
        ) ||
        revivers.length === 0 ||
        revivers.some(
          (part) =>
            part.kind !== "literal" ||
            (part.value !== undefined && part.value !== null),
        )
      ) {
        return this.#fail(
          frame,
          node,
          "JSON.parse requires data text and no reviver",
        );
      }
      return { kind: "input" };
    }
    if (method !== "readdirSync" && method !== "readFileSync") {
      return undefined;
    }
    const paths = this.#alternatives(value);
    if (
      paths.length === 0 ||
      paths.some(
        (part) =>
          part.kind !== "input" &&
          !(
            part.kind === "literal" &&
            (typeof part.value === "string" ||
              (method === "readFileSync" && typeof part.value === "number"))
          ) &&
          !(
            part.kind === "external" &&
            part.module === "global" &&
            part.name === "<instance:URL>"
          ),
      )
    ) {
      return this.#fail(
        frame,
        node,
        `native file read requires a data path or native URL (source: ${this.#signature(
          {
            value,
          },
        )})`,
      );
    }
    if (!this.#utf8ReadOptions(options, method)) {
      return this.#fail(
        frame,
        node,
        "native file read requires default directory names or explicit UTF-8 text options",
      );
    }
    // These native encoding contracts return primitive strings, not arbitrary
    // input objects with caller-defined replace or coercion methods.
    return method === "readdirSync"
      ? {
          kind: "array",
          extent: { type: "unknown" },
          stability: "mutable",
          values: [{ kind: "input", primitive: "string" }],
        }
      : { kind: "input", primitive: "string" };
  };

  readonly #nativeMutationExport = (
    file: string | undefined,
    name: string,
  ): boolean => {
    const contract = this.#options.schedulerWriteIntents;
    if (contract === undefined) {
      return false;
    }
    return (
      (contract.dispositions.size > 0 &&
        file === contract.ownerFile &&
        name === "writeSchedulerBookkeeping") ||
      (contract.globalJobs.size > 0 &&
        file === contract.globalOwnerFile &&
        name === "runGlobalSystemWork")
    );
  };

  readonly #nativeMutationCall = ({
    fn,
    args,
    frame,
    node,
  }: {
    fn: Extract<OrgGraphValue, { kind: "external" }>;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const contract =
      this.#options.schedulerWriteIntents ??
      panic("Missing scheduler write contract");
    const global = fn.module === contract.globalOwnerFile;
    const input =
      args.at(global ? 1 : 0) ??
      this.#unknown("missing closed mutation intent");
    const alternatives = this.#alternatives(input);
    if (alternatives.length === 0) {
      return this.#fail(frame, node, "unresolved closed mutation intent");
    }
    for (const operation of alternatives) {
      if (operation.kind !== "object") {
        return this.#fail(
          frame,
          node,
          "closed mutation intent requires a resolved object",
        );
      }
      for (const [field, value] of operation.fields) {
        if (
          field !== "db" &&
          field !== "table" &&
          this.#containsCallable(value)
        ) {
          return this.#fail(
            frame,
            node,
            "closed scheduler intent cannot receive a callback in its data",
          );
        }
      }
      const types = this.#alternatives(
        this.#field({
          value: operation,
          name: "type",
          frame,
        }),
      );
      if (types.length === 0) {
        return this.#fail(frame, node, "unresolved scheduler write intent");
      }
      for (const type of types) {
        if (type.kind !== "literal" || typeof type.value !== "string") {
          return this.#fail(frame, node, "unresolved scheduler write intent");
        }
        if (global) {
          if (contract.globalJobs.get(type.value) !== frame.module.file) {
            return this.#fail(
              frame,
              node,
              "global scheduler intent is not called by its declared owner",
            );
          }
          const receiver =
            args.at(0) ?? this.#unknown("missing global owner handle");
          if (this.#containsScopedCapability(receiver)) {
            return this.#fail(
              frame,
              node,
              "global scheduler intent requires its tenantless owner handle",
            );
          }
          continue;
        }
        const disposition = contract.dispositions.get(type.value);
        if (disposition === undefined) {
          return this.#fail(frame, node, "unclassified scheduler write intent");
        }
        let ownership: "organization" | "platform";
        if (disposition === "by-task") {
          const declared = this.#field({
            value: operation,
            name: "ownership",
            frame,
          });
          if (
            declared.kind !== "literal" ||
            (declared.value !== "organization" && declared.value !== "platform")
          ) {
            return this.#fail(
              frame,
              node,
              "unresolved scheduler task ownership",
            );
          }
          ownership = declared.value;
          const values = this.#field({
            value: operation,
            name: "values",
            frame,
          });
          this.#validateSchedulerTask({
            value: this.#field({
              value: values,
              name: "task",
              frame,
            }),
            ownership,
            frame,
            node,
          });
        } else {
          ownership = disposition;
          if (operation.fields.has("task")) {
            this.#validateSchedulerTask({
              value: this.#field({
                value: operation,
                name: "task",
                frame,
              }),
              ownership,
              frame,
              node,
            });
          }
          if (operation.fields.has("values")) {
            this.#validateSchedulerTask({
              value: this.#field({
                value: this.#field({
                  value: operation,
                  name: "values",
                  frame,
                }),
                name: "task",
                frame,
              }),
              ownership,
              frame,
              node,
            });
          }
        }
        if (ownership === "organization") {
          const handles = this.#alternatives(
            this.#field({
              value: operation,
              name: "db",
              frame,
            }),
          );
          if (
            handles.length === 0 ||
            handles.some((handle) => handle.kind !== "org-scoped-handle")
          ) {
            return this.#fail(
              frame,
              node,
              "organization scheduler intent requires its withOrgScope capability",
            );
          }
        }
      }
    }
    if (!global) {
      this.#reachedRecovery.add(contract.ownerFile);
    }
    this.#reachedNativeExports.add(`${fn.module}#${fn.name}`);
    return {
      kind: "array",
      extent: { type: "unknown" },
      stability: "mutable",
      values: [{ kind: "input" }],
    };
  };

  readonly #validateSchedulerTask = ({
    value,
    ownership,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    ownership: "organization" | "platform";
    frame: OrgGraphFrame;
    node: CallExpression;
  }): void => {
    const contract =
      this.#options.schedulerWriteIntents ??
      panic("Missing scheduler write contract");
    const tasks = this.#alternatives(value);
    if (tasks.length === 0) {
      return this.#fail(frame, node, "unresolved scheduler task ownership");
    }
    for (const task of tasks) {
      // Opaque data is accepted only at the typed owner's closed task parameter.
      // Unresolved local expressions never acquire that data provenance.
      if (task.kind === "input") {
        continue;
      }
      if (
        task.kind !== "literal" ||
        typeof task.value !== "string" ||
        contract.taskOwnership.get(task.value) !== ownership
      ) {
        return this.#fail(
          frame,
          node,
          "scheduler task ownership does not match its typed write intent",
        );
      }
    }
  };

  readonly #taggedErrorFactoryCall = ({
    args,
    frame,
    node,
  }: {
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const tag = args.at(0);
    if (
      args.length !== 1 ||
      tag?.kind !== "literal" ||
      typeof tag.value !== "string"
    ) {
      return this.#fail(
        frame,
        node,
        "TaggedError requires one literal string tag",
      );
    }
    return {
      kind: "external",
      module: "better-result",
      name: `${TAGGED_ERROR_BASE_PREFIX}${tag.value}>`,
      nativeState: true,
    };
  };

  readonly #objectUtilityCall = ({
    fn,
    args,
    frame,
    node,
  }: {
    fn: OrgGraphValue;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (
      fn.kind === "external" &&
      fn.module === "global" &&
      fn.name === "Object.hasOwn"
    ) {
      if (args.length !== 2) {
        return this.#fail(frame, node, "Object.hasOwn requires two arguments");
      }
      return this.#objectHasOwn({
        value: args[0] ?? this.#bottom,
        key: args[1] ?? this.#bottom,
        frame,
        node,
      });
    }
    if (
      fn.kind === "external" &&
      fn.module === "global" &&
      fn.name === "Object.fromEntries"
    ) {
      if (args.length !== 1) {
        return this.#fail(
          frame,
          node,
          "Object.fromEntries requires one iterable",
        );
      }
      return this.#objectFromEntries({
        value: args.at(0) ?? this.#bottom,
        frame,
        node,
      });
    }
    if (
      fn.kind === "external" &&
      fn.module === "global" &&
      (fn.name === "Object.entries" || fn.name === "Object.values")
    ) {
      return this.#objectEnumeration({
        value: args.at(0) ?? { kind: "literal", value: undefined },
        projection: fn.name === "Object.entries" ? "entries" : "values",
        frame,
        node,
      });
    }
    if (
      fn.kind === "external" &&
      fn.module === "global" &&
      fn.name === "Object.keys"
    ) {
      return this.#objectKeys({
        value: args.at(0) ?? { kind: "literal", value: undefined },
        frame,
        node,
      });
    }
    return undefined;
  };

  readonly #callLiveValue = ({
    node,
    frame,
    callee,
    fn,
    member,
  }: {
    node: CallExpression;
    frame: OrgGraphFrame;
    callee: Node;
    fn: OrgGraphValue;
    member: OrgGraphMemberReference | undefined;
  }): OrgGraphValue => {
    const args = node.arguments.map((argument) =>
      argument.type === "SpreadElement"
        ? this.#fail(
            frame,
            argument,
            "spread call arguments require positional expansion",
          )
        : this.#evaluate(argument, frame),
    );
    const nativePath = this.#nativePathCall({ fn, args, frame, node });
    if (nativePath !== undefined) {
      return nativePath;
    }
    if (
      fn.kind === "external" &&
      fn.module === this.#clientFile &&
      (fn.name === "createDatabase" || fn.name === "createSqlClient")
    ) {
      if (args.some((argument) => this.#containsCallable(argument))) {
        return this.#fail(
          frame,
          node,
          "raw database factory callbacks require an owner model",
        );
      }
      return this.#raw;
    }
    if (
      fn.kind === "external" &&
      this.#nativeMutationExport(fn.module, fn.name)
    ) {
      return this.#nativeMutationCall({ fn, args, frame, node });
    }
    if (
      fn.kind === "external" &&
      fn.module === "better-result" &&
      fn.name === "panic"
    ) {
      return this.#bottom;
    }
    if (
      fn.kind === "external" &&
      fn.module === "better-result" &&
      fn.name === "TaggedError"
    ) {
      return this.#taggedErrorFactoryCall({ args, frame, node });
    }
    const nativeData = this.#nativeDataCall({ fn, args, frame, node });
    if (nativeData !== undefined) {
      return nativeData;
    }
    const validation = this.#valibotCall({ fn, args, frame, node });
    if (validation !== undefined) {
      return validation;
    }
    const objectUtility = this.#objectUtilityCall({ fn, args, frame, node });
    if (objectUtility !== undefined) {
      return objectUtility;
    }
    // Bun type assertions observe argument values without invoking function
    // arguments. Argument expressions above still execute in the graph.
    if (
      this.#alternatives(fn).every(
        (part) =>
          part.kind === "external" &&
          part.module === "bun:test" &&
          (part.name === "expectTypeOf" ||
            part.name.startsWith("<type-assertion>")),
      )
    ) {
      return { kind: "external", module: "bun:test", name: "<type-assertion>" };
    }
    if (
      this.#alternatives(fn).every(
        (part) =>
          part.kind === "external" &&
          part.module === "global" &&
          part.name === "Array.isArray",
      )
    ) {
      return this.#join(
        ...this.#alternatives(
          args.at(0) ?? { kind: "literal", value: undefined },
        ).map((part): OrgGraphValue => {
          if (part.kind === "array") {
            return { kind: "literal", value: true };
          }
          if (
            part.kind === "input" ||
            part.kind === "unknown" ||
            part.kind === "external"
          ) {
            return this.#unknown("array predicate");
          }
          return { kind: "literal", value: false };
        }),
      );
    }
    const scopeGate = this.#alternatives(fn).every(
      (part) =>
        part.kind === "external" &&
        part.module === this.#scopeFile &&
        part.name === "withOrgScope",
    );
    if (this.#alternatives(fn).length > 0 && scopeGate) {
      const options = args.at(0) ?? this.#unknown("missing scope options");
      const result = this.#awaitValue({
        value: this.#callbackCall({
          callback: this.#field({
            value: options,
            name: "fn",
            frame,
          }),
          args: [this.#scoped, { kind: "org-scoped-handle" }],
          frame,
          call: node,
        }),
        frame,
        node,
      });
      if (this.#relevant(result)) {
        return this.#fail(
          frame,
          node,
          "scoped callback result exports a transaction capability",
        );
      }
      return result;
    }
    if (callee.type === "MemberExpression") {
      if (member === undefined) {
        return panic("Missing captured member call reference");
      }
      return this.#callLiveMember({
        node,
        frame,
        fn,
        args,
        receiver: member.receiver,
        name: member.name,
      });
    }
    if (
      this.#alternatives(fn).every(
        (part) =>
          part.kind === "external" &&
          part.module === "drizzle-orm" &&
          (part.name === "sql.raw" || part.name === "sql.join"),
      )
    ) {
      return this.#callSqlConstructor({ node, frame, args });
    }
    return this.#invoke({ fn, args, caller: frame, call: node });
  };

  readonly #callLiveMember = ({
    node,
    frame,
    receiver,
    name,
    fn,
    args,
  }: {
    node: CallExpression;
    frame: OrgGraphFrame;
    receiver: OrgGraphValue | undefined;
    name: string | undefined;
    fn: OrgGraphValue;
    args: readonly OrgGraphValue[];
  }): OrgGraphValue => {
    if (receiver === undefined) {
      return this.#fail(
        frame,
        node,
        "import.meta data cannot serve as a member call receiver",
      );
    }
    if (name === undefined) {
      if (
        this.#alternatives(receiver).some((part) =>
          this.#nativeExternalIdentity(part),
        )
      ) {
        return this.#fail(
          frame,
          node,
          "dynamic native member call requires a model",
        );
      }
      if (this.#alternatives(receiver).some((part) => part.kind === "set")) {
        return this.#fail(frame, node, "dynamic native Set method");
      }
      if (
        this.#relevant(receiver) ||
        this.#containsCallable(receiver) ||
        args.some(
          (argument) =>
            this.#relevant(argument) || this.#containsCallable(argument),
        )
      ) {
        this.#fail(frame, node, "dynamic transaction/delegate member");
      }
      return this.#unknown("dynamic member call");
    }
    const stringResult = this.#callNativeString({
      receiver,
      name,
      args,
      frame,
      node,
    });
    if (stringResult !== undefined) {
      return stringResult;
    }
    const arrays = this.#alternatives(receiver);
    if (arrays.length > 0 && arrays.every((part) => part.kind === "set")) {
      return this.#callSetMethod({ receiver, name, args, frame, node });
    }
    const arrayValues = arrays.filter(
      (part): part is OrgGraphArrayValue => part.kind === "array",
    );
    const arrayResult =
      arrayValues.length === arrays.length
        ? this.#callLiveArrayMember({
            arrays: arrayValues,
            name,
            args,
            frame,
            node,
          })
        : undefined;
    if (arrayResult !== undefined) {
      return arrayResult;
    }
    const transactionResult = this.#callLiveTransactionMember({
      name,
      receiver,
      fn,
      args,
      frame,
      node,
    });
    if (transactionResult !== undefined) {
      return transactionResult;
    }
    const collectionResult = this.#callLiveArrayCallback({
      name,
      receiver,
      args,
      frame,
      node,
    });
    if (collectionResult !== undefined) {
      return collectionResult;
    }
    if (
      this.#alternatives(fn).every(
        (part) =>
          part.kind === "external" &&
          part.module === "drizzle-orm" &&
          (part.name === "sql.raw" || part.name === "sql.join"),
      )
    ) {
      return this.#callSqlConstructor({ node, frame, args });
    }
    return this.#invoke({ fn, args, caller: frame, call: node, receiver });
  };

  readonly #callLiveTransactionMember = ({
    name,
    receiver,
    fn,
    args,
    frame,
    node,
  }: {
    name: string;
    receiver: OrgGraphValue;
    fn: OrgGraphValue;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (
      ORG_WRITE_METHODS.has(name) &&
      this.#alternatives(receiver).every((part) => part.kind === "object") &&
      this.#alternatives(fn).length > 0 &&
      this.#alternatives(fn).every((part) => part.kind === "function")
    ) {
      return this.#invoke({ fn, args, caller: frame, call: node, receiver });
    }
    if (ORG_WRITE_METHODS.has(name)) {
      const target = args.at(0) ?? this.#unknown("missing mutation target");
      this.#recordWrite({
        call: node,
        frame,
        receiver,
        target,
        operation: name,
      });
      return { kind: "query", receiver };
    }
    if (name === "execute") {
      const targets = this.#sqlTargets({
        value: args.at(0) ?? this.#unknown("missing SQL"),
        frame,
        node,
      });
      this.#recordWrite({
        call: node,
        frame,
        receiver,
        target: targets,
        operation: name,
      });
      return this.#unknown("SQL result");
    }
    const transactionReceivers = this.#alternatives(receiver).filter(
      (part) => part.kind === "tx",
    );
    if (
      name === "transaction" &&
      this.#alternatives(receiver).some(
        (part) =>
          part.kind === "tx" ||
          part.kind === "unknown" ||
          part.kind === "input",
      )
    ) {
      const inherited = this.#alternatives(receiver).map((part) => {
        if (part.kind === "tx") {
          return part;
        }
        if (part.kind === "unknown" || part.kind === "input") {
          return this.#raw;
        }
        return this.#fail(
          frame,
          node,
          "partially unresolved transaction receiver",
        );
      });
      return this.#callbackCall({
        callback: args.at(0) ?? this.#unknown("missing transaction callback"),
        args: [this.#join(...inherited)],
        frame,
        call: node,
      });
    }
    if (
      this.#alternatives(receiver).every((part) => part.kind === "query") &&
      this.#alternatives(receiver).length > 0
    ) {
      // Query-builder chaining neither changes the transaction nor invokes
      // callbacks except explicit function values, which are rejected here.
      if (
        args.some((argument) =>
          this.#alternatives(argument).some((part) => part.kind === "function"),
        )
      ) {
        this.#fail(frame, node, "query-builder callback requires semantics");
      }
      return receiver;
    }
    if (
      (name === "select" ||
        name === "selectDistinct" ||
        name === "selectDistinctOn") &&
      transactionReceivers.length > 0
    ) {
      return { kind: "query", receiver };
    }
    if (
      transactionReceivers.length > 0 ||
      this.#alternatives(receiver).some((part) => part.kind === "method")
    ) {
      this.#fail(frame, node, `unsupported transaction method ${name}`);
    }
    return undefined;
  };

  readonly #callLiveArrayCallback = ({
    name,
    receiver,
    args,
    frame,
    node,
  }: {
    name: string;
    receiver: OrgGraphValue;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    const alternatives = this.#alternatives(receiver);
    if (
      alternatives.length === 0 ||
      !alternatives.every((part) => part.kind === "array")
    ) {
      return undefined;
    }
    const callback = args.at(0);
    if (
      callback !== undefined &&
      this.#alternatives(callback).some((part) => part.kind === "function")
    ) {
      const items = this.#alternatives(receiver).flatMap((part) =>
        part.kind === "array"
          ? part.values
          : [this.#unknown("collection item")],
      );
      const exact = receiver.kind === "array" && receiver.stability === "fixed";
      const results: OrgGraphValue[] = [];
      for (const [index, item] of items.entries()) {
        const result = this.#callbackCall({
          callback,
          args: [
            item,
            exact ? { kind: "literal", value: index } : { kind: "input" },
            receiver,
          ],
          frame,
          call: node,
        });
        results.push(result);
        const truth = this.#truth(result);
        if (
          exact &&
          (((name === "find" || name === "some") && truth === true) ||
            (name === "every" && truth === false))
        ) {
          break;
        }
      }
      if (name === "forEach") {
        return { kind: "literal", value: undefined };
      }
      if (name === "map") {
        return {
          kind: "array",
          extent: this.#arrayReceiverExtent(receiver),
          stability: exact ? "fixed" : "mutable",
          values: results,
        };
      }
      if (name === "flatMap") {
        return {
          kind: "array",
          extent: { type: "unknown" },
          stability: "mutable",
          values: results.flatMap((result) =>
            this.#alternatives(result).flatMap((part) =>
              part.kind === "array" ? part.values : [part],
            ),
          ),
        };
      }
      const possible = items.filter(
        (_, index) =>
          this.#truth(results.at(index) ?? this.#bottom) !== false &&
          index < results.length,
      );
      if (name === "filter") {
        return {
          kind: "array",
          extent: this.#arrayReceiverExtent(receiver),
          stability:
            exact &&
            results.every((result) => this.#truth(result) !== undefined)
              ? "fixed"
              : "mutable",
          values: possible,
        };
      }
      if (name === "find") {
        return this.#join(
          ...possible,
          exact && results.some((result) => this.#truth(result) === true)
            ? this.#bottom
            : { kind: "literal", value: undefined },
        );
      }
      if (
        exact &&
        results.every((result) => this.#truth(result) !== undefined)
      ) {
        return {
          kind: "literal",
          value:
            name === "some"
              ? results.some((result) => this.#truth(result) === true)
              : results.every((result) => this.#truth(result) === true),
        };
      }
      return { kind: "input" };
    }
    return undefined;
  };

  readonly #joinArrayValue = ({
    array,
    separator,
    frame,
    node,
  }: {
    array: OrgGraphArrayValue;
    separator: OrgGraphValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    for (const value of [separator, ...array.values]) {
      if (this.#relevant(value) || this.#containsCallable(value)) {
        return this.#fail(
          frame,
          node,
          "array join cannot coerce a transaction capability or callable",
        );
      }
      const alternatives = this.#alternatives(value);
      if (
        alternatives.length === 0 ||
        alternatives.some(
          (part) => part.kind !== "literal" && part.kind !== "input",
        )
      ) {
        return this.#fail(
          frame,
          node,
          "array join requires primitive or opaque data coercion",
        );
      }
    }
    if (
      array.stability === "fixed" &&
      separator.kind === "literal" &&
      array.values.every((part) => part.kind === "literal")
    ) {
      const values = array.values.map((part) => part.value);
      return {
        kind: "literal",
        value: values.join(
          separator.value === undefined ? undefined : String(separator.value),
        ),
      };
    }
    return { kind: "input" };
  };

  readonly #sortedArrayValue = ({
    array,
    comparator,
    frame,
    node,
  }: {
    array: OrgGraphArrayValue;
    comparator: OrgGraphValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    // Native sorting copies the source after arguments run, before comparisons.
    const snapshot = { ...array, values: [...array.values] };
    const comparators = this.#alternatives(comparator);
    if (comparators.length === 0) {
      return this.#fail(
        frame,
        node,
        "native array toSorted comparator requires an owner model",
      );
    }
    return this.#join(
      ...comparators.map((callback): OrgGraphValue => {
        if (callback.kind === "literal" && callback.value === undefined) {
          return this.#defaultSortedArrayValue({
            array: snapshot,
            frame,
            node,
          });
        }
        if (
          callback.kind !== "function" ||
          callback.node.async ||
          (callback.node.type !== "ArrowFunctionExpression" &&
            callback.node.generator)
        ) {
          return this.#fail(
            frame,
            node,
            "native array toSorted comparator requires an owner model",
          );
        }
        const defined = snapshot.values.flatMap((value) =>
          this.#alternatives(value).filter(
            (part) => part.kind !== "literal" || part.value !== undefined,
          ),
        );
        const singleton =
          snapshot.extent.type === "finite" && snapshot.extent.maximum <= 1;
        if (
          !singleton &&
          !(snapshot.stability === "fixed" && defined.length <= 1)
        ) {
          for (const left of defined) {
            for (const right of defined) {
              if (++this.#loopSteps > ORG_GRAPH_FINITE_WORK_BUDGET) {
                return this.#fail(
                  frame,
                  node,
                  "finite iteration exceeds supported work limit",
                );
              }
              const returned = this.#callbackCall({
                callback,
                args: [left, right],
                frame: { ...frame, executionMode: "array-sort" },
                call: node,
              });
              this.#assertOperatorCoercionIsPrimitive({
                values: [returned],
                frame,
                node,
              });
            }
          }
        }
        const fixedSingleton =
          snapshot.stability === "fixed" &&
          defined.length <= 1 &&
          snapshot.values.every((value) => value.kind !== "union");
        return {
          kind: "array",
          extent: snapshot.extent,
          stability: fixedSingleton ? "fixed" : "mutable",
          values: fixedSingleton
            ? [
                ...defined,
                ...snapshot.values.filter(
                  (value) =>
                    value.kind === "literal" && value.value === undefined,
                ),
              ]
            : [...snapshot.values],
        };
      }),
    );
  };

  readonly #defaultSortedArrayValue = ({
    array,
    frame,
    node,
  }: {
    array: OrgGraphArrayValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    // No comparison/coercion occurs for a fixed empty or singleton array.
    if (array.stability === "fixed" && array.values.length <= 1) {
      return {
        kind: "array",
        extent: array.extent,
        stability: "fixed",
        values: [...array.values],
      };
    }
    for (const value of array.values) {
      if (this.#relevant(value) || this.#containsCallable(value)) {
        return this.#fail(
          frame,
          node,
          "array sorting cannot coerce a transaction capability or callable",
        );
      }
      const alternatives = this.#alternatives(value);
      if (
        alternatives.length === 0 ||
        alternatives.some(
          (part) => part.kind !== "literal" && part.kind !== "input",
        )
      ) {
        return this.#fail(
          frame,
          node,
          "array sorting requires primitive or opaque data coercion",
        );
      }
    }
    if (
      array.stability === "fixed" &&
      array.values.every((part) => part.kind === "literal")
    ) {
      const values = array.values
        .map((part) => part.value)
        .toSorted((left, right) => {
          if (left === undefined) {
            return right === undefined ? 0 : 1;
          }
          if (right === undefined) {
            return -1;
          }
          const leftText = String(left);
          const rightText = String(right);
          if (leftText < rightText) {
            return -1;
          }
          if (leftText > rightText) {
            return 1;
          }
          return 0;
        });
      return {
        kind: "array",
        extent: array.extent,
        stability: "fixed",
        values: values.map((value) => ({ kind: "literal", value })),
      };
    }
    // Preserve every actual value; uncertain ordering cannot prove an index.
    return {
      kind: "array",
      extent: array.extent,
      stability: "mutable",
      values: [...array.values],
    };
  };

  // ECMAScript GetSubstitution scans code units and never rescans inserted text.
  // https://tc39.es/ecma262/multipage/text-processing.html#sec-getsubstitution
  readonly #getNativeStringSubstitution = (
    template: string,
    nativeArgs: readonly unknown[],
  ): string => {
    const matched = nativeArgs.at(0);
    const last = nativeArgs.at(-1);
    let namedCaptures: Map<string, string | undefined> | undefined;
    if (typeof last === "object" && last !== null) {
      if (Object.getPrototypeOf(last) !== null) {
        return panic("Malformed native replacement named captures");
      }
      namedCaptures = new Map<string, string | undefined>();
      for (const key of Reflect.ownKeys(last)) {
        const descriptor = Object.getOwnPropertyDescriptor(last, key);
        if (
          typeof key !== "string" ||
          descriptor === undefined ||
          !("value" in descriptor)
        ) {
          return panic("Malformed native replacement named capture descriptor");
        }
        const capture: unknown = descriptor.value;
        if (capture !== undefined && typeof capture !== "string") {
          return panic("Malformed native replacement named capture value");
        }
        namedCaptures.set(key, capture);
      }
    }
    const subjectIndex =
      nativeArgs.length - (namedCaptures === undefined ? 1 : 2);
    const positionIndex = subjectIndex - 1;
    const subject = nativeArgs.at(subjectIndex);
    const position = nativeArgs.at(positionIndex);
    if (
      nativeArgs.length < 3 ||
      typeof matched !== "string" ||
      typeof subject !== "string" ||
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 0 ||
      position > subject.length ||
      positionIndex < 1
    ) {
      return panic("Malformed native string replacement callback arguments");
    }
    const captures: (string | undefined)[] = [];
    for (const capture of nativeArgs.slice(1, positionIndex)) {
      if (capture !== undefined && typeof capture !== "string") {
        return panic("Malformed native replacement capture value");
      }
      captures.push(capture);
    }
    const pieces: string[] = [];
    let index = 0;
    while (index < template.length) {
      const current = template.charAt(index);
      if (current !== "$") {
        pieces.push(current);
        index += 1;
        continue;
      }
      const next = template.charAt(index + 1);
      switch (next) {
        case "$":
          pieces.push("$");
          index += 2;
          continue;
        case "&":
          pieces.push(matched);
          index += 2;
          continue;
        case "`":
          pieces.push(subject.slice(0, position));
          index += 2;
          continue;
        case "'":
          pieces.push(
            subject.slice(Math.min(position + matched.length, subject.length)),
          );
          index += 2;
          continue;
        case "<": {
          const close = template.indexOf(">", index + 2);
          if (namedCaptures === undefined || close === -1) {
            // Only "$<" is literal here; later tokens still need expansion.
            pieces.push("$<");
            index += 2;
            continue;
          }
          pieces.push(
            namedCaptures.get(template.slice(index + 2, close)) ?? "",
          );
          index = close + 1;
          continue;
        }
        default:
          break;
      }
      if (next >= "0" && next <= "9") {
        const second = template.charAt(index + 2);
        let digitCount = second >= "0" && second <= "9" ? 2 : 1;
        let captureIndex = Number(
          template.slice(index + 1, index + 1 + digitCount),
        );
        if (captureIndex > captures.length && digitCount === 2) {
          digitCount = 1;
          captureIndex = Number(next);
        }
        pieces.push(
          captureIndex >= 1 && captureIndex <= captures.length
            ? (captures.at(captureIndex - 1) ?? "")
            : template.slice(index, index + 1 + digitCount),
        );
        index += 1 + digitCount;
        continue;
      }
      pieces.push("$");
      index += 1;
    }
    return pieces.join("");
  };

  readonly #nativeReplacementArguments = (
    nativeArgs: readonly unknown[],
  ): OrgGraphValue[] => {
    const args: OrgGraphValue[] = [];
    for (const [index, value] of nativeArgs.entries()) {
      if (
        value === undefined ||
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        args.push({ kind: "literal", value });
        continue;
      }
      if (
        index === nativeArgs.length - 1 &&
        typeof value === "object" &&
        value !== null
      ) {
        const fields = new Map<string, OrgGraphValue>();
        for (const [key, field] of Object.entries(value)) {
          if (field !== undefined && typeof field !== "string") {
            return panic("Malformed native replacement named capture value");
          }
          fields.set(key, { kind: "literal", value: field });
        }
        args.push({
          kind: "object",
          prototypeDisposition: "ordinary",
          fields,
          unknownFields: this.#bottom,
          keyStability: "fixed",
          propertyPresence: "closed",
        });
        continue;
      }
      return panic("Malformed native replacement callback argument");
    }
    return args;
  };

  readonly #nativeReplacementResult = ({
    value,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    frame: OrgGraphFrame;
    node: CallExpression;
  }): { literal: string } | { dynamic: true } => {
    const parts = this.#alternatives(value);
    if (parts.length === 0) {
      return { literal: "undefined" };
    }
    let literal: string | undefined;
    let dynamic = false;
    for (const part of parts) {
      if (part.kind === "input") {
        dynamic = true;
        continue;
      }
      if (part.kind !== "literal") {
        return this.#fail(
          frame,
          node,
          "native string replacement callback result requires primitive data",
        );
      }
      const string = String(part.value);
      if (literal !== undefined && literal !== string) {
        dynamic = true;
      }
      literal = string;
    }
    return dynamic ? { dynamic: true } : { literal: literal ?? "undefined" };
  };

  readonly #callNativeString = ({
    receiver,
    name,
    args,
    frame,
    node,
  }: {
    receiver: OrgGraphValue;
    name: string;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (
      name !== "replace" &&
      name !== "toLowerCase" &&
      name !== "toUpperCase" &&
      name !== "slice" &&
      name !== "trim" &&
      name !== "split" &&
      name !== "indexOf"
    ) {
      return undefined;
    }
    const parts = this.#alternatives(receiver);
    if (
      !parts.some(
        (part) =>
          (part.kind === "literal" && typeof part.value === "string") ||
          (part.kind === "input" && part.primitive === "string"),
      )
    ) {
      return undefined;
    }
    const result: OrgGraphValue[] = [];
    for (const part of parts) {
      const literal =
        part.kind === "literal" && typeof part.value === "string"
          ? part.value
          : undefined;
      if (
        literal === undefined &&
        !(part.kind === "input" && part.primitive === "string")
      ) {
        return this.#fail(
          frame,
          node,
          `native string method requires a proven string receiver (source: ${this.#signature(
            {
              value: receiver,
            },
          )})`,
        );
      }
      result.push(
        this.#callNativeStringPart({ literal, name, args, frame, node }),
      );
    }
    return this.#join(...result);
  };

  readonly #callNativeStringPart = ({
    literal,
    name,
    args,
    frame,
    node,
  }: {
    literal: string | undefined;
    name: OrgGraphNativeStringMethod;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    if (name === "indexOf") {
      const search = args.at(0);
      const position = args.at(1);
      if (
        args.length === 0 ||
        args.length > 2 ||
        search?.kind !== "literal" ||
        typeof search.value !== "string" ||
        (position !== undefined &&
          (position.kind !== "literal" ||
            (position.value !== undefined &&
              typeof position.value !== "number")))
      ) {
        return this.#fail(
          frame,
          node,
          "native string indexOf requires a literal string search and an optional literal numeric position",
        );
      }
      if (literal === undefined) {
        return { kind: "input" };
      }
      const start =
        position?.kind === "literal" && typeof position.value === "number"
          ? position.value
          : 0;
      return {
        kind: "literal",
        value: literal.indexOf(search.value, start),
      };
    }
    if (name === "toLowerCase" || name === "toUpperCase") {
      if (args.length !== 0) {
        return this.#fail(frame, node, `native ${name} requires no arguments`);
      }
      if (literal === undefined) {
        return { kind: "input", primitive: "string" };
      }
      return {
        kind: "literal",
        value:
          name === "toLowerCase"
            ? literal.toLowerCase()
            : literal.toUpperCase(),
      };
    }
    if (name === "slice") {
      if (args.length > 2) {
        return this.#fail(
          frame,
          node,
          "native string slice accepts at most two indexes",
        );
      }
      const indexes: (number | undefined)[] = [];
      let dynamicIndex = false;
      for (const argument of args) {
        this.#assertOperatorCoercionIsPrimitive({
          values: [argument],
          frame,
          node,
        });
        const parts = this.#alternatives(argument);
        const sole = parts.at(0);
        if (parts.length === 1 && sole?.kind === "literal") {
          const value = sole.value;
          indexes.push(value === undefined ? undefined : Number(value));
          continue;
        }
        if (
          parts.length > 0 &&
          parts.every(
            (part) => part.kind === "literal" || part.kind === "input",
          )
        ) {
          dynamicIndex = true;
          continue;
        }
        return this.#fail(
          frame,
          node,
          "native string slice requires primitive or input data indexes",
        );
      }
      return literal === undefined || dynamicIndex
        ? { kind: "input", primitive: "string" }
        : {
            kind: "literal",
            value: literal.slice(indexes.at(0), indexes.at(1)),
          };
    }
    if (name === "trim") {
      if (args.length !== 0) {
        return this.#fail(frame, node, "native trim requires no arguments");
      }
      return literal === undefined
        ? { kind: "input", primitive: "string" }
        : { kind: "literal", value: literal.trim() };
    }
    if (name === "split") {
      return this.#callNativeStringSplit({ literal, args, frame, node });
    }
    if (name === "replace") {
      return this.#callNativeStringReplacement({ literal, args, frame, node });
    }
    name satisfies never;
    return panic("Unknown native string method");
  };

  readonly #callNativeStringSplit = ({
    literal,
    args,
    frame,
    node,
  }: {
    literal: string | undefined;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    if (
      args.some(
        (argument) =>
          this.#relevant(argument) || this.#containsCallable(argument),
      )
    ) {
      return this.#fail(
        frame,
        node,
        "native string split cannot discard a callable or transaction",
      );
    }
    if (args.length > 2) {
      return this.#fail(
        frame,
        node,
        "native string split accepts at most two arguments",
      );
    }
    const pattern =
      args.at(0) ??
      ({ kind: "literal", value: undefined } satisfies OrgGraphValue);
    let separator: string | RegExp | undefined;
    if (
      pattern.kind === "literal" &&
      (typeof pattern.value === "string" || pattern.value === undefined)
    ) {
      separator = pattern.value;
    } else if (
      pattern.kind === "external" &&
      pattern.module === "global" &&
      pattern.name === "RegExp.literal" &&
      pattern.regexp !== undefined
    ) {
      separator = pattern.regexp;
    } else {
      return this.#fail(
        frame,
        node,
        "native string split requires a literal string, native RegExp, or undefined separator",
      );
    }
    const limit =
      args.at(1) ??
      ({ kind: "literal", value: undefined } satisfies OrgGraphValue);
    if (
      limit.kind !== "literal" ||
      (limit.value !== undefined && typeof limit.value !== "number")
    ) {
      return this.#fail(
        frame,
        node,
        "native string split requires a literal numeric limit",
      );
    }
    // Split uses ToUint32, including wraparound and nonfinite numeric limits.
    if (limit.value !== undefined && this.#toUint32(limit.value) === 0) {
      return {
        kind: "array",
        extent: { type: "finite", maximum: 0 },
        stability: "fixed",
        values: [],
      };
    }
    if (separator === undefined) {
      return {
        kind: "array",
        extent: { type: "finite", maximum: 1 },
        stability: "fixed",
        values: [
          literal === undefined
            ? { kind: "input", primitive: "string" }
            : { kind: "literal", value: literal },
        ],
      };
    }
    if (literal !== undefined) {
      // RegExp @@split clones its matching state; the original lastIndex is not read or changed.
      const values = literal.split(separator, limit.value);
      if (values.length > 128) {
        return this.#fail(
          frame,
          node,
          "native string split exceeds its supported finite domain",
        );
      }
      return {
        kind: "array",
        extent: { type: "finite", maximum: values.length },
        stability: "fixed",
        values: values.map((value) => ({ kind: "literal", value })),
      };
    }
    return {
      kind: "array",
      extent: { type: "unknown" },
      stability: "mutable",
      values:
        separator instanceof RegExp
          ? [
              { kind: "input", primitive: "string" },
              { kind: "literal", value: undefined },
            ]
          : [{ kind: "input", primitive: "string" }],
    };
  };

  readonly #callNativeStringReplacement = ({
    literal,
    args,
    frame,
    node,
  }: {
    literal: string | undefined;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    const pattern =
      args.at(0) ?? this.#unknown("missing native replacement pattern");
    const replacement =
      args.at(1) ?? this.#unknown("missing native replacement value");
    let search: string | RegExp | undefined;
    if (pattern.kind === "literal" && typeof pattern.value === "string") {
      search = pattern.value;
    } else if (
      pattern.kind === "external" &&
      pattern.module === "global" &&
      pattern.name === "RegExp.literal"
    ) {
      search = pattern.regexp;
    }
    if (args.length !== 2 || search === undefined) {
      return this.#fail(
        frame,
        node,
        "native string replacement requires a literal RegExp and string replacement (or literal string search)",
      );
    }
    if (search instanceof RegExp && search.sticky && !search.global) {
      return this.#fail(
        frame,
        node,
        "sticky non-global RegExp replacement requires a state model",
      );
    }
    if (this.#relevant(pattern) || this.#containsCallable(pattern)) {
      return this.#fail(
        frame,
        node,
        "native string replacement cannot discard a callable or transaction",
      );
    }
    const replacementParts = this.#alternatives(replacement);
    const callbacks = replacementParts.filter(
      (candidate): candidate is Extract<OrgGraphValue, { kind: "function" }> =>
        candidate.kind === "function",
    );
    if (callbacks.length > 0) {
      if (callbacks.length !== replacementParts.length) {
        return this.#fail(
          frame,
          node,
          "native string replacement callback is unresolved",
        );
      }
      return this.#callNativeStringReplacementCallback({
        literal,
        search,
        replacement,
        callbacks,
        frame,
        node,
      });
    }
    if (this.#relevant(replacement) || this.#containsCallable(replacement)) {
      return this.#fail(
        frame,
        node,
        "native string replacement cannot discard a callable or transaction",
      );
    }
    if (
      replacementParts.some(
        (candidate) =>
          candidate.kind !== "literal" || typeof candidate.value !== "string",
      )
    ) {
      return this.#fail(
        frame,
        node,
        "native string replacement requires a literal RegExp and string replacement (or literal string search)",
      );
    }
    const templates = replacementParts.map((candidate) =>
      candidate.kind === "literal" && typeof candidate.value === "string"
        ? candidate.value
        : panic("Validated string replacement changed shape"),
    );
    const template = templates.at(0) ?? panic("Missing string replacement");
    if (templates.some((candidate) => candidate !== template)) {
      return { kind: "input", primitive: "string" };
    }
    return literal === undefined
      ? { kind: "input", primitive: "string" }
      : {
          kind: "literal",
          value: literal.replace(search, (...nativeArgs: unknown[]) =>
            this.#getNativeStringSubstitution(template, nativeArgs),
          ),
        };
  };

  readonly #callNativeStringReplacementCallback = ({
    literal,
    search,
    replacement,
    callbacks,
    frame,
    node,
  }: {
    literal: string | undefined;
    search: string | RegExp;
    replacement: OrgGraphValue;
    callbacks: readonly Extract<OrgGraphValue, { kind: "function" }>[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue => {
    if (literal === undefined) {
      const arity = Math.max(
        ...callbacks.map((callback) => callback.node.params.length),
      );
      const callbackArgs = Array.from({ length: arity }, (_, index) =>
        index === 0
          ? ({ kind: "input", primitive: "string" } satisfies OrgGraphValue)
          : ({ kind: "input" } satisfies OrgGraphValue),
      );
      const returned = this.#callbackCall({
        callback: replacement,
        args: callbackArgs,
        frame,
        call: node,
      });
      this.#nativeReplacementResult({ value: returned, frame, node });
      return { kind: "input", primitive: "string" };
    }
    let dynamicResult = false;
    const replaced = literal.replace(search, (...nativeArgs: unknown[]) => {
      const returned = this.#callbackCall({
        callback: replacement,
        args: this.#nativeReplacementArguments(nativeArgs),
        frame,
        call: node,
      });
      const converted = this.#nativeReplacementResult({
        value: returned,
        frame,
        node,
      });
      if ("dynamic" in converted) {
        dynamicResult = true;
        return "";
      }
      return converted.literal;
    });
    return dynamicResult
      ? { kind: "input", primitive: "string" }
      : { kind: "literal", value: replaced };
  };

  readonly #callLiveArrayMember = ({
    arrays,
    name,
    args,
    frame,
    node,
  }: {
    arrays: readonly OrgGraphArrayValue[];
    name: string;
    args: readonly OrgGraphValue[];
    frame: OrgGraphFrame;
    node: CallExpression;
  }): OrgGraphValue | undefined => {
    if (arrays.length === 0) {
      return undefined;
    }
    if (name === "toSorted") {
      if (args.length > 1) {
        return this.#fail(
          frame,
          node,
          "native array toSorted requires a modeled argument shape",
        );
      }
      return this.#join(
        ...arrays.map((array) =>
          this.#sortedArrayValue({
            array,
            comparator: args.at(0) ?? { kind: "literal", value: undefined },
            frame,
            node,
          }),
        ),
      );
    }
    if (name === "join") {
      const separator =
        args.at(0) ??
        ({ kind: "literal", value: undefined } satisfies OrgGraphValue);
      return this.#join(
        ...arrays.map((array) =>
          this.#joinArrayValue({ array, separator, frame, node }),
        ),
      );
    }

    let offsets: readonly OrgGraphValue[] = [];
    if (name === "splice") {
      offsets = args.slice(0, 2);
    } else if (name === "at") {
      offsets = args.slice(0, 1);
    } else if (name === "includes") {
      offsets = args.slice(1, 2);
    }
    if (
      offsets.some(
        (value) => this.#relevant(value) || this.#containsCallable(value),
      )
    ) {
      return this.#fail(
        frame,
        node,
        "array offset can invoke a callable or carry a transaction",
      );
    }
    const result: OrgGraphValue[] = [];
    for (const array of arrays) {
      if (name === "push" || name === "unshift" || name === "splice") {
        array.stability = "mutable";
        array.extent = { type: "unknown" };
        const inserted = name === "splice" ? args.slice(2) : args;
        if (inserted.some((value) => this.#containsScopedCapability(value))) {
          return this.#fail(
            frame,
            node,
            "scoped capability cannot enter a mutable container",
          );
        }
        for (const item of inserted) {
          const signature = this.#signature({
            value: item,
          });
          if (
            !array.values.some(
              (existing) =>
                this.#signature({
                  value: existing,
                }) === signature,
            )
          ) {
            array.values.push(item);
          }
          if (array.values.length > 128) {
            return this.#fail(
              frame,
              node,
              "abstract mutable array exceeds its finite domain",
            );
          }
        }
        result.push(name === "splice" ? array : { kind: "input" });
      } else if (name === "pop" || name === "shift") {
        // Read the endpoint before invalidating the original fixed extent.
        const removed = this.#arrayElementValue({
          array,
          index: { kind: "literal", value: name === "pop" ? -1 : 0 },
        });
        array.stability = "mutable";
        array.extent = { type: "unknown" };
        // Keep possible aliases: another branch may not have removed the value.
        result.push(removed);
      } else if (name === "includes") {
        const search = args.at(0) ?? { kind: "literal", value: undefined };
        const offset = args.at(1) ?? { kind: "literal", value: 0 };
        if (
          array.stability === "fixed" &&
          search.kind === "literal" &&
          offset.kind === "literal" &&
          typeof offset.value === "number" &&
          array.values.every((item) => item.kind === "literal")
        ) {
          const values = array.values.map((item) => item.value);
          result.push({
            kind: "literal",
            value: values.includes(search.value, offset.value),
          });
        } else {
          result.push({ kind: "input" });
        }
      } else if (name === "at") {
        result.push(
          this.#arrayElementValue({
            array,
            index: args.at(0) ?? { kind: "literal", value: 0 },
          }),
        );
      }
    }
    if (result.length > 0) {
      return this.#join(...result);
    }
    return undefined;
  };

  readonly #callSqlConstructor = ({
    node,
    frame,
    args,
  }: OrgGraphSqlConstructorOptions): OrgGraphValue => {
    const argument = args.at(0);
    if (argument?.kind === "literal" && typeof argument.value === "string") {
      return {
        kind: "sql",
        text: argument.value,
        targets: new Map(),
        unresolved: false,
      };
    }
    if (argument?.kind === "array") {
      const targets = new Map<string, OrgGraphValue>();
      let unresolved = false;
      const text = argument.values
        .map((part) => {
          if (part.kind !== "sql") {
            this.#fail(frame, node, "sql.join contains unresolved syntax");
          }
          unresolved ||= part.unresolved;
          for (const [token, target] of part.targets) {
            if (targets.has(token)) {
              this.#fail(frame, node, "SQL token collision in sql.join");
            }
            targets.set(token, target);
          }
          return part.text;
        })
        .join(" ");
      return { kind: "sql", text, targets, unresolved };
    }
    return this.#fail(frame, node, "dynamic SQL constructor");
  };

  readonly #evaluate = (
    node: Node | null | undefined,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const value = this.#evaluateValue(node, frame);
    return node === null || node === undefined
      ? value
      : this.#ownValue(value, { frame, node, role: "expression" });
  };

  readonly #evaluateValue = (
    node: Node | null | undefined,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    if (node === undefined || node === null) {
      return { kind: "literal", value: undefined };
    }
    if (this.#isFunctionNode(node)) {
      return this.#functionValue(node, frame);
    }
    if (isOrgGraphReferenceExpression(node)) {
      return this.#evaluateReference(node, frame);
    }
    if (isOrgGraphContainerExpression(node)) {
      return this.#evaluateContainer(node, frame);
    }
    if (isOrgGraphOperatorExpression(node)) {
      return this.#evaluateOperator(node, frame);
    }
    return this.#evaluateOther(node, frame);
  };

  readonly #graphAccessName = (access: MemberExpression): string | undefined =>
    accessName(access) ??
    (access.computed &&
    access.property.type === "Literal" &&
    typeof access.property.value === "number"
      ? String(access.property.value)
      : undefined);

  readonly #memberReference = (
    node: Extract<Node, { type: "MemberExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphMemberReference => {
    const name = this.#graphAccessName(node);
    if (
      node.object.type === "MetaProperty" &&
      node.object.meta.name === "import" &&
      node.object.property.name === "meta" &&
      name !== undefined &&
      ["dir", "dirname", "file", "filename", "url"].includes(name)
    ) {
      return { receiver: undefined, name, value: { kind: "input" } };
    }
    const alternatives = this.#alternatives(this.#evaluate(node.object, frame));
    const shortCircuited = alternatives.some(
      (part) =>
        part.kind === "chain-short-circuit" ||
        (node.optional &&
          part.kind === "literal" &&
          (part.value === null || part.value === undefined)),
    );
    const receiver = this.#join(
      ...alternatives.filter(
        (part) =>
          part.kind !== "chain-short-circuit" &&
          !(
            node.optional &&
            part.kind === "literal" &&
            (part.value === null || part.value === undefined)
          ),
      ),
    );
    if (receiver.kind === "bottom") {
      return {
        receiver,
        name,
        value: shortCircuited ? { kind: "chain-short-circuit" } : receiver,
      };
    }
    let value: OrgGraphValue;
    if (name === undefined) {
      const key = node.computed
        ? this.#evaluate(node.property, frame)
        : this.#bottom;
      if (node.computed) {
        this.#assertOperatorCoercionIsPrimitive({
          values: [key],
          frame,
          node,
        });
      }
      if (this.#relevant(receiver) || this.#containsCallable(receiver)) {
        return this.#fail(
          frame,
          node,
          "dynamic capability/callback member access",
        );
      }
      value = this.#join(
        ...this.#alternatives(receiver).map((part) => {
          if (part.kind === "array") {
            return this.#join(
              ...this.#alternatives(key).map((index) => {
                if (
                  index.kind !== "literal" ||
                  (typeof index.value !== "number" &&
                    typeof index.value !== "string")
                ) {
                  return this.#unknown("dynamic array property");
                }
                let numeric: number;
                if (typeof index.value === "number") {
                  numeric = index.value;
                } else if (/^(?:0|[1-9]\d*)$/u.test(index.value)) {
                  numeric = Number(index.value);
                } else {
                  numeric = Number.NaN;
                }
                if (
                  !Number.isSafeInteger(numeric) ||
                  numeric < 0 ||
                  numeric >= 4_294_967_295
                ) {
                  return this.#unknown("dynamic array property");
                }
                return this.#arrayElementValue({
                  array: part,
                  index: { kind: "literal", value: numeric },
                });
              }),
            );
          }
          if (part.kind === "input" && part.primitive === undefined) {
            return part;
          }
          return part.kind === "object"
            ? this.#join(part.unknownFields, ...part.fields.values(), {
                kind: "literal",
                value: undefined,
              })
            : this.#unknown("dynamic field");
        }),
      );
    } else {
      value = this.#validatedReadOutput({
        node,
        receiver,
        value: this.#field({
          value: receiver,
          name,
          frame,
        }),
        frame,
      });
    }
    return {
      receiver,
      name,
      value: shortCircuited
        ? this.#join(value, { kind: "chain-short-circuit" })
        : value,
    };
  };

  readonly #memberValue = (
    node: Extract<Node, { type: "MemberExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => this.#memberReference(node, frame).value;

  readonly #nullishValue = ({
    node,
    frame,
    left,
  }: {
    node: Extract<Node, { type: "LogicalExpression" }>;
    frame: OrgGraphFrame;
    left: OrgGraphValue;
  }): OrgGraphValue => {
    const alternatives = this.#alternatives(left);
    const nullable = alternatives.some(
      (part) =>
        part.kind === "unknown" ||
        part.kind === "input" ||
        part.kind === "external" ||
        (part.kind === "literal" &&
          (part.value === null || part.value === undefined)),
    );
    const retained = alternatives.filter(
      (part) =>
        !(
          part.kind === "literal" &&
          (part.value === null || part.value === undefined)
        ),
    );
    return this.#join(
      ...retained,
      nullable || alternatives.length === 0
        ? this.#evaluate(node.right, frame)
        : this.#bottom,
    );
  };

  readonly #nullishLiteral = (
    node: Expression,
    frame: OrgGraphFrame,
  ): { value: null | undefined } | undefined => {
    const value = unwrap(node);
    if (value.type === "Literal" && value.value === null) {
      return { value: null };
    }
    if (
      value.type === "Identifier" &&
      value.name === "undefined" &&
      resolveDeclaration(value, frame.module.parents) === undefined
    ) {
      return { value: undefined };
    }
    return undefined;
  };

  readonly #nullishConditionExclusions = ({
    test,
    binding,
    truth,
    frame,
  }: {
    test: Expression;
    binding: Identifier;
    truth: boolean;
    frame: OrgGraphFrame;
  }): ReadonlySet<null | undefined> => {
    const condition = unwrap(test);
    if (
      condition.type === "LogicalExpression" &&
      ((condition.operator === "||" && !truth) ||
        (condition.operator === "&&" && truth))
    ) {
      return new Set([
        ...this.#nullishConditionExclusions({
          test: condition.left,
          binding,
          truth,
          frame,
        }),
        ...this.#nullishConditionExclusions({
          test: condition.right,
          binding,
          truth,
          frame,
        }),
      ]);
    }
    if (condition.type === "UnaryExpression" && condition.operator === "!") {
      return this.#nullishConditionExclusions({
        test: condition.argument,
        binding,
        truth: !truth,
        frame,
      });
    }
    if (
      condition.type !== "BinaryExpression" ||
      !(
        (condition.operator === "===" && !truth) ||
        (condition.operator === "!==" && truth)
      )
    ) {
      return new Set();
    }
    const left = this.#nullishLiteral(condition.left, frame);
    const right = this.#nullishLiteral(condition.right, frame);
    const literal = left ?? right;
    const reference = unwrap(
      left === undefined ? condition.left : condition.right,
    );
    if (
      literal === undefined ||
      reference.type !== "Identifier" ||
      resolveDeclaration(reference, frame.module.parents) !== binding
    ) {
      return new Set();
    }
    return new Set([literal.value]);
  };

  readonly #pureRecordPredicate = (
    node: Node,
    frame: OrgGraphFrame,
  ): boolean => {
    if (
      node.type !== "ArrowFunctionExpression" ||
      node.async ||
      node.body.type === "BlockStatement" ||
      node.params.length !== 1
    ) {
      return false;
    }
    const parameter = node.params.at(0);
    if (parameter?.type !== "Identifier") {
      return false;
    }
    const parts: Expression[] = [];
    const collect = (expression: Expression): void => {
      const value = unwrap(expression);
      if (value.type === "LogicalExpression" && value.operator === "&&") {
        collect(value.left);
        collect(value.right);
        return;
      }
      parts.push(value);
    };
    collect(node.body);
    if (parts.length !== 3) {
      return false;
    }
    const [typeCheck, nullCheck, arrayCheck] = parts;
    if (
      typeCheck?.type !== "BinaryExpression" ||
      typeCheck.operator !== "===" ||
      nullCheck?.type !== "BinaryExpression" ||
      nullCheck.operator !== "!==" ||
      arrayCheck?.type !== "UnaryExpression" ||
      arrayCheck.operator !== "!"
    ) {
      return false;
    }
    const typeOperand = unwrap(typeCheck.left);
    const typeLiteral = unwrap(typeCheck.right);
    if (
      typeOperand.type !== "UnaryExpression" ||
      typeOperand.operator !== "typeof" ||
      typeLiteral.type !== "Literal" ||
      typeLiteral.value !== "object" ||
      !resolvesToBinding(typeOperand.argument, parameter, frame.module.parents)
    ) {
      return false;
    }
    const nullLeft = unwrap(nullCheck.left);
    const nullRight = unwrap(nullCheck.right);
    if (!(
      resolvesToBinding(nullLeft, parameter, frame.module.parents) &&
      nullRight.type === "Literal" &&
      nullRight.value === null
    )) {
      return false;
    }
    const arrayCall = unwrap(arrayCheck.argument);
    if (
      arrayCall.type !== "CallExpression" ||
      arrayCall.optional ||
      arrayCall.arguments.length !== 1
    ) {
      return false;
    }
    const arrayArgument = arrayCall.arguments.at(0);
    if (
      arrayArgument === undefined ||
      arrayArgument.type === "SpreadElement" ||
      !resolvesToBinding(arrayArgument, parameter, frame.module.parents)
    ) {
      return false;
    }
    const arrayCallee = unwrap(arrayCall.callee);
    if (
      arrayCallee.type !== "MemberExpression" ||
      arrayCallee.computed ||
      arrayCallee.optional ||
      arrayCallee.object.type !== "Identifier" ||
      arrayCallee.object.name !== "Array" ||
      resolveDeclaration(arrayCallee.object, frame.module.parents) !==
        undefined ||
      arrayCallee.property.type !== "Identifier" ||
      arrayCallee.property.name !== "isArray"
    ) {
      return false;
    }
    return true;
  };

  readonly #recordConditionTruth = ({
    test,
    binding,
    frame,
  }: {
    test: Expression;
    binding: Identifier;
    frame: OrgGraphFrame;
  }): boolean | undefined => {
    let condition = unwrap(test);
    let trueMeansRecord = true;
    if (condition.type === "UnaryExpression" && condition.operator === "!") {
      condition = unwrap(condition.argument);
      trueMeansRecord = false;
    }
    if (
      condition.type !== "CallExpression" ||
      condition.optional ||
      condition.arguments.length !== 1
    ) {
      return undefined;
    }
    const argument = condition.arguments.at(0);
    if (
      argument === undefined ||
      argument.type === "SpreadElement" ||
      !resolvesToBinding(argument, binding, frame.module.parents)
    ) {
      return undefined;
    }
    const callee = unwrap(condition.callee);
    if (callee.type !== "Identifier") {
      return undefined;
    }
    const calleeBinding = resolveDeclaration(callee, frame.module.parents);
    const declarator =
      calleeBinding === undefined
        ? undefined
        : frame.module.parents.get(calleeBinding);
    const declaration =
      declarator === undefined
        ? undefined
        : frame.module.parents.get(declarator);
    if (
      declarator?.type !== "VariableDeclarator" ||
      declarator.id !== calleeBinding ||
      declarator.init === null ||
      declaration?.type !== "VariableDeclaration" ||
      declaration.kind !== "const" ||
      !this.#pureRecordPredicate(unwrap(declarator.init), frame)
    ) {
      return undefined;
    }
    return trueMeansRecord;
  };

  readonly #discriminantCondition = ({
    test,
    binding,
    frame,
  }: {
    test: Expression;
    binding: Identifier;
    frame: OrgGraphFrame;
  }): OrgGraphDiscriminantCondition | undefined => {
    const expression = unwrap(test);
    if (
      expression.type !== "BinaryExpression" ||
      (expression.operator !== "===" && expression.operator !== "!==")
    ) {
      return undefined;
    }
    const sides = [unwrap(expression.left), unwrap(expression.right)];
    const member = sides.find(
      (side): side is MemberExpression => side.type === "MemberExpression",
    );
    const literal = sides.find(
      (side): side is Extract<Node, { type: "Literal" }> =>
        side.type === "Literal" &&
        (typeof side.value === "string" ||
          typeof side.value === "number" ||
          typeof side.value === "boolean" ||
          side.value === null),
    );
    if (
      member === undefined ||
      literal === undefined ||
      member.optional ||
      member.object.type !== "Identifier" ||
      resolveDeclaration(member.object, frame.module.parents) !== binding
    ) {
      return undefined;
    }
    const property = accessName(member);
    return property === undefined
      ? undefined
      : {
          property,
          value: literal.value,
          equalsWhenTrue: expression.operator === "===",
        };
  };

  readonly #nearestIteration = ({
    node,
    frame,
  }: {
    node: Node;
    frame: OrgGraphFrame;
  }): Node | undefined => {
    let current: Node | undefined = node;
    let child: Node | undefined;
    while (current !== undefined && !this.#isFunctionNode(current)) {
      if (
        (current.type === "ForOfStatement" ||
          current.type === "ForInStatement" ||
          current.type === "ForStatement" ||
          current.type === "WhileStatement" ||
          current.type === "DoWhileStatement") &&
        current.body === child
      ) {
        return current;
      }
      child = current;
      current = frame.module.parents.get(current);
    }
    return undefined;
  };

  readonly #discriminantFacts = ({
    reference,
    binding,
    frame,
  }: {
    reference: Identifier;
    binding: Identifier;
    frame: OrgGraphFrame;
  }): readonly OrgGraphDiscriminantFact[] => {
    const facts: OrgGraphDiscriminantFact[] = [];
    const exits = ({
      node,
      target,
    }: {
      node: Node | null;
      target: Node | undefined;
    }): boolean => {
      if (node === null) {
        return false;
      }
      if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
        return true;
      }
      if (node.type === "ContinueStatement") {
        return (
          node.label === null &&
          target?.type === "ForOfStatement" &&
          this.#nearestIteration({ node, frame }) === target
        );
      }
      if (node.type === "BlockStatement") {
        const last = node.body
          .toReversed()
          .find((statement) => statement.type !== "EmptyStatement");
        return exits({ node: last ?? null, target });
      }
      return (
        node.type === "IfStatement" &&
        node.alternate !== null &&
        exits({ node: node.consequent, target }) &&
        exits({ node: node.alternate, target })
      );
    };
    const addFact = ({
      source,
      truth,
      excludedBranchTruth,
    }: {
      source: Extract<Node, { type: "IfStatement" }>;
      truth: boolean;
      excludedBranchTruth: boolean;
    }): void => {
      const condition = this.#discriminantCondition({
        test: source.test,
        binding,
        frame,
      });
      if (condition !== undefined) {
        facts.push({
          property: condition.property,
          value: condition.value,
          equals: truth === condition.equalsWhenTrue,
          source,
          excludedBranchTruth,
        });
      }
    };
    const target = this.#nearestIteration({ node: reference, frame });
    let current: Node = reference;
    while (true) {
      const parent = frame.module.parents.get(current);
      if (parent === undefined || this.#isFunctionNode(parent)) {
        break;
      }
      if (parent.type === "IfStatement") {
        let child = reference;
        while (frame.module.parents.get(child) !== parent) {
          const next = frame.module.parents.get(child);
          if (next === undefined) {
            break;
          }
          child = next;
        }
        if (parent.consequent === child) {
          addFact({ source: parent, truth: true, excludedBranchTruth: false });
        } else if (parent.alternate === child) {
          addFact({ source: parent, truth: false, excludedBranchTruth: true });
        }
      }
      if (parent.type === "BlockStatement") {
        const index = parent.body.indexOf(current);
        for (const statement of parent.body.slice(0, Math.max(index, 0))) {
          if (statement.type !== "IfStatement") {
            continue;
          }
          const yes = exits({ node: statement.consequent, target });
          const no = exits({ node: statement.alternate, target });
          if (yes !== no) {
            addFact({
              source: statement,
              truth: !yes,
              excludedBranchTruth: yes,
            });
          }
        }
      }
      current = parent;
    }
    return facts;
  };

  readonly #containsBindingReference = ({
    node,
    binding,
    frame,
  }: {
    node: Node;
    binding: Identifier;
    frame: OrgGraphFrame;
  }): boolean => {
    let found = false;
    walk(node, (child) => {
      if (
        child.type === "Identifier" &&
        resolveDeclaration(child, frame.module.parents) === binding
      ) {
        found = true;
        return "skip-children";
      }
      return undefined;
    });
    return found;
  };

  readonly #branchConflictsWithFacts = ({
    node,
    facts,
    frame,
  }: {
    node: Node;
    facts: readonly OrgGraphDiscriminantFact[];
    frame: OrgGraphFrame;
  }): boolean => {
    let child = node;
    let parent = frame.module.parents.get(child);
    while (parent !== undefined && !this.#isFunctionNode(parent)) {
      if (parent.type === "IfStatement") {
        let branch = node;
        while (frame.module.parents.get(branch) !== parent) {
          const next = frame.module.parents.get(branch);
          if (next === undefined) {
            break;
          }
          branch = next;
        }
        let truth: boolean | undefined;
        if (parent.consequent === branch) {
          truth = true;
        } else if (parent.alternate === branch) {
          truth = false;
        }
        if (truth !== undefined) {
          for (const fact of facts) {
            if (fact.source === parent && fact.excludedBranchTruth === truth) {
              return true;
            }
          }
        }
      }
      child = parent;
      parent = frame.module.parents.get(child);
    }
    return false;
  };

  readonly #readOnlySetHas = (
    call: CallExpression,
    frame: OrgGraphFrame,
  ): boolean => {
    const callee = unwrap(call.callee);
    const argument = call.arguments.at(0);
    if (
      call.optional ||
      callee.type !== "MemberExpression" ||
      callee.optional ||
      callee.object.type !== "Identifier" ||
      accessName(callee) !== "has" ||
      call.arguments.length !== 1 ||
      argument === undefined ||
      argument.type === "SpreadElement" ||
      (argument.type !== "Identifier" && argument.type !== "Literal")
    ) {
      return false;
    }
    const sets = this.#alternatives(this.#evaluate(callee.object, frame));
    const keys = this.#alternatives(this.#evaluate(argument, frame));
    const isPrimitiveKey = (key: OrgGraphValue): boolean => {
      if (key.kind === "literal") {
        return (
          typeof key.value === "string" ||
          typeof key.value === "number" ||
          typeof key.value === "boolean" ||
          key.value === null
        );
      }
      return key.kind === "input" && "primitive" in key;
    };
    return (
      sets.length > 0 &&
      sets.every((set) => set.kind === "set") &&
      keys.length > 0 &&
      keys.every(isPrimitiveKey)
    );
  };

  readonly #discriminantReadPathIsStable = ({
    node,
    reference,
    binding,
    facts,
    frame,
  }: {
    node: Node;
    reference: Identifier;
    binding: Identifier;
    facts: readonly OrgGraphDiscriminantFact[];
    frame: OrgGraphFrame;
  }): boolean => {
    const unstableNodes: Node[] = [];
    const containsReference = ({
      ancestor,
      target,
    }: {
      ancestor: Node;
      target: Node;
    }): boolean => {
      let current: Node | undefined = target;
      while (current !== undefined && current !== ancestor) {
        current = frame.module.parents.get(current);
      }
      return current === ancestor;
    };
    walk(node, (child, ancestors) => {
      if (child.start > reference.start) {
        return "skip-children";
      }
      if (this.#branchConflictsWithFacts({ node: child, facts, frame })) {
        return "skip-children";
      }
      if (
        child.type === "Identifier" &&
        resolveDeclaration(child, frame.module.parents) === binding &&
        (frame.module.parents.get(child)?.type !== "MemberExpression" ||
          (frame.module.parents.get(child)?.type === "MemberExpression" &&
            frame.module.parents.get(child)?.object !== child) ||
          ancestors.some((ancestor) => this.#isFunctionNode(ancestor)))
      ) {
        unstableNodes.push(child);
        return "skip-children";
      }
      if (
        (child.type === "AssignmentExpression" ||
          child.type === "UpdateExpression") &&
        this.#containsBindingReference({
          node:
            child.type === "AssignmentExpression" ? child.left : child.argument,
          binding,
          frame,
        })
      ) {
        unstableNodes.push(child);
        return "skip-children";
      }
      if (
        child.type === "UnaryExpression" &&
        child.operator === "delete" &&
        this.#containsBindingReference({ node: child.argument, binding, frame })
      ) {
        unstableNodes.push(child);
        return "skip-children";
      }
      if (
        child.type === "CallExpression" &&
        !containsReference({ ancestor: child, target: reference }) &&
        !this.#readOnlySetHas(child, frame)
      ) {
        unstableNodes.push(child);
        return "skip-children";
      }
      return undefined;
    });
    return unstableNodes.length === 0;
  };

  readonly #stableDiscriminantRead = ({
    reference,
    binding,
    declarator,
    value,
    facts,
    frame,
  }: {
    reference: Identifier;
    binding: Identifier;
    declarator: Extract<Node, { type: "VariableDeclarator" }>;
    value: OrgGraphValue;
    facts: readonly OrgGraphDiscriminantFact[];
    frame: OrgGraphFrame;
  }): boolean => {
    if (
      facts.length === 0 ||
      !this.#alternatives(value).some((part) => part.kind === "object")
    ) {
      return false;
    }
    const declaration = frame.module.parents.get(declarator);
    if (
      declaration?.type !== "VariableDeclaration" ||
      declaration.kind !== "const" ||
      declaration.declarations.length !== 1
    ) {
      return false;
    }
    const inside = ({
      ancestor,
      target,
    }: {
      ancestor: Node;
      target: Node;
    }): boolean => {
      let current: Node | undefined = target;
      while (current !== undefined && current !== ancestor) {
        current = frame.module.parents.get(current);
      }
      return current === ancestor;
    };
    let block: Extract<Node, { type: "BlockStatement" }> | undefined;
    let current: Node | undefined = reference;
    while (current !== undefined) {
      if (
        current.type === "BlockStatement" &&
        inside({ ancestor: current, target: declarator })
      ) {
        block = current;
        break;
      }
      current = frame.module.parents.get(current);
    }
    if (block === undefined) {
      return false;
    }
    const directChild = (node: Node): Node | undefined => {
      let child = node;
      while (frame.module.parents.get(child) !== block) {
        const parent = frame.module.parents.get(child);
        if (parent === undefined) {
          return undefined;
        }
        child = parent;
      }
      return child;
    };
    const start = block.body.indexOf(declaration);
    const endChild = directChild(reference);
    const end = endChild === undefined ? -1 : block.body.indexOf(endChild);
    if (start === -1 || end === -1 || end <= start) {
      return false;
    }
    for (const node of block.body.slice(start + 1, end + 1)) {
      if (
        !this.#discriminantReadPathIsStable({
          node,
          reference,
          binding,
          facts,
          frame,
        })
      ) {
        return false;
      }
    }
    return true;
  };

  readonly #singleFunctionExit = (node: Node | null): boolean => {
    if (node === null) {
      return false;
    }
    const statement =
      node.type === "BlockStatement" && node.body.length === 1
        ? node.body.at(0)
        : node;
    return (
      statement?.type === "ReturnStatement" ||
      statement?.type === "ThrowStatement"
    );
  };

  readonly #singleSameIterationContinue = ({
    node,
    reference,
    frame,
  }: {
    node: Node | null;
    reference: Identifier;
    frame: OrgGraphFrame;
  }): boolean => {
    const statement =
      node?.type === "BlockStatement" && node.body.length === 1
        ? node.body.at(0)
        : node;
    if (statement?.type !== "ContinueStatement" || statement.label !== null) {
      return false;
    }
    const target = this.#nearestIteration({ node: reference, frame });
    return (
      target?.type === "ForOfStatement" &&
      this.#nearestIteration({ node: statement, frame }) === target
    );
  };

  readonly #bindingDeclarator = (
    binding: Identifier,
    frame: OrgGraphFrame,
  ): Extract<Node, { type: "VariableDeclarator" }> | undefined => {
    let current: Node = binding;
    while (true) {
      const parent = frame.module.parents.get(current);
      if (parent === undefined) {
        return undefined;
      }
      if (parent.type === "VariableDeclarator") {
        return parent.id === current ? parent : undefined;
      }
      const currentNode = current;
      if (
        (parent.type === "ArrayPattern" &&
          parent.elements.some((element) => element === currentNode)) ||
        (parent.type === "ObjectPattern" &&
          parent.properties.some((property) => property === currentNode)) ||
        (parent.type === "Property" && parent.value === currentNode) ||
        (parent.type === "AssignmentPattern" && parent.left === currentNode) ||
        (parent.type === "RestElement" && parent.argument === currentNode)
      ) {
        current = parent;
        continue;
      }
      return undefined;
    }
  };

  readonly #stableReadBinding = (
    binding: Identifier,
    frame: OrgGraphFrame,
  ): boolean => {
    const declarator = this.#bindingDeclarator(binding, frame);
    const declaration =
      declarator === undefined
        ? undefined
        : frame.module.parents.get(declarator);
    if (
      declarator !== undefined &&
      declarator.init !== null &&
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
    ) {
      return true;
    }
    const owner =
      frame.context === undefined
        ? undefined
        : this.#contexts.get(frame.context)?.fn.node;
    return (
      owner !== undefined &&
      owner.params.some((parameter) => parameter === binding) &&
      !this.#hasDirectEval(owner) &&
      !this.#bindingIsCaptured({ binding, owner, frame })
    );
  };

  readonly #guardedBindingRead = ({
    reference,
    binding,
    value,
    frame,
  }: {
    reference: Identifier;
    binding: Identifier;
    value: OrgGraphValue;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    const alternatives = this.#alternatives(value);
    if (!this.#stableReadBinding(binding, frame)) {
      return value;
    }
    const excluded = new Set<null | undefined>();
    let recordAccepted = false;
    let current: Node = reference;
    while (true) {
      const parent = frame.module.parents.get(current);
      // A hoisted or escaping closure is not dominated by an outer function's
      // later guard. Keep lexical capture environments unchanged.
      if (parent === undefined || this.#isFunctionNode(parent)) {
        break;
      }
      if (parent.type === "BlockStatement") {
        const index = parent.body.indexOf(current);
        for (const statement of parent.body.slice(0, Math.max(index, 0))) {
          if (statement.type !== "IfStatement") {
            continue;
          }
          let truth: boolean | undefined;
          if (this.#singleFunctionExit(statement.consequent)) {
            truth = false;
          } else if (this.#singleFunctionExit(statement.alternate)) {
            truth = true;
          }
          const functionExitTruth = truth;
          if (truth === undefined) {
            if (
              this.#singleSameIterationContinue({
                node: statement.consequent,
                reference,
                frame,
              })
            ) {
              truth = false;
            } else if (
              this.#singleSameIterationContinue({
                node: statement.alternate,
                reference,
                frame,
              })
            ) {
              truth = true;
            }
          }
          if (truth === undefined) {
            continue;
          }
          for (const literal of this.#nullishConditionExclusions({
            test: statement.test,
            binding,
            truth,
            frame,
          })) {
            excluded.add(literal);
          }
          if (
            functionExitTruth !== undefined &&
            this.#recordConditionTruth({
              test: statement.test,
              binding,
              frame,
            }) === functionExitTruth
          ) {
            recordAccepted = true;
          }
        }
      }
      current = parent;
    }
    // Refine this read only; changing frame.values would also change closures
    // captured or returned on the guard's rejecting path.
    let refined = value;
    if (excluded.size > 0 || recordAccepted) {
      // Record checks exclude primitive literals only. Keep opaque input and
      // every nonliteral capability/callback alternative intact.
      refined = this.#join(
        ...alternatives.filter((part) => {
          if (part.kind !== "literal") {
            return true;
          }
          if (recordAccepted) {
            return false;
          }
          if (part.value === null || part.value === undefined) {
            return !excluded.has(part.value);
          }
          return true;
        }),
      );
    }
    const declarator = this.#bindingDeclarator(binding, frame);
    if (declarator === undefined) {
      return refined;
    }
    const facts = this.#discriminantFacts({ reference, binding, frame });
    if (
      !this.#stableDiscriminantRead({
        reference,
        binding,
        declarator,
        value,
        facts,
        frame,
      })
    ) {
      return refined;
    }
    const narrowed = this.#alternatives(refined).filter((part) => {
      if (
        part.kind !== "object" ||
        part.keyStability !== "fixed" ||
        part.propertyPresence !== "closed" ||
        part.unknownFields.kind !== "bottom"
      ) {
        return true;
      }
      for (const fact of facts) {
        if (part.optionalFields?.has(fact.property)) {
          continue;
        }
        const discriminant = part.fields.get(fact.property);
        const values =
          discriminant === undefined ? [] : this.#alternatives(discriminant);
        const tag = values.at(0);
        if (
          values.length !== 1 ||
          tag?.kind !== "literal" ||
          !(
            typeof tag.value === "string" ||
            typeof tag.value === "number" ||
            typeof tag.value === "boolean" ||
            tag.value === null
          )
        ) {
          continue;
        }
        if (fact.equals !== (tag.value === fact.value)) {
          return false;
        }
      }
      return true;
    });
    return narrowed.length === 0 ? refined : this.#join(...narrowed);
  };

  readonly #evaluateReference = (
    node: OrgGraphReferenceExpression,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    switch (node.type) {
      case "Identifier": {
        const binding = resolveDeclaration(node, frame.module.parents);
        if (binding === undefined && node.name === "undefined") {
          return { kind: "literal", value: undefined };
        }
        if (binding === undefined && GRAPH_GLOBAL_ALIASES.has(node.name)) {
          return { kind: "external", module: "global", name: "globalThis" };
        }
        if (binding === undefined && GRAPH_GLOBAL_BINDINGS.has(node.name)) {
          return { kind: "external", module: "global", name: node.name };
        }
        return binding === undefined
          ? this.#unknown(`unbound ${node.name}`)
          : this.#guardedStringIdentifier({
              reference: node,
              frame,
              value: this.#guardedBindingRead({
                reference: node,
                binding,
                value: this.#immediateTruthyConditionalRead({
                  reference: node,
                  binding,
                  value: this.#bindingValue(binding, frame),
                  frame,
                }),
                frame,
              }),
            });
      }
      case "Literal":
        if ("regex" in node) {
          if (!(node.value instanceof RegExp)) {
            return this.#unknown(
              "RegExp literal unsupported by the native analyzer",
            );
          }
          return {
            kind: "external",
            module: "global",
            name: "RegExp.literal",
            regexp: node.value,
          };
        }
        return typeof node.value === "string" ||
          typeof node.value === "number" ||
          typeof node.value === "boolean" ||
          node.value === null
          ? { kind: "literal", value: node.value }
          : this.#unknown("non-scalar literal");
      case "AwaitExpression":
        return this.#awaitValue({
          value: this.#evaluate(node.argument, frame),
          frame,
          node,
        });
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
        return this.#evaluate(node.expression, frame);
      case "ChainExpression":
        return this.#join(
          ...this.#alternatives(this.#evaluate(node.expression, frame)).map(
            (part): OrgGraphValue =>
              part.kind === "chain-short-circuit"
                ? { kind: "literal", value: undefined }
                : part,
          ),
        );
      case "ParenthesizedExpression":
      case "TSInstantiationExpression":
        return this.#evaluate(node.expression, frame);
      case "MemberExpression":
        return this.#memberValue(node, frame);
      case "CallExpression":
        return this.#callValue(node, frame);
      case "ImportExpression": {
        const specifier = stringValue(node.source);
        if (specifier === undefined) {
          return this.#fail(frame, node, "dynamic import path");
        }
        const file = this.#localPath({
          from: frame.module.file,
          specifier,
        });
        return file === undefined
          ? { kind: "external", module: specifier, name: "*" }
          : { kind: "module", file };
      }
      default:
        node satisfies never;
        return panic("Unreachable organization reference expression");
    }
  };

  readonly #iterableValues = ({
    value,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): Extract<OrgGraphValue, { kind: "array" }> => {
    const alternatives = this.#alternatives(value);
    if (alternatives.length === 0) {
      return this.#fail(frame, node, "unresolved iterable expansion");
    }
    const result: Extract<OrgGraphValue, { kind: "array" }> = {
      kind: "array",
      extent: { type: "finite", maximum: 0 },
      stability: alternatives.length === 1 ? "fixed" : "mutable",
      values: [],
    };
    const append = (candidate: OrgGraphValue): void => {
      if (result.stability === "mutable") {
        const alreadyPresent = result.values.some(
          (existingValue) =>
            existingValue === candidate ||
            (existingValue.kind === "literal" &&
              candidate.kind === "literal" &&
              Object.is(existingValue.value, candidate.value)),
        );
        if (alreadyPresent) {
          return;
        }
      }
      result.values.push(candidate);
      if (result.values.length > 128) {
        return this.#fail(
          frame,
          node,
          `abstract iterable exceeds its finite domain (alternatives: ${alternatives.length}; accumulated: ${result.values.length}; distinct values: ${result.values.length})`,
        );
      }
    };
    for (const part of alternatives) {
      if (part.kind !== "array" && part.kind !== "set") {
        return this.#fail(
          frame,
          node,
          `unsupported unknown/custom iterable expansion (source: ${this.#signature({ value: part })})`,
        );
      }
      let extent: OrgGraphArrayExtent = { type: "unknown" };
      if (part.kind === "array") {
        extent = part.extent;
      } else if (
        part.stability === "fixed" &&
        part.values.every((item) => item.kind === "literal")
      ) {
        extent = { type: "finite", maximum: part.values.length };
      }
      result.extent = this.#maximumArrayExtent({
        left: result.extent,
        right: extent,
      });
      if (part.stability === "mutable") {
        result.stability = "mutable";
      }
      for (const candidate of part.values) {
        append(candidate);
      }
    }
    return result;
  };

  readonly #evaluateArray = (
    node: Extract<Node, { type: "ArrayExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const result: Extract<OrgGraphValue, { kind: "array" }> = {
      kind: "array",
      extent: { type: "finite", maximum: 0 },
      stability: "fixed",
      values: [],
    };
    for (const element of node.elements) {
      if (element?.type === "SpreadElement") {
        const expanded = this.#iterableValues({
          value: this.#evaluate(element.argument, frame),
          frame,
          node: element,
        });
        if (expanded.stability === "mutable") {
          result.stability = "mutable";
        }
        result.extent = this.#sumArrayExtent({
          left: result.extent,
          right: expanded.extent,
        });
        result.values.push(...expanded.values);
      } else {
        result.extent = this.#sumArrayExtent({
          left: result.extent,
          right: { type: "finite", maximum: 1 },
        });
        result.values.push(this.#evaluate(element, frame));
      }
      if (result.values.length > 128) {
        return this.#fail(
          frame,
          node,
          "abstract array exceeds its finite domain",
        );
      }
    }
    return result;
  };

  readonly #constructSet = ({
    argument,
    frame,
    node,
  }: {
    argument: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): OrgGraphValue => {
    const alternatives = this.#alternatives(argument);
    if (alternatives.length === 0) {
      return this.#fail(frame, node, "unresolved native Set input");
    }
    const result: Extract<OrgGraphValue, { kind: "set" }> = {
      kind: "set",
      stability: alternatives.length === 1 ? "fixed" : "mutable",
      values: [],
    };
    for (const part of alternatives) {
      if (
        part.kind === "literal" &&
        (part.value === null || part.value === undefined)
      ) {
        continue;
      }
      const expanded = this.#iterableValues({ value: part, frame, node });
      if (expanded.stability === "mutable") {
        result.stability = "mutable";
      }
      for (const item of expanded.values) {
        if (item.kind !== "literal") {
          // Equal abstract structures do not prove equal concrete identities.
          result.stability = "mutable";
          result.values.push(item);
        } else if (
          !result.values.some(
            (known) =>
              known.kind === "literal" &&
              (known.value === item.value ||
                Object.is(known.value, item.value)),
          )
        ) {
          result.values.push(item);
        }
        if (result.values.length > 128) {
          return this.#fail(
            frame,
            node,
            "abstract Set exceeds its finite domain",
          );
        }
      }
    }
    return result;
  };

  readonly #objectSpreadSources = ({
    value,
    frame,
    node,
  }: {
    value: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): readonly OrgGraphObjectValue[] =>
    this.#alternatives(value).map((candidate): OrgGraphObjectValue => {
      if (candidate.kind === "literal") {
        const fields = new Map<string, OrgGraphValue>();
        if (typeof candidate.value === "string") {
          for (let index = 0; index < candidate.value.length; index += 1) {
            fields.set(String(index), {
              kind: "literal",
              value: candidate.value.charAt(index),
            });
          }
        }
        return {
          kind: "object",
          prototypeDisposition: "ordinary",
          fields,
          unknownFields: this.#bottom,
          keyStability: "fixed",
          propertyPresence: "closed",
        };
      }
      if (candidate.kind === "input") {
        return {
          kind: "object",
          prototypeDisposition: "ordinary",
          fields: new Map<string, OrgGraphValue>(),
          unknownFields: candidate,
          keyStability: "mutable",
          propertyPresence: "open",
        };
      }
      if (
        candidate.kind !== "object" ||
        candidate.prototypeDisposition === "unmodeled"
      ) {
        return this.#fail(
          frame,
          node,
          `object spread cannot preserve unknown delegated fields (source kind: ${candidate.kind})`,
        );
      }
      return candidate;
    });

  readonly #computedOwnPropertyKeys = ({
    key,
    frame,
    node,
  }: {
    key: OrgGraphValue;
    frame: OrgGraphFrame;
    node: Node;
  }): { names: readonly string[]; presence: "closed" | "open" } => {
    const names = new Set<string>();
    let presence: "closed" | "open" = "closed";
    const parts = this.#alternatives(key);
    if (parts.length === 0) {
      this.#fail(frame, node, "unresolved computed object property key");
    }
    for (const part of parts) {
      if (part.kind === "unknown" || part.kind === "external") {
        this.#fail(frame, node, "dynamic/accessor object property");
      }
      this.#assertOperatorCoercionIsPrimitive({ values: [part], frame, node });
      if (part.kind === "literal") {
        names.add(String(part.value));
      } else if (part.kind === "input" && part.primitive === "string") {
        presence = "open";
      } else {
        this.#fail(frame, node, "dynamic/accessor object property");
      }
    }
    return { names: [...names], presence };
  };

  readonly #evaluateObjectExpression = (
    node: Extract<OrgGraphContainerExpression, { type: "ObjectExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const fields = new Map<string, OrgGraphValue>();
    const optionalFields = new Set<string>();
    let unknownFields = this.#bottom;
    let keyStability: "fixed" | "mutable" = "fixed";
    let propertyPresence: OrgGraphPropertyPresence = "closed";
    let prototypeDisposition: "ordinary" | "unmodeled" = "ordinary";
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        const spread = this.#evaluate(property.argument, frame);
        const candidates = this.#objectSpreadSources({
          value: spread,
          frame,
          node: property,
        });
        if (candidates.length !== 1) {
          keyStability = "mutable";
        }
        const spreadFields = new Map<string, OrgGraphValue>();
        for (const candidate of candidates) {
          if (candidate.keyStability === "mutable") {
            keyStability = "mutable";
          }
          propertyPresence = this.#joinPropertyPresence({
            left: propertyPresence,
            right: candidate.propertyPresence,
          });
          unknownFields = this.#join(unknownFields, candidate.unknownFields);
          for (const [key, value] of candidate.fields) {
            spreadFields.set(
              key,
              this.#join(spreadFields.get(key) ?? this.#bottom, value),
            );
          }
        }
        for (const [key, value] of spreadFields) {
          const previouslyPresent = fields.has(key) && !optionalFields.has(key);
          const alwaysPresent = candidates.every(
            (candidate) =>
              candidate.fields.has(key) && !candidate.optionalFields?.has(key),
          );
          fields.set(
            key,
            alwaysPresent
              ? value
              : this.#join(fields.get(key) ?? this.#bottom, value),
          );
          if (previouslyPresent || alwaysPresent) {
            optionalFields.delete(key);
          } else {
            optionalFields.add(key);
          }
        }
        continue;
      }
      if (property.kind !== "init") {
        this.#fail(frame, property, "dynamic/accessor object property");
      }
      let keys: { names: readonly string[]; presence: "closed" | "open" };
      if (property.computed) {
        keys = this.#computedOwnPropertyKeys({
          key: this.#evaluate(property.key, frame),
          frame,
          node: property,
        });
      } else {
        const name = staticPropertyName(property);
        if (name === undefined) {
          this.#fail(frame, property, "dynamic/accessor object property");
        }
        keys = { names: [name], presence: "closed" };
        if (name === "__proto__" && !property.method && !property.shorthand) {
          prototypeDisposition = "unmodeled";
        }
      }
      // ToPropertyKey above precedes the initializer's evaluation. Keep the
      // actual stored value, including every transaction, callback and alias.
      const stored = this.#evaluate(property.value, frame);
      if (
        !property.computed &&
        !property.method &&
        !property.shorthand &&
        keys.names.at(0) === "__proto__" &&
        (this.#relevant(stored) || this.#containsCallable(stored))
      ) {
        return this.#fail(
          frame,
          property,
          "prototype initializer carries a transaction or callable",
        );
      }
      if (keys.presence === "open") {
        unknownFields = this.#join(unknownFields, stored);
        keyStability = "mutable";
        propertyPresence = this.#joinPropertyPresence({
          left: propertyPresence,
          right: "known-values",
        });
      }
      const definite = keys.presence === "closed" && keys.names.length === 1;
      if (!definite) {
        keyStability = "mutable";
      }
      for (const name of keys.names) {
        if (definite) {
          fields.set(name, stored);
          optionalFields.delete(name);
        } else {
          const present = fields.has(name) && !optionalFields.has(name);
          fields.set(
            name,
            this.#join(fields.get(name) ?? this.#bottom, stored),
          );
          if (!present) {
            optionalFields.add(name);
          }
        }
      }
    }
    return {
      kind: "object",
      prototypeDisposition,
      fields,
      unknownFields,
      keyStability,
      propertyPresence,
      optionalFields,
    };
  };

  readonly #evaluateTaggedTemplate = (
    node: Extract<
      OrgGraphContainerExpression,
      { type: "TaggedTemplateExpression" }
    >,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const tag = this.#evaluate(node.tag, frame);
    if (
      !this.#alternatives(tag).every(
        (part) =>
          part.kind === "external" &&
          part.module === "drizzle-orm" &&
          part.name === "sql",
      )
    ) {
      return this.#fail(frame, node, "unknown tagged template semantics");
    }
    const targets = new Map<string, OrgGraphValue>();
    let unresolved = false;
    let text = "";
    for (const [index, quasi] of node.quasi.quasis.entries()) {
      text += quasi.value.cooked ?? quasi.value.raw;
      const expression = node.quasi.expressions.at(index);
      if (expression === undefined) {
        continue;
      }
      const value = this.#evaluate(expression, frame);
      if (value.kind === "sql") {
        unresolved ||= value.unresolved;
        text += value.text;
        for (const [token, target] of value.targets) {
          if (targets.has(token)) {
            this.#fail(frame, node, "nested SQL token collision");
          }
          targets.set(token, target);
        }
      } else if (
        this.#alternatives(value).every((part) => part.kind === "table") &&
        this.#alternatives(value).length > 0
      ) {
        const token = `__org_graph_${node.start}_${index}__`;
        text += token;
        targets.set(token, value);
      } else {
        if (
          !this.#alternatives(value).every(
            (part) => part.kind === "literal" || part.kind === "column",
          ) ||
          this.#alternatives(value).length === 0
        ) {
          unresolved = true;
        }
        text += " __org_graph_parameter__ ";
      }
    }
    return { kind: "sql", text, targets, unresolved };
  };

  readonly #evaluateTemplateLiteral = (
    node: Extract<OrgGraphContainerExpression, { type: "TemplateLiteral" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const values = node.expressions.map((expression) =>
      this.#alternatives(this.#evaluate(expression, frame)),
    );
    if (node.expressions.length === 0) {
      return {
        kind: "literal",
        value: node.quasis.at(0)?.value.cooked ?? "",
      };
    }
    let dynamic = false;
    const literalParts: string[] = [];
    for (const alternatives of values) {
      if (
        alternatives.length === 0 ||
        alternatives.some(
          (part) => !(part.kind === "literal" || part.kind === "input"),
        )
      ) {
        return this.#fail(
          frame,
          node,
          "dynamic template interpolation requires primitive data",
        );
      }
      const literal = alternatives.at(0);
      if (alternatives.length !== 1 || literal?.kind !== "literal") {
        dynamic = true;
      }
      literalParts.push(
        literal?.kind === "literal" ? String(literal.value) : "",
      );
    }
    if (dynamic) {
      return { kind: "input", primitive: "string" };
    }
    let text = node.quasis.at(0)?.value.cooked ?? "";
    for (const [index, interpolation] of literalParts.entries()) {
      text += interpolation;
      text += node.quasis.at(index + 1)?.value.cooked ?? "";
    }
    return { kind: "literal", value: text };
  };

  readonly #evaluateContainer = (
    node: OrgGraphContainerExpression,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    switch (node.type) {
      case "ObjectExpression":
        return this.#evaluateObjectExpression(node, frame);
      case "ArrayExpression":
        return this.#evaluateArray(node, frame);
      case "TaggedTemplateExpression":
        return this.#evaluateTaggedTemplate(node, frame);
      case "TemplateLiteral":
        return this.#evaluateTemplateLiteral(node, frame);
      case "SequenceExpression": {
        let value: OrgGraphValue = this.#bottom;
        for (const expression of node.expressions) {
          value = this.#evaluate(expression, frame);
        }
        return value;
      }
      default:
        node satisfies never;
        return panic("Unreachable organization container expression");
    }
  };

  readonly #toUint32 = (value: number): number => {
    if (!Number.isFinite(value) || value === 0) {
      return 0;
    }
    const modulus = 2 ** 32;
    const remainder = Math.trunc(value) % modulus;
    if (remainder === 0) {
      return 0;
    }
    return remainder < 0 ? remainder + modulus : remainder;
  };

  readonly #toInt32 = (value: number): number => {
    const unsigned = this.#toUint32(value);
    return unsigned >= 2 ** 31 ? unsigned - 2 ** 32 : unsigned;
  };

  readonly #combineIntegerBits = ({
    operator,
    left,
    right,
  }: {
    operator: "&" | "|" | "^";
    left: number;
    right: number;
  }): number => {
    let leftBits = left;
    let rightBits = right;
    let result = 0;
    for (let position = 0; position < 32; position += 1) {
      const leftBit = leftBits % 2;
      const rightBit = rightBits % 2;
      let bit: number;
      switch (operator) {
        case "&":
          bit = leftBit * rightBit;
          break;
        case "|":
          bit = Math.max(leftBit, rightBit);
          break;
        case "^":
          bit = (leftBit + rightBit) % 2;
          break;
        default:
          operator satisfies never;
          return panic("Unknown integer bit operation");
      }
      result += bit * 2 ** position;
      leftBits = Math.floor(leftBits / 2);
      rightBits = Math.floor(rightBits / 2);
    }
    return this.#toInt32(result);
  };

  readonly #literalBitwiseOperator = ({
    operator,
    left,
    right,
  }: {
    operator: "<<" | ">>" | ">>>" | "&" | "|" | "^";
    left: number;
    right: number;
  }): number => {
    const leftWord = this.#toUint32(left);
    const rightWord = this.#toUint32(right);
    const shift = rightWord % 32;
    switch (operator) {
      case "<<":
        return this.#toInt32((leftWord * 2 ** shift) % 2 ** 32);
      case ">>":
        return Math.floor(this.#toInt32(leftWord) / 2 ** shift);
      case ">>>":
        return Math.floor(leftWord / 2 ** shift);
      case "&":
      case "|":
      case "^":
        return this.#combineIntegerBits({
          operator,
          left: leftWord,
          right: rightWord,
        });
      default:
        operator satisfies never;
        return panic("Unknown bitwise numeric operation");
    }
  };

  readonly #literalNumericOperator = ({
    node,
    left,
    right,
  }: {
    node: Extract<Node, { type: "BinaryExpression" }>;
    left: OrgGraphValue;
    right: OrgGraphValue;
  }): OrgGraphValue | undefined => {
    if (
      left.kind !== "literal" ||
      typeof left.value !== "number" ||
      right.kind !== "literal" ||
      typeof right.value !== "number"
    ) {
      return undefined;
    }
    switch (node.operator) {
      case "+":
        return { kind: "literal", value: left.value + right.value };
      case "-":
        return { kind: "literal", value: left.value - right.value };
      case "*":
        return { kind: "literal", value: left.value * right.value };
      case "/":
        return { kind: "literal", value: left.value / right.value };
      case "%":
        return { kind: "literal", value: left.value % right.value };
      case "**":
        return { kind: "literal", value: left.value ** right.value };
      case "<":
        return { kind: "literal", value: left.value < right.value };
      case "<=":
        return { kind: "literal", value: left.value <= right.value };
      case ">":
        return { kind: "literal", value: left.value > right.value };
      case ">=":
        return { kind: "literal", value: left.value >= right.value };
      case "<<":
      case ">>":
      case ">>>":
      case "&":
      case "|":
      case "^":
        return {
          kind: "literal",
          value: this.#literalBitwiseOperator({
            operator: node.operator,
            left: left.value,
            right: right.value,
          }),
        };
      default:
        return undefined;
    }
  };

  readonly #typeOfValue = (value: OrgGraphValue): OrgGraphValue =>
    this.#join(
      ...this.#alternatives(value).map((part): OrgGraphValue => {
        if (part.kind === "literal") {
          return { kind: "literal", value: typeof part.value };
        }
        if (part.kind === "input") {
          if (part.primitive === "string") {
            return { kind: "literal", value: "string" };
          }
          if (part.primitive === "boolean") {
            return { kind: "literal", value: "boolean" };
          }
          return { kind: "input", primitive: "string" };
        }
        if (
          part.kind === "array" ||
          part.kind === "object" ||
          part.kind === "set"
        ) {
          return { kind: "literal", value: "object" };
        }
        if (part.kind === "function") {
          return { kind: "literal", value: "function" };
        }
        return { kind: "input", primitive: "string" };
      }),
    );

  readonly #knownNonNullReference = (value: OrgGraphValue): boolean => {
    const alternatives = this.#alternatives(value);
    return (
      alternatives.length > 0 &&
      alternatives.every(
        (part) =>
          part.kind === "array" ||
          part.kind === "object" ||
          part.kind === "set" ||
          part.kind === "function",
      )
    );
  };

  readonly #evaluateConditionalOperator = (
    node: Extract<
      OrgGraphOperatorExpression,
      { type: "ConditionalExpression" }
    >,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const condition = this.#truth(this.#evaluate(node.test, frame));
    if (condition === false) {
      return this.#evaluate(node.alternate, frame);
    }
    const consequentFrame = condition === true ? frame : this.#forkFrame(frame);
    const consequent = this.#typeofStringConditionalOutput({
      node,
      frame: consequentFrame,
      value: this.#validatedConditionalOutput({
        node,
        frame: consequentFrame,
        value: this.#arrayReturnValue({
          node,
          value: this.#evaluate(node.consequent, consequentFrame),
          frame: consequentFrame,
        }),
      }),
    });
    return condition === true
      ? consequent
      : this.#join(
          consequent,
          this.#evaluate(node.alternate, this.#forkFrame(frame)),
        );
  };

  readonly #evaluateLogicalOperator = (
    node: Extract<OrgGraphOperatorExpression, { type: "LogicalExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const left = this.#evaluate(node.left, frame);
    if (node.operator === "??") {
      return this.#nullishValue({ node, frame, left });
    }
    const condition = this.#truth(left);
    if (
      (node.operator === "&&" && condition === false) ||
      (node.operator === "||" && condition === true)
    ) {
      return left;
    }
    if (
      (node.operator === "&&" && condition === true) ||
      (node.operator === "||" && condition === false)
    ) {
      return this.#evaluate(node.right, frame);
    }
    return this.#join(left, this.#evaluate(node.right, frame));
  };

  readonly #evaluateBinaryOperator = (
    node: Extract<OrgGraphOperatorExpression, { type: "BinaryExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const left = this.#evaluate(node.left, frame);
    const right = this.#evaluate(node.right, frame);
    const coercive =
      node.operator === "==" ||
      node.operator === "!=" ||
      node.operator === "+" ||
      node.operator === "-" ||
      node.operator === "*" ||
      node.operator === "/" ||
      node.operator === "%" ||
      node.operator === "**" ||
      node.operator === "<<" ||
      node.operator === ">>" ||
      node.operator === ">>>" ||
      node.operator === "&" ||
      node.operator === "|" ||
      node.operator === "^" ||
      node.operator === "<" ||
      node.operator === ">" ||
      node.operator === "<=" ||
      node.operator === ">=";
    if (coercive) {
      this.#assertOperatorCoercionIsPrimitive({
        values: [left, right],
        frame,
        node,
      });
    }
    if (node.operator === "in" || node.operator === "instanceof") {
      this.#assertOperatorCoercionIsPrimitive({
        values: [left],
        frame,
        node,
      });
    }
    if (node.operator === "==" || node.operator === "!=") {
      return { kind: "input" };
    }
    const numeric = this.#literalNumericOperator({ node, left, right });
    if (numeric !== undefined) {
      return numeric;
    }
    if (left.kind === "literal" && right.kind === "literal") {
      if (node.operator === "===") {
        return { kind: "literal", value: left.value === right.value };
      }
      if (node.operator === "!==") {
        return { kind: "literal", value: left.value !== right.value };
      }
    }
    if (
      (node.operator === "===" || node.operator === "!==") &&
      ((left.kind === "literal" &&
        (left.value === null || left.value === undefined) &&
        this.#knownNonNullReference(right)) ||
        (right.kind === "literal" &&
          (right.value === null || right.value === undefined) &&
          this.#knownNonNullReference(left)))
    ) {
      return { kind: "literal", value: node.operator === "!==" };
    }
    // Table identity comparisons used by recovery spec invariants are exact.
    if (
      left.kind === "table" &&
      right.kind === "table" &&
      ["===", "!=="].includes(node.operator)
    ) {
      return {
        kind: "literal",
        value:
          node.operator === "==="
            ? left.name === right.name
            : left.name !== right.name,
      };
    }
    return { kind: "input" };
  };

  readonly #evaluateUnaryOperator = (
    node: Extract<OrgGraphOperatorExpression, { type: "UnaryExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    if (node.operator === "delete") {
      return this.#fail(
        frame,
        node,
        "unmodeled delete mutation cannot preserve object property presence",
      );
    }
    const argument = this.#evaluate(node.argument, frame);
    if (node.operator === "typeof") {
      return this.#typeOfValue(argument);
    }
    if (
      (node.operator === "+" || node.operator === "-") &&
      argument.kind === "literal" &&
      typeof argument.value === "number"
    ) {
      return {
        kind: "literal",
        value: node.operator === "-" ? -argument.value : argument.value,
      };
    }
    if (node.operator === "!") {
      const truth = this.#truth(argument);
      return truth === undefined
        ? { kind: "input", primitive: "boolean" }
        : { kind: "literal", value: !truth };
    }
    if (node.operator === "void") {
      return { kind: "literal", value: undefined };
    }
    if (
      node.operator === "+" ||
      node.operator === "-" ||
      node.operator === "~"
    ) {
      this.#assertOperatorCoercionIsPrimitive({
        values: [argument],
        frame,
        node,
      });
      if (
        node.operator === "~" &&
        argument.kind === "literal" &&
        typeof argument.value === "number"
      ) {
        return { kind: "literal", value: -this.#toInt32(argument.value) - 1 };
      }
      return { kind: "input" };
    }
    return this.#unknown("unary result");
  };

  readonly #evaluateOperator = (
    node: OrgGraphOperatorExpression,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    switch (node.type) {
      case "ConditionalExpression":
        return this.#evaluateConditionalOperator(node, frame);
      case "LogicalExpression":
        return this.#evaluateLogicalOperator(node, frame);
      case "BinaryExpression":
        return this.#evaluateBinaryOperator(node, frame);
      case "UnaryExpression":
        return this.#evaluateUnaryOperator(node, frame);
      default:
        node satisfies never;
        return panic("Unreachable organization operator expression");
    }
  };

  readonly #localBindingOwner = (
    binding: Identifier,
    frame: OrgGraphFrame,
  ): OrgGraphFunction | undefined => {
    const declarator = frame.module.parents.get(binding);
    if (
      declarator?.type !== "VariableDeclarator" ||
      declarator.id !== binding
    ) {
      return undefined;
    }
    const declaration = frame.module.parents.get(declarator);
    if (
      declaration?.type !== "VariableDeclaration" ||
      (declaration.kind !== "const" && declaration.kind !== "let")
    ) {
      return undefined;
    }
    const context =
      frame.context === undefined
        ? undefined
        : this.#contexts.get(frame.context);
    let current: Node | undefined = declarator;
    while (current !== undefined && !this.#isFunctionNode(current)) {
      current = frame.module.parents.get(current);
    }
    return current !== undefined &&
      this.#isFunctionNode(current) &&
      current === context?.fn.node
      ? current
      : undefined;
  };

  readonly #bindingIsCaptured = ({
    binding,
    owner,
    frame,
  }: {
    binding: Identifier;
    owner: OrgGraphFunction;
    frame: OrgGraphFrame;
  }): boolean => {
    let proofs = this.#captureProofs.get(owner);
    if (proofs === undefined) {
      proofs = new WeakMap();
      this.#captureProofs.set(owner, proofs);
    }
    const cached = proofs.get(binding);
    if (cached !== undefined) {
      return cached;
    }
    let captured = false;
    walk(owner, (reference) => {
      if (
        reference.type !== "Identifier" ||
        !isReferencePosition(reference, frame.module.parents) ||
        resolveDeclaration(reference, frame.module.parents) !== binding
      ) {
        return;
      }
      let current = frame.module.parents.get(reference);
      while (current !== undefined && !this.#isFunctionNode(current)) {
        current = frame.module.parents.get(current);
      }
      if (current !== owner) {
        captured = true;
      }
    });
    proofs.set(binding, captured);
    return captured;
  };

  readonly #hasDirectEval = (owner: OrgGraphFunction): boolean => {
    const cached = this.#evalProofs.get(owner);
    if (cached !== undefined) {
      return cached;
    }
    let found = false;
    walk(owner, (node) => {
      if (node.type !== "CallExpression") {
        return;
      }
      const callee = unwrapTypes(node.callee);
      if (callee.type === "Identifier" && callee.name === "eval") {
        found = true;
      }
    });
    this.#evalProofs.set(owner, found);
    return found;
  };

  readonly #assignLocalSlot = ({
    node,
    target,
    frame,
  }: {
    node: Extract<Node, { type: "AssignmentExpression" | "UpdateExpression" }>;
    target: Identifier;
    frame: OrgGraphFrame;
  }): OrgGraphValue => {
    if (node.type !== "AssignmentExpression" || node.operator !== "=") {
      return this.#fail(
        frame,
        node,
        "local slot assignment requires a modeled plain assignment",
      );
    }
    const binding = resolveDeclaration(target, frame.module.parents);
    const owner =
      binding === undefined
        ? undefined
        : this.#localBindingOwner(binding, frame);
    const declarator =
      binding === undefined ? undefined : frame.module.parents.get(binding);
    const declaration =
      declarator === undefined
        ? undefined
        : frame.module.parents.get(declarator);
    if (
      binding === undefined ||
      owner === undefined ||
      declaration?.type !== "VariableDeclaration" ||
      declaration.kind !== "let" ||
      !frame.values.has(binding)
    ) {
      return this.#fail(
        frame,
        node,
        "mutable slot requires an initialized local let binding",
      );
    }
    if (
      this.#nearestIteration({ node, frame }) !== frame.countedIteration?.loop
    ) {
      return this.#fail(
        frame,
        node,
        "local slot assignment requires its owning counted loop",
      );
    }
    if (binding === frame.countedIteration?.counter) {
      return this.#fail(
        frame,
        node,
        "counted loop body cannot assign its induction variable",
      );
    }
    if (this.#bindingIsCaptured({ binding, owner, frame })) {
      return this.#fail(
        frame,
        node,
        "captured mutable binding requires a shared lexical store",
      );
    }
    if (this.#hasDirectEval(owner)) {
      return this.#fail(
        frame,
        node,
        "dynamic lexical evaluation prevents a local slot proof",
      );
    }
    let ancestor: Node | undefined = node;
    while (ancestor !== undefined && ancestor !== owner) {
      if (ancestor.type === "TryStatement") {
        return this.#fail(
          frame,
          node,
          "local slot assignment across an exception boundary requires exception states",
        );
      }
      ancestor = frame.module.parents.get(ancestor);
    }
    const value = this.#evaluate(node.right, frame);
    frame.values.set(binding, value);
    return value;
  };

  readonly #evaluateOpaqueMutation = (
    node: Extract<Node, { type: "AssignmentExpression" | "UpdateExpression" }>,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    const target =
      node.type === "AssignmentExpression" ? node.left : node.argument;
    if (target.type === "Identifier" && frame.countedIteration !== undefined) {
      return this.#assignLocalSlot({ node, target, frame });
    }
    if (target.type !== "MemberExpression") {
      return this.#fail(
        frame,
        node,
        "mutable state requires an alias/control-flow state model",
      );
    }
    const receiver = this.#evaluate(target.object, frame);
    const key = target.computed
      ? this.#evaluate(target.property, frame)
      : this.#bottom;
    const value =
      node.type === "AssignmentExpression"
        ? this.#evaluate(node.right, frame)
        : this.#bottom;
    this.#nativeExternalWrite({ receiver, key, value, target, frame, node });
    if (
      [receiver, key, value].some(
        (part) => this.#relevant(part) || this.#containsCallable(part),
      )
    ) {
      return this.#fail(
        frame,
        node,
        "mutable field retains a transaction capability or callable",
      );
    }
    const fieldName = accessName(target);
    const assigned =
      node.type === "AssignmentExpression" && node.operator === "="
        ? value
        : ({ kind: "input" } satisfies OrgGraphValue);
    for (const part of this.#alternatives(receiver)) {
      if (part.kind === "input" || part.kind === "external") {
        continue;
      }
      if (part.kind !== "object") {
        return this.#fail(
          frame,
          node,
          "mutable field requires a known object and property",
        );
      }
      delete part.validation;
      if (
        (fieldName === undefined || fieldName === "__proto__") &&
        !(
          part.prototypeDisposition === "ordinary" &&
          part.fields.has("__proto__") &&
          !part.optionalFields?.has("__proto__")
        )
      ) {
        part.prototypeDisposition = "unmodeled";
      }
      // Aliases and branch frames share the object. Retain all possible field
      // values so a later branch cannot erase a previously reachable effect.
      part.keyStability = "mutable";
      if (fieldName === undefined) {
        part.unknownFields = this.#join(part.unknownFields, assigned);
      } else {
        if (!part.fields.has(fieldName)) {
          part.optionalFields ??= new Set<string>();
          part.optionalFields.add(fieldName);
        }
        part.fields.set(
          fieldName,
          this.#join(part.fields.get(fieldName) ?? this.#bottom, assigned),
        );
      }
    }
    // Opaque data has no cached fields or scope proof to invalidate. A plain
    // assignment returns its right operand; compound updates remain unknown.
    return node.type === "AssignmentExpression" && node.operator === "="
      ? value
      : { kind: "input" };
  };

  readonly #evaluateOther = (
    node: Node,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    if (isOrgGraphOtherExpression(node)) {
      return this.#evaluateModeledOther(node, frame);
    }
    if (node.type.startsWith("TS")) {
      return this.#fail(
        frame,
        node,
        `unsupported TypeScript runtime form ${node.type}`,
      );
    }
    walk(node, (child, ancestors) => {
      if (ancestors.length !== 1) {
        return undefined;
      }
      const value = this.#evaluate(child, frame);
      if (this.#relevant(value) || this.#containsCallable(value)) {
        this.#fail(
          frame,
          child,
          `unsupported ${node.type} carries a transaction/callback`,
        );
      }
      return "skip-children";
    });
    return this.#unknown(`unsupported value ${node.type}`);
  };

  readonly #evaluateModeledOther = (
    node: OrgGraphOtherExpression,
    frame: OrgGraphFrame,
  ): OrgGraphValue => {
    switch (node.type) {
      case "AssignmentExpression":
      case "UpdateExpression":
        return this.#evaluateOpaqueMutation(node, frame);
      case "ClassDeclaration": {
        const value = this.#taggedErrorClassValue(node, frame);
        if (value.kind !== "unknown") {
          return value;
        }
        return this.#fail(
          frame,
          node,
          "class instance/static method dispatch requires an owner model",
        );
      }
      case "ClassExpression":
        return this.#fail(
          frame,
          node,
          "class instance/static method dispatch requires an owner model",
        );
      case "NewExpression": {
        const constructor = this.#evaluate(node.callee, frame);
        const args = node.arguments.map((argument) =>
          argument.type === "SpreadElement"
            ? this.#fail(frame, argument, "constructor argument spread")
            : this.#evaluate(argument, frame),
        );
        const constructorParts = this.#alternatives(constructor);
        this.#assertNativeEvaluationOwner({ fn: constructor, frame, node });
        const taggedErrorConstructors = constructorParts.filter(
          (part) =>
            part.kind === "external" &&
            part.module === "better-result" &&
            part.name.startsWith(TAGGED_ERROR_CLASS_PREFIX),
        );
        if (taggedErrorConstructors.length > 0) {
          if (taggedErrorConstructors.length !== constructorParts.length) {
            return this.#fail(
              frame,
              node,
              "mixed tagged-error and ordinary constructor alternatives",
            );
          }
          if (args.length !== 1) {
            return this.#fail(
              frame,
              node,
              "tagged-error metadata requires one primitive message",
            );
          }
          const messages = this.#alternatives(args.at(0) ?? this.#bottom);
          if (
            messages.length === 0 ||
            messages.some(
              (message) =>
                !(
                  (message.kind === "literal" &&
                    typeof message.value === "string") ||
                  (message.kind === "input" && message.primitive === "string")
                ),
            )
          ) {
            return this.#fail(
              frame,
              node,
              "tagged-error metadata requires primitive values",
            );
          }
          return this.#join(
            ...taggedErrorConstructors.flatMap((candidate) => {
              if (
                candidate.kind !== "external" ||
                !candidate.name.startsWith(TAGGED_ERROR_CLASS_PREFIX)
              ) {
                return [];
              }
              const tag = candidate.name.slice(
                TAGGED_ERROR_CLASS_PREFIX.length,
                -1,
              );
              return messages.map((message): OrgGraphValue => ({
                kind: "object",
                prototypeDisposition: "ordinary",
                fields: new Map<string, OrgGraphValue>([
                  ["_tag", { kind: "literal", value: tag }],
                  ["message", message],
                ]),
                unknownFields: this.#bottom,
                keyStability: "fixed",
                propertyPresence: "open",
              }));
            }),
          );
        }
        if (
          constructor.kind === "external" &&
          constructor.module === "global" &&
          constructor.name === "Set"
        ) {
          return this.#constructSet({
            argument: args.at(0) ?? { kind: "literal", value: undefined },
            frame,
            node,
          });
        }
        if (
          args.some(
            (argument) =>
              this.#relevant(argument) || this.#containsCallable(argument),
          )
        ) {
          this.#fail(
            frame,
            node,
            "constructor receives transaction capability or callable",
          );
        }
        if (args.some((argument) => this.#containsValidationResult(argument))) {
          return this.#fail(
            frame,
            node,
            "constructor receives a validation result without a model",
          );
        }
        if (args.some((argument) => this.#containsNativeIdentity(argument))) {
          return this.#fail(
            frame,
            node,
            "constructor receives a native identity without a model",
          );
        }
        this.#assertNoOpaqueDataEscape({ values: args, frame, node });
        if (constructor.kind === "external") {
          return {
            kind: "external",
            module: constructor.module,
            name: `<instance:${constructor.name}>`,
          };
        }
        return this.#fail(
          frame,
          node,
          "source constructor dispatch requires an owner model",
        );
      }
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "TSDeclareFunction":
        return this.#unknown("type declaration");
      default:
        node satisfies never;
        return panic("Unreachable organization other expression");
    }
  };

  readonly #normalFlow = (frame: OrgGraphFrame): OrgGraphFlow => [
    { type: "normal", frame },
  ];

  readonly #sameCompletion = ({
    left,
    right,
  }: {
    left: OrgGraphCompletion;
    right: OrgGraphCompletion;
  }): boolean => {
    if (left.type !== right.type) {
      return false;
    }
    if (left.type === "break" || left.type === "continue") {
      return (
        (right.type === "break" || right.type === "continue") &&
        left.target === right.target
      );
    }
    return true;
  };

  readonly #resumeCompletion = (
    completion: OrgGraphCompletion,
    frame: OrgGraphFrame,
  ): OrgGraphCompletion => {
    switch (completion.type) {
      case "normal":
        return { type: "normal", frame };
      case "return":
        return { type: "return", value: completion.value, frame };
      case "throw":
        return { type: "throw", value: completion.value, frame };
      case "break":
        return { type: "break", target: completion.target, frame };
      case "continue":
        return { type: "continue", target: completion.target, frame };
      default:
        completion satisfies never;
        return panic("Unknown organization completion");
    }
  };

  readonly #mergeFlow = ({
    flow,
    frame,
  }: {
    flow: OrgGraphFlow;
    frame: OrgGraphFrame;
  }): OrgGraphFlow => {
    const groups: OrgGraphCompletion[][] = [];
    for (const completion of flow) {
      const group = groups.find((items) => {
        const first = items.at(0);
        return (
          first !== undefined &&
          this.#sameCompletion({ left: first, right: completion })
        );
      });
      if (group === undefined) {
        groups.push([completion]);
      } else {
        group.push(completion);
      }
    }
    return groups.map((items): OrgGraphCompletion => {
      const first = items.at(0) ?? panic("Empty organization completion group");
      const values = new Map<Identifier, OrgGraphValue>();
      for (const binding of first.frame.values.keys()) {
        if (!items.every((item) => item.frame.values.has(binding))) {
          continue;
        }
        const incoming = items.map(
          (item) =>
            item.frame.values.get(binding) ??
            panic("Missing completion binding"),
        );
        const signatures = new Set(
          incoming
            .flatMap((value) => this.#alternatives(value))
            .map((value) => this.#signature({ value })),
        );
        if (signatures.size > 128) {
          return this.#fail(
            frame,
            binding,
            `completion binding ${binding.name} exceeds its finite union domain (${signatures.size} alternatives)`,
          );
        }
        values.set(binding, this.#join(...incoming));
      }
      const joined =
        first.type === "normal" ? frame : { ...first.frame, values };
      if (first.type === "normal") {
        frame.values.clear();
        for (const [binding, value] of values) {
          frame.values.set(binding, value);
        }
      }
      switch (first.type) {
        case "return": {
          const returned = items.map((item) =>
            item.type === "return"
              ? item.value
              : panic("Mixed return completion"),
          );
          const alternatives = returned.flatMap((value) =>
            this.#alternatives(value),
          );
          if (alternatives.length > 128) {
            const domain = new Set(
              alternatives.map((value) => this.#signature({ value })),
            );
            if (domain.size > 128) {
              const kinds = new Map<string, number>();
              for (const value of alternatives) {
                kinds.set(value.kind, (kinds.get(value.kind) ?? 0) + 1);
              }
              const owner =
                frame.context === undefined
                  ? undefined
                  : this.#contexts.get(frame.context)?.fn.node;
              return this.#fail(
                frame,
                owner ?? frame.module.parsed.program,
                `return completion exceeds its finite union domain (${domain.size} alternatives; kinds ${JSON.stringify([...kinds])})`,
              );
            }
          }
          return {
            type: "return",
            value: this.#join(...returned),
            frame: joined,
          };
        }
        case "throw":
          return {
            type: "throw",
            value: this.#join(
              ...items.map((item) =>
                item.type === "throw"
                  ? item.value
                  : panic("Mixed throw completion"),
              ),
            ),
            frame: joined,
          };
        case "normal":
          return { type: "normal", frame: joined };
        case "break":
          return { type: "break", target: first.target, frame: joined };
        case "continue":
          return { type: "continue", target: first.target, frame: joined };
        default:
          first satisfies never;
          return panic("Unknown completion group");
      }
    });
  };

  readonly #functionFlowValue = ({
    flow,
    frame,
    node,
  }: {
    flow: OrgGraphFlow;
    frame: OrgGraphFrame;
    node: Node;
  }): OrgGraphValue =>
    this.#join(
      ...flow.flatMap((completion) => {
        switch (completion.type) {
          case "normal":
            return [
              { kind: "literal", value: undefined } satisfies OrgGraphValue,
            ];
          case "return":
            return [completion.value];
          case "throw":
            return [];
          case "break":
          case "continue":
            return this.#fail(
              frame,
              node,
              "loop completion escaped its owning statement",
            );
          default:
            completion satisfies never;
            return panic("Unknown function completion");
        }
      }),
    );

  readonly #executeList = (
    statements: readonly Node[],
    frame: OrgGraphFrame,
  ): OrgGraphFlow => {
    let flow = this.#normalFlow(frame);
    for (const statement of statements) {
      const next: OrgGraphCompletion[] = [];
      for (const completion of flow) {
        if (completion.type === "normal") {
          next.push(...this.#execute(statement, completion.frame));
        } else {
          next.push(completion);
        }
      }
      flow = this.#mergeFlow({ flow: next, frame });
      if (!flow.some((completion) => completion.type === "normal")) {
        break;
      }
    }
    return flow;
  };

  readonly #execute = (node: Node, frame: OrgGraphFrame): OrgGraphFlow => {
    if (!isOrgGraphStatement(node)) {
      this.#evaluate(node, frame);
      return this.#normalFlow(frame);
    }
    return this.#executeStatement(node, frame);
  };

  readonly #completionTarget = ({
    node,
    frame,
    type,
  }: {
    node: Node;
    frame: OrgGraphFrame;
    type: "break" | "continue";
  }): Node => {
    let current = frame.module.parents.get(node);
    while (current !== undefined && !this.#isFunctionNode(current)) {
      if (type === "break" && current.type === "SwitchStatement") {
        return current;
      }
      if (
        current.type === "ForOfStatement" ||
        (current.type === "ForStatement" &&
          frame.countedIteration?.loop === current)
      ) {
        return current;
      }
      if (
        current.type === "ForStatement" ||
        current.type === "ForInStatement" ||
        current.type === "WhileStatement" ||
        current.type === "DoWhileStatement"
      ) {
        return this.#fail(frame, node, "completion requires a modeled loop");
      }
      current = frame.module.parents.get(current);
    }
    return this.#fail(frame, node, "completion has no enclosing owner");
  };

  readonly #executeStatement = (
    node: OrgGraphStatement,
    frame: OrgGraphFrame,
  ): OrgGraphFlow => {
    switch (node.type) {
      case "Program":
      case "BlockStatement":
        return this.#executeList(node.body, frame);
      case "ExportNamedDeclaration":
        return node.declaration === null
          ? this.#normalFlow(frame)
          : this.#execute(node.declaration, frame);
      case "ExportDefaultDeclaration":
        this.#evaluate(node.declaration, frame);
        return this.#normalFlow(frame);
      case "VariableDeclaration":
        if (node.kind === "var" && !node.declare) {
          return this.#fail(
            frame,
            node,
            "function-scoped var bindings require an explicit binding model",
          );
        }
        for (const declaration of node.declarations) {
          this.#bind({
            pattern: declaration.id,
            value: node.declare
              ? { kind: "input" }
              : this.#evaluate(declaration.init, frame),
            frame,
          });
        }
        return this.#normalFlow(frame);
      case "FunctionDeclaration":
        return this.#normalFlow(frame);
      case "ExpressionStatement":
        this.#evaluate(node.expression, frame);
        return this.#normalFlow(frame);
      case "ReturnStatement":
        return [
          {
            type: "return",
            frame,
            value:
              node.argument === null
                ? { kind: "literal", value: undefined }
                : this.#evaluate(node.argument, frame),
          },
        ];
      case "ThrowStatement":
        return [
          { type: "throw", frame, value: this.#evaluate(node.argument, frame) },
        ];
      case "BreakStatement":
        if (node.label !== null) {
          return this.#fail(frame, node, "labelled break");
        }
        return [
          {
            type: "break",
            frame,
            target: this.#completionTarget({ node, frame, type: "break" }),
          },
        ];
      case "ContinueStatement":
        if (node.label !== null) {
          return this.#fail(frame, node, "labelled continue");
        }
        return [
          {
            type: "continue",
            frame,
            target: this.#completionTarget({ node, frame, type: "continue" }),
          },
        ];
      case "IfStatement":
        return this.#executeIf(node, frame);
      case "SwitchStatement":
        return this.#executeSwitch(node, frame);
      case "ForOfStatement":
        return this.#executeForOf(node, frame);
      case "ForStatement":
        return this.#executeCountedFor(node, frame);
      case "ForInStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        return this.#fail(
          frame,
          node,
          "loop form requires an abstract state fixed point",
        );
      case "TryStatement":
        return this.#executeTry(node, frame);
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "EmptyStatement":
        return this.#normalFlow(frame);
      default:
        node satisfies never;
        return panic("Unreachable organization statement");
    }
  };

  readonly #comparedLiteral = (
    node: Expression,
    frame: OrgGraphFrame,
  ): Extract<OrgGraphValue, { kind: "literal" }> | undefined => {
    const value = unwrapTypes(node);
    if (
      value.type === "Literal" &&
      (typeof value.value === "string" ||
        typeof value.value === "number" ||
        typeof value.value === "boolean" ||
        value.value === null)
    ) {
      return { kind: "literal", value: value.value };
    }
    if (
      value.type === "Identifier" &&
      value.name === "undefined" &&
      resolveDeclaration(value, frame.module.parents) === undefined
    ) {
      return { kind: "literal", value: undefined };
    }
    return undefined;
  };

  readonly #refineLocalBranch = ({
    test,
    truth,
    frame,
  }: {
    test: Expression;
    truth: boolean;
    frame: OrgGraphFrame;
  }): boolean => {
    const condition = unwrapTypes(test);
    if (condition.type === "UnaryExpression" && condition.operator === "!") {
      return this.#refineLocalBranch({
        test: condition.argument,
        truth: !truth,
        frame,
      });
    }
    if (
      condition.type !== "BinaryExpression" ||
      (condition.operator !== "===" && condition.operator !== "!==")
    ) {
      return true;
    }
    for (const [candidate, compared] of [
      [condition.left, condition.right],
      [condition.right, condition.left],
    ]) {
      if (candidate === undefined || compared === undefined) {
        return panic("Missing comparison operand");
      }
      const literal = this.#comparedLiteral(compared, frame);
      if (literal === undefined) {
        continue;
      }
      const subject = unwrapTypes(candidate);
      let reference: Identifier | undefined;
      if (subject.type === "Identifier") {
        reference = subject;
      } else if (
        subject.type === "MemberExpression" &&
        !subject.optional &&
        subject.object.type === "Identifier"
      ) {
        reference = subject.object;
      }
      if (reference === undefined) {
        continue;
      }
      const binding = resolveDeclaration(reference, frame.module.parents);
      if (binding === undefined || !frame.values.has(binding)) {
        continue;
      }
      const owner = this.#localBindingOwner(binding, frame);
      if (
        owner === undefined ||
        this.#bindingIsCaptured({ binding, owner, frame }) ||
        this.#hasDirectEval(owner)
      ) {
        continue;
      }
      const property =
        subject.type === "MemberExpression"
          ? this.#graphAccessName(subject)
          : undefined;
      if (subject.type === "MemberExpression" && property === undefined) {
        continue;
      }
      const value =
        frame.values.get(binding) ?? panic("Missing compared local binding");
      const equals = (condition.operator === "===") === truth;
      frame.values.set(
        binding,
        this.#join(
          ...this.#alternatives(value).filter((part) => {
            let selected = part;
            if (property !== undefined) {
              if (
                part.kind !== "object" ||
                part.prototypeDisposition !== "ordinary" ||
                part.keyStability !== "fixed" ||
                part.propertyPresence !== "closed" ||
                part.unknownFields.kind !== "bottom" ||
                part.optionalFields?.has(property)
              ) {
                return true;
              }
              const field = part.fields.get(property);
              if (field === undefined) {
                return true;
              }
              selected = field;
            }
            if (selected.kind === "literal") {
              return (selected.value === literal.value) === equals;
            }
            if (
              property === undefined &&
              (literal.value === undefined || literal.value === null) &&
              (this.#knownNonNullReference(selected) ||
                (selected.kind === "input" && selected.primitive !== undefined))
            ) {
              return !equals;
            }
            return true;
          }),
        ),
      );
      if (frame.values.get(binding)?.kind === "bottom") {
        return false;
      }
    }
    return true;
  };

  readonly #executeIf = (
    node: Extract<Node, { type: "IfStatement" }>,
    frame: OrgGraphFrame,
  ): OrgGraphFlow => {
    const condition = this.#truth(this.#evaluate(node.test, frame));
    if (condition === true) {
      return this.#execute(node.consequent, frame);
    }
    if (condition === false) {
      return node.alternate === null
        ? this.#normalFlow(frame)
        : this.#execute(node.alternate, frame);
    }
    const leftFrame = this.#forkFrame(frame);
    const left = this.#refineLocalBranch({
      test: node.test,
      truth: true,
      frame: leftFrame,
    })
      ? this.#execute(node.consequent, leftFrame)
      : [];
    const rightFrame = this.#forkFrame(frame);
    let right: OrgGraphFlow;
    if (
      !this.#refineLocalBranch({
        test: node.test,
        truth: false,
        frame: rightFrame,
      })
    ) {
      right = [];
    } else if (node.alternate === null) {
      right = this.#normalFlow(rightFrame);
    } else {
      right = this.#execute(node.alternate, rightFrame);
    }
    return this.#mergeFlow({ flow: [...left, ...right], frame });
  };

  readonly #executeSwitch = (
    node: Extract<Node, { type: "SwitchStatement" }>,
    frame: OrgGraphFrame,
  ): OrgGraphFlow => {
    const discriminant = this.#evaluate(node.discriminant, frame);
    const result: OrgGraphCompletion[] = [];
    for (const part of this.#alternatives(discriminant)) {
      const starts: number[] = [];
      let fallback: number | undefined;
      for (const [index, clause] of node.cases.entries()) {
        if (clause.test === null) {
          fallback = index;
          continue;
        }
        const test = this.#evaluate(clause.test, frame);
        if (
          part.kind !== "literal" ||
          test.kind !== "literal" ||
          part.value === test.value
        ) {
          starts.push(index);
        }
      }
      if (starts.length === 0 && fallback !== undefined) {
        starts.push(fallback);
      }
      if (part.kind !== "literal" && fallback !== undefined) {
        starts.push(fallback);
      }
      if (
        starts.length === 0 ||
        (part.kind !== "literal" && fallback === undefined)
      ) {
        result.push(...this.#normalFlow(this.#forkFrame(frame)));
      }
      for (const start of starts) {
        const branch = this.#forkFrame(frame);
        let flow = this.#normalFlow(branch);
        for (const clause of node.cases.slice(start)) {
          const next: OrgGraphCompletion[] = [];
          for (const completion of flow) {
            if (completion.type === "normal") {
              next.push(
                ...this.#executeList(clause.consequent, completion.frame),
              );
            } else {
              next.push(completion);
            }
          }
          flow = this.#mergeFlow({ flow: next, frame: branch });
          if (!flow.some((completion) => completion.type === "normal")) {
            break;
          }
        }
        for (const completion of flow) {
          result.push(
            completion.type === "break" && completion.target === node
              ? { type: "normal", frame: completion.frame }
              : completion,
          );
        }
      }
    }
    return this.#mergeFlow({ flow: result, frame });
  };

  readonly #bindingOutlivesIteration = ({
    binding,
    loop,
    frame,
  }: {
    binding: Identifier;
    loop: Extract<Node, { type: "ForOfStatement" | "ForStatement" }>;
    frame: OrgGraphFrame;
  }): boolean => {
    let current: Node | undefined = binding;
    while (current !== undefined && current !== loop) {
      if (current.type === "VariableDeclaration" && current.kind === "var") {
        return true;
      }
      current = frame.module.parents.get(current);
    }
    return current !== loop;
  };

  readonly #boundedNumber = (
    node: Expression,
    frame: OrgGraphFrame,
  ): OrgGraphNumberRange => {
    const expression = unwrapTypes(node);
    const checked = ({
      minimum,
      maximum,
    }: OrgGraphNumberRange): OrgGraphNumberRange => {
      if (
        !Number.isFinite(minimum) ||
        !Number.isFinite(maximum) ||
        Math.abs(minimum) > Number.MAX_SAFE_INTEGER ||
        Math.abs(maximum) > Number.MAX_SAFE_INTEGER ||
        minimum > maximum
      ) {
        return this.#fail(
          frame,
          node,
          "counted loop requires a finite numeric bound",
        );
      }
      return { minimum, maximum };
    };
    if (expression.type === "MemberExpression") {
      if (
        expression.optional ||
        this.#graphAccessName(expression) !== "length"
      ) {
        return this.#fail(
          frame,
          expression,
          "counted loop requires a finite array extent",
        );
      }
      const receiver = this.#evaluate(expression.object, frame);
      let minimum = Infinity;
      let maximum = -Infinity;
      for (const part of this.#alternatives(receiver)) {
        if (part.kind !== "array" || part.extent.type !== "finite") {
          return this.#fail(
            frame,
            expression,
            "counted loop requires a finite array extent",
          );
        }
        const lower = part.stability === "fixed" ? part.values.length : 0;
        if (part.extent.maximum < lower) {
          return panic("Array extent excludes a fixed array length");
        }
        minimum = Math.min(minimum, lower);
        maximum = Math.max(maximum, part.extent.maximum);
      }
      return checked({ minimum, maximum });
    }
    if (
      expression.type === "BinaryExpression" &&
      (expression.operator === "+" || expression.operator === "-")
    ) {
      const left = this.#boundedNumber(expression.left, frame);
      const right = this.#boundedNumber(expression.right, frame);
      return expression.operator === "+"
        ? checked({
            minimum: left.minimum + right.minimum,
            maximum: left.maximum + right.maximum,
          })
        : checked({
            minimum: left.minimum - right.maximum,
            maximum: left.maximum - right.minimum,
          });
    }
    if (
      expression.type === "UnaryExpression" &&
      (expression.operator === "+" || expression.operator === "-")
    ) {
      const argument = this.#boundedNumber(expression.argument, frame);
      return expression.operator === "+"
        ? argument
        : checked({ minimum: -argument.maximum, maximum: -argument.minimum });
    }
    if (expression.type !== "Literal" && expression.type !== "Identifier") {
      return this.#fail(
        frame,
        expression,
        "counted loop requires a finite numeric bound",
      );
    }
    if (expression.type === "Identifier") {
      const binding = resolveDeclaration(expression, frame.module.parents);
      if (binding === undefined || !frame.values.has(binding)) {
        return this.#fail(
          frame,
          expression,
          "counted loop bound requires an initialized numeric binding",
        );
      }
    }
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const part of this.#alternatives(this.#evaluate(expression, frame))) {
      if (part.kind !== "literal" || typeof part.value !== "number") {
        return this.#fail(
          frame,
          expression,
          "counted loop requires a finite numeric bound",
        );
      }
      minimum = Math.min(minimum, part.value);
      maximum = Math.max(maximum, part.value);
    }
    return checked({ minimum, maximum });
  };

  readonly #countedStateFrame = ({
    state,
    outer,
    loop,
    iteration,
  }: {
    state: OrgGraphFrame;
    outer: OrgGraphFrame;
    loop: Extract<Node, { type: "ForStatement" }>;
    iteration?: OrgGraphCountedIteration;
  }): OrgGraphFrame => {
    const values = new Map<Identifier, OrgGraphValue>();
    for (const [binding, value] of state.values) {
      if (
        binding === iteration?.counter ||
        this.#bindingOutlivesIteration({ binding, loop, frame: state })
      ) {
        values.set(binding, value);
      }
    }
    const frame = {
      ...outer,
      values,
      lexicalParents: [outer.values, ...(outer.lexicalParents ?? [])],
    };
    return iteration === undefined
      ? frame
      : {
          ...frame,
          countedIteration: iteration,
          loopAllocations: [
            ...(outer.loopAllocations ?? []),
            { start: loop.start, end: loop.end, position: iteration.position },
          ],
        };
  };

  readonly #assertCountedLoopBodyDoesNotAssignCounter = ({
    node,
    frame,
    counter,
  }: {
    node: Extract<Node, { type: "ForStatement" }>;
    frame: OrgGraphFrame;
    counter: Identifier;
  }): void => {
    walk(node.body, (child) => {
      let target: Node | undefined;
      if (child.type === "AssignmentExpression") {
        target = child.left;
      } else if (child.type === "UpdateExpression") {
        target = child.argument;
      }
      if (
        target?.type === "Identifier" &&
        resolveDeclaration(target, frame.module.parents) === counter
      ) {
        this.#fail(
          frame,
          child,
          "counted loop body cannot assign its induction variable",
        );
      }
    });
  };

  readonly #assertCountedLoopTestAndUpdate = ({
    node,
    frame,
    counter,
  }: {
    node: Extract<Node, { type: "ForStatement" }>;
    frame: OrgGraphFrame;
    counter: Identifier;
  }): Extract<Node, { type: "BinaryExpression" }> => {
    const test = node.test === null ? undefined : unwrapTypes(node.test);
    if (
      test?.type !== "BinaryExpression" ||
      test.operator !== "<" ||
      test.left.type !== "Identifier" ||
      resolveDeclaration(test.left, frame.module.parents) !== counter
    ) {
      return this.#fail(
        frame,
        node,
        "counted loop requires a strict numeric induction test",
      );
    }
    const update = node.update === null ? undefined : unwrapTypes(node.update);
    if (
      update?.type !== "AssignmentExpression" ||
      update.operator !== "+=" ||
      update.left.type !== "Identifier" ||
      resolveDeclaration(update.left, frame.module.parents) !== counter ||
      update.right.type !== "Literal" ||
      update.right.value !== 1
    ) {
      return this.#fail(
        frame,
        node,
        "counted loop update requires a numeric unit increment",
      );
    }
    return test;
  };

  readonly #executeCountedFor = (
    node: Extract<Node, { type: "ForStatement" }>,
    frame: OrgGraphFrame,
  ): OrgGraphFlow => {
    const init = node.init;
    if (
      init?.type !== "VariableDeclaration" ||
      init.kind !== "let" ||
      init.declare ||
      init.declarations.length !== 1
    ) {
      return this.#fail(
        frame,
        node,
        "counted loop requires one initialized local let binding",
      );
    }
    const declaration = init.declarations.at(0);
    if (
      declaration === undefined ||
      declaration.id.type !== "Identifier" ||
      declaration.init === null
    ) {
      return this.#fail(
        frame,
        node,
        "counted loop requires one initialized local let binding",
      );
    }
    const counter = declaration.id;
    const owner = this.#localBindingOwner(counter, frame);
    if (owner === undefined) {
      return this.#fail(
        frame,
        node,
        "counted loop requires a local let binding",
      );
    }
    if (this.#bindingIsCaptured({ binding: counter, owner, frame })) {
      return this.#fail(
        frame,
        node,
        "captured mutable binding requires a shared lexical store",
      );
    }
    if (this.#hasDirectEval(owner)) {
      return this.#fail(
        frame,
        node,
        "dynamic lexical evaluation prevents a counted loop proof",
      );
    }
    const test = this.#assertCountedLoopTestAndUpdate({ node, frame, counter });
    this.#assertCountedLoopBodyDoesNotAssignCounter({ node, frame, counter });
    const initial = this.#forkFrame(frame);
    this.#execute(init, initial);
    const start = initial.values.get(counter);
    if (
      start?.kind !== "literal" ||
      typeof start.value !== "number" ||
      !Number.isSafeInteger(start.value)
    ) {
      return this.#fail(
        frame,
        node,
        "counted loop requires a safe integer induction value",
      );
    }
    let position = start.value;
    let active: OrgGraphFrame | undefined = initial;
    let range = this.#boundedNumber(test.right, initial);
    const maximum = range.maximum;
    const required = Math.max(0, Math.ceil(maximum - position));
    if (
      !Number.isSafeInteger(required) ||
      required > ORG_GRAPH_FINITE_WORK_BUDGET - this.#loopSteps
    ) {
      return this.#fail(
        frame,
        node,
        "counted loop exceeds its finite work budget",
      );
    }
    const outcomes: OrgGraphCompletion[] = [];
    while (active !== undefined) {
      if (range.maximum > maximum) {
        return this.#fail(
          frame,
          node,
          "counted loop bound grew beyond its finite proof",
        );
      }
      if (position >= range.maximum) {
        outcomes.push({
          type: "normal",
          frame: this.#countedStateFrame({
            state: active,
            outer: frame,
            loop: node,
          }),
        });
        break;
      }
      if (++this.#loopSteps > ORG_GRAPH_FINITE_WORK_BUDGET) {
        return this.#fail(
          frame,
          node,
          "counted loop exceeds its finite work budget",
        );
      }
      if (position >= range.minimum) {
        outcomes.push({
          type: "normal",
          frame: this.#countedStateFrame({
            state: active,
            outer: frame,
            loop: node,
          }),
        });
      }
      const branch = this.#countedStateFrame({
        state: active,
        outer: frame,
        loop: node,
        iteration: { loop: node, counter, position },
      });
      const next: OrgGraphCompletion[] = [];
      for (const completion of this.#execute(node.body, branch)) {
        if (
          completion.type === "normal" ||
          (completion.type === "continue" && completion.target === node)
        ) {
          const current = completion.frame.values.get(counter);
          if (
            current?.kind !== "literal" ||
            !Object.is(current.value, position)
          ) {
            return this.#fail(
              frame,
              node,
              "counted loop lost its induction variable proof",
            );
          }
          const updated = this.#countedStateFrame({
            state: completion.frame,
            outer: frame,
            loop: node,
            iteration: { loop: node, counter, position: position + 1 },
          });
          updated.values.set(counter, { kind: "literal", value: position + 1 });
          next.push({ type: "normal", frame: updated });
        } else {
          const outside = this.#countedStateFrame({
            state: completion.frame,
            outer: frame,
            loop: node,
          });
          outcomes.push(
            completion.type === "break" && completion.target === node
              ? { type: "normal", frame: outside }
              : this.#resumeCompletion(completion, outside),
          );
        }
      }
      position += 1;
      const carrier = this.#countedStateFrame({
        state: active,
        outer: frame,
        loop: node,
        iteration: { loop: node, counter, position },
      });
      const continuing = this.#mergeFlow({ flow: next, frame: carrier }).at(0);
      active = continuing?.type === "normal" ? continuing.frame : undefined;
      if (active !== undefined) {
        range = this.#boundedNumber(test.right, active);
      }
    }
    return this.#mergeFlow({ flow: outcomes, frame });
  };

  readonly #assertForOfVarBindings = (
    node: Extract<Node, { type: "ForOfStatement" }>,
    frame: OrgGraphFrame,
  ): void => {
    if (node.left.type !== "VariableDeclaration" || node.left.kind !== "var") {
      return;
    }
    const fail = () =>
      this.#fail(
        frame,
        node.left,
        "function-scoped var bindings require an explicit binding model",
      );
    let owner: Node | undefined = node;
    while (owner !== undefined && !this.#isFunctionNode(owner)) {
      owner = frame.module.parents.get(owner);
    }
    const context =
      frame.context === undefined
        ? undefined
        : this.#contexts.get(frame.context);
    if (
      owner === undefined ||
      !this.#isFunctionNode(owner) ||
      owner !== context?.fn.node ||
      this.#hasDirectEval(owner)
    ) {
      return fail();
    }
    const nearestFunction = (value: Node): Node | undefined => {
      let current = frame.module.parents.get(value);
      while (current !== undefined && !this.#isFunctionNode(current)) {
        current = frame.module.parents.get(current);
      }
      return current;
    };
    for (const declaration of node.left.declarations) {
      for (const binding of bindingIdentifiers(declaration.id)) {
        let declarations = 0;
        let invalid = owner.params.some((parameter) =>
          [
            ...bindingIdentifiers(
              parameter.type === "TSParameterProperty"
                ? parameter.parameter
                : parameter,
            ),
          ].some((parameterBinding) => parameterBinding.name === binding.name),
        );
        walk(owner, (child) => {
          if (child.type === "VariableDeclaration" && child.kind === "var") {
            for (const variable of child.declarations) {
              for (const declared of bindingIdentifiers(variable.id)) {
                if (
                  declared.name === binding.name &&
                  nearestFunction(declared) === owner
                ) {
                  declarations += 1;
                }
              }
            }
          }
          if (
            child.type === "FunctionDeclaration" &&
            child.id?.name === binding.name &&
            nearestFunction(child) === owner
          ) {
            invalid = true;
          }
          if (
            child.type !== "Identifier" ||
            child.name !== binding.name ||
            !isReferencePosition(child, frame.module.parents) ||
            (child.start === binding.start && child.end === binding.end)
          ) {
            return;
          }
          if (
            resolveDeclaration(child, frame.module.parents) !== binding ||
            nearestFunction(child) !== owner ||
            child.start < node.body.start ||
            child.end > node.body.end
          ) {
            invalid = true;
          }
        });
        if (invalid || declarations !== 1) {
          return fail();
        }
      }
    }
  };

  readonly #executeForOf = (
    node: Extract<Node, { type: "ForOfStatement" }>,
    frame: OrgGraphFrame,
  ): OrgGraphFlow => {
    if (node.left.type !== "VariableDeclaration") {
      return this.#fail(
        frame,
        node.left,
        "for-of assignment requires an explicit mutation model",
      );
    }
    this.#assertForOfVarBindings(node, frame);
    const collection = this.#guardedArrayReceiver({
      call: node,
      receiver: node.right,
      value: this.#evaluate(node.right, frame),
      frame,
    });
    const outcomes: OrgGraphCompletion[] = [];
    for (const part of this.#alternatives(collection)) {
      let values: readonly OrgGraphValue[];
      if (part.kind === "array" || part.kind === "set") {
        values = part.values;
      } else if (part.kind === "input") {
        values = [part];
      } else {
        return this.#fail(
          frame,
          node.right,
          `unsupported for-of iterable (${part.kind})`,
        );
      }
      for (const value of values) {
        const branch = this.#forkFrame(frame);
        const declaration =
          node.left.declarations.at(0) ?? panic("Missing for-of binding");
        this.#bind({
          pattern: declaration.id,
          value: node.await
            ? this.#awaitValue({ value, frame: branch, node })
            : value,
          frame: branch,
        });
        for (const completion of this.#execute(node.body, branch)) {
          const projected = this.#forkFrame(frame);
          for (const [binding, child] of completion.frame.values) {
            if (
              this.#bindingOutlivesIteration({ binding, loop: node, frame })
            ) {
              projected.values.set(
                binding,
                this.#join(
                  projected.values.get(binding) ?? this.#bottom,
                  child,
                ),
              );
            }
          }
          if (
            completion.type === "normal" ||
            ((completion.type === "break" || completion.type === "continue") &&
              completion.target === node)
          ) {
            outcomes.push({ type: "normal", frame: projected });
          } else {
            outcomes.push(this.#resumeCompletion(completion, projected));
          }
        }
      }
    }
    // A mutable iterable describes possible values, not a complete runtime
    // sequence. Preserve the existing conservative empty/continuing path.
    outcomes.push(...this.#normalFlow(frame));
    return this.#mergeFlow({ flow: outcomes, frame });
  };

  readonly #inertThrowOperand = (
    node: Expression,
    frame: OrgGraphFrame,
  ): boolean => {
    const value = unwrapTypes(node);
    switch (value.type) {
      case "Literal":
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return true;
      case "Identifier": {
        const binding = resolveDeclaration(value, frame.module.parents);
        if (binding === undefined) {
          return (
            value.name === "undefined" ||
            value.name === "NaN" ||
            value.name === "Infinity"
          );
        }
        if (frame.values.has(binding)) {
          return true;
        }
        const parent = frame.module.parents.get(binding);
        return (
          parent?.type === "ImportSpecifier" ||
          parent?.type === "ImportDefaultSpecifier" ||
          parent?.type === "ImportNamespaceSpecifier"
        );
      }
      case "ObjectExpression":
        return value.properties.every(
          (property) =>
            property.type === "Property" &&
            property.kind === "init" &&
            !property.method &&
            !property.computed &&
            this.#inertThrowOperand(property.value, frame),
        );
      case "ArrayExpression":
        return value.elements.every(
          (element) =>
            element === null ||
            (element.type !== "SpreadElement" &&
              this.#inertThrowOperand(element, frame)),
        );
      default:
        return false;
    }
  };

  readonly #mayThrowImplicitly = (
    node: Node,
    frame: OrgGraphFrame,
  ): boolean => {
    switch (node.type) {
      case "BlockStatement":
        return node.body.some((statement) =>
          this.#mayThrowImplicitly(statement, frame),
        );
      case "ReturnStatement":
        return (
          node.argument !== null &&
          !this.#inertThrowOperand(node.argument, frame)
        );
      case "ThrowStatement":
        return !this.#inertThrowOperand(node.argument, frame);
      case "EmptyStatement":
      case "FunctionDeclaration":
        return false;
      default:
        return true;
    }
  };

  readonly #executeTry = (
    node: Extract<Node, { type: "TryStatement" }>,
    frame: OrgGraphFrame,
  ): OrgGraphFlow => {
    const implicit = this.#mayThrowImplicitly(node.block, frame);
    const body = [...this.#execute(node.block, this.#forkFrame(frame))];
    if (implicit) {
      body.push({
        type: "throw",
        frame: this.#forkFrame(frame),
        value: this.#unknown("implicit exception"),
      });
    }
    const handled: OrgGraphCompletion[] = [];
    for (const completion of body) {
      if (completion.type !== "throw" || node.handler === null) {
        handled.push(completion);
        continue;
      }
      const caught = this.#forkFrame(completion.frame);
      if (node.handler.param !== null) {
        this.#bind({
          pattern: node.handler.param,
          value: completion.value,
          frame: caught,
        });
      }
      handled.push(...this.#execute(node.handler.body, caught));
    }
    if (node.finalizer === null) {
      return this.#mergeFlow({ flow: handled, frame });
    }
    const finalized: OrgGraphCompletion[] = [];
    for (const completion of handled) {
      for (const final of this.#execute(
        node.finalizer,
        this.#forkFrame(completion.frame),
      )) {
        finalized.push(
          final.type === "normal"
            ? this.#resumeCompletion(completion, final.frame)
            : final,
        );
      }
    }
    return this.#mergeFlow({ flow: finalized, frame });
  };

  readonly #enqueueDependencyExport = (
    { file, name }: { file: string; name: string },
    state: OrgGraphDependencyState,
  ): boolean => {
    // The VM models this native admission's callback receiver; its implementation
    // dependencies do not turn an admitted caller into a root-handle importer.
    if (file === this.#scopeFile && name === "withOrgScope") {
      return false;
    }
    if (
      file === this.#rootFile &&
      (name === "*" || isRootConnectionExport(name))
    ) {
      return true;
    }
    if (
      file === this.#clientFile &&
      (name === "createDatabase" || name === "createSqlClient")
    ) {
      return true;
    }
    const key = `${file}#${name}`;
    if (state.exports.has(key)) {
      return false;
    }
    state.exports.add(key);
    const targets = this.#exportTargets({ file, name });
    if (targets.length === 0 && name !== "*") {
      return panic(
        `Unresolved organization write graph: missing dependency export ${key}`,
      );
    }
    for (const target of targets) {
      switch (target.kind) {
        case "binding":
          if (target.binding === undefined) {
            return panic(`Missing dependency binding ${key}`);
          }
          state.pending.push({
            kind: "binding",
            file: target.declarationFile,
            binding: target.binding,
          });
          break;
        case "expression":
          state.pending.push({
            kind: "node",
            file: target.declarationFile,
            node: target.expression,
          });
          break;
        case "namespace":
          if (
            this.#enqueueDependencyExport(
              { file: target.targetFile, name: "*" },
              state,
            )
          ) {
            return true;
          }
          break;
        case "external": {
          if (SCHEMA_MODULE.test(target.specifier)) {
            break;
          }
          const local = this.#localPath({
            from: target.declarationFile,
            specifier: target.specifier,
          });
          if (
            local !== undefined &&
            this.#enqueueDependencyExport(
              { file: local, name: target.name },
              state,
            )
          ) {
            return true;
          }
          break;
        }
        default:
          target satisfies never;
          return panic("Unknown organization dependency export");
      }
    }
    return false;
  };

  readonly #enqueueDependencyBinding = (
    {
      file,
      binding,
      member,
    }: { file: string; binding: Identifier; member?: string },
    state: OrgGraphDependencyState,
  ): boolean => {
    const module = this.#moduleAt(file);
    const holder = module.parents.get(binding);
    if (holder === undefined) {
      return false;
    }
    if (
      holder.type === "ImportSpecifier" ||
      holder.type === "ImportDefaultSpecifier" ||
      holder.type === "ImportNamespaceSpecifier"
    ) {
      const declaration = module.parents.get(holder);
      if (
        declaration?.type !== "ImportDeclaration" ||
        declaration.importKind === "type" ||
        (holder.type === "ImportSpecifier" && holder.importKind === "type")
      ) {
        return false;
      }
      if (SCHEMA_MODULE.test(declaration.source.value)) {
        return false;
      }
      if (isDataImport(declaration)) {
        return false;
      }
      const target = this.#localPath({
        from: file,
        specifier: declaration.source.value,
      });
      if (target === undefined) {
        return false;
      }
      let name: string;
      if (holder.type === "ImportDefaultSpecifier") {
        name = "default";
      } else if (holder.type === "ImportNamespaceSpecifier") {
        name = member ?? "*";
      } else if (holder.imported.type === "Identifier") {
        name = holder.imported.name;
      } else {
        name = holder.imported.value;
      }
      return this.#enqueueDependencyExport({ file: target, name }, state);
    }
    if (
      (this.#isFunctionNode(holder) && holder.id === binding) ||
      (holder.type === "ClassDeclaration" && holder.id === binding)
    ) {
      state.pending.push({ kind: "node", file, node: holder });
      return false;
    }
    let ancestor: Node | undefined = holder;
    while (
      ancestor !== undefined &&
      ancestor.type !== "VariableDeclarator" &&
      !this.#isFunctionNode(ancestor) &&
      ancestor.type !== "ClassDeclaration"
    ) {
      ancestor = module.parents.get(ancestor);
    }
    if (ancestor?.type === "VariableDeclarator" && ancestor.init !== null) {
      state.pending.push({ kind: "node", file, node: ancestor.init });
    }
    return false;
  };

  readonly #walkRootDependency = (
    { file, node }: { file: string; node: Node },
    state: OrgGraphDependencyState,
  ): boolean => {
    const module = this.#moduleAt(file);
    let found = false;
    walk(node, (child) => {
      if (found) {
        return "skip-children";
      }
      if (child.type === "ImportDeclaration") {
        return "skip-children";
      }
      if (child.type === "ImportExpression") {
        const specifier = stringValue(child.source);
        if (specifier === undefined) {
          found = true;
          return "skip-children";
        }
        const target = this.#localPath({
          from: file,
          specifier,
        });
        if (target !== undefined) {
          found = this.#enqueueDependencyExport(
            { file: target, name: "*" },
            state,
          );
        }
      }
      if (
        child.type === "CallExpression" &&
        child.callee.type === "Identifier" &&
        child.callee.name === "require" &&
        resolveDeclaration(child.callee, module.parents) === undefined
      ) {
        const specifier = stringValue(child.arguments.at(0));
        if (specifier === undefined) {
          found = true;
          return "skip-children";
        }
        const target = this.#localPath({
          from: file,
          specifier,
        });
        if (target !== undefined) {
          found = this.#enqueueDependencyExport(
            { file: target, name: "*" },
            state,
          );
        }
      }
      if (
        child.type !== "Identifier" ||
        !isReferencePosition(child, module.parents)
      ) {
        return undefined;
      }
      const binding = resolveDeclaration(child, module.parents);
      if (binding === undefined) {
        return undefined;
      }
      const parent = module.parents.get(child);
      const member =
        parent?.type === "MemberExpression" && parent.object === child
          ? accessName(parent)
          : undefined;
      if (
        this.#enqueueDependencyBinding(
          { file, binding, ...(member === undefined ? {} : { member }) },
          state,
        )
      ) {
        found = true;
      }
      return undefined;
    });
    return found;
  };

  readonly #dependsOnRoot = ({
    file,
    node,
  }: {
    file: string;
    node: Node;
  }): boolean => {
    const key = `${file}:${node.start}:${node.end}`;
    const cached = this.#rootDependencies.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const state: OrgGraphDependencyState = {
      pending: [{ kind: "node", file, node }],
      exports: new Set(),
    };
    const visited = new Set<string>();
    for (let cursor = 0; cursor < state.pending.length; cursor += 1) {
      if (cursor >= ORG_GRAPH_FINITE_WORK_BUDGET) {
        return panic(
          "Organization root dependency graph exceeds its finite work budget",
        );
      }
      const work =
        state.pending.at(cursor) ?? panic("Missing dependency work item");
      const identity = work.kind === "binding" ? work.binding : work.node;
      const workKey = `${work.kind}:${work.file}:${identity.start}:${identity.end}`;
      if (visited.has(workKey)) {
        continue;
      }
      visited.add(workKey);
      const found =
        work.kind === "binding"
          ? this.#enqueueDependencyBinding(
              { file: work.file, binding: work.binding },
              state,
            )
          : this.#walkRootDependency(work, state);
      if (found) {
        this.#rootDependencies.set(key, true);
        return true;
      }
    }
    this.#rootDependencies.set(key, false);
    return false;
  };

  readonly #discoverEntries = (): readonly OrgWriteGraphEntry[] => {
    const reasons = new Map<
      string,
      Set<OrgWriteGraphEntry["reasons"][number]>
    >();
    const addEntry = (
      file: string,
      reason: OrgWriteGraphEntry["reasons"][number],
    ): void => {
      if (!this.#options.sources.has(file)) {
        panic(
          `Unresolved organization write graph: missing ${reason} owner ${file}`,
        );
      }
      const existing = reasons.get(file) ?? new Set();
      existing.add(reason);
      reasons.set(file, existing);
    };
    for (const file of this.#options.rootDoorFiles) {
      addEntry(file, "root-door");
    }
    for (const file of this.#options.policyEntryFiles) {
      addEntry(file, "policy-owner");
    }
    for (const file of this.#options.recoveryOwnerFiles) {
      this.#moduleAt(file);
    }
    for (const file of this.#options.entryFiles ??
      this.#options.sources.keys()) {
      const content =
        this.#options.sources.get(file) ??
        panic(`Missing entry source ${file}`);
      if (countRootConnectionImports(content, file) > 0) {
        addEntry(file, "root-import");
      }
      const module = this.#moduleAt(file);
      for (const statement of module.parsed.program.body) {
        if (
          statement.type !== "ImportDeclaration" &&
          statement.type !== "ExportNamedDeclaration" &&
          statement.type !== "ExportAllDeclaration"
        ) {
          continue;
        }
        if (statement.source === null) {
          continue;
        }
        if (
          (statement.type === "ImportDeclaration" &&
            statement.importKind === "type") ||
          (statement.type !== "ImportDeclaration" &&
            statement.exportKind === "type")
        ) {
          continue;
        }
        const target = this.#localPath({
          from: file,
          specifier: statement.source.value,
        });
        if (
          target !== undefined &&
          this.#options.recoveryOwnerFiles.has(target)
        ) {
          addEntry(file, "recovery-caller");
        }
      }
    }
    for (const file of this.#options.entryFiles ??
      this.#options.sources.keys()) {
      const module = this.#moduleAt(file);
      walk(module.parsed.program, (node) => {
        if (node.type !== "ImportExpression") {
          return;
        }
        const specifier = stringValue(node.source);
        if (specifier === undefined) {
          addEntry(file, "unresolved-import");
          return;
        }
        const target = this.#localPath({
          from: file,
          specifier,
        });
        if (target === undefined) {
          return;
        }
        if (this.#options.recoveryOwnerFiles.has(target)) {
          addEntry(file, "recovery-caller");
        }
      });
    }
    for (const file of this.#options.entryFiles ??
      this.#options.sources.keys()) {
      const module = this.#moduleAt(file);
      if (
        this.#dependsOnRoot({
          file,
          node: module.parsed.program,
        })
      ) {
        addEntry(file, "delegate-import");
      }
    }
    const entries = [...reasons]
      .toSorted(([a], [b]) => compareCodeUnit(a, b))
      .map(([file, declared]) => ({ file, reasons: [...declared].toSorted() }));
    return entries;
  };

  readonly #seedEntry = (entry: OrgWriteGraphEntry): void => {
    const persistentRoots = [...this.#moduleHeap];
    const heapBefore = this.#persistentHeapSnapshot(persistentRoots);
    const module = this.#moduleAt(entry.file);
    const frame: OrgGraphFrame = {
      executionMode: "ordinary",
      module,
      values: new Map(),
      entry: entry.file,
      trace: new Map(),
      context: undefined,
    };
    this.#execute(module.parsed.program, frame);
    this.#assertNoContainerCycles();
    const entryValues: OrgGraphValue[] = [];
    for (const statement of module.parsed.program.body) {
      if (
        statement.type === "ExportAllDeclaration" &&
        entry.reasons.some((reason) => reason !== "recovery-caller")
      ) {
        this.#fail(
          frame,
          statement,
          "entry export-star/namespace requires a total export universe",
        );
      }
      if (statement.type === "ExportDefaultDeclaration") {
        entryValues.push(this.#evaluate(statement.declaration, frame));
      }
      if (statement.type === "ExportNamedDeclaration") {
        if (statement.declaration !== null) {
          for (const binding of statementDeclarations([statement])) {
            entryValues.push(this.#bindingValue(binding, frame));
          }
        }
        if (entry.reasons.some((reason) => reason !== "recovery-caller")) {
          for (const specifier of statement.specifiers) {
            if (specifier.exportKind === "type") {
              continue;
            }
            const name =
              specifier.exported.type === "Identifier"
                ? specifier.exported.name
                : specifier.exported.value;
            entryValues.push(this.#exported(entry.file, name));
          }
        }
      }
    }
    const exportedCallables = (
      value: OrgGraphValue,
    ): Extract<OrgGraphValue, { kind: "function" }>[] => {
      switch (value.kind) {
        case "function":
          return [value];
        case "schema":
          return exportedCallables(value.output);
        case "object":
          return [...value.fields.values()].flatMap(exportedCallables);
        case "array":
        case "set":
        case "union":
          return value.values.flatMap(exportedCallables);
        case "module":
          return panic(
            `Unresolved organization write graph: exported namespace ${value.file} requires a total export universe`,
          );
        case "bottom":
        case "chain-short-circuit":
        case "column":
        case "external":
        case "input":
        case "literal":
        case "method":
        case "query":
        case "sql":
        case "table":
        case "tx":
        case "org-scoped-handle":
        case "unknown":
        case "valibot-action":
          return [];
        default:
          value satisfies never;
          return panic("Unknown organization export value");
      }
    };
    for (const value of entryValues) {
      for (const part of exportedCallables(value)) {
        // Reexporting a function is not an invocation with invented raw
        // arguments. Analyze it at actual callers; explicit door aliases need
        // a resolved boundary instead of silently dropping that obligation.
        const declaration = module.parents.get(part.node);
        const name =
          part.node.id?.name ??
          (declaration?.type === "VariableDeclarator" &&
          declaration.id.type === "Identifier"
            ? declaration.id.name
            : undefined);
        if (name !== undefined && this.#nativeMutationExport(part.file, name)) {
          continue;
        }
        if (part.file !== entry.file) {
          if (entry.reasons.includes("root-door")) {
            this.#fail(
              frame,
              part.node,
              "root-door function is reexported; resolve its actual boundary",
            );
          }
          continue;
        }
        if (
          !entry.reasons.some(
            (reason) =>
              reason === "root-door" ||
              reason === "policy-owner" ||
              reason === "root-import",
          ) &&
          !this.#dependsOnRoot({
            file: part.file,
            node: part.node,
          })
        ) {
          continue;
        }
        // Open inputs carry no local callable or scope proof. Their methods
        // may observe data, but cannot receive a transaction or local callback;
        // mutation and transaction methods still use the raw receiver rules.
        if (this.#options.recoveryOwnerFiles.has(part.file)) {
          this.#reachedRecovery.add(part.file);
        }
        const args = part.node.params.map((): OrgGraphValue => ({
          kind: "input",
        }));
        const key = `${entry.file}|entry:${this.#signature({
          value: part,
        })}`;
        this.#contexts.set(key, {
          fn: { ...part, captures: this.#captureSnapshot(part) },
          args,
          caller: frame,
          allocationContext: JSON.stringify([
            part.file,
            part.node.start,
            args.map((argument) =>
              this.#allocationShape({
                value: argument,
              }),
            ),
          ]),
          result: this.#bottom,
          execution: { type: "unseen" },
          dependents: new Set(),
        });
        this.#runContext(key);
      }
    }
    this.#analyzed.add(entry.file);
    if (this.#persistentHeapChanged(heapBefore, persistentRoots)) {
      this.#queueCompletedContexts();
    }
  };

  readonly #settleContexts = (): void => {
    let iterations = 0;
    while (this.#pending.size > 0) {
      if (++iterations > ORG_GRAPH_FINITE_WORK_BUDGET) {
        panic(
          "Unresolved organization write graph: recursive summaries did not converge",
        );
      }
      const key = this.#pending.values().next().value;
      if (key === undefined) {
        break;
      }
      this.#pending.delete(key);
      this.#runContext(key);
    }
  };

  readonly #assertRecoveryFunctionReachability = (owner: string): void => {
    const module = this.#moduleAt(owner);
    walk(module.parsed.program, (node) => {
      if (!this.#isFunctionNode(node)) {
        return undefined;
      }
      const parent = module.parents.get(node);
      const name =
        node.id?.name ??
        (parent?.type === "VariableDeclarator" &&
        parent.id.type === "Identifier"
          ? parent.id.name
          : undefined);
      if (name !== undefined && this.#nativeMutationExport(owner, name)) {
        if (!this.#reachedNativeExports.has(`${owner}#${name}`)) {
          panic(
            `Unresolved organization write graph: recovery helper ${owner}:${name} was not reached from a resolved entry`,
          );
        }
        return "skip-children";
      }
      const mutations: CallExpression[] = [];
      if (node.body !== null) {
        walk(node.body, (child) => {
          if (this.#isFunctionNode(child)) {
            return "skip-children";
          }
          if (
            child.type !== "CallExpression" ||
            child.callee.type !== "MemberExpression"
          ) {
            return undefined;
          }
          const method = accessName(child.callee);
          if (
            method !== undefined &&
            (ORG_WRITE_METHODS.has(method) || method === "execute")
          ) {
            mutations.push(child);
          }
          return undefined;
        });
      }
      if (
        mutations.length > 0 &&
        !this.#analyzedRecoveryFunctions.has(`${owner}:${node.start}`)
      ) {
        panic(
          `Unresolved organization write graph: recovery helper ${owner}:${String(node.start)} was not reached from a resolved entry`,
        );
      }
      return undefined;
    });
  };

  run = (): OrgWriteGraphResult => {
    const entries = this.#discoverEntries();
    for (const entry of entries) {
      this.#seedEntry(entry);
    }
    this.#settleContexts();
    for (const owner of this.#options.recoveryOwnerFiles) {
      if (!this.#reachedRecovery.has(owner)) {
        panic(
          `Unresolved organization write graph: recovery owner ${owner} was not reached from a resolved entry`,
        );
      }
      this.#assertRecoveryFunctionReachability(owner);
    }
    return {
      entries,
      analyzedEntries: [...this.#analyzed].toSorted(),
      reachedRecoveryOwners: [...this.#reachedRecovery].toSorted(),
      hits: [...this.#hits.values()],
    };
  };
}

/**
 * Prototype per-tree delegated write analysis. The caller owns source selection
 * and supplies existing root/recovery ownership inventories without exclusions.
 * A successful result accounts for every derived entry and recovery owner.
 */
export const scanOrgWriteGraph = (
  options: ScanOrgWriteGraphOptions,
): OrgWriteGraphResult => new OrgWriteGraphEngine(options).run();
