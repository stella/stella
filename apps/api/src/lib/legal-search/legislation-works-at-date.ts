import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  inForceOn,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
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

/** A consolidation of the same Work opening after the requested date. */
const laterVersion = alias(legislationDocuments, "later_version");

const resolvedWorkSchema = v.object({
  key: v.string(),
  id: v.pipe(v.string(), v.uuid()),
});

/**
 * The consolidation each requested Work had in force on its own date, in one
 * statement.
 *
 * A Work repealed before that date answers with its last consolidation: a
 * court keeps applying an ended act to the facts it governed, and that
 * wording is the one it read. That fallback holds only past the Work's final
 * consolidation: a date before its first one, or inside a stretch between two
 * consolidations the corpus does not cover, goes unanswered, as the single
 * point-in-time read leaves it.
 *
 * The dates differ per Work, so the windows are joined against a values list
 * rather than folded into one predicate: every request keeps its own `as_of`
 * and the canonical `inForceOn` rule decides all of them at once. The ELI is
 * matched exactly, so one act's number cannot answer for another sharing its
 * digits. Ordering repeats the point-in-time read's tie-break, so a Work
 * resolved here and the same Work resolved by `by-eli` cannot disagree.
 *
 * A request no consolidation answers (an unknown Work, a date before the
 * corpus covers it, a source not cleared for redistribution) is absent from
 * the map.
 */
export const resolveWorksAtDate = async (
  tx: LegislationReadTransaction,
  requests: readonly WorkAtDateRequest[],
): Promise<Map<string, SafeId<"legislationDocument">>> => {
  const idByKey = new Map<string, SafeId<"legislationDocument">>();
  if (requests.length === 0) {
    return idByKey;
  }

  const values = sql.join(
    requests.map(
      (request) =>
        sql`(${request.key}, ${request.country}, ${request.eli}, ${request.asOf}::date)`,
    ),
    sql`, `,
  );

  const resolved = executedRows(
    await tx.execute(sql`
      SELECT DISTINCT ON (w.key) w.key AS key, ${legislationDocuments.id} AS id
        FROM (VALUES ${values}) AS w(key, country, eli, as_of)
        JOIN ${legislationDocuments}
          ON ${legislationDocuments.country} = w.country
         AND ${legislationDocuments.eli} = w.eli
         AND (${legislationDocuments.versionValidFrom} IS NULL
              OR ${legislationDocuments.versionValidFrom} <= w.as_of)
        JOIN ${legislationSources}
          ON ${legislationSources.id} = ${legislationDocuments.sourceId}
       WHERE ${publishedLegislationDocument}
         AND (${inForceOn(
           legislationDocuments.versionValidFrom,
           legislationDocuments.versionValidTo,
           sql`w.as_of`,
         )}
              OR NOT EXISTS (
                SELECT 1
                  FROM ${legislationDocuments} AS ${laterVersion}
                 WHERE ${laterVersion.country} = w.country
                   AND ${laterVersion.eli} = w.eli
                   AND ${laterVersion.versionValidFrom} > w.as_of
              ))
       ORDER BY w.key,
                ${inForceOn(
                  legislationDocuments.versionValidFrom,
                  legislationDocuments.versionValidTo,
                  sql`w.as_of`,
                )} DESC,
                ${versionSortKey(legislationDocuments.versionValidFrom)} DESC,
                ${legislationDocuments.language} ASC,
                ${legislationDocuments.id} DESC
    `),
  ).map((row) => v.parse(resolvedWorkSchema, row));

  for (const { key, id } of resolved) {
    idByKey.set(key, brandPersistedLegislationDocumentId(id));
  }

  return idByKey;
};
