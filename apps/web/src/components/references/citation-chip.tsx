import type { ReactNode } from "react";

import { DecisionCitationChip } from "@/components/references/decision-citation-chip";
import type { DecisionCitationChipProps } from "@/components/references/decision-citation-chip";
import { ParagraphReference } from "@/features/case-law/components/case-viewer/paragraph-reference";
import type { ParagraphReferenceProps } from "@/features/case-law/components/case-viewer/paragraph-reference";

/** What each kind of citation needs to draw, keyed by its kind. */
type CitationPayloads = {
  /** Paragraphs of the decision being read: previewed from its loaded text. */
  paragraph: ParagraphReferenceProps;
  /** Another decision: previewed from its metadata, opened beside the text. */
  decision: DecisionCitationChipProps;
};

export type CitationKind = keyof CitationPayloads;

export type CitationChipProps<Kind extends CitationKind = CitationKind> = {
  [Key in Kind]: { kind: Key } & CitationPayloads[Key];
}[Kind];

type CitationRenderers = {
  [Kind in CitationKind]: (citation: CitationChipProps<Kind>) => ReactNode;
};

// Annotated rather than `satisfies`: indexing the mapped type by a generic
// kind is what keeps each renderer paired with its own kind's props.
const CITATION_RENDERERS: CitationRenderers = {
  paragraph: ({ language, onAnchorClick, reference }) => (
    <ParagraphReference
      language={language}
      onAnchorClick={onAnchorClick}
      reference={reference}
    />
  ),
  decision: ({
    decision,
    passage,
    preview,
    presentation,
    paragraphNumber,
    onOpenInSidePanel,
    label,
    citingText,
  }) => (
    <DecisionCitationChip
      citingText={citingText}
      decision={decision}
      label={label}
      onOpenInSidePanel={onOpenInSidePanel}
      paragraphNumber={paragraphNumber}
      passage={passage}
      presentation={presentation}
      preview={preview}
    />
  ),
};

const renderCitation = <Kind extends CitationKind>(
  citation: CitationChipProps<Kind>,
): ReactNode => CITATION_RENDERERS[citation.kind](citation);

/**
 * The one way a surface draws a citation. The kind picks the chip, so a
 * paragraph of the open decision and another decision never look or behave
 * alike by accident, and the marker below lets tests prove that every
 * citation on a surface came through here.
 */
export const CitationChip = (citation: CitationChipProps) => (
  <span data-citation-kind={citation.kind}>{renderCitation(citation)}</span>
);
