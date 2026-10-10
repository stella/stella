import { panic } from "better-result";

// parser-output-unchanged: Publication provenance and its schema checks affect metadata only, not canonical document payloads.
// parser-output-unchanged: Publisher field absence markers widen the accepted absence fields; adapters that emit none produce the same output.
// parser-output-unchanged: The decision text-source constant names read-time passage selection; no parser emits it.

/** Canonical text used to page and locate a decision's passages. */
export const DECISION_TEXT_SOURCE = {
  AST: "ast",
  FULLTEXT: "fulltext",
} as const;

export const TEXT_FIELD_TYPE = {
  ABSENT: "absent",
  PRESENT: "present",
} as const;

export const DECISION_TEXT_WITHHELD_REASON = {
  SOURCE_LICENCE: "source_licence",
} as const;

export type DecisionTextWithheldReason =
  (typeof DECISION_TEXT_WITHHELD_REASON)[keyof typeof DECISION_TEXT_WITHHELD_REASON];

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
 * A row's publisher summary as the cell draws it: the sentence with the
 * publisher's own breaks, the terms as one line, and empty where they
 * supplied none. A find reads this one, because it may only keep a row whose
 * match the reader can then see marked in the cell.
 */
export const decisionHeadnoteText = (
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

/**
 * The same summary where only one line will do: a prompt that grounds a
 * suggestion gives the model one decision per line, and a break inside one
 * would read as the next decision. Derived from the reading above rather than
 * written beside it.
 */
export const decisionHeadnoteLine = (
  headnote: DecisionHeadnotePreview,
): string => decisionHeadnoteText(headnote).replaceAll("\n", " ");

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
export const DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY =
  "_stellaDecisionTextAbsenceVersion";
export const DECISION_TEXT_ABSENCE_SCHEMA_VERSION = 2;

export const DECISION_PUBLICATION_FIELD_KEYS = Object.freeze([
  "ecli",
  "decisionDate",
  "decisionType",
  "sourceUrl",
  "documentUrl",
] as const);

export type DecisionPublicationFieldKey =
  (typeof DECISION_PUBLICATION_FIELD_KEYS)[number];

export const DECISION_ABSENCE_FIELD_KEYS = Object.freeze([
  ...DECISION_TEXT_FIELD_KEYS,
  ...DECISION_PUBLICATION_FIELD_KEYS,
]);

export const SK_US_ECLI_AVAILABILITY_STATUSES = [
  "published",
  "not_published",
  "not_stated",
] as const;

export type SkUsEcliAvailability = {
  status: (typeof SK_US_ECLI_AVAILABILITY_STATUSES)[number];
};

export const SK_COURTS_SOURCE_URL_STATUSES = [
  "published",
  "not-published-by-source",
  "rejected-url",
  "detail-unavailable",
] as const;

export type SkCourtsSourceUrlStatus =
  (typeof SK_COURTS_SOURCE_URL_STATUSES)[number];

/** Stored beside nullable publisher fields; each marker carries its reason. */
export type DecisionTextAbsenceEntry = {
  readonly field: DecisionTextFieldKey | DecisionPublicationFieldKey;
  readonly reason: TextAbsenceReason;
};

export const DECISION_TEXT_METADATA_KEYS = Object.freeze([
  ...DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
]);

export type ReadDecisionTextFields = Readonly<
  Record<DecisionTextFieldKey, TextField>
>;

const isDecisionTextAbsenceEntry = (
  input: unknown,
): input is { readonly field: string; readonly reason: TextAbsenceReason } =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  Object.keys(input).length === 2 &&
  Object.hasOwn(input, "field") &&
  Object.hasOwn(input, "reason") &&
  "field" in input &&
  "reason" in input &&
  typeof input.field === "string" &&
  TEXT_ABSENCE_REASONS.some((reason) => reason === input.reason);

export type DecisionTextAbsenceParseResult =
  | { readonly type: "invalid" }
  | {
      readonly type: "valid";
      readonly entries: readonly DecisionTextAbsenceEntry[];
    };

export const parseDecisionTextAbsence = (
  value: unknown,
): DecisionTextAbsenceParseResult => {
  if (value === undefined) {
    return { type: "valid", entries: [] };
  }
  if (!Array.isArray(value)) {
    return { type: "invalid" };
  }
  const entries: DecisionTextAbsenceEntry[] = [];
  const seenFields = new Set<string>();
  for (const entry of value) {
    if (!isDecisionTextAbsenceEntry(entry) || seenFields.has(entry.field)) {
      return { type: "invalid" };
    }
    seenFields.add(entry.field);
    const field = DECISION_ABSENCE_FIELD_KEYS.find(
      (candidate) => candidate === entry.field,
    );
    if (field === undefined) {
      continue;
    }
    entries.push({ field, reason: entry.reason });
  }
  return { type: "valid", entries };
};

export type DecisionTextAbsenceInspection =
  | { readonly type: "legacy" }
  | {
      readonly type: "current";
      readonly missingFields: readonly DecisionTextFieldKey[];
    }
  | { readonly type: "invalid"; readonly reason: "schema_version" | "sidecar" };

/** Missing reasons are defects only for writes that promised explicit absence. */
export const inspectDecisionTextAbsence = (
  metadata: Readonly<Record<string, unknown>> | null,
): DecisionTextAbsenceInspection => {
  const version = metadata?.[DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY];
  if (
    version !== undefined &&
    version !== DECISION_TEXT_ABSENCE_SCHEMA_VERSION
  ) {
    return { type: "invalid", reason: "schema_version" };
  }
  const absence = parseDecisionTextAbsence(
    metadata?.[DECISION_TEXT_ABSENCE_METADATA_KEY],
  );
  if (absence.type === "invalid") {
    return { type: "invalid", reason: "sidecar" };
  }
  if (version === undefined) {
    return { type: "legacy" };
  }
  return {
    type: "current",
    missingFields: DECISION_TEXT_FIELD_KEYS.filter(
      (field) =>
        (metadata?.[field] === null || metadata?.[field] === undefined) &&
        !absence.entries.some((entry) => entry.field === field),
    ),
  };
};
