import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { parsePlainDate } from "@stll/time";

import {
  statuteBySlugOptions,
  statuteOptions,
} from "@/features/statutes/queries/statutes";
import type { PublicStatute } from "@/features/statutes/queries/statutes";
import { APIError } from "@/lib/errors/api";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicLawCanonicalUrl,
  createPublicLawHead,
  createStatuteJsonLd,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  createStatutePath,
  createStatuteRouteParams,
  isStatuteDocumentId,
  normalizeStatuteVersionSegment,
  type StatuteRouteParams,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

/**
 * A calendar day, not merely a date-shaped string: `2026-02-30` matches the
 * pattern and is not a day, and the reader must not ask the corpus for it.
 */
const isCalendarDate = (value: string): boolean =>
  parsePlainDate(value) !== null;

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
      v.maxLength(32),
      v.transform((value) => (value.length > 0 ? value : undefined)),
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
 */
export type PublicStatuteRouteData = {
  statute: PublicStatute | null;
  work: PublicStatute;
};

type LoadPublicStatuteRouteOptions = {
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
  throw redirect({ to: "/law", search: { notFound: true }, replace: true });
};

const ensurePublicStatute = async <T>(load: () => Promise<T>): Promise<T> => {
  try {
    return await load();
  } catch (error) {
    if (error instanceof APIError && error.status === 404) {
      return statuteNotFound();
    }
    throw error;
  }
};

/**
 * The address a consolidation is canonical at: the bare slug path for the
 * open-ended latest text, its own `/v/` path for every superseded one. A
 * closed validity window is exactly "a later consolidation opened", so the
 * flag needs no version listing to compute.
 */
const canonicalStatuteParams = (statute: PublicStatute): StatuteRouteParams =>
  createStatuteRouteParams({
    country: statute.country,
    documentId: statute.id,
    slug: statute.slug,
    version: statute.versionValidTo === null ? null : statute.versionValidFrom,
  });

const currentStatutePath = (params: PublicStatuteRouteParams): string =>
  createStatutePath({
    country: toStatuteCountrySegment(params.country),
    slug: params.slug,
    ...(params.version === undefined ? {} : { version: params.version }),
  });

const redirectToCanonicalStatutePath = ({
  canonicalParams,
  search,
}: {
  canonicalParams: StatuteRouteParams;
  search: PublicStatuteSearch;
}): never => {
  // `asOf` is dropped: it has done its work by naming the consolidation, and
  // carrying it on would make the canonical address ambiguous again. `jump`
  // is where in the text to open, so it survives.
  const redirectSearch = search.jump === undefined ? {} : { jump: search.jump };

  if (canonicalParams.version) {
    throw redirect({
      to: "/law/$country/statutes/$slug/v/$version",
      params: {
        country: canonicalParams.country,
        slug: canonicalParams.slug,
        version: canonicalParams.version,
      },
      replace: true,
      search: redirectSearch,
    });
  }

  throw redirect({
    to: "/law/$country/statutes/$slug",
    params: {
      country: canonicalParams.country,
      slug: canonicalParams.slug,
    },
    replace: true,
    search: redirectSearch,
  });
};

const settleCanonicalPath = ({
  params,
  search,
  statute,
}: {
  params: PublicStatuteRouteParams;
  search: PublicStatuteSearch;
  statute: PublicStatute;
}): void => {
  const canonicalParams = canonicalStatuteParams(statute);

  if (
    search.asOf !== undefined ||
    currentStatutePath(params) !== createStatutePath(canonicalParams)
  ) {
    redirectToCanonicalStatutePath({ canonicalParams, search });
  }
};

/**
 * Resolve the statute a public URL names.
 *
 * Three addresses reach this loader and exactly one of them is canonical for
 * any given text: the readable segment (the latest consolidation), that
 * segment plus a `/v/` opening (a superseded consolidation), and the legacy
 * document id. The first two carry a `?asOf` lookup as well. Everything that
 * is not the canonical address redirects to it, so the corpus never offers a
 * crawler two URLs for one text.
 */
export const loadPublicStatuteRoute = async ({
  params,
  queryClient,
  search,
}: LoadPublicStatuteRouteOptions): Promise<PublicStatuteRouteData> => {
  const country = toStatuteCountrySegment(params.country);

  if (isStatuteDocumentId(params.slug)) {
    const statute = await ensurePublicStatute(
      async () =>
        await ensureRouteQueryData(queryClient, statuteOptions(params.slug)),
    );

    // A document the backfill has not reached has no slug, and the id path is
    // then its canonical address; one with a slug always moves.
    settleCanonicalPath({ params, search, statute });

    return { statute, work: statute };
  }

  const version = normalizeStatuteVersionSegment(params.version);
  const requestedDate = version ?? search.asOf;
  const slugKey = { country, slug: params.slug };
  const statute = await ensureRouteQueryData(
    queryClient,
    statuteBySlugOptions(
      requestedDate === undefined
        ? slugKey
        : { ...slugKey, asOf: requestedDate },
    ),
  );

  if (statute !== null) {
    settleCanonicalPath({ params, search, statute });

    return { statute, work: statute };
  }

  if (requestedDate === undefined) {
    return statuteNotFound();
  }

  // Nothing was in force on the requested day. A `/v/` opening that names no
  // consolidation is not a page at all, so it goes back to the act; a date
  // picked in the reader stays on the act and is answered there.
  const work = await ensureRouteQueryData(
    queryClient,
    statuteBySlugOptions(slugKey),
  );

  if (work === null) {
    return statuteNotFound();
  }

  if (version !== null) {
    redirectToCanonicalStatutePath({
      canonicalParams: canonicalStatuteParams(work),
      search,
    });
  }

  return { statute: null, work };
};

export const createPublicStatuteHead = ({
  statute,
  work,
}: PublicStatuteRouteData) => {
  const header = statute ?? work;
  // The canonical URL names the consolidation on screen, which a dated
  // request need not be the one the path was entered with.
  const path = createStatutePath(canonicalStatuteParams(header));
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
