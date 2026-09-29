/**
 * What a stored legislation version is, and whether its publisher window can
 * answer a point-in-time read. One declaration for the database CHECKs, the
 * writer and every reader, so a value added here fails each consumer that has
 * not decided what to do with it.
 */

/** The kind of text a stored version holds. */
export const LEGISLATION_EXPRESSION_KINDS = [
  /** A consolidated wording with a validity window. */
  "consolidation",
  /** The text as first published, next to the consolidations. */
  "promulgated",
  /** A work the publisher keeps as one text with no version history. */
  "unversioned",
] as const;

export type LegislationExpressionKind =
  (typeof LEGISLATION_EXPRESSION_KINDS)[number];

/**
 * Whether the publisher's window places the version in time. `withdrawn` is a
 * tombstone: a version the publisher no longer lists keeps its row and id, is
 * never read as in force, and is restored in place if it is listed again.
 */
export const LEGISLATION_WINDOW_DISPOSITIONS = [
  "effective",
  "never-in-force",
  "invalid-window",
  "withdrawn",
] as const;

export type LegislationWindowDisposition =
  (typeof LEGISLATION_WINDOW_DISPOSITIONS)[number];

/**
 * Why a version that is not effective carries its disposition. An effective
 * version carries no basis: its window is the publisher's, never inferred.
 */
export const LEGISLATION_WINDOW_DISPOSITION_BASES = {
  "never-in-force": ["publisher-flag", "replaced-same-day"],
  "invalid-window": ["zero-length-window", "reversed", "missing-start"],
  withdrawn: [
    "publisher-unlisted",
    "listed-not-stored",
    "deferred-promulgated",
  ],
} as const satisfies Record<
  Exclude<LegislationWindowDisposition, "effective">,
  readonly string[]
>;

export type LegislationWindowDispositionBasis =
  (typeof LEGISLATION_WINDOW_DISPOSITION_BASES)[keyof typeof LEGISLATION_WINDOW_DISPOSITION_BASES][number];

/**
 * Whether each kind's window can answer "which text applied then". Total over
 * the kinds, so a kind added above fails to compile here until someone
 * decides. A promulgated text sits next to the consolidation that opens the
 * same day and never answers for it.
 */
export const LEGISLATION_EXPRESSION_KIND_APPLIES = {
  consolidation: true,
  promulgated: false,
  unversioned: true,
} as const satisfies Record<LegislationExpressionKind, boolean>;

/** The kinds decided applicable above, in declaration order. */
export const LEGISLATION_APPLICABLE_EXPRESSION_KINDS: readonly LegislationExpressionKind[] =
  LEGISLATION_EXPRESSION_KINDS.filter(
    (kind) => LEGISLATION_EXPRESSION_KIND_APPLIES[kind],
  );

/** The one disposition whose window can answer a point-in-time read. */
export const LEGISLATION_APPLICABLE_WINDOW_DISPOSITION =
  "effective" as const satisfies LegislationWindowDisposition;

/** The fields a version carries that decide whether it can apply at all. */
export type LegislationExpressionEligibility = {
  expressionKind: LegislationExpressionKind;
  windowDisposition: LegislationWindowDisposition;
};

/**
 * Whether a version can ever answer a point-in-time read: an effective window
 * of an applicable kind. Every applicability decision starts here; its SQL
 * twin in the API is built from the same declarations, so a date can never
 * be matched against a version this says cannot apply.
 */
export const isEligibleLegislationExpression = ({
  expressionKind,
  windowDisposition,
}: LegislationExpressionEligibility): boolean =>
  windowDisposition === LEGISLATION_APPLICABLE_WINDOW_DISPOSITION &&
  LEGISLATION_APPLICABLE_EXPRESSION_KINDS.includes(expressionKind);

/**
 * Why a point-in-time read has no answer although the Work exists and a
 * version of it opened by the date: that version's publisher window is
 * inconsistent (reversed, zero-length or without a start), so no text can be
 * said to apply. Distinct from a date the corpus simply does not cover.
 */
export const LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT =
  "publisher-data-inconsistent" as const;

/** The machine-readable code an HTTP read answers the gap with. */
export const LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE =
  "publisher_window_inconsistent" as const;

/** What every surface says about the gap, word for word. */
export const LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE =
  "No in-force reading for this date: publisher data inconsistent";

/** One version whose inconsistent window leaves a date without an answer. */
export type LegislationInconsistentVersion = {
  id: string;
  language: string;
  /** The stored window, as the publisher stated it (half-open). */
  versionValidFrom: string | null;
  versionValidTo: string | null;
  basis: LegislationWindowDispositionBasis | null;
};
