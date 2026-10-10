import {
  eslintCompatPlugin,
  type ESTree,
  type Variable,
} from "@oxlint/plugins";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BASELINE_PATHS } from "../scripts/baseline-paths.ts";
import { parseTestStateBaseline } from "../scripts/check-test-state-baseline.ts";
import {
  type ScopeContext,
  type FilenameContext,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  resolveVariable,
  resolveImport,
  stableInitializer,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const BASELINE_PATH = BASELINE_PATHS.testState;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_MODULE = "apps/api/src/env";
const FIXTURE_MODULE = "apps/api/src/tests/helpers/test-state";
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

// Counts are validated by the same parser as the shrink-only membership check.
const baselineCounts = () => {
  const text = readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf-8");
  const counts = new Map<string, number>();
  for (const member of parseTestStateBaseline(text, BASELINE_PATH)) {
    const file = member.slice(0, member.lastIndexOf("::"));
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
};

const createStateResolver = (context: ScopeContext & FilenameContext) => {
  const variableOf = (node: unknown) =>
    isIdentifierReference(node) ? resolveVariable(context, node) : null;
  const isGlobal = (node: unknown) => {
    const variable = variableOf(node);
    return variable === null || variable.defs.length === 0;
  };

  const isProcess = (input: unknown, seen = new Set<Variable>()): boolean => {
    const node = unwrapExpression(input);
    const binding = resolveImport(context, node);
    if (
      binding !== null &&
      (binding.moduleId === "node:process" || binding.moduleId === "process") &&
      (binding.imported === "default" || binding.imported === "*")
    ) {
      return true;
    }
    if (isIdentifierReference(node)) {
      const variable = variableOf(node);
      if (variable === null || variable.defs.length === 0) {
        return node.name === "process";
      }
      if (seen.has(variable)) {
        return false;
      }
      seen.add(variable);
      return (
        isProcess(stableInitializer(variable), new Set(seen)) ||
        variable.references.some(
          (reference) =>
            reference.isWrite() &&
            isProcess(reference.writeExpr, new Set(seen)),
        )
      );
    }
    return (
      node?.type === "MemberExpression" &&
      memberPropertyName(node) === "process" &&
      isIdentifierReference(node.object) &&
      node.object.name === "globalThis" &&
      isGlobal(node.object)
    );
  };

  const isState = (input: unknown, seen = new Set<Variable>()): boolean => {
    const node = unwrapExpression(input);
    const binding = resolveImport(context, node);
    if (
      binding?.imported === "env" &&
      (binding.moduleId === CONFIG_MODULE ||
        binding.moduleId === "node:process" ||
        binding.moduleId === "process")
    ) {
      return true;
    }
    if (node?.type === "MemberExpression") {
      return (
        (memberPropertyName(node) === "env" && isProcess(node.object)) ||
        isState(node.object, seen)
      );
    }
    if (!isIdentifierReference(node)) {
      return false;
    }
    const variable = variableOf(node);
    if (variable === null || seen.has(variable)) {
      return false;
    }
    seen.add(variable);
    const definition = variable.defs.at(0);
    if (definition?.node.type !== "VariableDeclarator") {
      return false;
    }
    const declaration = definition.node;
    if (declaration.id.type === "Identifier") {
      return (
        isState(declaration.init, new Set(seen)) ||
        variable.references.some(
          (reference) =>
            reference.isWrite() && isState(reference.writeExpr, new Set(seen)),
        )
      );
    }
    if (declaration.id.type !== "ObjectPattern") {
      return false;
    }
    return declaration.id.properties.some(
      (property) =>
        property.type === "Property" &&
        isIdentifierReference(property.value) &&
        property.value.name === node.name &&
        ((getPropertyName(property.key) === "env" &&
          isProcess(declaration.init)) ||
          isState(declaration.init, new Set(seen))),
    );
  };

  return { isGlobal, isState, variableOf };
};

const testRegistration = (
  context: ScopeContext & FilenameContext,
  input: unknown,
) => {
  let callee = unwrapExpression(input);
  while (callee?.type === "MemberExpression") {
    if (resolveImport(context, callee)?.moduleId === "bun:test") {
      break;
    }
    callee = unwrapExpression(callee.object);
  }
  const binding = resolveImport(context, callee);
  if (binding?.moduleId !== "bun:test") {
    return null;
  }
  return [
    "beforeAll",
    "beforeEach",
    "afterEach",
    "afterAll",
    "test",
    "it",
    "describe",
  ].includes(binding.imported)
    ? binding.imported
    : null;
};

const isReflectiveWrite = (owner: string, method: string | null) => {
  if (method === null) {
    return false;
  }
  switch (owner) {
    case "Object":
      return [
        "assign",
        "defineProperty",
        "defineProperties",
        "setPrototypeOf",
        "freeze",
        "seal",
        "preventExtensions",
      ].includes(method);
    case "Reflect":
      return [
        "set",
        "deleteProperty",
        "defineProperty",
        "setPrototypeOf",
        "preventExtensions",
      ].includes(method);
    default:
      return false;
  }
};

export default eslintCompatPlugin({
  meta: { name: "no-direct-test-state" },
  rules: {
    "no-direct-test-state": {
      meta: {
        type: "problem",
        messages: {
          mutation:
            "Use createTestState from apps/api/src/tests/helpers/test-state.ts to mutate test environment or validated configuration; it restores file and test setup automatically.",
          stale:
            "{{file}} now has {{count}} state mutations (baseline {{baseline}}). Shrink scripts/test-state-baseline.json in this change.",
          concurrent:
            "Files using createTestState must run serial tests; concurrent tests share the environment and validated configuration.",
          registration:
            "Register createTestState at the test file's top level before any test, describe or lifecycle hook so its cleanup runs before setup hooks.",
          fileSetup:
            "Use the fixture's beforeAll method for file-scoped state setup; ordinary beforeAll hooks cannot declare the fixture's restoration scope.",
        },
      },
      createOnce(context) {
        const counts = baselineCounts();
        let filename = "";
        let mutations: ESTree.Node[] = [];
        let hasFixture = false;
        let concurrent: ESTree.Node[] = [];
        let earlyRegistrations: ESTree.Node[] = [];
        let fileSetup: ESTree.Node[] = [];
        let nestedFixtures: ESTree.Node[] = [];

        const { isGlobal, isState, variableOf } = createStateResolver(context);

        const mutates = (input: unknown): boolean => {
          const node = unwrapExpression(input);
          if (node?.type === "MemberExpression") {
            return isState(node.object) || isState(node);
          }
          if (
            node?.type === "ObjectPattern" &&
            Array.isArray(node.properties)
          ) {
            return node.properties.some(
              (property) =>
                isAstNode(property) &&
                mutates(property.value ?? property.argument),
            );
          }
          if (node?.type === "ArrayPattern" && Array.isArray(node.elements)) {
            return node.elements.some(mutates);
          }
          if (node?.type === "AssignmentPattern") {
            return mutates(node.left);
          }
          return false;
        };

        return {
          before() {
            filename = path.relative(REPO_ROOT, filenameForContext(context));
            mutations = [];
            hasFixture = false;
            concurrent = [];
            earlyRegistrations = [];
            fileSetup = [];
            nestedFixtures = [];
          },
          AssignmentExpression(node) {
            if (mutates(node.left)) {
              mutations.push(node);
            }
          },
          ForOfStatement(node) {
            if (mutates(node.left)) {
              mutations.push(node);
            }
          },
          ForInStatement(node) {
            if (mutates(node.left)) {
              mutations.push(node);
            }
          },
          UpdateExpression(node) {
            if (mutates(node.argument)) {
              mutations.push(node);
            }
          },
          UnaryExpression(node) {
            if (node.operator === "delete" && mutates(node.argument)) {
              mutations.push(node);
            }
          },
          CallExpression(node) {
            const imported = resolveImport(context, node.callee);
            const registration = testRegistration(context, node.callee);
            if (registration !== null) {
              if (!hasFixture) {
                earlyRegistrations.push(node);
              }
              if (registration === "beforeAll") {
                fileSetup.push(node);
              }
            }
            if (
              imported?.moduleId === FIXTURE_MODULE &&
              imported.imported === "createTestState"
            ) {
              hasFixture = true;
              const parent = node.parent;
              const statement =
                parent.type === "VariableDeclarator" ? parent.parent : parent;
              if (statement.parent?.type !== "Program") {
                nestedFixtures.push(node);
              }
            }
            let callee = unwrapExpression(node.callee);
            const seen = new Set<Variable>();
            while (isIdentifierReference(callee)) {
              const variable = variableOf(callee);
              if (variable === null || seen.has(variable)) {
                break;
              }
              seen.add(variable);
              callee = stableInitializer(variable);
            }
            if (
              callee?.type !== "MemberExpression" ||
              !isIdentifierReference(callee.object) ||
              !isGlobal(callee.object)
            ) {
              return;
            }
            const method = memberPropertyName(callee);
            const reflectiveWrite = isReflectiveWrite(
              callee.object.name,
              method,
            );
            if (reflectiveWrite && isState(node.arguments.at(0))) {
              mutations.push(node);
            }
          },
          MemberExpression(node) {
            if (!isAstNode(node) || memberPropertyName(node) !== "concurrent") {
              return;
            }
            const binding = resolveImport(context, node.object);
            if (
              binding?.moduleId === "bun:test" &&
              (binding.imported === "test" ||
                binding.imported === "it" ||
                binding.imported === "describe")
            ) {
              concurrent.push(node);
            }
          },
          "Program:exit"(node) {
            if (!TEST_FILE.test(filename)) {
              return;
            }
            const baseline = counts.get(filename) ?? 0;
            if (mutations.length < baseline) {
              context.report({
                node,
                messageId: "stale",
                data: { file: filename, count: mutations.length, baseline },
              });
            }
            for (const mutation of mutations.slice(baseline)) {
              context.report({ node: mutation, messageId: "mutation" });
            }
            if (hasFixture) {
              for (const registration of [
                ...earlyRegistrations,
                ...nestedFixtures,
              ]) {
                context.report({
                  node: registration,
                  messageId: "registration",
                });
              }
              for (const setup of fileSetup) {
                context.report({ node: setup, messageId: "fileSetup" });
              }
              for (const member of concurrent) {
                context.report({ node: member, messageId: "concurrent" });
              }
            }
          },
        };
      },
    },
  },
});
