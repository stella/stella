import { panic } from "better-result";

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
 * What a publisher filed a decision under, where they wrote no headnote: a
 * subject index or an area of law. Its own branch rather than one more string,
 * because a classification is a list of terms and a headnote is a sentence,
 * and a row that draws them the same way reads the tags as prose.
 */
export const DECISION_HEADNOTE_KEYWORDS = "keywords";

/**
 * A bounded publisher-summary preview returned for a public decision row.
 * Truncated text retains its terminal mark for clients that do not yet read
 * the explicit flag.
 */
export type DecisionHeadnotePreview =
  | Extract<TextField, { readonly type: typeof TEXT_FIELD_TYPE.ABSENT }>
  | (Extract<TextField, { readonly type: typeof TEXT_FIELD_TYPE.PRESENT }> & {
      readonly truncated: boolean;
    })
  | {
      readonly type: typeof DECISION_HEADNOTE_KEYWORDS;
      readonly items: readonly string[];
      /**
       * How many terms the publisher filed that the row's budget dropped. A
       * count rather than a flag, because a row that shows part of a filing
       * has to say how much of it is missing.
       */
      readonly omitted: number;
    };

/** How a classification reads where only one line of text will do. */
export const DECISION_KEYWORD_SEPARATOR = " · ";

/**
 * A row's publisher summary as one line, whichever kind it is, and empty
 * where the publisher supplied none. For the consumers that cannot draw terms
 * as terms — a find over a cell, a prompt grounding a suggestion — so that
 * what they read is never a kind poorer than what the row shows.
 */
export const decisionHeadnoteLine = (
  headnote: DecisionHeadnotePreview,
): string => {
  switch (headnote.type) {
    case TEXT_FIELD_TYPE.PRESENT:
      return headnote.text;
    case DECISION_HEADNOTE_KEYWORDS:
      return headnote.items.join(DECISION_KEYWORD_SEPARATOR);
    case TEXT_FIELD_TYPE.ABSENT:
      return "";
    default:
      headnote satisfies never;
      return panic(`Unhandled decision headnote: ${String(headnote)}`);
  }
};

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
