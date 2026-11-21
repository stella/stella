// parser-output-unchanged: [pl-kis] the shared PDF reader moved out of this file to pdf-bands.ts unchanged for the default reading pl-kis calls; this file keeps only the Supreme Court decision parser.
// parser-output-unchanged: [cz-nss] the shared PDF reader moved out of this file to pdf-bands.ts unchanged for the default reading the NSS document reader calls; this file keeps only the Supreme Court decision parser.
// parser-output-unchanged: [pl-sn] the decision reader is the one that was in this file; the PDF reader it calls moved unchanged to pdf-bands.ts.
/**
 * Polish Supreme Court (Sąd Najwyższy) document reader.
 *
 * sn.pl serves each decision as a PDF with a real text layer, and nothing
 * richer: the portal's own "HTML version" is the same PDF re-rendered as
 * absolutely positioned one-line divs, so it carries no structure the text
 * layer does not already state.
 *
 * What the text layer does state is the publisher's own typesetting: a
 * paragraph's first line is indented past the body margin, paragraphs are
 * separated by empty lines, and the thesis, the docket and the section
 * markers are set in bold. The shared PDF reader (`pdf-bands.ts`) reads
 * those signals, the court's running header included, back into the markup
 * the Polish parser already reads, and `parsePlDecisionContent` does the
 * rest. There is one Polish decision parser, and this is not a second one.
 */

// parser-output-unchanged: imports the document AST from its package owner
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  assemblePdfParagraphs,
  extractPdfLines,
  PDF_PARAGRAPH_START,
  pdfParagraphsToHtml,
} from "@/api/handlers/case-law/ingestion/parsers/pdf-bands";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_SN_SOURCE_SYSTEM = "sn.pl";

type ParsePlSnDecisionInput = {
  pdfBytes: Uint8Array;
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  documentUrl: string | undefined;
  documentId: string;
};

type ParsePlSnDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

export const parsePlSnDecisionPdf = async (
  input: ParsePlSnDecisionInput,
): Promise<ParsePlSnDecisionOutput> => {
  const lines = await extractPdfLines(
    input.pdfBytes,
    PDF_PARAGRAPH_START.INDENT,
    {
      supremeCourt: { docket: input.caseNumber },
    },
  );
  const paragraphs = assemblePdfParagraphs(lines);
  return parsePlDecisionContent({
    caseNumber: input.caseNumber,
    // Poland issues no ECLI, so no Polish decision carries one.
    ecli: undefined,
    court: input.court,
    decisionDate: input.decisionDate,
    decisionType: input.decisionType,
    sourceUrl: input.sourceUrl,
    documentUrl: input.documentUrl,
    content: pdfParagraphsToHtml(paragraphs),
    superscripts: true,
    footnoteIds: lines.flatMap((line) =>
      line.type === "text" && line.footnote !== undefined
        ? [line.footnote.noteId]
        : [],
    ),
    // sn.pl indexes neither, so there is nothing to carry onto the AST.
    keywords: [],
    statutes: [],
    documentId: input.documentId,
    sourceSystem: PL_SN_SOURCE_SYSTEM,
  });
};
