import { panic } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isDated,
  legislationVersionRef,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  planVersionChanges,
  readWorkVersionCandidatesTx,
  refreshWorkVersionChanges,
} from "@/api/lib/legal-search/legislation-version-changes";
import type { LegislationVersionWork } from "@/api/lib/legal-search/legislation-version-changes";
import { brandValidatedLegislationSourceId } from "@/api/lib/safe-id-boundaries";

/**
 * Computes the change summaries of versions stored before ingestion wrote
 * them (`legislation-version-changes.ts`), or whose summary a later write
 * outdated without a refresh landing.
 *
 * Walks the corpus one Work (source and ELI, every language) at a time, in
 * key order, a page of Works per transaction. A report only plans: it counts
 * the summaries that are missing or stale and computes nothing. An apply runs
 * the same refresh ingestion runs. Idempotent: a Work whose summaries are
 * fresh plans nothing, so a repeated run writes nothing and recomputes
 * nothing.
 */

/** Where a walk stands: the last Work it finished. */
export type VersionChangesCursor = {
  sourceId: SafeId<"legislationSource">;
  eli: string;
};

const CURSOR_SEPARATOR = "/";

/**
 * The cursor as a run prints it and `--after` reads it: the source id, a
 * slash, then the ELI. A UUID has no slash, so the first one splits it
 * whatever the ELI holds.
 */
export const encodeVersionChangesCursor = ({
  eli,
  sourceId,
}: VersionChangesCursor): string => `${sourceId}${CURSOR_SEPARATOR}${eli}`;

export const decodeVersionChangesCursor = (
  cursor: string,
): VersionChangesCursor => {
  const separator = cursor.indexOf(CURSOR_SEPARATOR);
  if (separator <= 0 || separator === cursor.length - 1) {
    return panic("A version-changes cursor is <source id>/<eli>");
  }
  const sourceId = brandValidatedLegislationSourceId(
    cursor.slice(0, separator),
  );
  return sourceId === null
    ? panic("A version-changes cursor starts with a source id")
    : { sourceId, eli: cursor.slice(separator + 1) };
};

type VersionChangesBackfillPage = {
  /** The last Work examined; null when the walk reached the end. */
  cursor: VersionChangesCursor | null;
  works: number;
  /** Summaries found missing or stale. */
  planned: number;
  /** Summaries written; always 0 in a report. */
  written: number;
  /** Summaries a concurrent write made obsolete before this one landed. */
  superseded: number;
};

type BackfillVersionChangesPageOptions = {
  db: ScopedDb;
  after: VersionChangesCursor | null;
  /** Works this page examines. */
  pageSize: number;
  apply: boolean;
};

export const backfillVersionChangesPage = async ({
  after,
  apply,
  db,
  pageSize,
}: BackfillVersionChangesPageOptions): Promise<VersionChangesBackfillPage> => {
  // The work/version index leads with (source_id, eli) and holds only dated
  // rows, which are the only ones a summary is kept for.
  const works = await db(
    async (tx) =>
      await tx
        .selectDistinct({
          sourceId: legislationDocuments.sourceId,
          eli: legislationDocuments.eli,
          language: legislationDocuments.language,
        })
        .from(legislationDocuments)
        .where(
          and(
            isDated(legislationVersionRef(legislationDocuments)),
            after === null
              ? undefined
              : sql`(${legislationDocuments.sourceId}, ${legislationDocuments.eli}) > (${after.sourceId}::uuid, ${after.eli})`,
          ),
        )
        .orderBy(
          asc(legislationDocuments.sourceId),
          asc(legislationDocuments.eli),
          asc(legislationDocuments.language),
        )
        // A page ends on a whole Work: the languages of the last one are
        // fetched below rather than cut here.
        .limit(pageSize),
  );
  const last = works.at(-1);
  if (last === undefined) {
    return { cursor: null, works: 0, planned: 0, written: 0, superseded: 0 };
  }
  const lastLanguages = await db(
    async (tx) =>
      await tx
        .selectDistinct({ language: legislationDocuments.language })
        .from(legislationDocuments)
        .where(
          and(
            eq(legislationDocuments.sourceId, last.sourceId),
            eq(legislationDocuments.eli, last.eli),
            isDated(legislationVersionRef(legislationDocuments)),
          ),
        ),
  );
  const versionWorks = new Map<string, LegislationVersionWork>();
  for (const work of [
    ...works,
    ...lastLanguages.map(({ language }) => ({ ...last, language })),
  ]) {
    versionWorks.set(JSON.stringify([work.sourceId, work.eli, work.language]), {
      sourceId: work.sourceId,
      eli: work.eli,
      language: work.language,
    });
  }

  let planned = 0;
  let written = 0;
  let superseded = 0;
  for (const work of versionWorks.values()) {
    if (apply) {
      const refreshed = await refreshWorkVersionChanges({ db, work });
      planned += refreshed.planned;
      written += refreshed.written;
      superseded += refreshed.superseded;
    } else {
      const versions = await db(
        async (tx) => await readWorkVersionCandidatesTx(tx, work),
      );
      planned += planVersionChanges({ versions }).length;
    }
  }

  return {
    cursor: { sourceId: last.sourceId, eli: last.eli },
    works: new Set(works.map((work) => `${work.sourceId}\u0000${work.eli}`))
      .size,
    planned,
    written,
    superseded,
  };
};
