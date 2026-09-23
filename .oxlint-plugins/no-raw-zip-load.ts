// `JSZip.loadAsync` parses the central directory, and every later
// `entry.async(...)` inflates an entry to whatever size the archive declares:
// a small upload can decompress to gigabytes in the API process. Archive reads
// go through `loadDocxArchive` (`apps/api/src/lib/docx-archive.ts`), which caps
// entry count, per-entry size, and cumulative size, or through the file
// scanner, which inspects archives before anything else reads them.
//
//   await JSZip.loadAsync(bytes)            // default import, any local name
//   await new JSZip().loadAsync(bytes)      // instance form
//
// Existing callers are frozen by this rule's suppression budget in
// scripts/ratchet.ts; the budget may only shrink. Tests and operational
// scripts (`apps/api/src/scripts/`) are exempt.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const OWNER_FRAGMENTS = [
  "apps/api/src/lib/docx-archive.ts",
  "apps/api/src/lib/file-scan/",
];

const EXEMPT_FRAGMENTS = ["apps/api/src/scripts/", "apps/api/src/tests/"];

export default eslintCompatPlugin({
  meta: { name: "no-raw-zip-load" },
  rules: {
    "no-raw-zip-load": {
      meta: {
        type: "problem",
        messages: {
          rawZipLoad:
            "Do not call JSZip.loadAsync directly; open archives with " +
            "loadDocxArchive from @/api/lib/docx-archive so entry reads are " +
            "size-capped.",
        },
      },
      createOnce(context) {
        const jszipLocals = new Set<string>();
        // Variables initialized with `new JSZip()`.
        const instanceLocals = new Set<string>();

        // A JSZip instance: `new JSZip()`, a variable holding one, or a
        // `.folder(...)` of either (folders share the archive's loadAsync).
        const isJszipRef = (node: unknown): boolean => {
          if (isIdentifier(node)) {
            return jszipLocals.has(node.name) || instanceLocals.has(node.name);
          }
          if (!isAstNode(node)) {
            return false;
          }
          if (node.type === "NewExpression") {
            return (
              isIdentifier(node.callee) && jszipLocals.has(node.callee.name)
            );
          }
          return (
            node.type === "CallExpression" &&
            isAstNode(node.callee) &&
            node.callee.type === "MemberExpression" &&
            isIdentifier(node.callee.property, "folder") &&
            isJszipRef(node.callee.object)
          );
        };

        return {
          before() {
            jszipLocals.clear();
            instanceLocals.clear();
            const filename = filenameForContext(context);
            if (
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/no-raw-zip-load.fixture.ts",
              )
            ) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !filename.endsWith(".test.ts") &&
              ![...OWNER_FRAGMENTS, ...EXEMPT_FRAGMENTS].some((fragment) =>
                filename.includes(fragment),
              )
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              node.source.value !== "jszip" ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            // `import JSZip from "jszip"` is the usual form; the default and
            // namespace specifiers carry the local binding directly.
            for (const specifier of node.specifiers) {
              const local = isAstNode(specifier) ? specifier.local : undefined;
              if (isIdentifier(local)) {
                jszipLocals.add(local.name);
              }
            }
          },
          VariableDeclarator(node) {
            const { id, init } = node;
            if (
              isIdentifier(id) &&
              isAstNode(init) &&
              init.type !== "Identifier" &&
              isJszipRef(init)
            ) {
              instanceLocals.add(id.name);
            }
          },
          CallExpression(node) {
            const { callee } = node;
            if (
              isAstNode(callee) &&
              callee.type === "MemberExpression" &&
              isIdentifier(callee.property, "loadAsync") &&
              isJszipRef(callee.object)
            ) {
              context.report({ node, messageId: "rawZipLoad" });
            }
          },
        };
      },
    },
  },
});
