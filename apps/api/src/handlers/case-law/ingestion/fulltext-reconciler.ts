import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  DECISION_TEXT_FAILURE,
  DECISION_TEXT_RECOVERY,
} from "@stll/api-contract/case-law-fulltext-state";
import type {
  DecisionTextFailure,
  DecisionTextRecovery,
  DecisionTextState,
} from "@stll/api-contract/case-law-fulltext-state";
import { CASE_LAW_TEXT_STATUS } from "@stll/api-contract/case-law-text-status";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SourceRegistration } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { DEFERRED_DOCUMENT_PROCESSORS } from "@/api/handlers/case-law/ingestion/adapters/deferred-document-processors";
import {
  PL_UOKIK_DOCUMENT_ABSENCE,
  PL_UOKIK_DOCUMENT_ABSENCE_KEY,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uokik.text-policy";
import {
  processDecision,
  processStoredDecision,
} from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { readStoredRawFromS3 } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
import { processSupplement } from "@/api/handlers/case-law/ingestion/pipeline/supplement";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { ProcessDecisionOptions } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import { eligibleDecisionTextSql } from "@/api/lib/case-law/fulltext-eligibility-sql";
import {
  recoverFromPublisherListing,
  terminalPublisherTextState,
} from "@/api/lib/case-law/fulltext-publisher-recovery";
import {
  FULLTEXT_RECOVERY_KIND,
  fulltextPolicyForSource,
} from "@/api/lib/case-law/fulltext-source-policy";
import {
  failedDecisionText,
  FULLTEXT_RECOVERY_LIMITS,
  pendingDecisionText,
  readDecisionTextState,
  textFailureFromError,
  textFailureFromObservation,
  verifiedDecisionText,
} from "@/api/lib/case-law/fulltext-state";
import {
  adoptLegacyDecisionTextStates,
  claimDecisionTextWork,
  scheduleStaleDecisionTextProof,
  settleDecisionTextWork,
} from "@/api/lib/case-law/fulltext-state-store";
import type { ClaimedDecisionTextWork } from "@/api/lib/case-law/fulltext-state-store";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";
import {
  readCorpusAst,
  readCorpusAtAuthoritativePointer,
  readCorpusSections,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import { corpusTombstoneReaderForTx } from "@/api/lib/legal-search/corpus-tombstones";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type {
  DecisionSupplement,
  IngestionResult,
  StoredRawResultReader,
} from "@/api/lib/legal-search/ingestion-types";

const SOURCE_RECOVERY_AFTER = "fulltextRecoveryAfter";
const SOURCE_RECOVERY_INTERVAL_MS = 30_000;

type CorpusPointerField = "textS3Key" | "normalizedS3Key" | "astS3Key";
type ReadHeldPayloadOptions = {
  row: ClaimedDecisionTextWork;
  scopedDb: ScopedDb;
  signal: AbortSignal;
};

/** Actual bounded reads, including the established missing-object/repoint race. */
export const readHeldDecisionPayload = async ({
  row,
  scopedDb,
  signal,
}: ReadHeldPayloadOptions): Promise<{
  payload: CorpusPayload;
  storage: "postgres" | "corpus";
}> => {
  if (
    row.contentHash === null ||
    row.textS3Key === null ||
    row.normalizedS3Key === null ||
    row.astS3Key === null
  ) {
    return {
      payload: {
        text: row.fulltext,
        sections: row.sections,
        ast: row.documentAst,
      },
      storage: "postgres",
    };
  }
  const reread = async (field: CorpusPointerField): Promise<string | null> =>
    (
      await scopedDb(async (tx) =>
        (
          await tx
            .select({ key: caseLawDecisions[field] })
            .from(caseLawDecisions)
            .where(
              and(
                eq(caseLawDecisions.id, row.id),
                eq(caseLawDecisions.sourceId, row.sourceId),
                isNull(caseLawDecisions.redactedAt),
              ),
            )
            .limit(1)
        ).at(0),
      )
    )?.key ?? null;
  const readTombstones: CorpusTombstoneReader = async (locations) =>
    await scopedDb(
      async (tx) => await corpusTombstoneReaderForTx(tx)(locations),
    );
  const [text, sections, ast] = await Promise.all([
    readCorpusAtAuthoritativePointer({
      storedKey: row.textS3Key,
      read: async (key) =>
        await readCorpusText(key, { signal, readTombstones }),
      rereadStoredKey: async () => await reread("textS3Key"),
    }),
    readCorpusAtAuthoritativePointer({
      storedKey: row.normalizedS3Key,
      read: async (key) =>
        await readCorpusSections(key, { signal, readTombstones }),
      rereadStoredKey: async () => await reread("normalizedS3Key"),
    }),
    readCorpusAtAuthoritativePointer({
      storedKey: row.astS3Key,
      read: async (key) => await readCorpusAst(key, { signal, readTombstones }),
      rereadStoredKey: async () => await reread("astS3Key"),
    }),
  ]);
  return { payload: { text, sections, ast }, storage: "corpus" };
};

type FulltextRecoverySummary = {
  adopted: number;
  rechecked: number;
  verified: number;
  recovered: number;
  failed: number;
  continued: number;
};
export type FulltextRecoveryUnitOutcome =
  | { type: "worked"; summary: FulltextRecoverySummary }
  | { type: "idle" }
  | { type: "leased" }
  | { type: "aborted" };

type FulltextRecoveryUnitOptions = {
  sourceId: SafeId<"caseLawSource">;
  registration: SourceRegistration;
  publisherAccess: "enabled" | "disabled";
  scopedDb: ScopedDb;
  now: () => Date;
  signal: AbortSignal;
  /** Storage seams replace I/O, never payload validation or cursor/claim semantics. */
  readPayload?: typeof readHeldDecisionPayload;
  readRaw?: StoredRawResultReader;
  corpus?: CaseLawCorpusDependencies;
  sourceFingerprintFromStoredRaw?: ProcessDecisionOptions["sourceFingerprintFromStoredRaw"];
};

type AttemptContext = Omit<FulltextRecoveryUnitOptions, "signal"> & {
  signal: AbortSignal;
  lease: CaseLawSourceIngestionLease;
  summary: FulltextRecoverySummary;
  row: ClaimedDecisionTextWork;
};

/** Owns the mutable claim snapshot and every fenced state transition. */
const createRecoveryAttempt = ({
  row: initial,
  registration,
  publisherAccess,
  scopedDb,
  sourceId,
  lease,
  now,
  signal,
  summary,
  readPayload = readHeldDecisionPayload,
  readRaw = readStoredRawFromS3,
  corpus,
  sourceFingerprintFromStoredRaw,
}: AttemptContext) => {
  const adapter = registration.source;
  let row = initial;
  let observationOrder = row.sourceObservationOrder;
  const policy = fulltextPolicyForSource(adapter.key);
  const checkpoint = async (
    recovery: DecisionTextRecovery,
    delayMs = FULLTEXT_RECOVERY_LIMITS.CLAIM_MS,
  ): Promise<void> => {
    await lease.beforeDatabaseMark();
    const state = pendingDecisionText({
      now: now(),
      attemptCount: row.textState.attemptCount,
      lastAttemptAt: row.textState.lastAttemptAt,
      delayMs,
      recovery,
    });
    const applied = await settleDecisionTextWork({
      scopedDb,
      claimed: row,
      state,
      observationOrder,
    });
    if (!applied) {
      throw new ConcurrentModificationError({
        message: "Full-text recovery claim was superseded",
      });
    }
    const snapshot = await currentState();
    if (snapshot === undefined) {
      throw new ConcurrentModificationError({
        message: "Full-text row was removed during checkpoint",
      });
    }
    row = {
      ...row,
      textState: state,
      sourceHash: snapshot.sourceHash,
      sourceObservationOrder: snapshot.sourceObservationOrder,
    };
  };
  const fail = async (
    cause: DecisionTextFailure,
    recovery = row.textState.recovery,
  ): Promise<void> => {
    await lease.beforeDatabaseMark();
    const applied = await settleDecisionTextWork({
      scopedDb,
      claimed: row,
      observationOrder,
      state: failedDecisionText({
        now: now(),
        attemptCount: row.textState.attemptCount,
        cause,
        retryFloorMs: policy.retryFloorMs,
        recovery,
      }),
    });
    if (applied) {
      summary.failed += 1;
    }
  };
  const finish = async (state: DecisionTextState): Promise<boolean> => {
    await lease.beforeDatabaseMark();
    return await settleDecisionTextWork({
      scopedDb,
      claimed: row,
      state,
      observationOrder,
    });
  };
  const currentState = async () =>
    await scopedDb(async (tx) =>
      (
        await tx
          .select({
            textState: caseLawDecisions.textState,
            sourceHash: caseLawDecisions.sourceHash,
            sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
          })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.id, row.id),
              eligibleDecisionTextSql(caseLawDecisions),
            ),
          )
          .limit(1)
      ).at(0),
    );
  const nextOrder = async (): Promise<bigint> => {
    await lease.beforeDatabaseMark();
    return await allocateSourceObservationOrder({
      scopedDb,
      sourceId,
      leaseToken: lease.leaseToken,
    });
  };
  const resolver = createSourceContractResolver(scopedDb);
  const persist = async (
    input: IngestionResult,
    rawKey: string | null,
  ): Promise<"stored" | "retry" | "textless" | "superseded"> => {
    signal.throwIfAborted();
    observationOrder = await nextOrder();
    const options = {
      input,
      scopedDb,
      sourceId,
      observedAt: now(),
      observationOrder,
      signal,
      ...(corpus === undefined ? {} : { corpus }),
      ...(sourceFingerprintFromStoredRaw === undefined
        ? {}
        : { sourceFingerprintFromStoredRaw }),
    };
    const written =
      rawKey === null
        ? await processDecision(
            { ...options, refresh: DECISION_REFRESH.ALWAYS },
            resolver,
          )
        : await processStoredDecision(
            { ...options, sourceRawS3Key: rawKey, decisionId: row.id },
            resolver,
          );
    if (written.status !== PROCESS_DECISION_STATUS.COMPLETE) {
      const recovery =
        rawKey === null
          ? row.textState.recovery
          : ({ type: DECISION_TEXT_RECOVERY.STORED_RAW_RETRY } as const);
      await checkpoint(recovery, policy.retryFloorMs);
      summary.continued += 1;
      return "retry";
    }
    const stored = await currentState();
    if (
      stored !== undefined &&
      readDecisionTextState(stored.textState)?.status ===
        CASE_LAW_TEXT_STATUS.STORED
    ) {
      summary.recovered += 1;
      return "stored";
    }
    return stored === undefined ? "superseded" : "textless";
  };

  return {
    registration,
    publisherAccess,
    scopedDb,
    sourceId,
    lease,
    now,
    signal,
    summary,
    readPayload,
    readRaw,
    corpus,
    adapter,
    policy,
    resolver,
    get row() {
      return row;
    },
    checkpoint,
    fail,
    finish,
    currentState,
    nextOrder,
    persist,
    adoptOwnedOrder: (order: bigint | null) => {
      observationOrder = order;
    },
  };
};

type RecoveryAttempt = ReturnType<typeof createRecoveryAttempt>;
type RecoveryPhaseOutcome = "complete" | "continue";

const verifyHeldStorage = async (attempt: RecoveryAttempt) => {
  const {
    row,
    scopedDb,
    signal,
    lease,
    readPayload,
    registration,
    now,
    finish,
    summary,
  } = attempt;
  let storageFailure: DecisionTextFailure | null = null;
  const read = await Result.tryPromise({
    try: async () =>
      await lease.beforeRemoteEffect(
        async () => await readPayload({ row, scopedDb, signal }),
      ),
    catch: (error) =>
      textFailureFromError({
        error,
        phase: "storage",
        timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
      }),
  });
  signal.throwIfAborted();
  if (read.isErr()) {
    storageFailure = read.error;
  }
  if (read.isOk()) {
    const proof = verifiedDecisionText({
      ...read.value,
      caseNumberType: row.caseNumberType,
      now: now(),
    });
    if (proof !== null) {
      // Read-time vocabulary degradation can change serialized AST bytes.
      // The acknowledged hash fences the actual keys whose text was read.
      const state =
        read.value.storage === "corpus" && row.contentHash !== null
          ? ({
              status: CASE_LAW_TEXT_STATUS.STORED,
              storage: "corpus",
              contentHash: row.contentHash,
              verifiedAt: now().toISOString(),
            } as const)
          : proof;
      if (await finish(state)) {
        summary.verified += 1;
      }
      return { type: "complete" } as const;
    }
  }

  const terminal =
    registration.capability === "crawl"
      ? terminalPublisherTextState({
          adapterKey: registration.source.key,
          row,
          now: now(),
        })
      : null;
  if (terminal !== null) {
    if (await finish(terminal)) {
      summary.verified += 1;
    }
    return { type: "complete" } as const;
  }
  return { type: "unresolved", storageFailure } as const;
};

type RecoverSupplementOptions = {
  attempt: RecoveryAttempt;
  supplement: DecisionSupplement;
  recovery: DecisionTextRecovery;
};

const recoverSupplement = async ({
  attempt,
  supplement,
  recovery,
}: RecoverSupplementOptions): Promise<RecoveryPhaseOutcome> => {
  const {
    adapter,
    sourceId,
    scopedDb,
    now,
    readRaw,
    corpus,
    resolver,
    summary,
  } = attempt;
  if (adapter.reparseStoredRaw === undefined) {
    await attempt.fail({
      kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
      code: "supplement_replay_not_supported",
    });
    return "complete";
  }
  const ownedOrders = new Set<bigint>();
  const written = await processSupplement(
    {
      supplement,
      sourceId,
      scopedDb,
      observedAt: now(),
      nextObservationOrder: async () => {
        const order = await attempt.nextOrder();
        ownedOrders.add(order);
        return order;
      },
      reparseStoredRaw: adapter.reparseStoredRaw,
      readStoredRaw: readRaw,
      ...(corpus === undefined ? {} : { corpus }),
    },
    resolver,
  );
  const stored = await attempt.currentState();
  if (written.status === PROCESS_DECISION_STATUS.RETRYABLE) {
    // A supplement may write another judgment. Only adopt an order this
    // attempt allocated, or retain the original held-row claim fence.
    if (
      stored !== undefined &&
      (stored.sourceObservationOrder === attempt.row.sourceObservationOrder ||
        (stored.sourceObservationOrder !== null &&
          ownedOrders.has(stored.sourceObservationOrder)))
    ) {
      attempt.adoptOwnedOrder(stored.sourceObservationOrder);
      await attempt.checkpoint(recovery, attempt.policy.retryFloorMs);
    }
    summary.continued += 1;
    return "complete";
  }
  if (written.disposition.type === "erased") {
    return "complete";
  }
  if (
    stored === undefined ||
    readDecisionTextState(stored.textState)?.status ===
      CASE_LAW_TEXT_STATUS.STORED
  ) {
    summary.recovered += 1;
    return "complete";
  }
  return "continue";
};

const replayHeldRaw = async (
  attempt: RecoveryAttempt,
): Promise<RecoveryPhaseOutcome> => {
  const { row, adapter, lease, readRaw, signal, now, persist, fail } = attempt;
  const reparseStoredRaw = adapter.reparseStoredRaw;
  if (
    reparseStoredRaw !== undefined &&
    (row.sourceRawS3Key !== null || row.sourceRaw !== null)
  ) {
    let replayPhase: "storage" | "parser" = "storage";
    const replay = await Result.tryPromise({
      try: async () => {
        const acquired =
          row.sourceRawS3Key === null
            ? Result.ok(new TextEncoder().encode(row.sourceRaw ?? ""))
            : await lease.beforeRemoteEffect(
                async () =>
                  await readRaw(
                    row.sourceRawS3Key ?? panic("Raw pointer disappeared"),
                  ),
              );
        if (acquired.isErr()) {
          throw acquired.error;
        }
        const raw = acquired.value;
        if (raw === null) {
          return null;
        }
        replayPhase = "parser";
        return await reparseStoredRaw({
          raw,
          contentType: row.sourceRawContentType,
          caseNumber: row.caseNumber,
          sourceDocumentId: row.sourceDocumentId,
          language: row.language,
          court: row.court,
          ecli: row.ecli,
          decisionDate: row.decisionDate,
          decisionType: row.decisionType,
          sourceUrl: row.sourceUrl,
          documentUrl: row.documentUrl,
          metadata: row.metadata ?? {},
        });
      },
      catch: (error) =>
        textFailureFromError({
          error,
          phase: replayPhase,
          timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
        }),
    });
    signal.throwIfAborted();
    if (replay.isOk() && replay.value?.type === "parsed") {
      const candidate = replay.value.result;
      const proof = verifiedDecisionText({
        payload: {
          text: candidate.fulltext ?? null,
          ast: candidate.documentAst,
          sections: candidate.sections ?? null,
        },
        caseNumberType: row.caseNumberType,
        storage: "postgres",
        now: now(),
      });
      if (proof !== null) {
        const persisted = await persist(candidate, row.sourceRawS3Key);
        if (persisted !== "textless") {
          return "complete";
        }
      }
    }
    if (replay.isOk() && replay.value?.type === "supplement") {
      const outcome = await recoverSupplement({
        attempt,
        supplement: replay.value.supplement,
        recovery: { type: DECISION_TEXT_RECOVERY.STORED_RAW_RETRY },
      });
      if (outcome === "complete") {
        return outcome;
      }
    }
    if (
      row.textState.recovery.type === DECISION_TEXT_RECOVERY.STORED_RAW_RETRY
    ) {
      let cause: DecisionTextFailure;
      if (replay.isErr()) {
        cause = replay.error;
      } else if (replay.value === null) {
        cause = {
          kind: DECISION_TEXT_FAILURE.STORAGE,
          code: "source_raw_missing",
        };
      } else {
        cause = {
          kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
          code: "stored_raw_has_no_readable_output",
        };
      }
      await fail(cause, {
        type: DECISION_TEXT_RECOVERY.STORED_RAW_RETRY,
      });
      return "complete";
    }
  } else if (
    row.textState.recovery.type === DECISION_TEXT_RECOVERY.STORED_RAW_RETRY
  ) {
    await fail(
      {
        kind: DECISION_TEXT_FAILURE.STORAGE,
        code: "stored_raw_retry_has_no_input",
      },
      row.textState.recovery,
    );
    return "complete";
  }
  return "continue";
};

const recoverDeferredDocument = async (
  attempt: RecoveryAttempt,
): Promise<void> => {
  const { adapter, row, scopedDb, signal, fail, summary, currentState } =
    attempt;
  if (adapter.key !== ADAPTER_KEYS.SK_COURTS) {
    return panic("Unregistered deferred full-text processor");
  }
  const fetched = await Result.tryPromise({
    try: async () =>
      await DEFERRED_DOCUMENT_PROCESSORS[adapter.key]({
        decisionId: row.id,
        scopedDb,
        signal,
      }),
    catch: (error) =>
      textFailureFromError({
        error,
        phase: "publisher",
        timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
      }),
  });
  signal.throwIfAborted();
  if (fetched.isErr()) {
    await fail(fetched.error);
    return;
  }
  switch (fetched.value.status) {
    case "filled":
      summary.recovered += 1;
      return;
    case "unavailable": {
      const persisted = await currentState();
      if (
        persisted !== undefined &&
        readDecisionTextState(persisted.textState)?.status ===
          CASE_LAW_TEXT_STATUS.FETCH_FAILED
      ) {
        summary.failed += 1;
      } else {
        summary.continued += 1;
      }
      return;
    }
    case "deferred":
    case "parked":
      await fail(fetched.value.cause);
      return;
    case "claimed":
    case "superseded":
    case "busy":
    case "lost":
      summary.continued += 1;
      return;
    default:
      fetched.value satisfies never;
      return panic("Unhandled deferred full-text result");
  }
};

const recoverPublisherDocument = async (
  attempt: RecoveryAttempt,
): Promise<void> => {
  const {
    registration,
    row,
    signal,
    checkpoint,
    summary,
    fail,
    lease,
    sourceId,
    scopedDb,
    now,
    nextOrder,
    corpus,
    resolver,
    persist,
    finish,
  } = attempt;
  if (registration.capability === "import") {
    await fail({
      kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
      code: "import_requires_new_publisher_payload",
    });
    return;
  }
  const publisher = await recoverFromPublisherListing({
    adapter: registration.source,
    row,
    recovery: row.textState.recovery,
    signal,
    checkpoint: async (recovery) => await checkpoint(recovery),
  });
  signal.throwIfAborted();
  switch (publisher.type) {
    case "continued":
      await checkpoint(publisher.recovery, 0);
      summary.continued += 1;
      return;
    case "failed":
      await fail(
        publisher.cause,
        publisher.cause.kind === DECISION_TEXT_FAILURE.PARSER_REFUSAL &&
          publisher.cause.code === "listing_identity_not_found"
          ? { type: DECISION_TEXT_RECOVERY.VERIFY_STORAGE }
          : row.textState.recovery,
      );
      return;
    case "built": {
      // Companions settle first; a failed companion must not leave the main
      // row complete and suppress the replay that would discover it again.
      for (const companion of publisher.companions ?? []) {
        await lease.beforeDatabaseMark();
        const written = await processDecision(
          {
            input: companion,
            sourceId,
            scopedDb,
            observedAt: now(),
            observationOrder: await nextOrder(),
            signal,
            refresh: DECISION_REFRESH.ALWAYS,
            ...(corpus === undefined ? {} : { corpus }),
          },
          resolver,
        );
        if (written.status !== PROCESS_DECISION_STATUS.COMPLETE) {
          await fail({
            kind: DECISION_TEXT_FAILURE.STORAGE,
            code: "companion_write_pending",
          });
          return;
        }
      }
      const persisted = await persist(publisher.decision, null);
      if (persisted !== "textless") {
        return;
      }
      // The source may explicitly publish a record without an attachment.
      const latest = {
        ...row,
        metadata: publisher.decision.metadata,
        sourceHash: publisher.decision.rawHash,
        sourceUrl: publisher.decision.sourceUrl ?? row.sourceUrl,
      };
      const terminal = terminalPublisherTextState({
        adapterKey: registration.source.key,
        row: latest,
        now: now(),
      });
      if (terminal !== null && (await finish(terminal))) {
        summary.verified += 1;
        return;
      }
      let cause = textFailureFromObservation(publisher.decision.metadata);
      if (
        cause === null &&
        registration.source.key === ADAPTER_KEYS.PL_UOKIK &&
        publisher.decision.metadata[PL_UOKIK_DOCUMENT_ABSENCE_KEY] ===
          PL_UOKIK_DOCUMENT_ABSENCE.SCANNED
      ) {
        cause = {
          kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
          code: "ocr_required",
        };
      }
      cause ??= {
        kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
        code: "publisher_returned_no_readable_text",
      };
      await fail(cause, { type: DECISION_TEXT_RECOVERY.VERIFY_STORAGE });
      return;
    }
    case "built-supplement": {
      const outcome = await recoverSupplement({
        attempt,
        supplement: publisher.supplement,
        recovery: row.textState.recovery,
      });
      if (outcome === "continue") {
        await fail({
          kind: DECISION_TEXT_FAILURE.PARSER_REFUSAL,
          code: "supplement_has_no_readable_output",
        });
      }
      return;
    }
    default:
      publisher satisfies never;
      return panic("Unhandled full-text publisher recovery");
  }
};

const runRecoveryPhases = async (attempt: RecoveryAttempt): Promise<void> => {
  const { publisherAccess, lease, signal, fail, checkpoint, summary, policy } =
    attempt;
  let storageFailure: DecisionTextFailure | null = null;
  if (
    attempt.row.textState.recovery.type ===
    DECISION_TEXT_RECOVERY.VERIFY_STORAGE
  ) {
    const storage = await verifyHeldStorage(attempt);
    if (storage.type === "complete") {
      return;
    }
    storageFailure = storage.storageFailure;
  }
  if (
    attempt.row.textState.recovery.type !==
      DECISION_TEXT_RECOVERY.PUBLISHER_LISTING &&
    (await replayHeldRaw(attempt)) === "complete"
  ) {
    return;
  }
  if (publisherAccess === "disabled" || !lease.source.enabled) {
    if (storageFailure !== null) {
      await fail(storageFailure);
      return;
    }
    await checkpoint(
      attempt.row.textState.recovery,
      FULLTEXT_RECOVERY_LIMITS.MAX_RETRY_MS,
    );
    summary.continued += 1;
    return;
  }
  signal.throwIfAborted();
  if (policy.recovery === FULLTEXT_RECOVERY_KIND.DEFERRED_PDF) {
    await recoverDeferredDocument(attempt);
    return;
  }
  await recoverPublisherDocument(attempt);
};

/** A recoverable item failure gets durable backoff while the next item proceeds. */
const recoverHeldDecision = async (options: AttemptContext): Promise<void> => {
  const attempt = createRecoveryAttempt(options);
  const attempted = await Result.tryPromise({
    try: async () => await runRecoveryPhases(attempt),
    catch: (error) => error,
  });
  if (attempted.isErr()) {
    attempt.signal.throwIfAborted();
    await attempt.fail(
      textFailureFromError({
        error: attempted.error,
        phase: "storage",
        timeoutMs: FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS,
      }),
    );
  }
};

/** A fair bounded unit beside normal reconciliation, under its existing source lease. */
export const runDecisionFulltextRecoveryUnit = async ({
  sourceId,
  registration,
  publisherAccess,
  scopedDb,
  now,
  signal,
  ...seams
}: FulltextRecoveryUnitOptions): Promise<FulltextRecoveryUnitOutcome> => {
  const lease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId,
  });
  if (lease === null) {
    return { type: "leased" };
  }
  const unitSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(FULLTEXT_RECOVERY_LIMITS.ATTEMPT_TIMEOUT_MS),
  ]);
  try {
    if (lease.source.adapterKey !== registration.key) {
      return panic("Full-text worker source does not match its adapter");
    }
    const after = lease.source.config?.[SOURCE_RECOVERY_AFTER];
    if (after !== undefined) {
      if (
        typeof after !== "string" ||
        !Number.isFinite(new Date(after).getTime())
      ) {
        return panic("Invalid full-text source recovery schedule");
      }
      if (new Date(after).getTime() > now().getTime()) {
        return { type: "idle" };
      }
    }
    const summary = {
      adopted: 0,
      rechecked: 0,
      verified: 0,
      recovered: 0,
      failed: 0,
      continued: 0,
    };
    await lease.beforeDatabaseMark();
    summary.rechecked = await scheduleStaleDecisionTextProof({
      scopedDb,
      sourceId,
      now: now(),
    });
    let rows = await claimDecisionTextWork({ scopedDb, sourceId, now: now() });
    if (rows.length === 0) {
      summary.adopted = await adoptLegacyDecisionTextStates({
        scopedDb,
        sourceId,
        now: now(),
      });
      rows = await claimDecisionTextWork({ scopedDb, sourceId, now: now() });
    }
    for (const row of rows) {
      unitSignal.throwIfAborted();
      await recoverHeldDecision({
        row,
        registration,
        publisherAccess,
        scopedDb,
        sourceId,
        now,
        signal: unitSignal,
        lease,
        summary,
        ...seams,
      });
    }
    await lease.beforeDatabaseMark();
    await scopedDb(async (tx) => {
      // audit: skip - bounded public source recovery pacing after durable item claims.
      await tx
        .update(caseLawSources)
        .set({
          config: sql`jsonb_set(coalesce(${caseLawSources.config}, '{}'::jsonb), ${`{${SOURCE_RECOVERY_AFTER}}`}::text[], to_jsonb(${new Date(now().getTime() + SOURCE_RECOVERY_INTERVAL_MS).toISOString()}::text))`,
          updatedAt: sql`${caseLawSources.updatedAt}`,
        })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            eq(caseLawSources.ingestionLeaseToken, lease.leaseToken),
          ),
        );
    });
    return rows.length === 0 && summary.adopted === 0 && summary.rechecked === 0
      ? { type: "idle" }
      : { type: "worked", summary };
  } catch (error) {
    if (unitSignal.aborted) {
      return { type: "aborted" };
    }
    throw error;
  } finally {
    await lease.release();
  }
};
