import { panic } from "better-result";

import {
  MARKETING_LOCALES,
  marketingLocaleForOrganization,
  PRIMARY_MARKETING_LOCALE,
} from "@stll/playwright-tools/marketing-locales";
import type { MarketingLocale } from "@stll/playwright-tools/marketing-locales";

import { CS_SEED_CONTENT } from "./cs";
import { EN_SEED_CONTENT } from "./en";
import { SK_SEED_CONTENT } from "./sk";
import type { SeedLocaleContent } from "./types";

export const SEED_CONTENT_BY_LOCALE: Record<
  MarketingLocale,
  SeedLocaleContent
> = {
  en: EN_SEED_CONTENT,
  cs: CS_SEED_CONTENT,
  sk: SK_SEED_CONTENT,
};

const isMarketingLocale = (value: string): value is MarketingLocale =>
  MARKETING_LOCALES.some((locale) => locale === value);

/**
 * The content language of a seed run. A locale's marketing firm is always
 * seeded in its own language. Any other organization (the English firm, a
 * developer's own organization) gets the requested locale, else the primary
 * one.
 */
export const resolveSeedLocale = ({
  organizationId,
  requested,
}: {
  organizationId: string | undefined;
  requested: string | undefined;
}): MarketingLocale => {
  const firmLocale =
    organizationId === undefined
      ? undefined
      : marketingLocaleForOrganization(organizationId);
  if (requested === undefined) {
    return firmLocale ?? PRIMARY_MARKETING_LOCALE;
  }
  if (!isMarketingLocale(requested)) {
    return panic(
      `STELLA_SEED_LOCALE=${requested} has no content pack; use one of ${MARKETING_LOCALES.join(", ")}`,
    );
  }
  if (firmLocale !== undefined && firmLocale !== requested) {
    return panic(
      `${organizationId ?? ""} is the ${firmLocale} marketing firm; it cannot be seeded in ${requested}`,
    );
  }
  return requested;
};

/**
 * The locale this process seeds, from the target organization the CLI was
 * given and an optional STELLA_SEED_LOCALE. Read once at import, like the
 * seed-id namespace, because the module-level seed tables derive from it.
 */
export const SEED_LOCALE = resolveSeedLocale({
  organizationId: process.env["STELLA_SEED_ORG_ID"]?.trim() || undefined,
  requested: process.env["STELLA_SEED_LOCALE"]?.trim() || undefined,
});

/** Fail when a run would write one locale's content into another's firm. */
export const assertSeedLocaleMatches = (organizationId: string) => {
  const firmLocale = marketingLocaleForOrganization(organizationId);
  if (firmLocale !== undefined && firmLocale !== SEED_LOCALE) {
    panic(
      `Seeding ${organizationId} needs the ${firmLocale} content, but this run loaded ${SEED_LOCALE}`,
    );
  }
};

/**
 * Whether a run into this organization seeds the shared case-law corpus.
 * Every firm but the non-primary marketing ones does; those are seeded after
 * the primary run and reuse its corpus.
 */
export const seedsSharedCorpus = (organizationId: string): boolean =>
  (marketingLocaleForOrganization(organizationId) ??
    PRIMARY_MARKETING_LOCALE) === PRIMARY_MARKETING_LOCALE;
