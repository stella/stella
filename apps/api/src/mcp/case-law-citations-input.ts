import * as v from "valibot";

import {
  CITATION_READ_DIRECTIONS,
  CITATION_TREATMENTS,
} from "@/api/lib/case-law/citation-vocabulary";
import { DOCTRINAL_TREATMENTS } from "@/api/lib/case-law/doctrine";
import { LIMITS } from "@/api/lib/limits";

import { cursorInput, nullAsAbsent, uuidInputSchema } from "./input-schemas";

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
