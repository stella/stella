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

const COUNTRY_SEGMENT_PATTERN = /^[a-z]{2,3}$/u;

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

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
 * Whether a `$slug` route param is the legacy document-id form. A minted slug
 * opens with the act number, so no slug can wear the 8-4-4-4-12 hex shape and
 * the two forms cannot be confused for one another.
 */
export const isStatuteDocumentId = (value: string): boolean =>
  UUID_REGEX.test(value.trim());

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
  /** The stored slug, or the document id when the corpus holds no slug. */
  slug: string;
  /** Absent on the canonical address of the latest consolidation. */
  version?: string;
};

type CreateStatuteRouteParamsOptions = {
  country: string | null;
  documentId: string;
  slug?: string | null | undefined;
  /**
   * The consolidation opening to address, when the page is not the latest
   * consolidation. The latest one is canonical at the bare slug path.
   */
  version?: string | null | undefined;
};

/**
 * The route params a statute's public address is built from. A document with
 * a stored slug canonicalises to it; without one the id form is canonical,
 * which is what keeps a document the backfill has not reached linkable.
 */
export const createStatuteRouteParams = ({
  country,
  documentId,
  slug,
  version,
}: CreateStatuteRouteParamsOptions): StatuteRouteParams => {
  const storedSlug = normalizeStatuteStoredSlug(slug);
  const base = {
    country: toStatuteCountrySegment(country),
    slug: storedSlug ?? documentId,
  };
  const versionSegment = normalizeStatuteVersionSegment(version);

  // The id form addresses one consolidation directly, so a `/v/` segment on
  // it would name the same thing twice.
  if (versionSegment === null || storedSlug === null) {
    return base;
  }

  return { ...base, version: versionSegment };
};

/**
 * The address of one particular consolidation, for a caller that knows which
 * document it is and nothing about where that document sits in its Work's
 * history — the citation links inside a reader, which point at the wording
 * that applied, not at today's.
 *
 * Deliberately the id form: the readable segment names a Work's latest text,
 * so linking a dated citation through it would silently retarget it. The
 * reader's loader resolves the id and replaces it with the consolidation's
 * own readable address.
 */
export const createStatuteDocumentRouteParams = ({
  country,
  documentId,
}: {
  country: string | null;
  documentId: string;
}): StatuteRouteParams => ({
  country: toStatuteCountrySegment(country),
  slug: documentId,
});

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
