/**
 * A jurisdiction profile: what a citation reader needs to know about a legal
 * culture, as data.
 *
 * A profile declares the vocabulary (section terms, subdivision terms,
 * connectors, collections), the act tables (aliases and titles), and the
 * publisher's anchor scheme, so a reader that consumes it needs no branch on
 * a country: adding a jurisdiction is a profile plus fixtures.
 *
 * Lists are in no significant order. A consumer that matches spellings orders
 * them itself (longest first), so a profile may list its terms in whatever
 * order reads best.
 */

/** Which top-level unit a number names. Acts use one or the other, not both. */
export const SECTION_UNITS = ["section", "article"] as const;

export type SectionUnit = (typeof SECTION_UNITS)[number];

/**
 * Levels below the section, deepest last.
 *
 * `sentence` is recorded but never anchored: no publisher in scope gives a
 * sentence its own id, so a sentence anchor would be a link to nowhere. It is
 * still read, because dropping it would silently widen `§ 243c odst. 1 věty
 * první` into the whole subsection.
 */
export const SUBDIVISION_LEVELS = [
  "subsection",
  "letter",
  "point",
  "sentence",
] as const;

export type SubdivisionLevel = (typeof SUBDIVISION_LEVELS)[number];

/** The subdivision levels a publisher anchor scheme actually addresses. */
export const ANCHORED_SUBDIVISION_LEVELS = [
  "subsection",
  "letter",
  "point",
] as const satisfies readonly SubdivisionLevel[];

/**
 * Every level an anchor mapper has to render, derived from the two lists above
 * rather than restated, so a new level cannot land without an anchor decision.
 */
export type AnchorLevel =
  | SectionUnit
  | (typeof ANCHORED_SUBDIVISION_LEVELS)[number];

/** An act's identity in a national collection. */
export type WorkIdentifier = {
  number: number;
  year: number;
  /** The collection's canonical spelling: `Sb.`, `Z. z.`, `Zb.`, `Ú. l.`. */
  collection: string;
};

/** The jurisdictions this build can read. Corpus country codes (ISO alpha-3). */
export const PROVISION_CITATION_JURISDICTIONS = ["CZE", "SVK"] as const;

export type ProvisionCitationJurisdiction =
  (typeof PROVISION_CITATION_JURISDICTIONS)[number];

/** `§`, `§§`, `čl.`, `Art.` — what introduces a provision number. */
export type SectionTermSpec = {
  /** The literal spelling, as the source writes it. */
  text: string;
  unit: SectionUnit;
};

/** `odst.`, `písm.`, `bod`, `veta` — what introduces a value below the section. */
export type SubdivisionTermSpec = {
  text: string;
  level: SubdivisionLevel;
};

/** A national collection and every spelling a court uses for it. */
export type CollectionSpec = {
  /** The spelling stored in a work identifier. */
  canonical: string;
  /** Every spelling accepted in text, including the canonical one. */
  spellings: readonly string[];
};

/**
 * The citing dates an entry is the default reading for.
 *
 * A recodification reuses a title: `občanský zákoník` defaults to 40/1964 Sb.
 * in a decision dated before 2014 and to 89/2012 Sb. from then. A window is a
 * default, not proof of identity: a later decision may discuss the earlier
 * law, so a consumer lets a citation that names its act (number, year) take
 * precedence over it. Both bounds are half-open ISO dates; an entry without
 * bounds applies at any date. A consumer should not apply an entry to a
 * decision dated before the year its act was issued.
 */
export type CitedWindow = {
  citedFrom?: string;
  citedUntil?: string;
};

/**
 * The unit an act numbers its provisions by, `section` when an entry leaves
 * it out. A citation in the other unit (`§ 5 Listiny`) does not name it.
 */
type ActUnit = { unit?: SectionUnit };

/** An abbreviation that names one act. Matched case-sensitively. */
export type ActAliasSpec = CitedWindow &
  ActUnit & {
    spellings: readonly string[];
    identifier: WorkIdentifier;
  };

/** A title (or a declined form of one) that names one act. Case-insensitive. */
export type ActTitleSpec = CitedWindow &
  ActUnit & {
    spellings: readonly string[];
    identifier: WorkIdentifier;
  };

type SuccessionOptions = {
  spellings: readonly string[];
  older: WorkIdentifier;
  newer: WorkIdentifier;
  /** The day the newer act took effect. */
  on: string;
};

/**
 * A name two acts bore in turn: the older is the default reading until the
 * newer took effect, the newer from then. A citation that names its act
 * outright (`z roku 1965`, `č. 65/1965 Sb.`) identifies the older one after
 * the switch regardless.
 */
export const succession = ({
  newer,
  older,
  on,
  spellings,
}: SuccessionOptions): readonly ActTitleSpec[] => [
  { spellings, identifier: older, citedUntil: on },
  { spellings, identifier: newer, citedFrom: on },
];

/** How a provision path renders as the publisher's deep-link anchor. */
export type AnchorScheme = {
  /** What joins two path segments: `-` for e-sbirka, `.` for Slov-Lex. */
  join: string;
  /**
   * One renderer per anchorable level. Total by construction: a level without
   * a renderer is a compile error, not a link silently missing a segment.
   */
  render: Readonly<Record<AnchorLevel, (value: string) => string>>;
};

export type JurisdictionProfile = {
  jurisdiction: ProvisionCitationJurisdiction;
  /** BCP-47 primary subtag of the language the profile's vocabulary is in. */
  language: string;
  sectionTerms: readonly SectionTermSpec[];
  subdivisionTerms: readonly SubdivisionTermSpec[];
  /** `,` and `;` are always connectors; these are the word-shaped ones. */
  enumerationConnectors: readonly string[];
  /** Word-shaped range connectors. Dashes are always range connectors. */
  rangeConnectors: readonly string[];
  /** "and following": recorded as an open range, never expanded. */
  andFollowingMarkers: readonly string[];
  collections: readonly CollectionSpec[];
  /**
   * Lowercase or issuer-name phrases that may stand between a provision and
   * the act it belongs to without breaking the pairing. Everything else that
   * is capitalised does break it.
   */
  actLeadIns: readonly string[];
  aliases: readonly ActAliasSpec[];
  titles: readonly ActTitleSpec[];
  /** Ordinal words a sentence reference uses, mapped to their digit. */
  ordinalWords: Readonly<Record<string, string>>;
  /**
   * Tokens that end in a period without ending a sentence. Without these the
   * segmenter cuts `zákona č. 99/1963 Sb., občanský soudní řád` into pieces and
   * the act never reaches the provision that cites it.
   */
  sentenceAbbreviations: readonly string[];
  /** A two-digit year at or above this is last century (`96` -> 1996). */
  twoDigitYearPivot: number;
  /** No collection has an act older than this; anything earlier is not an act. */
  earliestYear: number;
  /** How far past a provision the act it belongs to may sit, in characters. */
  maxActGapChars: number;
  anchor: AnchorScheme;
};
