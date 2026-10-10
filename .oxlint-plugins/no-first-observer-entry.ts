import {
  eslintCompatPlugin,
  type ESTree,
  type Variable,
} from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  isSingleAssignment,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { ScopeContext } from "./utils.ts";

const OBSERVERS = new Set(["IntersectionObserver", "ResizeObserver"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window"]);

type Callback = ESTree.ArrowFunctionExpression | ESTree.Function;

const isCallback = (node: unknown): node is Callback =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration");

type ResolveCallbackOptions = {
  context: ScopeContext;
  node: unknown;
  seen?: Set<Variable>;
};
const resolveCallback = ({
  context,
  node,
  seen = new Set<Variable>(),
}: ResolveCallbackOptions): Callback | null => {
  const expression = unwrapExpression(node);
  if (isCallback(expression)) {
    return expression;
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  if (!variable || seen.has(variable)) {
    return null;
  }
  seen.add(variable);
  const declaration = variable.defs.at(0)?.node;
  // A reassigned binding may hold another function when the observer is built.
  if (declaration?.type === "FunctionDeclaration") {
    return variable.defs.length === 1 && isSingleAssignment(variable)
      ? declaration
      : null;
  }
  return resolveCallback({ context, node: stableInitializer(variable), seen });
};

const isObserverConstructor = (context: ScopeContext, node: unknown) => {
  const callee = unwrapExpression(node);
  if (isIdentifierReference(callee)) {
    return (
      OBSERVERS.has(callee.name) &&
      !resolveVariable(context, callee)?.defs.length
    );
  }
  return (
    callee?.type === "MemberExpression" &&
    OBSERVERS.has(memberPropertyName(callee) ?? "") &&
    isIdentifierReference(callee.object) &&
    GLOBAL_OBJECTS.has(callee.object.name) &&
    !resolveVariable(context, callee.object)?.defs.length
  );
};

const isZero = (node: unknown) => {
  const expression = unwrapExpression(node);
  return expression?.type === "Literal" && expression.value === 0;
};

export default eslintCompatPlugin({
  meta: { name: "no-first-observer-entry" },
  rules: {
    "no-first-observer-entry": {
      meta: {
        type: "problem",
        messages: {
          latestRecord:
            "Decide from the latest observer record per target: use entries.at(-1) for one target, or the last entry for each target when observing several.",
        },
      },
      createOnce(context) {
        const parameters = new Set<Variable>();
        const candidates: {
          node: ESTree.Node;
          receiver: ESTree.IdentifierReference;
        }[] = [];
        return {
          before() {
            parameters.clear();
            candidates.length = 0;
          },
          NewExpression(node) {
            if (!isObserverConstructor(context, node.callee)) {
              return;
            }
            const callback = resolveCallback({
              context,
              node: node.arguments.at(0),
            });
            const parameter = callback?.params.at(0);
            const binding =
              parameter?.type === "AssignmentPattern"
                ? parameter.left
                : parameter;
            if (binding?.type === "ArrayPattern") {
              const firstBinding = binding.elements.at(0);
              if (firstBinding && firstBinding.type !== "RestElement") {
                context.report({ node: binding, messageId: "latestRecord" });
                return;
              }
            }
            if (!callback?.body || binding?.type !== "Identifier") {
              return;
            }
            const variable = context.sourceCode
              .getScope(callback.body)
              .set.get(binding.name);
            if (variable) {
              parameters.add(variable);
            }
          },
          MemberExpression(node) {
            if (
              node.computed &&
              isZero(node.property) &&
              isIdentifierReference(node.object)
            ) {
              candidates.push({ node, receiver: node.object });
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type === "MemberExpression" &&
              memberPropertyName(callee) === "at" &&
              isZero(node.arguments.at(0)) &&
              isIdentifierReference(callee.object)
            ) {
              candidates.push({ node, receiver: callee.object });
            }
          },
          VariableDeclarator(node) {
            const firstBinding =
              node.id.type === "ArrayPattern" ? node.id.elements.at(0) : null;
            if (
              firstBinding &&
              firstBinding.type !== "RestElement" &&
              isIdentifierReference(node.init)
            ) {
              candidates.push({ node: node.id, receiver: node.init });
            }
          },
          "Program:exit"() {
            // Named callbacks can occur before their observer construction.
            for (const { node, receiver } of candidates) {
              const variable = resolveVariable(context, receiver);
              if (variable && parameters.has(variable)) {
                context.report({ node, messageId: "latestRecord" });
              }
            }
          },
        };
      },
    },
  },
});
