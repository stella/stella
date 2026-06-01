// Auth lifecycle guardrails.
// Membership removal must clear every org-scoped auth artifact through
// revokeOrganizationMemberAuthArtifacts(). TypeScript cannot infer that a
// Better Auth organization hook, Stella sessions, and OAuth token rows are one
// lifecycle boundary, so this rule keeps that coupling explicit.

import { getPropertyName, isCallTo, isIdentifier } from "./utils.ts";

const HELPER_NAME = "revokeOrganizationMemberAuthArtifacts";
const HELPER_FILE = "apps/api/src/lib/auth-artifacts.ts";
const AUTH_ARTIFACT_TABLES = new Set([
  "oauthAccessToken",
  "oauthRefreshToken",
  "session",
  "sessionTable",
]);

const isAllowedFile = (context) => {
  const filename = context.filename ?? context.getFilename?.() ?? "";
  return filename.endsWith(HELPER_FILE);
};

const containsHelperCall = (node, seen = new WeakSet()): boolean => {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);

  if (isCallTo(node, HELPER_NAME)) {
    return true;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.some((item) => containsHelperCall(item, seen))) {
        return true;
      }
      continue;
    }

    if (containsHelperCall(value, seen)) {
      return true;
    }
  }

  return false;
};

const getDeleteTarget = (node): string | null => {
  if (node.type !== "CallExpression") {
    return null;
  }

  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    !isIdentifier(callee.property, "delete")
  ) {
    return null;
  }

  const firstArgument = node.arguments.at(0);
  if (isIdentifier(firstArgument)) {
    return firstArgument.name;
  }

  if (
    firstArgument?.type === "MemberExpression" &&
    firstArgument.computed === false &&
    isIdentifier(firstArgument.property)
  ) {
    return firstArgument.property.name;
  }

  return null;
};

export default {
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
      create(context) {
        return {
          Property(node) {
            if (getPropertyName(node.key) !== "afterRemoveMember") {
              return;
            }

            if (containsHelperCall(node.value)) {
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
      create(context) {
        const allowedFile = isAllowedFile(context);

        return {
          CallExpression(node) {
            if (allowedFile) {
              return;
            }

            const table = getDeleteTarget(node);
            if (table === null || !AUTH_ARTIFACT_TABLES.has(table)) {
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
};
