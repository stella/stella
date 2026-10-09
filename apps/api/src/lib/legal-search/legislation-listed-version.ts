import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { legislationDocuments } from "@/api/db/schema";
import {
  applicableKind,
  eligibleExpression,
  legislationVersionRef,
  legislationVersionRefAt,
  notWithdrawn,
  openedBy,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";

/** The row a statute listing shows, as the validity predicates address it. */
export const listedLegislationRef = legislationVersionRef(legislationDocuments);
const newerRef = legislationVersionRefAt("newer");

/** Another row of the listed row's Work: `(source, eli, language)`. */
const newerOfSameWork = sql`newer.source_id = ${legislationDocuments.sourceId}
      AND newer.eli = ${legislationDocuments.eli}
      AND newer.language = ${legislationDocuments.language}
      AND newer.id <> ${legislationDocuments.id}`;

/**
 * The row a listing shows per Work: the latest eligible wording that opened
 * on or before `asOf`, whether or not its window is still open. A Work whose
 * last wording closed is listed as ended rather than dropped, so a repealed
 * act stays findable; a Work whose every eligible wording opens after `asOf`
 * is not listed.
 *
 * A Work with no eligible wording at all (every version never took effect,
 * or its publisher windows are inconsistent) is listed by its latest version
 * that opened by `asOf`, preferring a consolidation over a promulgated text,
 * so it stays findable under the validity that says so. Withdrawn versions
 * are never listed, so a Work holding only those is not either.
 *
 * One anti-join over the Work's other rows excludes the listed one on either
 * ground: a later version that outranks it, or (when it is not eligible
 * itself) any eligible version at all. Written as `eligible OR NOT EXISTS
 * (…)` the second ground cannot become a join, and Postgres plans it as a
 * hashed subplan that reads the whole table on every listing; as a second
 * anti-join it costs the facets aggregate a second pass over the table. The
 * listed row never satisfies the second ground itself, so leaving it out of
 * the probe changes nothing.
 *
 * Shared by the listing, the facets and the facet snapshot refresh, so all
 * three count the same row per Work.
 */
export const isLatestOpenedVersionOfWorkAt = (asOf: SQLWrapper): SQL => sql`(
  ${openedBy(listedLegislationRef, asOf)}
  AND ${notWithdrawn(listedLegislationRef)}
) AND NOT EXISTS (
    SELECT 1
    FROM legislation_documents AS newer
    WHERE ${newerOfSameWork}
      AND ((
        ${openedBy(newerRef, asOf)}
        AND ${notWithdrawn(newerRef)}
        AND (${eligibleExpression(newerRef)} OR NOT ${eligibleExpression(listedLegislationRef)})
        AND (
          ${applicableKind(newerRef)},
          ${versionSortKey(newerRef.validFrom)},
          newer.id
        ) > (
          ${applicableKind(listedLegislationRef)},
          ${versionSortKey(legislationDocuments.versionValidFrom)},
          ${legislationDocuments.id}
        )
      ) OR (
        ${eligibleExpression(newerRef)}
        AND NOT ${eligibleExpression(listedLegislationRef)}
      ))
  )`;
