// A case-law adapter's `rawHash` comes from `sourceFingerprint`.
//
// The pipeline rewrites a stored decision only when the incoming `rawHash`
// differs, so the hash has to cover every stored raw byte. The owner
// (`apps/api/src/handlers/case-law/ingestion/source-fingerprint.ts`) derives
// it from the stored fields themselves; a hand-written hash over identifiers,
// one response or parsed text can leave a correction undetected.
//
// Reported: a `rawHash` property in an object literal, or an assignment to
// `<expr>.rawHash`, whose value is not a direct `sourceFingerprint(...)` call.
// A value read from another decision's `.rawHash` passes through unchanged,
// since that decision was built under the same rule.
//
// Detection boundary: syntax only. A value computed elsewhere and named by a
// variable is reported, because the rule cannot see where it came from.
//
// Options: `allowedFiles` lists repository-relative files that predate the
// owner, generated into `scripts/source-fingerprint-baseline.json` by
// `scripts/source-fingerprint-baseline.ts`. `census: true` ignores that list,
// which is how the generator enumerates every current member.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const OWNER_CALL = "sourceFingerprint";
const FIELD = "rawHash";

const stringsFrom = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const isSanctionedValue = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (node.type === "CallExpression") {
    return isIdentifier(node.callee, OWNER_CALL);
  }
  if (node.type === "MemberExpression") {
    return memberPropertyName(node) === FIELD;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "raw-hash-from-source-fingerprint" },
  rules: {
    "raw-hash-from-source-fingerprint": {
      meta: {
        type: "problem",
        messages: {
          handRolled:
            "Derive rawHash with sourceFingerprint over the stored envelope and objects, not by hand.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: { type: "array", items: { type: "string" } },
              census: { type: "boolean" },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        return {
          before() {
            const options: unknown = context.options[0];
            if (typeof options !== "object" || options === null) {
              return true;
            }
            if (Reflect.get(options, "census") === true) {
              return true;
            }
            const filename = filenameForContext(context);
            return !stringsFrom(Reflect.get(options, "allowedFiles")).some(
              (file) => filename.endsWith(file),
            );
          },
          Property(node) {
            if (
              node.parent.type !== "ObjectExpression" ||
              node.computed ||
              getPropertyName(node.key) !== FIELD ||
              isSanctionedValue(node.value)
            ) {
              return;
            }
            context.report({ node, messageId: "handRolled" });
          },
          AssignmentExpression(node) {
            const target: unknown = node.left;
            if (
              !isAstNode(target) ||
              target.type !== "MemberExpression" ||
              memberPropertyName(target) !== FIELD ||
              isSanctionedValue(node.right)
            ) {
              return;
            }
            context.report({ node, messageId: "handRolled" });
          },
        };
      },
    },
  },
});
