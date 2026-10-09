import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isTestFile,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toContainEqual",
]);
const TEST_FUNCTIONS = new Set(["it", "test"]);
const ORACLE_NAME =
  /(?:classif|detect|derive|project|extract|parse|read|build|expected)/iu;
const FIXTURE_ROOT =
  /^[A-Za-z0-9_$]*(?:fixture|fx|case|sample|input|record|row)[A-Za-z0-9_$]*(?:\.|$)/iu;

type AliasMap = Map<string, string>;

const memberPath = (node: unknown, aliases: AliasMap): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isIdentifier(expression)) {
    return aliases.get(expression.name) ?? expression.name;
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const property = getPropertyName(expression.property);
  const object = memberPath(expression.object, aliases);
  return property === null || object === null ? null : `${object}.${property}`;
};

const pathsIn = (
  node: unknown,
  aliases: AliasMap,
  paths = new Set<string>(),
) => {
  if (!isAstNode(node)) {
    return paths;
  }
  const path = memberPath(node, aliases);
  if (path !== null && path.includes(".") && FIXTURE_ROOT.test(path)) {
    paths.add(path);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        pathsIn(child, aliases, paths);
      }
    } else if (isAstNode(value)) {
      pathsIn(value, aliases, paths);
    }
  }
  return paths;
};

const calledName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (isIdentifier(callee)) {
    return callee.name;
  }
  return callee?.type === "MemberExpression"
    ? getPropertyName(callee.property)
    : null;
};

const isConstructedOracle = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (
    expression.type === "ObjectExpression" ||
    expression.type === "ArrayExpression"
  ) {
    return true;
  }
  const name = calledName(expression);
  return name !== null && ORACLE_NAME.test(name);
};

const isIndependentAnchor = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "Literal" ||
    expression?.type === "TemplateLiteral" ||
    expression?.type === "Identifier" ||
    expression?.type === "MemberExpression"
  );
};

const matcherParts = (node: unknown) => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !Array.isArray(node.arguments) ||
    node.arguments.length !== 1
  ) {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (callee?.type !== "MemberExpression") {
    return null;
  }
  const matcher = getPropertyName(callee.property);
  if (matcher === null || !MATCHERS.has(matcher)) {
    return null;
  }
  let receiver = unwrapExpression(callee.object);
  let negated = false;
  if (
    receiver?.type === "MemberExpression" &&
    getPropertyName(receiver.property) === "not"
  ) {
    negated = true;
    receiver = unwrapExpression(receiver.object);
  }
  if (
    receiver?.type !== "CallExpression" ||
    !Array.isArray(receiver.arguments)
  ) {
    return null;
  }
  const expectCallee = unwrapExpression(receiver.callee);
  if (expectCallee?.type !== "Identifier" || expectCallee.name !== "expect") {
    return null;
  }
  const actual = receiver.arguments.at(0);
  const expected = node.arguments.at(0);
  return isAstNode(actual) && isAstNode(expected)
    ? { actual, expected, negated }
    : null;
};

const testScope = (node: AstNode): AstNode => {
  let current = node;
  while (isAstNode(current.parent)) {
    current = current.parent;
    const name = calledName(current);
    if (name !== null && TEST_FUNCTIONS.has(name)) {
      return current;
    }
  }
  return current;
};

export default eslintCompatPlugin({
  meta: { name: "no-same-fixture-member-oracle" },
  rules: {
    "no-same-fixture-member-oracle": {
      meta: {
        type: "problem",
        messages: {
          shared:
            "The actual and computed expectation both depend on '{{path}}'. Anchor the expected result in an independent literal, golden value, or fixture field.",
        },
      },
      createOnce(context) {
        const aliases: AliasMap = new Map();
        const matchers: AstNode[] = [];
        return {
          before() {
            const filename = filenameForContext(context);
            if (filename.includes("/.oxlint-plugins/__tests__/")) {
              return false;
            }
            if (filename.includes(".oxlint-plugins/__fixtures__/")) {
              return filename.endsWith(
                "/no-same-fixture-member-oracle.fixture.ts",
              );
            }
            return isTestFile(filename);
          },
          VariableDeclarator(node) {
            if (node.id.type !== "Identifier") {
              return;
            }
            const path = memberPath(node.init, aliases);
            if (path?.includes(".")) {
              aliases.set(node.id.name, path);
            }
          },
          CallExpression(node) {
            if (matcherParts(node) !== null && isAstNode(node)) {
              matchers.push(node);
            }
          },
          "Program:exit"() {
            for (const matcher of matchers) {
              const parts = matcherParts(matcher);
              if (
                parts === null ||
                !isConstructedOracle(parts.expected) ||
                (parts.actual.type === "ObjectExpression" &&
                  parts.expected.type === "ObjectExpression")
              ) {
                continue;
              }
              const actualPaths = pathsIn(parts.actual, aliases);
              const shared = [...pathsIn(parts.expected, aliases)].find(
                (path) => actualPaths.has(path),
              );
              if (shared === undefined) {
                continue;
              }
              const actualText = context.sourceCode.getText(parts.actual);
              const scope = testScope(matcher);
              const anchored = matchers.some((candidate) => {
                if (candidate === matcher) {
                  return false;
                }
                const candidateParts = matcherParts(candidate);
                return (
                  candidateParts !== null &&
                  !candidateParts.negated &&
                  testScope(candidate) === scope &&
                  context.sourceCode.getText(candidateParts.actual) ===
                    actualText &&
                  isIndependentAnchor(candidateParts.expected)
                );
              });
              if (!anchored) {
                context.report({
                  node: matcher,
                  messageId: "shared",
                  data: { path: shared },
                });
              }
            }
          },
        };
      },
    },
  },
});
