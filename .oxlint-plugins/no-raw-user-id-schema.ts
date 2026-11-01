import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";
// Disallow user ID request schemas typed as raw strings.
// User IDs are auth-provider strings, but handlers should still read them
// through the shared `userIdSchema` (or the branded `resourceIdSchema("user")`)
// from `@/api/lib/custom-schema` at boundaries. That keeps one length bound and
// one shape for every user reference, prevents ownership-like fields from
// degrading back into arbitrary strings, and makes follow-up membership
// validation explicit in handler code.
//
// A user ID field is a property named `userId`, ending in `UserId`
// (`leadUserId`, `assigneeUserId`), or one of the contact owner fields. Its
// value is reported when it contains an inline `v.string()` anywhere (bare,
// wrapped in `v.optional`/`v.nullable`, or at the head of a `v.pipe`) and does
// not reference `userIdSchema`.

import { getCalleeName, getPropertyName, isAstNode } from "./utils.ts";

const USER_ID_FIELD = /^userId$|UserId$/u;

const CONTACT_OWNER_FIELDS = new Set([
  "originatingAttorneyId",
  "responsibleAttorneyId",
]);

const USER_ID_SCHEMA = "userIdSchema";

const ORG_USER_VALIDATORS = new Set([
  "validateOrgUserId",
  "validateOrgUserIds",
  "lockOrgUserIdsForAssignment",
]);

const isUserIdField = (name: string): boolean =>
  USER_ID_FIELD.test(name) || CONTACT_OWNER_FIELDS.has(name);

const childExpressions = (node: unknown): unknown[] => {
  if (!isAstNode(node)) {
    return [];
  }
  switch (node.type) {
    case "CallExpression":
      return [
        node.callee,
        ...(Array.isArray(node.arguments) ? node.arguments : []),
      ];
    case "MemberExpression":
      return [node.object, node.property];
    case "ArrayExpression":
      return Array.isArray(node.elements) ? node.elements : [];
    case "SpreadElement":
      return [node.argument];
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return [node.expression];
    default:
      return [];
  }
};

const containsSchemaIdentifier = (node: unknown, name: string): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "Identifier") {
    return node.name === name;
  }
  return childExpressions(node).some((child) =>
    containsSchemaIdentifier(child, name),
  );
};

const containsRawStringSchema = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type === "CallExpression" &&
    getCalleeName(node.callee) === "v.string"
  ) {
    return true;
  }
  if (node.type === "MemberExpression") {
    return false;
  }
  return childExpressions(node).some(containsRawStringSchema);
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-user-id-schema" },
  rules: {
    "no-raw-user-id-schema": {
      meta: {
        type: "problem",
        messages: {
          rawUserIdSchema:
            "User ID schema field '{{name}}' must use userIdSchema (or " +
            'resourceIdSchema("user")) from @/api/lib/custom-schema, not an ' +
            "inline v.string(). Read user IDs through the shared schema at " +
            "the handler boundary.",
          missingOrgUserValidation:
            "Contact owner field '{{name}}' must be validated with " +
            "validateOrgUserId(s) or lockOrgUserIdsForAssignment before it " +
            "is written.",
        },
      },
      createOnce(context) {
        let hasValidateOrgUserId = false;
        const ownerFieldNodes: { name: string; node: Ranged }[] = [];

        return {
          before() {
            hasValidateOrgUserId = false;
            ownerFieldNodes.length = 0;
          },
          Identifier(node) {
            if (ORG_USER_VALIDATORS.has(node.name)) {
              hasValidateOrgUserId = true;
            }
          },
          Property(node) {
            const name = getPropertyName(node.key);
            if (!name || !isUserIdField(name)) {
              return;
            }

            if (CONTACT_OWNER_FIELDS.has(name)) {
              ownerFieldNodes.push({ node, name });
            }

            if (containsSchemaIdentifier(node.value, USER_ID_SCHEMA)) {
              return;
            }
            if (!containsRawStringSchema(node.value)) {
              return;
            }

            context.report({
              node,
              messageId: "rawUserIdSchema",
              data: { name },
            });
          },
          "Program:exit"() {
            if (hasValidateOrgUserId) {
              return;
            }
            for (const { node, name } of ownerFieldNodes) {
              context.report({
                node,
                messageId: "missingOrgUserValidation",
                data: { name },
              });
            }
          },
        };
      },
    },
  },
});
