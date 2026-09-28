import { panic } from "better-result";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  not,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { isUuid } from "@stll/uuid-codec";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationSources,
  schedulerJobs,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK =
  "legislation.backfillExpressionIds" as const;

type BackfillBounds = {
  /** Rows one page walks, in id order. */
  pageRows: number;
  /** Pages one run commits before it yields; each is its own transaction. */
  pagesPerRun: number;
};

const DEFAULT_BOUNDS: BackfillBounds = { pageRows: 1000, pagesPerRun: 10 };

/** `legislation_documents.publisher_expression_id` is `varchar(1024)`. */
const PUBLISHER_ID_MAX_LENGTH = 1024;

type ExpressionIdCursor = SafeId<"legislationDocument"> | null;

const backfillCursor = (
  payload: Record<string, unknown> | null,
): ExpressionIdCursor => {
  const cursor = payload?.["cursor"];
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (typeof cursor !== "string" || !isUuid(cursor)) {
    return panic("Legislation expression id backfill cursor must be a UUID");
  }
  return brandPersistedLegislationDocumentId(cursor);
};

/**
 * Why a row without an id was not given one. Every such row is reported, on
 * every pass, until a writer or an operator settles it: nothing is left
 * behind silently.
 */
export const EXPRESSION_ID_SKIP_REASONS = [
  /** Its source declares no namespace yet. */
  "no-namespace",
  /** It stores no version IRI; its writer has to supply the id. */
  "no-version-iri",
  /** The id would not fit the column. */
  "oversized-id",
  /** Another row of the work carries, or could equally claim, the id. */
  "ambiguous-id",
] as const;

export type ExpressionIdSkipReason =
  (typeof EXPRESSION_ID_SKIP_REASONS)[number];

const isSkipReason = (value: unknown): value is ExpressionIdSkipReason =>
  EXPRESSION_ID_SKIP_REASONS.some((reason) => reason === value);

export type ExpressionIdSkip = {
  reason: ExpressionIdSkipReason;
  documentId: SafeId<"legislationDocument">;
};

export type ExpressionIdPage =
  | {
      type: "page";
      last: SafeId<"legislationDocument">;
      claimed: number;
      skipped: ExpressionIdSkip[];
    }
  | { type: "cycle-complete" };

/**
 * The run summary's attribute per reason. Spelled out rather than derived:
 * the logger drops keys that look sensitive, and `…namespace` is one.
 */
const SKIP_SUMMARY_KEYS = {
  "no-namespace": "legislationExpressionIds.skipped.sourceUnprefixed",
  "no-version-iri": "legislationExpressionIds.skipped.noVersionIri",
  "oversized-id": "legislationExpressionIds.skipped.oversizedId",
  "ambiguous-id": "legislationExpressionIds.skipped.ambiguousId",
} as const satisfies Record<ExpressionIdSkipReason, string>;

/** Document ids one skip log line names; the count is always complete. */
const LOGGED_SKIP_IDS = 20;

/**
 * Give every row of one id-ordered page that has no publisher expression id
 * the one its stored version IRI proves: `<source namespace>:<versionIri>`,
 * and name every row it leaves without one, with the reason.
 *
 * Only rows whose id is still null are touched, so a page replayed after a
 * crash, or racing the writer's own claim of the same row, changes nothing a
 * second time. A row is left alone when its source has no namespace yet, when
 * it stores no IRI (it waits for its writer to supply one), when the id would
 * not fit the column, or when another row of the same work already carries,
 * or could equally claim, that id (the duplicate is left for the census rather
 * than guessed at).
 */
export const claimExpressionIdPageTx = async (
  tx: Transaction,
  cursor: ExpressionIdCursor,
  pageRows: number = DEFAULT_BOUNDS.pageRows,
): Promise<ExpressionIdPage> => {
  const page = await tx
    .select({ id: legislationDocuments.id })
    .from(legislationDocuments)
    .where(cursor === null ? undefined : gt(legislationDocuments.id, cursor))
    .orderBy(asc(legislationDocuments.id))
    .limit(pageRows);
  const last = page.at(-1)?.id;
  if (last === undefined) {
    return { type: "cycle-complete" };
  }

  // Parenthesised: `->>` and `||` share one precedence level.
  const versionIri = sql<string>`(${legislationDocuments.metadata}->>'versionIri')`;
  // One primary-key read of a table that holds a row per publisher.
  const namespace = sql<string | null>`(
    SELECT ${legislationSources.expressionNamespace}
    FROM ${legislationSources}
    WHERE ${legislationSources.id} = ${legislationDocuments.sourceId}
  )`;
  const publisherId = sql<string>`${namespace} || ':' || ${versionIri}`;
  const twin = alias(legislationDocuments, "twin");
  const sibling = alias(legislationDocuments, "sibling");
  // Two unclaimed rows of one work naming the same version: which one it is
  // cannot be told here, so neither is claimed.
  const unclaimedTwin = exists(
    tx
      .select({ id: twin.id })
      .from(twin)
      .where(
        and(
          eq(twin.sourceId, legislationDocuments.sourceId),
          eq(twin.eli, legislationDocuments.eli),
          eq(twin.language, legislationDocuments.language),
          sql`${twin.id} <> ${legislationDocuments.id}`,
          isNull(twin.publisherExpressionId),
          sql`(${twin.metadata}->>'versionIri') = ${versionIri}`,
        ),
      ),
  );
  // Another row of the work already carries the id.
  const claimedSibling = exists(
    tx
      .select({ id: sibling.id })
      .from(sibling)
      .where(
        and(
          eq(sibling.sourceId, legislationDocuments.sourceId),
          eq(sibling.eli, legislationDocuments.eli),
          eq(sibling.language, legislationDocuments.language),
          sql`${sibling.publisherExpressionId} = ${publisherId}`,
        ),
      ),
  );
  // An id that does not fit the column would fail the whole page, and every
  // later run with it.
  const skipReason = sql<string | null>`CASE
    WHEN ${namespace} IS NULL THEN 'no-namespace'
    WHEN coalesce(${versionIri}, '') = '' THEN 'no-version-iri'
    WHEN length(${publisherId}) > ${PUBLISHER_ID_MAX_LENGTH} THEN 'oversized-id'
    WHEN ${unclaimedTwin} OR ${claimedSibling} THEN 'ambiguous-id'
  END`;

  const unclaimed = await tx
    .select({ id: legislationDocuments.id, skipReason })
    .from(legislationDocuments)
    .where(
      and(
        cursor === null ? undefined : gt(legislationDocuments.id, cursor),
        lte(legislationDocuments.id, last),
        isNull(legislationDocuments.publisherExpressionId),
      ),
    );
  const skipped = unclaimed.flatMap(({ id, skipReason: reason }) =>
    reason === null
      ? []
      : [
          {
            reason: isSkipReason(reason)
              ? reason
              : panic("Unknown expression id skip reason", { reason }),
            documentId: id,
          },
        ],
  );
  const claimable = unclaimed
    .filter(({ skipReason: reason }) => reason === null)
    .map(({ id }) => id);

  const claimed =
    claimable.length === 0
      ? []
      : await tx
          .update(legislationDocuments)
          // An identity attachment, not an edit: `updated_at` keeps its value.
          .set({
            publisherExpressionId: publisherId,
            updatedAt: sql`${legislationDocuments.updatedAt}`,
          })
          .where(
            and(
              inArray(legislationDocuments.id, claimable),
              isNull(legislationDocuments.publisherExpressionId),
              // Re-checked in the write: a writer may have stored the id since.
              not(claimedSibling),
            ),
          )
          .returning({ id: legislationDocuments.id });
  return { type: "page", last, claimed: claimed.length, skipped };
};

/**
 * Attach publisher expression ids to legislation rows written without one.
 *
 * Recurring and never gating: writers built before the id existed keep
 * inserting rows without it until they drain, so a finished pass is not a
 * finished backfill. Each page commits with its cursor; after the last page
 * the cursor resets and the next pass starts over, which finds nothing to do
 * once every writer supplies ids. Completion is read from the rows (no null
 * ids left), not from this task.
 */
export const createLegislationExpressionIdBackfill =
  ({ pageRows, pagesPerRun }: BackfillBounds = DEFAULT_BOUNDS): SchedulerTask =>
  async ({ db, job, logger, signal }) => {
    const leaseToken =
      job.lockedBy ??
      panic("Legislation expression id backfill requires a scheduler lease");
    let cursor = backfillCursor(job.payload);
    let claimed = 0;
    let pages = 0;
    const skippedByReason = new Map<ExpressionIdSkipReason, number>(
      EXPRESSION_ID_SKIP_REASONS.map((reason) => [reason, 0]),
    );
    let status: "progress" | "cycle-complete" = "progress";

    while (pages < pagesPerRun) {
      signal.throwIfAborted();
      const pageCursor = cursor;
      const outcome = await db.transaction(async (tx) => {
        const page = await claimExpressionIdPageTx(tx, pageCursor, pageRows);
        // Checkpoint in the page's own transaction: a crash replays the page,
        // which claims nothing twice, and never skips it.
        await tx
          .update(schedulerJobs)
          .set({
            payload: { cursor: page.type === "page" ? page.last : null },
          })
          .where(
            and(
              eq(schedulerJobs.id, job.id),
              eq(schedulerJobs.lockedBy, leaseToken),
            ),
          );
        return page;
      });
      if (outcome.type === "cycle-complete") {
        status = "cycle-complete";
        break;
      }
      pages += 1;
      claimed += outcome.claimed;
      cursor = outcome.last;
      for (const reason of EXPRESSION_ID_SKIP_REASONS) {
        const documentIds = outcome.skipped
          .filter((skip) => skip.reason === reason)
          .map(({ documentId }) => documentId);
        if (documentIds.length === 0) {
          continue;
        }
        skippedByReason.set(
          reason,
          (skippedByReason.get(reason) ?? 0) + documentIds.length,
        );
        logger.warn("scheduler.legislation_expression_ids_skipped", {
          "legislationExpressionIds.reason": reason,
          "legislationExpressionIds.count": documentIds.length,
          "legislationExpressionIds.documentIds": documentIds
            .slice(0, LOGGED_SKIP_IDS)
            .join(","),
        });
      }
    }

    // audit: skip — bounded identity repair derived from stored publisher IRIs;
    // scheduler_job_runs provides the durable operator trail.
    logger.info("scheduler.legislation_expression_ids_backfilled", {
      "legislationExpressionIds.claimed": claimed,
      ...Object.fromEntries(
        [...skippedByReason].map(([reason, count]) => [
          SKIP_SUMMARY_KEYS[reason],
          count,
        ]),
      ),
      "legislationExpressionIds.pages": pages,
      "legislationExpressionIds.status": status,
    });
  };

export const backfillLegislationExpressionIds =
  createLegislationExpressionIdBackfill();
