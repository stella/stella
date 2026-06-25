import {
  loadCatalogue,
  recommendedSlugsForJurisdictions,
} from "@stll/catalogue";

// Which country code(s) a locale's "local sources" reflect. The catalogue's
// recommendedSlugsForJurisdictions() auto-adds the EU tier (e.g. VIES) when a
// country is an EU member, so we only list the country itself here.
//
// Locales with no entry (or an empty list) simply show no local sources yet,
// which is the honest signal that data coverage has not reached them.
const localeCountries: Record<string, readonly string[]> = {
  cs: ["CZ"],
  sk: ["SK"],
  pl: ["PL"],
  es: ["ES"],
  fr: ["FR"],
  de: ["DE"],
  "zh-TW": ["TW"],
  en: ["GB", "US"],
};

export type LocaleSource = {
  slug: string;
  displayName: string;
  description: string;
  homepage: string | null;
};

export function localeHasSourceMapping(locale: string): boolean {
  return (localeCountries[locale]?.length ?? 0) > 0;
}

// Official sources stella connects for a locale, derived from the catalogue.
// Adding a registry/case-law adapter with a jurisdiction surfaces it here
// automatically; nothing in the landing is hardcoded per source.
export function sourcesForLocale(locale: string): LocaleSource[] {
  const countries = localeCountries[locale] ?? [];
  if (countries.length === 0) {
    return [];
  }

  const slugs = recommendedSlugsForJurisdictions(new Set(countries));
  if (slugs.size === 0) {
    return [];
  }

  const bySlug = new Map(loadCatalogue().map((entry) => [entry.slug, entry]));
  const sources: LocaleSource[] = [];
  for (const slug of slugs) {
    const entry = bySlug.get(slug);
    if (!entry) {
      continue;
    }
    sources.push({
      slug: entry.slug,
      displayName: entry.displayName,
      description: entry.description,
      homepage: entry.homepage ?? null,
    });
  }
  return sources;
}
