import { panic, Result, TaggedError } from "better-result";
import type { InferOk } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  isDated,
  legislationVersionRef,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  planVersionChangeTasks,
  prepareVersionChanges,
  versionChangeWorkKey,
  writePreparedVersionChangesTx,
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

type VersionChangesPageOptions = {
  db: ScopedDb;
  after: VersionChangesCursor | null;
  /** Works this page examines. */
  pageSize: number;
};

export const VERSION_CHANGE_WORK_PAGE_MAX = 100;
const WORK_LANGUAGE_VARIANTS_MAX = 256;

class VersionChangeLanguageLimitError extends TaggedError(
  "VersionChangeLanguageLimitError",
)<{ message: string }> {}

export const planVersionChangesPage = async ({
  after,
  db,
  pageSize,
}: VersionChangesPageOptions) => {
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
        .limit(Math.min(pageSize, VERSION_CHANGE_WORK_PAGE_MAX)),
  );
  const last = works.at(-1);
  if (last === undefined) {
    return Result.ok({ after, cursor: null, works: 0, tasks: [] });
  }
  const languageResult = await db(
    async (tx) =>
      await readBounded(
        tx
          .selectDistinct({ language: legislationDocuments.language })
          .from(legislationDocuments)
          .where(
            and(
              eq(legislationDocuments.sourceId, last.sourceId),
              eq(legislationDocuments.eli, last.eli),
              isDated(legislationVersionRef(legislationDocuments)),
            ),
          ),
        WORK_LANGUAGE_VARIANTS_MAX,
      ),
  );
  if (languageResult.type === "overflow") {
    return Result.err(
      new VersionChangeLanguageLimitError({
        message: "A work exceeds the language-variant batch bound",
      }),
    );
  }
  const lastLanguages = languageResult.rows;
  const versionWorks = new Map<string, LegislationVersionWork>();
  for (const work of [
    ...works,
    ...lastLanguages.map(({ language }) => ({ ...last, language })),
  ]) {
    versionWorks.set(versionChangeWorkKey(work), {
      sourceId: work.sourceId,
      eli: work.eli,
      language: work.language,
    });
  }

  const taskPlan = await planVersionChangeTasks({
    db,
    works: [...versionWorks.values()],
  });
  if (taskPlan.isErr()) {
    return Result.err(taskPlan.error);
  }
  const tasks = taskPlan.value;
  return Result.ok({
    after,
    cursor: { sourceId: last.sourceId, eli: last.eli },
    works: new Set(works.map((work) => `${work.sourceId}\u0000${work.eli}`))
      .size,
    tasks,
  });
};

/** All object I/O finishes before entering the checkpoint transaction. */
export const prepareVersionChangesPage = async (
  options: VersionChangesPageOptions,
) => {
  const planned = await planVersionChangesPage(options);
  if (planned.isErr()) {
    return Result.err(planned.error);
  }
  const page = planned.value;
  const preparation = await prepareVersionChanges({
    db: options.db,
    tasks: page.tasks,
  });
  if (preparation.isErr()) {
    return Result.err(preparation.error);
  }
  const writes = preparation.value;
  return Result.ok({ page, writes });
};

type PreparedVersionChangesPage = InferOk<
  Awaited<ReturnType<typeof prepareVersionChangesPage>>
>;

/** The caller checks the prepared cursor against its locked durable checkpoint. */
export const applyVersionChangesPageTx = async (
  tx: Transaction,
  { page, writes }: PreparedVersionChangesPage,
): Promise<VersionChangesBackfillPage> => {
  const written = await writePreparedVersionChangesTx(tx, writes);
  return {
    cursor: page.cursor,
    works: page.works,
    planned: page.tasks.length,
    written,
    superseded: page.tasks.length - written,
  };
};

/** A page of works shares candidate and payload reads across every comparison. */
export const backfillVersionChangesPage = async ({
  apply,
  ...options
}: VersionChangesPageOptions & {
  apply: boolean;
}) => {
  if (apply) {
    const preparation = await prepareVersionChangesPage(options);
    if (preparation.isErr()) {
      return Result.err(preparation.error);
    }
    const prepared = preparation.value;
    return Result.ok(
      await options.db(
        async (tx) => await applyVersionChangesPageTx(tx, prepared),
      ),
    );
  }
  const planned = await planVersionChangesPage(options);
  if (planned.isErr()) {
    return Result.err(planned.error);
  }
  const page = planned.value;
  return Result.ok({
    cursor: page.cursor,
    works: page.works,
    planned: page.tasks.length,
    written: 0,
    superseded: 0,
  });
};
