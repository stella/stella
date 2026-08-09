// Keep document-version replacement logic behind its canonical transaction.
//
// The two session finalizers own distinct durable protocols, and restore-version
// publishes no new bytes. Their explicit paths make those exceptions reviewable;
// every ordinary or automatic replacement must call writeFileVersion instead of
// assembling version numbers and cloned fields in a feature slice.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  isAstNode,
  isStringLiteral,
} from "./utils.ts";

const VERSION_UTILS_MODULE = "@/api/lib/entity-versions/version-utils";
const VERSION_WRITE_HELPERS = new Set([
  "cloneFieldsForRevision",
  "nextEntityVersionNumber",
]);
const REVIEWED_VERSION_OWNERS = [
  "apps/api/src/handlers/entities/finalize-desktop-edit-session.ts",
  "apps/api/src/handlers/entities/restore-version.ts",
  "apps/api/src/handlers/folio-collab/finalize.ts",
  "apps/api/src/lib/entity-versions/write-file-version.ts",
] as const;

const isReviewedVersionOwner = (filename: string): boolean =>
  REVIEWED_VERSION_OWNERS.some((owner) => filename.endsWith(owner));

export default eslintCompatPlugin({
  meta: { name: "no-unowned-file-version-write" },
  rules: {
    "no-unowned-file-version-write": {
      meta: {
        type: "problem",
        messages: {
          unownedVersionWrite:
            "Create document replacements through writeFileVersion. Only the canonical transaction and reviewed session/restore lifecycles may assemble version rows directly.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return !isReviewedVersionOwner(filenameForContext(context));
          },
          ImportDeclaration(node) {
            if (
              !isAstNode(node.source) ||
              !isStringLiteral(node.source) ||
              node.source.value !== VERSION_UTILS_MODULE ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }

            for (const specifier of node.specifiers) {
              const importedName = getImportedName(specifier);
              if (
                importedName !== null &&
                VERSION_WRITE_HELPERS.has(importedName)
              ) {
                context.report({
                  node: specifier,
                  messageId: "unownedVersionWrite",
                });
              }
            }
          },
        };
      },
    },
  },
});
