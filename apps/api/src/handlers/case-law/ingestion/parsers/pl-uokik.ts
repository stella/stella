/**
 * Polish competition and consumer protection authority (Prezes UOKiK)
 * document reader.
 *
 * decyzje.uokik.gov.pl files each decision as a PDF attachment and nothing
 * richer: the register's own page for a decision is a table of its metadata
 * with a link to the file. The text layer is read the way the Supreme Court's
 * PDFs are (indent and blank lines for paragraphs, the font for bold), into
 * the markup the Polish decision parser reads, so there is one Polish parser
 * and this is not a second one.
 */

import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  assemblePlSnParagraphs,
  extractPlSnLines,
  PL_PDF_PARAGRAPH_START,
  plSnParagraphsToHtml,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnLine } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const PL_UOKIK_SOURCE_SYSTEM = "decyzje.uokik.gov.pl";

export type ParsePlUokikDocumentInput = {
  /** Every decision file the record attaches, in the order it lists them. */
  pdfs: readonly Uint8Array[];
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string;
  sourceUrl: string;
  documentUrl: string | undefined;
  documentId: string;
  keywords: string[];
};

export type ParsePlUokikDocumentOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

/**
 * The lines of every file, one after the other. A blank line between two
 * files ends the last paragraph of the first, so no paragraph spans them.
 */
export const plUokikDocumentLines = async (
  pdfs: readonly Uint8Array[],
): Promise<PlSnLine[]> => {
  const lines: PlSnLine[] = [];
  for (const pdf of pdfs) {
    if (lines.length > 0) {
      lines.push({ type: "blank" });
    }
    // The office numbers its paragraphs with a hanging indent.
    lines.push(
      ...(await extractPlSnLines(
        pdf,
        PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
      )),
    );
  }
  return lines;
};

/**
 * The decision's document, or null where its files hold no text layer: a
 * scan states nothing to read, and a document of no paragraphs is not one.
 */
export const parsePlUokikDocument = async (
  input: ParsePlUokikDocumentInput,
): Promise<ParsePlUokikDocumentOutput | null> => {
  const paragraphs = assemblePlSnParagraphs(
    await plUokikDocumentLines(input.pdfs),
  );
  if (paragraphs.length === 0) {
    return null;
  }
  return parsePlDecisionContent({
    caseNumber: input.caseNumber,
    // Poland issues no ECLI, and an authority's decision carries none.
    ecli: undefined,
    court: input.court,
    decisionDate: input.decisionDate,
    decisionType: input.decisionType,
    sourceUrl: input.sourceUrl,
    documentUrl: input.documentUrl ?? "",
    content: plSnParagraphsToHtml(paragraphs),
    keywords: input.keywords,
    statutes: [],
    documentId: input.documentId,
    sourceSystem: PL_UOKIK_SOURCE_SYSTEM,
  });
};
