import * as v from "valibot";

import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";
import { CITATION_PASSAGE_MENTIONS } from "@stll/legal-ast/citation-passage";

import {
  CITATION_READ_DIRECTIONS,
  CITATION_TREATMENTS,
} from "../case-law/citation-vocabulary";
import { caseNumberTypeProjection } from "./case-law-result-projections";
import { passthroughId, publicUrl } from "./projection-fields";

/**
 * read_case_law_citations. Source of truth: `handleReadCaseLawCitationsTool`
 * (`stella-tools.ts`) mapping `readGatedDecisionCitations`. All ids are public
 * case-law corpus ids (citation, decision). `passage` is publisher decision
 * text, withheld where the source bars derived AI use.
 */
export const READ_CASE_LAW_CITATIONS_PROJECTION = v.strictObject({
  // The decision the citations were read from, echoed so a paged reply still
  // says what it is about.
  decisionId: passthroughId(),
  direction: v.picklist(CITATION_READ_DIRECTIONS),
  // Opaque citation-id cursor, base64url-encoded.
  nextCursor: v.nullable(passthroughId()),
  citations: v.array(
    v.strictObject({
      citationId: passthroughId(),
      citationText: v.nullable(v.string()),
      textWithheldReason: v.nullable(
        v.literal(DECISION_TEXT_WITHHELD_REASON.SOURCE_LICENCE),
      ),
      // The classified reading, or `unclassified` where there is none: a row
      // the classifier never reached and one it could not answer for are both
      // the absence of a reading, never a neutral one.
      polarity: v.picklist(CITATION_TREATMENTS),
      // Null for a citation the corpus holds no decision for.
      decision: v.nullable(
        v.strictObject({
          // Nullable for the same reason as search_case_law's `appUrl`.
          appUrl: v.nullable(v.string()),
          url: v.nullable(publicUrl()),
          source_url: v.optional(publicUrl()),
          caseNumber: v.string(),
          caseNumberType: v.optional(caseNumberTypeProjection),
          citationAuthority: v.number(),
          court: v.string(),
          decisionDate: v.nullable(v.string()),
          decisionId: passthroughId(),
          decisionType: v.nullable(v.string()),
          resourceName: passthroughId(),
        }),
      ),
      // An excerpt of the citing paragraph, by AST anchor. Null where none is
      // available. `truncated` says the block was longer than the excerpt;
      // `mention` says whether the document left a choice of paragraph, in
      // which case `polarity` may have been read from another one.
      passage: v.nullable(
        v.strictObject({
          anchorId: passthroughId(),
          text: v.string(),
          truncated: v.boolean(),
          mention: v.picklist(CITATION_PASSAGE_MENTIONS),
        }),
      ),
    }),
  ),
});
