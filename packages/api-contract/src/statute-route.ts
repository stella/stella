import { Result } from "better-result";

import { slugify, stripDiacriticsForSlug } from "@stll/text-normalize";
import { decodeUuidSuffix, encodeCompactUuid } from "@stll/uuid-codec";

/**
 * The single owner of a statute's public route. The API mints persisted
 * slugs and agent-facing URLs from it, the web routes with it, so the two
 * cannot address different pages.
 */

/**
 * The shape a public statute slug may take. The column CHECK, the slug
 * generator, the by-slug route param and the web's stored-slug check all
 * read this one declaration, so nothing can persist a segment the resolver
 * would refuse.
 */
export const STATUTE_SLUG_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";
export const STATUTE_SLUG_MAX_LENGTH = 256;
const STATUTE_SLUG_REGEX = new RegExp(STATUTE_SLUG_PATTERN, "u");

/**
 * Jurisdiction the statutes browser opens on when a route carries no usable
 * country (the shell's statutes link is reachable from country-less pages).
 */
const STATUTES_DEFAULT_COUNTRY = "cze";
const COUNTRY_SEGMENT_PATTERN = /^[a-z]{2,3}$/u;

/** A consolidation opening, as the `/v/` segment spells it. */
const VERSION_SEGMENT_REGEX = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The `--` form: a readable prefix, then the document id compacted, for a
 * document the corpus holds no slug for (its ELI carries no citation, or the
 * backfill has not reached it). Nothing else addresses a statute by id;
 * there is no id-only route.
 */
const ID_ROUTE_PARAM_SEPARATOR = "--";
const ID_ROUTE_PARAM_FALLBACK_PREFIX = "statute";

/**
 * ELIs end in `/<collection>/<year>/<number>` (`/eli/cz/sb/2012/89`), the
 * same tail the act-number lookup matches on. That triple is the citation a
 * lawyer reads the act by, and it identifies the Work within a jurisdiction.
 */
const ELI_CITATION_REGEX = /\/([a-z0-9]{1,32})\/(\d{4})\/(\d{1,6})$/u;

/**
 * The name part of an official title. Czech titles open with the citation
 * (`89/2012 Sb., občanský zákoník`), Slovak titles carry the name alone.
 * The SQL twin is `legislationTitleName` in the API schema; both drop the
 * same prefix so a slug and a title search agree on what the act is called.
 */
const TITLE_CITATION_PREFIX_REGEX = /^[0-9]+\/[0-9]{4} [^,]*, /u;

/** The ELI's citation as a slug segment (`89-2012-sb`), null without one. */
const statuteEliCitation = (eli: string | null): string | null => {
  const match = ELI_CITATION_REGEX.exec(eli?.trim().toLowerCase() ?? "");
  const collection = match?.at(1);
  const year = match?.at(2);
  const number = match?.at(3);
  if (collection === undefined || year === undefined || number === undefined) {
    return null;
  }

  return `${number}-${year}-${collection}`;
};

type CreateStatuteSlugOptions = {
  eli: string;
  title: string;
};

/**
 * The public slug of a statute Work: its citation, then its short name
 * (`89-2012-sb-obcansky-zakonik`).
 *
 * Null when the ELI carries no citation tail. Such a document keeps a null
 * slug and is addressed by the id form; minting a name-only slug would put an
 * act in the global namespace under a segment the resolver cannot make
 * unique.
 *
 * Pure in its inputs and stable across consolidations: every Expression of a
 * Work shares the ELI and, in practice, the title, so all of them derive the
 * same slug and the version routes hang off one segment.
 */
export const createStatuteSlug = ({
  eli,
  title,
}: CreateStatuteSlugOptions): string | null => {
  const citation = statuteEliCitation(eli);
  if (citation === null) {
    return null;
  }

  const name = slugify(
    stripDiacriticsForSlug(title.replace(TITLE_CITATION_PREFIX_REGEX, "")),
    {
      charset: "ascii",
      separator: "-",
      // Leave room for the citation and the joining hyphen, so the citation
      // prefix is never the part that gets clipped.
      maxLength: STATUTE_SLUG_MAX_LENGTH - citation.length - 1,
      fallback: "",
    },
  );

  return name === "" ? citation : `${citation}-${name}`;
};

/** Whether a route param is a slug this corpus could have minted. */
export const isStatuteSlug = (value: string): boolean =>
  value.length <= STATUTE_SLUG_MAX_LENGTH && STATUTE_SLUG_REGEX.test(value);

/**
 * The stored slug, or null when the corpus holds none for this document or
 * holds one the router would not round-trip. Such a document keeps the id
 * form as its canonical address.
 */
export const normalizeStatuteStoredSlug = (
  slug: string | null | undefined,
): string | null => {
  const normalized = slug?.trim().toLowerCase() ?? "";
  return isStatuteSlug(normalized) ? normalized : null;
};

/** The consolidation opening a `/v/` segment names, or null. */
export const normalizeStatuteVersionSegment = (
  version: string | null | undefined,
): string | null => {
  const trimmed = version?.trim() ?? "";
  return VERSION_SEGMENT_REGEX.test(trimmed) ? trimmed : null;
};

/** Country segment for a statutes URL: lower-case ISO code, or the default. */
export const toStatuteCountrySegment = (country: string | null): string => {
  const segment = country?.trim().toLowerCase() ?? "";
  return COUNTRY_SEGMENT_PATTERN.test(segment)
    ? segment
    : STATUTES_DEFAULT_COUNTRY;
};

/** The document id an id-form `$slug` param carries, null for a plain slug. */
export const extractStatuteDocumentIdFromRouteParam = (
  param: string,
): string | null => {
  // Trimmed because the param reaches here URL-decoded, and the decoder takes
  // the segment exactly as it is spelled.
  const decoded = decodeUuidSuffix({
    segment: param.trim(),
    separator: ID_ROUTE_PARAM_SEPARATOR,
  });
  return Result.isError(decoded) ? null : decoded.value;
};

export type StatuteRouteParams = {
  country: string;
  /** A stored slug, or the `<prefix>--<compact-id>` form when there is none. */
  slug: string;
  /** Absent on the canonical address of the latest consolidation. */
  version?: string;
};

/**
 * Every field that can change the URL is required, null when the caller has
 * none, so an omission is a compile error rather than a different page.
 */
export type StatuteRouteInput = {
  country: string | null;
  documentId: string;
  /** The Work identifier, for the readable half of the id form. */
  eli: string | null;
  slug: string | null;
  /**
   * The consolidation opening to address, when the page is not the latest
   * consolidation. The latest one is canonical at the bare slug path.
   */
  version: string | null;
};

/**
 * The route params a statute's public address is built from.
 *
 * A document with a stored slug is addressed by it, and a superseded
 * consolidation hangs a `/v/` opening off it. A document without one is
 * addressed by the id form instead; that form already names one
 * consolidation, so it takes no `/v/` segment. Its prefix is cosmetic: only
 * the compacted id after the last `--` is resolved.
 */
export const createStatuteRouteParams = ({
  country,
  documentId,
  eli,
  slug,
  version,
}: StatuteRouteInput): StatuteRouteParams => {
  const storedSlug = normalizeStatuteStoredSlug(slug);
  const countrySegment = toStatuteCountrySegment(country);

  if (storedSlug === null) {
    // A value that is not an id is carried through as it came: the link is
    // already broken, and swallowing it would hide which row minted it.
    const compacted = encodeCompactUuid(documentId.trim());
    const idSegment = Result.isError(compacted) ? documentId : compacted.value;
    const prefix = statuteEliCitation(eli) ?? ID_ROUTE_PARAM_FALLBACK_PREFIX;
    return {
      country: countrySegment,
      slug: `${prefix}${ID_ROUTE_PARAM_SEPARATOR}${idSegment}`,
    };
  }

  const versionSegment = normalizeStatuteVersionSegment(version);
  return versionSegment === null
    ? { country: countrySegment, slug: storedSlug }
    : { country: countrySegment, slug: storedSlug, version: versionSegment };
};

export const createStatuteIndexPath = (
  country: string | null,
): `/law/${string}/statutes` =>
  `/law/${toStatuteCountrySegment(country)}/statutes`;

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
