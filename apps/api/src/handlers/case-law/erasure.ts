import { panic, Result } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitationDoctrineReviews,
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawDecisionSupplements,
  caseLawIndexJobs,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { runDecisionWriteExtension } from "@/api/lib/case-law/decision-write-extension";
import {
  lockCaseLawDecisionErasureRows,
  lockCaseLawRepublication,
} from "@/api/lib/db/aggregate-lock";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  cancelCaseLawCorpusUploadIntents,
  completeCaseLawCorpusUploadIntentCleanups,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import type { CancelledCaseLawCorpusUploadIntent } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import {
  enqueueCaseLawRawSweepTx,
  rawSweepSettleAfter,
  sweepCaseLawRawDecision,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import type { CaseLawRawSweepOutcome } from "@/api/lib/legal-search/case-law-raw-sweeps";
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
  classifyCaseLawRawKey,
  deleteRawKeys,
  RAW_KEY_OWNERSHIP,
} from "@/api/lib/legal-search/raw-source-storage";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";

/** Wall-clock bound on the raw listing, reads and deletes of an erasure. */
const RAW_ERASE_TIMEOUT_MS = 60_000;

/**
 * When the sweeper first follows an erasure up. The erasure sweeps inline;
 * this is the retry when that sweep failed or the process died before it.
 */
const RAW_SWEEP_FOLLOW_UP_MS = 5 * 60 * 1000;

/**
 * GDPR redaction / takedown for a case-law decision. Personal data lives
 * in (up to) five places once the migration is underway, and erasure
 * must hit all of them:
 *
 *   1. The corpus index, through the projection queue: clearing the canonical
 *      content moves the decision's desired state to a delete.
 *   2. The pg-fts projection (case_law_search_documents).
 *   3. The object-storage corpus payloads (text/sections/AST).
 *   4. The Postgres canonical columns (fulltext/sections/document_ast).
 *   5. The publisher's raw payloads and files, under the decision's own
 *      raw prefix (see `case-law-raw-sweeps.ts`).
 *   6. Supplements (such as written reasons published apart from their
 *      ruling): those merged into it, and the one it stood for when it is
 *      a supplement's own standalone row. Their rows go, and their raw
 *      payloads, which the decision owns under the same prefix; a copy its
 *      judgment holds is deleted by key.
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
  /** Test seam; production sweeps through the documents bucket client. */
  sweepRaw?: typeof sweepCaseLawRawDecision;
  /** Test seam; production locks the decision's projection source. */
  lockSource?: typeof lockActiveCorpusProjectionSourceTx;
};

/** How the publisher's own payloads and files were reached. */
type RawErasure =
  | { type: "swept"; legacyRaw: LegacyRawErasure }
  | { type: "incomplete"; error: unknown };

/**
 * Whether objects of the earlier source-wide raw layout remain in the
 * decision's source. The decision may have been served bytes stored there;
 * they are shared by content, so they go only with the source-wide legacy
 * sweep, and the erasure's sweep entry stays until they have.
 */
type LegacyRawErasure = Extract<
  CaseLawRawSweepOutcome,
  { type: "swept" }
>["legacy"];

export type RedactCaseLawDecisionOutcome =
  | { type: "not-found" }
  /**
   * Every store was scrubbed. `erasure` says how the corpus payloads were
   * reached: deleted outright, or tombstoned because they are members of a
   * pack that carries other decisions. Both are complete erasures — a
   * tombstoned address is served to nobody — and they are distinguished
   * because only one of them leaves bytes for a later rewrite to reclaim.
   */
  | {
      type: "redacted";
      erasure: "deleted" | "tombstoned";
      legacyRaw: LegacyRawErasure;
    }
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
  await scopedDb((tx) =>
    // audit: skip — this insert IS the append-only failed erasure audit row
    tx.insert(caseLawIndexJobs).values({
      decisionId,
      operation: "redact",
      status: "failed",
      contentHash: null,
      errorMessage: errorMessage.slice(0, 2048),
    }),
  );
};

/** What the fencing transaction settled. */
type RedactionFence =
  | {
      type: "fenced";
      canonicalId: SafeId<"caseLawDecision">;
      decisions: FencedDecision[];
    }
  /** No such row, or none the projection knows: nothing to redact. */
  | { type: "missing" }
  /** The fence itself failed, which says nothing about the row. */
  | { type: "lock-failed"; cause: unknown };

type FencedDecision = {
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
  /** Supplement payloads stored under another decision's prefix. */
  supplementRawKeys: string[];
};

export const redactCaseLawDecision = async ({
  decisionId,
  scopedDb,
  deleteCorpus = deleteCorpusDocument,
  sweepRaw = sweepCaseLawRawDecision,
  lockSource = lockActiveCorpusProjectionSourceTx,
}: RedactInput): Promise<
  Result<RedactCaseLawDecisionOutcome, DatabaseError>
> => {
  const fenced = await scopedDb(async (tx): Promise<RedactionFence> => {
    await lockCaseLawRepublication({ tx, mode: "shared" });
    const aliasForRequestedId = (
      await tx
        .select({ id: caseLawDecisionAliases.canonicalDecisionId })
        .from(caseLawDecisionAliases)
        .where(eq(caseLawDecisionAliases.retiredDecisionId, decisionId))
        .limit(1)
    ).at(0);
    const canonicalId = aliasForRequestedId?.id ?? decisionId;
    const aliases = await tx
      .select({ id: caseLawDecisionAliases.retiredDecisionId })
      .from(caseLawDecisionAliases)
      .where(eq(caseLawDecisionAliases.canonicalDecisionId, canonicalId));
    const decisionIds = [
      canonicalId,
      ...aliases.map(({ id }) => id),
    ].toSorted();
    // Projection fences before decision rows, the order projection writers
    // take them; and every lock before any row changes, because a failure
    // returned from this callback commits and must find nothing mutated.
    const pendingSourceLocks = [];
    for (const id of decisionIds) {
      const subject = { family: "case_law", entityId: id } as const;
      pendingSourceLocks.push(
        Result.tryPromise({
          // db-await-in-loop: take per-subject projection fences in sorted order before any row changes
          try: async () => await lockSource(tx, subject),
          catch: (cause) => cause,
        }).then((sourceLock) => ({ sourceLock, subject })),
      );
    }
    const lockedSubjects = [];
    for (const locked of await Promise.all(pendingSourceLocks)) {
      if (Result.isError(locked.sourceLock)) {
        if (
          !(
            locked.sourceLock.error instanceof
            CorpusIndexProjectionSubjectMissingError
          )
        ) {
          return { type: "lock-failed", cause: locked.sourceLock.error };
        }
        continue;
      }
      lockedSubjects.push({
        sourceLock: locked.sourceLock.value,
        subject: locked.subject,
      });
    }
    const lockedIds = lockedSubjects.map(({ subject }) => subject.entityId);
    await lockCaseLawDecisionErasureRows({ tx, decisionIds: lockedIds });
    const decisions = await tx
      .select({
        id: caseLawDecisions.id,
        sourceId: caseLawDecisions.sourceId,
        textS3Key: caseLawDecisions.textS3Key,
        normalizedS3Key: caseLawDecisions.normalizedS3Key,
        astS3Key: caseLawDecisions.astS3Key,
        sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        redactedAt: caseLawDecisions.redactedAt,
        sourceDocumentId: caseLawDecisions.sourceDocumentId,
      })
      .from(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, lockedIds));
    if (decisions.length === 0) {
      return { type: "missing" };
    }

    const pendingFenceResults = [];
    for (const decision of decisions) {
      const { sourceLock, subject } =
        lockedSubjects.find(
          (locked) => locked.subject.entityId === decision.id,
        ) ??
        panic(
          `Redaction fence read ${decision.id} without its projection lock`,
        );
      pendingFenceResults.push(
        (async () => {
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
              // The inline raw column predates object storage; nothing writes it
              // any more, and a row that still holds it holds the publisher's text.
              sourceRaw: null,
            })
            .where(eq(caseLawDecisions.id, decision.id));
          // Supplements carry the same personal text: those merged into this
          // decision, and the one this row stands for. Payloads under this
          // decision's prefix go with the sweep below; one its judgment holds is
          // deleted by key. A supplement observed after this point finds its
          // judgment or its own row redacted and is not kept.
          // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
          const erasedSupplements = await tx
            .delete(caseLawDecisionSupplements)
            .where(
              or(
                eq(caseLawDecisionSupplements.decisionId, decision.id),
                decision.sourceDocumentId === null
                  ? undefined
                  : and(
                      eq(
                        caseLawDecisionSupplements.sourceId,
                        decision.sourceId,
                      ),
                      eq(
                        caseLawDecisionSupplements.sourceDocumentId,
                        decision.sourceDocumentId,
                      ),
                    ),
              ),
            )
            .returning({ key: caseLawDecisionSupplements.sourceRawS3Key });
          // A doctrine review quotes the citing decision's own text as evidence,
          // so it goes with that text. Re-reviewing a redacted decision has no
          // text to quote from, so nothing re-creates it. Covered by this fence's
          // redaction exemption above, recorded in case_law_index_jobs below.
          await tx
            .delete(caseLawCitationDoctrineReviews)
            .where(
              eq(caseLawCitationDoctrineReviews.citingDecisionId, decision.id),
            );
          const supplementRawKeys = erasedSupplements.flatMap(({ key }) =>
            key !== null &&
            classifyCaseLawRawKey(key, {
              sourceId: decision.sourceId,
              documentId: decision.id,
            }) === RAW_KEY_OWNERSHIP.FOREIGN &&
            key.startsWith(`case-law/raw/${decision.sourceId}/documents/`)
              ? [key]
              : [],
          );
          // The raw prefix is swept below and again once every write that could
          // have started before this fence is over.
          await enqueueCaseLawRawSweepTx(tx, {
            decisionId: decision.id,
            sourceId: decision.sourceId,
            firstAttemptAt: new Date(
              Temporal.Now.instant().epochMilliseconds + RAW_SWEEP_FOLLOW_UP_MS,
            ),
            settleAfter: rawSweepSettleAfter(),
          });
          const cancelledIntents = await cancelCaseLawCorpusUploadIntents({
            decisionId: decision.id,
            tx,
          });
          if (sourceLock !== null) {
            await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
              lock: sourceLock,
              subject,
            });
          }
          await runDecisionWriteExtension(tx, decision.id);
          return { cancelledIntents, decision, supplementRawKeys };
        })(),
      );
    }
    return {
      type: "fenced",
      canonicalId,
      decisions: await Promise.all(pendingFenceResults),
    };
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
  const primary = fenced.decisions.find(
    ({ decision }) => decision.id === fenced.canonicalId,
  );
  if (primary === undefined) {
    return panic(
      `Redaction fence omitted canonical decision ${fenced.canonicalId}`,
    );
  }
  const aliasDecisions = fenced.decisions.filter(
    ({ decision }) => decision.id !== fenced.canonicalId,
  );
  const pendingAliasOutcomes = [];
  for (const alias of aliasDecisions) {
    pendingAliasOutcomes.push(
      eraseFencedDecision({
        fenced: alias,
        scopedDb,
        deleteCorpus,
        sweepRaw,
      }),
    );
  }
  const aliasOutcomes = await Promise.all(pendingAliasOutcomes);
  const incompleteAlias = aliasOutcomes.find(
    (outcome) => outcome.type === "corpus-objects-remain",
  );
  const primaryOutcome = await eraseFencedDecision({
    fenced: primary,
    scopedDb,
    deleteCorpus,
    sweepRaw,
  });
  return Result.ok(incompleteAlias ?? primaryOutcome);
};

type EraseFencedDecisionOptions = {
  fenced: FencedDecision;
  scopedDb: ScopedDb;
  deleteCorpus: typeof deleteCorpusDocument;
  sweepRaw: typeof sweepCaseLawRawDecision;
};

const eraseFencedDecision = async ({
  fenced: { cancelledIntents, decision, supplementRawKeys },
  scopedDb,
  deleteCorpus,
  sweepRaw,
}: EraseFencedDecisionOptions): Promise<
  Exclude<RedactCaseLawDecisionOutcome, { type: "not-found" }>
> => {
  const decisionId = decision.id;

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
      captureError(
        corpusErasure.error,
        handlerErrorContext(
          "caselaw.redactCaseLawDecision.corpusErasure_error",
          {
            decisionId,
            step: "redactCaseLawDecision.deleteCorpusDocument",
          },
        ),
      );
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
    captureError(
      error,
      handlerErrorContext("caselaw.redactCaseLawDecision", {
        decisionId,
        step: "redactCaseLawDecision.deleteReservedCorpusUpload",
      }),
    );
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
    captureError(
      intentCleanup.error,
      handlerErrorContext("caselaw.redactCaseLawDecision.intentCleanup_error", {
        decisionId,
        step: "redactCaseLawDecision.completeReservedCorpusUploadCleanup",
      }),
    );
  }

  // The publisher's own payloads and files carry the same text as the
  // payloads above, so an erasure that leaves them behind has erased nothing.
  // They live under the decision's own prefix, which no other decision
  // writes to; the sweep deletes that prefix and nothing another decision
  // holds.
  const rawSwept = await Result.tryPromise({
    try: async () =>
      await sweepRaw({
        decisionId,
        sourceId: decision.sourceId,
        scopedDb,
        signal: AbortSignal.timeout(RAW_ERASE_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  const supplementRawErased = await Result.tryPromise({
    try: async () =>
      await deleteRawKeys(
        supplementRawKeys,
        AbortSignal.timeout(RAW_ERASE_TIMEOUT_MS),
      ),
    catch: (cause) => cause,
  });
  const rawErasure = ((): RawErasure => {
    if (Result.isError(rawSwept)) {
      return { type: "incomplete", error: rawSwept.error };
    }
    if (Result.isError(supplementRawErased)) {
      return { type: "incomplete", error: supplementRawErased.error };
    }
    if (rawSwept.value.type === "incomplete") {
      return { type: "incomplete", error: rawSwept.value.error };
    }
    if (rawSwept.value.type !== "swept") {
      // The fence above erased the row in this very call.
      return panic(`Erased decision swept as ${rawSwept.value.type}`);
    }
    return { type: "swept", legacyRaw: rawSwept.value.legacy };
  })();
  if (rawErasure.type === "incomplete") {
    captureError(
      rawErasure.error,
      handlerErrorContext("caselaw.redactCaseLawDecision.rawErasure_error", {
        decisionId,
        step: "redactCaseLawDecision.sweepSourceRaw",
      }),
    );
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
    await scopedDb(async (tx) => {
      // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
      await tx
        .update(caseLawDecisions)
        .set({
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
          sourceRawS3Key: null,
          sourceRawContentType: null,
        })
        .where(eq(caseLawDecisions.id, decisionId));
      await tx
        .update(caseLawDecisionSourceIdentities)
        .set({ sourceRawS3Key: null, sourceRawContentType: null })
        .where(eq(caseLawDecisionSourceIdentities.decisionId, decisionId));
      await runDecisionWriteExtension(tx, decisionId);
    });
  }

  if (corpusErasure.type === "incomplete") {
    // The failed audit row recorded above is the record of this erasure.
    return {
      type: "corpus-objects-remain",
      error: corpusErasure.error,
    };
  }
  if (rawErasure.type === "incomplete") {
    return {
      type: "corpus-objects-remain",
      error: rawErasure.error,
    };
  }

  const detail =
    [
      corpusErasure.type === "tombstoned"
        ? `tombstoned: ${corpusErasure.tombstoned.join(", ")}`
        : null,
      // Recorded so the audit trail does not read as finished while the
      // source's older raw objects are still stored; see `LegacyRawErasure`.
      rawErasure.legacyRaw === "pending" ? "legacy raw pending" : null,
    ]
      .filter((part) => part !== null)
      .join("; ")
      .slice(0, 2048) || null;
  await scopedDb((tx) =>
    // audit: skip — this insert IS the append-only erasure audit row
    tx.insert(caseLawIndexJobs).values({
      decisionId,
      operation: "redact",
      status: "succeeded",
      contentHash: null,
      detail,
    }),
  );

  return {
    type: "redacted",
    erasure: corpusErasure.type,
    legacyRaw: rawErasure.legacyRaw,
  };
};
