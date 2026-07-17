import { panic } from "better-result";
import { type SQL, and, eq, like, or, sql } from "drizzle-orm";

import { stripDiacriticsForSlug } from "@stll/text-normalize";

import { caseLawDecisions } from "@/api/db/schema";
import { escapeLike } from "@/api/lib/escape-like";

const CASE_LAW_DECISION_SLUG_MAX_LENGTH = 256;
const MIN_CASE_LAW_DECISION_SLUG_SUFFIX = 2;

const trimSlugHyphens = (value: string): string => {
  let start = 0;
  while (value.at(start) === "-") {
    start += 1;
  }

  let end = value.length;
  while (end > start && value.at(end - 1) === "-") {
    end -= 1;
  }

  return value.slice(start, end);
};

const toSuffixText = (suffix: number): string => `-${suffix}`;

const fitSlug = (baseSlug: string, suffix?: number): string => {
  const suffixText = suffix === undefined ? "" : toSuffixText(suffix);
  const maxBaseLength = Math.max(
    0,
    CASE_LAW_DECISION_SLUG_MAX_LENGTH - suffixText.length,
  );
  const trimmed = trimSlugHyphens(baseSlug.slice(0, maxBaseLength));
  return `${trimmed || "unknown"}${suffixText}`;
};

export const createCaseLawDecisionSlug = (caseNumber: string): string => {
  // NFKD strip is single-homed in stripDiacriticsForSlug; case folding and
  // the [a-z0-9] filter stay here and run in the same order as before, so
  // existing persisted slugs are reproduced byte-for-byte.
  const slug = trimSlugHyphens(
    stripDiacriticsForSlug(caseNumber)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-"),
  );

  return fitSlug(slug || "unknown");
};

type CaseLawDecisionSlugCollisionScanPrefixOptions = {
  baseSlug: string;
  maxSuffix: number;
};

export const createCaseLawDecisionSlugCollisionScanPrefix = ({
  baseSlug,
  maxSuffix,
}: CaseLawDecisionSlugCollisionScanPrefixOptions): string => {
  const normalizedBase = fitSlug(baseSlug);
  const suffix = Math.max(MIN_CASE_LAW_DECISION_SLUG_SUFFIX, maxSuffix);
  const suffixText = toSuffixText(suffix);
  const maxBaseLength = Math.max(
    0,
    CASE_LAW_DECISION_SLUG_MAX_LENGTH - suffixText.length,
  );
  return trimSlugHyphens(normalizedBase.slice(0, maxBaseLength)) || "unknown";
};

/**
 * Builds the WHERE condition that selects every slug colliding with `baseSlug`
 * (the bare base plus its `-<n>` suffixes), for both ingest and the backfill so
 * they share one collision-scan definition.
 *
 * When the base is short enough that no suffix within the scan window truncates
 * it, every colliding slug is exactly `base` or `base-<digits>`, so the filter
 * matches that set precisely. A bare `LIKE base%` would also pull in unrelated
 * slugs that merely share the textual prefix (e.g. base `c-752` matching
 * `c-7524`); on a short or common base those can fill the scan cap and hide the
 * real collision, so the caller would pick an already-used slug. For the rare
 * max-length base whose `-<n>` variants truncate to different prefixes, fall
 * back to the shared prefix scan (collision risk there is negligible since the
 * prefix is already ~250 chars).
 */
export const caseLawDecisionSlugCollisionFilter = ({
  baseSlug,
  maxSuffix,
}: CaseLawDecisionSlugCollisionScanPrefixOptions): SQL | undefined => {
  const normalizedBase = fitSlug(baseSlug);
  const suffix = Math.max(MIN_CASE_LAW_DECISION_SLUG_SUFFIX, maxSuffix);
  const longestSuffixLength = toSuffixText(suffix).length;

  if (
    normalizedBase.length + longestSuffixLength <=
    CASE_LAW_DECISION_SLUG_MAX_LENGTH
  ) {
    // normalizedBase contains only [a-z0-9-], so it is already regex-safe.
    return or(
      eq(caseLawDecisions.slug, normalizedBase),
      and(
        like(caseLawDecisions.slug, `${escapeLike(normalizedBase)}-%`),
        sql`${caseLawDecisions.slug} ~ ${`^${normalizedBase}-[0-9]+$`}`,
      ),
    );
  }

  const scanPrefix = createCaseLawDecisionSlugCollisionScanPrefix({
    baseSlug,
    maxSuffix,
  });
  return like(caseLawDecisions.slug, `${escapeLike(scanPrefix)}%`);
};

export const createAvailableCaseLawDecisionSlug = (
  baseSlug: string,
  existingSlugs: readonly (string | null)[],
): string => {
  const used = new Set(existingSlugs.filter((slug) => slug !== null));
  const normalizedBase = fitSlug(baseSlug);

  if (!used.has(normalizedBase)) {
    return normalizedBase;
  }

  for (
    let suffix = MIN_CASE_LAW_DECISION_SLUG_SUFFIX;
    suffix < Number.MAX_SAFE_INTEGER;
    suffix += 1
  ) {
    const candidate = fitSlug(normalizedBase, suffix);
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return panic("No available case-law decision slug");
};
