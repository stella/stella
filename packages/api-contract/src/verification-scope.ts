/**
 * Why a verification limited to a paragraph range is refused when it is
 * started: a paragraph at either end of the range is not in the document,
 * the range holds no text, the document's paragraph numbers do not read as
 * one numbering (so counting by position would name other paragraphs), or
 * the document has no text to find paragraphs in (a scan without a text
 * layer). A refused range never falls back to checking the whole document.
 */
export const VERIFICATION_SCOPE_REFUSALS = {
  paragraphsNotFound: "verification_paragraphs_not_found",
  paragraphsEmpty: "verification_paragraphs_empty",
  numberingUnclear: "verification_numbering_unclear",
  noText: "verification_document_no_text",
} as const;

export type VerificationScopeRefusal =
  (typeof VERIFICATION_SCOPE_REFUSALS)[keyof typeof VERIFICATION_SCOPE_REFUSALS];

const REFUSAL_CODES: ReadonlySet<string> = new Set(
  Object.values(VERIFICATION_SCOPE_REFUSALS),
);

export const isVerificationScopeRefusal = (
  code: unknown,
): code is VerificationScopeRefusal =>
  typeof code === "string" && REFUSAL_CODES.has(code);
