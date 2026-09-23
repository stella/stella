import { and, asc, desc, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import {
  isStatuteSlug,
  STATUTE_SLUG_MAX_LENGTH,
} from "@stll/api-contract/statute-route";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import {
  selectDefaultVersionId,
  workKeyConditions,
} from "@/api/handlers/legislation/work-key";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  inForceOn,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

export const readStatuteBySlugParamsSchema = t.Object({
  slug: t.String({ minLength: 1, maxLength: STATUTE_SLUG_MAX_LENGTH }),
});

export const readStatuteBySlugQuerySchema = t.Object({
  country: tPublicLawCountry,
  /** Absent means the version in force today, else the latest one. */
  asOf: t.Optional(t.String({ format: "date" })),
});

type ReadStatuteBySlugQuery = Static<typeof readStatuteBySlugQuerySchema>;

type ReadStatuteBySlugOptions = {
  legislationDb: LegislationReadDb;
  params: Static<typeof readStatuteBySlugParamsSchema>;
  query: ReadStatuteBySlugQuery;
};

/**
 * The public reader's address for a statute: a jurisdiction and the readable
 * segment its Work is known by, optionally read at a date.
 *
 * Resolution is two steps, because the slug addresses the Work while the
 * date picks the Expression. The first step finds any row carrying the
 * segment and takes its Work key; the second applies the same window rule
 * `by-eli` does over the whole Work, so both entry points cannot disagree
 * about which consolidation a date names.
 *
 * Without a date the version in force today answers, falling back to the
 * latest consolidation when none is in force: a repealed act still has a
 * public page, and its last text is what that page shows.
 */
export const readStatuteBySlugHandler = async ({
  legislationDb,
  params: { slug },
  query,
}: ReadStatuteBySlugOptions) => {
  // A segment outside the minted shape matches no row by construction, so it
  // is answered before it costs a query.
  if (!isStatuteSlug(slug)) {
    return status(404, { message: "Legislation document not found" });
  }

  const countryRead = readPublicLawCountry(query.country, {
    admitted: PUBLIC_LEGISLATION_COUNTRIES,
  });
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  const country = countryRead.country;
  const asOf = query.asOf;

  const resolved = await legislationDb(async (tx) => {
    // The segment is not unique by itself: a Work's consolidations all carry
    // it. Ordering makes the pick deterministic, so two identically named
    // Works in one jurisdiction always resolve to the same one rather than
    // to whatever the planner returned first.
    const [work] = await tx
      .select({
        sourceId: legislationDocuments.sourceId,
        eli: legislationDocuments.eli,
        language: legislationDocuments.language,
      })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          eq(legislationDocuments.country, country),
          eq(legislationDocuments.slug, slug),
          publishedLegislationDocument,
        ),
      )
      .orderBy(asc(legislationDocuments.eli), asc(legislationDocuments.id))
      .limit(1);

    if (work === undefined) {
      return { type: "unknown-work" } as const;
    }

    if (asOf === undefined) {
      const defaultId = await selectDefaultVersionId(tx, work);
      return defaultId === null
        ? ({ type: "uncovered-date" } as const)
        : ({ type: "expression", id: defaultId } as const);
    }

    const conditions = workKeyConditions(work);
    conditions.push(
      inForceOn(
        legislationDocuments.versionValidFrom,
        legislationDocuments.versionValidTo,
        sql`${asOf}::date`,
      ),
    );

    const [expression] = await tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .where(and(...conditions))
      .orderBy(
        desc(versionSortKey(legislationDocuments.versionValidFrom)),
        desc(legislationDocuments.id),
      )
      .limit(1);

    return expression === undefined
      ? ({ type: "uncovered-date" } as const)
      : ({ type: "expression", id: expression.id } as const);
  });

  if (resolved.type === "unknown-work") {
    return status(404, { message: "Legislation document not found" });
  }

  // Separating "no such act" from "no window covers that date" is the whole
  // answer for a reader who asked for a date the corpus does not cover.
  if (resolved.type === "uncovered-date") {
    return status(404, {
      message: "No version of this legislation was in force on the given date",
    });
  }

  return await readPublicLegislationHandler(resolved.id, legislationDb);
};
