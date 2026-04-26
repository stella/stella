/**
 * Court registry: per-country definitions of courts with
 * slug, display name, color, and hierarchy tier.
 *
 * Hierarchy tiers (lower = higher authority):
 *   1 = constitutional
 *   2 = supreme / supreme administrative
 *   3 = appellate / high
 *   4 = regional / district
 *   5 = EU supranational
 */

type CourtDef = {
  slug: string;
  name: string;
  color: string;
  tier: number;
};

type CountryRegistry = {
  courts: CourtDef[];
};

const REGISTRY: Record<string, CountryRegistry> = {
  cz: {
    courts: [
      {
        slug: "us",
        name: "Ústavní soud",
        color: "--option-violet",
        tier: 1,
      },
      {
        slug: "ns",
        name: "Nejvyšší soud",
        color: "--option-amber",
        tier: 2,
      },
      {
        slug: "nss",
        name: "Nejvyšší správní soud",
        color: "--option-cyan",
        tier: 2,
      },
      {
        slug: "regional",
        name: "Krajský soud",
        color: "--option-teal",
        tier: 4,
      },
    ],
  },
  sk: {
    courts: [
      {
        slug: "us-sr",
        name: "Ústavný súd SR",
        color: "--option-violet",
        tier: 1,
      },
      {
        slug: "ns-sr",
        name: "Najvyšší súd SR",
        color: "--option-amber",
        tier: 2,
      },
      {
        slug: "nss-sr",
        name: "Najvyšší správny súd SR",
        color: "--option-cyan",
        tier: 2,
      },
    ],
  },
  pl: {
    courts: [
      {
        slug: "tk",
        name: "Trybunał Konstytucyjny",
        color: "--option-violet",
        tier: 1,
      },
      {
        slug: "sn",
        name: "Sąd Najwyższy",
        color: "--option-amber",
        tier: 2,
      },
      {
        slug: "nsa",
        name: "Naczelny Sąd Administracyjny",
        color: "--option-cyan",
        tier: 2,
      },
    ],
  },
  at: {
    courts: [
      {
        slug: "vfgh",
        name: "Verfassungsgerichtshof",
        color: "--option-violet",
        tier: 1,
      },
      {
        slug: "ogh",
        name: "Oberster Gerichtshof",
        color: "--option-amber",
        tier: 2,
      },
      {
        slug: "vwgh",
        name: "Verwaltungsgerichtshof",
        color: "--option-cyan",
        tier: 2,
      },
    ],
  },
  eu: {
    courts: [
      {
        slug: "cjeu",
        name: "Court of Justice",
        // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS variable name, not a color value
        color: "--option-blue",
        tier: 5,
      },
      {
        slug: "gc",
        name: "General Court",
        // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS variable name, not a color value
        color: "--option-blue",
        tier: 5,
      },
    ],
  },
};

const DEFAULT_COLOR = "--option-emerald";

/** Build a lookup by court name across all countries. */
const buildNameIndex = (): Map<string, CourtDef> => {
  const index = new Map<string, CourtDef>();
  for (const country of Object.values(REGISTRY)) {
    for (const court of country.courts) {
      index.set(court.name, court);
    }
  }
  return index;
};

const nameIndex = buildNameIndex();

/** Look up a court definition by its display name. */
export const getCourtByName = (name: string): CourtDef | null =>
  nameIndex.get(name) ?? null;

/** Get CSS color variable value for a court name. */
export const getCourtColor = (courtName: string): string => {
  const court = nameIndex.get(courtName);
  return `var(${court?.color ?? DEFAULT_COLOR})`;
};

/** Get the full registry for a country. */
export const getCountryRegistry = (country: string): CountryRegistry | null =>
  REGISTRY[country.toLowerCase()] ?? null;
