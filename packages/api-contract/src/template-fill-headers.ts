import * as v from "valibot";

/** Download responses carry only a count; JSON results and receipts retain diagnostics. */
export const CLAUSE_WARNINGS_HEADER = "X-Clause-Warnings";
export const clauseWarningCountHeaderSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d{0,9})$/u),
  v.transform(Number),
);
