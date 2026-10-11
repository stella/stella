import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const TEST_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../.oxlint-plugins/__tests__",
);
// Every exception must name a measured runtime that exceeds the central 30s budget.
const TIMEOUT_ALLOWLIST: Readonly<Record<string, string>> = {};
const TEST_APIS = new Set(["test", "it", "describe", "setDefaultTimeout"]);

const memberPath = (expression: ts.Expression): string[] => {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const members = memberPath(expression.expression);
    members.push(expression.name.text);
    return members;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    const members = memberPath(expression.expression);
    members.push(expression.argumentExpression.text);
    return members;
  }
  if (
    ts.isCallExpression(expression) ||
    ts.isTaggedTemplateExpression(expression)
  ) {
    return memberPath(
      ts.isCallExpression(expression) ? expression.expression : expression.tag,
    );
  }
  if (ts.isParenthesizedExpression(expression)) {
    return memberPath(expression.expression);
  }
  return [];
};

const hasTimeoutOverride = (file: ts.SourceFile): boolean => {
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  const values = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "bun:test"
    ) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (named === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
      continue;
    }
    for (const binding of named.elements) {
      bindings.set(
        binding.name.text,
        binding.propertyName?.text ?? binding.name.text,
      );
    }
  }
  const collectValues = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.getFirstToken(file)?.kind === ts.SyntaxKind.ConstKeyword &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      values.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectValues);
  };
  collectValues(file);

  const isTimeoutFreeOptions = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): boolean => {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return isTimeoutFreeOptions(expression.expression, seen);
    }
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) {
        return false;
      }
      seen.add(expression.text);
      const value = values.get(expression.text);
      return value !== undefined && isTimeoutFreeOptions(value, seen);
    }
    if (!ts.isObjectLiteralExpression(expression)) {
      return false;
    }
    return expression.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) {
        return isTimeoutFreeOptions(property.expression, new Set(seen));
      }
      const name = property.name;
      return (
        name !== undefined &&
        (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
        name.text !== "timeout"
      );
    });
  };

  const visit = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)) {
      // The data call in test.each(cases)(...) has no test arguments.
      const isFactory =
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        (ts.isTaggedTemplateExpression(node.parent) &&
          node.parent.tag === node);
      const members = memberPath(node.expression);
      const root = members.at(0);
      let api = root === undefined ? undefined : bindings.get(root);
      if (root !== undefined && namespaces.has(root)) {
        api = members.at(1);
      }
      if (!isFactory && api !== undefined && TEST_APIS.has(api)) {
        const secondArgument = node.arguments.at(1);
        const thirdArgument = node.arguments.at(2);
        const optionsFirst =
          secondArgument !== undefined &&
          (ts.isObjectLiteralExpression(secondArgument) ||
            ts.isIdentifier(secondArgument)) &&
          thirdArgument !== undefined &&
          (ts.isArrowFunction(thirdArgument) ||
            ts.isFunctionExpression(thirdArgument));
        const optionsArgument = optionsFirst ? secondArgument : thirdArgument;
        if (
          api === "setDefaultTimeout" ||
          (optionsArgument !== undefined &&
            !isTimeoutFreeOptions(optionsArgument))
        ) {
          return true;
        }
      }
    }
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(file);
};

type CustomLintTestTimeoutOptions = {
  directory?: string;
  allowlist?: Readonly<Record<string, string>>;
};

export const customLintTestTimeoutViolations = ({
  directory = TEST_DIRECTORY,
  allowlist = TIMEOUT_ALLOWLIST,
}: CustomLintTestTimeoutOptions = {}): string[] => {
  const violations: string[] = [];
  for (const filename of new Bun.Glob(
    "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  ).scanSync(directory)) {
    const source = readFileSync(path.join(directory, filename), "utf-8");
    const file = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    if (!hasTimeoutOverride(file)) {
      continue;
    }
    const reason = allowlist[filename];
    if (reason === undefined || reason.trim() === "") {
      violations.push(`${filename}: timeout override is not allow-listed`);
    }
  }
  return violations.toSorted();
};
