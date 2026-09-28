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
 * Why a version carries its disposition, by disposition. An effective version
 * normally carries no basis; `successor-derived-end` marks one whose end was
 * taken from the next version because the stated end could not be placed.
 */
export const LEGISLATION_WINDOW_DISPOSITION_BASES = {
  effective: ["successor-derived-end"],
  "never-in-force": ["publisher-flag", "replaced-same-day"],
  "invalid-window": ["zero-length-window", "reversed", "missing-start"],
  withdrawn: [
    "publisher-unlisted",
    "listed-not-stored",
    "deferred-promulgated",
  ],
} as const satisfies Record<LegislationWindowDisposition, readonly string[]>;

export type LegislationWindowDispositionBasis =
  (typeof LEGISLATION_WINDOW_DISPOSITION_BASES)[LegislationWindowDisposition][number];
