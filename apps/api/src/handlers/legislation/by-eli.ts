import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import {
  inForceOn,
  versionSortKey,
} from "@/api/handlers/legislation/validity-window";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

export const readStatuteByEliQuerySchema = t.Object({
  eli: t.String({ minLength: 1, maxLength: 512 }),
  language: t.Optional(t.String({ minLength: 2, maxLength: 8 })),
  /** Absent means "the text in force today". */
  asOf: t.Optional(t.String({ format: "date" })),
});

type ReadStatuteByEliQuery = Static<typeof readStatuteByEliQuerySchema>;

/**
 * Point-in-time read: the Expression of a Work that applied on a given date.
 *
 * The identifier addresses the Work, the date picks the Expression. When more
 * than one window covers the date (an older open-ended consolidation the
 * publisher never closed), the latest opening wins, which is the same rule
 * the listing's current-version anti-join applies. Language is part of the
 * Work key, so it is ordered on rather than left to the planner when the
 * caller does not name one.
 */
export const readStatuteByEliHandler = async (
  query: ReadStatuteByEliQuery,
  legislationDb: LegislationReadDb,
) => {
  const asOf =
    query.asOf === undefined ? sql`CURRENT_DATE` : sql`${query.asOf}::date`;

  const workConditions: SQL[] = [
    eq(legislationDocuments.eli, query.eli),
    redistributableLegislationSource,
  ];

  if (query.language !== undefined) {
    workConditions.push(eq(legislationDocuments.language, query.language));
  }

  const resolved = await legislationDb(async (tx) => {
    const [expression] = await tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          ...workConditions,
          inForceOn(
            legislationDocuments.versionValidFrom,
            legislationDocuments.versionValidTo,
            asOf,
          ),
        ),
      )
      .orderBy(
        desc(versionSortKey(legislationDocuments.versionValidFrom)),
        asc(legislationDocuments.language),
        desc(legislationDocuments.id),
      )
      .limit(1);

    if (expression !== undefined) {
      return { type: "expression", id: expression.id } as const;
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

  if (resolved.type === "unknown-work") {
    return status(404, { message: "Legislation document not found" });
  }

  if (resolved.type === "uncovered-date") {
    return status(404, {
      message: "No version of this legislation was in force on the given date",
    });
  }

  return await readPublicLegislationHandler(resolved.id, legislationDb);
};
