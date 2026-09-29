import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  eligibleExpression,
  inForceOn,
  legislationVersionRef,
  openedBy,
  opensAfter,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import { isInconsistentWindowGapOn } from "@/api/lib/legal-search/legislation-window-gap";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";

/**
 * One Work addressed at a date. `key` is the caller's own name for the
 * request, returned with its answer; the corpus never reads it.
 */
export type WorkAtDateRequest = {
  key: string;
  /** The corpus spelling of the jurisdiction: alpha-3. */
  country: string;
  eli: string;
  /** ISO calendar date. */
  asOf: string;
};

/** An eligible version of the same Work opening after the requested date. */
const laterVersion = alias(legislationDocuments, "later_version");

const documentRef = legislationVersionRef(legislationDocuments);
const laterRef = legislationVersionRef(laterVersion);

const resolvedWorkSchema = v.object({
  key: v.string(),
  id: v.pipe(v.string(), v.uuid()),
  in_force: v.boolean(),
});

const inconsistentWorkSchema = v.object({ key: v.string() });

/**
 * What the batch answers: the version each resolved Work applies at its
 * date, and the Works a publisher inconsistency leaves unanswered at theirs.
 * A key in neither found no answer at all.
 */
export type WorksAtDateResolution = {
  idByKey: Map<string, SafeId<"legislationDocument">>;
  inconsistentKeys: Set<string>;
};

const valuesOf = (requests: readonly WorkAtDateRequest[]) =>
  sql.join(
    requests.map(
      (request) =>
        sql`(${request.key}, ${request.country}, ${request.eli}, ${request.asOf}::date)`,
    ),
    sql`, `,
  );

/**
 * The consolidation each requested Work had in force on its own date, in one
 * statement, plus one more for the Works that had none.
 *
 * Only eligible versions answer (`eligibleExpression`): a version that never
 * took effect, one whose publisher window is inconsistent, a withdrawn one or
 * a promulgated text is never returned and never counts as a later version.
 *
 * When no eligible version covers the date, the reason is decided before any
 * fallback: if the Work's latest version opened by then has an inconsistent
 * publisher window, the answer is that inconsistency, naming the versions,
 * rather than an older wording or silence. The versions themselves are named
 * by the single point-in-time read; a batch only needs the reason.
 *
 * Otherwise a Work repealed before that date answers with its last eligible
 * consolidation: a court keeps applying an ended act to the facts it
 * governed, and that wording is the one it read. That fallback holds only
 * past the Work's final eligible consolidation: a date before its first one,
 * or inside a stretch between two consolidations the corpus does not cover,
 * goes unanswered, as the single point-in-time read leaves it.
 *
 * The dates differ per Work, so the windows are joined against a values list
 * rather than folded into one predicate: every request keeps its own `as_of`
 * and the canonical `inForceOn` rule decides all of them at once. The ELI is
 * matched exactly, so one act's number cannot answer for another sharing its
 * digits. Ordering repeats the point-in-time read's tie-break, so a Work
 * resolved here and the same Work resolved by `by-eli` cannot disagree.
 *
 * A request nothing answers (an unknown Work, a date before the corpus covers
 * it, a source not cleared for redistribution) is in neither map.
 */
export const resolveWorksAtDate = async (
  tx: LegislationReadTransaction,
  requests: readonly WorkAtDateRequest[],
): Promise<WorksAtDateResolution> => {
  const idByKey = new Map<string, SafeId<"legislationDocument">>();
  const inconsistentKeys = new Set<string>();
  if (requests.length === 0) {
    return { idByKey, inconsistentKeys };
  }
  if (requests.length > LIMITS.legislationResolveWorksMax) {
    return panic("Too many works to resolve in one batch");
  }

  const inForceAtRequest = inForceOn(documentRef, sql`w.as_of`);

  // sql-perf-allow: bounded by LIMITS.legislationResolveWorksMax exact country and ELI probes
  const resolved = executedRows(
    await tx.execute(sql`
      SELECT DISTINCT ON (w.key)
             w.key AS key,
             ${legislationDocuments.id} AS id,
             ${inForceAtRequest} AS in_force
        FROM (VALUES ${valuesOf(requests)}) AS w(key, country, eli, as_of)
        JOIN ${legislationDocuments}
          ON ${legislationDocuments.country} = w.country
         AND ${legislationDocuments.eli} = w.eli
         AND ${eligibleExpression(documentRef)}
         AND ${openedBy(documentRef, sql`w.as_of`)}
        JOIN ${legislationSources}
          ON ${legislationSources.id} = ${legislationDocuments.sourceId}
       WHERE ${publishedLegislationDocument}
         AND (${inForceAtRequest}
              OR NOT EXISTS (
                SELECT 1
                  FROM ${legislationDocuments} AS ${laterVersion}
                 WHERE ${laterVersion.country} = w.country
                   AND ${laterVersion.eli} = w.eli
                   AND ${eligibleExpression(laterRef)}
                   AND ${opensAfter(laterRef, sql`w.as_of`)}
              ))
       ORDER BY w.key,
                ${inForceAtRequest} DESC,
                ${versionSortKey(legislationDocuments.versionValidFrom)} DESC,
                ${legislationDocuments.language} ASC,
                ${legislationDocuments.id} DESC
    `),
  ).map((row) => v.parse(resolvedWorkSchema, row));

  const fallbackByKey = new Map<string, SafeId<"legislationDocument">>();
  for (const { key, id, in_force: inForce } of resolved) {
    (inForce ? idByKey : fallbackByKey).set(
      key,
      brandPersistedLegislationDocumentId(id),
    );
  }

  // The gap reason outranks the ended-act fallback: a fallback wording would
  // hide that the publisher's own dates leave this date unanswered.
  const unanswered = requests.filter((request) => !idByKey.has(request.key));
  if (unanswered.length > 0) {
    const inconsistent = executedRows(
      await tx.execute(sql`
        SELECT DISTINCT w.key AS key
          FROM (VALUES ${valuesOf(unanswered)}) AS w(key, country, eli, as_of)
          JOIN ${legislationDocuments}
            ON ${legislationDocuments.country} = w.country
           AND ${legislationDocuments.eli} = w.eli
           AND ${isInconsistentWindowGapOn(sql`w.as_of`)}
          JOIN ${legislationSources}
            ON ${legislationSources.id} = ${legislationDocuments.sourceId}
         WHERE ${publishedLegislationDocument}
      `),
    ).map((row) => v.parse(inconsistentWorkSchema, row));

    for (const { key } of inconsistent) {
      inconsistentKeys.add(key);
    }
  }

  for (const [key, id] of fallbackByKey) {
    if (!inconsistentKeys.has(key)) {
      idByKey.set(key, id);
    }
  }

  return { idByKey, inconsistentKeys };
};
