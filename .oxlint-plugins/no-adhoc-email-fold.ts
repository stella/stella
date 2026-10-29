// Email addresses compare equal through one owner,
// apps/api/src/lib/email/normalized-email.ts. A hand-written fold elsewhere
// can disagree with it (trim or not, JavaScript or SQL case mapping), and a
// gate that folds one way admits an address the account lookup resolves
// another way. Syntax only: a value counts as an address when the binding or
// property it is read from is named like one (`email`, `userEmail`,
// `mailbox`, `profile["email"]`), so an address renamed to `value` is out of
// reach; the owner's types carry the rest.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const EMAIL_NAME = /e-?mail|mailbox/iu;
const LOWERCASE_METHODS = new Set(["toLowerCase", "toLocaleLowerCase"]);
const TRIM_METHODS = new Set(["trim", "trimStart", "trimEnd"]);
const SQL_TAGS = new Set(["sql", "sql.raw"]);
// A case fold opened right before an interpolation: `lower(${user.email})`.
const SQL_FOLD_OPENING = /\b(?:lower|upper)\s*\(\s*$/iu;

const calledMethod = (node: unknown): string | null => {
  const call = unwrapExpression(node);
  const callee = unwrapExpression(call?.callee);
  return callee?.type === "MemberExpression"
    ? memberPropertyName(callee)
    : null;
};

const calledReceiver = (node: unknown): AstNode | null => {
  const call = unwrapExpression(node);
  const callee = unwrapExpression(call?.callee);
  return callee?.type === "MemberExpression"
    ? unwrapExpression(callee.object)
    : null;
};

/** The name an expression reads its value from, when it has one. */
const valueName = (node: AstNode | null): string | null => {
  if (node === null) {
    return null;
  }
  if (node.type === "Identifier") {
    return getPropertyName(node);
  }
  if (node.type === "MemberExpression") {
    return memberPropertyName(node);
  }
  return null;
};

/** Peels `.trim()` and its one-sided variants off the folded receiver. */
const foldedValue = (receiver: AstNode | null): AstNode | null => {
  let current = receiver;
  while (
    current?.type === "CallExpression" &&
    TRIM_METHODS.has(calledMethod(current) ?? "")
  ) {
    current = calledReceiver(current);
  }
  return current;
};

const isEmailNamed = (node: AstNode | null): boolean =>
  EMAIL_NAME.test(valueName(node) ?? "");

const isCallOf = (node: unknown, methods: ReadonlySet<string>): boolean => {
  const call = unwrapExpression(node);
  return (
    call?.type === "CallExpression" && methods.has(calledMethod(call) ?? "")
  );
};

const EMAIL_ACTION = new Set(["email"]);

const tagName = (tag: unknown): string | null => {
  const node = unwrapExpression(tag);
  if (node?.type === "Identifier") {
    return getPropertyName(node);
  }
  if (node?.type === "MemberExpression") {
    const object = unwrapExpression(node.object);
    const property = memberPropertyName(node);
    return object?.type === "Identifier" && property !== null
      ? `${String(getPropertyName(object))}.${property}`
      : null;
  }
  return null;
};

const rawTextOf = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : undefined;
  return typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof value.raw === "string"
    ? value.raw
    : "";
};

export default eslintCompatPlugin({
  meta: { name: "no-adhoc-email-fold" },
  rules: {
    "no-adhoc-email-fold": {
      meta: {
        type: "problem",
        messages: {
          fold: "Fold an email address with normalizeEmail() from @/api/lib/email/normalized-email so every comparison, key and lookup uses one rule.",
          schema:
            "Validate an email address with emailAddressSchema from @/api/lib/email/normalized-email instead of a lowercase action in the pipe.",
          sql: "Compare a stored email column with emailColumnMatches() from @/api/lib/email/normalized-email instead of folding it in SQL by hand.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const method = calledMethod(node);
            if (method === null) {
              return;
            }
            if (LOWERCASE_METHODS.has(method)) {
              if (isEmailNamed(foldedValue(calledReceiver(node)))) {
                context.report({ node, messageId: "fold" });
              }
              return;
            }
            if (method !== "pipe") {
              return;
            }
            const actions = Array.isArray(node.arguments) ? node.arguments : [];
            if (
              actions.some((action) => isCallOf(action, LOWERCASE_METHODS)) &&
              actions.some((action) => isCallOf(action, EMAIL_ACTION))
            ) {
              context.report({ node, messageId: "schema" });
            }
          },
          TaggedTemplateExpression(node) {
            if (!SQL_TAGS.has(tagName(node.tag) ?? "")) {
              return;
            }
            const template = node.quasi;
            const quasis =
              isAstNode(template) && Array.isArray(template.quasis)
                ? template.quasis
                : [];
            const expressions =
              isAstNode(template) && Array.isArray(template.expressions)
                ? template.expressions
                : [];
            for (const [index, expression] of expressions.entries()) {
              if (
                SQL_FOLD_OPENING.test(rawTextOf(quasis[index])) &&
                isEmailNamed(unwrapExpression(expression))
              ) {
                context.report({ node, messageId: "sql" });
                return;
              }
            }
          },
        };
      },
    },
  },
});
