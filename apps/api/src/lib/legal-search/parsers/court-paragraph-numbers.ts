/**
 * The parsers' last step: the court's paragraph numbers moved into structure
 * by `extractCourtParagraphNumbers`, with a numbering that was present but
 * implausible reported for an operator to sweep.
 */

import { extractCourtParagraphNumbers } from "@stll/legal-ast/court-paragraph-numbers";
import type { Block } from "@stll/legal-ast/document-ast";

import type { ValidationSubject } from "@/api/lib/legal-search/parsers/validate-ast";
import { logger } from "@/api/lib/observability/logger";

/**
 * Log event emitted when a decision's paragraphs open with markers that do
 * not read as numbering. Reported at WARN: the text is whole and the markers
 * stay in it, but `#par=` links and the reader's gutter have no numbers for
 * this decision.
 */
const PARAGRAPH_NUMBERING_REJECTED =
  "case_law.ingestion.paragraph_numbering_rejected";

export const courtParagraphNumbers = (
  blocks: readonly Block[],
  subject: ValidationSubject,
): Block[] => {
  const numbering = extractCourtParagraphNumbers(blocks);
  if (numbering.type === "rejected") {
    logger.warn(PARAGRAPH_NUMBERING_REJECTED, {
      parser: subject.parser,
      caseNumber: subject.caseNumber,
      ...(subject.url === undefined ? {} : { url: subject.url }),
      defect: numbering.defect,
      detail: numbering.detail,
    });
  }
  return numbering.blocks;
};
