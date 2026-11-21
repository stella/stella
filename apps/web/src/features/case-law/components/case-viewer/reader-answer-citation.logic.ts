import { panic } from "better-result";

import type { ReaderAnswerCitation } from "@stll/api-contract/reader-answers";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";

import { decisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import type { DecisionCitationMetadata } from "@/components/references/decision-citation-chip.logic";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { QueryView } from "@/lib/query-view.logic";

import { resolveParagraphReference } from "./paragraph-reference.logic";
import type { ResolvedParagraphReference } from "./paragraph-reference.logic";

/** Another decision an answer cites, as far as the reader has read it. */
export type CitedDecisionRead =
  | { type: "pending" }
  | { type: "unavailable" }
  | {
      type: "loaded";
      decision: DecisionCitationMetadata;
      /** Null when the decision has no parsed text to number paragraphs in. */
      blocks: readonly Block[] | null;
    };

/** A cited decision's read, parsed once for every citation into it. */
export const citedDecisionRead = (
  view: QueryView<PublicCaseLawDecision, unknown>,
): CitedDecisionRead => {
  switch (view.type) {
    case "pending":
      return { type: "pending" };
    case "error":
    case "empty":
      return { type: "unavailable" };
    case "items":
      return {
        type: "loaded",
        decision: decisionCitationMetadata(view.items),
        blocks: parseDocumentAst(view.items.documentAst)?.blocks ?? null,
      };
    default:
      view satisfies never;
      return panic("Unhandled cited decision query state");
  }
};

/** What an answer's citation draws: the chip kind and what that chip needs. */
export type ReaderAnswerCitationTarget =
  | { type: "paragraph"; reference: ResolvedParagraphReference }
  | {
      type: "decision";
      decision: DecisionCitationMetadata;
      paragraphNumber: number | null;
    }
  | { type: "pending" }
  | { type: "unresolved" };

type ResolveReaderAnswerCitationOptions = {
  citation: ReaderAnswerCitation;
  /** The decision being read, whose text is loaded. */
  decisionId: string;
  blocks: readonly Block[];
  formatNumber: (value: number) => string;
  readCitedDecision: (
    decisionId: ReaderAnswerCitation["decisionId"],
  ) => CitedDecisionRead;
};

/**
 * A paragraph of the decision being read previews from its loaded text; a
 * paragraph of another decision is cited as that decision, opened at the
 * paragraph. A paragraph the open text lacks resolves to nothing, as does a
 * decision whose read failed (the reader reports that failure itself).
 */
export const resolveReaderAnswerCitation = ({
  citation,
  decisionId,
  blocks,
  formatNumber,
  readCitedDecision,
}: ResolveReaderAnswerCitationOptions): ReaderAnswerCitationTarget => {
  if (citation.decisionId === decisionId) {
    const reference = resolveParagraphReference({
      blocks,
      formatNumber,
      range: {
        startAnchorId: citation.paragraphId,
        endAnchorId: citation.paragraphId,
      },
    });
    return reference === null
      ? { type: "unresolved" }
      : { type: "paragraph", reference };
  }
  const read = readCitedDecision(citation.decisionId);
  switch (read.type) {
    case "pending":
      return { type: "pending" };
    case "unavailable":
      return { type: "unresolved" };
    case "loaded": {
      const block = read.blocks?.find(
        ({ anchorId }) => anchorId === citation.paragraphId,
      );
      return {
        type: "decision",
        decision: {
          ...read.decision,
          // Native navigation follows the href, so the paragraph lives in it.
          readerUrl: `${read.decision.readerUrl}#${encodeURIComponent(citation.paragraphId)}`,
        },
        paragraphNumber:
          block?.type === "paragraph" ? (block.number ?? null) : null,
      };
    }
    default:
      read satisfies never;
      return panic("Unhandled cited decision read");
  }
};
