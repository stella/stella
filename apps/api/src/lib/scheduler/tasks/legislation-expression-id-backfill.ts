import { panic, Result } from "better-result";
import { and, asc, eq, exists, gt, isNull, lte, not, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Verdict } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";
import { isUuid } from "@stll/uuid-codec";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import {
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
  logSchedulerBackfillStatus,
} from "@/api/lib/scheduler/backfill-config";
import {
  SchedulerTaskFailure,
  type SchedulerTask,
} from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK =
  "legislation.backfillExpressionIds" as const;

type BackfillBounds = {
  /** Rows one run walks, in id order, in one transaction. */
  pageRows?: number;
  createRuntime?: typeof createScriptBackfillRuntime;
  readVerdict?: () => Promise<Verdict>;
  clock?: () => number;
  observeStatus?: typeof logSchedulerBackfillStatus;
};

const DEFAULT_PAGE_ROWS = 1000;
const DEFAULT_BOUNDS = {
  pageRows: DEFAULT_PAGE_ROWS,
} as const satisfies BackfillBounds;

/** A page that left more of the table behind it; the next follows at once. */
const CONTINUATION_DELAY_MS = 1000;

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
const EXPRESSION_ID_SKIP_REASONS = [
  /** Its source declares no namespace yet. */
  "no-namespace",
  /** It stores no version IRI; its writer has to supply the id. */
  "no-version-iri",
  /** The id would not fit the column. */
  "oversized-id",
  /** Another row of the work carries, or could equally claim, the id. */
  "ambiguous-id",
] as const;

type ExpressionIdSkipReason = (typeof EXPRESSION_ID_SKIP_REASONS)[number];

const isSkipReason = (value: unknown): value is ExpressionIdSkipReason =>
  EXPRESSION_ID_SKIP_REASONS.some((reason) => reason === value);

type ExpressionIdSkip = {
  reason: ExpressionIdSkipReason;
  documentId: SafeId<"legislationDocument">;
};

type ExpressionIdPage =
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

/** The rows after the cursor, when there is one. */
const afterCursor = (cursor: ExpressionIdCursor) =>
  cursor === null ? undefined : gt(legislationDocuments.id, cursor);

/** The next page's ids, in id order: a primary-key walk stopped by the limit. */
export const expressionIdPageQuery = (
  tx: Transaction,
  cursor: ExpressionIdCursor,
  pageRows: number,
) =>
  tx
    .select({ id: legislationDocuments.id })
    .from(legislationDocuments)
    .where(afterCursor(cursor))
    .orderBy(asc(legislationDocuments.id))
    .limit(pageRows);

/**
 * The id the outer `legislation_documents` row would claim, and whether
 * another row of its work already carries it.
 */
const expressionIdTerms = (tx: Transaction) => {
  // Parenthesised: `->>` and `||` share one precedence level.
  const versionIri = sql<string>`(${legislationDocuments.metadata}->>'versionIri')`;
  // One primary-key read of a table that holds a row per publisher.
  const namespace = sql<string | null>`(
    SELECT ${legislationSources.expressionNamespace}
    FROM ${legislationSources}
    WHERE ${legislationSources.id} = ${legislationDocuments.sourceId}
  )`;
  const publisherId = sql<string>`${namespace} || ':' || ${versionIri}`;
  const sibling = alias(legislationDocuments, "sibling");
  // Another row of the work already carries the id. A scalar probe rather
  // than EXISTS: in the claim's WHERE an EXISTS becomes an anti-join, which
  // may hash the whole table; a scalar subquery stays a per-row index seek.
  const claimedSibling = sql<boolean>`coalesce((${tx
    .select({ found: sql<boolean>`true` })
    .from(sibling)
    .where(
      and(
        eq(sibling.sourceId, legislationDocuments.sourceId),
        eq(sibling.eli, legislationDocuments.eli),
        eq(sibling.language, legislationDocuments.language),
        sql`${sibling.publisherExpressionId} = ${publisherId}`,
      ),
    )
    .limit(1)}), false)`;
  return { versionIri, namespace, publisherId, claimedSibling };
};

/**
 * The page's rows still without an id, each with the reason it cannot be
 * given one, or null when it can.
 */
export const unclaimedExpressionIdRowsQuery = (
  tx: Transaction,
  cursor: ExpressionIdCursor,
  last: SafeId<"legislationDocument">,
) => {
  const { versionIri, namespace, publisherId, claimedSibling } =
    expressionIdTerms(tx);
  const twin = alias(legislationDocuments, "twin");
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
  // An id that does not fit the column would fail the whole page, and every
  // later run with it.
  const skipReason = sql<string | null>`CASE
    WHEN ${namespace} IS NULL THEN 'no-namespace'
    WHEN coalesce(${versionIri}, '') = '' THEN 'no-version-iri'
    WHEN length(${publisherId}) > ${PUBLISHER_ID_MAX_LENGTH} THEN 'oversized-id'
    WHEN ${unclaimedTwin} OR ${claimedSibling} THEN 'ambiguous-id'
  END`;
  return tx
    .select({ id: legislationDocuments.id, skipReason })
    .from(legislationDocuments)
    .where(
      and(
        afterCursor(cursor),
        lte(legislationDocuments.id, last),
        isNull(legislationDocuments.publisherExpressionId),
      ),
    );
};

/** Attach the page's claimable rows' ids; returns the rows it claimed. */
export const claimExpressionIdsQuery = (
  tx: Transaction,
  claimable: readonly SafeId<"legislationDocument">[],
) => {
  const { publisherId, claimedSibling } = expressionIdTerms(tx);
  // Joined to the ids rather than filtered by an `IN` list: the planner may
  // match an `IN` list against any index that holds the id, even one it has
  // to read whole, while a join to the ids seeks each on the primary key.
  const ids = sql.join(
    claimable.map((id) => sql`${id}`),
    sql`, `,
  );
  return (
    tx
      .update(legislationDocuments)
      // An identity attachment, not an edit: `updated_at` keeps its value.
      .set({
        publisherExpressionId: publisherId,
        updatedAt: sql`${legislationDocuments.updatedAt}`,
      })
      .where(
        and(
          sql`${legislationDocuments.id} = claim.id`,
          isNull(legislationDocuments.publisherExpressionId),
          // Re-checked in the write: a writer may have stored the id since.
          not(claimedSibling),
        ),
      )
      .from(sql`unnest(ARRAY[${ids}]::uuid[]) AS claim(id)`)
      .returning({ id: legislationDocuments.id })
  );
};

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
const claimExpressionIdPageTx = async (
  tx: Transaction,
  cursor: ExpressionIdCursor,
  pageRows: number = DEFAULT_BOUNDS.pageRows,
): Promise<ExpressionIdPage> => {
  const page = await expressionIdPageQuery(tx, cursor, pageRows);
  const last = page.at(-1)?.id;
  if (last === undefined) {
    return { type: "cycle-complete" };
  }

  const unclaimed = await unclaimedExpressionIdRowsQuery(tx, cursor, last);
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
    claimable.length === 0 ? [] : await claimExpressionIdsQuery(tx, claimable);
  return { type: "page", last, claimed: claimed.length, skipped };
};

/**
 * Attach publisher expression ids to legislation rows written without one.
 *
 * Recurring and never gating: writers built before the id existed keep
 * inserting rows without it until they drain, so a finished pass is not a
 * finished backfill. Each run commits one page with its cursor and, while the
 * table goes on, asks for the next run at once; after the last page the cursor
 * resets and the next scheduled pass starts over, which finds nothing to do
 * once every writer supplies ids. Completion is read from the rows (no null
 * ids left), not from this task.
 */
export const createLegislationExpressionIdBackfill =
  ({
    pageRows = DEFAULT_PAGE_ROWS,
    createRuntime = createScriptBackfillRuntime,
    readVerdict,
    clock = () => Temporal.Now.instant().epochMilliseconds,
    observeStatus = logSchedulerBackfillStatus,
  }: BackfillBounds = DEFAULT_BOUNDS): SchedulerTask =>
  async ({ db, job, logger, runId, scheduleContinuation, signal }) => {
    signal.throwIfAborted();
    const runtime = createRuntime({
      db,
      name: SCHEDULER_BACKFILL_IDS.expressionIds,
      tableName: "legislation_documents",
      initialSize: pageRows,
      initialCursor: backfillCursor(job.payload),
      config: {
        ...SCHEDULER_BACKFILL_CONFIG,
        minSize: Math.min(100, pageRows),
        maxSize: pageRows,
      },
      clock,
      readVerdict,
      observeStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const settled = await Result.tryPromise({
      try: async () => {
        try {
          return await runtime.step(async ({ tx, cursor, size }) => {
            signal.throwIfAborted();
            const claimedPage = await claimExpressionIdPageTx(
              tx,
              backfillCursor({ cursor }),
              size,
            );
            return {
              cursor: claimedPage.type === "page" ? claimedPage.last : null,
              done: claimedPage.type === "cycle-complete",
              value: claimedPage,
            };
          });
        } finally {
          await runtime.close();
        }
      },
      catch: (cause: unknown) => cause,
    });
    if (settled.isErr()) {
      if (settled.error instanceof BackfillHeldError) {
        logger.info("scheduler.legislation_expression_ids_held", {
          ...(settled.error.holdUntil === null
            ? {}
            : { holdUntil: settled.error.holdUntil }),
          ...(settled.error.heldSince === null
            ? {}
            : { heldSince: settled.error.heldSince }),
        });
        return undefined;
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: "Legislation expression ID backfill failed",
          cause: settled.error,
        }),
      );
    }
    const page = settled.value.value;

    const skipped = page.type === "page" ? page.skipped : [];
    for (const reason of EXPRESSION_ID_SKIP_REASONS) {
      const documentIds = skipped
        .filter((skip) => skip.reason === reason)
        .map(({ documentId }) => documentId);
      if (documentIds.length > 0) {
        logger.warn("scheduler.legislation_expression_ids_skipped", {
          "legislationExpressionIds.reason": reason,
          "legislationExpressionIds.count": documentIds.length,
          "legislationExpressionIds.documentIds": documentIds
            .slice(0, LOGGED_SKIP_IDS)
            .join(","),
        });
      }
    }

    await recordSystemAudit(db, "system:legislation-expression-id-backfill", {
      subject: runId,
      counts: { claimedDocuments: page.type === "page" ? page.claimed : 0 },
    });
    logger.info("scheduler.legislation_expression_ids_backfilled", {
      "legislationExpressionIds.claimed":
        page.type === "page" ? page.claimed : 0,
      ...Object.fromEntries(
        EXPRESSION_ID_SKIP_REASONS.map((reason) => [
          SKIP_SUMMARY_KEYS[reason],
          skipped.filter((skip) => skip.reason === reason).length,
        ]),
      ),
      "legislationExpressionIds.status":
        page.type === "page" ? "progress" : "cycle-complete",
    });

    if (page.type === "page" && !signal.aborted) {
      scheduleContinuation(
        new Date(
          clock() + Math.max(CONTINUATION_DELAY_MS, settled.value.sleepMs),
        ),
      );
    }
    return undefined;
  };

export const backfillLegislationExpressionIds =
  createLegislationExpressionIdBackfill();
