/**
 * The short form a lawyer writes a court as: ÚS, NS, NSS, KS, SN, NSA, CJEU.
 *
 * Courts are stored as free-text names in the publisher's own language, so the
 * abbreviation is derived here rather than stored, and it is derived in the
 * same language as the name it stands beside — `ÚS` next to "Ústavní soud",
 * `CJEU` next to "Court of Justice". A chip in the reader's UI language beside
 * a name in the court's own would read as two different courts.
 *
 * Two sources, in order, and no third:
 *
 * 1. The decision's own ECLI. Its third segment is the court's national code
 *    (`ECLI:CZ:KSOS:…` is Krajský soud v Ostravě whichever portal serves it),
 *    which is machine-readable and spelled the same way by every publisher.
 *    Seat-bearing codes resolve to their family, because the chip's job is to
 *    say what kind of court this is, not which building.
 * 2. A curated apex-court name pattern per jurisdiction, for the constitutional,
 *    supreme, supreme administrative and justice courts — the courts whose
 *    abbreviation a reader actually reads as a name.
 *
 * Anything else has no abbreviation. A guessed chip on a court nobody
 * abbreviates is worse than no chip: the reader cannot tell an invented short
 * form from a real one, and the court name is already right there.
 */

/**
 * The court segment of an ECLI, with the jurisdiction that issued it. Bounded
 * so a malformed identifier is a miss rather than an unbounded string.
 */
const ECLI_COURT_SEGMENT =
  /^ECLI:(?<jurisdiction>[A-Z]{2}):(?<code>[A-Z0-9]{1,10}):/u;

/**
 * One jurisdiction's reading of its ECLI court codes.
 *
 * `exact` is consulted first and `families` second, longest prefix first, so a
 * national code that happens to start with a family prefix keeps its own
 * reading: Slovak `NSSR` is the Supreme Court, not an `NS`-prefixed family.
 */
type EcliCourtCodes = {
  exact: Readonly<Record<string, string>>;
  /** Prefix → abbreviation, for codes that append a seat to the court family. */
  families: readonly (readonly [prefix: string, abbreviation: string])[];
};

/**
 * ECLI jurisdiction segment → that jurisdiction's codes.
 *
 * Keyed on the ECLI's own jurisdiction rather than on the decision's stored
 * country, because the two legitimately differ: the Czech Supreme Court's
 * database publishes regional and district judgments, and their ECLI is what
 * says so.
 */
const ECLI_COURT_CODES = {
  CZ: {
    exact: { NS: "NS", NSS: "NSS", US: "ÚS" },
    families: [
      ["KS", "KS"],
      ["MS", "MS"],
      ["OS", "OS"],
      ["VS", "VS"],
    ],
  },
  EU: {
    // The Court of Justice and the General Court are `C` and `T` in an ECLI,
    // which says nothing to a reader; their working abbreviations do.
    exact: { C: "CJEU", T: "GC" },
    families: [],
  },
  PL: {
    exact: { NSA: "NSA", SN: "SN", TK: "TK" },
    families: [
      ["WSA", "WSA"],
      ["SA", "SA"],
      ["SO", "SO"],
      ["SR", "SR"],
    ],
  },
  SK: {
    exact: { NSSR: "NS", NSSSR: "NSS", USSR: "ÚS" },
    families: [
      ["KS", "KS"],
      ["OS", "OS"],
    ],
  },
} as const satisfies Readonly<Record<string, EcliCourtCodes>>;

/**
 * Apex-court name patterns per stored country code, most specific first: the
 * administrative supreme court's name contains the supreme court's, so an
 * unordered map would abbreviate one as the other.
 *
 * Apex only, on purpose. A jurisdiction's regional and district courts are
 * named after their seat and are not abbreviated in prose, so there is nothing
 * to derive from a name that an ECLI did not already answer.
 */
const APEX_COURT_PATTERNS = {
  CZE: [
    [/ústavní\s+soud/iu, "ÚS"],
    [/nejvyšší\s+správní\s+soud/iu, "NSS"],
    [/nejvyšší\s+soud/iu, "NS"],
  ],
  EU: [
    [/court\s+of\s+justice/iu, "CJEU"],
    [/general\s+court/iu, "GC"],
  ],
  // Hungary issues no ECLI, so the name is the only source there is. The
  // Kúria is written out rather than abbreviated in Hungarian prose, which is
  // why its chip is the name; `LB` is the pre-2012 Legfelsőbb Bíróság, the
  // same court under the name its older decisions carry.
  HUN: [
    [/alkotmánybíróság/iu, "AB"],
    [/kúria/iu, "Kúria"],
    [/legfelsőbb\s+bíróság/iu, "LB"],
  ],
  POL: [
    [/trybunał\s+konstytucyjny/iu, "TK"],
    [/naczelny\s+sąd\s+administracyjny/iu, "NSA"],
    [/sąd\s+najwyższy/iu, "SN"],
  ],
  SVK: [
    [/ústavný\s+súd/iu, "ÚS"],
    [/najvyšší\s+správny\s+súd/iu, "NSS"],
    [/najvyšší\s+súd/iu, "NS"],
  ],
  // Anchored to the court directory's canonical name, the one spelling a
  // decision of that court is stored under.
  USA: [[/^supreme\s+court\s+of\s+the\s+united\s+states$/iu, "SCOTUS"]],
} as const satisfies Readonly<
  Record<string, readonly (readonly [RegExp, string])[]>
>;

/**
 * The same tables as a lookup, with the family prefixes already in
 * longest-first order so `WSA…` is a voivodeship administrative court rather
 * than an appellate one. Built once: the object literal above is what is
 * reviewed, and this is what is read.
 */
const ecliCourtCodes = new Map<string, EcliCourtCodes>(
  Object.entries(ECLI_COURT_CODES).map(([jurisdiction, codes]) => [
    jurisdiction,
    {
      exact: codes.exact,
      families: codes.families.toSorted(
        ([left], [right]) => right.length - left.length,
      ),
    },
  ]),
);

const abbreviationFromEcliCode = (
  jurisdiction: string,
  code: string,
): string | undefined => {
  const codes = ecliCourtCodes.get(jurisdiction);
  if (codes === undefined) {
    return undefined;
  }
  const exact = codes.exact[code];
  if (exact !== undefined) {
    return exact;
  }
  const matched = codes.families.find(
    ([prefix]) => code.length > prefix.length && code.startsWith(prefix),
  );
  return matched?.[1];
};

/** The abbreviation an ECLI states, or none when it states no known court. */
const courtAbbreviationFromEcli = (
  ecli: string | null | undefined,
): string | undefined => {
  const groups =
    ecli === null || ecli === undefined
      ? undefined
      : ECLI_COURT_SEGMENT.exec(ecli)?.groups;
  const jurisdiction = groups?.["jurisdiction"];
  const code = groups?.["code"];
  if (jurisdiction === undefined || code === undefined) {
    return undefined;
  }
  return abbreviationFromEcliCode(jurisdiction, code);
};

const apexCourtPatterns = new Map<
  string,
  readonly (readonly [RegExp, string])[]
>(Object.entries(APEX_COURT_PATTERNS));

/** The abbreviation a jurisdiction's apex-court names carry, or none. */
const courtAbbreviationFromName = (
  country: string,
  court: string,
): string | undefined =>
  apexCourtPatterns
    .get(country.toUpperCase())
    ?.find(([pattern]) => pattern.test(court))?.[1];

export type CourtAbbreviationInput = {
  /** The decision's stored country, ISO 3166-1 alpha-3 or `EU`. */
  country: string;
  /** The court name as the publisher spells it. */
  court: string;
  /** The decision's own identifier, where it carries one. */
  ecli?: string | null | undefined;
};

/**
 * The chip a court is shown under, or none when nothing states one.
 *
 * `undefined` is a value the caller must render as an absent chip, never as a
 * placeholder: the court name carries the meaning on its own, and the chip is
 * the shorthand beside it.
 */
export const courtAbbreviation = ({
  country,
  court,
  ecli,
}: CourtAbbreviationInput): string | undefined =>
  courtAbbreviationFromEcli(ecli) ?? courtAbbreviationFromName(country, court);
