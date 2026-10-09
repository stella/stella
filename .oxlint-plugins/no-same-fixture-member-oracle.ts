import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isTestFile,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toContain",
  "toContainEqual",
]);
const TEST_FUNCTIONS = new Set(["describe", "it", "test"]);
const TEST_MODIFIERS = new Set(["each", "if", "only", "skip", "skipIf"]);
const ORACLE_NAME =
  /(?:classif|detect|derive|project|extract|parse|read|build|expected)/iu;
const FIXTURE_ROOT =
  /^[A-Za-z0-9_$]*(?:fixture|fx|case|sample|input|record|row)[A-Za-z0-9_$]*(?:\.|$)/iu;

type AliasMap = Map<Variable, string>;
type ValueMap = Map<Variable, unknown>;
type ResolveBinding = (identifier: unknown) => Variable | null;

const pathText = (path: string): string => path.slice(path.indexOf(":") + 1);

const memberPath = (
  node: unknown,
  aliases: AliasMap,
  resolveBinding: ResolveBinding,
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isIdentifier(expression)) {
    const binding = resolveBinding(expression);
    const alias = binding === null ? undefined : aliases.get(binding);
    if (alias !== undefined) {
      return alias;
    }
    const declarationStart = binding?.defs.at(0)?.name.range[0];
    const root = declarationStart ?? `global-${expression.name}`;
    return `${root}:${expression.name}`;
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const property = getPropertyName(expression.property);
  const object = memberPath(expression.object, aliases, resolveBinding);
  return property === null || object === null ? null : `${object}.${property}`;
};

type PathsInOptions = {
  aliases: AliasMap;
  resolveBinding: ResolveBinding;
  paths?: Set<string>;
  values?: ValueMap;
};

const pathsIn = (
  node: unknown,
  {
    aliases,
    resolveBinding,
    paths = new Set<string>(),
    values,
  }: PathsInOptions,
) => {
  if (!isAstNode(node)) {
    return paths;
  }
  const path = memberPath(node, aliases, resolveBinding);
  if (
    path !== null &&
    path.includes(".") &&
    FIXTURE_ROOT.test(pathText(path))
  ) {
    paths.add(path);
    if (node.type === "MemberExpression") {
      return paths;
    }
  }
  if (isIdentifier(node)) {
    const binding = resolveBinding(node);
    if (binding !== null && values?.has(binding)) {
      pathsIn(values.get(binding), { aliases, resolveBinding, paths });
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        pathsIn(child, { aliases, resolveBinding, paths });
      }
    } else if (isAstNode(value)) {
      pathsIn(value, { aliases, resolveBinding, paths });
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

const isConstructedOracle = (
  node: unknown,
  values: ValueMap,
  resolveBinding: ResolveBinding,
): boolean => {
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
  if (isIdentifier(expression)) {
    const binding = resolveBinding(expression);
    const value = binding === null ? undefined : values.get(binding);
    return (
      value !== undefined &&
      isConstructedOracle(value, new Map(), resolveBinding)
    );
  }
  const name = calledName(expression);
  return name !== null && ORACLE_NAME.test(name);
};

const containsOracleCall = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const name = calledName(node);
  if (name !== null && ORACLE_NAME.test(name)) {
    return true;
  }
  return Object.entries(node).some(([key, value]) => {
    if (key === "parent") {
      return false;
    }
    return Array.isArray(value)
      ? value.some(containsOracleCall)
      : containsOracleCall(value);
  });
};

type IndependentAnchorOptions = {
  aliases: AliasMap;
  values: ValueMap;
  resolveBinding: ResolveBinding;
  sharedPath: string;
};

const isIndependentAnchor = (
  node: unknown,
  { aliases, values, resolveBinding, sharedPath }: IndependentAnchorOptions,
): boolean => {
  const expression = unwrapExpression(node);
  const hasAnchorShape =
    expression?.type === "Literal" ||
    expression?.type === "TemplateLiteral" ||
    expression?.type === "Identifier" ||
    expression?.type === "MemberExpression";
  return (
    hasAnchorShape &&
    !pathsIn(expression, {
      aliases,
      resolveBinding,
      values,
    }).has(sharedPath)
  );
};

type RepeatedObservationOptions = {
  actual: AstNode;
  expected: AstNode;
  values: ValueMap;
  resolveBinding: ResolveBinding;
  sourceText: (node: AstNode) => string;
};

const repeatedObservationName = ({
  actual,
  expected,
  values,
  resolveBinding,
  sourceText,
}: RepeatedObservationOptions): string | null => {
  const expression = unwrapExpression(expected);
  if (!isIdentifier(expression)) {
    return null;
  }
  const binding = resolveBinding(expression);
  const initializer = binding === null ? undefined : values.get(binding);
  return isAstNode(initializer) &&
    sourceText(actual) === sourceText(initializer)
    ? expression.name
    : null;
};

type MirroredArrayContextOptions = {
  actual: AstNode;
  expected: AstNode;
  aliases: AliasMap;
  values: ValueMap;
  resolveBinding: ResolveBinding;
  sharedPath: string;
  sourceText: (node: AstNode) => string;
};

const hasMirroredArrayContext = ({
  actual,
  expected,
  aliases,
  values,
  resolveBinding,
  sharedPath,
  sourceText,
}: MirroredArrayContextOptions): boolean => {
  if (
    actual.type !== "ArrayExpression" ||
    expected.type !== "ArrayExpression" ||
    !Array.isArray(actual.elements) ||
    !Array.isArray(expected.elements) ||
    actual.elements.length !== expected.elements.length
  ) {
    return false;
  }
  let mirroredSharedContext = false;
  let independentOracle = false;
  for (const [index, actualElement] of actual.elements.entries()) {
    const expectedElement = expected.elements.at(index);
    if (!isAstNode(actualElement) || !isAstNode(expectedElement)) {
      continue;
    }
    if (
      pathsIn(actualElement, { aliases, resolveBinding, values }).has(
        sharedPath,
      ) &&
      sourceText(actualElement) === sourceText(expectedElement)
    ) {
      mirroredSharedContext = true;
      continue;
    }
    if (
      isIndependentAnchor(expectedElement, {
        aliases,
        values,
        resolveBinding,
        sharedPath,
      })
    ) {
      independentOracle = true;
    }
  }
  return mirroredSharedContext && independentOracle;
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

const isTestRegistration = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  let callee = unwrapExpression(node.callee);
  while (callee !== null) {
    if (isIdentifier(callee)) {
      return TEST_FUNCTIONS.has(callee.name);
    }
    if (callee.type === "CallExpression") {
      callee = unwrapExpression(callee.callee);
      continue;
    }
    if (callee.type !== "MemberExpression") {
      return false;
    }
    const modifier = getPropertyName(callee.property);
    if (modifier === null || !TEST_MODIFIERS.has(modifier)) {
      return false;
    }
    callee = unwrapExpression(callee.object);
  }
  return false;
};

const testScope = (node: AstNode): AstNode => {
  let current = node;
  while (isAstNode(current.parent)) {
    current = current.parent;
    if (isTestRegistration(current)) {
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
        const expectedValues: ValueMap = new Map();
        const matchers: AstNode[] = [];
        const resolveBinding: ResolveBinding = (identifier) =>
          isIdentifierReference(identifier)
            ? resolveVariable(context, identifier)
            : null;
        return {
          before() {
            aliases.clear();
            expectedValues.clear();
            matchers.length = 0;
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
            const binding = resolveBinding(node.id);
            if (binding === null) {
              return;
            }
            const parent = node.parent;
            if (
              parent.type === "VariableDeclaration" &&
              parent.kind === "const"
            ) {
              expectedValues.set(binding, node.init);
            }
            const path = memberPath(node.init, aliases, resolveBinding);
            if (path?.includes(".")) {
              aliases.set(binding, path);
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
                !isConstructedOracle(
                  parts.expected,
                  expectedValues,
                  resolveBinding,
                ) ||
                (parts.actual.type === "ObjectExpression" &&
                  parts.expected.type === "ObjectExpression" &&
                  !containsOracleCall(parts.actual) &&
                  !containsOracleCall(parts.expected))
              ) {
                continue;
              }
              const actualPaths = pathsIn(parts.actual, {
                aliases,
                resolveBinding,
              });
              const shared = [
                ...pathsIn(parts.expected, {
                  aliases,
                  resolveBinding,
                  values: expectedValues,
                }),
              ].find((path) => actualPaths.has(path));
              if (shared === undefined) {
                continue;
              }
              const sourceText = (node: AstNode) =>
                context.sourceCode.getText(node);
              if (
                hasMirroredArrayContext({
                  actual: parts.actual,
                  expected: parts.expected,
                  aliases,
                  values: expectedValues,
                  resolveBinding,
                  sharedPath: shared,
                  sourceText,
                })
              ) {
                continue;
              }
              const actualText = context.sourceCode.getText(parts.actual);
              const repeatedName = repeatedObservationName({
                actual: parts.actual,
                expected: parts.expected,
                values: expectedValues,
                resolveBinding,
                sourceText,
              });
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
                  (context.sourceCode.getText(candidateParts.actual) ===
                    actualText ||
                    context.sourceCode.getText(candidateParts.actual) ===
                      repeatedName) &&
                  isIndependentAnchor(candidateParts.expected, {
                    aliases,
                    values: expectedValues,
                    resolveBinding,
                    sharedPath: shared,
                  })
                );
              });
              if (!anchored) {
                context.report({
                  node: matcher,
                  messageId: "shared",
                  data: { path: pathText(shared) },
                });
              }
            }
          },
        };
      },
    },
  },
});
