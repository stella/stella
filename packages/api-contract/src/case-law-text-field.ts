export const TEXT_FIELD_TYPE = {
  ABSENT: "absent",
  PRESENT: "present",
} as const;

export const TEXT_ABSENCE_REASONS = [
  "not_published",
  "parse_failed",
  "publisher_placeholder",
  "redistribution_withheld",
] as const;

export type TextAbsenceReason = (typeof TEXT_ABSENCE_REASONS)[number];

export const TEXT_ABSENCE_REASON = {
  NOT_PUBLISHED: "not_published",
  PARSE_FAILED: "parse_failed",
  PUBLISHER_PLACEHOLDER: "publisher_placeholder",
  REDISTRIBUTION_WITHHELD: "redistribution_withheld",
} as const satisfies Record<Uppercase<TextAbsenceReason>, TextAbsenceReason>;

export type TextField =
  | {
      readonly type: typeof TEXT_FIELD_TYPE.PRESENT;
      readonly text: string;
    }
  | {
      readonly type: typeof TEXT_FIELD_TYPE.ABSENT;
      readonly reason: TextAbsenceReason;
    };

export const DECISION_HEADNOTE_TRUNCATION_MARK = "…";

/**
 * A bounded publisher-summary preview returned for a public decision row.
 * Truncated text retains its terminal mark for clients that do not yet read
 * the explicit flag.
 */
export type DecisionHeadnotePreview =
  | Extract<TextField, { readonly type: typeof TEXT_FIELD_TYPE.ABSENT }>
  | (Extract<TextField, { readonly type: typeof TEXT_FIELD_TYPE.PRESENT }> & {
      readonly truncated: boolean;
    });

export const DECISION_TEXT_FIELD = {
  ABSTRACT: "abstract",
  HEADNOTE: "headnote",
  LEGAL_SENTENCE: "legalSentence",
  SUMMARY: "summary",
} as const;

export type DecisionTextFieldKey =
  (typeof DECISION_TEXT_FIELD)[keyof typeof DECISION_TEXT_FIELD];

export const DECISION_TEXT_FIELD_KEYS = Object.freeze(
  Object.values(DECISION_TEXT_FIELD),
);

export const DECISION_TEXT_ABSENCE_METADATA_KEY = "_stellaDecisionTextAbsence";

export const DECISION_TEXT_METADATA_KEYS = Object.freeze([
  ...DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_ABSENCE_METADATA_KEY,
]);

export type ReadDecisionTextFields = Readonly<
  Record<DecisionTextFieldKey, TextField>
>;
