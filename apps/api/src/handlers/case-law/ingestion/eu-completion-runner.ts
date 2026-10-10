import { panic, Result, TaggedError, type InferOk } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { TransformStream } from "node:stream/web";

// parser-output-unchanged: SHA-256 ownership changes preserve input bytes, serialization and update order, so stored hashes and parser output remain identical.
import { createSha256 } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawDecisionJudges,
  caseLawSources,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  type IngestionResult,
  type StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  ECJ_LANGUAGES,
  euEcjAdapter,
  fetchDecisionsByCelex,
  isValidCelex,
  refreshEcjStoredFormex,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { withPublisherRequestRateLimit } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  readCorpusText,
  readCorpusAst,
  type CorpusByteSourceSeams,
} from "@/api/lib/legal-search/corpus-storage";
import { corpusTombstoneReaderForTx } from "@/api/lib/legal-search/corpus-tombstones";
import {
  readS3ObjectBoundedIfPresent,
  S3ObjectBudgetError,
} from "@/api/lib/s3";

import {
  EuCompletionStop,
  EU_COMPLETION_LIMITS,
  type EuCompletionRowOptions,
  type EuCompletionRowOutcome,
} from "./eu-completion";
import {
  ecjCompletionFingerprint,
  protectEcjCompletion,
  protectEcjFormexParts,
  protectEcjLegacyDocument,
} from "./eu-completion-protection";
import {
  capRefusalHold,
  CompletionPayloadTooLarge,
  euCompletionDecisionNotWithdrawn,
} from "./eu-completion-store";
import type {
  createEuCompletionStore,
  EuCompletionReceipt,
  EuCompletionFailure,
} from "./eu-completion-store";

class CompletionReviewRequired extends TaggedError("CompletionReviewRequired")<{
  message: string;
}> {}
class CompletionSupersededByCrawl extends TaggedError(
  "CompletionSupersededByCrawl",
)<{ message: string }> {}
class CompletionPublisherGone extends TaggedError("CompletionPublisherGone")<{
  message: string;
}> {}
class CompletionWithdrawn extends TaggedError("CompletionWithdrawn")<{
  message: string;
}> {}
class CompletionStageFailure extends TaggedError("CompletionStageFailure")<{
  message: string;
  code: EuCompletionFailure["code"];
  scope: EuCompletionFailure["scope"];
  cause: unknown;
}> {}

const MAX_COMPLETION_JUDGES = 1000;
const COMPLETION_DEFER_MS = 60_000;
const digest = (payload: string) =>
  createSha256().update(payload).digest("hex");

/** The canonical writer and storage APIs still reject promises; this is their typed boundary. */
const legacyOperation = async <T>(operation: () => Promise<T>) =>
  await Result.tryPromise({ try: operation, catch: (error) => error });

const loadDecisionTx = async (tx: Transaction, receipt: EuCompletionReceipt) =>
  await Result.gen(async function* () {
    const row = (yield* Result.await(
      legacyOperation(
        async () =>
          await tx
            .select()
            .from(caseLawDecisions)
            .where(
              and(
                eq(caseLawDecisions.id, receipt.decisionId),
                eq(caseLawDecisions.sourceId, receipt.sourceId),
              ),
            )
            .for("update")
            .limit(1),
      ),
    )).at(0);
    if (row === undefined || row.redactedAt !== null) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Decision missing or redacted",
        }),
      );
    }
    // A withdrawal may commit while the lock waits. Read its marker with the
    // next statement snapshot after acquiring the decision lock.
    const withdrawal =
      (yield* Result.await(
        legacyOperation(
          async () =>
            await tx
              .select({ notWithdrawn: euCompletionDecisionNotWithdrawn() })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, row.id))
              .limit(1),
        ),
      )).at(0) ?? panic("Locked completion decision disappeared");
    if (!withdrawal.notWithdrawn) {
      return Result.err(
        new CompletionWithdrawn({ message: "Decision has been withdrawn" }),
      );
    }
    const judges = yield* Result.await(
      legacyOperation(
        async () =>
          await readBounded(
            tx
              .select({
                role: caseLawDecisionJudges.role,
                nameAsPrinted: caseLawDecisionJudges.nameAsPrinted,
              })
              .from(caseLawDecisionJudges)
              .where(eq(caseLawDecisionJudges.decisionId, row.id))
              .orderBy(
                asc(caseLawDecisionJudges.role),
                asc(caseLawDecisionJudges.position),
              ),
            MAX_COMPLETION_JUDGES,
          ),
      ),
    );
    if (judges.type === "overflow") {
      return Result.err(
        new CompletionReviewRequired({
          message: "Stored bench exceeds the completion comparison budget",
        }),
      );
    }
    return Result.ok({ row, judges: judges.rows });
  });

type DecisionSnapshot = InferOk<Awaited<ReturnType<typeof loadDecisionTx>>>;
const matchesWrittenMarker = (
  receipt: EuCompletionReceipt,
  row: DecisionSnapshot["row"],
) =>
  receipt.writtenAt !== null &&
  receipt.writtenSourceHash !== null &&
  receipt.writtenParserVersion !== null &&
  receipt.writtenObservationOrder !== null &&
  row.sourceHash === receipt.writtenSourceHash &&
  row.parserVersion === receipt.writtenParserVersion &&
  row.sourceObservationOrder === receipt.writtenObservationOrder;

type CompletionRunnerOptions = {
  rootDb: CaseLawRootHandle;
  ingestionDb: ScopedDb;
  store: ReturnType<typeof createEuCompletionStore>;
  sourceLease: () => CaseLawSourceIngestionLease | null;
  signal: AbortSignal;
  check: () => Promise<Result<void, unknown>>;
  raiseFailure: (error: unknown) => never;
  onRequest: () => void;
  isEnabled: () => boolean;
  beforeWriteFence?: () => Promise<void>;
};
type CompletionPublisherState = {
  requests: number;
  publisherSuccess: boolean;
  bytes: number;
  refusal: number | null;
  publisherFailure: { error: unknown } | null;
};
type CompletionContext = CompletionRunnerOptions &
  EuCompletionRowOptions & {
    receipt: EuCompletionReceipt;
    ensure: () => Promise<Result<void, unknown>>;
    state: CompletionPublisherState;
  };
type CandidateContext = CompletionContext & DecisionSnapshot;
type CompletionCandidate =
  | { type: "candidate"; candidate: IngestionResult; target: "formex" | "full" }
  | { type: "unchanged" };
type RowResult = Result<EuCompletionRowOutcome, unknown>;

const storedInput = (
  row: typeof caseLawDecisions.$inferSelect,
): Omit<StoredRawReparseInput, "raw"> => ({
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
const readStoredRaw = async ({ row, signal, ensure }: CandidateContext) =>
  await Result.gen(async function* () {
    yield* Result.await(ensure());
    const read = await legacyOperation(async () => {
      if (row.sourceRawS3Key !== null) {
        const boundedSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
        ]);
        const value = await readS3ObjectBoundedIfPresent({
          key: row.sourceRawS3Key,
          maxBytes: EU_COMPLETION_LIMITS.maxBytes,
          signal: boundedSignal,
          s3Policy: { mode: "replay-strict", signal: boundedSignal },
        });
        return value === null ? null : new Uint8Array(value);
      }
      return row.sourceRaw === null
        ? null
        : new TextEncoder().encode(row.sourceRaw);
    });
    if (read.isErr() && signal.aborted) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion cancelled",
          reason: "cancelled",
        }),
      );
    }
    if (read.isErr() && read.error instanceof S3ObjectBudgetError) {
      return Result.err(
        new CompletionPayloadTooLarge({
          message: "Stored raw exceeds the document byte limit",
        }),
      );
    }
    if (read.isErr()) {
      return Result.err(
        new CompletionStageFailure({
          message: "Stored raw read failed",
          code: "storage",
          scope: "systemic",
          cause: read.error,
        }),
      );
    }
    if (
      read.value !== null &&
      read.value.byteLength > EU_COMPLETION_LIMITS.maxBytes
    ) {
      return Result.err(
        new CompletionPayloadTooLarge({
          message: "Stored raw exceeds the document byte limit",
        }),
      );
    }
    if (read.value === null && row.sourceRawS3Key !== null) {
      return Result.err(
        new CompletionStageFailure({
          message: "Stored raw reference is missing",
          code: "storage",
          scope: "systemic",
          cause: null,
        }),
      );
    }
    return read;
  });

type FullCandidateOptions = Pick<CandidateContext, "row" | "signal" | "ensure">;
const fetchFullCompletionCandidate = async (
  { row, signal, ensure }: FullCandidateOptions,
  raw: Uint8Array | null,
) =>
  await Result.gen(async function* () {
    if (
      raw !== null &&
      Object.keys(decodeSourceRawEnvelopeObjects(new TextDecoder().decode(raw)))
        .length > 0
    ) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Stored binary source parts require review",
        }),
      );
    }
    const celex =
      typeof row.metadata?.["celex"] === "string"
        ? row.metadata["celex"]
        : row.sourceDocumentId?.split(":").at(0);
    const language = ECJ_LANGUAGES.find(
      (value) => value.toLowerCase() === row.language.toLowerCase(),
    );
    if (
      celex === undefined ||
      !isValidCelex(celex) ||
      language === undefined ||
      row.sourceDocumentId === null
    ) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Full completion has no exact publisher identity",
        }),
      );
    }
    const fetched = yield* Result.await(
      legacyOperation(
        async () =>
          await fetchDecisionsByCelex({
            celexNumbers: [celex],
            languages: [language],
            signal,
          }),
      ),
    );
    yield* Result.await(ensure());
    const matches = fetched.filter(
      (value) =>
        value.sourceDocumentId === row.sourceDocumentId &&
        value.language === row.language,
    );
    if (matches.length === 0) {
      return Result.err(
        new CompletionPublisherGone({
          message: "Selected publisher document is gone",
        }),
      );
    }
    if (matches.length !== 1) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Publisher did not return exactly the selected identity",
        }),
      );
    }
    const candidate =
      matches.at(0) ?? panic("Selected publisher candidate disappeared");
    // A variant whose every manifestation failed to build is present but
    // unusable: neither gone nor a conflict to review.
    if (candidate.plainTextOutcome.type === "item_build_failed") {
      return Result.err(
        new CompletionStageFailure({
          message: "Publisher document did not build",
          code: "parse",
          scope: "row",
          cause: candidate.plainTextOutcome.error,
        }),
      );
    }
    if (raw !== null) {
      const preserved = protectEcjLegacyDocument({
        storedRaw: raw,
        storedRawContentType: row.sourceRawContentType,
        candidate,
      });
      if (preserved.type === "review-required") {
        return Result.err(
          new CompletionReviewRequired({
            message: "Full completion changed existing legacy document bytes",
          }),
        );
      }
    }
    return Result.ok(candidate);
  });

const fetchCompletionCandidate = async (
  { row, signal, ensure, state }: CandidateContext,
  raw: Uint8Array | null,
): Promise<Result<CompletionCandidate, unknown>> =>
  await Result.gen(async function* () {
    const parts =
      raw === null
        ? null
        : decodeSourceRawEnvelope(new TextDecoder().decode(raw));
    if (raw === null || parts?.["notice"] === undefined) {
      const candidate = yield* Result.await(
        fetchFullCompletionCandidate({ row, signal, ensure }, raw),
      );
      return Result.ok({
        type: "candidate",
        candidate,
        target: "full",
      } satisfies CompletionCandidate);
    }
    const refreshed = yield* Result.await(
      legacyOperation(
        async () =>
          await refreshEcjStoredFormex({
            stored: { ...storedInput(row), raw },
            signal,
          }),
      ),
    );
    yield* Result.await(ensure());
    switch (refreshed.type) {
      case "refreshed": {
        const preserved = protectEcjFormexParts({
          storedRaw: raw,
          storedRawContentType: row.sourceRawContentType,
          candidate: refreshed.decision,
        });
        if (preserved.type === "review-required") {
          return Result.err(
            new CompletionReviewRequired({
              message: "Formex changed existing source parts",
            }),
          );
        }
        return Result.ok({
          type: "candidate",
          candidate: refreshed.decision,
          target: "formex",
        } satisfies CompletionCandidate);
      }
      case "unchanged-already-current":
        return Result.ok({
          type: "unchanged",
        } satisfies EuCompletionRowOutcome);
      case "rate-limited":
        state.refusal = capRefusalHold(
          refreshed.cooldownUntilEpochMs,
          Temporal.Now.instant().epochMilliseconds,
        );
        return Result.err(
          new EuCompletionStop({
            message: "Publisher refused completion",
            reason: "publisher-refused",
          }),
        );
      case "retryable-exhausted":
        return Result.err(
          new CompletionStageFailure({
            message: "Formex fetch did not complete",
            code: "publisher",
            scope: "systemic",
            cause: null,
          }),
        );
      case "formex-gone":
        return Result.err(
          new CompletionPublisherGone({
            message: "Selected Formex manifestation is gone",
          }),
        );
      // The publisher refused this document's Formex part only; the row
      // retries on the normal cadence and other rows continue.
      case "formex-refused":
        return Result.err(
          new CompletionStageFailure({
            message: `Publisher refused the Formex part (${String(refreshed.status)})`,
            code: "publisher",
            scope: "row",
            cause: null,
          }),
        );
      case "notice-missing":
      case "formex-not-located":
      case "write-rejected":
        return Result.err(
          new CompletionReviewRequired({
            message: `Formex completion requires review: ${refreshed.type}`,
          }),
        );
      default:
        refreshed satisfies never;
        return panic("Unknown Formex completion outcome");
    }
  });

const recoverCompletionCandidate = async ({
  row,
  receipt,
}: CandidateContext) => {
  const payload =
    receipt.payload ?? panic("Completion recovery has no payload");
  if (digest(payload) !== receipt.payloadHash) {
    return Result.err(
      new CompletionReviewRequired({
        message: "Fetched recovery payload hash mismatch",
      }),
    );
  }
  const reparse =
    euEcjAdapter.reparseStoredRaw ??
    panic("ECJ completion requires stored raw reparsing");
  const parsed = await Result.tryPromise({
    try: async () =>
      await reparse({
        ...storedInput(row),
        raw: new TextEncoder().encode(payload),
        contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      }),
    catch: (error) => error,
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  if (parsed.value.type !== "parsed") {
    return Result.err(
      new CompletionReviewRequired({
        message: "Fetched envelope cannot be reparsed",
      }),
    );
  }
  if (receipt.target === null) {
    return panic("Fetched receipt has no target");
  }
  return Result.ok(parsed.value.result);
};

const prepareCompletionCandidate = async (
  context: CandidateContext,
  fingerprint: string,
): Promise<Result<CompletionCandidate, unknown>> =>
  await Result.gen(async function* () {
    const { row, receipt, ensure, store } = context;
    if (receipt.payload !== null) {
      const candidate = yield* Result.await(
        recoverCompletionCandidate(context),
      );
      return Result.ok({
        type: "candidate",
        candidate,
        target: receipt.target ?? panic("Fetched receipt has no target"),
      } satisfies CompletionCandidate);
    }
    if (
      row.sourceHash !== receipt.claimedSourceHash ||
      row.sourceObservationOrder !== receipt.claimedObservationOrder
    ) {
      return Result.err(
        new CompletionSupersededByCrawl({
          message: "Decision source changed after reservation",
        }),
      );
    }
    const raw = yield* Result.await(readStoredRaw(context));
    const fetched = yield* Result.await(fetchCompletionCandidate(context, raw));
    if (fetched.type === "unchanged") {
      yield* Result.await(ensure());
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({
              id: receipt.id,
              status: "unchanged",
              publisherSuccess: context.state.publisherSuccess,
            }),
        ),
      );
      return Result.ok(fetched);
    }
    const { candidate, target } = fetched;
    const payload = candidate.sourceRaw;
    if (
      payload === undefined ||
      candidate.sourceRawBytes !== undefined ||
      candidate.sourceRawObjects !== undefined
    ) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Completion requires a recoverable textual envelope",
        }),
      );
    }
    const parts = decodeSourceRawEnvelope(payload);
    if (
      parts === null ||
      (target === "full"
        ? ["listing", "notice", "document", "formex"]
        : ["formex"]
      ).some((part) => parts[part] === undefined)
    ) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Publisher did not supply the requested completion surfaces",
        }),
      );
    }
    yield* Result.await(ensure());
    const fetchedReceipt = yield* Result.await(
      legacyOperation(
        async () =>
          await store.markFetched({
            id: receipt.id,
            payload,
            payloadHash: digest(payload),
            claimedFingerprint: fingerprint,
            target,
            provenance: {
              requestHashes: [digest(payload)],
              requestedSurfaces:
                target === "formex"
                  ? ["formex"]
                  : ["listing", "notice", "document", "formex"],
            },
          }),
      ),
    );
    if (fetchedReceipt.isErr()) {
      return fetchedReceipt;
    }
    const saved = fetchedReceipt.value;
    if (saved === null) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Completion receipt moved before fetched persistence",
        }),
      );
    }
    return Result.ok(fetched);
  });

type CompletionWriteContext = CompletionContext & {
  candidate: IngestionResult;
  lease: CaseLawSourceIngestionLease;
  observationOrder: bigint;
};
const checkCompletionWriteTx = async (
  tx: Transaction,
  { signal, store, receipt, lease }: CompletionWriteContext,
) =>
  await Result.gen(async function* () {
    if (signal.aborted) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion cancelled",
          reason: "cancelled",
        }),
      );
    }
    const approved = yield* Result.await(
      legacyOperation(async () => await store.assertApprovalTx(tx, receipt)),
    );
    if (!approved) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion approval or controls revoked",
          reason: "off",
        }),
      );
    }
    const source = (yield* Result.await(
      legacyOperation(
        async () =>
          await tx
            .select({
              token: caseLawSources.ingestionLeaseToken,
              expiry: caseLawSources.ingestionLeaseExpiresAt,
            })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, receipt.sourceId))
            .for("update")
            .limit(1),
      ),
    )).at(0);
    if (
      source?.token !== lease.leaseToken ||
      source.expiry === null ||
      source.expiry.getTime() <= Temporal.Now.instant().epochMilliseconds
    ) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion source lease lost",
          reason: "cancelled",
        }),
      );
    }
    const currentReceipt = yield* Result.await(
      legacyOperation(async () => await store.assertFetchedTx(tx, receipt.id)),
    );
    if (currentReceipt === null) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Completion receipt no longer fetched",
        }),
      );
    }
    const current = yield* Result.await(loadDecisionTx(tx, receipt));
    if (
      !matchesWrittenMarker(currentReceipt, current.row) &&
      (current.row.sourceObservationOrder !==
        currentReceipt.claimedObservationOrder ||
        ecjCompletionFingerprint({
          existing: current.row,
          judges: current.judges,
        }) !== currentReceipt.claimedFingerprint)
    ) {
      return Result.err(
        new CompletionSupersededByCrawl({
          message: "Completion claimed statements changed before apply",
        }),
      );
    }
    return Result.ok();
  });
const markCompletionWriteTx = async (
  tx: Transaction,
  {
    signal,
    receipt,
    store,
    observationOrder,
    candidate,
  }: CompletionWriteContext,
) =>
  await Result.gen(async function* () {
    if (signal.aborted) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion cancelled",
          reason: "cancelled",
        }),
      );
    }
    const current = yield* Result.await(loadDecisionTx(tx, receipt));
    if (
      current.row.sourceObservationOrder === observationOrder &&
      current.row.sourceHash === candidate.rawHash
    ) {
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.markWrittenTx(tx, {
              id: receipt.id,
              decisionId: receipt.decisionId,
            }),
        ),
      );
    }
    return Result.ok();
  });
// The write runs inside a transaction that already holds the lane; the budget
// only needs to cover the re-entrant try, and a zero budget refuses even that.
const COMPLETION_WRITE_LANE_WAIT_MS = 5000;
const createCompletionWriteDb = (context: CompletionWriteContext) =>
  createIngestionDb(
    markRlsDatabase({
      transaction: context.rootDb.transaction.bind(context.rootDb),
    }),
    {
      laneWaitMs: COMPLETION_WRITE_LANE_WAIT_MS,
      maintenance: {
        before: async (tx) => {
          await context.beforeWriteFence?.();
          const checked = await checkCompletionWriteTx(tx, context);
          if (checked.isErr()) {
            context.raiseFailure(checked.error);
          }
        },
        after: async (tx) => {
          const marked = await markCompletionWriteTx(tx, context);
          if (marked.isErr()) {
            context.raiseFailure(marked.error);
          }
        },
      },
    },
  );

type GuardedLeaseOptions = Pick<
  CompletionContext,
  "ensure" | "raiseFailure"
> & { lease: CaseLawSourceIngestionLease };
const createGuardedLease = ({
  lease,
  ensure,
  raiseFailure,
}: GuardedLeaseOptions): CaseLawSourceIngestionLease => ({
  source: lease.source,
  leaseToken: lease.leaseToken,
  purpose: lease.purpose,
  release: lease.release,
  beforeDatabaseMark: async () => {
    const admitted = await ensure();
    if (admitted.isErr()) {
      raiseFailure(admitted.error);
    }
    await lease.beforeDatabaseMark();
    const checked = await ensure();
    if (checked.isErr()) {
      raiseFailure(checked.error);
    }
  },
  beforeRemoteEffect: async (effect) => {
    const admitted = await ensure();
    if (admitted.isErr()) {
      raiseFailure(admitted.error);
    }
    return await lease.beforeRemoteEffect(async () => {
      const checked = await ensure();
      if (checked.isErr()) {
        raiseFailure(checked.error);
      }
      return await effect();
    });
  },
});

const finalizeWrittenCompletion = async (
  context: CompletionContext,
): Promise<RowResult> =>
  await Result.gen(async function* () {
    yield* Result.await(context.ensure());
    const settled = yield* Result.await(
      legacyOperation(
        async () =>
          await context.store.finalize(
            context.receipt.id,
            context.state.publisherSuccess,
          ),
      ),
    );
    if (settled === "retryable") {
      const waiting = yield* Result.await(
        legacyOperation(
          async () => await context.store.waitForMirror(context.receipt.id),
        ),
      );
      switch (waiting) {
        case "waiting":
          return Result.ok({
            type: "waiting-for-mirror",
          } satisfies EuCompletionRowOutcome);
        case "review-required":
          return Result.ok({
            type: "mirror-repair-required",
          } satisfies EuCompletionRowOutcome);
        case "applied":
          return Result.ok({
            type: "applied",
          } satisfies EuCompletionRowOutcome);
        default:
          waiting satisfies never;
          return panic("Unexpected completion mirror disposition");
      }
    }
    return Result.ok({ type: settled } satisfies EuCompletionRowOutcome);
  });

const applyCompletionCandidate = async (
  context: CompletionContext,
  candidate: IngestionResult,
): Promise<RowResult> =>
  await Result.gen(async function* () {
    const { ensure, sourceLease, receipt, ingestionDb, signal, raiseFailure } =
      context;
    yield* Result.await(ensure());
    const lease =
      sourceLease() ?? panic("Completion apply has no source lease");
    const observationOrder = yield* Result.await(
      legacyOperation(
        async () =>
          await allocateSourceObservationOrder({
            leaseToken: lease.leaseToken,
            scopedDb: ingestionDb,
            sourceId: receipt.sourceId,
          }),
      ),
    );
    const scopedDb = createCompletionWriteDb({
      ...context,
      lease,
      observationOrder,
      candidate,
    });
    const guardedLease = createGuardedLease({ lease, ensure, raiseFailure });
    yield* Result.await(
      legacyOperation(
        async () =>
          await guardedLease.beforeRemoteEffect(
            async () =>
              await processDecision({
                input: candidate,
                sourceId: receipt.sourceId,
                scopedDb,
                signal,
                s3Policy: { mode: "replay-strict", signal },
                observedAt: new Date(),
                observationOrder,
                refresh: DECISION_REFRESH.ALWAYS,
              }),
          ),
      ),
    );
    yield* Result.await(ensure());
    return await finalizeWrittenCompletion(context);
  });

type HydrateOptions = Pick<
  CandidateContext,
  "rootDb" | "signal" | "ensure" | "row"
>;
const hydrateCompletionStatements = async ({
  rootDb,
  signal,
  ensure,
  row,
}: HydrateOptions) =>
  await Result.gen(async function* () {
    const readOptions = {
      signal,
      s3Policy: { mode: "replay-strict", signal },
      readTombstones: async (locations) =>
        await rootDb.transaction(
          async (tx) => await corpusTombstoneReaderForTx(tx)(locations),
        ),
    } satisfies CorpusByteSourceSeams;
    yield* Result.await(ensure());
    const text = await legacyOperation(async () =>
      row.fulltext === null && row.textS3Key !== null
        ? await readCorpusText(row.textS3Key, readOptions)
        : row.fulltext,
    );
    if (text.isErr() && signal.aborted) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion cancelled",
          reason: "cancelled",
        }),
      );
    }
    if (text.isErr()) {
      return Result.err(
        new CompletionStageFailure({
          message: "Stored statements could not be read",
          code: "storage",
          scope: "systemic",
          cause: text.error,
        }),
      );
    }
    yield* Result.await(ensure());
    const ast = await legacyOperation(async () =>
      row.astS3Key !== null
        ? await readCorpusAst(row.astS3Key, readOptions)
        : row.documentAst,
    );
    if (ast.isErr() && signal.aborted) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion cancelled",
          reason: "cancelled",
        }),
      );
    }
    if (ast.isErr()) {
      return Result.err(
        new CompletionStageFailure({
          message: "Stored statements could not be read",
          code: "storage",
          scope: "systemic",
          cause: ast.error,
        }),
      );
    }
    yield* Result.await(ensure());
    if (row.astS3Key !== null && ast.value === null) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Stored AST reference has no verifiable statement",
        }),
      );
    }
    return Result.ok({ ...row, fulltext: text.value, documentAst: ast.value });
  });

const executeCompletionRow = async (
  context: CompletionContext,
): Promise<RowResult> =>
  await Result.gen(async function* () {
    const { rootDb, receipt, ensure, store } = context;
    yield* Result.await(ensure());
    if (receipt.writtenAt !== null) {
      return await finalizeWrittenCompletion(context);
    }
    const loaded = yield* Result.await(
      legacyOperation(
        async () =>
          await rootDb.transaction(
            async (tx) => await loadDecisionTx(tx, receipt),
          ),
      ),
    );
    const snapshot = yield* loaded;
    const { row, judges } = snapshot;
    const fingerprint = ecjCompletionFingerprint({ existing: row, judges });
    if (
      receipt.payload !== null &&
      receipt.claimedFingerprint !== fingerprint &&
      !matchesWrittenMarker(receipt, row)
    ) {
      return Result.err(
        new CompletionSupersededByCrawl({
          message: "Decision changed after completion claim",
        }),
      );
    }
    const prepared = yield* Result.await(
      prepareCompletionCandidate({ ...context, ...snapshot }, fingerprint),
    );
    if (prepared.type === "unchanged") {
      return Result.ok({ type: "unchanged" } satisfies EuCompletionRowOutcome);
    }
    const { candidate } = prepared;
    if (
      candidate.sourceDocumentId !== row.sourceDocumentId ||
      candidate.language !== row.language
    ) {
      return Result.err(
        new CompletionReviewRequired({
          message: "Completion candidate identity mismatch",
        }),
      );
    }
    if (candidate.parserVersion !== receipt.parserVersion) {
      return Result.err(
        new CompletionStageFailure({
          message: "Completion candidate parser stamp mismatch",
          code: "parse",
          scope: "systemic",
          cause: null,
        }),
      );
    }
    const existing = yield* Result.await(
      hydrateCompletionStatements({ ...context, row }),
    );
    const protectedResult = protectEcjCompletion({
      existing,
      candidate,
      judges,
    });
    if (protectedResult.type === "review-required") {
      yield* Result.await(ensure());
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({
              id: receipt.id,
              status: "review-required",
              publisherSuccess: context.state.publisherSuccess,
              detail: protectedResult.fields.join(",").slice(0, 512),
            }),
        ),
      );
      return Result.ok({
        type: "review-required",
      } satisfies EuCompletionRowOutcome);
    }
    if (receipt.mode === "dry-run") {
      yield* Result.await(ensure());
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({
              id: receipt.id,
              status: "dry-run",
              publisherSuccess: context.state.publisherSuccess,
            }),
        ),
      );
      return Result.ok({ type: "dry-run" } satisfies EuCompletionRowOutcome);
    }
    const applied = yield* Result.await(
      applyCompletionCandidate(context, protectedResult.candidate),
    );
    return Result.ok(applied);
  });

const completionResponseLimiter =
  (state: CompletionPublisherState) =>
  (response: Response): Response => {
    state.publisherSuccess ||= response.ok;
    if (response.body === null) {
      return response;
    }
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          state.bytes += chunk.byteLength;
          if (state.bytes > EU_COMPLETION_LIMITS.maxBytes) {
            const error = new CompletionPayloadTooLarge({
              message: "Completion document byte budget reached",
            });
            state.publisherFailure = { error };
            controller.error(error);
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
const chargeCompletionRequest = async (context: CompletionContext) =>
  await Result.gen(async function* () {
    const { state, store, receipt, onRequest } = context;
    if (state.requests >= EU_COMPLETION_LIMITS.maxRequests) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion publisher request budget reached",
          reason: "request-budget",
        }),
      );
    }
    const reserved = yield* Result.await(
      legacyOperation(
        async () =>
          await store.reserveRequest({
            sourceId: receipt.sourceId,
            hour: new Date(
              Math.floor(Temporal.Now.instant().epochMilliseconds / 3_600_000) *
                3_600_000,
            ),
          }),
      ),
    );
    if (!reserved) {
      return Result.err(
        new EuCompletionStop({
          message: "Completion publisher request budget reached",
          reason: "request-budget",
        }),
      );
    }
    state.requests++;
    onRequest();
    return Result.ok();
  });
const checkCompletionBeforeSend = (
  context: CompletionContext,
): Result<void, unknown> => {
  if (context.state.refusal !== null) {
    return Result.err(
      new EuCompletionStop({
        message: "Publisher refused this run",
        reason: "publisher-refused",
      }),
    );
  }
  if (context.state.publisherFailure !== null) {
    return Result.err(context.state.publisherFailure.error);
  }
  if (context.signal.aborted) {
    return Result.err(
      new EuCompletionStop({
        message: "Completion cancelled",
        reason: "cancelled",
      }),
    );
  }
  if (!context.isEnabled()) {
    return Result.err(
      new EuCompletionStop({
        message: "Completion is disabled",
        reason: "off",
      }),
    );
  }
  return context.checkBeforeSend();
};

const runControlledCompletionRow = async (
  context: CompletionContext,
): Promise<RowResult> =>
  await Result.gen(async function* () {
    const { ensure, state } = context;
    // Adapter boundaries may wrap request errors. Keep benign stops available
    // to settlement before that conversion so they never become source failures.
    const rememberStop = (result: Result<void, unknown>) => {
      if (result.isErr() && result.error instanceof EuCompletionStop) {
        state.publisherFailure = { error: result.error };
      }
      return result;
    };
    const result = yield* Result.await(
      legacyOperation(
        async () =>
          await withPublisherRequestRateLimit({
            gateId: "cellar-eu",
            requestsPerSecond: 1,
            operation: async () => await executeCompletionRow(context),
            controls: {
              retry: "durable",
              raiseFailure: context.raiseFailure,
              check: async () => rememberStop(await ensure()),
              checkBeforeSend: () =>
                rememberStop(checkCompletionBeforeSend(context)),
              chargeRequest: async () =>
                rememberStop(await chargeCompletionRequest(context)),
              onRefusal: (deadline) => {
                state.refusal = capRefusalHold(
                  deadline,
                  Temporal.Now.instant().epochMilliseconds,
                );
              },
              onFailure: (error) => {
                state.publisherFailure = {
                  error: context.signal.aborted
                    ? new EuCompletionStop({
                        message: "Completion cancelled",
                        reason: "cancelled",
                      })
                    : error,
                };
              },
              limitResponse: completionResponseLimiter(state),
            },
          }),
      ),
    );
    return result;
  });

type FailureContext = CompletionContext & { error: unknown };
const settleCompletionFailure = async ({
  receipt,
  store,
  state,
  healthyEvidence,
  error,
}: FailureContext): Promise<RowResult> =>
  await Result.gen(async function* () {
    if (error instanceof CompletionWithdrawn) {
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({ id: receipt.id, status: "withdrawn" }),
        ),
      );
      return Result.ok({ type: "withdrawn" } satisfies EuCompletionRowOutcome);
    }
    if (error instanceof CompletionPublisherGone) {
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({
              id: receipt.id,
              status: "publisher-gone",
              publisherSuccess: state.publisherSuccess,
            }),
        ),
      );
      return Result.ok({
        type: "publisher-gone",
      } satisfies EuCompletionRowOutcome);
    }
    if (error instanceof CompletionPayloadTooLarge) {
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({
              id: receipt.id,
              status: "too-large",
              publisherSuccess: state.publisherSuccess,
            }),
        ),
      );
      return Result.ok({ type: "too-large" } satisfies EuCompletionRowOutcome);
    }
    if (error instanceof CompletionSupersededByCrawl) {
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({
              id: receipt.id,
              status: "superseded-by-crawl",
              retryAt: new Date(
                Temporal.Now.instant().epochMilliseconds + COMPLETION_DEFER_MS,
              ),
            }),
        ),
      );
      return Result.ok({
        type: "superseded-by-crawl",
      } satisfies EuCompletionRowOutcome);
    }
    if (error instanceof CompletionReviewRequired) {
      yield* Result.await(
        legacyOperation(
          async () =>
            await store.finish({
              id: receipt.id,
              status: "review-required",
              publisherSuccess: state.publisherSuccess,
              detail: error.message,
            }),
        ),
      );
      return Result.ok({
        type: "review-required",
      } satisfies EuCompletionRowOutcome);
    }
    if (error instanceof EuCompletionStop) {
      yield* Result.await(
        legacyOperation(async () => await store.releaseBenign(receipt.id)),
      );
      return Result.ok({
        type: "stopped",
        reason: error.reason,
      } satisfies EuCompletionRowOutcome);
    }
    const type = yield* Result.await(
      legacyOperation(
        async () =>
          await store.recordFailure(
            receipt,
            error instanceof CompletionStageFailure
              ? { scope: error.scope, code: error.code, healthyEvidence }
              : {
                  scope: "systemic",
                  code:
                    state.publisherFailure === null
                      ? "unexpected"
                      : "publisher",
                  healthyEvidence,
                },
          ),
      ),
    );
    return Result.ok({ type } satisfies EuCompletionRowOutcome);
  });

const resetCompletionPublisherRow = (state: CompletionPublisherState) => {
  state.publisherFailure = null;
  state.bytes = 0;
  state.publisherSuccess = false;
};

/** Network results are durable raw envelopes; retries reparse stored bytes canonically. */
export const createEuCompletionRunner = (options: CompletionRunnerOptions) => {
  const state: CompletionPublisherState = {
    requests: 0,
    publisherSuccess: false,
    bytes: 0,
    refusal: null,
    publisherFailure: null,
  };
  const runRow = async (
    reserved: EuCompletionReceipt,
    rowOptions: EuCompletionRowOptions,
  ): Promise<RowResult> =>
    await Result.gen(async function* () {
      resetCompletionPublisherRow(state);
      const receipt = yield* Result.await(
        legacyOperation(
          async () => await options.store.getReceipt(reserved.id),
        ),
      );
      const ensure = async () =>
        await Result.gen(async function* () {
          if (state.refusal !== null) {
            return Result.err(
              new EuCompletionStop({
                message: "Publisher refused this run",
                reason: "publisher-refused",
              }),
            );
          }
          if (state.publisherFailure !== null) {
            return Result.err(state.publisherFailure.error);
          }
          yield* Result.await(rowOptions.check());
          yield* Result.await(options.check());
          if (options.signal.aborted) {
            return Result.err(
              new EuCompletionStop({
                message: "Completion cancelled",
                reason: "cancelled",
              }),
            );
          }
          return Result.ok();
        });
      const context = { ...options, ...rowOptions, receipt, state, ensure };
      const attempted = await runControlledCompletionRow(context);
      if (state.refusal !== null) {
        const refusalDeadline = new Date(state.refusal);
        const settled = yield* Result.await(
          legacyOperation(
            async () =>
              await options.store.finish({
                id: receipt.id,
                status: "publisher-refused",
                retryAt: refusalDeadline,
                healthyEvidence: rowOptions.healthyEvidence,
              }),
          ),
        );
        const retryAt = settled?.refusalHoldUntil ?? refusalDeadline;
        return Result.ok({
          type: "publisher-refused",
          retryAt,
        } satisfies EuCompletionRowOutcome);
      }
      if (state.publisherFailure !== null) {
        const failed = yield* Result.await(
          settleCompletionFailure({
            ...context,
            error: state.publisherFailure.error,
          }),
        );
        return Result.ok(failed);
      }
      if (attempted.isOk()) {
        return attempted;
      }
      const settled = yield* Result.await(
        settleCompletionFailure({ ...context, error: attempted.error }),
      );
      return Result.ok(settled);
    });
  return { runRow };
};
