// Temporary-root entries belong to the process that created them. Sweeping
// names discovered by listing a shared root can delete another concurrently
// running test's directory.
//
// Rejected: iterate readdirSync(tmpdir()) and remove path.join(tmpdir(), name).
// Accepted: remove the exact directory returned by mkdtempSync(...).
//
// This rule deliberately targets the review-resistant sweep shape rather than
// every temporary-path removal. Directories returned by mkdtemp are owned; a
// name learned from a shared-root listing is not.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode } from "./utils.ts";

const SHARED_ROOT = String.raw`(?:tmpdir\s*\(\s*\)|(?:process\.env\.)?RUNNER_TEMP|(?:process\.env\.)?TMPDIR|["'\x60]\/tmp["'\x60])`;

export default eslintCompatPlugin({
  meta: { name: "no-shared-temp-sweep" },
  rules: {
    "no-shared-temp-sweep": {
      meta: {
        type: "problem",
        messages: {
          sweep:
            "Do not remove paths discovered by listing a shared temporary root. Track and remove only paths this process created.",
        },
      },
      createOnce(context) {
        return {
          ForOfStatement(node) {
            if (!isAstNode(node.left) || !isAstNode(node.right)) {
              return;
            }
            const source = context.sourceCode.getText(node.right);
            const listedSharedRoot = new RegExp(
              String.raw`(?:readdir|readdirSync)\s*\(\s*${SHARED_ROOT}`,
              "u",
            ).test(source);
            if (!listedSharedRoot) {
              return;
            }
            const left = context.sourceCode.getText(node.left);
            const match = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/u.exec(left);
            const name = match?.[1];
            if (name === undefined) {
              return;
            }
            const body = context.sourceCode.getText(node.body);
            const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
            const removesListedEntry = new RegExp(
              String.raw`(?:rm|rmSync|rmdir|rmdirSync)\s*\(\s*(?:path\.)?join\s*\(\s*${SHARED_ROOT}\s*,\s*${escapedName}\b`,
              "u",
            ).test(body);
            if (removesListedEntry) {
              context.report({ node, messageId: "sweep" });
            }
          },
        };
      },
    },
  },
});
