import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import {
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
} from "@stll/api-contract/legislation-expression";
import type { LegislationInconsistentVersion } from "@stll/api-contract/legislation-expression";
import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { projectInconsistentVersion } from "@/api/handlers/legislation/catalog-response";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { status } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import { publishedLegislationDocumentFor } from "@/api/lib/legal-search/legislation-redistribution";
import {
  eligibleExpression,
  inForceOn,
  legislationVersionRef,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import { selectInconsistentWindowVersions } from "@/api/lib/legal-search/legislation-window-gap";
import { legislationWorkIdentifierCondition } from "@/api/lib/legal-search/legislation-work-identifiers";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";

export const readStatuteByEliQuerySchema = v.object({
  eli: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  language: v.optional(v.pipe(v.string(), v.minLength(2), v.maxLength(8))),
  asOf: v.optional(apiDateSchema),
});

type ReadStatuteByEliQuery = v.InferOutput<typeof readStatuteByEliQuerySchema>;

/**
 * Which Expression a Work-plus-date address names, or why it names none.
 *
 * The cases are not interchangeable: a caller who asked for a date the
 * corpus does not cover needs to hear that the act exists, a caller who
 * misspelled an ELI needs to hear that it does not, and a caller whose date
 * falls where the publisher's own dates contradict each other needs to hear
 * that, with the versions responsible, rather than that nothing covers it.
 */
export type StatuteExpressionResolution =
  | { type: "expression"; id: SafeId<"legislationDocument"> }
  | { type: "unknown-work" }
  | { type: "uncovered-date" }
  | {
      type: typeof LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT;
      versions: LegislationInconsistentVersion[];
    };

const documentRef = legislationVersionRef(legislationDocuments);

/**
 * The 404 body for a date the publisher's inconsistent windows leave without
 * an in-force reading: the shared message, a code to branch on, and the
 * versions responsible with their stated dates.
 */
export const publisherWindowInconsistentBody = (
  versions: readonly LegislationInconsistentVersion[],
) => ({
  code: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
  message: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
  versions: versions.map(projectInconsistentVersion),
});

/**
 * Point-in-time resolution: the Expression of a Work that applied on a date.
 *
 * The identifier addresses the Work, the date picks the Expression. When more
 * than one window covers the date (an older open-ended consolidation the
 * publisher never closed), the latest opening wins, which is the same rule
 * the listing's current-version anti-join applies. Language is part of the
 * Work key, so it is ordered on rather than left to the planner when the
 * caller does not name one.
 *
 * Exported because the HTTP read and the agent-facing statute tools address
 * statutes the same way: one implementation decides what an ELI plus a date
 * means, so a tool cannot resolve it differently from the reader.
 */
type WorkConditionsOptions = {
  tx: LegislationReadTransaction;
  query: { eli: string; language?: string | undefined };
  surface: PublicCountrySurface;
};

const workConditionsFor = async ({
  tx,
  query: { eli, language },
  surface,
}: WorkConditionsOptions): Promise<SQL[]> => {
  const identity = await legislationWorkIdentifierCondition(tx, eli);
  const conditions = [identity, publishedLegislationDocumentFor(surface)];
  if (language !== undefined) {
    conditions.push(eq(legislationDocuments.language, language));
  }
  return conditions;
};

/**
 * The newest consolidation of a Work by its ELI, whatever its validity window.
 *
 * A caller that wants the amendment history of a Work is not asking about
 * today: a repealed, expired or not-yet-effective act has no applicable
 * Expression and every one of its consolidations is still readable history.
 * So this deliberately ignores validity and answers with the latest window
 * the corpus holds, which is all a Work-walking read needs to establish the
 * Work key from. Every version counts, so a Work whose versions all have
 * inconsistent windows still has a history; an eligible one is preferred, so
 * the Work key comes from a version that can apply whenever one exists.
 */
export const resolveStatuteWorkVersion = async (
  query: { eli: string; language?: string | undefined },
  legislationDb: LegislationReadDb,
  surface: PublicCountrySurface,
): Promise<StatuteExpressionResolution> =>
  await legislationDb(async (tx) => {
    const conditions = await workConditionsFor({ tx, query, surface });
    const [version] = await tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(and(...conditions))
      .orderBy(
        desc(eligibleExpression(documentRef)),
        desc(versionSortKey(legislationDocuments.versionValidFrom)),
        asc(legislationDocuments.language),
        desc(legislationDocuments.id),
      )
      .limit(1);

    return version === undefined
      ? ({ type: "unknown-work" } as const)
      : ({ type: "expression", id: version.id } as const);
  });

export const resolveStatuteExpression = async (
  query: ReadStatuteByEliQuery,
  legislationDb: LegislationReadDb,
  surface: PublicCountrySurface,
): Promise<StatuteExpressionResolution> => {
  const asOf =
    query.asOf === undefined ? sql`CURRENT_DATE` : sql`${query.asOf}::date`;

  return await legislationDb(async (tx) => {
    const workConditions = await workConditionsFor({ tx, query, surface });
    const [expression] = await tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(and(...workConditions, inForceOn(documentRef, asOf)))
      .orderBy(
        desc(versionSortKey(legislationDocuments.versionValidFrom)),
        asc(legislationDocuments.language),
        desc(legislationDocuments.id),
      )
      .limit(1);

    if (expression !== undefined) {
      return { type: "expression", id: expression.id } as const;
    }

    // Why nothing answers is decided before anything else: an inconsistent
    // publisher window is a stated gap, not a date the corpus lacks.
    const inconsistent = await selectInconsistentWindowVersions(tx, {
      conditions: workConditions,
      asOf,
    });
    if (inconsistent.length > 0) {
      return {
        type: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
        versions: inconsistent,
      } as const;
    }

    // Separating "no such work" from "no window covers that date" is the
    // whole answer for a caller who asked for a date before the corpus
    // covers the act.
    const [work] = await tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(and(...workConditions))
      .limit(1);

    return work === undefined
      ? ({ type: "unknown-work" } as const)
      : ({ type: "uncovered-date" } as const);
  });
};

/** The unauthenticated point-in-time read: resolve, then project. */
export const readStatuteByEliHandler = async (
  query: ReadStatuteByEliQuery,
  legislationDb: LegislationReadDb,
) => {
  const resolved = await resolveStatuteExpression(
    query,
    legislationDb,
    "pages",
  );

  if (resolved.type === "unknown-work") {
    return status(404, { message: "Legislation document not found" });
  }

  if (resolved.type === "uncovered-date") {
    return status(404, {
      message: "No version of this legislation was in force on the given date",
    });
  }

  if (resolved.type === LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT) {
    return status(404, publisherWindowInconsistentBody(resolved.versions));
  }

  return await readPublicLegislationHandler(
    resolved.id,
    legislationDb,
    "pages",
  );
};
