// Where the owner connection (`rootDb`) is supplied implicitly.
//
// The per-file import count in `scripts/ratchet.ts` says which modules can
// reach the owner connection. It cannot say how they hand it on: a module that
// imports `rootDb` once and passes it explicitly to the one operation that
// needs it looks the same as one that makes it the default of every
// dependency. This counter finds the second kind, the shapes that let a caller
// receive owner access without asking for it:
//
//   - a parameter or destructured default:    (db = rootDb) / { db = rootDb }
//   - a fallback operand:                      db ?? rootDb / s ??= make(rootDb)
//   - a conditional operand:                   cond ? rootDb.transaction(f) : ...
//   - an object-literal dependency property:   { db: rootDb } / { rootDb }
//   - a module-level call taking it:           const store = createStore(rootDb)
//   - an alias or a returned handle:           const db = rootDb / () => rootDb
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
// which the import ratchet and the door list account for.

import ts from "typescript";

const ROOT_CONNECTION_MODULE_SUFFIX = "db/root";
const ROOT_CONNECTION_EXPORT = "rootDb";

export const ROOT_CONNECTION_SHAPE = {
  parameterDefault: "parameter-default",
  fallbackOperand: "fallback-operand",
  conditionalOperand: "conditional-operand",
  dependencyProperty: "dependency-property",
  moduleLevelCall: "module-level-call",
  alias: "alias",
} as const;

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
  node.text.endsWith(ROOT_CONNECTION_MODULE_SUFFIX);

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
            (specifier.propertyName ?? specifier.name).text ===
              ROOT_CONNECTION_EXPORT
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
            imported.text === ROOT_CONNECTION_EXPORT &&
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

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
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
      expression.name.text === ROOT_CONNECTION_EXPORT &&
      isNamespaceIdentifier(unwrap(expression.expression))
    ) {
      return true;
    }
    return (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteralLike(expression.argumentExpression) &&
      expression.argumentExpression.text === ROOT_CONNECTION_EXPORT &&
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

export const findRootConnectionShapesAs = (
  content: string,
  scriptKind: ts.ScriptKind,
): RootConnectionShapeHit[] => {
  const sourceFile = ts.createSourceFile(
    "root-connection-source",
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const bindings = collectRootBindings(sourceFile);
  if (bindings.handles.size === 0 && bindings.namespaces.size === 0) {
    return [];
  }
  const { buildsFromHandle, isHandle, reachesHandle } =
    createRootReferenceTest(bindings);
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
        if (reachesHandle(operand)) {
          record(ROOT_CONNECTION_SHAPE.conditionalOperand, operand);
        }
      }
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
      isHandle(node.expression)
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.expression);
    } else if (
      ts.isArrowFunction(node) &&
      !ts.isBlock(node.body) &&
      isHandle(node.body)
    ) {
      record(ROOT_CONNECTION_SHAPE.alias, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
};

// The counter sees content, not the file name. Parsing a `.ts` generic arrow
// as TSX misreads what follows it, so both parses run and the one that found
// more is the one that read the file correctly (the same rule the import
// count in `scripts/ratchet.ts` follows).
export const findRootConnectionShapes = (
  content: string,
): RootConnectionShapeHit[] => {
  const asTs = findRootConnectionShapesAs(content, ts.ScriptKind.TS);
  const asTsx = findRootConnectionShapesAs(content, ts.ScriptKind.TSX);
  return asTsx.length > asTs.length ? asTsx : asTs;
};

export const countRootConnectionShapes = (content: string): number =>
  findRootConnectionShapes(content).length;
