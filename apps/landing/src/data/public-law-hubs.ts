import {
  CASE_LAW_REGION_BY_COUNTRY,
  PUBLIC_CASE_LAW_PAGE_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";

/** The legal database's host; its law pages carry their own robots.txt and sitemap. */
const PUBLIC_LAW_ORIGIN = "https://my.stll.app";

type PublicLawHubLink = { href: string; name: string };

/**
 * One link per jurisdiction whose case-law pages are public, from the same
 * list the legal database admits pages, sitemaps and crawlers by, so a
 * country that is not public is never linked.
 */
export const publicLawHubLinks = (
  languageTag: string,
): readonly PublicLawHubLink[] => {
  const names = new Intl.DisplayNames([languageTag], { type: "region" });
  return PUBLIC_CASE_LAW_PAGE_COUNTRIES.map((country) => ({
    href: `${PUBLIC_LAW_ORIGIN}/law/${country.toLowerCase()}`,
    name: names.of(CASE_LAW_REGION_BY_COUNTRY[country]) ?? country,
  })).toSorted((a, b) => a.name.localeCompare(b.name, languageTag));
};
