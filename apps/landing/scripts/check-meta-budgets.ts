#!/usr/bin/env bun
import { products } from "../src/data/products/registry";
import { type Locale, localeCodes } from "../src/i18n/config";
import { catalogs } from "../src/i18n/utils";

// SERP length budgets for every indexable page's meta strings, in every locale.
// Google truncates a title past ~60 characters and a description past ~158,
// and pads a description under ~140 with page text it picks itself; either way
// the market-specific wording the string was written for stops rendering. The
// budgets are a translation rule (src/i18n/TRANSLATION.md) that used to depend
// on whoever edited a catalog remembering it, which is how thirteen locales
// drifted past it at once. Checked here instead.
//
// Two pages in one locale sharing a title or a description is the other half of
// the same class: the catalog is the only place a translator can collapse two
// distinct pages onto one SERP entry, so the collision is caught here too.

const TITLE_MAX = 60;
const DESCRIPTION_MIN = 140;
const DESCRIPTION_MAX = 158;

/** A meta pair and the page it belongs to, for one locale. */
type PageMeta = { page: string; title: string; description: string };

const pagesFor = (locale: (typeof localeCodes)[number]): PageMeta[] => {
  const { meta, products: catalog } = catalogs[locale];
  return [
    { page: "/", title: meta.homeTitle, description: meta.homeDescription },
    ...products.map(({ slug }) => ({
      page: `/product/${slug}`,
      title: catalog[slug].metaTitle,
      description: catalog[slug].metaDescription,
    })),
  ];
};

/**
 * Metas are written for searchers, not for the product catalog: each locale below
 * targets researched demand phrasings and excludes the literal category label from
 * meta strings, per the exception carved out in src/i18n/TRANSLATION.md ("Metas are
 * the exception" under "The identity phrase"). That rule used to depend on whoever
 * touched a catalog remembering it, which is how three locales drifted at once.
 * Checked here instead.
 */
type TermPolicy = {
  banned: readonly RegExp[];
  homeRequiredAny: readonly RegExp[];
};

const termPolicies: Partial<Record<Locale, TermPolicy>> = {
  cs: {
    banned: [/pracovn\S*\s+prostor\S*/iu, /advokátn\S*\s+spis\S*/iu],
    homeRequiredAny: [
      /AI pro právníky/iu,
      /právní rešerš/iu,
      /reviz\S*\s+smluv/iu,
    ],
  },
  sk: {
    banned: [/pracovn\S*\s+priestor\S*/iu, /advokátsk\S*\s+spis\S*/iu],
    homeRequiredAny: [/AI právny asistent/iu],
  },
  de: {
    banned: [/arbeitsbereich/iu, /kanzleisoftware/iu, /schwärzung/iu],
    homeRequiredAny: [
      /KI für Anwälte/iu,
      /aktenverwaltung/iu,
      /vertragsanalyse/iu,
    ],
  },
};

const termPolicyViolations = (
  locale: Locale,
  pages: readonly PageMeta[],
): string[] => {
  const policy = termPolicies[locale];
  if (!policy) {
    return [];
  }
  const violations: string[] = [];
  for (const meta of pages) {
    for (const field of ["title", "description"] as const) {
      for (const banned of policy.banned) {
        const match = meta[field].match(banned);
        if (match) {
          violations.push(
            `${meta.page} ${field} uses a term excluded from metas: "${match[0]}"`,
          );
        }
      }
    }
  }
  const home = pages.find(({ page }) => page === "/");
  if (
    home &&
    policy.homeRequiredAny.length > 0 &&
    !policy.homeRequiredAny.some((required) =>
      required.test(`${home.title} ${home.description}`),
    )
  ) {
    violations.push(
      `${home.page} home metas carry none of the locale's meta demand terms`,
    );
  }
  return violations;
};

const budgetViolations = ({ page, title, description }: PageMeta): string[] => {
  const violations: string[] = [];
  if (title.length > TITLE_MAX) {
    violations.push(`${page} title ${title.length} > ${TITLE_MAX}`);
  }
  if (description.length < DESCRIPTION_MIN) {
    violations.push(
      `${page} description ${description.length} < ${DESCRIPTION_MIN}`,
    );
  }
  if (description.length > DESCRIPTION_MAX) {
    violations.push(
      `${page} description ${description.length} > ${DESCRIPTION_MAX}`,
    );
  }
  return violations;
};

const duplicateViolations = (pages: readonly PageMeta[]): string[] => {
  const violations: string[] = [];
  for (const field of ["title", "description"] as const) {
    const seen = new Map<string, string[]>();
    for (const meta of pages) {
      const pagesWithValue = seen.get(meta[field]) ?? [];
      pagesWithValue.push(meta.page);
      seen.set(meta[field], pagesWithValue);
    }
    for (const [value, pagesWithValue] of seen) {
      if (pagesWithValue.length > 1) {
        violations.push(
          `${field} shared by ${pagesWithValue.join(", ")}: ${value}`,
        );
      }
    }
  }
  return violations;
};

const failures: string[] = [];
for (const locale of localeCodes) {
  const pages = pagesFor(locale);
  const violations = [
    ...pages.flatMap(budgetViolations),
    ...duplicateViolations(pages),
    ...termPolicyViolations(locale, pages),
  ];
  for (const violation of violations) {
    failures.push(`${locale}: ${violation}`);
  }
}

if (failures.length > 0) {
  console.error(`meta budgets: ${failures.length} violation(s)`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(
  `meta budgets: ${localeCodes.length} locales x ${products.length + 1} pages ok`,
);
