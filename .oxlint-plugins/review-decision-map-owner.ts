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
import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "review-decision-map-owner";
const OWNER_FILE = "packages/api-contract/src/review-decision.ts";
const OWNER_MODULE = "@stll/api-contract/review-decision";
const DECISION_TYPE = "ReviewDecision";

/** The names `ReviewDecision` goes by in a file: its own, and any alias it
 *  is imported under. */
const decisionNamesOf = (program: AstNode): Set<string> => {
  const names = new Set([DECISION_TYPE]);
  const body = Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    if (
      !isAstNode(statement) ||
      statement.type !== "ImportDeclaration" ||
      !isAstNode(statement.source) ||
      statement.source.value !== OWNER_MODULE ||
      !Array.isArray(statement.specifiers)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const local = getImportLocalName(specifier);
      if (getImportedName(specifier) === DECISION_TYPE && local !== null) {
        names.add(local);
      }
    }
  }
  return names;
};

const typeArgumentsOf = (node: AstNode): unknown[] => {
  const holder = node.typeArguments ?? node.typeParameters;
  return isAstNode(holder) && Array.isArray(holder.params) ? holder.params : [];
};

/** Whether a type names `ReviewDecision` (under any of its names), alone
 *  or in a union. */
const mentionsDecision = (type: unknown, names: Set<string>): boolean => {
  if (!isAstNode(type)) {
    return false;
  }
  if (type.type === "TSTypeReference") {
    return isIdentifier(type.typeName) && names.has(type.typeName.name);
  }
  if (type.type === "TSUnionType" && Array.isArray(type.types)) {
    return type.types.some((member) => mentionsDecision(member, names));
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
        let names = new Set([DECISION_TYPE]);
        return {
          Program(node: unknown) {
            names = isAstNode(node)
              ? decisionNamesOf(node)
              : new Set([DECISION_TYPE]);
          },
          TSTypeReference(node: unknown) {
            if (
              !isAstNode(node) ||
              !isIdentifier(node.typeName, "Record") ||
              !mentionsDecision(typeArgumentsOf(node).at(1), names)
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
