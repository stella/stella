import * as v from "valibot";

import {
  CITATION_READ_DIRECTIONS,
  CITATION_TREATMENTS,
} from "@/api/lib/case-law/citation-vocabulary";
import { DOCTRINAL_TREATMENTS } from "@/api/lib/case-law/doctrine";
import type { ConstantMap } from "@/api/lib/constant-map";
import { LIMITS } from "@/api/lib/limits";

import { cursorInput, nullAsAbsent, uuidInputSchema } from "./input-schemas";

/**
 * How much of each citation a read returns: the whole row, or a compact one
 * whose passage is cut to a cue, for reading many citations in one reply.
 */
export const CITATION_READ_DETAILS = ["full", "compact"] as const;
type CitationReadDetail = (typeof CITATION_READ_DETAILS)[number];

export const CITATION_READ_DETAIL = {
  FULL: "full",
  COMPACT: "compact",
} as const satisfies ConstantMap<CitationReadDetail>;

// Shared by the tool definition and the citation graph app input contract,
// so the app contract loads no handlers.
export const readCaseLawCitationsArgsSchema = nullAsAbsent(
  v.strictObject({
    decision_id: uuidInputSchema("Case-law decision ID"),
    direction: v.pipe(
      v.picklist(CITATION_READ_DIRECTIONS),
      v.description(
        "Which side of the citation graph to read: 'cites' for the decisions this decision cites, 'cited_by' for the decisions that cite it. Citing is not agreeing: both sides carry negative treatments.",
      ),
    ),
    doctrine: v.optional(
      v.pipe(
        v.picklist(
          DOCTRINAL_TREATMENTS.filter((value) => value !== "not_stated"),
        ),
        v.description("Only citations with this reviewed doctrinal finding."),
      ),
    ),
    polarity: v.optional(
      v.pipe(
        v.picklist(CITATION_TREATMENTS),
        v.description("Only citations with this polarity reading."),
      ),
    ),
    detail: v.optional(
      v.pipe(
        v.picklist(CITATION_READ_DETAILS),
        v.description(
          `Defaults to 'full'. 'compact' cuts each passage to ${LIMITS.caseLawCitationCompactPassageChars} characters around the citation, without evidenceQuote.`,
        ),
      ),
    ),
    passage_query: v.optional(
      v.pipe(
        v.string(),
        v.minLength(LIMITS.mcpNonEmptyMin),
        v.maxLength(LIMITS.caseLawCitationPassageQueryChars),
        v.description(
          "Only citations whose citing paragraph holds every word, in any inflection. Filters page by page: `scannedCitations` is how many the page read; an empty page with `nextCursor` may still match later.",
        ),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(LIMITS.mcpPageSizeMin),
        v.maxValue(LIMITS.caseLawDecisionCitationPageSize),
        v.description(
          `Citations per page; defaults to ${LIMITS.caseLawAgentCitationPageSizeDefault}, at most ${LIMITS.caseLawDecisionCitationPageSize}.`,
        ),
      ),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous read_case_law_citations call to read the next page",
    }),
  }),
);
