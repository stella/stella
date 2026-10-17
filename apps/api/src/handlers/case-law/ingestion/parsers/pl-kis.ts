/**
 * Polish tax interpretations and rulings (EUREKA) document reader.
 *
 * The service states each document as HTML exported from a word processor,
 * and a PDF rendition of the same text for the documents whose HTML field is
 * empty. Both are read into the markup the Polish decision parser reads, so
 * there is one Polish parser and this is not a second one.
 */

import type { DecisionDocumentAst } from "@stll/legal-ast/document-ast";

import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  assemblePdfParagraphs,
  extractPdfParagraphLines,
  pdfParagraphsToHtml,
} from "@/api/lib/legal-search/parsers/pdf-paragraphs";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_KIS_SOURCE_SYSTEM = "eureka.mf.gov.pl";

export type ParsePlKisDocumentInput = {
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string;
  documentUrl: string;
  documentId: string;
  keywords: string[];
  statutes: string[];
};

export type ParsePlKisDocumentOutput = {
  documentAst: DecisionDocumentAst;
  fulltext: string;
};

const parseContent = (
  input: ParsePlKisDocumentInput,
  content: string,
): ParsePlKisDocumentOutput =>
  parsePlDecisionContent({
    caseNumber: input.caseNumber,
    // Poland issues no ECLI, and a tax authority's document carries none.
    ecli: undefined,
    court: input.court,
    decisionDate: input.decisionDate,
    decisionType: input.decisionType,
    sourceUrl: input.sourceUrl,
    documentUrl: input.documentUrl,
    content,
    keywords: input.keywords,
    statutes: input.statutes,
    documentId: input.documentId,
    sourceSystem: PL_KIS_SOURCE_SYSTEM,
  });

/** The document's own HTML field. */
export const parsePlKisDocumentHtml = (
  input: ParsePlKisDocumentInput & { html: string },
): ParsePlKisDocumentOutput => parseContent(input, input.html);

/** The PDF rendition, for a document whose HTML field is empty. */
export const parsePlKisDocumentPdf = async (
  input: ParsePlKisDocumentInput & { pdfBytes: Uint8Array },
): Promise<ParsePlKisDocumentOutput> =>
  parseContent(
    input,
    pdfParagraphsToHtml(
      assemblePdfParagraphs(await extractPdfParagraphLines(input.pdfBytes)),
    ),
  );
