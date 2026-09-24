import type { QueryClient } from "@tanstack/react-query";
import { redirect, notFound } from "@tanstack/react-router";
import { panic } from "better-result";
import * as v from "valibot";

import {
  createStatutePath,
  createStatuteRouteParams,
  extractStatuteDocumentIdFromRouteParam,
  normalizeStatuteVersionSegment,
  type StatuteRouteParams,
  toStatuteCountrySegment,
} from "@stll/api-contract/statute-route";
import { parsePlainDate } from "@stll/time";

import {
  publicStatuteOptions,
  statuteBySlugOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import type {
  PublicStatute,
  PublicStatuteVersion,
} from "@/features/statutes/queries/statutes";
import { isStatuteCompareShow } from "@/features/statutes/statute-compare-search";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicLawCanonicalUrl,
  createPublicLawHead,
  createStatuteJsonLd,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { isPublicStatuteCountry } from "@/lib/statute-route";

/**
 * A calendar day, not merely a date-shaped string: `2026-02-30` matches the
 * pattern and is not a day, and the reader must not ask the corpus for it.
 */
const isCalendarDate = (value: string): boolean =>
  parsePlainDate(value) !== null;

const MAX_JUMP_LENGTH = 32;
/** The API's own bound on a provision anchor. */
const MAX_PROVISION_ANCHOR_LENGTH = 256;

/**
 * `asOf` names the day whose law the reader wants. It is a lookup, not an
 * address: the loader resolves it to the consolidation that applied and sends
 * the reader to that consolidation's own URL, so one text has one indexable
 * address. Anything unparseable is dropped rather than rejected — a mistyped
 * link should still open the act.
 */
export const publicStatuteSearchSchema = v.object({
  asOf: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) => (isCalendarDate(value) ? value : undefined)),
    ),
  ),
  /**
   * A provision designation to open at (`§ 2079`), as the statutes box sends
   * it. Read by the outline's jump field; anything it cannot parse just
   * narrows nothing.
   */
  jump: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) =>
        value.length > 0 && value.length <= MAX_JUMP_LENGTH ? value : undefined,
      ),
    ),
  ),
  /**
   * Another consolidation to set beside the one on screen, named by the day
   * its validity window opened. The reader then shows the two wordings side
   * by side instead of the text.
   */
  compare: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform(
        (value) => normalizeStatuteVersionSegment(value) ?? undefined,
      ),
    ),
  ),
  /** The provision heading anchor a comparison is narrowed to. */
  provision: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) =>
        value.length > 0 && value.length <= MAX_PROVISION_ANCHOR_LENGTH
          ? value
          : undefined,
      ),
    ),
  ),
  /** Which provisions a whole-act comparison lists; changed ones by default. */
  show: v.optional(
    v.pipe(
      v.string(),
      v.transform((value) => (isStatuteCompareShow(value) ? value : undefined)),
    ),
  ),
});

type PublicStatuteSearch = v.InferOutput<typeof publicStatuteSearchSchema>;

type PublicStatuteRouteParams = {
  country: string;
  slug: string;
  version?: string;
};

/**
 * What the reader renders. `statute` is null only when the reader asked for a
 * day no consolidation of the Work covers, which is an answer the reader
 * shows against the Work's chrome rather than a failure.
 *
 * `versions` is loaded here rather than in the viewer: the canonical address
 * depends on it, and a component suspending on it after the route resolved
 * would show the reader a second loading pass.
 */
export type PublicStatuteRouteData = {
  statute: PublicStatute | null;
  versions: readonly PublicStatuteVersion[];
  work: PublicStatute;
};

type LoadPublicStatuteRouteOptions = {
  /** The provision anchor the incoming URL carried, `#` included. */
  hash: string;
  params: PublicStatuteRouteParams;
  queryClient: QueryClient;
  search: PublicStatuteSearch;
};

/**
 * A dead statute link leaves the reader with nothing to show results for, so
 * they land where a new entry starts and the miss is named there (the same
 * rule the case-law detail route applies).
 */
const statuteNotFound = (): never => {
  redirect({
    to: "/law",
    search: { notFound: true },
    replace: true,
    throw: true,
  });
  return panic("TanStack Router did not throw a redirect response.");
};

/**
 * The address a consolidation is canonical at: the bare slug path for the
 * Work's default text, its own `/v/` path for every other one.
 *
 * Which text is the default is the API's rule (in force today, else the
 * latest), marked on its row of the version listing by the same query
 * `by-slug` resolves through. It is never re-derived here: the browser's
 * today and the database's can differ, and a copy of the rule would drift.
 */
const canonicalStatuteParams = ({
  statute,
  versions,
}: {
  statute: PublicStatute;
  versions: readonly PublicStatuteVersion[];
}): StatuteRouteParams => {
  const defaultVersion = versions.find((version) => version.isDefault);

  return createStatuteRouteParams({
    country: statute.country,
    documentId: statute.id,
    eli: statute.eli,
    slug: statute.slug,
    version:
      defaultVersion === undefined || defaultVersion.id === statute.id
        ? null
        : statute.versionValidFrom,
  });
};

const currentStatutePath = (params: PublicStatuteRouteParams): string =>
  createStatutePath({
    country: toStatuteCountrySegment(params.country),
    slug: params.slug,
    ...(params.version === undefined ? {} : { version: params.version }),
  });

type RedirectToCanonicalStatutePathOptions = {
  canonicalParams: StatuteRouteParams;
  hash: string;
  search: PublicStatuteSearch;
};

const redirectToCanonicalStatutePath = ({
  canonicalParams,
  hash,
  search,
}: RedirectToCanonicalStatutePathOptions): never => {
  // `asOf` is dropped: it has done its work by naming the consolidation, and
  // carrying it on would make the canonical address ambiguous again. `jump`
  // is where in the text to open, so it survives — and so does the anchor,
  // which is the same instruction spelled as a fragment. A comparison is
  // what to show of that text, so it survives too.
  const redirectSearch = {
    compare: search.compare,
    jump: search.jump,
    provision: search.provision,
    show: search.show,
  };
  const redirectHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const anchor = redirectHash === "" ? {} : { hash: redirectHash };

  if (canonicalParams.version) {
    redirect({
      to: "/law/$country/statutes/$slug/v/$version",
      params: {
        country: canonicalParams.country,
        slug: canonicalParams.slug,
        version: canonicalParams.version,
      },
      replace: true,
      search: redirectSearch,
      ...anchor,
      throw: true,
    });
  }

  redirect({
    to: "/law/$country/statutes/$slug",
    params: {
      country: canonicalParams.country,
      slug: canonicalParams.slug,
    },
    replace: true,
    search: redirectSearch,
    ...anchor,
    throw: true,
  });

  return panic("TanStack Router did not throw a redirect response.");
};

type SettleStatuteRouteOptions = LoadPublicStatuteRouteOptions & {
  /** Null when no consolidation of the Work covered the requested day. */
  statute: PublicStatute | null;
  /** A member of the Work, which carries its chrome while no text resolves. */
  work: PublicStatute;
};

/**
 * Send the reader to the address this text is canonical at, or render it when
 * they are already there.
 */
const settleStatuteRoute = async ({
  hash,
  params,
  queryClient,
  search,
  statute,
  work,
}: SettleStatuteRouteOptions): Promise<PublicStatuteRouteData> => {
  const versions = await ensureRouteQueryData(
    queryClient,
    statuteVersionsOptions(work.id),
  );

  if (statute === null) {
    // A `/v/` opening that names no consolidation is not a page at all, so it
    // goes back to the act; a day picked in the reader stays on the act and
    // is answered there.
    if (params.version !== undefined) {
      redirectToCanonicalStatutePath({
        canonicalParams: canonicalStatuteParams({ statute: work, versions }),
        hash,
        search,
      });
    }

    return { statute: null, versions, work };
  }

  const canonicalParams = canonicalStatuteParams({ statute, versions });
  if (
    search.asOf !== undefined ||
    currentStatutePath(params) !== createStatutePath(canonicalParams)
  ) {
    redirectToCanonicalStatutePath({ canonicalParams, hash, search });
  }

  return { statute, versions, work: statute };
};

/**
 * Resolve the statute a public URL names.
 *
 * Three addresses reach this loader and exactly one of them is canonical for
 * any given text: the readable segment (the Work's latest consolidation),
 * that segment plus a `/v/` opening (a superseded consolidation), and the
 * legacy document id. The first two carry a `?asOf` lookup as well.
 * Everything that is not the canonical address redirects to it, so the corpus
 * never offers a crawler two URLs for one text.
 */
export const loadPublicStatuteRoute = async ({
  hash,
  params,
  queryClient,
  search,
}: LoadPublicStatuteRouteOptions): Promise<PublicStatuteRouteData> => {
  const country = toStatuteCountrySegment(params.country);
  if (!isPublicStatuteCountry(country)) {
    notFound({ throw: true });
  }
  const requestedDate =
    normalizeStatuteVersionSegment(params.version) ?? search.asOf;
  const readBySlug = async (slug: string, asOf: string | undefined) =>
    await ensureRouteQueryData(
      queryClient,
      statuteBySlugOptions(
        asOf === undefined ? { country, slug } : { country, slug, asOf },
      ),
    );

  // The id form addresses one consolidation of a Work the corpus holds no
  // slug for. It names that text directly, so a date cannot narrow it; once
  // the backfill mints a slug, the canonical address below moves the reader on.
  const routeDocumentId = extractStatuteDocumentIdFromRouteParam(params.slug);
  if (routeDocumentId !== null) {
    const addressed = await ensureRouteQueryData(
      queryClient,
      publicStatuteOptions(routeDocumentId),
    );

    if (addressed === null) {
      return statuteNotFound();
    }

    return await settleStatuteRoute({
      hash,
      params,
      queryClient,
      search,
      statute: addressed,
      work: addressed,
    });
  }

  const addressed = await readBySlug(params.slug, requestedDate);
  if (addressed !== null) {
    return await settleStatuteRoute({
      hash,
      params,
      queryClient,
      search,
      statute: addressed,
      work: addressed,
    });
  }

  if (requestedDate === undefined) {
    return statuteNotFound();
  }

  // Nothing was in force on the requested day; the Work still has chrome to
  // answer with, so it is read without one.
  const work = await readBySlug(params.slug, undefined);
  if (work === null) {
    return statuteNotFound();
  }

  return await settleStatuteRoute({
    hash,
    params,
    queryClient,
    search,
    statute: null,
    work,
  });
};

export const createPublicStatuteHead = ({
  statute,
  versions,
  work,
}: PublicStatuteRouteData) => {
  const header = statute ?? work;
  // The canonical URL names the consolidation on screen, which a dated
  // request need not be the one the path was entered with.
  const path = createStatutePath(
    canonicalStatuteParams({ statute: header, versions }),
  );
  const canonicalUrl = createPublicLawCanonicalUrl(path);

  return createPublicLawHead({
    description: header.title,
    jsonLd: createStatuteJsonLd({
      canonicalUrl,
      country: header.country,
      documentType: header.documentType,
      eli: header.eli,
      language: header.language,
      sourceUrl: header.sourceUrl,
      title: header.title,
      versionValidFrom: header.versionValidFrom,
    }),
    path,
    title: pageTitleLiteral(header.title),
    type: "article",
  });
};
