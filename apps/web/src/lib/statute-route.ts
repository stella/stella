import { Result } from "better-result";

import { isPublicLegislationCountry } from "@stll/api-contract/legislation-publication";
import { decodeCompactUuid, encodeCompactUuid } from "@stll/uuid-codec";

import type { useFormatter } from "@/i18n/formatting-context";

/**
 * Jurisdiction the statutes browser opens on when the current route carries
 * none (the shell's statutes link is reachable from country-less pages).
 */
export const STATUTES_DEFAULT_COUNTRY = "cze";

/**
 * Jurisdictions the statutes browser covers, as route segments, with the
 * region code their names are rendered from. Order is the picker's order.
 */
export const STATUTE_COUNTRIES = {
  cze: { region: "CZ" },
  svk: { region: "SK" },
} as const satisfies Record<string, { region: string }>;

export type StatuteCountry = keyof typeof STATUTE_COUNTRIES;

export const isStatuteCountry = (value: string): value is StatuteCountry =>
  Object.hasOwn(STATUTE_COUNTRIES, value);

export const isPublicStatuteCountry = (
  value: string,
): value is StatuteCountry =>
  isStatuteCountry(value) && isPublicLegislationCountry(value.toUpperCase());

/**
 * A statute jurisdiction as a reader names it, from its route segment. One
 * helper, because the box and the top-bar menu have to say the same country
 * the same way.
 */
export const statuteCountryName = (
  format: ReturnType<typeof useFormatter>,
  segment: string,
): string =>
  format.displayName(
    isStatuteCountry(segment)
      ? STATUTE_COUNTRIES[segment].region
      : segment.toUpperCase(),
    { type: "region" },
  );

const COUNTRY_SEGMENT_PATTERN = /^[a-z]{2,3}$/u;

// The API's persisted slug shape (see the column CHECK
// `legislation_documents_slug_shape` and apps/api/.../legislation/slug.ts).
// The web never mints one; it only decides whether a stored value is usable.
const STATUTE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATUTE_SLUG_MAX_LENGTH = 256;

/** A consolidation opening, as the `/v/` segment spells it. */
const VERSION_SEGMENT_REGEX = /^\d{4}-\d{2}-\d{2}$/u;

/** Country segment for a statutes URL: lower-case ISO code, or the default. */
export const toStatuteCountrySegment = (country: string | null): string => {
  const segment = country?.trim().toLowerCase() ?? "";

  return COUNTRY_SEGMENT_PATTERN.test(segment)
    ? segment
    : STATUTES_DEFAULT_COUNTRY;
};

export const createStatuteIndexPath = (
  country: string | null,
): `/law/${string}/statutes` =>
  `/law/${toStatuteCountrySegment(country)}/statutes`;

/**
 * The `--` form: a readable prefix, then the document id compacted, for a
 * document the corpus holds no slug for yet (its ELI carries no citation, or
 * the backfill has not reached it). Nothing else addresses a statute by id;
 * there is no id-only route.
 *
 * The compacting is `@stll/uuid-codec`'s: both public-law readers hand out
 * these segments and they have to decode identically.
 */
const ID_ROUTE_PARAM_SEPARATOR = "--";

/** The document id an id-form `$slug` param carries, null for a plain slug. */
export const extractStatuteDocumentIdFromRouteParam = (
  param: string,
): string | null => {
  const separator = param.lastIndexOf(ID_ROUTE_PARAM_SEPARATOR);
  if (separator === -1) {
    return null;
  }

  // Trimmed because the param reaches here URL-decoded: a pasted address whose
  // segment ended in an encoded space resolved before the codec moved out, and
  // the decoder itself takes the segment exactly as it is spelled.
  const decoded = decodeCompactUuid(
    param.slice(separator + ID_ROUTE_PARAM_SEPARATOR.length).trim(),
  );
  return Result.isError(decoded) ? null : decoded.value;
};

/**
 * The stored slug, or null when the corpus holds none for this document (its
 * ELI carries no citation) or holds one the router would not round-trip. Such
 * a document keeps the id form as its canonical address.
 */
export const normalizeStatuteStoredSlug = (
  slug: string | null | undefined,
): string | null => {
  const trimmed = slug?.trim().toLowerCase() ?? "";

  return trimmed.length > 0 &&
    trimmed.length <= STATUTE_SLUG_MAX_LENGTH &&
    STATUTE_SLUG_REGEX.test(trimmed)
    ? trimmed
    : null;
};

/** The consolidation opening a `/v/` segment names, or null. */
export const normalizeStatuteVersionSegment = (
  version: string | null | undefined,
): string | null => {
  const trimmed = version?.trim() ?? "";

  return VERSION_SEGMENT_REGEX.test(trimmed) ? trimmed : null;
};

export type StatuteRouteParams = {
  country: string;
  /** A stored slug, or the `<prefix>--<compact-id>` form when there is none. */
  slug: string;
  /** Absent on the canonical address of the latest consolidation. */
  version?: string;
};

type CreateStatuteRouteParamsOptions = {
  country: string | null;
  documentId: string;
  /** The Work identifier, for the readable half of the id-form fallback. */
  eli?: string | null | undefined;
  slug?: string | null | undefined;
  /**
   * The consolidation opening to address, when the page is not the latest
   * consolidation. The latest one is canonical at the bare slug path.
   */
  version?: string | null | undefined;
};

/**
 * The readable half of the id form. Cosmetic: only the compacted id after the
 * last `--` is resolved, so this may be anything stable — the act number the
 * ELI ends in, or `statute` when the caller has no identifier at all.
 */
const idRouteParamPrefix = (eli: string | null | undefined): string => {
  const tail = /\/([a-z0-9]{1,32})\/(\d{4})\/(\d{1,6})$/u.exec(
    eli?.trim().toLowerCase() ?? "",
  );
  const collection = tail?.at(1);
  const year = tail?.at(2);
  const number = tail?.at(3);

  return collection === undefined || year === undefined || number === undefined
    ? "statute"
    : `${number}-${year}-${collection}`;
};

/**
 * The route params a statute's public address is built from.
 *
 * A document with a stored slug is addressed by it, and a superseded
 * consolidation hangs a `/v/` opening off it. A document the backfill has not
 * reached carries no slug, so it is addressed by the id form instead; that
 * form already names one consolidation, so it takes no `/v/` segment.
 */
export const createStatuteRouteParams = ({
  country,
  documentId,
  eli,
  slug,
  version,
}: CreateStatuteRouteParamsOptions): StatuteRouteParams => {
  const storedSlug = normalizeStatuteStoredSlug(slug);
  const countrySegment = toStatuteCountrySegment(country);

  if (storedSlug === null) {
    // A value that is not an id is carried through as it came: the link is
    // already broken, and swallowing it would hide which row minted it.
    const compacted = encodeCompactUuid(documentId.trim());
    const idSegment = Result.isError(compacted) ? documentId : compacted.value;
    return {
      country: countrySegment,
      slug: `${idRouteParamPrefix(eli)}${ID_ROUTE_PARAM_SEPARATOR}${idSegment}`,
    };
  }

  const versionSegment = normalizeStatuteVersionSegment(version);

  return versionSegment === null
    ? { country: countrySegment, slug: storedSlug }
    : { country: countrySegment, slug: storedSlug, version: versionSegment };
};

/**
 * One consolidation, as the props a `Link` needs. The `/v/` opening is always
 * named when the row has one: a citation means the wording that applied, and
 * the bare slug names whatever is latest. When the row turns out to be the
 * latest, the loader canonicalises the address; when it is not, this is the
 * only spelling that reaches the right text.
 */
export type StatuteLinkTarget =
  | {
      params: { country: string; slug: string };
      to: "/law/$country/statutes/$slug";
    }
  | {
      params: { country: string; slug: string; version: string };
      to: "/law/$country/statutes/$slug/v/$version";
    };

type CreateStatuteLinkTargetOptions = {
  country: string | null;
  documentId: string;
  eli?: string | null | undefined;
  slug?: string | null | undefined;
  versionValidFrom?: string | null | undefined;
};

export const createStatuteLinkTarget = ({
  country,
  documentId,
  eli,
  slug,
  versionValidFrom,
}: CreateStatuteLinkTargetOptions): StatuteLinkTarget => {
  const params = createStatuteRouteParams({
    country,
    documentId,
    eli,
    slug,
    version: versionValidFrom,
  });

  return params.version === undefined
    ? {
        params: { country: params.country, slug: params.slug },
        to: "/law/$country/statutes/$slug",
      }
    : {
        params: {
          country: params.country,
          slug: params.slug,
          version: params.version,
        },
        to: "/law/$country/statutes/$slug/v/$version",
      };
};

export const createStatutePath = ({
  country,
  slug,
  version,
}: StatuteRouteParams): `/law/${string}/statutes/${string}` => {
  if (version) {
    return `${createStatuteIndexPath(country)}/${slug}/v/${version}`;
  }

  return `${createStatuteIndexPath(country)}/${slug}`;
};
