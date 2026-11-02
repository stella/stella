import { decisionReaderTextPieces } from "@stll/decision-reader/reader-text-pieces.logic";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import type { ReaderTextPiece } from "@stll/legal-ast/reader-text-quote";

import { readerTextFields } from "@/api/handlers/case-law/decisions/read-response";
import { readDecisionTextMetadata } from "@/api/lib/case-law/decision-text";

/**
 * The runs of text the decision reader draws marks in, built from the same
 * inputs the read route hands that reader: the publisher text fields as it
 * projects them, the document's AST, and the plain text where the AST has
 * nothing to show. The reader's own projection builds the runs, so a mark
 * the reader draws is one an agent's listing places, and a mark the reader
 * cannot draw is one the listing reports as orphaned.
 */
export const decisionAnnotationTextPieces = ({
  ast,
  caseNumberType,
  fulltext,
  metadata,
}: {
  ast: DocumentAst | null;
  caseNumberType: DecisionPrimaryReferenceType;
  fulltext: string | null;
  metadata: Record<string, unknown> | null;
}): ReaderTextPiece[] =>
  decisionReaderTextPieces({
    caseNumberType,
    documentAst: ast,
    fulltext,
    textFields: readerTextFields(readDecisionTextMetadata(metadata).textFields),
  });
