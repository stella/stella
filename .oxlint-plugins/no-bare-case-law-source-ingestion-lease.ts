import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  filenameForContext,
  isFileIn,
  isIdentifier,
  resolveImportedExpressionForEnforcement,
} from "./utils.ts";

const OWNER =
  "apps/api/src/lib/legal-search/case-law-source-ingestion-lease.ts";

const ACQUIRE = "acquireCaseLawSourceIngestionLease";

export const createCaseLawSourceIngestionLeasePlugin = (
  enforcesLine = guardEnforcesLine,
) =>
  eslintCompatPlugin({
    meta: { name: "no-bare-case-law-source-ingestion-lease" },
    rules: {
      "no-bare-case-law-source-ingestion-lease": {
        meta: {
          type: "problem",
          messages: {
            bareAcquisition:
              "Run source work through withCaseLawSourceIngestionLease; only the lease owner may acquire directly.",
          },
          schema: [],
        },
        createOnce(context) {
          const enforces = (node: Ranged) => {
            const start = context.sourceCode.getLocFromIndex(
              node.range[0],
            ).line;
            const end = context.sourceCode.getLocFromIndex(
              node.range[1] - 1,
            ).line;
            for (let line = start; line <= end; line++) {
              if (
                enforcesLine({
                  guard: "no-bare-case-law-source-ingestion-lease",
                  file: filenameForContext(context),
                  line,
                })
              ) {
                return true;
              }
            }
            return false;
          };

          return {
            before() {
              return !isFileIn(context, [OWNER]);
            },
            // Any member named like the acquisition, whatever object holds
            // it: a namespace import, or a module loaded on demand.
            MemberExpression(node) {
              if (
                !node.computed &&
                isIdentifier(node.property) &&
                node.property.name === ACQUIRE &&
                enforces(node)
              ) {
                context.report({ node, messageId: "bareAcquisition" });
              }
            },
            CallExpression(node) {
              if (!isIdentifier(node.callee)) {
                return;
              }
              const imported = resolveImportedExpressionForEnforcement(
                context,
                node.callee,
              );
              const isDirectGlobal = node.callee.name === ACQUIRE;
              if (
                enforces(node) &&
                (isDirectGlobal || imported?.imported === ACQUIRE)
              ) {
                context.report({
                  node: node.callee,
                  messageId: "bareAcquisition",
                });
              }
            },
          };
        },
      },
    },
  });

export default createCaseLawSourceIngestionLeasePlugin();
