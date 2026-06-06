import { normalizeCaseLawLanguageSegment } from "@/lib/case-law-route";

type CaseLawLanguageAlternate = {
  language: string;
};

export type CaseLawLanguageAlternateLink = {
  href: string;
  hreflang: string;
};

export type CreateCaseLawLanguageAlternateLinksOptions<
  TAlternate extends CaseLawLanguageAlternate,
> = {
  alternates: readonly TAlternate[];
  createHref: (alternate: TAlternate) => string;
};

export const createCaseLawLanguageAlternateLinks = <
  TAlternate extends CaseLawLanguageAlternate,
>({
  alternates,
  createHref,
}: CreateCaseLawLanguageAlternateLinksOptions<TAlternate>): CaseLawLanguageAlternateLink[] => {
  if (alternates.length <= 1) {
    return [];
  }

  const alternateLinks: CaseLawLanguageAlternateLink[] = [];
  const seenHreflangs = new Set<string>();
  for (const alternate of alternates) {
    const hreflang = normalizeCaseLawLanguageSegment(alternate.language);
    if (hreflang === null || seenHreflangs.has(hreflang)) {
      continue;
    }

    seenHreflangs.add(hreflang);
    alternateLinks.push({
      hreflang,
      href: createHref(alternate),
    });
  }

  if (alternateLinks.length <= 1) {
    return [];
  }

  const defaultAlternate =
    alternateLinks.find((alternate) => alternate.hreflang === "en") ??
    alternateLinks.at(0);
  if (defaultAlternate) {
    alternateLinks.push({
      hreflang: "x-default",
      href: defaultAlternate.href,
    });
  }

  return alternateLinks;
};
