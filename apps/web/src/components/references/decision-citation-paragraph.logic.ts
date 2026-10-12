import { panic } from "better-result";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

export type DecisionCitationParagraphSource = Pick<
  PublicCaseLawDecision,
  "documentAst" | "resolution"
>;

type CourtNumberByAnchor = ReadonlyMap<string, number>;

const EMPTY_INDEX: CourtNumberByAnchor = new Map();

// A read's AST is one immutable object per cached response, so every chip
// citing the same decision shares a single parse instead of one per render.
const indexByDocumentAst = new WeakMap<object, CourtNumberByAnchor>();

const courtNumberIndex = (documentAst: unknown): CourtNumberByAnchor => {
  const cacheable = typeof documentAst === "object" && documentAst !== null;
  const cached = cacheable ? indexByDocumentAst.get(documentAst) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const index = new Map<string, number>();
  for (const block of parseDocumentAst(documentAst)?.blocks ?? []) {
    if (
      block.type === "paragraph" &&
      block.number !== undefined &&
      Number.isSafeInteger(block.number) &&
      block.number >= 1
    ) {
      index.set(block.anchorId, block.number);
    }
  }
  const result = index.size === 0 ? EMPTY_INDEX : index;
  if (cacheable) {
    indexByDocumentAst.set(documentAst, result);
  }
  return result;
};

/**
 * The paragraph number the court itself printed on the cited block, or null.
 *
 * Anchors (`p-8`) count every block, headings included, so they are never a
 * court number: the number comes only from the block's own `number`, and a
 * decision whose court does not number its paragraphs yields none. An
 * address naming reasons absorbed into their judgment finds its block under
 * the prefix the reasons carry there; a block that is not there is not
 * substituted, since a number from another block would misattribute the
 * citation.
 */
export const citedCourtParagraphNumber = ({
  decision,
  anchorId,
}: {
  decision: DecisionCitationParagraphSource;
  anchorId: string | undefined;
}): number | null => {
  if (anchorId === undefined) {
    return null;
  }
  const index = courtNumberIndex(decision.documentAst);
  switch (decision.resolution.type) {
    case DECISION_READ_RESOLUTION.DIRECT:
      return index.get(anchorId) ?? null;
    case DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT:
      return (
        index.get(`${decision.resolution.anchorPrefix}${anchorId}`) ?? null
      );
    default:
      decision.resolution satisfies never;
      return panic(
        `Unhandled decision resolution: ${String(decision.resolution)}`,
      );
  }
};
