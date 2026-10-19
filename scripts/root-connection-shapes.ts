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
import ts from "typescript";

import { sha256Hex } from "@stll/sha256/node";

import { parseSource } from "./parse-memo";

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
    file: "apps/api/src/lib/auth.ts",
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
export const isRootConnectionModule = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isStringLiteralLike(node) &&
  ROOT_CONNECTION_MODULE.test(node.text);

const isDynamicRootImport = (node: ts.Expression): boolean => {
  const unwrapped = ts.isAwaitExpression(node) ? node.expression : node;
  return (
    ts.isCallExpression(unwrapped) &&
    unwrapped.expression.kind === ts.SyntaxKind.ImportKeyword &&
    isRootConnectionModule(unwrapped.arguments.at(0))
  );
};

// Identifier nodes a binding name declares, through any destructuring depth.
const bindingIdentifiers = (name: ts.BindingName): ts.Identifier[] => {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
};

type RootBindings = {
  /** Declarations that bind the handle itself. */
  handles: Set<ts.Identifier>;
  /** Declarations that bind the whole module (`import * as root`). */
  namespaces: Set<ts.Identifier>;
};

const collectRootBindings = (sourceFile: ts.SourceFile): RootBindings => {
  const handles = new Set<ts.Identifier>();
  const namespaces = new Set<ts.Identifier>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      isRootConnectionModule(node.moduleSpecifier) &&
      node.importClause !== undefined &&
      node.importClause.phaseModifier !== ts.SyntaxKind.TypeKeyword
    ) {
      const bindings = node.importClause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name);
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if (
            !specifier.isTypeOnly &&
            isRootConnectionExport(
              (specifier.propertyName ?? specifier.name).text,
            )
          ) {
            handles.add(specifier.name);
          }
        }
      }
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isDynamicRootImport(node.initializer)
    ) {
      if (ts.isIdentifier(node.name)) {
        namespaces.add(node.name);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(imported) &&
            isRootConnectionExport(imported.text) &&
            ts.isIdentifier(element.name)
          ) {
            handles.add(element.name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { handles, namespaces };
};

// Names a list of statements declares at its own level.
const statementDeclarations = function* (
  statements: readonly ts.Statement[],
): Generator<ts.Identifier> {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        yield* bindingIdentifiers(declaration.name);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      yield statement.name;
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        yield clause.name;
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        yield bindings.name;
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          yield specifier.name;
        }
      }
    }
  }
};

// Names one scope node declares for code inside it.
const scopeDeclarations = function* (scope: ts.Node): Generator<ts.Identifier> {
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      yield* bindingIdentifiers(parameter.name);
    }
    if (
      (ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) &&
      scope.name !== undefined
    ) {
      yield scope.name;
    }
    return;
  }
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    yield* statementDeclarations(scope.statements);
    return;
  }
  if (ts.isCaseBlock(scope)) {
    for (const clause of scope.clauses) {
      yield* statementDeclarations(clause.statements);
    }
    return;
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
    yield* bindingIdentifiers(scope.variableDeclaration.name);
    return;
  }
  if (
    (ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    for (const declaration of scope.initializer.declarations) {
      yield* bindingIdentifiers(declaration.name);
    }
  }
};

// The declaration an identifier reference resolves to, by walking lexical
// scopes outwards. `undefined` means a global or an unresolved name.
const resolveDeclaration = (
  reference: ts.Identifier,
): ts.Identifier | undefined => {
  let found: ts.Identifier | undefined;
  ts.findAncestor(reference.parent, (scope) => {
    for (const declared of scopeDeclarations(scope)) {
      if (declared.text === reference.text) {
        found = declared;
        return true;
      }
    }
    return false;
  });
  return found;
};

const isReferencePosition = (identifier: ts.Identifier): boolean => {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === identifier) {
    return false;
  }
  return true;
};

// Parentheses and type-only wrappers, which change nothing at runtime.
const unwrapTypes = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = unwrapTypes(node);
  while (ts.isAwaitExpression(current)) {
    current = unwrapTypes(current.expression);
  }
  return current;
};

const createRootReferenceTest = (bindings: RootBindings) => {
  const isHandleIdentifier = (node: ts.Node): boolean => {
    if (!ts.isIdentifier(node) || !isReferencePosition(node)) {
      return false;
    }
    const declaration = resolveDeclaration(node);
    return declaration !== undefined && bindings.handles.has(declaration);
  };
  const isNamespaceIdentifier = (node: ts.Node): boolean => {
    if (!ts.isIdentifier(node)) {
      return false;
    }
    const declaration = resolveDeclaration(node);
    return declaration !== undefined && bindings.namespaces.has(declaration);
  };
  /** The expression IS the owner handle. */
  const isHandle = (node: ts.Expression): boolean => {
    const expression = unwrap(node);
    if (isHandleIdentifier(expression)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      isRootConnectionExport(expression.name.text) &&
      isNamespaceIdentifier(unwrap(expression.expression))
    ) {
      return true;
    }
    return (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteralLike(expression.argumentExpression) &&
      isRootConnectionExport(expression.argumentExpression.text) &&
      isNamespaceIdentifier(unwrap(expression.expression))
    );
  };
  /** The expression is the handle, or a member/call chain rooted at it. */
  const reachesHandle = (node: ts.Expression): boolean => {
    let current = unwrap(node);
    for (;;) {
      if (isHandle(current)) {
        return true;
      }
      if (
        ts.isCallExpression(current) ||
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
      ) {
        current = unwrap(current.expression);
      } else {
        return false;
      }
    }
  };
  /** The expression builds something from the handle: `createStore(rootDb)`. */
  const buildsFromHandle = (node: ts.Expression): boolean => {
    const expression = unwrap(node);
    return (
      (ts.isCallExpression(expression) || ts.isNewExpression(expression)) &&
      (expression.arguments ?? []).some(isHandle)
    );
  };
  return { buildsFromHandle, isHandle, reachesHandle };
};

// The listed operation an awaited call names, when the call is exempt in
// `file`: awaited, a plain identifier callee on the list, and this file the
// one the entry names.
const exemptRootOperation = (
  node: ts.Expression,
  file: string,
): RootOperationName | undefined => {
  const awaited = unwrapTypes(node);
  if (!ts.isAwaitExpression(awaited)) {
    return undefined;
  }
  const call = unwrapTypes(awaited.expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
    return undefined;
  }
  const name = call.expression.text;
  return isRootOperationName(name) && ROOT_OPERATION_RESULTS[name].file === file
    ? name
    : undefined;
};

const FALLBACK_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);

// A class `static {}` block runs once, when the module evaluates, so it is
// module level; only a real function defers the call.
const isInsideFunction = (node: ts.Node): boolean =>
  ts.findAncestor(node.parent, ts.isFunctionLike) !== undefined;

type RootConnectionScan = {
  hits: RootConnectionShapeHit[];
  /** Listed operations whose awaited call this file was exempted for. */
  exemptOperations: RootOperationName[];
};

const scanRootConnectionShapes = (
  content: string,
  file: string,
): RootConnectionScan => {
  const sourceFile = parseSource({ fileName: file, text: content });
  const bindings = collectRootBindings(sourceFile);
  if (bindings.handles.size === 0 && bindings.namespaces.size === 0) {
    return { hits: [], exemptOperations: [] };
  }
  const { buildsFromHandle, isHandle, reachesHandle } =
    createRootReferenceTest(bindings);
  const exemptOperations: RootOperationName[] = [];
  // At module level a call taking the handle is already `module-level-call`;
  // counting the position that receives its value too would count it twice.
  const buildsInFunction = (node: ts.Expression): boolean => {
    if (!isInsideFunction(node) || !buildsFromHandle(node)) {
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
  const record = (shape: RootConnectionShape, node: ts.Node): void => {
    hits.push({
      shape,
      line:
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) || ts.isBindingElement(node)) &&
      node.initializer !== undefined &&
      reachesHandle(node.initializer)
    ) {
      record(ROOT_CONNECTION_SHAPE.parameterDefault, node.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      FALLBACK_OPERATORS.has(node.operatorToken.kind) &&
      (reachesHandle(node.right) || buildsFromHandle(node.right))
    ) {
      record(ROOT_CONNECTION_SHAPE.fallbackOperand, node.right);
    } else if (ts.isConditionalExpression(node)) {
      for (const operand of [node.whenTrue, node.whenFalse]) {
        if (reachesHandle(operand) || buildsInFunction(operand)) {
          record(ROOT_CONNECTION_SHAPE.conditionalOperand, operand);
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      // The handle itself or a value built from it. A query chain rooted at
      // the handle (`rows = await rootDb.select()…`) is an explicit use, as
      // its declaration form is.
      (isHandle(node.right) || buildsInFunction(node.right))
    ) {
      record(ROOT_CONNECTION_SHAPE.assignment, node.right);
    } else if (ts.isPropertyAssignment(node) && isHandle(node.initializer)) {
      record(ROOT_CONNECTION_SHAPE.dependencyProperty, node.initializer);
    } else if (ts.isShorthandPropertyAssignment(node) && isHandle(node.name)) {
      record(ROOT_CONNECTION_SHAPE.dependencyProperty, node.name);
    } else if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      !isInsideFunction(node)
    ) {
      for (const argument of node.arguments ?? []) {
        if (isHandle(argument)) {
          record(ROOT_CONNECTION_SHAPE.moduleLevelCall, argument);
        }
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isHandle(node.initializer)
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.initializer);
    } else if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      (isHandle(node.expression) || buildsInFunction(node.expression))
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.expression);
    } else if (
      ts.isArrowFunction(node) &&
      !ts.isBlock(node.body) &&
      (isHandle(node.body) || buildsInFunction(node.body))
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { hits, exemptOperations };
};

export const findRootConnectionShapes = (
  content: string,
  file: string,
): RootConnectionShapeHit[] => scanRootConnectionShapes(content, file).hits;

/**
 * Listed operations with no exempt site left in their file. The list may only
 * shrink: a stale entry would exempt the next call that takes its name.
 */
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
const hasNodeFlag = (flags: ts.NodeFlags, mask: ts.NodeFlags): boolean => {
  const value: number = flags;
  const bit: number = mask;
  return value % (bit * 2) >= bit;
};

const accessName = (
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined => {
  if (ts.isPropertyAccessExpression(access)) {
    return access.name.text;
  }
  if (ts.isStringLiteralLike(access.argumentExpression)) {
    return access.argumentExpression.text;
  }
  return undefined;
};
const SCHEMA_MODULE =
  /(?:^|\/)db\/(?:schema(?:\/[^.]+)?|auth-schema|agent-auth-schema)(?:\.[cm]?[jt]sx?)?$/u;
const ORG_WRITE_METHODS = new Set(["insert", "update", "delete"]);

type ImportedValue = { type: "member"; name: string } | { type: "namespace" };

const isDynamicModuleImport = (
  expression: ts.Expression,
  modulePattern: RegExp,
): boolean => {
  const value = unwrap(expression);
  const source = ts.isCallExpression(value) ? value.arguments.at(0) : undefined;
  return (
    ts.isCallExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ImportKeyword &&
    source !== undefined &&
    ts.isStringLiteralLike(source) &&
    modulePattern.test(source.text)
  );
};

// `const { name } = await import("…")`: the destructured member of a
// matching module.
const destructuredDynamicImportValue = (
  parent: ts.BindingElement,
  modulePattern: RegExp,
): ImportedValue | undefined => {
  const pattern = parent.parent;
  const declaration = pattern.parent;
  if (
    !ts.isObjectBindingPattern(pattern) ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !isDynamicModuleImport(declaration.initializer, modulePattern)
  ) {
    return undefined;
  }
  const name = parent.propertyName ?? parent.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? { type: "member", name: name.text }
    : undefined;
};

// A runtime named or namespace import from a matching module.
const staticImportValue = (
  parent: ts.ImportSpecifier | ts.NamespaceImport,
  modulePattern: RegExp,
): ImportedValue | undefined => {
  const imported = ts.findAncestor(parent, ts.isImportDeclaration);
  if (
    imported === undefined ||
    !ts.isImportDeclaration(imported) ||
    !ts.isStringLiteralLike(imported.moduleSpecifier) ||
    !modulePattern.test(imported.moduleSpecifier.text) ||
    imported.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    (ts.isImportSpecifier(parent) && parent.isTypeOnly)
  ) {
    return undefined;
  }
  return ts.isImportSpecifier(parent)
    ? { type: "member", name: (parent.propertyName ?? parent.name).text }
    : { type: "namespace" };
};

// A `const` alias of a dynamic module import or of another imported value.
const constAliasValue = (
  parent: ts.VariableDeclaration,
  modulePattern: RegExp,
  seen: Set<ts.Identifier>,
): ImportedValue | undefined => {
  if (
    parent.initializer === undefined ||
    !ts.isVariableDeclarationList(parent.parent) ||
    !hasNodeFlag(parent.parent.flags, ts.NodeFlags.Const)
  ) {
    return undefined;
  }
  if (isDynamicModuleImport(parent.initializer, modulePattern)) {
    return { type: "namespace" };
  }
  return importedValue(parent.initializer, modulePattern, seen);
};

const identifierImportedValue = (
  value: ts.Identifier,
  modulePattern: RegExp,
  seen: Set<ts.Identifier>,
): ImportedValue | undefined => {
  const declaration = resolveDeclaration(value);
  if (declaration === undefined || seen.has(declaration)) {
    return undefined;
  }
  seen.add(declaration);
  const parent = declaration.parent;
  if (ts.isBindingElement(parent)) {
    return destructuredDynamicImportValue(parent, modulePattern);
  }
  if (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) {
    return staticImportValue(parent, modulePattern);
  }
  if (ts.isVariableDeclaration(parent)) {
    return constAliasValue(parent, modulePattern, seen);
  }
  return undefined;
};

// Resolve imports and immutable aliases using the same lexical declarations
// as the owner-handle scanner. Mutable aliases never establish admission.
const importedValue = (
  expression: ts.Expression,
  modulePattern: RegExp,
  seen = new Set<ts.Identifier>(),
): ImportedValue | undefined => {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    return identifierImportedValue(value, modulePattern, seen);
  }
  if (
    !ts.isPropertyAccessExpression(value) &&
    !ts.isElementAccessExpression(value)
  ) {
    return undefined;
  }
  const name = accessName(value);
  return name !== undefined &&
    importedValue(value.expression, modulePattern, seen)?.type === "namespace"
    ? { type: "member", name }
    : undefined;
};

const resolvesToBinding = (
  expression: ts.Expression,
  binding: ts.Identifier,
  seen = new Set<ts.Identifier>(),
): boolean => {
  const value = unwrap(expression);
  if (!ts.isIdentifier(value)) {
    return false;
  }
  const declaration = resolveDeclaration(value);
  if (declaration === binding) {
    return true;
  }
  if (declaration === undefined || seen.has(declaration)) {
    return false;
  }
  seen.add(declaration);
  const parent = declaration.parent;
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    ts.isVariableDeclarationList(parent.parent) &&
    hasNodeFlag(parent.parent.flags, ts.NodeFlags.Const) &&
    resolvesToBinding(parent.initializer, binding, seen)
  );
};

const scopedReceiver = (
  call: ts.CallExpression,
  receiver: ts.Expression,
): boolean => {
  let scoped = false;
  ts.findAncestor(call.parent, (node) => {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
      return false;
    }
    const property = node.parent;
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) &&
        !ts.isStringLiteralLike(property.name)) ||
      property.name.text !== "fn" ||
      !ts.isObjectLiteralExpression(property.parent)
    ) {
      return false;
    }
    const invocation = property.parent.parent;
    if (
      !ts.isCallExpression(invocation) ||
      invocation.arguments.at(0) !== property.parent
    ) {
      return false;
    }
    const imported = importedValue(invocation.expression, ORG_SCOPE_MODULE);
    const parameter = node.parameters.at(0)?.name;
    if (
      imported?.type !== "member" ||
      imported.name !== "withOrgScope" ||
      parameter === undefined ||
      !ts.isIdentifier(parameter)
    ) {
      return false;
    }
    scoped = resolvesToBinding(receiver, parameter);
    return scoped;
  });
  return scoped;
};

export type OrgWriteScopeHit = {
  line: number;
  table: string;
  operation: string;
  fingerprint: string;
};

// Syntax kinds and token values retain the write's statement while omitting
// offsets, trivia, and quote style. Formatting and relocation stay neutral.
const writeStatementFingerprint = (call: ts.CallExpression): string => {
  const statement =
    ts.findAncestor(
      call,
      (node) =>
        ts.isExpressionStatement(node) ||
        ts.isReturnStatement(node) ||
        ts.isVariableStatement(node),
    ) ?? call;
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    const text =
      ts.isIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
        ? node.text
        : "";
    tokens.push(`${node.kind}:${text}`);
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return sha256Hex(JSON.stringify(tokens));
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
  const source = parseSource({ fileName: file, text: content });
  const hits: OrgWriteScopeHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)
      ) {
        const operation = accessName(callee);
        const target = node.arguments.at(0);
        const imported =
          target === undefined
            ? undefined
            : importedValue(target, SCHEMA_MODULE);
        if (
          operation !== undefined &&
          ORG_WRITE_METHODS.has(operation) &&
          imported?.type === "member" &&
          orgTables.has(imported.name) &&
          !scopedReceiver(node, callee.expression)
        ) {
          hits.push({
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            table: imported.name,
            operation,
            fingerprint: writeStatementFingerprint(node),
          });
        }
        // SQL mutations cannot classify their target from a Drizzle argument;
        // keep each owner module's explicit SQL mutation debt independently.
        if (
          operation === "execute" &&
          target !== undefined &&
          /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\b/iu.test(
            target.getText(source).replace(/\bFOR\s+UPDATE\b/giu, ""),
          ) &&
          !scopedReceiver(node, callee.expression)
        ) {
          hits.push({
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            table: "<raw-sql>",
            operation: "execute",
            fingerprint: writeStatementFingerprint(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
};

/** The classification registry is shared by both measured source trees. */
export const orgScopeTableExportNames = (
  content: string,
  file: string,
): string[] => {
  const source = parseSource({ fileName: file, text: content });
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "ORG_SCOPE_TABLES" ||
        declaration.initializer === undefined
      ) {
        continue;
      }
      const value = unwrap(declaration.initializer);
      if (!ts.isObjectLiteralExpression(value)) {
        panic("ORG scope table registry requires explicit export keys");
      }
      return value.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          (!ts.isIdentifier(property.name) &&
            !ts.isStringLiteralLike(property.name))
        ) {
          return panic(
            "ORG scope table registry requires explicit export keys",
          );
        }
        return property.name.text;
      });
    }
  }
  return panic("ORG scope table registry is missing");
};

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
  /** References that bind a handle at runtime. */
  readonly value: number;
  /** References erased at compile time: type-only imports and type queries. */
  readonly type: number;
};

type NamedReference = {
  readonly name: ts.Identifier | ts.StringLiteral;
  readonly isTypeOnly: boolean;
};

// The handles a dynamic import's result is destructured into, or every
// handle when the module object itself escapes.
const dynamicImportHandles = (call: ts.CallExpression): number => {
  let holder: ts.Node = call.parent;
  while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder)) {
    holder = holder.parent;
  }
  if (
    ts.isVariableDeclaration(holder) &&
    ts.isObjectBindingPattern(holder.name) &&
    holder.name.elements.every(
      (element) => element.dotDotDotToken === undefined,
    )
  ) {
    return holder.name.elements.filter((element) => {
      const imported = element.propertyName ?? element.name;
      return (
        (ts.isIdentifier(imported) || ts.isStringLiteral(imported)) &&
        isRootConnectionExport(imported.text)
      );
    }).length;
  }
  return HANDLES_PER_MODULE;
};

// The handles an import type names: its qualifier's first name, the string
// index that selects a member (`import("…")["rootDb"]`), or the whole module
// when it names neither.
const importTypeHandles = (node: ts.ImportTypeNode): number => {
  let head = node.qualifier;
  while (head !== undefined && ts.isQualifiedName(head)) {
    head = head.left;
  }
  if (head !== undefined) {
    return isRootConnectionExport(head.text) ? 1 : 0;
  }
  let selected: ts.Node = node;
  while (ts.isParenthesizedTypeNode(selected.parent)) {
    selected = selected.parent;
  }
  const access = selected.parent;
  if (
    ts.isIndexedAccessTypeNode(access) &&
    access.objectType === selected &&
    ts.isLiteralTypeNode(access.indexType) &&
    ts.isStringLiteral(access.indexType.literal)
  ) {
    return isRootConnectionExport(access.indexType.literal.text) ? 1 : 0;
  }
  return HANDLES_PER_MODULE;
};

const countRootConnectionReferences = (
  content: string,
  file: string,
): RootConnectionReferences => {
  const sourceFile = parseSource({ fileName: file, text: content });
  let value = 0;
  let type = 0;
  const add = (count: number, isTypeOnly: boolean): void => {
    if (isTypeOnly) {
      type += count;
    } else {
      value += count;
    }
  };
  const addNamed = (names: readonly NamedReference[]): void => {
    for (const { name, isTypeOnly } of names) {
      if (isRootConnectionExport(name.text)) {
        add(1, isTypeOnly);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      isRootConnectionModule(node.moduleSpecifier)
    ) {
      const clauseIsTypeOnly =
        node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        add(HANDLES_PER_MODULE, clauseIsTypeOnly);
      } else if (bindings !== undefined) {
        addNamed(
          bindings.elements.map((specifier) => ({
            name: specifier.propertyName ?? specifier.name,
            isTypeOnly: clauseIsTypeOnly || specifier.isTypeOnly,
          })),
        );
      }
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      isRootConnectionModule(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        add(HANDLES_PER_MODULE, node.isTypeOnly);
      } else {
        addNamed(
          clause.elements.map((specifier) => ({
            name: specifier.propertyName ?? specifier.name,
            isTypeOnly: node.isTypeOnly || specifier.isTypeOnly,
          })),
        );
      }
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isRootConnectionModule(node.moduleReference.expression)
    ) {
      add(HANDLES_PER_MODULE, node.isTypeOnly);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isRootConnectionModule(node.arguments.at(0))
    ) {
      value += dynamicImportHandles(node);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      isRootConnectionModule(node.argument.literal)
    ) {
      type += importTypeHandles(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
