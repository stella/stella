import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawIndexJobs,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  cancelCaseLawCorpusUploadIntents,
  completeCaseLawCorpusUploadIntentCleanups,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import type { CancelledCaseLawCorpusUploadIntent } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { removeDecisionFromIndex } from "@/api/lib/legal-search/case-law-search-index";
import {
  CorpusIndexProjectionSubjectMissingError,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import {
  caseLawCorpusTombstoneWriter,
  CORPUS_TOMBSTONE_REASON,
} from "@/api/lib/legal-search/corpus-tombstones";
import type { CorpusTombstoneWriter } from "@/api/lib/legal-search/corpus-tombstones";
import {
  eraseSourceBinaries,
  RAW_SOURCE_FAMILY,
} from "@/api/lib/legal-search/raw-source-storage";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";

/** Wall-clock bound on the publisher-envelope and file deletes of an erasure. */
const RAW_ERASE_TIMEOUT_MS = 30_000;

/**
 * GDPR redaction / takedown for a case-law decision. Personal data lives
 * in (up to) four places once the migration is underway, and erasure
 * must hit all of them:
 *
 *   1. The corpus index, through the projection queue: clearing the canonical
 *      content moves the decision's desired state to a delete.
 *   2. The pg-fts projection (case_law_search_documents).
 *   3. The object-storage corpus payloads (text/sections/AST).
 *   4. The Postgres canonical columns (fulltext/sections/document_ast).
 *
 * The decision row itself is kept (citation-graph node) but stripped of
 * personal text. `content_hash` is nulled so nothing re-projects the body.
 * The erasure is recorded in case_law_index_jobs.
 */
type EraseCancelledIntentObjectsOptions = {
  cancelledIntents: readonly CancelledCaseLawCorpusUploadIntent[];
  decisionId: SafeId<"caseLawDecision">;
  tombstone: CorpusTombstoneWriter;
  deleteCorpus?: typeof deleteCorpusDocument;
};

type CancelledIntentErasure = {
  /** Intents whose every payload is beyond reach; only these lose their row. */
  cleanedIntentIds: SafeId<"caseLawCorpusUploadIntent">[];
  /** Intents still holding a payload; their rows stay as retry targets. */
  incomplete: {
    intentId: SafeId<"caseLawCorpusUploadIntent">;
    error: unknown;
  }[];
};

/**
 * Erase the payloads of every cancelled upload intent and split the intents
 * by outcome. A failed DELETE keeps the intent on the retry path exactly as
 * it keeps a decision's pointer columns; a tombstoned member is unreadable,
 * so its reservation has nothing left to own.
 */
export const eraseCancelledIntentObjects = async ({
  cancelledIntents,
  decisionId,
  tombstone,
  deleteCorpus = deleteCorpusDocument,
}: EraseCancelledIntentObjectsOptions): Promise<CancelledIntentErasure> => {
  const erasures = await Promise.all(
    cancelledIntents.map(async (intent) => ({
      intentId: intent.id,
      erasure: await eraseCorpusObjects({
        keys: {
          textKey: intent.textKey,
          sectionsKey: intent.sectionsKey,
          astKey: intent.astKey,
        },
        decisionId,
        tombstone,
        deleteCorpus,
      }),
    })),
  );
  const result: CancelledIntentErasure = {
    cleanedIntentIds: [],
    incomplete: [],
  };
  for (const { intentId, erasure } of erasures) {
    switch (erasure.type) {
      case "deleted":
      case "tombstoned":
        result.cleanedIntentIds.push(intentId);
        break;
      case "incomplete":
        result.incomplete.push({ intentId, error: erasure.error });
        break;
      default:
        erasure satisfies never;
        return panic(`Unhandled erasure: ${String(erasure)}`);
    }
  }
  return result;
};

type RedactInput = {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  /** Test seam; production deletes through the corpus bucket client. */
  deleteCorpus?: typeof deleteCorpusDocument;
  /** Test seam; production deletes through the documents bucket client. */
  deleteSourceRaw?: typeof deleteS3ObjectWithSignal;
  /** Test seam; production deletes through the documents bucket client. */
  eraseSourceFiles?: typeof eraseSourceBinaries;
};

type EraseSourceRawPayloadOptions = {
  decisionId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  sourceRawS3Key: string | null;
  deleteSourceRaw: typeof deleteS3ObjectWithSignal;
  eraseSourceFiles: typeof eraseSourceBinaries;
};

/**
 * Erase the publisher's envelope for one decision, and every file it was
 * served.
 *
 * The envelope the row names is stored under its own content hash as a
 * standalone object, in the documents bucket rather than the corpus one, so
 * erasing it is a delete. The files live under the decision's own prefix,
 * which no other decision writes to, so deleting that prefix erases every
 * file written for this decision and nothing another decision holds.
 */
const eraseSourceRawPayload = async ({
  decisionId,
  sourceId,
  sourceRawS3Key,
  deleteSourceRaw,
  eraseSourceFiles,
}: EraseSourceRawPayloadOptions): Promise<CorpusObjectErasure> => {
  const erased = await Result.tryPromise({
    try: async () => {
      const signal = AbortSignal.timeout(RAW_ERASE_TIMEOUT_MS);
      await eraseSourceFiles({
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId,
        documentId: decisionId,
        signal,
      });
      if (sourceRawS3Key !== null) {
        await deleteSourceRaw(sourceRawS3Key, signal);
      }
    },
    catch: (cause) => cause,
  });
  return Result.isError(erased)
    ? { type: "incomplete", error: erased.error }
    : { type: "deleted" };
};

export type RedactCaseLawDecisionOutcome =
  | { type: "not-found" }
  /**
   * Every store was scrubbed. `erasure` says how the corpus payloads were
   * reached: deleted outright, or tombstoned because they are members of a
   * pack that carries other decisions. Both are complete erasures — a
   * tombstoned address is served to nobody — and they are distinguished
   * because only one of them leaves bytes for a later rewrite to reclaim.
   */
  | { type: "redacted"; erasure: "deleted" | "tombstoned" }
  /**
   * The row is redacted and every index copy removed, but at least one
   * corpus object still holds the payload. Its pointer columns are kept as
   * retry targets and a failed audit row records the cause.
   */
  | { type: "corpus-objects-remain"; error: unknown };

/**
 * Whether every corpus payload a decision pointed at is beyond reach.
 *
 * Exported because the withdrawal path erases the same payloads and must
 * report the same outcomes; one definition keeps the two from disagreeing
 * about what "still there" means.
 */
export type CorpusObjectErasure =
  | { type: "deleted" }
  /**
   * At least one payload was a member of a pack the erasure cannot delete
   * without taking other decisions' payloads with it. Those addresses are
   * tombstoned: no reader serves them again, which is the erasure. The
   * bytes leave the pack when it is next rewritten.
   */
  | { type: "tombstoned"; tombstoned: string[] }
  /**
   * A DELETE failed, so an object still holds the payload. The pointer
   * columns stay as retry targets.
   */
  | { type: "incomplete"; error: unknown };

type EraseCorpusObjectsOptions = {
  keys: Parameters<typeof deleteCorpusDocument>[0];
  decisionId: SafeId<"caseLawDecision">;
  tombstone: CorpusTombstoneWriter;
  deleteCorpus?: typeof deleteCorpusDocument;
};

/** Erase a decision's corpus payloads and say how each one was reached. */
export const eraseCorpusObjects = async ({
  keys,
  decisionId,
  tombstone,
  deleteCorpus = deleteCorpusDocument,
}: EraseCorpusObjectsOptions): Promise<CorpusObjectErasure> => {
  const outcome = await Result.tryPromise({
    try: async () => await deleteCorpus(keys, { decisionId, tombstone }),
    // The cause travels unchanged into the audit row and telemetry.
    catch: (cause) => cause,
  });
  if (Result.isError(outcome)) {
    return { type: "incomplete", error: outcome.error };
  }
  switch (outcome.value.type) {
    case "deleted":
      return { type: "deleted" };
    case "tombstoned":
      return {
        type: "tombstoned",
        tombstoned: outcome.value.tombstoned.map(formatCorpusLocation),
      };
    default: {
      outcome.value satisfies never;
      return panic(`Unhandled value: ${String(outcome.value)}`);
    }
  }
};

type FailedRedactionAuditOptions = {
  decisionId: SafeId<"caseLawDecision">;
  error: unknown;
  scopedDb: ScopedDb;
};

const recordFailedRedactionAudit = async ({
  decisionId,
  error,
  scopedDb,
}: FailedRedactionAuditOptions): Promise<void> => {
  const errorMessage =
    error instanceof Error ? error.message : "Unknown corpus redaction error";
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — this insert IS the append-only failed erasure audit row
    return tx.insert(caseLawIndexJobs).values({
      decisionId,
      operation: "redact",
      status: "failed",
      contentHash: null,
      errorMessage: errorMessage.slice(0, 2048),
    });
  });
};

/** What the fencing transaction settled. */
type RedactionFence =
  | {
      type: "fenced";
      cancelledIntents: Awaited<
        ReturnType<typeof cancelCaseLawCorpusUploadIntents>
      >;
      decision: Pick<
        typeof caseLawDecisions.$inferSelect,
        | "id"
        | "sourceId"
        | "textS3Key"
        | "normalizedS3Key"
        | "astS3Key"
        | "sourceRawS3Key"
        | "redactedAt"
      >;
    }
  /** No such row, or none the projection knows: nothing to redact. */
  | { type: "missing" }
  /** The fence itself failed, which says nothing about the row. */
  | { type: "lock-failed"; cause: unknown };

export const redactCaseLawDecision = async ({
  decisionId,
  scopedDb,
  deleteCorpus = deleteCorpusDocument,
  deleteSourceRaw = deleteS3ObjectWithSignal,
  eraseSourceFiles = eraseSourceBinaries,
}: RedactInput): Promise<
  Result<RedactCaseLawDecisionOutcome, DatabaseError>
> => {
  const fenced = await scopedDb(async (tx): Promise<RedactionFence> => {
    const sourceLock = await Result.tryPromise({
      try: async () =>
        await lockActiveCorpusProjectionSourceTx(tx, {
          family: "case_law",
          entityId: decisionId,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(sourceLock)) {
      // A subject the projection does not know is the row not being there,
      // which is an answer. Anything else — a lock timeout, a dropped
      // connection — says nothing about the row, so it is carried back
      // instead of being recorded as an erasure that never happened.
      return sourceLock.error instanceof
        CorpusIndexProjectionSubjectMissingError
        ? { type: "missing" }
        : { type: "lock-failed", cause: sourceLock.error };
    }
    const decision = (
      await tx
        .select({
          id: caseLawDecisions.id,
          sourceId: caseLawDecisions.sourceId,
          textS3Key: caseLawDecisions.textS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          astS3Key: caseLawDecisions.astS3Key,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (decision === undefined) {
      return { type: "missing" };
    }

    // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
    await tx
      .update(caseLawDecisions)
      .set({
        redactedAt: decision.redactedAt ?? new Date(),
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        fulltext: null,
        sections: null,
        documentAst: null,
        contentHash: null,
      })
      .where(eq(caseLawDecisions.id, decisionId));
    const cancelledIntents = await cancelCaseLawCorpusUploadIntents({
      decisionId,
      tx,
    });
    if (sourceLock.value !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: sourceLock.value,
        subject: { family: "case_law", entityId: decisionId },
      });
    }
    return { type: "fenced", cancelledIntents, decision };
  });

  switch (fenced.type) {
    case "fenced":
      break;
    case "missing":
      return Result.ok({ type: "not-found" });
    case "lock-failed":
      return Result.err(
        new DatabaseError({
          message: `Case-law redaction could not fence ${decisionId}`,
          cause: fenced.cause,
        }),
      );
    default:
      fenced satisfies never;
      return panic(`Unhandled fence: ${String(fenced)}`);
  }
  const { cancelledIntents, decision } = fenced;

  // 1. pg-fts projection.
  await removeDecisionFromIndex(decisionId, scopedDb);

  // 2. Object-storage corpus payloads. Delete if ANY key is present: a
  // partially ingested decision (e.g. text written but AST not yet) must
  // still have its personal data erased, not skipped. An incomplete erasure
  // (a failed DELETE, or an object left in place because it holds other
  // members) is recorded as a failed audit row so the outcome is visible.
  const tombstone = caseLawCorpusTombstoneWriter({
    scopedDb,
    reason: CORPUS_TOMBSTONE_REASON.REDACTION,
  });

  let corpusErasure: CorpusObjectErasure = { type: "deleted" };
  if (
    decision.textS3Key !== null ||
    decision.normalizedS3Key !== null ||
    decision.astS3Key !== null
  ) {
    corpusErasure = await eraseCorpusObjects({
      keys: {
        textKey: decision.textS3Key,
        sectionsKey: decision.normalizedS3Key,
        astKey: decision.astS3Key,
      },
      decisionId,
      tombstone,
      deleteCorpus,
    });
    if (corpusErasure.type === "incomplete") {
      captureError(corpusErasure.error, {
        decisionId,
        step: "redactCaseLawDecision.deleteCorpusDocument",
      });
      await recordFailedRedactionAudit({
        decisionId,
        error: corpusErasure.error,
        scopedDb,
      });
    }
  }

  // Reserved uploads cancelled under the decision lock go the same way as
  // the decision's own payloads: only an intent whose objects are all gone
  // loses its row, the rest stay retry targets. The batched row delete is
  // failure-isolated the way the per-intent deletes it replaced were: a
  // redaction that has already scrubbed the objects must go on to scrub the
  // pointers and the index, and a retained cleanup row is a retry target,
  // not a reason to stop.
  const { cleanedIntentIds, incomplete } = await eraseCancelledIntentObjects({
    cancelledIntents,
    decisionId,
    tombstone,
    deleteCorpus,
  });
  for (const { error } of incomplete) {
    captureError(error, {
      decisionId,
      step: "redactCaseLawDecision.deleteReservedCorpusUpload",
    });
  }
  const intentCleanup = await Result.tryPromise({
    try: async () =>
      await completeCaseLawCorpusUploadIntentCleanups({
        intentIds: cleanedIntentIds,
        scopedDb,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(intentCleanup)) {
    captureError(intentCleanup.error, {
      decisionId,
      step: "redactCaseLawDecision.completeReservedCorpusUploadCleanup",
    });
  }

  // The publisher's own envelope and files carry the same text as the
  // payloads above, so an erasure that leaves them behind has erased nothing.
  const rawErasure = await eraseSourceRawPayload({
    decisionId,
    sourceId: decision.sourceId,
    sourceRawS3Key: decision.sourceRawS3Key,
    deleteSourceRaw,
    eraseSourceFiles,
  });
  if (rawErasure.type === "incomplete") {
    captureError(rawErasure.error, {
      decisionId,
      step: "redactCaseLawDecision.deleteSourceRawPayload",
    });
    await recordFailedRedactionAudit({
      decisionId,
      error: rawErasure.error,
      scopedDb,
    });
  }

  // Clear pointers only once every payload is beyond reach; an incomplete
  // erasure retains exact retry targets while the row tombstone already
  // blocks every reader.
  if (corpusErasure.type !== "incomplete" && rawErasure.type !== "incomplete") {
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    await scopedDb((tx) => {
      // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
      return tx
        .update(caseLawDecisions)
        .set({
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
          sourceRawS3Key: null,
          sourceRawContentType: null,
        })
        .where(eq(caseLawDecisions.id, decisionId));
    });
  }

  if (corpusErasure.type === "incomplete") {
    // The failed audit row recorded above is the record of this erasure.
    return Result.ok({
      type: "corpus-objects-remain",
      error: corpusErasure.error,
    });
  }
  if (rawErasure.type === "incomplete") {
    return Result.ok({
      type: "corpus-objects-remain",
      error: rawErasure.error,
    });
  }

  const detail =
    corpusErasure.type === "tombstoned"
      ? `tombstoned: ${corpusErasure.tombstoned.join(", ")}`.slice(0, 2048)
      : null;
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — this insert IS the append-only erasure audit row
    return tx.insert(caseLawIndexJobs).values({
      decisionId,
      operation: "redact",
      status: "succeeded",
      contentHash: null,
      detail,
    });
  });

  return Result.ok({ type: "redacted", erasure: corpusErasure.type });
};
