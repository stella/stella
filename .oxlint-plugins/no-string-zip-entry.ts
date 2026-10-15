// Keep zip entry writes at @stll/docx-utils' writeZipEntry. JSZip encodes
// string content in 16 KiB pieces, which splits a surrogate pair straddling
// a piece boundary into two U+FFFD characters; the owner encodes text once.
// Syntax-based: any `.file(path, content, ...)` call is a zip write, because
// JSZip's one-argument `.file(path)` is the read form; `Bun.file` and the
// callback form of FileSystemFileEntry.file are the other `file` methods.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, getPropertyName, isAstNode } from "./utils.ts";

const OWNER_PATH = "packages/docx-utils/src/zip-entry.ts";

export default eslintCompatPlugin({
  meta: { name: "no-string-zip-entry" },
  rules: {
    "no-string-zip-entry": {
      meta: {
        type: "problem",
        messages: {
          direct:
            "Write zip entries with writeZipEntry() from @stll/docx-utils: JSZip splits string content at 16 KiB and corrupts characters outside the Basic Multilingual Plane.",
        },
      },
      createOnce(context) {
        let isOwnerFile = false;

        return {
          before() {
            isOwnerFile = filenameForContext(context).endsWith(OWNER_PATH);
          },
          CallExpression(node) {
            if (isOwnerFile || node.arguments.length < 2) {
              return;
            }
            if (
              !isAstNode(node.callee) ||
              node.callee.type !== "MemberExpression" ||
              getPropertyName(node.callee.property) !== "file"
            ) {
              return;
            }
            // FileSystemFileEntry.file(success, failure) takes callbacks;
            // a JSZip write never does.
            if (
              node.arguments.some(
                (argument) =>
                  isAstNode(argument) &&
                  (argument.type === "ArrowFunctionExpression" ||
                    argument.type === "FunctionExpression"),
              )
            ) {
              return;
            }
            const receiver = node.callee.object;
            if (
              isAstNode(receiver) &&
              receiver.type === "Identifier" &&
              receiver.name === "Bun"
            ) {
              return;
            }
            context.report({ node, messageId: "direct" });
          },
        };
      },
    },
  },
});
