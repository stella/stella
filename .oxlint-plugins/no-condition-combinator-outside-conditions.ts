// Condition-tree nodes (`combinator`, `negated`) are an implementation
// detail of `@stll/conditions`. Reading those fields directly, anywhere but
// the condition builder itself, re-implements tree semantics (AND/OR
// grouping, negation) at the call site instead of going through the
// package's fold/walk/evaluate helpers — the same drift risk as reading a
// Drizzle table's derived columns by hand instead of through its owner.
//
// The sanctioned way to give a group meaning is the package's own fold:
// `foldCondition`/`foldConditions` own which nodes survive, and hand the
// surviving children to a `group` callback that may read `combinator` and
// `negated` to combine them. Only group callbacks actually passed to an owner
// fold are exempt; importing a fold does not exempt unrelated reads.
//
// The ban is a plain, non-computed property-access check on `.combinator`
// and `.negated`: an object-literal key (`{ combinator: "and" }`, building a
// new node) is a `Property`, not a `MemberExpression`, so it is unaffected —
// only *reading* an existing node's combinator/negated is in scope. A
// destructured read (`const { combinator } = node`, including a function
// parameter pattern) reads the same fields through an `ObjectPattern`
// instead, so it is banned the same way.
//
// Exempt (the condition builder legitimately reads and writes these
// fields):
//   - packages/conditions/src/** (the tree's own fold/walk/evaluate)
//   - packages/workspace-ui/src/** (the interactive condition builder)
//   - group callbacks in the handlers of an actual `foldCondition` or
//     `foldConditions` call from `@stll/conditions`, including stable named
//     handlers and callback aliases; type-only imports cannot call the fold
//
// Enabled only for production modules under apps/web/src/** and
// apps/api/src/** (test files build and inspect nodes as data); the exemption paths
// are checked here too so the rule stays correct on its own even if a future
// config change broadens the enabling scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { FoldHandlers } from "../packages/conditions/src/fold.ts";
import {
  type AstNode,
  type ScopeContext,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isImportedFrom,
  isSingleAssignment,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const TARGET_PROPERTY_NAMES = new Set(["combinator", "negated"]);

const CONDITIONS_PACKAGE = "@stll/conditions";
const FOLD_EXPORT_NAMES = new Set(["foldCondition", "foldConditions"]);
const FOLD_HANDLER_PROPERTIES = {
  leaf: true,
  group: true,
} as const satisfies Record<keyof FoldHandlers<unknown>, true>;
const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const SCOPE_PREFIXES = ["apps/web/src/", "apps/api/src/"];

// `*.test.ts` also matches `*.integration.test.ts`, `*.differential.test.ts`
// and `*.property.test.ts`: every test-file convention still ends in it.
const TEST_FILE_PATTERN = /\.test\.tsx?$/u;

const EXEMPT_PREFIXES = [
  "packages/conditions/src/",
  "packages/workspace-ui/src/",
];

// Matches both the main fixture and the type-import regression fixture
// (`no-condition-combinator-outside-conditions.fixture.type-import.ts`).
const FIXTURE_FILE_PREFIX =
  ".oxlint-plugins/__fixtures__/no-condition-combinator-outside-conditions.fixture.";

const stableExpression = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): AstNode | null => {
  const expression = unwrapExpression(value);
  if (expression === null || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (!isIdentifierReference(expression)) {
    return expression;
  }
  const variable = resolveVariable(context, expression);
  if (variable === null) {
    return null;
  }
  const definition = variable.defs.at(0);
  // A destructured binding holds a selected property, not its whole initializer.
  if (
    definition?.type === "Variable" &&
    isAstNode(definition.node) &&
    definition.node.type === "VariableDeclarator" &&
    (!isAstNode(definition.node.id) || definition.node.id.type !== "Identifier")
  ) {
    return null;
  }
  const initializer = stableInitializer(variable);
  if (initializer !== null) {
    return stableExpression(context, initializer, seen);
  }
  if (
    variable.defs.length !== 1 ||
    definition === undefined ||
    !isSingleAssignment(variable) ||
    !isAstNode(definition.node) ||
    definition.node.type !== "FunctionDeclaration"
  ) {
    return null;
  }
  return definition.node;
};

const createHandlerMutationRecorder = (
  context: ScopeContext,
  mutatedHandlers: Set<AstNode>,
) => {
  const recordHandlerMutation = (value: unknown) => {
    const target = unwrapExpression(value);
    if (target === null) {
      return;
    }
    if (target.type === "ObjectPattern" && Array.isArray(target.properties)) {
      for (const property of target.properties) {
        if (!isAstNode(property)) {
          continue;
        }
        recordHandlerMutation(
          property.type === "RestElement" ? property.argument : property.value,
        );
      }
      return;
    }
    if (target.type === "ArrayPattern" && Array.isArray(target.elements)) {
      for (const element of target.elements) {
        recordHandlerMutation(element);
      }
      return;
    }
    if (target.type === "RestElement" || target.type === "AssignmentPattern") {
      recordHandlerMutation(
        target.type === "RestElement" ? target.argument : target.left,
      );
      return;
    }
    if (target.type !== "MemberExpression") {
      return;
    }
    const name = target.computed
      ? staticStringValue(target.property)
      : getPropertyName(target.property);
    if (name !== null && !Object.hasOwn(FOLD_HANDLER_PROPERTIES, name)) {
      return;
    }
    const object = stableExpression(context, target.object);
    if (object?.type === "ObjectExpression") {
      mutatedHandlers.add(object);
    }
  };
  return recordHandlerMutation;
};

type PossibleLeafCallbacksOptions = {
  context: ScopeContext;
  value: unknown;
  callbacks: Set<AstNode>;
};

// Uncertain handlers cannot grant a possible leaf an outer group's exemption.
const collectPossibleLeafCallbacks = (
  { context, value, callbacks }: PossibleLeafCallbacksOptions,
  seen = new Set<AstNode>(),
): void => {
  const object = stableExpression(context, value);
  if (
    object?.type !== "ObjectExpression" ||
    !Array.isArray(object.properties) ||
    seen.has(object)
  ) {
    return;
  }
  seen.add(object);
  for (const property of object.properties) {
    if (!isAstNode(property)) {
      continue;
    }
    if (property.type === "SpreadElement") {
      collectPossibleLeafCallbacks(
        { context, value: property.argument, callbacks },
        seen,
      );
      continue;
    }
    if (property.type !== "Property") {
      continue;
    }
    const name = property.computed
      ? staticStringValue(property.key)
      : getPropertyName(property.key);
    if (name !== "leaf") {
      continue;
    }
    const callback = stableExpression(context, property.value);
    if (callback !== null && FUNCTION_NODE_TYPES.has(callback.type)) {
      callbacks.add(callback);
    }
  }
};

export default eslintCompatPlugin({
  meta: { name: "no-condition-combinator-outside-conditions" },
  rules: {
    "no-condition-combinator-outside-conditions": {
      meta: {
        type: "problem",
        messages: {
          combinatorRead:
            "Condition-tree semantics live in @stll/conditions: combine " +
            "nodes inside a foldCondition/foldConditions group callback " +
            "instead of reading combinator or negated here.",
        },
      },
      createOnce(context) {
        const callbacks = new Set<AstNode>();
        const leafCallbacks = new Set<AstNode>();
        const reports: (() => void)[] = [];
        const folds: (() => void)[] = [];
        const mutatedHandlers = new Set<AstNode>();

        type HandlerCallbacks = {
          type: "known" | "partial";
          callbacks: Map<string, AstNode | null>;
        };
        const handlerCallbacks = (
          value: unknown,
          seen = new Set<AstNode>(),
        ): HandlerCallbacks | null => {
          const object = stableExpression(context, value);
          if (
            object?.type !== "ObjectExpression" ||
            mutatedHandlers.has(object) ||
            !Array.isArray(object.properties) ||
            seen.has(object)
          ) {
            return null;
          }
          seen.add(object);
          let type: HandlerCallbacks["type"] = "known";
          const handlers = new Map<string, AstNode | null>();
          for (const property of object.properties) {
            if (!isAstNode(property)) {
              continue;
            }
            if (property.type === "SpreadElement") {
              const spread = handlerCallbacks(property.argument, seen);
              if (spread?.type !== "known") {
                type = "partial";
                handlers.clear();
              }
              if (spread !== null) {
                for (const [name, callback] of spread.callbacks) {
                  handlers.set(name, callback);
                }
              }
              continue;
            }
            if (property.type !== "Property") {
              continue;
            }
            const name = property.computed
              ? staticStringValue(property.key)
              : getPropertyName(property.key);
            if (name === null) {
              type = "partial";
              handlers.clear();
              continue;
            }
            if (!Object.hasOwn(FOLD_HANDLER_PROPERTIES, name)) {
              continue;
            }
            const callback = stableExpression(context, property.value);
            if (
              property.kind === "init" &&
              callback !== null &&
              FUNCTION_NODE_TYPES.has(callback.type)
            ) {
              handlers.set(name, callback);
            } else {
              handlers.set(name, null);
            }
          }
          seen.delete(object);
          return { type, callbacks: handlers };
        };

        const recordHandlerMutation = createHandlerMutationRecorder(
          context,
          mutatedHandlers,
        );

        const insideCallback = (node: unknown): boolean => {
          let ancestor = isAstNode(node) ? node : null;
          while (ancestor !== null) {
            if (leafCallbacks.has(ancestor)) {
              return false;
            }
            if (callbacks.has(ancestor)) {
              return true;
            }
            ancestor = isAstNode(ancestor.parent) ? ancestor.parent : null;
          }
          return false;
        };

        return {
          before() {
            callbacks.clear();
            leafCallbacks.clear();
            reports.length = 0;
            folds.length = 0;
            mutatedHandlers.clear();
            const filename = filenameForContext(context);
            if (filename.includes(FIXTURE_FILE_PREFIX)) {
              return true;
            }
            // Tests build and inspect condition nodes as data (fixtures,
            // generators, assertions on a node's shape); the semantics the
            // rule guards live in production modules only.
            if (TEST_FILE_PATTERN.test(filename)) {
              return false;
            }
            return (
              SCOPE_PREFIXES.some((prefix) => filename.includes(prefix)) &&
              !EXEMPT_PREFIXES.some((prefix) => filename.includes(prefix))
            );
          },
          CallExpression(node) {
            if (
              !isImportedFrom({
                context,
                node: node.callee,
                modules: [CONDITIONS_PACKAGE],
                names: FOLD_EXPORT_NAMES,
              })
            ) {
              return;
            }
            folds.push(() => {
              collectPossibleLeafCallbacks({
                context,
                value: node.arguments.at(1),
                callbacks: leafCallbacks,
              });
              const handlers = handlerCallbacks(node.arguments.at(1));
              if (handlers !== null) {
                const group = handlers.callbacks.get("group");
                if (group !== undefined && group !== null) {
                  callbacks.add(group);
                }
              }
            });
          },
          AssignmentExpression(node) {
            recordHandlerMutation(node.left);
          },
          UpdateExpression(node) {
            recordHandlerMutation(node.argument);
          },
          UnaryExpression(node) {
            if (node.operator === "delete") {
              recordHandlerMutation(node.argument);
            }
          },
          "Program:exit"() {
            // Uses and writes may follow named callback definitions.
            for (const fold of folds) {
              fold();
            }
            for (const report of reports) {
              report();
            }
          },
          MemberExpression(node) {
            if (node.computed) {
              return;
            }
            const propertyName = getPropertyName(node.property);
            if (
              propertyName === null ||
              !TARGET_PROPERTY_NAMES.has(propertyName)
            ) {
              return;
            }
            reports.push(() => {
              if (!insideCallback(node)) {
                context.report({ node, messageId: "combinatorRead" });
              }
            });
          },
          // Destructured reads (`const { combinator } = node` or a function
          // parameter pattern) surface the same fields through an
          // ObjectPattern rather than a MemberExpression, so the ban needs
          // its own visitor to catch them.
          ObjectPattern(node) {
            for (const property of node.properties) {
              if (property.type !== "Property" || property.computed) {
                continue;
              }
              const propertyName = getPropertyName(property.key);
              if (
                propertyName === null ||
                !TARGET_PROPERTY_NAMES.has(propertyName)
              ) {
                continue;
              }
              reports.push(() => {
                if (!insideCallback(property)) {
                  context.report({
                    node: property,
                    messageId: "combinatorRead",
                  });
                }
              });
            }
          },
        };
      },
    },
  },
});
