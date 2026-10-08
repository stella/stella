import ts from "typescript";

import type { TaskMutationEffectOwner } from "../../src/lib/feature-access/registry";

const expression = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isParenthesizedExpression(node)
    ? expression(node.expression)
    : node;

const property = (node: ts.Expression, key: string) => {
  const value = expression(node);
  if (!ts.isObjectLiteralExpression(value)) {
    return undefined;
  }
  // Duplicate, spread and computed keys cannot prove the effective target.
  if (
    value.properties.some(
      (item) =>
        (!ts.isPropertyAssignment(item) &&
          !ts.isShorthandPropertyAssignment(item)) ||
        !(
          (ts.isPropertyAssignment(item) ||
            ts.isShorthandPropertyAssignment(item)) &&
          (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
        ),
    )
  ) {
    return undefined;
  }
  const matches = value.properties.filter(
    (item) =>
      (ts.isPropertyAssignment(item) ||
        ts.isShorthandPropertyAssignment(item)) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === key,
  );
  const item = matches.length === 1 ? matches.at(0) : undefined;
  if (item === undefined) {
    return undefined;
  }
  if (ts.isPropertyAssignment(item)) {
    return expression(item.initializer);
  }
  return ts.isShorthandPropertyAssignment(item) ? item.name : undefined;
};

const pathName = (node: ts.Expression): string | undefined => {
  const value = expression(node);
  if (ts.isIdentifier(value)) {
    return value.text;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const parent = pathName(value.expression);
    return parent === undefined ? undefined : `${parent}.${value.name.text}`;
  }
  return undefined;
};

const namedImport = (ast: ts.SourceFile, module: string, imported: string) => {
  const bindings: ts.Identifier[] = [];
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const names = statement.importClause?.namedBindings;
    if (names === undefined || !ts.isNamedImports(names)) {
      continue;
    }
    for (const item of names.elements) {
      if (
        !item.isTypeOnly &&
        (item.propertyName?.text ?? item.name.text) === imported
      ) {
        bindings.push(item.name);
      }
    }
  }
  const binding = bindings.length === 1 ? bindings.at(0) : undefined;
  if (binding === undefined) {
    return undefined;
  }
  let shadowed = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === binding.text
    ) {
      shadowed = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      pathName(node.left) === binding.text
    ) {
      shadowed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return shadowed ? undefined : binding.text;
};

const ownerNode = (ast: ts.SourceFile, symbol: string): ts.Node | undefined => {
  if (symbol === "default") {
    const assignments = ast.statements.filter(ts.isExportAssignment);
    const assignment = assignments.length === 1 ? assignments.at(0) : undefined;
    if (assignment === undefined || assignment.isExportEquals) {
      return undefined;
    }
    const value = expression(assignment.expression);
    if (ts.isIdentifier(value)) {
      return ownerNode(ast, value.text);
    }
    if (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.arguments.length === 0
    ) {
      return ownerNode(ast, value.expression.text);
    }
    return value;
  }
  const declarations: ts.Node[] = [];
  for (const statement of ast.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === symbol
    ) {
      declarations.push(statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === symbol &&
          declaration.initializer !== undefined
        ) {
          declarations.push(expression(declaration.initializer));
        }
      }
    }
  }
  return declarations.length === 1 ? declarations.at(0) : undefined;
};

const blockOfSuppliedOwner = (node: ts.Node) =>
  (ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)) &&
  node.body !== undefined &&
  ts.isBlock(node.body)
    ? node.body
    : undefined;

const parameterBinds = (name: ts.BindingName, expected: string): boolean =>
  ts.isIdentifier(name)
    ? name.text === expected
    : name.elements.some(
        (item) =>
          ts.isBindingElement(item) && parameterBinds(item.name, expected),
      );

const trustedParameter = (name: ts.BindingName, expected: string): boolean => {
  if (ts.isIdentifier(name)) {
    return name.text === expected;
  }
  if (!ts.isObjectBindingPattern(name)) {
    return false;
  }
  return name.elements.some(
    (item) =>
      ts.isIdentifier(item.name) &&
      item.name.text === expected &&
      (item.dotDotDotToken === undefined || expected === "props") &&
      item.initializer === undefined &&
      (item.propertyName === undefined ||
        ((ts.isIdentifier(item.propertyName) ||
          ts.isStringLiteral(item.propertyName)) &&
          (item.propertyName.text === expected ||
            (expected === "copySourceWorkspaceId" &&
              item.propertyName.text === "sourceWorkspaceId")))),
  );
};

const trustedPropsBinding = (name: ts.ObjectBindingPattern, expected: string) =>
  trustedParameter(name, expected) &&
  name.elements.every((item) => {
    const key = item.propertyName ?? item.name;
    if (
      !(ts.isIdentifier(key) || ts.isStringLiteral(key)) ||
      !["userId", "body", "workspaceId"].includes(key.text)
    ) {
      return true;
    }
    return (
      ts.isIdentifier(item.name) &&
      item.name.text === key.text &&
      item.dotDotDotToken === undefined &&
      item.initializer === undefined
    );
  });

const enclosingFunction = (node: ts.Node) => {
  let parent = node.parent;
  while (parent !== undefined) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent)
    ) {
      return parent;
    }
    parent = parent.parent;
  }
  return undefined;
};

const assignsBinding = (node: ts.Expression, name: string): boolean => {
  const value = expression(node);
  const assigned = pathName(value);
  if (assigned === name || assigned?.startsWith(`${name}.`)) {
    return true;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (item) =>
        !ts.isOmittedExpression(item) &&
        assignsBinding(ts.isSpreadElement(item) ? item.expression : item, name),
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((item) => {
      if (ts.isShorthandPropertyAssignment(item)) {
        return item.name.text === name;
      }
      if (ts.isPropertyAssignment(item)) {
        return assignsBinding(item.initializer, name);
      }
      return (
        ts.isSpreadAssignment(item) && assignsBinding(item.expression, name)
      );
    });
  }
  return false;
};

const localSelectorSource = (name: string): string | undefined => {
  switch (name) {
    case "sourceEntityId":
      return "body.source.id";
    case "targetEntityId":
      return "body.target.id";
    case "taskId":
      return "body.taskId";
    default:
      return undefined;
  }
};

const copySourcePrefix = (statement: ts.Node | undefined) => {
  if (
    statement === undefined ||
    !ts.isVariableStatement(statement) ||
    statement.declarationList.getFirstToken()?.kind !==
      ts.SyntaxKind.ConstKeyword ||
    statement.declarationList.declarations.length !== 1
  ) {
    return false;
  }
  const declaration = statement.declarationList.declarations.at(0);
  if (
    declaration === undefined ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== "sourceWorkspaceId" ||
    declaration.initializer === undefined
  ) {
    return false;
  }
  const value = expression(declaration.initializer);
  return (
    ts.isConditionalExpression(value) &&
    ts.isBinaryExpression(value.condition) &&
    pathName(value.condition.left) === "transfer.type" &&
    value.condition.operatorToken.kind ===
      ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isStringLiteral(value.condition.right) &&
    value.condition.right.text === "move" &&
    pathName(value.whenTrue) === "transfer.sourceWorkspaceId" &&
    ts.isBinaryExpression(expression(value.whenFalse)) &&
    expression(value.whenFalse).getText().replace(/\s/gu, "") ===
      "copySourceWorkspaceId??targetWorkspaceId"
  );
};

/** Closed parameter provenance rejects aliases from body/assignee input and lexical shadows. */
const parameterSource = (
  node: ts.Node,
  name: string,
  allowUserAlias = false,
): boolean => {
  const fn = enclosingFunction(node);
  if (fn === undefined || fn.body === undefined) {
    return false;
  }
  const parameters = fn.parameters.filter((parameter) =>
    parameterBinds(parameter.name, name),
  );
  let alias: ts.VariableDeclaration | undefined;
  if (parameters.length === 0 && allowUserAlias && ts.isBlock(fn.body)) {
    const aliases = fn.body.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.getFirstToken()?.kind ===
        ts.SyntaxKind.ConstKeyword
        ? statement.declarationList.declarations.filter((declaration) => {
            if (
              declaration.initializer === undefined ||
              declaration.pos >= node.pos
            ) {
              return false;
            }
            return (
              (name === "userId" &&
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === name &&
                pathName(declaration.initializer) === "user.id") ||
              (ts.isObjectBindingPattern(declaration.name) &&
                trustedPropsBinding(declaration.name, name) &&
                pathName(declaration.initializer) === "props") ||
              (localSelectorSource(name) !== undefined &&
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === name &&
                pathName(declaration.initializer) ===
                  localSelectorSource(name)) ||
              (name === "taskId" &&
                ts.isObjectBindingPattern(declaration.name) &&
                trustedParameter(declaration.name, name) &&
                pathName(declaration.initializer) === "body") ||
              (name === "sourceWorkspaceId" &&
                copySourcePrefix(declaration.parent.parent))
            );
          })
        : [],
    );
    alias = aliases.length === 1 ? aliases.at(0) : undefined;
    if (alias === undefined || alias.initializer === undefined) {
      return false;
    }
    const sourcePath = pathName(alias.initializer);
    let source = "props";
    if (sourcePath === "user.id") {
      source = "user";
    } else if (sourcePath === "body" || sourcePath?.startsWith("body.")) {
      source = "body";
    }
    if (name === "sourceWorkspaceId") {
      if (
        !["transfer", "copySourceWorkspaceId", "targetWorkspaceId"].every(
          (root) => parameterSource(node, root),
        )
      ) {
        return false;
      }
    } else if (!parameterSource(node, source, source === "body")) {
      return false;
    }
  } else if (
    parameters.length !== 1 ||
    !parameters.some(
      (parameter) =>
        parameter.initializer === undefined &&
        trustedParameter(parameter.name, name),
    )
  ) {
    return false;
  }
  let shadowed = false;
  const visit = (child: ts.Node) => {
    if (child === alias) {
      return;
    }
    if (
      (ts.isVariableDeclaration(child) ||
        ts.isParameter(child) ||
        ts.isBindingElement(child)) &&
      child !== alias &&
      parameterBinds(child.name, name)
    ) {
      shadowed = true;
    }
    if (
      (ts.isFunctionDeclaration(child) ||
        ts.isFunctionExpression(child) ||
        ts.isClassDeclaration(child) ||
        ts.isClassExpression(child)) &&
      child.name?.text === name
    ) {
      shadowed = true;
    }
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      child.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignsBinding(child.left, name)
    ) {
      shadowed = true;
    }
    if (
      (ts.isPrefixUnaryExpression(child) ||
        ts.isPostfixUnaryExpression(child)) &&
      (child.operator === ts.SyntaxKind.PlusPlusToken ||
        child.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignsBinding(child.operand, name)
    ) {
      shadowed = true;
    }
    ts.forEachChild(child, visit);
  };
  visit(fn.body);
  return !shadowed;
};

const containsCall = (node: ts.Node): boolean => {
  if (
    ts.isCallExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    found ||= containsCall(child);
  });
  return found;
};
const pureReadArgument = (ast: ts.SourceFile, node: ts.Node): boolean => {
  if (
    ts.isAwaitExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  ) {
    return false;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return false;
  }
  if (ts.isCallExpression(node)) {
    const predicates = [
      "and",
      "or",
      "eq",
      "ne",
      "inArray",
      "notInArray",
      "isNull",
      "isNotNull",
      "lt",
      "lte",
      "gt",
      "gte",
      "not",
      "asc",
      "desc",
    ];
    if (
      !predicates.some(
        (name) =>
          namedImport(ast, "drizzle-orm", name) === pathName(node.expression),
      )
    ) {
      return false;
    }
  }
  let pure = true;
  ts.forEachChild(node, (child) => {
    pure &&= pureReadArgument(ast, child);
  });
  return pure;
};
const pureSelect = (
  ast: ts.SourceFile,
  call: ts.CallExpression,
  txName: string,
): boolean => {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !call.arguments.every((argument) => pureReadArgument(ast, argument))
  ) {
    return false;
  }
  const receiver = expression(call.expression.expression);
  if (call.expression.name.text === "select") {
    return pathName(receiver) === txName;
  }
  return (
    ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"].includes(
      call.expression.name.text,
    ) &&
    ts.isCallExpression(receiver) &&
    pureSelect(ast, receiver, txName)
  );
};

const pureReadCallback = (
  ast: ts.SourceFile,
  body: ts.ConciseBody,
  txName: string,
) => {
  const single =
    ts.isBlock(body) && body.statements.length === 1
      ? body.statements.at(0)
      : undefined;
  let returned: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    returned =
      single !== undefined && ts.isReturnStatement(single)
        ? single.expression
        : undefined;
  } else {
    returned = body;
  }
  if (returned === undefined) {
    return false;
  }
  const value = expression(
    ts.isAwaitExpression(returned) ? returned.expression : returned,
  );
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (pureSelect(ast, value, txName)) {
    return true;
  }
  const called = pathName(value.expression);
  if (
    called?.startsWith(`${txName}.query.`) &&
    /\.find(?:First|Many)$/u.test(called)
  ) {
    return value.arguments.every((argument) => !containsCall(argument));
  }
  const readHelpers = {
    admitTaskFlowAccess: "@/api/lib/flows/review-gate-task",
    admitTaskFlowTargetAccess: "@/api/lib/flows/review-task-admission",
    reviewGateForTask: "@/api/lib/flows/review-gate-task",
  };
  if (
    called === undefined ||
    !Object.entries(readHelpers).some(
      ([name, module]) => namedImport(ast, module, name) === called,
    )
  ) {
    return false;
  }
  const options = value.arguments.at(1);
  if (
    value.arguments.length !== 2 ||
    pathName(value.arguments[0] ?? value.expression) !== txName ||
    options === undefined ||
    containsCall(options)
  ) {
    return false;
  }
  if (
    namedImport(
      ast,
      "@/api/lib/flows/review-gate-task",
      "reviewGateForTask",
    ) === called
  ) {
    return true;
  }
  const access = property(options, "access");
  return (
    access !== undefined && ts.isStringLiteral(access) && access.text === "read"
  );
};

const transactionConstructor = (ast: ts.SourceFile, called: string) => {
  if (called === "safeDb") {
    return called;
  }
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@/api/db/safe-db" ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const item of bindings.elements) {
      const imported = item.propertyName?.text ?? item.name.text;
      if (
        !item.isTypeOnly &&
        item.name.text === called &&
        ["resultTx", "withScopedTx", "abortableTx"].includes(imported)
      ) {
        return imported;
      }
    }
  }
  return undefined;
};

const transactionCallback = (
  ast: ts.SourceFile,
  node: ts.Node,
  callee: string,
) => {
  if (
    callee !== "safeDb" &&
    namedImport(ast, "@/api/db/safe-db", callee) !== callee
  ) {
    return undefined;
  }
  const callbacks: ts.Block[] = [];
  let unsupported = false;
  const visit = (child: ts.Node) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      transactionConstructor(ast, child.expression.text) !== undefined
    ) {
      const called = child.expression.text;
      const invoked = transactionConstructor(ast, called);
      if (invoked === undefined) {
        unsupported = true;
        return;
      }
      const callback = child.arguments.at(invoked === "safeDb" ? 0 : 1);
      const handle =
        invoked === "safeDb"
          ? "safeDb"
          : pathName(child.arguments[0] ?? child.expression);
      const parameter =
        callback !== undefined &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? callback.parameters.at(0)
          : undefined;
      if (
        (invoked !== "safeDb" &&
          namedImport(ast, "@/api/db/safe-db", invoked) !== called) ||
        handle === undefined ||
        !parameterSource(child, handle) ||
        child.arguments.length !== (invoked === "safeDb" ? 1 : 2) ||
        callback === undefined ||
        !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
        callback.parameters.length !== 1 ||
        parameter === undefined ||
        !ts.isIdentifier(parameter.name)
      ) {
        unsupported = true;
      } else if (!pureReadCallback(ast, callback.body, parameter.name.text)) {
        if (invoked === callee && ts.isBlock(callback.body)) {
          callbacks.push(callback.body);
        } else {
          unsupported = true;
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return !unsupported && callbacks.length === 1 ? callbacks.at(0) : undefined;
};

const objectKeys = (node: ts.Expression) => {
  const value = expression(node);
  if (!ts.isObjectLiteralExpression(value)) {
    return [];
  }
  return value.properties.map((item) =>
    (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
    (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
      ? item.name.text
      : undefined,
  );
};
const hasOnlyKeys = (node: ts.Expression, keys: readonly string[]) => {
  const actual = objectKeys(node);
  return (
    actual.length === keys.length &&
    keys.every((key) => actual.filter((item) => item === key).length === 1)
  );
};
const arrayOfPaths = (node: ts.Expression, paths: readonly string[]) => {
  const value = expression(node);
  return (
    ts.isArrayLiteralExpression(value) &&
    value.elements.length === paths.length &&
    value.elements.every(
      (item, index) =>
        !ts.isSpreadElement(item) && pathName(item) === paths.at(index),
    )
  );
};

const selectorArrow = (call: ts.CallExpression) => {
  const callback = call.arguments.at(0);
  if (
    call.arguments.length !== 1 ||
    callback === undefined ||
    !ts.isArrowFunction(callback) ||
    callback.parameters.length !== 1 ||
    ts.isBlock(callback.body)
  ) {
    return undefined;
  }
  const parameter = callback.parameters.at(0);
  if (
    parameter === undefined ||
    !ts.isIdentifier(parameter.name) ||
    parameter.initializer !== undefined ||
    parameter.dotDotDotToken !== undefined
  ) {
    return undefined;
  }
  return { parameter: parameter.name.text, body: expression(callback.body) };
};

const copySourceIds = (node: ts.Expression) => {
  const value = expression(node);
  if (
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "map" ||
    pathName(value.expression.expression) !== "sourceEntities"
  ) {
    return false;
  }
  const callback = selectorArrow(value);
  return (
    callback !== undefined &&
    pathName(callback.body) === `${callback.parameter}.id`
  );
};

const excludesAbsentId = (
  node: ts.Expression,
  parameter: string,
  absent: "null" | "undefined",
) => {
  const value = expression(node);
  return (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    pathName(value.left) === parameter &&
    (absent === "null"
      ? value.right.kind === ts.SyntaxKind.NullKeyword
      : pathName(value.right) === "undefined")
  );
};

const copyDestinationIds = (node: ts.Expression) => {
  const value = expression(node);
  if (
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "filter" ||
    !arrayOfPaths(value.expression.expression, [
      "targetParentId",
      "targetRootEntityId",
    ])
  ) {
    return false;
  }
  const callback = selectorArrow(value);
  return (
    callback !== undefined &&
    ts.isBinaryExpression(callback.body) &&
    callback.body.operatorToken.kind ===
      ts.SyntaxKind.AmpersandAmpersandToken &&
    excludesAbsentId(callback.body.left, callback.parameter, "null") &&
    excludesAbsentId(callback.body.right, callback.parameter, "undefined")
  );
};

const moveParentIds = (node: ts.Expression) => {
  const value = expression(node);
  if (!ts.isConditionalExpression(value)) {
    return false;
  }
  const condition = expression(value.condition);
  return (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    pathName(condition.left) === "body.parentId" &&
    condition.right.kind === ts.SyntaxKind.NullKeyword &&
    arrayOfPaths(value.whenTrue, []) &&
    arrayOfPaths(value.whenFalse, ["body.parentId"])
  );
};

const targetMatches = (
  target: ts.Expression,
  expected: TaskMutationEffectOwner["targets"][number],
) => {
  const discriminator = property(target, "type");
  if (
    discriminator === undefined ||
    !ts.isStringLiteral(discriminator) ||
    discriminator.text !== expected.type
  ) {
    return false;
  }
  switch (expected.type) {
    case "link": {
      const id = property(target, "linkId");
      return (
        id !== undefined &&
        pathName(id) === expected.selector &&
        hasOnlyKeys(target, ["type", "linkId"])
      );
    }
    case "entities": {
      const ids = property(target, "entityIds");
      if (ids === undefined || !hasOnlyKeys(target, ["type", "entityIds"])) {
        return false;
      }
      switch (expected.selector) {
        case "link-endpoints":
          return arrayOfPaths(ids, ["sourceEntityId", "targetEntityId"]);
        case "copy-destination":
          return copyDestinationIds(ids);
        default:
          return arrayOfPaths(ids, [expected.selector]);
      }
    }
    case "subtree": {
      const roots = property(target, "rootEntityIds");
      const additional = property(target, "additionalEntityIds");
      if (
        roots === undefined ||
        additional === undefined ||
        !hasOnlyKeys(target, ["type", "rootEntityIds", "additionalEntityIds"])
      ) {
        return false;
      }
      switch (expected.selector) {
        case "move":
          return (
            arrayOfPaths(roots, ["body.entityId"]) && moveParentIds(additional)
          );
        case "copy-source":
          return (
            arrayOfPaths(roots, ["sourceEntityId"]) && copySourceIds(additional)
          );
        case "delete":
          return (
            pathName(roots) === "body.entityIds" && arrayOfPaths(additional, [])
          );
      }
    }
  }
};

const errorOf = (node: ts.Expression, result: string) =>
  pathName(node) === `${result}.error`;
const refusalReturn = (
  node: ts.Expression,
  result: string,
  resultImport: string | undefined,
) => {
  const value = expression(node);
  if (pathName(value) === result) {
    return true;
  }
  if (
    ts.isCallExpression(value) &&
    resultImport !== undefined &&
    pathName(value.expression) === `${resultImport}.err`
  ) {
    const error = value.arguments.at(0);
    return (
      value.arguments.length === 1 &&
      error !== undefined &&
      errorOf(error, result)
    );
  }
  const error = property(value, "error");
  const status = property(value, "status");
  if (
    error !== undefined &&
    errorOf(error, result) &&
    status !== undefined &&
    ts.isStringLiteral(status) &&
    ["denied", "admission-refused", "feature_refused", "rejected"].includes(
      status.text,
    ) &&
    hasOnlyKeys(value, ["status", "error"])
  ) {
    return true;
  }
  const type = property(value, "type");
  if (
    error !== undefined &&
    errorOf(error, result) &&
    type !== undefined &&
    ts.isStringLiteral(type) &&
    type.text === "refused" &&
    hasOnlyKeys(value, ["type", "error"])
  ) {
    return true;
  }
  const ok = property(value, "ok");
  const message = property(value, "message");
  return (
    hasOnlyKeys(value, ["ok", "status", "message"]) &&
    ok?.kind === ts.SyntaxKind.FalseKeyword &&
    status !== undefined &&
    message !== undefined &&
    pathName(status) === `${result}.error.status` &&
    pathName(message) === `${result}.error.message`
  );
};

const refusalGuard = (
  node: ts.Statement | undefined,
  result: string,
  resultImport: string | undefined,
  abortImport: string | undefined,
) => {
  if (
    node === undefined ||
    !ts.isIfStatement(node) ||
    node.elseStatement !== undefined
  ) {
    return false;
  }
  const condition = expression(node.expression);
  if (!ts.isCallExpression(condition)) {
    return false;
  }
  const method = pathName(condition.expression);
  const isError =
    (method === `${result}.isErr` && condition.arguments.length === 0) ||
    (resultImport !== undefined &&
      method === `${resultImport}.isError` &&
      condition.arguments.length === 1 &&
      pathName(condition.arguments[0] ?? condition.expression) === result);
  const statements = ts.isBlock(node.thenStatement)
    ? node.thenStatement.statements
    : [node.thenStatement];
  const returned = statements.length === 1 ? statements.at(0) : undefined;
  if (!isError || returned === undefined) {
    return false;
  }
  if (
    ts.isExpressionStatement(returned) &&
    ts.isCallExpression(returned.expression) &&
    abortImport !== undefined
  ) {
    const call = returned.expression;
    const error = call.arguments.at(0);
    return (
      pathName(call.expression) === abortImport &&
      call.arguments.length === 1 &&
      error !== undefined &&
      errorOf(error, result)
    );
  }
  return (
    ts.isReturnStatement(returned) &&
    returned.expression !== undefined &&
    refusalReturn(returned.expression, result, resultImport)
  );
};

const selectorRoots = (
  target: TaskMutationEffectOwner["targets"][number],
): readonly string[] => {
  switch (target.type) {
    case "link":
      return ["body"];
    case "entities": {
      switch (target.selector) {
        case "link-endpoints":
          return ["sourceEntityId", "targetEntityId"];
        case "copy-destination":
          return ["targetParentId", "targetRootEntityId"];
        default:
          return [target.selector.split(".").at(0) ?? target.selector];
      }
    }
    case "subtree": {
      switch (target.selector) {
        case "copy-source":
          return ["sourceEntityId", "sourceEntities"];
        case "move":
        case "delete":
          return ["body"];
      }
    }
  }
};

const targetBindings = (
  context: ts.Node,
  target: TaskMutationEffectOwner["targets"][number],
) =>
  [target.workspace, ...selectorRoots(target)].every((root) =>
    parameterSource(context, root, true),
  );

type AdmissionPrefixOptions = {
  statements: readonly ts.Statement[];
  owner: TaskMutationEffectOwner;
  txName: string;
  admissionImport: string;
  resultImport: string | undefined;
  abortImport: string | undefined;
  bindingContext: ts.Node;
};
const admissionPrefix = ({
  statements,
  owner,
  txName,
  admissionImport,
  resultImport,
  abortImport,
  bindingContext,
}: AdmissionPrefixOptions) => {
  if (owner.targets.length === 0) {
    return false;
  }
  return owner.targets.every((expected, index) => {
    const statement = statements.at(index * 2);
    if (
      statement === undefined ||
      !ts.isVariableStatement(statement) ||
      statement.declarationList.getFirstToken()?.kind !==
        ts.SyntaxKind.ConstKeyword ||
      statement.declarationList.declarations.length !== 1
    ) {
      return false;
    }
    const declaration = statement.declarationList.declarations.at(0);
    if (
      declaration === undefined ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined ||
      !ts.isAwaitExpression(declaration.initializer)
    ) {
      return false;
    }
    const call = expression(declaration.initializer.expression);
    if (
      !ts.isCallExpression(call) ||
      pathName(call.expression) !== admissionImport ||
      call.arguments.length !== 2 ||
      pathName(call.arguments[0] ?? call.expression) !== txName
    ) {
      return false;
    }
    const options = call.arguments.at(1);
    const target =
      options === undefined ? undefined : property(options, "target");
    const actor =
      options === undefined ? undefined : property(options, "userId");
    const workspace =
      options === undefined ? undefined : property(options, "workspaceId");
    return (
      options !== undefined &&
      hasOnlyKeys(options, ["workspaceId", "userId", "target"]) &&
      target !== undefined &&
      actor !== undefined &&
      workspace !== undefined &&
      pathName(actor) === owner.actor &&
      pathName(workspace) === expected.workspace &&
      targetMatches(target, expected) &&
      targetBindings(bindingContext, expected) &&
      refusalGuard(
        statements.at(index * 2 + 1),
        declaration.name.text,
        resultImport,
        abortImport,
      )
    );
  });
};

type EffectContextOptions = {
  ast: ts.SourceFile;
  node: ts.Node;
  owner: TaskMutationEffectOwner;
};
const effectContext = ({ ast, node, owner }: EffectContextOptions) => {
  const block =
    owner.transaction.type === "supplied"
      ? blockOfSuppliedOwner(node)
      : transactionCallback(ast, node, owner.transaction.callee);
  if (block === undefined) {
    return undefined;
  }
  const callback = block.parent;
  const parameter =
    ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)
      ? callback.parameters.at(0)
      : undefined;
  const actorRoot = owner.actor.split(".").at(0);
  const actorSource =
    owner.transaction.type === "supplied" ? block : callback.parent;
  if (
    actorRoot === undefined ||
    actorSource === undefined ||
    !parameterSource(actorSource, actorRoot, true)
  ) {
    return undefined;
  }
  let txName: string | undefined;
  if (owner.transaction.type === "supplied") {
    txName = owner.transaction.parameter;
  } else if (parameter !== undefined && ts.isIdentifier(parameter.name)) {
    txName = parameter.name.text;
  }
  if (
    txName === undefined ||
    txName === actorRoot ||
    !parameterSource(block, txName)
  ) {
    return undefined;
  }
  const bindingContext =
    owner.transaction.type === "supplied"
      ? (block.statements.at(1) ?? block)
      : actorSource;
  return { block, txName, bindingContext };
};

const parentEffectStatements = (
  block: ts.Block,
  owner: TaskMutationEffectOwner,
) => {
  if (owner.transaction.type !== "parent-insert") {
    return undefined;
  }
  const conditional = block.statements.at(0);
  if (
    conditional === undefined ||
    !ts.isIfStatement(conditional) ||
    conditional.elseStatement !== undefined ||
    pathName(conditional.expression) !== owner.transaction.parent ||
    !ts.isBlock(conditional.thenStatement) ||
    owner.targets.length !== 1 ||
    owner.targets.at(0)?.type !== "entities"
  ) {
    return undefined;
  }
  const statements = conditional.thenStatement.statements;
  if (statements.length !== 2) {
    return undefined;
  }
  const admission = statements.at(0);
  if (admission === undefined || !ts.isVariableStatement(admission)) {
    return undefined;
  }
  const declaration = admission.declarationList.declarations.at(0);
  const awaited = declaration?.initializer;
  const call =
    awaited !== undefined && ts.isAwaitExpression(awaited)
      ? awaited.expression
      : undefined;
  const options =
    call !== undefined && ts.isCallExpression(call)
      ? call.arguments.at(1)
      : undefined;
  const target =
    options === undefined ? undefined : property(options, "target");
  const ids = target === undefined ? undefined : property(target, "entityIds");
  if (
    ids === undefined ||
    !ts.isArrayLiteralExpression(ids) ||
    ids.elements.length !== 1 ||
    pathName(ids.elements[0] ?? ids) !== owner.transaction.parent
  ) {
    return undefined;
  }
  return statements;
};

type EffectStatementsOptions = {
  node: ts.Node;
  block: ts.Block;
  owner: TaskMutationEffectOwner;
};
const effectStatements = ({ node, block, owner }: EffectStatementsOptions) => {
  switch (owner.transaction.type) {
    case "callback":
      return block.statements;
    case "parent-insert":
      return parentEffectStatements(block, owner);
    case "supplied": {
      const txParameter = owner.transaction.parameter;
      if (
        !(
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isFunctionDeclaration(node)
        ) ||
        !node.parameters.some((candidate) =>
          parameterBinds(candidate.name, txParameter),
        ) ||
        !copySourcePrefix(block.statements.at(0))
      ) {
        return undefined;
      }
      return block.statements.slice(1);
    }
  }
};

/** The registered effect protocol is deliberately a closed prologue, not a general CFG proof. */
export const validateTaskMutationEffectOwner = (
  ast: ts.SourceFile,
  owner: TaskMutationEffectOwner,
): string | undefined => {
  const failure = `task mutation owner ${owner.symbol} requires canonical admission first in its effect transaction, on the same transaction and actor, with its registered target and immediate typed refusal`;
  const admissionImport = namedImport(
    ast,
    "@/api/lib/flows/review-task-admission",
    "admitTaskFlowMutation",
  );
  const node = ownerNode(ast, owner.symbol);
  if (
    admissionImport === undefined ||
    node === undefined ||
    !["userId", "deletedByUserId", "user.id"].includes(owner.actor)
  ) {
    return failure;
  }
  const context = effectContext({ ast, node, owner });
  if (context === undefined) {
    return failure;
  }
  const statements = effectStatements({ node, block: context.block, owner });
  if (statements === undefined) {
    return failure;
  }
  return admissionPrefix({
    statements,
    owner,
    txName: context.txName,
    admissionImport,
    resultImport: namedImport(ast, "better-result", "Result"),
    abortImport: namedImport(ast, "@/api/db/safe-db", "abortTransaction"),
    bindingContext: context.bindingContext,
  })
    ? undefined
    : failure;
};
