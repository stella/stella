import type { CreateOnceRule } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
} from "./utils.ts";

// Require a filter on the mutation's own fluent chain. An unrelated `.where`
// before the mutation or on an enclosing call cannot filter its rows. This
// checks configured receiver names; aliases and separately stored builders are
// outside the analysis boundary.
const receiverName = (node) => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "MemberExpression") {
    return getPropertyName(node.property);
  }
  if (node.type === "CallExpression") {
    return receiverName(node.callee);
  }
  return null;
};

const hasWhere = (node) => {
  let currentMember = node;
  let call = node.parent;
  while (call?.type === "CallExpression" && call.callee === currentMember) {
    const member = call.parent;
    if (member?.type !== "MemberExpression" || member.object !== call) {
      return false;
    }
    const nextCall = member.parent;
    if (nextCall?.type !== "CallExpression" || nextCall.callee !== member) {
      return false;
    }
    if (getPropertyName(member.property) === "where") {
      return true;
    }
    currentMember = member;
    call = nextCall;
  }
  return false;
};

const configuredReceiverNames = (option: unknown): string | string[] => {
  if (
    typeof option !== "object" ||
    option === null ||
    !("drizzleObjectName" in option)
  ) {
    return [];
  }
  const names = option.drizzleObjectName;
  if (typeof names === "string") {
    return names;
  }
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
};

const rule = (mutation: "delete" | "update"): CreateOnceRule => ({
  meta: {
    type: "problem",
    messages: {
      missingWhere:
        mutation === "delete"
          ? "Without `.where(...)` you will delete all the rows in a table. If you didn't want to do it, please use `{{ drizzleObjName }}.delete(...).where(...)` instead. Otherwise you can ignore this rule here"
          : "Without `.where(...)` you will update all the rows in a table. If you didn't want to do it, please use `{{ drizzleObjName }}.update(...).set(...).where(...)` instead. Otherwise you can ignore this rule here",
    },
    schema: [
      {
        type: "object",
        properties: { drizzleObjectName: { type: ["string", "array"] } },
        additionalProperties: false,
      },
    ],
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (getPropertyName(node.property) !== mutation) {
          return;
        }
        if (
          node.parent.type !== "CallExpression" ||
          node.parent.callee !== node
        ) {
          return;
        }
        const names = configuredReceiverNames(context.options.at(0));
        const name = receiverName(node.object);
        if (
          typeof names === "string"
            ? name !== names
            : names.length > 0 && !names.includes(name)
        ) {
          return;
        }
        if (hasWhere(node)) {
          return;
        }
        const nextMember = node.parent.parent;
        const reportNode =
          mutation === "update" &&
          nextMember.type === "MemberExpression" &&
          getPropertyName(nextMember.property) === "set"
            ? nextMember
            : node;
        context.report({
          node: reportNode,
          messageId: "missingWhere",
          data: { drizzleObjName: name },
        });
      },
    };
  },
});

export default eslintCompatPlugin({
  meta: { name: "drizzle" },
  rules: {
    "no-direct-entity-reparent": {
      meta: {
        type: "problem",
        messages: {
          useMoveOwner:
            "Reparent existing entities through moveEntityHandler, which locks the matter before checking ancestry. Direct parentId updates bypass that invariant.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const filename = filenameForContext(context);
            if (
              filename.endsWith(".test.ts") ||
              filename.endsWith(".test.tsx") ||
              filename.includes("/apps/api/src/tests/") ||
              filename.endsWith("/apps/api/src/handlers/entities/move.ts")
            ) {
              return;
            }
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              getPropertyName(callee.property) !== "set"
            ) {
              return;
            }
            const update = callee.object;
            if (
              update.type !== "CallExpression" ||
              update.callee.type !== "MemberExpression" ||
              getPropertyName(update.callee.property) !== "update" ||
              !isIdentifier(update.arguments.at(0), "entities")
            ) {
              return;
            }
            const values = node.arguments.at(0);
            if (
              !isAstNode(values) ||
              values.type !== "ObjectExpression" ||
              !Array.isArray(values.properties)
            ) {
              return;
            }
            if (
              values.properties.some(
                (property) =>
                  isAstNode(property) &&
                  property.type === "Property" &&
                  getPropertyName(property.key) === "parentId",
              )
            ) {
              context.report({ node, messageId: "useMoveOwner" });
            }
          },
        };
      },
    },
    "enforce-delete-with-where": {
      ...rule("delete"),
    },
    "enforce-update-with-where": {
      ...rule("update"),
    },
  },
});
