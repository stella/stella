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

import {
  type BindingIdentifier as Identifier,
  type BindingPattern,
  type BindingRestElement,
  type Directive,
  type Expression,
  type FormalParameterRest,
  type ImportExpression,
  type Node,
  parseSource,
  type Program,
  type Statement,
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
const resolveDeclaration = (
  reference: Identifier,
  parents: ParentMap,
): Identifier | undefined => {
  for (
    let scope = parents.get(reference);
    scope !== undefined;
    scope = parents.get(scope)
  ) {
    for (const declared of scopeDeclarations(scope)) {
      if (declared.name === reference.name) {
        return declared;
      }
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
      node.type === "Property" &&
      parents.get(node)?.type === "ObjectExpression" &&
      node.value.type !== "AssignmentPattern" &&
      node.value.type !== "ObjectPattern" &&
      node.value.type !== "ArrayPattern" &&
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
