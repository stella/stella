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
const FIXTURE_NOUN = /^(?:fixture|fx|case|sample|input|record|row)s?$/u;

type AliasMap = Map<Variable, string>;
type ValueMap = Map<Variable, unknown>;
type ResolveBinding = (identifier: unknown) => Variable | null;

const pathText = (path: string): string => path.slice(path.indexOf(":") + 1);

// Judge the root by its head noun (`testCase`, `inputRow`), not a substring:
// domain names such as `caseLawDecisions` or `CASE_LAW_*` are not fixtures.
const hasFixtureRoot = (path: string): boolean => {
  const root = pathText(path).split(".").at(0) ?? "";
  const head = root
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .split(/[_$]+/u)
    .findLast((segment) => segment.length > 0);
  return head !== undefined && FIXTURE_NOUN.test(head.toLowerCase());
};

const pathDependsOn = (path: string, dependency: string): boolean =>
  path === dependency || path.startsWith(`${dependency}.`);

const pathsDependOn = (paths: Set<string>, dependency: string): boolean =>
  [...paths].some((path) => pathDependsOn(path, dependency));

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

// "opaque": an awaited call with no oracle inside reads system state (a
// snapshot before an action, a row from another store); its result is an
// observation, not a value computed from the fixture keys it was given.
type ObservationTracing = "opaque" | "traced";

type PathsInOptions = {
  aliases: AliasMap;
  resolveBinding: ResolveBinding;
  paths?: Set<string>;
  values?: ValueMap | undefined;
  expanded?: Set<unknown>;
  observations?: ObservationTracing;
};

const isAwaitedObservation = (node: AstNode): boolean => {
  if (node.type !== "AwaitExpression") {
    return false;
  }
  const argument = unwrapExpression(node.argument);
  return argument?.type === "CallExpression" && !containsOracleCall(argument);
};

const pathsIn = (
  node: unknown,
  {
    aliases,
    resolveBinding,
    paths = new Set<string>(),
    values,
    expanded = new Set<unknown>(),
    observations = "traced",
  }: PathsInOptions,
) => {
  if (!isAstNode(node)) {
    return paths;
  }
  if (observations === "opaque" && isAwaitedObservation(node)) {
    return paths;
  }
  const path = memberPath(node, aliases, resolveBinding);
  if (path !== null && path.includes(".") && hasFixtureRoot(path)) {
    paths.add(path);
    if (node.type === "MemberExpression") {
      return paths;
    }
  }
  if (isIdentifier(node)) {
    const binding = resolveBinding(node);
    // Expand each initializer once: chained aliases resolve, self-referencing
    // initializers terminate.
    if (binding !== null && values?.has(binding) && !expanded.has(binding)) {
      expanded.add(binding);
      pathsIn(values.get(binding), {
        aliases,
        resolveBinding,
        paths,
        values,
        expanded,
        observations,
      });
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (
      key === "property" &&
      node.type === "MemberExpression" &&
      node.computed !== true
    ) {
      continue;
    }
    if (key === "key" && node.type === "Property" && node.computed !== true) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        pathsIn(child, {
          aliases,
          resolveBinding,
          paths,
          values,
          expanded,
          observations,
        });
      }
    } else if (isAstNode(value)) {
      pathsIn(value, {
        aliases,
        resolveBinding,
        paths,
        values,
        expanded,
        observations,
      });
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
    !pathsDependOn(
      pathsIn(expression, {
        aliases,
        resolveBinding,
        values,
      }),
      sharedPath,
    )
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
      pathsDependOn(
        pathsIn(actualElement, { aliases, resolveBinding, values }),
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
              const expectedPaths = pathsIn(parts.expected, {
                aliases,
                resolveBinding,
                values: expectedValues,
                observations: "opaque",
              });
              const sharedPaths = [...actualPaths].filter((path) =>
                pathsDependOn(expectedPaths, path),
              );
              if (sharedPaths.length === 0) {
                continue;
              }
              const sourceText = (node: AstNode) =>
                context.sourceCode.getText(node);
              const actualText = context.sourceCode.getText(parts.actual);
              const repeatedName = repeatedObservationName({
                actual: parts.actual,
                expected: parts.expected,
                values: expectedValues,
                resolveBinding,
                sourceText,
              });
              const scope = testScope(matcher);
              const unanchored = sharedPaths.find((sharedPath) => {
                if (
                  hasMirroredArrayContext({
                    actual: parts.actual,
                    expected: parts.expected,
                    aliases,
                    values: expectedValues,
                    resolveBinding,
                    sharedPath,
                    sourceText,
                  })
                ) {
                  return false;
                }
                return !matchers.some((candidate) => {
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
                      sharedPath,
                    })
                  );
                });
              });
              if (unanchored !== undefined) {
                context.report({
                  node: matcher,
                  messageId: "shared",
                  data: { path: pathText(unanchored) },
                });
              }
            }
          },
        };
      },
    },
  },
});
