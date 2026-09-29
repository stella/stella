/**
 * What one decision cites, read off its own text and nothing else.
 *
 * Extraction finds the citations; this turns them into references: the
 * identity each one names, the words the citing sentence printed about the
 * cited decision, what the citation is doing, and the windows its treatment is
 * read from. Every value is a function of the decision's sections and the
 * publisher's procedural history, so the same document always yields the same
 * references in the same order, whatever is or is not stored anywhere.
 *
 * Storage is a projection of this: a citation row is one reference plus the
 * polarity the rules and reviews gave it and the resolver's answer.
 */

import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import type { CitationDecisionTypeHint } from "@/api/handlers/case-law/citation-decision-type-hint";
import {
  CITATION_KIND,
  classifyCitation,
} from "@/api/handlers/case-law/citation-kind";
import type {
  CitationKind,
  ProceduralKeys,
} from "@/api/handlers/case-law/citation-kind";
import type { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  citationKeyOf,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { extractContexts } from "@/api/handlers/case-law/polarity/context";
import type { CitationContexts } from "@/api/handlers/case-law/polarity/context";
import type { SafeId } from "@/api/lib/branded-types";

type ExtractedCitation = ReturnType<typeof extractCitations>[number];

/** One typed identity a reference names, normalized for lookup. */
type DecisionReferenceIdentifier = {
  type: DecisionIdentifierType;
  normalizedValue: string;
};

/**
 * What the citing sentence says about the cited decision besides its
 * identity. Null is "the text did not say".
 */
export type DecisionReferenceHints = {
  court: string | null;
  decisionType: CitationDecisionTypeHint | null;
  sheetNumber: string | null;
  /** `YYYY-MM-DD`. */
  decisionDate: string | null;
};

export type DecisionReference = {
  /**
   * Position in the decision's extraction order, from zero. Extraction is a
   * pure function of the sections, so a document keeps its indexes.
   */
  index: number;
  /** The citation as the text prints it. */
  printed: string;
  /**
   * `bareCitationKey` of the printed form: what reviews are keyed by and what
   * the legacy docket bridge resolves through. Null when the text does not
   * canonicalize, which also leaves the reference out of resolution.
   */
  citationKey: string | null;
  /** The identity the reference resolves through. */
  identifiers: readonly [DecisionReferenceIdentifier];
  kind: CitationKind;
  hints: DecisionReferenceHints;
  /** The section the citation was found in; null when not located. */
  sectionIndex: number | null;
  /**
   * The windows the polarity rules read, one per mention. Null for a
   * procedural reference, whose treatment is not read, and for one whose
   * printed form is not found in the text.
   */
  polarityMentions: CitationContexts | null;
};

type DecisionReferences = {
  citingDecisionId: SafeId<"caseLawDecision">;
  references: readonly DecisionReference[];
};

type DeriveDecisionReferencesOptions = {
  citingDecisionId: SafeId<"caseLawDecision">;
  citations: readonly ExtractedCitation[];
  /** The publisher's statement of the case's own procedural history. */
  proceduralKeys: ProceduralKeys;
  sections: { text: string }[];
};

/**
 * One decision's references, in extraction order. Pure: the citing decision's
 * identity is carried, never looked up.
 */
export const deriveDecisionReferences = ({
  citingDecisionId,
  citations,
  proceduralKeys,
  sections,
}: DeriveDecisionReferencesOptions): DecisionReferences => ({
  citingDecisionId,
  references: citations.map((citation, index) => {
    const citationKey = citationKeyOf(citation.citationText);
    const windows = extractContexts(
      sections,
      citation.citationText,
      citation.sectionIndex,
    );
    const kind = classifyCitation({
      citationText: citation.citationText,
      citationKey,
      proceduralKeys,
      context: windows?.contexts[0] ?? null,
    });
    return {
      index,
      printed: citation.citationText,
      citationKey,
      identifiers: [
        {
          type: citation.identifierType,
          normalizedValue: normalizeDecisionIdentifierValue(
            citation.identifierType,
            citation.identifierValue,
          ),
        },
      ],
      kind,
      hints: {
        court: citation.citedCourtHint,
        decisionType: citation.citedDecisionTypeHint,
        sheetNumber: citation.citedSheetNumber,
        decisionDate: citation.citedDecisionDate,
      },
      sectionIndex: citation.sectionIndex,
      polarityMentions:
        kind === CITATION_KIND.PRECEDENT && windows !== null
          ? windows.mentions
          : null,
    };
  }),
});
