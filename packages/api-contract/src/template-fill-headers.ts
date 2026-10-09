import * as v from "valibot";

import { DECISION_UNDECIDED_REASONS } from "./ai-decision-provider";

/** Download responses carry only a count; JSON results and receipts retain diagnostics. */
export const CLAUSE_WARNINGS_HEADER = "X-Clause-Warnings";
export const clauseWarningCountHeaderSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d{0,9})$/u),
  v.transform(Number),
);

/** AI-decided conditions a fill left undecided, as URI-encoded JSON. */
export const UNDECIDED_CONDITIONS_HEADER = "X-Undecided-Conditions";

export const undecidedConditionsHeaderSchema = v.array(
  v.object({
    path: v.pipe(v.string(), v.nonEmpty()),
    label: v.string(),
    reason: v.picklist(DECISION_UNDECIDED_REASONS),
  }),
);
