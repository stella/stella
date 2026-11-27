/**
 * The parsers' last step: the court's paragraph numbers moved into structure
 * by `extractCourtParagraphNumbers`, with local irregularities reported for
 * an operator to sweep.
 */

import { extractCourtParagraphNumbers } from "@stll/legal-ast/court-paragraph-numbers";
import type { Block } from "@stll/legal-ast/document-ast";

// parser-output-unchanged: delegates logging through the host-registered parser logger sink.
import { getParserLogger } from "./parser-logger";
import type { ValidationSubject } from "./validate-ast";

/**
 * Report source-label anomalies without discarding the surrounding labels.
 */
const PARAGRAPH_NUMBERING_EVIDENCE =
  "case_law.ingestion.paragraph_numbering_evidence";

export const courtParagraphNumbers = (
  blocks: readonly Block[],
  subject: ValidationSubject,
): Block[] => {
  const numbering = extractCourtParagraphNumbers(blocks);
  if (numbering.type === "numbered" && numbering.evidence.length > 0) {
    getParserLogger()?.warn(PARAGRAPH_NUMBERING_EVIDENCE, {
      parser: subject.parser,
      caseNumber: subject.caseNumber,
      ...(subject.url === undefined ? {} : { url: subject.url }),
      evidence: numbering.evidence,
    });
  }
  return numbering.blocks;
};
