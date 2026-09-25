import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportLocalName,
  getPropertyName,
  isAstNode,
  isCallTo,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

// Keep failure sink handles named, module-level constants.
//
// `observeFailure(error, { sink })` decides a failure's record, severity and
// capture from the handle it is given, so a handle is a reviewed declaration,
// not a value to compute. Each one is created once, by `failureSink(...)`, at
// module scope, and passed by name: a handle built inline, per call, or chosen
// at runtime would hide which policy a site runs under and would let the
// expectation and legacy-pin counts drift from what the sites actually use.
//
// Flagged:
//   observeFailure(error, { sink: failureSink({ event, expected: [] }) })
//   observeFailure(error, { sink: pickSink(kind) })
//   observeFailure(error, { sink: sinks[kind] })
//   const handler = () => { const s = failureSink({ ... }); ... }
//
// Accepted:
//   const workerFailed = failureSink({ event: "worker.failed", expected: [] });
//   export const SINKS = { worker: failureSink({ ... }) };
//   observeFailure(error, { sink: workerFailed });
//   observeFailure(error, { sink: importedHandle });

const RULE_NAME = "failure-sink-handle";
const OBSERVE_FAILURE = "observeFailure";
const FAILURE_SINK = "failureSink";
const SINK_PROPERTY = "sink";

const EXPORT_WRAPPERS = new Set([
  "ExportDefaultDeclaration",
  "ExportNamedDeclaration",
]);

// Module-level `const` declarators, unwrapping `export`.
const moduleConstDeclarators = (program: unknown): AstNode[] => {
  const declarators: AstNode[] = [];
  const body =
    isAstNode(program) && Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    const declaration =
      isAstNode(statement) && EXPORT_WRAPPERS.has(statement.type)
        ? statement.declaration
        : statement;
    if (
      !isAstNode(declaration) ||
      declaration.type !== "VariableDeclaration" ||
      declaration.kind !== "const" ||
      !Array.isArray(declaration.declarations)
    ) {
      continue;
    }
    for (const declarator of declaration.declarations) {
      if (isAstNode(declarator)) {
        declarators.push(declarator);
      }
    }
  }
  return declarators;
};

// The `failureSink(...)` calls sitting where a handle may be created: a
// module-level const's initializer, or a property of a module-level const
// object literal.
const sanctionedSinkCalls = (declarators: readonly AstNode[]): Set<unknown> => {
  const calls = new Set<unknown>();
  for (const declarator of declarators) {
    const init = unwrapExpression(declarator.init);
    if (isCallTo(init, FAILURE_SINK)) {
      calls.add(init);
      continue;
    }
    if (
      !isAstNode(init) ||
      init.type !== "ObjectExpression" ||
      !Array.isArray(init.properties)
    ) {
      continue;
    }
    for (const property of init.properties) {
      if (
        isAstNode(property) &&
        property.type === "Property" &&
        isCallTo(property.value, FAILURE_SINK)
      ) {
        calls.add(property.value);
      }
    }
  }
  return calls;
};

const handleNames = (program: unknown, declarators: readonly AstNode[]) => {
  const names = new Set<string>();
  for (const declarator of declarators) {
    const id = declarator.id;
    if (
      isIdentifier(id) &&
      isCallTo(unwrapExpression(declarator.init), FAILURE_SINK)
    ) {
      names.add(id.name);
    }
  }
  const body =
    isAstNode(program) && Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    if (
      !isAstNode(statement) ||
      statement.type !== "ImportDeclaration" ||
      !Array.isArray(statement.specifiers)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const local = getImportLocalName(specifier);
      if (local !== null) {
        names.add(local);
      }
    }
  }
  return names;
};

const sinkArgument = (call: unknown): AstNode | null => {
  const args =
    isAstNode(call) && Array.isArray(call.arguments) ? call.arguments : [];
  const options = args.at(1);
  if (
    !isAstNode(options) ||
    options.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return null;
  }
  for (const property of options.properties) {
    if (
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property.key) === SINK_PROPERTY &&
      isAstNode(property.value)
    ) {
      return property.value;
    }
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          sinkNotHandle:
            "Pass a failure sink handle by name: a module-level constant " +
            "created by failureSink(...), or one imported from its module.",
          sinkOutsideModuleScope:
            "Create a failure sink handle once, at module scope, as a const " +
            "(or a property of a module-level const object).",
        },
      },
      createOnce(context) {
        let names = new Set<string>();
        let sanctioned = new Set<unknown>();
        return {
          Program(node) {
            const declarators = moduleConstDeclarators(node);
            names = handleNames(node, declarators);
            sanctioned = sanctionedSinkCalls(declarators);
          },
          CallExpression(node) {
            if (isCallTo(node, FAILURE_SINK) && !sanctioned.has(node)) {
              context.report({ node, messageId: "sinkOutsideModuleScope" });
              return;
            }
            if (!isCallTo(node, OBSERVE_FAILURE)) {
              return;
            }
            const sink = sinkArgument(node);
            if (sink === null) {
              return;
            }
            if (!isIdentifier(sink) || !names.has(sink.name)) {
              context.report({ node: sink, messageId: "sinkNotHandle" });
            }
          },
        };
      },
    },
  },
});
