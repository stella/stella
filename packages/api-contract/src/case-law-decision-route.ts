import { panic, Result } from "better-result";

import { stripDiacriticsForSlug } from "@stll/text-normalize";
import { decodeUuidSuffix, encodeCompactUuid, isUuid } from "@stll/uuid-codec";

/**
 * The single owner of a case-law decision's public route. The API mints
 * persisted slugs and agent-facing URLs from it, the web routes and parses
 * paths with it, so the two cannot address different pages.
 */

// `case_number` and `slug` are both `varchar(256)`, and NFKD expansion can
// push a long case number's fold past the column, so every fold truncates.
const CASE_LAW_DECISION_SLUG_MAX_LENGTH = 256;
const UNKNOWN_SLUG = "unknown";
const UNKNOWN_COURT_SEGMENT = "unknown-court";
const ID_ROUTE_PARAM_SEPARATOR = "--";
const LANGUAGE_SEGMENT_REGEX = /^(?=.{2,8}$)[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

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

type FitCaseLawDecisionSlugOptions = {
  baseSlug: string;
  suffix?: string;
};

/** A slug cut to the column length, the suffix kept whole. */
export const fitCaseLawDecisionSlug = ({
  baseSlug,
  suffix = "",
}: FitCaseLawDecisionSlugOptions): string => {
  const maxBaseLength = Math.max(
    0,
    CASE_LAW_DECISION_SLUG_MAX_LENGTH - suffix.length,
  );
  const trimmed = trimSlugHyphens(baseSlug.slice(0, maxBaseLength));
  return `${trimmed || UNKNOWN_SLUG}${suffix}`;
};

/**
 * The case-law slug fold: persisted slugs and every URL segment that
 * addresses them. NFKD strip is single-homed in stripDiacriticsForSlug; case
 * folding and the [a-z0-9] filter run in the order existing persisted slugs
 * were generated with, so they are reproduced byte-for-byte.
 */
export const createCaseLawDecisionSlug = (value: string): string => {
  const slug = trimSlugHyphens(
    stripDiacriticsForSlug(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-"),
  );

  return fitCaseLawDecisionSlug({ baseSlug: slug || UNKNOWN_SLUG });
};

const normalizeCaseLawStoredSlug = (
  slug: string | null | undefined,
): string | null => (slug?.trim() ? createCaseLawDecisionSlug(slug) : null);

export const isCaseLawDecisionId = (value: string): boolean =>
  isUuid(value.trim());

/** The id compacted, or the value untouched when it is not an id at all: a
 *  route param the caller assembled from a search hit is never dropped. */
const encodeCaseLawDecisionIdForRoute = (decisionId: string): string => {
  const encoded = encodeCompactUuid(decisionId.trim());
  return Result.isError(encoded) ? decisionId : encoded.value;
};

type CaseLawDecisionRouteIdentityInput = {
  caseNumber: string;
  decisionId: string;
  /** Required: a caller that omits a stored slug gets a different URL. */
  slug: string | null;
};

/**
 * The identity a decision's public route carries. Stored slugs are the
 * canonical form; a decision without one routes by id, because slugifying
 * its case number produces a segment `by-slug` cannot resolve.
 */
type CaseLawDecisionRouteIdentity =
  | { kind: "slug"; slug: string }
  | { kind: "id"; caseNumber: string; decisionId: string };

const resolveCaseLawDecisionRouteIdentity = ({
  caseNumber,
  decisionId,
  slug,
}: CaseLawDecisionRouteIdentityInput): CaseLawDecisionRouteIdentity => {
  const storedSlug = normalizeCaseLawStoredSlug(slug);
  return storedSlug === null
    ? { kind: "id", caseNumber, decisionId }
    : { kind: "slug", slug: storedSlug };
};

const createCaseLawDecisionRouteParam = (
  input: CaseLawDecisionRouteIdentityInput,
): string => {
  const identity = resolveCaseLawDecisionRouteIdentity(input);
  switch (identity.kind) {
    case "slug":
      return identity.slug;
    case "id":
      return `${createCaseLawDecisionSlug(identity.caseNumber)}${ID_ROUTE_PARAM_SEPARATOR}${encodeCaseLawDecisionIdForRoute(identity.decisionId)}`;
    default: {
      identity satisfies never;
      return panic(`Unhandled identity: ${String(identity)}`);
    }
  }
};

/** The decision id carried by an id-form route param (compact or legacy full
 *  uuid tail), null for slug params. */
export const extractCaseLawDecisionIdFromIdRouteParam = (
  param: string,
): string | null => {
  const decoded = decodeUuidSuffix({
    segment: param.trim(),
    separator: ID_ROUTE_PARAM_SEPARATOR,
  });
  return Result.isError(decoded) ? null : decoded.value;
};

export const normalizeCaseLawLanguageSegment = (
  language: string | null | undefined,
): string | null => {
  const normalized = language?.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized || !LANGUAGE_SEGMENT_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
};

const isCaseLawLanguageAlternate = (
  alternate: unknown,
): alternate is { language: string } =>
  typeof alternate === "object" &&
  alternate !== null &&
  "language" in alternate &&
  typeof alternate.language === "string";

const getCaseLawLanguageAlternateCount = (
  languageAlternates: readonly unknown[] | null | undefined,
): number => {
  if (!languageAlternates) {
    return 0;
  }

  const languages = new Set<string>();
  for (const alternate of languageAlternates) {
    if (!isCaseLawLanguageAlternate(alternate)) {
      continue;
    }

    const normalized = normalizeCaseLawLanguageSegment(alternate.language);
    if (normalized !== null) {
      languages.add(normalized);
    }
  }

  return languages.size;
};

export type CaseLawDecisionRouteParams = {
  country: string;
  court: string;
  language?: string;
  slug: string;
};

/**
 * Every field that can change the URL is required, null when the caller has
 * none: omitting the language alternates drops the language segment, so an
 * omission has to be a compile error rather than a different page.
 */
export type CaseLawDecisionRouteInput = CaseLawDecisionRouteIdentityInput & {
  country: string;
  court: string;
  language: string | null;
  languageAlternates: readonly unknown[] | null;
};

/** A language segment only for decisions published in several languages. */
export const createCaseLawDecisionRouteParams = ({
  caseNumber,
  country,
  court,
  decisionId,
  language,
  languageAlternates,
  slug,
}: CaseLawDecisionRouteInput): CaseLawDecisionRouteParams => {
  const baseParams = {
    country: country.toLowerCase(),
    court:
      court.trim().length > 0
        ? createCaseLawDecisionSlug(court)
        : UNKNOWN_COURT_SEGMENT,
    slug: createCaseLawDecisionRouteParam({ caseNumber, decisionId, slug }),
  };

  const languageSegment = normalizeCaseLawLanguageSegment(language);
  if (
    languageSegment === null ||
    getCaseLawLanguageAlternateCount(languageAlternates) <= 1
  ) {
    return baseParams;
  }

  return { ...baseParams, language: languageSegment };
};

export const createCaseLawDecisionPath = ({
  country,
  court,
  language,
  slug,
}: CaseLawDecisionRouteParams): `/law/${string}/cases/${string}/${string}` => {
  if (language) {
    return `/law/${country}/cases/${court}/${language}/${slug}`;
  }

  return `/law/${country}/cases/${court}/${slug}`;
};

const decodePathSegment = (segment: string): string | null =>
  Result.try(() => decodeURIComponent(segment)).unwrapOr(null);

/**
 * The inverse of `createCaseLawDecisionPath`: the route params a decision
 * page's path carries, null for any other path. A five-segment path is the
 * bare form; six segments carry a language between the court and the slug,
 * and only when that segment is one the route would have produced.
 */
export const parseCaseLawDecisionPath = (
  pathname: string,
): CaseLawDecisionRouteParams | null => {
  const [law, country, cases, court, fourth, fifth, ...rest] = pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodePathSegment);
  if (
    law !== "law" ||
    cases !== "cases" ||
    !country ||
    !court ||
    !fourth ||
    rest.length > 0
  ) {
    return null;
  }

  if (fifth === undefined) {
    return { country, court, slug: fourth };
  }

  if (!fifth || normalizeCaseLawLanguageSegment(fourth) !== fourth) {
    return null;
  }

  return { country, court, language: fourth, slug: fifth };
};
