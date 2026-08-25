import ts from "typescript";

const BUN_TIMEOUT_APIS = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "it",
  "setDefaultTimeout",
  "test",
]);
const BUN_JEST_BINDING = "jest";

const rootIdentifier = (
  expression: ts.Expression,
): ts.Identifier | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return rootIdentifier(expression.expression);
  }
  if (ts.isElementAccessExpression(expression)) {
    return rootIdentifier(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return rootIdentifier(expression.expression);
  }
  return undefined;
};

const isPropertyTestTimeoutCall = (expression: ts.Expression): boolean =>
  ts.isCallExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  expression.expression.text === "propertyTestTimeout";

const propertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
};

type BunTestBindings = {
  named: Map<string, string>;
  namespaces: Set<string>;
};

const bunTestBindings = (sourceFile: ts.SourceFile): BunTestBindings => {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "bun:test" ||
      statement.importClause?.namedBindings === undefined
    ) {
      continue;
    }
    const { namedBindings } = statement.importClause;
    if (ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (
        BUN_TIMEOUT_APIS.has(importedName) ||
        importedName === BUN_JEST_BINDING
      ) {
        named.set(element.name.text, importedName);
      }
    }
  }
  return { named, namespaces };
};

const memberPath = (
  expression: ts.Expression,
  root: string,
): string[] | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text === root ? [] : undefined;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const path = memberPath(expression.expression, root);
    path?.push(expression.name.text);
    return path;
  }
  if (ts.isElementAccessExpression(expression)) {
    if (!ts.isStringLiteral(expression.argumentExpression)) {
      return undefined;
    }
    const path = memberPath(expression.expression, root);
    path?.push(expression.argumentExpression.text);
    return path;
  }
  if (ts.isCallExpression(expression)) {
    return memberPath(expression.expression, root);
  }
  return undefined;
};

type CollectTimeoutViolationsOptions = {
  relativePath: string;
  source: string;
};

/** Find Bun timeout overrides that bypass the property-run scale factor. */
export const collectPropertyTimeoutViolations = ({
  relativePath,
  source,
}: CollectTimeoutViolationsOptions): string[] => {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = bunTestBindings(sourceFile);
  const violations: string[] = [];
  const report = (node: ts.Node, api: string) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push(
      `${relativePath}:${line + 1}: ${api} timeout is not factor-scaled`,
    );
  };

  const inspectOptions = (options: ts.ObjectLiteralExpression, api: string) => {
    for (const member of options.properties) {
      if (
        ts.isPropertyAssignment(member) &&
        propertyName(member.name) === "timeout"
      ) {
        if (!isPropertyTestTimeoutCall(member.initializer)) {
          report(member.initializer, api);
        }
        continue;
      }
      if (
        ts.isShorthandPropertyAssignment(member) &&
        member.name.text === "timeout"
      ) {
        report(member, api);
        continue;
      }
      if (!ts.isSpreadAssignment(member)) {
        continue;
      }
      if (ts.isObjectLiteralExpression(member.expression)) {
        inspectOptions(member.expression, api);
        continue;
      }
      report(member.expression, api);
    }
  };

  const visit = (node: ts.Node) => {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    // In `test.each(cases)(...)`, only the outer call has the test signature.
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      ts.forEachChild(node, visit);
      return;
    }

    const identifier = rootIdentifier(node.expression);
    const namedApi =
      identifier === undefined
        ? undefined
        : bindings.named.get(identifier.text);
    const members =
      identifier === undefined
        ? undefined
        : memberPath(node.expression, identifier.text);
    const namespaceMember =
      identifier !== undefined && bindings.namespaces.has(identifier.text)
        ? members?.at(0)
        : undefined;
    const namedJestSetTimeout =
      namedApi === BUN_JEST_BINDING &&
      members?.length === 1 &&
      members.at(0) === "setTimeout";
    const namespaceJestSetTimeout =
      namespaceMember === BUN_JEST_BINDING &&
      members?.length === 2 &&
      members.at(1) === "setTimeout";
    let api: string | undefined;
    if (namedJestSetTimeout || namespaceJestSetTimeout) {
      api = "jest.setTimeout";
    } else if (namedApi !== BUN_JEST_BINDING) {
      api =
        namedApi ??
        (namespaceMember !== undefined && BUN_TIMEOUT_APIS.has(namespaceMember)
          ? namespaceMember
          : undefined);
    }
    if (api === undefined) {
      ts.forEachChild(node, visit);
      return;
    }

    if (api === "setDefaultTimeout" || api === "jest.setTimeout") {
      const timeout = node.arguments.at(0);
      if (timeout !== undefined && !isPropertyTestTimeoutCall(timeout)) {
        report(timeout, api);
      }
      ts.forEachChild(node, visit);
      return;
    }

    for (const argument of node.arguments) {
      if (ts.isObjectLiteralExpression(argument)) {
        inspectOptions(argument, api);
      }
    }

    const positionalIndex = api === "test" || api === "it" ? 2 : 1;
    const positionalTimeout = node.arguments.at(positionalIndex);
    if (
      positionalTimeout !== undefined &&
      !ts.isObjectLiteralExpression(positionalTimeout) &&
      !ts.isArrowFunction(positionalTimeout) &&
      !ts.isFunctionExpression(positionalTimeout) &&
      !isPropertyTestTimeoutCall(positionalTimeout) &&
      !(
        ts.isIdentifier(positionalTimeout) &&
        positionalTimeout.text === "undefined"
      )
    ) {
      report(positionalTimeout, api);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
};
