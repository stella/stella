import { describe, expect, test } from "bun:test";

import {
  isStatuteQueryCountry,
  STATUTE_ALIASES,
  type StatuteAliasTarget,
  type StatuteQueryCountry,
} from "@stll/api-contract/statute-aliases";
import { foldStatuteQuery } from "@stll/api-contract/statute-query-intent";
import type {
  ActTitleSpec,
  ProvisionCitationJurisdiction,
  WorkIdentifier,
} from "@stll/legal-atlas/provision-citation-profile";
import { PROVISION_CITATION_PROFILES } from "@stll/legal-atlas/provision-citation-profiles";

/**
 * The statute search box and the citation profiles each name acts. The
 * profiles are the richer table (succession windows, declined titles), so
 * every search-box alias must name the act its profile spelling reads as
 * today. Disagreements the box makes on purpose are listed with the profile
 * reading they diverge from; the list may only shrink, because a listed key
 * whose reading changes fails until its entry is updated or removed.
 */

const PROFILE_BY_COUNTRY = {
  cze: "CZE",
  svk: "SVK",
} as const satisfies Record<StatuteQueryCountry, ProvisionCitationJurisdiction>;

// The ELI path segment each printed collection is published under. Slov-Lex
// files Zb. and Z. z. acts alike under `/zz/`.
const ELI_COLLECTION = {
  cze: { "Sb.": "sb" },
  svk: { "Zb.": "zz", "Z. z.": "zz" },
} as const satisfies Record<StatuteQueryCountry, Record<string, string>>;

type AliasKey = {
  [
    Country in StatuteQueryCountry
  ]: `${Country}:${keyof (typeof STATUTE_ALIASES)[Country] & string}`;
}[StatuteQueryCountry];

type Divergence = {
  key: AliasKey;
  /** The profile's reading today, as `describeReading` prints it. */
  profileReads: string;
  reason: string;
};

const SEARCH_ONLY =
  "Search-box shorthand: as a citation alias it would also match ordinary words in decision text.";

const searchOnly = (key: AliasKey): Divergence => ({
  key,
  profileReads: "absent",
  reason: SEARCH_ONLY,
});

const KNOWN_DIVERGENCES: readonly Divergence[] = [
  {
    key: "cze:obc. zak.",
    profileReads: "40/1964 sb",
    reason:
      "Decisions cite the 1964 code as `obč. zák.`; a search-box query means the code in force.",
  },
  searchOnly("cze:obc zak"),
  searchOnly("cze:obcz"),
  searchOnly("cze:obcansky"),
  searchOnly("cze:obcan"),
  searchOnly("cze:trz"),
  searchOnly("cze:dph"),
  {
    key: "cze:zivnostensky zakon",
    profileReads: "absent",
    reason: "The CZ profile has no titles for 455/1991 Sb. yet.",
  },
];

const TODAY = new Date().toISOString().slice(0, 10);

const isWindowed = ({ citedFrom, citedUntil }: ActTitleSpec) =>
  citedFrom !== undefined || citedUntil !== undefined;

const coversToday = ({ citedFrom, citedUntil }: ActTitleSpec) =>
  (citedFrom === undefined || citedFrom <= TODAY) &&
  (citedUntil === undefined || TODAY < citedUntil);

type ProfileReading =
  | { type: "act"; identifier: WorkIdentifier }
  | { type: "absent" }
  | { type: "ambiguous"; identifiers: readonly WorkIdentifier[] };

/** What a profile spelling reads as today: a window covering today wins. */
const readProfileToday = (
  country: StatuteQueryCountry,
  key: string,
): ProfileReading => {
  const profile = PROVISION_CITATION_PROFILES[PROFILE_BY_COUNTRY[country]];
  const entries = [...profile.titles, ...profile.aliases].filter(
    ({ spellings }) =>
      spellings.some((spelling) => foldStatuteQuery(spelling) === key),
  );
  const windowed = entries.filter(
    (entry) => isWindowed(entry) && coversToday(entry),
  );
  const candidates =
    windowed.length > 0
      ? windowed
      : entries.filter((entry) => !isWindowed(entry));
  const identifiers = [
    ...new Map(
      candidates.map(({ identifier }) => [
        `${identifier.number}/${identifier.year} ${identifier.collection}`,
        identifier,
      ]),
    ).values(),
  ];
  const only = identifiers.at(0);
  if (only === undefined) {
    return { type: "absent" };
  }
  if (identifiers.length > 1) {
    return { type: "ambiguous", identifiers };
  }
  return { type: "act", identifier: only };
};

/** A reading in the alias table's terms: number, year and ELI collection. */
const describeReading = (
  country: StatuteQueryCountry,
  reading: ProfileReading,
): string => {
  switch (reading.type) {
    case "act": {
      const collections: Partial<Record<string, string>> =
        ELI_COLLECTION[country];
      const { collection, number, year } = reading.identifier;
      return `${number}/${year} ${collections[collection] ?? `unmapped ${collection}`}`;
    }
    case "absent":
      return "absent";
    case "ambiguous":
      return `ambiguous ${reading.identifiers
        .map(({ number, year }) => `${number}/${year}`)
        .join(", ")}`;
    default: {
      const unreachable: never = reading;
      return unreachable;
    }
  }
};

const describeTarget = ({ collection, number, year }: StatuteAliasTarget) =>
  `${number}/${year} ${collection}`;

const aliasRowsFor = (country: StatuteQueryCountry) => {
  const aliases: Record<string, StatuteAliasTarget> = STATUTE_ALIASES[country];
  return Object.entries(aliases).map(([key, target]) => ({
    country,
    key,
    alias: describeTarget(target),
    profile: describeReading(country, readProfileToday(country, key)),
  }));
};

const ALIAS_ROWS = Object.keys(STATUTE_ALIASES)
  .filter(isStatuteQueryCountry)
  .flatMap(aliasRowsFor);

describe("statute search aliases against citation profiles", () => {
  test("lists each divergence once", () => {
    const keys = KNOWN_DIVERGENCES.map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test.each(ALIAS_ROWS)("$country:$key", ({ country, key, alias, profile }) => {
    const divergence = KNOWN_DIVERGENCES.find(
      (entry) => entry.key === `${country}:${key}`,
    );
    if (divergence === undefined) {
      expect(profile).toBe(alias);
      return;
    }
    expect(profile).not.toBe(alias);
    expect(profile).toBe(divergence.profileReads);
  });
});
