import type { Block } from "@stll/legal-ast/document-ast";

import { inlinesToPlainText } from "@/components/legal-reader/document-ast-text";
import { locateCitationAnchors } from "@/features/case-law/citation-anchors";
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";

/** The paragraph in which a decision names another, and where in it. */
export type CitationPassage = {
  anchorId: string;
  /** The paragraph's words, with the citation's place in them. */
  text: string;
  start: number;
  end: number;
};

/**
 * The first paragraph of `blocks` that names the cited decision the way
 * the citation row wrote it; null when the text does not carry it (a
 * decision whose structure is unknown, or a citation the parser read from
 * a table).
 */
export const findCitationPassage = ({
  blocks,
  citation,
}: {
  blocks: readonly Block[];
  citation: CitationAnchorSource;
}): CitationPassage | null => {
  const spans = locateCitationAnchors({ blocks, citations: [citation] });
  for (const block of blocks) {
    const hit = spans[block.id]?.at(0);
    if (hit === undefined || block.type === "table") {
      continue;
    }
    return {
      anchorId: block.anchorId,
      end: hit.end,
      start: hit.start,
      text: inlinesToPlainText(block.inlines),
    };
  }
  return null;
};
