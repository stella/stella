// What a review surface's status means as the shared decision (accepted,
// rejected, or open) has one owner: `REVIEW_STATUS_DECISION` in
// packages/api-contract/src/review-decision.ts. A second map from statuses
// to `ReviewDecision` lets one surface read "needs evidence" or "dismissed"
// differently from another, and the history, the queue and bulk acceptance
// drift apart.
//
// Flagged, outside the owner: a `Record<…, ReviewDecision …>` type, which is
// how such a map is written and checked.
//   const MAP = { reviewed: "accepted" } as const satisfies Record<Status, ReviewDecision | null>;
// Allowed: reading the owner.
//   REVIEW_STATUS_DECISION.claim[status]

import { eslintCompatPlugin } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import { filenameForContext, isAstNode, isIdentifier } from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "review-decision-map-owner";
const OWNER_FILE = "packages/api-contract/src/review-decision.ts";
const DECISION_TYPE = "ReviewDecision";

const typeArgumentsOf = (node: AstNode): unknown[] => {
  const holder = node.typeArguments ?? node.typeParameters;
  return isAstNode(holder) && Array.isArray(holder.params) ? holder.params : [];
};

/** Whether a type names `ReviewDecision`, alone or in a union. */
const mentionsDecision = (type: unknown): boolean => {
  if (!isAstNode(type)) {
    return false;
  }
  if (type.type === "TSTypeReference") {
    return isIdentifier(type.typeName, DECISION_TYPE);
  }
  if (type.type === "TSUnionType" && Array.isArray(type.types)) {
    return type.types.some(mentionsDecision);
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          secondMap:
            "A map from statuses to ReviewDecision has one owner, REVIEW_STATUS_DECISION in @stll/api-contract/review-decision: read it (REVIEW_STATUS_DECISION.<surface>[status]) or add the surface there, so every review surface reads a status as the same decision.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          TSTypeReference(node: unknown) {
            if (
              !isAstNode(node) ||
              !isIdentifier(node.typeName, "Record") ||
              !mentionsDecision(typeArgumentsOf(node).at(1))
            ) {
              return;
            }
            const file = filenameForContext(context);
            if (file.endsWith(OWNER_FILE)) {
              return;
            }
            if (
              !guardEnforcesLine({
                guard: RULE_NAME,
                file,
                line: context.sourceCode.getLocFromIndex(node.range[0]).line,
              })
            ) {
              return;
            }
            context.report({ node, messageId: "secondMap" });
          },
        };
      },
    },
  },
});
