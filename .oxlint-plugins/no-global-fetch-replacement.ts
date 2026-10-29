import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  resolveImport,
  type ScopeContext,
  unwrapExpression,
} from "./utils.ts";

const registration = (context: ScopeContext, input: unknown): string | null => {
  let callee = unwrapExpression(input);
  while (
    callee?.type === "MemberExpression" ||
    callee?.type === "CallExpression"
  ) {
    if (resolveImport(context, callee)?.moduleId === "bun:test") {
      break;
    }
    callee = unwrapExpression(
      callee.type === "CallExpression" ? callee.callee : callee.object,
    );
  }
  const imported = resolveImport(context, callee);
  return imported?.moduleId === "bun:test" &&
    ["test", "it", "describe"].includes(imported.imported)
    ? imported.imported
    : null;
};

const isFetchTarget = (input: unknown): boolean => {
  const node = unwrapExpression(input);
  return (
    node?.type === "MemberExpression" &&
    memberPropertyName(node) === "fetch" &&
    isIdentifierReference(node.object) &&
    node.object.name === "globalThis"
  );
};

const children = (input: unknown): unknown[] => {
  if (typeof input !== "object" || input === null) {
    return [];
  }
  return Object.entries(input)
    .filter(([key]) => key !== "parent" && key !== "loc" && key !== "range")
    .flatMap(([, value]) =>
      Array.isArray(value)
        ? value.filter(isNode)
        : isNode(value)
          ? [value]
          : [],
    );
};

const isNode = (
  input: unknown,
): input is { type: string; [key: string]: unknown } =>
  typeof input === "object" &&
  input !== null &&
  "type" in input &&
  typeof input.type === "string";

const restoresFetch = (input: unknown): boolean => {
  if (!isNode(input)) {
    return false;
  }
  if (input.type === "AssignmentExpression" && isFetchTarget(input.left)) {
    return true;
  }
  if (input.type === "CallExpression") {
    const callee = unwrapExpression(input.callee);
    if (
      callee?.type === "MemberExpression" &&
      memberPropertyName(callee) === "mockRestore"
    ) {
      return true;
    }
  }
  return children(input).some(restoresFetch);
};

const nodeRange = (node: unknown): [number, number] | null => {
  if (!isAstNode(node) || !Array.isArray(node.range)) {
    return null;
  }
  const [start, end] = node.range;
  return typeof start === "number" && typeof end === "number"
    ? [start, end]
    : null;
};

const allowedInsideRestoredTest = (
  node: unknown,
  testCallbacks: unknown[],
  functions: unknown[],
  tries: unknown[],
): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const range = nodeRange(node);
  if (range === null) {
    return false;
  }
  const contains = (candidate: unknown): candidate is typeof node => {
    const candidateRange = nodeRange(candidate);
    if (candidateRange === null) {
      return false;
    }
    return candidateRange[0] <= range[0] && candidateRange[1] >= range[1];
  };
  const matchingTests = testCallbacks.filter(contains);
  const test = matchingTests
    .toSorted((left, right) => {
      const leftRange = nodeRange(left);
      const rightRange = nodeRange(right);
      return (
        (leftRange?.[1] ?? 0) -
        (leftRange?.[0] ?? 0) -
        ((rightRange?.[1] ?? 0) - (rightRange?.[0] ?? 0))
      );
    })
    .at(0);
  if (test === undefined) {
    return false;
  }
  const testRange = nodeRange(test);
  if (testRange === null) {
    return false;
  }
  const nestedFunction = functions.some((candidate) => {
    const candidateRange = nodeRange(candidate);
    return (
      candidateRange !== null &&
      candidateRange[1] - candidateRange[0] < testRange[1] - testRange[0] &&
      contains(candidate) &&
      candidateRange[0] >= testRange[0] &&
      candidateRange[1] <= testRange[1]
    );
  });
  return (
    !nestedFunction &&
    tries.some((candidate) => {
      const candidateRange = nodeRange(candidate);
      if (
        !isNode(candidate) ||
        candidateRange === null ||
        candidateRange[0] < testRange[0] ||
        candidateRange[1] > testRange[1] ||
        !isNode(candidate.finalizer) ||
        !restoresFetch(candidate.finalizer)
      ) {
        return false;
      }
      const blockRange = nodeRange(candidate.block);
      const finalizerRange = nodeRange(candidate.finalizer);
      const within = (bounds: [number, number] | null) =>
        bounds !== null && bounds[0] <= range[0] && bounds[1] >= range[1];
      return (
        within(blockRange) ||
        within(finalizerRange) ||
        (node.type === "CallExpression" && range[1] < candidateRange[0])
      );
    })
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-global-fetch-replacement" },
  rules: {
    "no-global-fetch-replacement": {
      meta: {
        type: "problem",
        messages: {
          replacement:
            "Register fetch replacements through the API test-fetch owner; direct globalThis.fetch changes are allowed only inside a test-local try/finally that restores fetch.",
        },
      },
      createOnce(context) {
        const violations: ESTree.Node[] = [];
        const testCallbacks: unknown[] = [];
        const functions: unknown[] = [];
        const tries: unknown[] = [];

        return {
          Program() {
            violations.length = 0;
            testCallbacks.length = 0;
            functions.length = 0;
            tries.length = 0;
          },
          FunctionExpression(node) {
            functions.push(node);
          },
          ArrowFunctionExpression(node) {
            functions.push(node);
          },
          TryStatement(node) {
            tries.push(node);
          },
          AssignmentExpression(node) {
            if (isFetchTarget(node.left)) {
              violations.push(node);
            }
          },
          CallExpression(node) {
            const args = node.arguments;
            const target = args.at(0);
            const property = args.at(1);
            const testFunctions = args.filter(
              (argument) =>
                isAstNode(argument) &&
                (argument.type === "ArrowFunctionExpression" ||
                  argument.type === "FunctionExpression"),
            );
            const registeredAs = registration(context, node.callee);
            if (
              (registeredAs !== null && registeredAs !== "describe") ||
              (isIdentifierReference(node.callee) &&
                ["test", "it"].includes(node.callee.name))
            ) {
              testCallbacks.push(...testFunctions);
            }
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type === "MemberExpression" &&
              isIdentifierReference(callee.object) &&
              ["Object", "Reflect"].includes(callee.object.name) &&
              memberPropertyName(callee) === "defineProperty" &&
              isIdentifierReference(target) &&
              target.name === "globalThis" &&
              getPropertyName(property) === "fetch"
            ) {
              violations.push(node);
            }
            const spyImport = resolveImport(context, node.callee);
            const isSpy =
              (spyImport?.moduleId === "bun:test" &&
                spyImport.imported === "spyOn") ||
              (isIdentifierReference(node.callee) &&
                node.callee.name === "spyOn");
            if (
              isSpy &&
              isIdentifierReference(target) &&
              target.name === "globalThis" &&
              getPropertyName(property) === "fetch"
            ) {
              violations.push(node);
            }
          },
          "Program:exit"() {
            for (const violation of violations) {
              if (
                !allowedInsideRestoredTest(
                  violation,
                  testCallbacks,
                  functions,
                  tries,
                )
              ) {
                context.report({ node: violation, messageId: "replacement" });
              }
            }
          },
        };
      },
    },
  },
});
