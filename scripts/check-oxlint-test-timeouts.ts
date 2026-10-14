import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "../packages/portable-path/src/index";
import { guardEnforcesLine } from "./guard-rollouts.ts";

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
  if (ts.isElementAccessExpression(expression)) {
    const members = memberPath(expression.expression);
    if (ts.isStringLiteralLike(expression.argumentExpression)) {
      members.push(expression.argumentExpression.text);
    }
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

type TestPolicyViolationOptions = {
  file: ts.SourceFile;
  enforcesLine: (line: number) => boolean;
};

const testPolicyViolation = ({
  file,
  enforcesLine,
}: TestPolicyViolationOptions): string | undefined => {
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
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
  const apiFor = (expression: ts.Expression): string | undefined => {
    const members = memberPath(expression);
    const root = members.at(0);
    if (root === undefined) {
      return undefined;
    }
    return namespaces.has(root) ? members.at(1) : bindings.get(root);
  };
  const isTestReference = (expression: ts.Expression): boolean => {
    const api = apiFor(expression);
    if (api !== undefined && TEST_APIS.has(api)) {
      return true;
    }
    const members = memberPath(expression);
    return members.length === 1 && namespaces.has(members.at(0) ?? "");
  };
  const isFactoryValue = (expression: ts.Expression): boolean => {
    if (
      !ts.isCallExpression(expression) &&
      !ts.isTaggedTemplateExpression(expression)
    ) {
      return false;
    }
    let target: ts.Expression = ts.isCallExpression(expression)
      ? expression.expression
      : expression.tag;
    while (ts.isParenthesizedExpression(target)) {
      target = target.expression;
    }
    return (
      !ts.isCallExpression(target) &&
      !ts.isTaggedTemplateExpression(target) &&
      ["each", "if", "skipIf"].includes(memberPath(target).at(-1) ?? "")
    );
  };
  const isTimeoutFreeOptions = (expression: ts.Expression): boolean => {
    if (!ts.isObjectLiteralExpression(expression)) {
      return false;
    }
    return expression.properties.every((property) => {
      const name = property.name;
      return (
        name !== undefined &&
        (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
        name.text !== "timeout"
      );
    });
  };

  const isIndirectReference = (expression: ts.Expression): boolean => {
    if (!isTestReference(expression)) {
      return false;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      !ts.isStringLiteralLike(expression.argumentExpression)
    ) {
      return true;
    }
    if (
      memberPath(expression).some((member) =>
        ["bind", "call", "apply"].includes(member),
      )
    ) {
      return true;
    }
    const parent = expression.parent;
    const isName =
      "name" in parent &&
      parent.name === expression &&
      !ts.isShorthandPropertyAssignment(parent) &&
      !ts.isExportSpecifier(parent);
    const isChainPart =
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isParenthesizedExpression(parent)) &&
      parent.expression === expression;
    const isCallTarget =
      (ts.isCallExpression(parent) && parent.expression === expression) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === expression);
    const isCall =
      ts.isCallExpression(expression) ||
      ts.isTaggedTemplateExpression(expression);
    return (
      !isName &&
      !isChainPart &&
      !isCallTarget &&
      (!isCall || isFactoryValue(expression))
    );
  };

  const enforcesNode = (node: ts.Node): boolean => {
    const start =
      file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const end = file.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    for (let line = start; line <= end; line += 1) {
      if (enforcesLine(line)) {
        return true;
      }
    }
    return false;
  };

  const visit = (node: ts.Node): string | undefined => {
    if (ts.isImportDeclaration(node)) {
      return undefined;
    }
    if (
      ts.isExpression(node) &&
      isIndirectReference(node) &&
      enforcesNode(node)
    ) {
      return "call test APIs directly";
    }
    if (ts.isCallExpression(node)) {
      // The data call in test.each(cases)(...) has no test arguments.
      const isFactory =
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        (ts.isTaggedTemplateExpression(node.parent) &&
          node.parent.tag === node);
      const api = apiFor(node.expression);
      if (!isFactory && api !== undefined && TEST_APIS.has(api)) {
        const secondArgument = node.arguments.at(1);
        const thirdArgument = node.arguments.at(2);
        const optionsFirst =
          secondArgument !== undefined &&
          (ts.isObjectLiteralExpression(secondArgument) ||
            (thirdArgument !== undefined &&
              (ts.isArrowFunction(thirdArgument) ||
                ts.isFunctionExpression(thirdArgument))));
        const optionsArgument = optionsFirst ? secondArgument : thirdArgument;
        if (
          (api === "setDefaultTimeout" && enforcesNode(node)) ||
          node.arguments.some(
            (argument) =>
              ts.isSpreadElement(argument) && enforcesNode(argument),
          ) ||
          (optionsArgument !== undefined &&
            !isTimeoutFreeOptions(optionsArgument) &&
            enforcesNode(optionsArgument))
        ) {
          return "pass test options inline without timeout keys or spreads";
        }
      }
    }
    return ts.forEachChild(node, visit);
  };
  return visit(file);
};

type CustomLintTestTimeoutOptions = {
  directory?: string;
  allowlist?: Readonly<Record<string, string>>;
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  now?: Date;
  scope?: "all" | "rollout";
};

export const customLintTestTimeoutViolations = ({
  directory = TEST_DIRECTORY,
  allowlist = TIMEOUT_ALLOWLIST,
  changedLines,
  now,
  scope = "rollout",
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
    const repositoryFile = repoRelativePath(
      path.resolve(import.meta.dirname, ".."),
      path.join(directory, filename),
    );
    const violation = testPolicyViolation({
      file,
      enforcesLine: (line) =>
        scope === "all" ||
        guardEnforcesLine({
          guard: "central-test-timeout",
          file: repositoryFile,
          line,
          ...(changedLines === undefined ? {} : { changedLines }),
          ...(now === undefined ? {} : { now }),
        }),
    });
    if (violation === undefined) {
      continue;
    }
    const reason = allowlist[filename];
    if (reason === undefined || reason.trim() === "") {
      violations.push(
        `${filename}: ${violation}; exceptions require an allow-list reason`,
      );
    }
  }
  return violations.toSorted();
};

if (import.meta.main) {
  const violations = customLintTestTimeoutViolations({
    scope: process.argv.includes("--all") ? "all" : "rollout",
  });
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
}
