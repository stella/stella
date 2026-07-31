#!/usr/bin/env bun
import { products } from "../src/data/products/registry";
import { localeCodes } from "../src/i18n/config";
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
