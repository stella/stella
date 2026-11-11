import { panic } from "better-result";

import { DECISION_ANCHOR_RESOLUTION } from "@stll/api-contract/case-law-anchor-redirects";
import { parseDecisionParagraphFragment } from "@stll/api-contract/decision-paragraph-range";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { resolveDecisionParagraphRange } from "@stll/legal-ast/paragraph-range";

import {
  HELD_ANCHOR_STATE,
  type HeldDecisionAnchor,
} from "@/features/case-law/decision-anchor-resolution.logic";

const isCourtParagraphFragment = (fragment: string) =>
  fragment.replace(/^#/u, "").startsWith("par=");

/**
 * The block anchor a fragment names, when it names one. A `#par=` fragment
 * names court paragraph numbers, which a reparse never moves.
 */
export const fragmentBlockAnchor = (fragment: string | undefined) =>
  fragment === undefined || isCourtParagraphFragment(fragment)
    ? undefined
    : fragment;

export const decisionParagraphLanding = (
  ast: DocumentAst | null,
  fragment: string | undefined,
  resolveAnchor: (anchor: string) => HeldDecisionAnchor,
) => {
  if (fragment === undefined) {
    return { type: "anchor", anchorId: undefined } as const;
  }
  if (!isCourtParagraphFragment(fragment)) {
    const held = resolveAnchor(fragment);
    switch (held.type) {
      case DECISION_ANCHOR_RESOLUTION.CURRENT:
      case DECISION_ANCHOR_RESOLUTION.MOVED:
        return { type: "anchor", anchorId: held.anchorId } as const;
      // A failed redirect read lands as before: on the block when it is
      // rendered, nowhere when it is not.
      case HELD_ANCHOR_STATE.UNAVAILABLE:
        return { type: "anchor", anchorId: fragment } as const;
      case HELD_ANCHOR_STATE.PENDING:
        return { type: "anchor-pending" } as const;
      case DECISION_ANCHOR_RESOLUTION.GONE:
        return { type: "anchor-gone" } as const;
      default:
        held satisfies never;
        return panic("Unhandled held decision anchor");
    }
  }
  const range = parseDecisionParagraphFragment(fragment);
  if (range === null) {
    return { type: "invalid" } as const;
  }
  if (ast === null) {
    return { type: "text-unavailable" } as const;
  }
  const resolution = resolveDecisionParagraphRange(ast, range);
  switch (resolution.type) {
    case "found":
      return {
        type: "range",
        range,
        anchorIds: resolution.anchorIds,
        firstAnchorId: resolution.firstAnchorId,
      } as const;
    case "not-found":
      return { type: "not-found", range } as const;
    default:
      resolution satisfies never;
      return panic("Unhandled decision paragraph range resolution");
  }
};
