// Disallow user ID request schemas typed as raw strings.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/strict-boolean-expressions
//
// User IDs are auth-provider strings, but handlers should still use the
// branded `tUserId` schema at boundaries. That prevents ownership-like fields
// from degrading back into arbitrary strings and makes follow-up membership
// validation explicit in handler code.

import { getCalleeName, getPropertyName } from "./utils.ts";

const USER_ID_SCHEMA_FIELDS = new Set([
  "userId",
  "originatingAttorneyId",
  "responsibleAttorneyId",
]);

const CONTACT_OWNER_FIELDS = new Set([
  "originatingAttorneyId",
  "responsibleAttorneyId",
]);

const containsSchemaIdentifier = (node, name) => {
  if (!node) {
    return false;
  }
  if (node.type === "Identifier") {
    return node.name === name;
  }
  if (node.type === "CallExpression") {
    return (
      containsSchemaIdentifier(node.callee, name) ||
      node.arguments.some((arg) => containsSchemaIdentifier(arg, name))
    );
  }
  if (node.type === "MemberExpression") {
    return (
      containsSchemaIdentifier(node.object, name) ||
      containsSchemaIdentifier(node.property, name)
    );
  }
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return containsSchemaIdentifier(node.expression, name);
  }
  return false;
};

const containsRawStringSchema = (node) => {
  if (!node) {
    return false;
  }
  if (node.type === "CallExpression") {
    if (getCalleeName(node.callee) === "t.String") {
      return true;
    }
    return node.arguments.some(containsRawStringSchema);
  }
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return containsRawStringSchema(node.expression);
  }
  return false;
};

export default {
  meta: { name: "no-raw-user-id-schema" },
  rules: {
    "no-raw-user-id-schema": {
      meta: {
        type: "problem",
        messages: {
          rawUserIdSchema:
            "User ID schema field '{{name}}' must use tUserId, not t.String(). Brand user IDs at the handler boundary.",
          missingOrgUserValidation:
            "Contact owner field '{{name}}' must be validated with validateOrgUserId before it is written.",
        },
      },
      create(context) {
        let hasValidateOrgUserId = false;
        const ownerFieldNodes = [];

        const checkProperty = (node) => {
          const name = getPropertyName(node.key);
          if (!name || !USER_ID_SCHEMA_FIELDS.has(name)) {
            return;
          }

          if (CONTACT_OWNER_FIELDS.has(name)) {
            ownerFieldNodes.push({ node, name });
          }

          if (containsSchemaIdentifier(node.value, "tUserId")) {
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
        };

        return {
          Identifier(node) {
            if (node.name === "validateOrgUserId") {
              hasValidateOrgUserId = true;
            }
          },
          Property: checkProperty,
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
};
