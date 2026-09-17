import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import type { SafeId } from "@/api/lib/branded-types";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  inForceOn,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

export const readStatuteByEliQuerySchema = t.Object({
  eli: t.String({ minLength: 1, maxLength: 512 }),
  language: t.Optional(t.String({ minLength: 2, maxLength: 8 })),
  /** Absent means "the text in force today". */
  asOf: t.Optional(t.String({ format: "date" })),
});

type ReadStatuteByEliQuery = Static<typeof readStatuteByEliQuerySchema>;

/**
 * Which Expression a Work-plus-date address names, or why it names none.
 *
 * The three cases are not interchangeable: a caller who asked for a date the
 * corpus does not cover needs to hear that the act exists, and a caller who
 * misspelled an ELI needs to hear that it does not.
 */
export type StatuteExpressionResolution =
  | { type: "expression"; id: SafeId<"legislationDocument"> }
  | { type: "unknown-work" }
  | { type: "uncovered-date" };

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
const workConditionsFor = ({
  eli,
  language,
}: {
  eli: string;
  language?: string | undefined;
}): SQL[] => {
  const conditions: SQL[] = [
    eq(legislationDocuments.eli, eli),
    publishedLegislationDocument,
  ];
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
 * Work key from.
 */
export const resolveStatuteWorkVersion = async (
  query: { eli: string; language?: string | undefined },
  legislationDb: LegislationReadDb,
): Promise<StatuteExpressionResolution> => {
  const conditions = workConditionsFor(query);

  return await legislationDb(async (tx) => {
    const [version] = await tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(and(...conditions))
      .orderBy(
        desc(versionSortKey(legislationDocuments.versionValidFrom)),
        asc(legislationDocuments.language),
        desc(legislationDocuments.id),
      )
      .limit(1);

    return version === undefined
      ? ({ type: "unknown-work" } as const)
      : ({ type: "expression", id: version.id } as const);
  });
};

export const resolveStatuteExpression = async (
  query: ReadStatuteByEliQuery,
  legislationDb: LegislationReadDb,
): Promise<StatuteExpressionResolution> => {
  const asOf =
    query.asOf === undefined ? sql`CURRENT_DATE` : sql`${query.asOf}::date`;

  const workConditions = workConditionsFor(query);

  return await legislationDb(async (tx) => {
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
};

/** The unauthenticated point-in-time read: resolve, then project. */
export const readStatuteByEliHandler = async (
  query: ReadStatuteByEliQuery,
  legislationDb: LegislationReadDb,
) => {
  const resolved = await resolveStatuteExpression(query, legislationDb);

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
