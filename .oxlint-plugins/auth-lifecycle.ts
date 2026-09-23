// Auth lifecycle guardrails.
// Membership removal must clear every org-scoped auth artifact through
// revokeOrganizationMemberAuthArtifacts(). TypeScript cannot infer that a
// Better Auth organization hook, Stella sessions, and OAuth token rows are one
// lifecycle boundary, so this rule keeps that coupling explicit.
//
// Tables and the helper are recognised by import (aliased, namespace member,
// destructured), not by spelling, and a helper call only counts when it can
// run: a call after a `return` / `throw` in the same block, or under a
// constant-false branch, does not.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  type ImportedFromOptions,
  everyNode,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isFileIn,
  isIdentifier,
  isImportedFrom,
  memberPropertyName,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const HELPER: ReadonlySet<string> = new Set([
  "revokeOrganizationMemberAuthArtifacts",
]);
const HELPER_MODULE = "apps/api/src/lib/auth-artifacts";
const HELPER_FILE = "apps/api/src/lib/auth-artifacts.ts";
const AUTH_SCHEMA_MODULE = "apps/api/src/db/auth-schema";
const AUTH_ARTIFACT_TABLES: ReadonlySet<string> = new Set([
  "oauthAccessToken",
  "oauthRefreshToken",
  "session",
]);
// `authSchema.session`: the schema module also exports its tables as one
// object.
const AUTH_SCHEMA_OBJECT: ReadonlySet<string> = new Set(["authSchema"]);

const COMPLETION_STATEMENTS: ReadonlySet<string> = new Set([
  "ReturnStatement",
  "ThrowStatement",
]);

// The truthiness of an expression whose value is fixed at parse time, or null
// when it depends on runtime state.
const constantTruthiness = (node: unknown): boolean | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (expression.type === "Literal") {
    return expression.regex === undefined ? Boolean(expression.value) : true;
  }
  if (isIdentifier(expression, "undefined")) {
    return false;
  }
  if (expression.type === "UnaryExpression") {
    if (expression.operator === "void") {
      return false;
    }
    const operand = constantTruthiness(expression.argument);
    return expression.operator === "!" && operand !== null ? !operand : null;
  }
  return null;
};

// Whether `child`, a direct child of `parent`, can never execute because of
// where it sits in `parent`.
const isDeadChild = (parent: AstNode, child: AstNode): boolean => {
  const statements = Array.isArray(parent.body)
    ? parent.body
    : Array.isArray(parent.consequent)
      ? parent.consequent
      : null;
  if (statements !== null && statements.includes(child)) {
    return statements
      .slice(0, statements.indexOf(child))
      .some(
        (statement) =>
          isAstNode(statement) && COMPLETION_STATEMENTS.has(statement.type),
      );
  }
  if (
    parent.type === "IfStatement" ||
    parent.type === "ConditionalExpression"
  ) {
    const test = constantTruthiness(parent.test);
    return (
      (test === false && parent.consequent === child) ||
      (test === true && parent.alternate === child)
    );
  }
  if (parent.type === "LogicalExpression" && parent.right === child) {
    const left = constantTruthiness(parent.left);
    return (
      (parent.operator === "&&" && left === false) ||
      (parent.operator === "||" && left === true)
    );
  }
  if (parent.type === "WhileStatement" && parent.body === child) {
    return constantTruthiness(parent.test) === false;
  }
  return false;
};

// Whether `node` can run when `root` runs, judged by the path between them.
const isReachableWithin = (node: AstNode, root: AstNode): boolean => {
  let child = node;
  let parent = node.parent;
  while (isAstNode(parent) && child !== root) {
    if (isDeadChild(parent, child)) {
      return false;
    }
    child = parent;
    parent = parent.parent;
  }
  return true;
};

const isHelperCall = (context: RuleContext, node: AstNode): boolean =>
  node.type === "CallExpression" &&
  isImportedFrom({
    context,
    node: invokedCallee(node),
    modules: [HELPER_MODULE],
    names: HELPER,
  });

const containsReachableHelperCall = (
  context: RuleContext,
  root: unknown,
): boolean =>
  isAstNode(root) &&
  everyNode(root).some(
    (node) => isHelperCall(context, node) && isReachableWithin(node, root),
  );

// The auth artifact table a `<receiver>.delete(<table>)` call targets.
const deletedAuthTable = (
  context: RuleContext,
  node: unknown,
): string | null => {
  const call = unwrapExpression(node);
  const callee =
    call?.type === "CallExpression" ? unwrapExpression(call.callee) : null;
  if (
    call === null ||
    callee?.type !== "MemberExpression" ||
    memberPropertyName(callee) !== "delete" ||
    !Array.isArray(call.arguments)
  ) {
    return null;
  }
  const table = unwrapExpression(call.arguments.at(0));
  if (table === null) {
    return null;
  }
  const direct = resolveImport(context, table);
  if (direct !== null) {
    return direct.moduleId === AUTH_SCHEMA_MODULE &&
      AUTH_ARTIFACT_TABLES.has(direct.imported)
      ? direct.imported
      : null;
  }
  if (table.type !== "MemberExpression") {
    return null;
  }
  const property = memberPropertyName(table);
  return property !== null &&
    AUTH_ARTIFACT_TABLES.has(property) &&
    isImportedFrom({
      context,
      node: table.object,
      modules: [AUTH_SCHEMA_MODULE],
      names: AUTH_SCHEMA_OBJECT,
    })
    ? property
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "auth-lifecycle" },
  rules: {
    "after-remove-member-revokes-artifacts": {
      meta: {
        type: "problem",
        messages: {
          missingAuthArtifactCleanup:
            "afterRemoveMember must call revokeOrganizationMemberAuthArtifacts(...) so org-scoped auth artifacts stay on one lifecycle path.",
        },
      },
      createOnce(context) {
        return {
          Property(node) {
            if (getPropertyName(node.key) !== "afterRemoveMember") {
              return;
            }

            if (containsReachableHelperCall(context, node.value)) {
              return;
            }

            context.report({
              node,
              messageId: "missingAuthArtifactCleanup",
            });
          },
        };
      },
    },

    "no-direct-auth-artifact-delete": {
      meta: {
        type: "problem",
        messages: {
          directAuthArtifactDelete:
            "Delete org-member auth artifacts through revokeOrganizationMemberAuthArtifacts(...), not by deleting {{table}} directly.",
        },
      },
      createOnce(context) {
        let allowedFile = false;

        return {
          before() {
            allowedFile = isFileIn(context, [HELPER_FILE]);
          },
          CallExpression(node) {
            if (allowedFile) {
              return;
            }

            const table = deletedAuthTable(context, node);
            if (table === null) {
              return;
            }

            context.report({
              node,
              messageId: "directAuthArtifactDelete",
              data: { table },
            });
          },
        };
      },
    },
  },
});
