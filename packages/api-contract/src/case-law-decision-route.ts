import { panic, Result } from "better-result";

import { slugify, stripDiacriticsForSlug } from "@stll/text-normalize";
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

const CASE_LAW_SLUG_OPTIONS = {
  charset: "ascii",
  fallback: UNKNOWN_SLUG,
  maxLength: Number.MAX_SAFE_INTEGER,
  separator: "-",
} as const;

/**
 * The case-law slug fold: persisted slugs and every URL segment that
 * addresses them. NFKD strip is single-homed in stripDiacriticsForSlug, so a
 * spacing diacritic is removed rather than splitting a word; slugify then
 * transliterates the Latin letters no decomposition reaches (`Łd` is `ld`).
 */
export const createCaseLawDecisionSlug = (value: string): string =>
  fitCaseLawDecisionSlug({
    baseSlug: slugify(stripDiacriticsForSlug(value), CASE_LAW_SLUG_OPTIONS),
  });

const NON_ASCII_ALPHANUMERIC = /[^a-z0-9]/gu;

/**
 * The fold before transliteration, which turned every letter NFKD cannot
 * strip (`Ł`, `ø`, `ß`) into a separator: `III SA/Łd 223/21` was
 * `iii-sa-d-223-21`. Only for recognising the court segments and id-form
 * prefixes it published, which are recomputed per request, so their links
 * redirect permanently instead of temporarily; stored slugs are never
 * re-derived and need no legacy form.
 *
 * Remove once request logs show no old-fold segment for 90 days. Links that
 * still carry one keep working afterwards, through the temporary canonical
 * redirect every other non-canonical decision path gets.
 */
export const legacyCaseLawSlug = (value: string): string =>
  fitCaseLawDecisionSlug({
    baseSlug: slugify(
      stripDiacriticsForSlug(value)
        .toLowerCase()
        .replaceAll(NON_ASCII_ALPHANUMERIC, " "),
      CASE_LAW_SLUG_OPTIONS,
    ),
  });

/** One of the two folds above; route params are built under either. */
type CaseLawSlugFold = (value: string) => string;

const normalizeCaseLawStoredSlug = (
  slug: string | null | undefined,
  fold: CaseLawSlugFold,
): string | null => (slug?.trim() ? fold(slug) : null);

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

const resolveCaseLawDecisionRouteIdentity = (
  { caseNumber, decisionId, slug }: CaseLawDecisionRouteIdentityInput,
  fold: CaseLawSlugFold,
): CaseLawDecisionRouteIdentity => {
  const storedSlug = normalizeCaseLawStoredSlug(slug, fold);
  return storedSlug === null
    ? { kind: "id", caseNumber, decisionId }
    : { kind: "slug", slug: storedSlug };
};

const createCaseLawDecisionRouteParam = (
  input: CaseLawDecisionRouteIdentityInput,
  fold: CaseLawSlugFold,
): string => {
  const identity = resolveCaseLawDecisionRouteIdentity(input, fold);
  switch (identity.kind) {
    case "slug":
      return identity.slug;
    case "id":
      return `${fold(identity.caseNumber)}${ID_ROUTE_PARAM_SEPARATOR}${encodeCaseLawDecisionIdForRoute(identity.decisionId)}`;
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

/** All the route reads of a language version: which language it is in. */
export type CaseLawDecisionLanguageAlternate = { language: string };

const getCaseLawLanguageAlternateCount = (
  languageAlternates: readonly CaseLawDecisionLanguageAlternate[] | null,
): number => {
  if (!languageAlternates) {
    return 0;
  }

  const languages = new Set<string>();
  for (const alternate of languageAlternates) {
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
  languageAlternates: readonly CaseLawDecisionLanguageAlternate[] | null;
};

const createRouteParamsUnderFold = (
  {
    caseNumber,
    country,
    court,
    decisionId,
    language,
    languageAlternates,
    slug,
  }: CaseLawDecisionRouteInput,
  fold: CaseLawSlugFold,
): CaseLawDecisionRouteParams => {
  const baseParams = {
    country: country.toLowerCase(),
    court: court.trim().length > 0 ? fold(court) : UNKNOWN_COURT_SEGMENT,
    slug: createCaseLawDecisionRouteParam(
      { caseNumber, decisionId, slug },
      fold,
    ),
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

/** A language segment only for decisions published in several languages. */
export const createCaseLawDecisionRouteParams = (
  input: CaseLawDecisionRouteInput,
): CaseLawDecisionRouteParams =>
  createRouteParamsUnderFold(input, createCaseLawDecisionSlug);

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

/** How a requested decision path relates to the decision's canonical path. */
export const CASE_LAW_DECISION_PATH_MATCH = {
  /** The canonical path itself. */
  CANONICAL: "canonical",
  /** The path the pre-transliteration fold published for this decision. */
  LEGACY_FOLD: "legacy-fold",
  /** Any other path that reached the decision: id form, stale segment. */
  OTHER: "other",
} as const;

export type CaseLawDecisionPathMatch =
  | { type: typeof CASE_LAW_DECISION_PATH_MATCH.CANONICAL }
  | {
      type:
        | typeof CASE_LAW_DECISION_PATH_MATCH.LEGACY_FOLD
        | typeof CASE_LAW_DECISION_PATH_MATCH.OTHER;
      canonical: CaseLawDecisionRouteParams;
    };

type MatchCaseLawDecisionPathOptions = {
  decision: CaseLawDecisionRouteInput;
  requested: CaseLawDecisionRouteParams;
};

/**
 * Whether a request reached the decision at its canonical path, at the path
 * the old fold published for it (`legacyCaseLawSlug`), or elsewhere. A
 * non-canonical answer carries the canonical params, derived from the
 * decision alone, so a redirect built from them cannot be steered by the
 * request.
 */
export const matchCaseLawDecisionPath = ({
  decision,
  requested,
}: MatchCaseLawDecisionPathOptions): CaseLawDecisionPathMatch => {
  const requestedPath = createCaseLawDecisionPath(requested);
  const canonical = createCaseLawDecisionRouteParams(decision);
  if (requestedPath === createCaseLawDecisionPath(canonical)) {
    return { type: CASE_LAW_DECISION_PATH_MATCH.CANONICAL };
  }
  const legacy = createRouteParamsUnderFold(decision, legacyCaseLawSlug);
  return requestedPath === createCaseLawDecisionPath(legacy)
    ? { type: CASE_LAW_DECISION_PATH_MATCH.LEGACY_FOLD, canonical }
    : { type: CASE_LAW_DECISION_PATH_MATCH.OTHER, canonical };
};
