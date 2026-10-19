import { panic } from "better-result";

import { marketingLocaleForOrganization } from "@stll/playwright-tools/marketing-locales";
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

/**
 * The content language of a seed run. A locale's marketing firm is always
 * seeded in its own language; every other organization (the English firm,
 * a developer's own organization) gets the English content.
 */
export const seedLocaleForOrganization = (
  organizationId: string | undefined,
): MarketingLocale =>
  (organizationId === undefined
    ? undefined
    : marketingLocaleForOrganization(organizationId)) ?? "en";

/**
 * The locale this process seeds, from the target organization the CLI was
 * given. Read once at import, like the seed-id namespace, because the
 * module-level seed tables derive from it.
 */
export const SEED_LOCALE = seedLocaleForOrganization(
  process.env["STELLA_SEED_ORG_ID"]?.trim() || undefined,
);

/** Fail when a run would write one locale's content into another's firm. */
export const assertSeedLocaleMatches = (organizationId: string) => {
  const expected = seedLocaleForOrganization(organizationId);
  if (expected !== SEED_LOCALE) {
    panic(
      `Seeding ${organizationId} needs the ${expected} content, but this run loaded ${SEED_LOCALE}`,
    );
  }
};
