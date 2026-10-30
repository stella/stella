import * as v from "valibot";

import { DOCTRINAL_TREATMENTS } from "@stll/api-contract/case-law-doctrine";
import { DECISION_TEXT_WITHHELD_REASON } from "@stll/api-contract/case-law-text-field";
import { CITATION_PASSAGE_MENTIONS } from "@stll/legal-ast/citation-passage";

import {
  CITATION_READ_DIRECTIONS,
  CITATION_TREATMENTS,
} from "../case-law/citation-vocabulary";
import { caseNumberTypeProjection } from "./case-law-result-projections";
import { contentText, passthroughId, publicUrl } from "./projection-fields";

/**
 * read_case_law_citations. Source of truth: `handleReadCaseLawCitationsTool`
 * (`stella-tools.ts`) mapping `readGatedDecisionCitations`. All ids are public
 * case-law corpus ids (citation, decision). `passage` is publisher decision
 * text, withheld where the source bars derived AI use.
 */
export const READ_CASE_LAW_CITATIONS_PROJECTION = v.strictObject({
  doctrineAvailability: v.picklist(["available", "unavailable"]),
  doctrine: v.optional(
    v.picklist(DOCTRINAL_TREATMENTS.filter((value) => value !== "not_stated")),
  ),
  polarity: v.optional(v.picklist(CITATION_TREATMENTS)),
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
      doctrine: v.nullable(v.picklist([...DOCTRINAL_TREATMENTS, "unread"])),
      // Null for a citation the corpus holds no decision for.
      decision: v.nullable(
        v.strictObject({
          // Nullable for the same reason as search_case_law's `url`.
          url: v.nullable(publicUrl()),
          source_url: v.optional(publicUrl()),
          caseNumber: v.string(),
          caseNumberType: caseNumberTypeProjection,
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
          text: contentText(),
          truncated: v.boolean(),
          mention: v.picklist(CITATION_PASSAGE_MENTIONS),
          evidenceQuote: v.optional(v.string()),
          evidenceAnchorId: v.optional(v.nullable(passthroughId())),
        }),
      ),
    }),
  ),
});
