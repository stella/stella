/**
 * The parsers' last step: the court's paragraph numbers moved into structure
 * by `extractCourtParagraphNumbers`, with local irregularities reported for
 * an operator to sweep.
 */

import { extractCourtParagraphNumbers } from "@stll/legal-ast/court-paragraph-numbers";
import type { Block } from "@stll/legal-ast/document-ast";

import type { ValidationSubject } from "@/api/lib/legal-search/parsers/validate-ast";
import type { LeadingMarkerSourceKey } from "@/api/lib/legal-search/processed-field-inventory";
import { logger } from "@/api/lib/observability/logger";

/**
 * Report source-label anomalies without discarding the surrounding labels.
 */
const PARAGRAPH_NUMBERING_EVIDENCE =
  "case_law.ingestion.paragraph_numbering_evidence";

/**
 * The parser's subject, named by a source whose declared reader is the
 * leading marker (`COURT_PARAGRAPH_NUMBERING_CONVENTIONS`): a parser of a
 * source declared otherwise cannot call this without changing its
 * declaration, and the conformance suite holds the declaration to its
 * recordings.
 */
export type LeadingMarkerSubject = Omit<ValidationSubject, "parser"> & {
  readonly parser: LeadingMarkerSourceKey;
};

export const courtParagraphNumbers = (
  blocks: readonly Block[],
  subject: LeadingMarkerSubject,
): Block[] => {
  const numbering = extractCourtParagraphNumbers(blocks);
  if (numbering.type === "numbered" && numbering.evidence.length > 0) {
    logger.warn(PARAGRAPH_NUMBERING_EVIDENCE, {
      parser: subject.parser,
      caseNumber: subject.caseNumber,
      ...(subject.url === undefined ? {} : { url: subject.url }),
      evidence: numbering.evidence,
    });
  }
  return numbering.blocks;
};
