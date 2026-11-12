import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  MULTIPART_DOCUMENT_MAX_BYTES,
  UPLOAD_DOCUMENT_MAX_BYTES,
} from "../packages/api-contract/src/limits.ts";
import { filenameForContext, isAstNode } from "./utils.ts";

// A byte count equal to the document limit is a copy of it.
//
// The largest stored document is `UPLOAD_DOCUMENT_MAX_BYTES`, declared once in
// `packages/api-contract/src/document-version-upload.ts`, and the largest one a
// multipart request may carry is `MULTIPART_DOCUMENT_MAX_BYTES` beside it in
// `limits.ts`. A browser preflight, a CLI check, a stamp bound or a reader that
// writes the same number out by hand agrees with the limit only until the limit
// moves: then it refuses files the server accepts, or skips work on them, and
// nothing fails. Every such copy the limit once had was found by hand.
//
// The rule evaluates numeric literals and products of them (`200 * 1024 *
// 1024`, `209_715_200`) and reports one that equals either limit. It reads the
// limits from the owner, so a copy written after the limit moves is caught on
// the day it is written. The owner module, and the copy the published CLI
// generates from it, are the only places the value is spelled.

const LIMITS = new Set([
  UPLOAD_DOCUMENT_MAX_BYTES,
  MULTIPART_DOCUMENT_MAX_BYTES,
]);

const OWNING_MODULES = [
  "packages/api-contract/src/document-version-upload.ts",
  "packages/cli/src/generated/document-version-upload-transport.ts",
];

/** The value of a numeric literal or a product of them, else undefined. */
const literalProduct = (node: unknown): number | undefined => {
  if (!isAstNode(node)) {
    return undefined;
  }
  if (node.type === "Literal") {
    return typeof node.value === "number" ? node.value : undefined;
  }
  if (node.type === "BinaryExpression" && node.operator === "*") {
    const left = literalProduct(node.left);
    const right = literalProduct(node.right);
    return left === undefined || right === undefined ? undefined : left * right;
  }
  return undefined;
};

export default eslintCompatPlugin({
  meta: { name: "no-literal-document-byte-limit" },
  rules: {
    "no-literal-document-byte-limit": {
      meta: {
        type: "problem",
        messages: {
          copiedLimit:
            "This byte count equals the document limit, so it is a copy of " +
            "it that stops agreeing when the limit moves. Import " +
            "UPLOAD_DOCUMENT_MAX_BYTES (or MULTIPART_DOCUMENT_MAX_BYTES for a " +
            "multipart form) from @stll/api-contract/limits instead.",
        },
      },
      createOnce(context) {
        const check = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
        ) => {
          const value = literalProduct(node);
          if (value === undefined || !LIMITS.has(value)) {
            return;
          }
          // Report the outermost product that still equals the limit once.
          if (literalProduct(Reflect.get(node, "parent")) === value) {
            return;
          }
          const filename = filenameForContext(context);
          if (OWNING_MODULES.some((owner) => filename.endsWith(owner))) {
            return;
          }
          context.report({ node, messageId: "copiedLimit" });
        };
        return {
          BinaryExpression: check,
          Literal: check,
        };
      },
    },
  },
});
