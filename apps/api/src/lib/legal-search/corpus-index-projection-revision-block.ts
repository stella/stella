import { type InferOk, panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { Temporal } from "@stll/time";

import { corpusIndexProjectionStates } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import { PayloadBudgetError } from "@/api/lib/compression";
import type { ChunkBudgetError } from "@/api/lib/corpus-index/chunking";
import { settleBoth } from "@/api/lib/corpus-index/core";
import {
  MAX_TRANSPORT_WRAPPER_DEPTH,
  TRANSPORT_WRAPPERS,
} from "@/api/lib/errors/handler-error-resolution";
import type { StoredCorpusValidationError } from "@/api/lib/errors/tagged-errors";
import { corpusIndexDecisionTerms } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  buildCorpusProjectionDocuments,
  legislationV2NeedsPassages,
} from "@/api/lib/legal-search/corpus-index-projection-builder";
import {
  type CorpusIndexProjectionSubject,
  CorpusIndexProjectionSubjectMissingError,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  type CorpusProjectionAppendEntry,
  planCorpusProjectionAppendRequests,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  type CorpusProjectionMaterial,
  type CorpusProjectionMaterialsResult,
  readReservedCorpusProjectionMaterialsTx,
} from "@/api/lib/legal-search/corpus-index-projection-materials";
import {
  cancelCorpusProjectionReservationsTx,
  classifyCorpusProjectionReservationFailureTx,
  CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX,
  CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN,
  CORPUS_PROJECTION_RETRY_MAX_MS,
  CORPUS_PROJECTION_RETRY_MIN_MS,
  CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
  type CorpusProjectionIntentLease,
  type CorpusProjectionReservationFailure,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  readCorpusText,
  readSizedCorpusAst,
} from "@/api/lib/legal-search/corpus-reads";
import {
  readCorpusAtAuthoritativePointer,
  readCorpusForRecovery,
  type SizedCorpusAst,
} from "@/api/lib/legal-search/corpus-storage";
import { CaseLawDocumentLanguageUndeclaredError } from "@/api/lib/legal-search/morphology/corpus-language";
import type { StoredAstOutcome } from "@/api/lib/legal-search/stored-ast-outcome";
import { logger } from "@/api/lib/observability/logger";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { S3ObjectBudgetError } from "@/api/lib/s3";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedLegislationDocumentId,
} from "@/api/lib/safe-id-boundaries";

/**
 * What both delivery paths of a reserved revision share: reading its payload,
 * building its documents once, and settling a reservation that never reached
 * a start. The ingest-API executor and the offline build differ only in how a
 * started block travels to the engine.
 */
type ProjectionTransactionRunner = IngestionTransactionRunner<Transaction>;

export const mapSequentially = async <Input, Output>(
  values: readonly Input[],
  operation: (value: Input) => Promise<Output>,
  index = 0,
  outputs: Output[] = [],
): Promise<Output[]> => {
  const value = values.at(index);
  if (value === undefined) {
    return outputs;
  }
  outputs.push(await operation(value));
  return mapSequentially(values, operation, index + 1, outputs);
};

const CORPUS_PROJECTION_PAYLOAD_READ_CONCURRENCY_MAX = 32;

/** How payload reads may run, and how a failed one is retried. */
export type CorpusProjectionPayloadPolicy = {
  payloadReadConcurrency: number;
  retryDelayMs: number;
  payloadRetryLimit: number;
};

export const validateCorpusProjectionPayloadPolicy = ({
  payloadReadConcurrency,
  retryDelayMs,
  payloadRetryLimit,
}: CorpusProjectionPayloadPolicy): void => {
  if (
    !Number.isSafeInteger(payloadReadConcurrency) ||
    payloadReadConcurrency < 1 ||
    payloadReadConcurrency > CORPUS_PROJECTION_PAYLOAD_READ_CONCURRENCY_MAX
  ) {
    return panic(
      `Corpus projection payload read concurrency must be an integer from 1 to ${CORPUS_PROJECTION_PAYLOAD_READ_CONCURRENCY_MAX}`,
    );
  }
  if (
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < CORPUS_PROJECTION_RETRY_MIN_MS ||
    retryDelayMs > CORPUS_PROJECTION_RETRY_MAX_MS
  ) {
    return panic(
      `Corpus projection retry delay must be an integer from ${CORPUS_PROJECTION_RETRY_MIN_MS} to ${CORPUS_PROJECTION_RETRY_MAX_MS} milliseconds`,
    );
  }
  if (
    !Number.isSafeInteger(payloadRetryLimit) ||
    payloadRetryLimit < CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN ||
    payloadRetryLimit > CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX
  ) {
    return panic(
      `Corpus projection payload retry limit must be an integer from ${CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MIN} to ${CORPUS_PROJECTION_RETRY_ATTEMPT_LIMIT_MAX}`,
    );
  }
};

type CancelCorpusProjectionReservationsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  leases: readonly CorpusProjectionIntentLease[];
  errorMessage: string;
  /** Deterministic database-test clock; production reads PostgreSQL. */
  testNow?: Date | undefined;
};

export const cancelCorpusProjectionReservations = async ({
  runInTransaction,
  leases,
  errorMessage,
  testNow,
}: CancelCorpusProjectionReservationsOptions): Promise<{
  cancelled: number;
  leaseLost: number;
}> => {
  if (leases.length === 0) {
    return { cancelled: 0, leaseLost: 0 };
  }
  // One statement per store batch of each generation, each in its own short
  // transaction, never one statement per row.
  const batches = [
    ...Map.groupBy(
      leases,
      ({ family, generation }) => `${family}:${generation}`,
    ).values(),
  ].flatMap((sameGeneration) =>
    chunkItems(sameGeneration, CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE),
  );
  let cancelled = 0;
  let leaseLost = 0;
  for (const batch of batches) {
    // db-await-in-loop: one bounded cancel statement per store batch
    const outcome = await runInTransaction(
      async (tx) =>
        await cancelCorpusProjectionReservationsTx(tx, {
          leases: batch,
          errorMessage,
          testNow,
        }),
    );
    cancelled += outcome.cancelled;
    leaseLost += outcome.leaseLost;
  }
  return { cancelled, leaseLost };
};

export type CorpusProjectionReservationFailureOfLease = {
  lease: CorpusProjectionIntentLease;
  failure: CorpusProjectionReservationFailure;
};

export type CorpusProjectionReservationFailureCounts = {
  retryScheduled: number;
  blocked: number;
  staleCancelled: number;
  leaseLost: number;
};

type ClassifyCorpusProjectionReservationFailuresOptions = {
  runInTransaction: ProjectionTransactionRunner;
  failures: readonly CorpusProjectionReservationFailureOfLease[];
  /** Deterministic database-test clock; production reads PostgreSQL. */
  testNow?: Date | undefined;
};

export const classifyCorpusProjectionReservationFailures = async ({
  runInTransaction,
  failures,
  testNow,
}: ClassifyCorpusProjectionReservationFailuresOptions): Promise<CorpusProjectionReservationFailureCounts> => {
  if (failures.length === 0) {
    return {
      retryScheduled: 0,
      blocked: 0,
      staleCancelled: 0,
      leaseLost: 0,
    };
  }
  const classified = await runInTransaction(async (tx) => {
    const outcomes = await mapSequentially(failures, async (failure) =>
      classifyCorpusProjectionReservationFailureTx(tx, {
        intentId: failure.lease.intentId,
        leaseToken: failure.lease.leaseToken,
        failure: failure.failure,
        ...(testNow === undefined ? {} : { testNow }),
      }),
    );
    const blockedLeases = failures.flatMap((failure, index) =>
      outcomes.at(index) === "blocked" ? [failure.lease] : [],
    );
    const firstBlockedLease = blockedLeases.at(0);
    const blockedStates =
      firstBlockedLease === undefined
        ? []
        : await tx
            .select({
              entityId: corpusIndexProjectionStates.entityId,
              failureAttempts: corpusIndexProjectionStates.failureAttempts,
              lastFailureKind: corpusIndexProjectionStates.lastFailureKind,
            })
            .from(corpusIndexProjectionStates)
            .where(
              and(
                eq(
                  corpusIndexProjectionStates.family,
                  firstBlockedLease.family,
                ),
                eq(
                  corpusIndexProjectionStates.generation,
                  firstBlockedLease.generation,
                ),
                inArray(
                  corpusIndexProjectionStates.entityId,
                  blockedLeases.map(({ entityId }) => entityId),
                ),
              ),
            );
    return {
      retryScheduled: outcomes.filter(
        (outcome) => outcome === "retry_scheduled",
      ).length,
      blocked: outcomes.filter((outcome) => outcome === "blocked").length,
      staleCancelled: outcomes.filter(
        (outcome) => outcome === "stale_cancelled",
      ).length,
      leaseLost: outcomes.filter((outcome) => outcome === "lease_lost").length,
      blockedStates,
    };
  });
  for (const state of classified.blockedStates) {
    logger.warn("corpus_projection.append_blocked", {
      entity: state.entityId,
      kind:
        state.lastFailureKind ??
        panic(`Blocked projection has no failure kind: ${state.entityId}`),
      attempts: state.failureAttempts,
    });
  }
  return {
    retryScheduled: classified.retryScheduled,
    blocked: classified.blocked,
    staleCancelled: classified.staleCancelled,
    leaseLost: classified.leaseLost,
  };
};

/** What settling a material read's rejections did to its reservations. */
export type CorpusProjectionMaterialRejectionCounts = {
  /** Reservations whose material moved, cancelled for a later reservation. */
  cancelled: number;
  leaseLost: number;
  /** Unreadable material read again later, or blocked at its limit. */
  unread: number;
  retryScheduled: number;
  blocked: number;
  /**
   * Canonical mismatches whose desired state still named the reservation
   * after it was re-derived, so they wait out a retry or are blocked. They
   * are also counted in `retryScheduled` or `blocked`.
   */
  mismatchHeld: number;
};

/** Re-derive mismatched leases' desired states from their canonical rows. */
export type CorpusProjectionMismatchRederivation = (
  runInTransaction: ProjectionTransactionRunner,
  leases: readonly CorpusProjectionIntentLease[],
) => Promise<void>;

const subjectOfLease = ({
  family,
  entityId,
}: CorpusProjectionIntentLease): CorpusIndexProjectionSubject => {
  switch (family) {
    case "case_law":
      return { family, entityId: brandPersistedCaseLawDecisionId(entityId) };
    case "legislation":
      return {
        family,
        entityId: brandPersistedLegislationDocumentId(entityId),
      };
    default:
      family satisfies never;
      return panic(`Unhandled family: ${String(family)}`);
  }
};

/**
 * Re-derive the desired state of each mismatched entity from its canonical
 * row, one subject per transaction in the canonical writers' lock order, as
 * a repair does. A subject whose canonical row is gone, or whose repair is
 * held to keep a served copy, keeps its desired state; the classification
 * that follows then schedules it a retry.
 */
export const rederiveMismatchedCorpusProjectionDesiredStates: CorpusProjectionMismatchRederivation =
  async (runInTransaction, leases) => {
    await mapSequentially(leases, async (lease) => {
      const subject = subjectOfLease(lease);
      const reconciled = await Result.tryPromise({
        try: async () =>
          await runInTransaction(
            async (tx) =>
              await reconcileCorpusProjectionDesiredStateTx(tx, subject),
          ),
        catch: (cause) => cause,
      });
      if (reconciled.isOk()) {
        if (reconciled.value.isErr()) {
          logger.warn("corpus_projection.mismatch_repair_held", {
            entity: lease.entityId,
            generation: lease.generation,
          });
        }
        return;
      }
      if (
        reconciled.error instanceof CorpusIndexProjectionSubjectMissingError
      ) {
        return;
      }
      return await Promise.reject(reconciled.error);
    });
  };

type SettleRejectedCorpusProjectionMaterialsOptions = {
  runInTransaction: ProjectionTransactionRunner;
  rejected: CorpusProjectionMaterialsResult["rejected"];
  policy: Pick<
    CorpusProjectionPayloadPolicy,
    "retryDelayMs" | "payloadRetryLimit"
  >;
  testNow?: Date | undefined;
  /**
   * Database-test seam: a re-derivation that leaves some states where they
   * are, standing in for one whose derivation agrees with the desired state
   * while the material read does not.
   */
  rederive?: CorpusProjectionMismatchRederivation | undefined;
};

/**
 * Settle the reservations a material read refused. No refused reservation
 * leaves its desired state runnable at the same place with the same inputs,
 * so the next reservation never takes the same work again unchanged:
 * - a stale one is cancelled; its desired state already moved on and queues
 *   the newer work;
 * - a canonical mismatch has its desired state re-derived from the canonical
 *   row. Where that moved the state, the reservation is cancelled and the
 *   moved state is runnable at once. Where the state still names it, the
 *   state waits out a retry under the payload retry limit and is blocked at
 *   that limit, until a desired-state change resets it;
 * - an unreadable one is scheduled for a retry under the same limit;
 * - one whose lease is gone needs nothing.
 */
export const settleRejectedCorpusProjectionMaterials = async ({
  runInTransaction,
  rejected,
  policy,
  testNow,
  rederive = rederiveMismatchedCorpusProjectionDesiredStates,
}: SettleRejectedCorpusProjectionMaterialsOptions): Promise<CorpusProjectionMaterialRejectionCounts> => {
  const staleLeases = rejected
    .filter(({ status }) => status === "stale")
    .map(({ lease }) => lease);
  const mismatched = rejected.filter(
    ({ status }) => status === "canonical_input_mismatch",
  );
  const unreadable = rejected.filter(({ status }) => status === "unreadable");
  const cancellation = await cancelCorpusProjectionReservations({
    runInTransaction,
    leases: staleLeases,
    errorMessage: "projection material is no longer current",
    testNow,
  });
  await rederive(
    runInTransaction,
    mismatched.map(({ lease }) => lease),
  );
  const mismatches = await classifyCorpusProjectionReservationFailures({
    runInTransaction,
    failures: mismatched.map(({ lease, reason }) => ({
      lease,
      failure: {
        status: "retry_scheduled",
        kind: "canonical_input_mismatch",
        retryDelayMs: policy.retryDelayMs,
        maxAttempts: policy.payloadRetryLimit,
        message: reason,
      },
    })),
    testNow,
  });
  const retries = await classifyCorpusProjectionReservationFailures({
    runInTransaction,
    failures: unreadable.map(({ lease, reason }) => ({
      lease,
      failure: {
        status: "retry_scheduled",
        kind: "payload_unavailable",
        retryDelayMs: policy.retryDelayMs,
        maxAttempts: policy.payloadRetryLimit,
        message: reason,
      },
    })),
    testNow,
  });
  return {
    cancelled:
      cancellation.cancelled +
      mismatches.staleCancelled +
      retries.staleCancelled,
    leaseLost:
      rejected.filter(({ status }) => status === "lease_lost").length +
      cancellation.leaseLost +
      mismatches.leaseLost +
      retries.leaseLost,
    unread: unreadable.length,
    retryScheduled: mismatches.retryScheduled + retries.retryScheduled,
    blocked: mismatches.blocked + retries.blocked,
    mismatchHeld: mismatches.retryScheduled + mismatches.blocked,
  };
};

const rereadMaterial = async (
  runInTransaction: ProjectionTransactionRunner,
  lease: CorpusProjectionIntentLease,
): Promise<CorpusProjectionMaterial | null> => {
  const current = await runInTransaction(
    async (tx) =>
      await readReservedCorpusProjectionMaterialsTx(tx, { leases: [lease] }),
  );
  return current.ready.at(0) ?? null;
};

/** A revision's AST as indexing reads it, and what that read came to. */
export type ProjectionAst = {
  ast: SizedCorpusAst["ast"];
  storedAst: StoredAstOutcome;
};

/**
 * Indexing can recover structure only beside usable document text. A stored
 * AST the reader refuses then indexes the text alone, and the read is the
 * typed `unreadable` outcome, so the batch counts it rather than passing it.
 */
export const projectionAstOfRead = (
  astRead: Result<SizedCorpusAst, StoredCorpusValidationError>,
  text: string,
): Result<ProjectionAst, StoredCorpusValidationError> => {
  if (astRead.isOk()) {
    return Result.ok({
      ast: astRead.value.ast,
      storedAst: astRead.value.outcome,
    });
  }
  if (text.trim().length === 0) {
    return Result.err(astRead.error);
  }
  return Result.ok({
    ast: null,
    storedAst: { type: "unreadable", reason: "stored_ast_invalid" },
  });
};

const NO_STORED_AST = {
  ast: null,
  storedAst: { type: "absent" },
} as const satisfies ProjectionAst;

export const loadCorpusProjectionPayload = async (
  runInTransaction: ProjectionTransactionRunner,
  material: CorpusProjectionMaterial,
) =>
  await Result.gen(async function* () {
    let currentPromise: Promise<CorpusProjectionMaterial | null> | undefined;
    const current = async () => {
      currentPromise ??= rereadMaterial(runInTransaction, material.lease);
      return await currentPromise;
    };
    const textPromise = readCorpusAtAuthoritativePointer({
      storedKey: material.textS3Key,
      read: readCorpusText,
      rereadStoredKey: async () => (await current())?.textS3Key ?? null,
    });
    if (material.astS3Key === null) {
      return Result.ok({ text: await textPromise, ...NO_STORED_AST });
    }
    const storedAstPointer = material.astS3Key;
    const report = {
      documentId: material.input.documentId,
      jurisdiction: material.input.jurisdiction,
    };
    const loadAst = async () =>
      await readCorpusForRecovery({
        documentId: material.lease.entityId,
        read: async () =>
          await readCorpusAtAuthoritativePointer({
            storedKey: storedAstPointer,
            read: async (storedKey) =>
              await readSizedCorpusAst(storedKey, { report }),
            rereadStoredKey: async () => {
              const replacement = await current();
              return replacement?.astS3Key ?? null;
            },
          }),
      });
    if (material.family === "case_law") {
      const [text, astRead] = await settleBoth(textPromise, loadAst());
      const projected = yield* projectionAstOfRead(astRead, text);
      return Result.ok({ text, ...projected });
    }
    const text = await textPromise;
    if (
      !legislationV2NeedsPassages({
        input: material.input,
        text,
        revision: material.lease.intentId,
      })
    ) {
      return Result.ok({ text, ...NO_STORED_AST });
    }
    const projected = yield* projectionAstOfRead(await loadAst(), text);
    return Result.ok({ text, ...projected });
  });

export type CorpusProjectionPayloadReader = typeof loadCorpusProjectionPayload;

type LoadedCorpusProjectionPayload = InferOk<
  Awaited<ReturnType<typeof loadCorpusProjectionPayload>>
>;

export type CorpusProjectionRevisionBuildFailure = {
  kind:
    | "payload_unavailable"
    | "revision_too_large"
    | "document_language_undeclared";
  message: string;
};

export const classifyCorpusProjectionPayloadReadFailure = (
  error: unknown,
): CorpusProjectionRevisionBuildFailure => {
  let cause = error;
  for (let depth = 0; depth <= MAX_TRANSPORT_WRAPPER_DEPTH; depth++) {
    const candidate = cause;
    if (
      candidate instanceof PayloadBudgetError ||
      candidate instanceof S3ObjectBudgetError
    ) {
      return {
        kind: "revision_too_large",
        message: "projection payload exceeds the transfer or decode ceiling",
      };
    }
    if (
      !(candidate instanceof Error) ||
      !TRANSPORT_WRAPPERS.some((wrapper) => wrapper.is(candidate))
    ) {
      break;
    }
    cause = candidate.cause;
  }
  return {
    kind: "payload_unavailable",
    message: "projection payload read failed before append",
  };
};

/**
 * The reservation failure a revision that could not be built records: an
 * unavailable payload retries under the payload retry limit, and one over a
 * ceiling blocks, as no retry can shrink it.
 */
export const corpusProjectionRevisionBuildFailure = (
  lease: CorpusProjectionIntentLease,
  failure: CorpusProjectionRevisionBuildFailure,
  policy: Pick<
    CorpusProjectionPayloadPolicy,
    "retryDelayMs" | "payloadRetryLimit"
  >,
): CorpusProjectionReservationFailureOfLease => {
  switch (failure.kind) {
    case "payload_unavailable":
      return {
        lease,
        failure: {
          status: "retry_scheduled",
          kind: failure.kind,
          retryDelayMs: policy.retryDelayMs,
          maxAttempts: policy.payloadRetryLimit,
          message: failure.message,
        },
      };
    // Neither shrinks nor changes language on a retry. A corrected row, or a
    // declaration of the language (which changes the decision's fingerprint,
    // see the descriptor), makes it eligible again.
    case "revision_too_large":
    case "document_language_undeclared":
      return {
        lease,
        failure: {
          status: "blocked",
          kind: failure.kind,
          message: failure.message,
        },
      };
    default:
      failure.kind satisfies never;
      return panic(`Unhandled revision build failure: ${String(failure.kind)}`);
  }
};

/**
 * One reserved revision's documents as NDJSON, independent of how the block
 * is delivered. `parts` split it at document boundaries within the ingest
 * request ceiling (one document alone may exceed it); joined with newlines
 * they are the whole block.
 */
export type CorpusProjectionRevisionBlock = {
  material: CorpusProjectionMaterial;
  documentCount: number;
  parts: readonly [string, ...string[]];
  /**
   * How the decision's terms were written, on a generation that maps them:
   * `prefix` when they did not fit the opening passage and were cut, which
   * the executor counts and reports, because a reader then learns the
   * decision's words from its passages rather than from the decision field.
   */
  decisionTerms: CorpusProjectionDecisionTermsWritten;
  /**
   * What the read of the revision's stored AST came to, already reported
   * per document; the batch counts it, so a degraded, structureless or
   * unreadable AST never passes a run silently.
   */
  storedAst: StoredAstOutcome;
};

type CorpusProjectionDecisionTermsWritten = "not_mapped" | "whole" | "prefix";

/** Read off the documents as the engine receives them: the opening carries the mark. */
const decisionTermsWritten = (
  material: CorpusProjectionMaterial,
  documents: readonly Record<string, unknown>[],
): CorpusProjectionDecisionTermsWritten => {
  const field =
    material.family === "case_law"
      ? corpusIndexDecisionTerms(material.manifest)
      : null;
  if (field === null) {
    return "not_mapped";
  }
  return documents.some((document) => document[field.partialField] === true)
    ? "prefix"
    : "whole";
};

/** A revision's documents, serialized once and checked against the ceilings. */
/**
 * The failure a revision whose documents could not be built records. A
 * decision in a language its jurisdiction does not declare names itself, its
 * jurisdiction and its language, so the blocked state says which row to
 * correct or which declaration to extend.
 */
const revisionBuildErrorFailure = (
  material: CorpusProjectionMaterial,
  error: ChunkBudgetError | CaseLawDocumentLanguageUndeclaredError,
): CorpusProjectionRevisionBuildFailure =>
  CaseLawDocumentLanguageUndeclaredError.is(error)
    ? {
        kind: "document_language_undeclared",
        message: `case-law decision ${material.input.documentId} of ${error.jurisdiction} is written in "${error.language}", a language its jurisdiction does not declare`,
      }
    : {
        kind: "revision_too_large",
        message: "projection payload exceeds the structural build ceiling",
      };

const buildCorpusProjectionRevisionBlock = (
  material: CorpusProjectionMaterial,
  payload: LoadedCorpusProjectionPayload,
): Result<
  CorpusProjectionRevisionBlock,
  CorpusProjectionRevisionBuildFailure
> => {
  const built = (() => {
    switch (material.family) {
      case "case_law":
        return buildCorpusProjectionDocuments({
          family: material.family,
          manifest: material.manifest,
          input: material.input,
          payload,
          revision: material.lease.intentId,
        });
      case "legislation":
        return buildCorpusProjectionDocuments({
          family: material.family,
          manifest: material.manifest,
          input: material.input,
          payload,
          revision: material.lease.intentId,
        });
      default:
        material satisfies never;
        return panic(`Unhandled material: ${String(material)}`);
    }
  })();
  if (built.isErr()) {
    return Result.err(revisionBuildErrorFailure(material, built.error));
  }
  const entry = {
    revision: material.lease.intentId,
    documents: built.value,
  } satisfies CorpusProjectionAppendEntry;
  const planned = planCorpusProjectionAppendRequests([entry]);
  if (planned.isErr()) {
    if (planned.error.code === "revision_too_large") {
      return Result.err({
        kind: "revision_too_large",
        message: "projection revision exceeds the append safety ceiling",
      });
    }
    return panic(planned.error.message);
  }
  const [first, ...rest] = planned.value.map(({ ndjson }) => ndjson);
  if (first === undefined) {
    return panic("Projection revision did not produce an append request");
  }
  return Result.ok({
    material,
    documentCount: entry.documents.length,
    parts: [first, ...rest],
    decisionTerms: decisionTermsWritten(material, entry.documents),
    storedAst: payload.storedAst,
  });
};

type LoadCorpusProjectionRevisionBlockOptions = {
  runInTransaction: ProjectionTransactionRunner;
  material: CorpusProjectionMaterial;
  /** Records the synchronous build's share of the payload window. */
  recordBuildMs: (elapsedMs: number) => void;
  payloadReader: CorpusProjectionPayloadReader;
};

/** Read a reserved revision's payload and build its block. */
export const loadCorpusProjectionRevisionBlock = async ({
  runInTransaction,
  material,
  recordBuildMs,
  payloadReader,
}: LoadCorpusProjectionRevisionBlockOptions): Promise<
  Result<CorpusProjectionRevisionBlock, CorpusProjectionRevisionBuildFailure>
> => {
  // Without the `catch` mapper the cause is wrapped, and every budget failure
  // would classify as a transient `payload_unavailable` and retry forever
  // instead of blocking.
  const payload = await Result.tryPromise({
    try: async () => await payloadReader(runInTransaction, material),
    catch: (cause: unknown) => cause,
  });
  if (payload.isErr()) {
    return Result.err(
      classifyCorpusProjectionPayloadReadFailure(payload.error),
    );
  }
  if (payload.value.isErr()) {
    return Result.err(
      classifyCorpusProjectionPayloadReadFailure(payload.value.error),
    );
  }
  // The build is synchronous, so one span covers all of it and the spans of
  // concurrent revisions cannot overlap.
  const buildStartedAt = Temporal.Now.instant().epochMilliseconds;
  const block = buildCorpusProjectionRevisionBlock(
    material,
    payload.value.value,
  );
  recordBuildMs(Temporal.Now.instant().epochMilliseconds - buildStartedAt);
  return block;
};
