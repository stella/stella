import { prepareCorpusAst } from "@/api/lib/legal-search/corpus-ast";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
// parser-output-unchanged: the existing canonical corpus payload moves unchanged into a pure owner.
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";

export const decisionSections = (result: IngestionResult): DecisionSection[] =>
  result.sections ?? (result.fulltext ? segmentDecision(result.fulltext) : []);

/**
 * The canonical payload a result stores, in the shape the content hash is
 * taken over. Exported so a caller comparing a re-parse against what is
 * already stored asks the same question the corpus write does.
 */
export const caseLawCanonicalPayload = (
  result: IngestionResult,
): CorpusPayload => {
  const sections = decisionSections(result);
  return {
    ast: prepareCorpusAst({
      ast: result.documentAst,
      parserVersion: result.parserVersion,
    }).ast,
    sections: sections.length > 0 ? sections : null,
    text: result.fulltext ?? null,
  };
};
