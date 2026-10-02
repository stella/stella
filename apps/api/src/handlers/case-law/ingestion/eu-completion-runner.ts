import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq } from "drizzle-orm";

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
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  readCorpusText,
  readCorpusAst,
  type CorpusByteSourceSeams,
} from "@/api/lib/legal-search/corpus-storage";
import { corpusTombstoneReaderForTx } from "@/api/lib/legal-search/corpus-tombstones";
import { readS3ObjectBoundedIfPresent } from "@/api/lib/s3";

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
} from "./eu-completion-protection";
import type {
  createEuCompletionStore,
  EuCompletionReceipt,
  EuCompletionFailure,
} from "./eu-completion-store";

class CompletionReviewRequired extends TaggedError("CompletionReviewRequired")<{
  message: string;
}> {}
class CompletionStageFailure extends TaggedError("CompletionStageFailure")<{
  message: string;
  code: EuCompletionFailure["code"];
  scope: EuCompletionFailure["scope"];
  cause: unknown;
}> {}

const MAX_COMPLETION_JUDGES = 1000;

const digest = (payload: string) =>
  new Bun.CryptoHasher("sha256").update(payload).digest("hex");
const loadDecisionTx = async (
  tx: Transaction,
  receipt: EuCompletionReceipt,
) => {
  const row = (
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
      .limit(1)
  ).at(0);
  if (row === undefined || row.redactedAt !== null) {
    throw new CompletionReviewRequired({
      message: "Decision missing or redacted",
    });
  }
  const judges = await tx
    .select({
      role: caseLawDecisionJudges.role,
      nameAsPrinted: caseLawDecisionJudges.nameAsPrinted,
    })
    .from(caseLawDecisionJudges)
    .where(eq(caseLawDecisionJudges.decisionId, row.id))
    .orderBy(
      asc(caseLawDecisionJudges.role),
      asc(caseLawDecisionJudges.position),
    )
    .limit(MAX_COMPLETION_JUDGES + 1);
  if (judges.length > MAX_COMPLETION_JUDGES) {
    throw new CompletionReviewRequired({
      message: "Stored bench exceeds the completion comparison budget",
    });
  }
  return { row, judges };
};

const matchesWrittenMarker = (
  receipt: EuCompletionReceipt,
  row: typeof caseLawDecisions.$inferSelect,
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
  check: () => Promise<void>;
  onRequest: () => void;
};

type CompletionPublisherState = {
  requests: number;
  bytes: number;
  refusal: number | null;
  publisherFailure: { error: unknown } | null;
};

type CompletionContext = CompletionRunnerOptions &
  EuCompletionRowOptions & {
    receipt: EuCompletionReceipt;
    ensure: () => Promise<void>;
    state: CompletionPublisherState;
  };

type DecisionSnapshot = Awaited<ReturnType<typeof loadDecisionTx>>;
type CandidateContext = CompletionContext & DecisionSnapshot;
type CompletionCandidate =
  | { type: "candidate"; candidate: IngestionResult; target: "formex" | "full" }
  | { type: "unchanged" };

const readStoredRaw = async ({
  row,
  signal,
  ensure,
}: CandidateContext): Promise<Uint8Array | null> => {
  const read = await Result.tryPromise({
    try: async () => {
      await ensure();
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
    },
    catch: (error) => error,
  });
  if (read.isErr() && read.error instanceof EuCompletionStop) {
    throw read.error;
  }
  if (read.isErr()) {
    throw new CompletionStageFailure({
      message: "Stored raw read failed",
      code: "storage",
      scope: "systemic",
      cause: read.error,
    });
  }
  return read.value;
};

type FullCompletionCandidateOptions = Pick<
  CandidateContext,
  "row" | "signal" | "ensure"
>;
const fetchFullCompletionCandidate = async (
  { row, signal, ensure }: FullCompletionCandidateOptions,
  raw: Uint8Array | null,
): Promise<IngestionResult> => {
  if (
    raw !== null &&
    Object.keys(decodeSourceRawEnvelopeObjects(new TextDecoder().decode(raw)))
      .length > 0
  ) {
    throw new CompletionReviewRequired({
      message: "Stored binary source parts require review",
    });
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
    throw new CompletionReviewRequired({
      message: "Full completion has no exact publisher identity",
    });
  }
  const fetched = await fetchDecisionsByCelex({
    celexNumbers: [celex],
    languages: [language],
    signal,
  });
  await ensure();
  const matches = fetched.filter(
    (value) =>
      value.sourceDocumentId === row.sourceDocumentId &&
      value.language === row.language,
  );
  if (matches.length !== 1) {
    throw new CompletionReviewRequired({
      message: "Publisher did not return exactly the selected identity",
    });
  }
  return matches.at(0) ?? panic("Selected publisher candidate disappeared");
};

const fetchCompletionCandidate = async (
  { row, signal, ensure, state }: CandidateContext,
  raw: Uint8Array | null,
): Promise<CompletionCandidate> => {
  let candidate: IngestionResult;
  let target: "formex" | "full";
  const parts =
    raw === null
      ? null
      : decodeSourceRawEnvelope(new TextDecoder().decode(raw));
  if (
    raw !== null &&
    parts?.["notice"] !== undefined &&
    parts["listing"] !== undefined &&
    parts["document"] !== undefined
  ) {
    target = "formex";
    const refreshed = await refreshEcjStoredFormex({
      stored: { ...storedInput(row), raw },
      signal,
    });
    await ensure();
    switch (refreshed.type) {
      case "refreshed":
        candidate = refreshed.decision;
        break;
      case "unchanged-already-current":
        return { type: "unchanged" };
      case "rate-limited":
        state.refusal = refreshed.cooldownUntilEpochMs;
        throw new EuCompletionStop({
          message: "Publisher refused completion",
          reason: "publisher-refused",
        });
      case "retryable-exhausted":
        throw new CompletionStageFailure({
          message: "Formex fetch did not complete",
          code: "publisher",
          scope: "systemic",
          cause: null,
        });
      case "notice-missing":
      case "formex-not-located":
      case "formex-gone":
      case "write-rejected":
        throw new CompletionReviewRequired({
          message: `Formex completion requires review: ${refreshed.type}`,
        });
      default:
        refreshed satisfies never;
        return panic("Unknown Formex completion outcome");
    }
  } else {
    target = "full";
    candidate = await fetchFullCompletionCandidate(
      { row, signal, ensure },
      raw,
    );
  }
  if (target === "formex" && raw !== null) {
    const preserved = protectEcjFormexParts({
      storedRaw: raw,
      storedRawContentType: row.sourceRawContentType,
      candidate,
    });
    if (preserved.type === "review-required") {
      throw new CompletionReviewRequired({
        message: "Formex changed existing source parts",
      });
    }
  }

  return { type: "candidate", candidate, target };
};

const recoverCompletionCandidate = ({
  row,
  receipt,
}: CandidateContext): IngestionResult => {
  const payload =
    receipt.payload ?? panic("Completion recovery has no payload");
  if (digest(payload) !== receipt.payloadHash) {
    throw new CompletionReviewRequired({
      message: "Fetched recovery payload hash mismatch",
    });
  }
  const parsed = euEcjAdapter.reparseStoredRaw({
    ...storedInput(row),
    raw: new TextEncoder().encode(payload),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
  if (parsed.type !== "parsed") {
    throw new CompletionReviewRequired({
      message: "Fetched envelope cannot be reparsed",
    });
  }
  if (receipt.target === null) {
    panic("Fetched receipt has no target");
  }
  return parsed.result;
};

const prepareCompletionCandidate = async (
  context: CandidateContext,
  fingerprint: string,
): Promise<CompletionCandidate> => {
  const { row, receipt, ensure, store } = context;
  if (receipt.payload !== null) {
    return {
      type: "candidate",
      candidate: recoverCompletionCandidate(context),
      target: receipt.target ?? panic("Fetched receipt has no target"),
    };
  }
  if (
    row.sourceHash !== receipt.claimedSourceHash ||
    row.sourceObservationOrder !== receipt.claimedObservationOrder
  ) {
    throw new CompletionReviewRequired({
      message: "Decision source changed after reservation",
    });
  }
  const fetched = await fetchCompletionCandidate(
    context,
    await readStoredRaw(context),
  );
  if (fetched.type === "unchanged") {
    await ensure();
    await store.finish({ id: receipt.id, status: "unchanged" });
    return fetched;
  }
  const { candidate, target } = fetched;
  const payload = candidate.sourceRaw;
  if (
    payload === undefined ||
    candidate.sourceRawBytes !== undefined ||
    candidate.sourceRawObjects !== undefined
  ) {
    throw new CompletionReviewRequired({
      message: "Completion requires a recoverable textual envelope",
    });
  }
  const parts = decodeSourceRawEnvelope(payload);
  if (
    parts === null ||
    (target === "full"
      ? ["listing", "notice", "document", "formex"]
      : ["formex"]
    ).some((part) => parts[part] === undefined)
  ) {
    throw new CompletionReviewRequired({
      message: "Publisher did not supply the requested completion surfaces",
    });
  }
  await ensure();
  const saved = await store.markFetched({
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
  });
  if (saved === null) {
    throw new CompletionReviewRequired({
      message: "Completion receipt moved before fetched persistence",
    });
  }
  return fetched;
};

type CompletionWriteContext = CompletionContext & {
  candidate: IngestionResult;
  lease: CaseLawSourceIngestionLease;
  observationOrder: Awaited<ReturnType<typeof allocateSourceObservationOrder>>;
};

const createCompletionWriteDb = ({
  rootDb,
  signal,
  store,
  receipt,
  lease,
  observationOrder,
  candidate,
}: CompletionWriteContext) =>
  createIngestionDb(
    markRlsDatabase({ transaction: rootDb.transaction.bind(rootDb) }),
    {
      laneWaitMs: 0,
      maintenance: {
        before: async (tx) => {
          signal.throwIfAborted();
          if (!(await store.assertApprovalTx(tx, receipt))) {
            throw new EuCompletionStop({
              message: "Completion approval or controls revoked",
              reason: "off",
            });
          }
          const source = (
            await tx
              .select({
                token: caseLawSources.ingestionLeaseToken,
                expiry: caseLawSources.ingestionLeaseExpiresAt,
              })
              .from(caseLawSources)
              .where(eq(caseLawSources.id, receipt.sourceId))
              .for("update")
              .limit(1)
          ).at(0);
          if (
            source?.token !== lease.leaseToken ||
            source.expiry === null ||
            source.expiry.getTime() <= Temporal.Now.instant().epochMilliseconds
          ) {
            throw new EuCompletionStop({
              message: "Completion source lease lost",
              reason: "cancelled",
            });
          }
          const currentReceipt = await store.assertFetchedTx(tx, receipt.id);
          if (currentReceipt === null) {
            throw new CompletionReviewRequired({
              message: "Completion receipt no longer fetched",
            });
          }
          const current = await loadDecisionTx(tx, receipt);
          const alreadyWritten = matchesWrittenMarker(
            currentReceipt,
            current.row,
          );
          if (
            !alreadyWritten &&
            (current.row.sourceObservationOrder !==
              currentReceipt.claimedObservationOrder ||
              ecjCompletionFingerprint({
                existing: current.row,
                judges: current.judges,
              }) !== currentReceipt.claimedFingerprint)
          ) {
            throw new CompletionReviewRequired({
              message: "Completion claimed statements changed before apply",
            });
          }
        },
        after: async (tx) => {
          signal.throwIfAborted();
          const current = await loadDecisionTx(tx, receipt);
          if (
            current.row.sourceObservationOrder === observationOrder &&
            current.row.sourceHash === candidate.rawHash
          ) {
            await store.markWrittenTx(tx, {
              id: receipt.id,
              decisionId: receipt.decisionId,
            });
          }
        },
      },
    },
  );

type GuardedLeaseOptions = {
  lease: CaseLawSourceIngestionLease;
  ensure: () => Promise<void>;
};
const createGuardedLease = ({
  lease,
  ensure,
}: GuardedLeaseOptions): CaseLawSourceIngestionLease => ({
  source: lease.source,
  leaseToken: lease.leaseToken,
  release: lease.release,
  beforeDatabaseMark: async () => {
    await ensure();
    await lease.beforeDatabaseMark();
    await ensure();
  },
  beforeRemoteEffect: async (effect) => {
    await ensure();
    return await lease.beforeRemoteEffect(async () => {
      await ensure();
      return await effect();
    });
  },
});

const applyCompletionCandidate = async (
  context: CompletionContext,
  candidate: IngestionResult,
): Promise<EuCompletionRowOutcome> => {
  const {
    ensure,
    sourceLease,
    receipt,
    ingestionDb,
    signal,
    store,
    healthyEvidence,
  } = context;
  await ensure();
  const lease = sourceLease() ?? panic("Completion apply has no source lease");
  const observationOrder = await allocateSourceObservationOrder({
    leaseToken: lease.leaseToken,
    scopedDb: ingestionDb,
    sourceId: receipt.sourceId,
  });
  const scopedDb = createCompletionWriteDb({
    ...context,
    lease,
    observationOrder,
    candidate,
  });
  const guardedLease = createGuardedLease({ lease, ensure });
  await processDecision({
    input: candidate,
    sourceId: receipt.sourceId,
    scopedDb,
    sourceLease: guardedLease,
    signal,
    s3Policy: { mode: "replay-strict", signal },
    observedAt: new Date(),
    observationOrder,
    refresh: DECISION_REFRESH.ALWAYS,
  });
  await ensure();
  const settled = await store.finalize(receipt.id);
  if (settled === "retryable") {
    return {
      type: await store.recordFailure(receipt, {
        scope: "systemic",
        code: "write",
        healthyEvidence,
      }),
    };
  }
  return { type: settled };
};

type HydrateCompletionStatementsOptions = Pick<
  CandidateContext,
  "rootDb" | "signal" | "ensure" | "row"
>;
const hydrateCompletionStatements = async ({
  rootDb,
  signal,
  ensure,
  row,
}: HydrateCompletionStatementsOptions) => {
  const readOptions = {
    signal,
    s3Policy: { mode: "replay-strict", signal },
    readTombstones: async (locations) =>
      await rootDb.transaction(
        async (tx) => await corpusTombstoneReaderForTx(tx)(locations),
      ),
  } satisfies CorpusByteSourceSeams;
  const hydrated = await Result.tryPromise({
    try: async () => {
      await ensure();
      const fulltext =
        row.fulltext === null && row.textS3Key !== null
          ? await readCorpusText(row.textS3Key, readOptions)
          : row.fulltext;
      await ensure();
      const documentAst =
        row.astS3Key !== null
          ? await readCorpusAst(row.astS3Key, readOptions)
          : row.documentAst;
      await ensure();
      return { ...row, fulltext, documentAst };
    },
    catch: (error) => error,
  });
  if (hydrated.isErr() && hydrated.error instanceof EuCompletionStop) {
    throw hydrated.error;
  }
  if (hydrated.isErr()) {
    throw new CompletionStageFailure({
      message: "Stored statements could not be read",
      code: "storage",
      scope: "systemic",
      cause: hydrated.error,
    });
  }
  if (row.astS3Key !== null && hydrated.value.documentAst === null) {
    throw new CompletionReviewRequired({
      message: "Stored AST reference has no verifiable statement",
    });
  }
  return hydrated.value;
};

const executeCompletionRow = async (
  context: CompletionContext,
): Promise<EuCompletionRowOutcome> => {
  const { rootDb, receipt, ensure, store } = context;
  await ensure();
  const snapshot = await rootDb.transaction(
    async (tx) => await loadDecisionTx(tx, receipt),
  );
  const { row, judges } = snapshot;
  const fingerprint = ecjCompletionFingerprint({ existing: row, judges });
  const ownWrite = matchesWrittenMarker(receipt, row);
  if (
    receipt.payload !== null &&
    receipt.claimedFingerprint !== fingerprint &&
    !ownWrite
  ) {
    throw new CompletionReviewRequired({
      message: "Decision changed after completion claim",
    });
  }
  const prepared = await prepareCompletionCandidate(
    { ...context, ...snapshot },
    fingerprint,
  );
  if (prepared.type === "unchanged") {
    return { type: "unchanged" };
  }
  const { candidate } = prepared;
  if (
    candidate.sourceDocumentId !== row.sourceDocumentId ||
    candidate.language !== row.language
  ) {
    throw new CompletionReviewRequired({
      message: "Completion candidate identity mismatch",
    });
  }
  if (candidate.parserVersion !== receipt.parserVersion) {
    throw new CompletionStageFailure({
      message: "Completion candidate parser stamp mismatch",
      code: "parse",
      scope: "systemic",
      cause: null,
    });
  }
  const existing = await hydrateCompletionStatements({ ...context, row });
  const protectedResult = protectEcjCompletion({
    existing,
    candidate,
    judges,
  });
  if (protectedResult.type === "review-required") {
    await ensure();
    await store.finish({
      id: receipt.id,
      status: "review-required",
      detail: protectedResult.fields.join(",").slice(0, 512),
    });
    return { type: "review-required" };
  }
  if (receipt.mode === "dry-run") {
    await ensure();
    await store.finish({ id: receipt.id, status: "dry-run" });
    return { type: "dry-run" };
  }
  return await applyCompletionCandidate(context, protectedResult.candidate);
};

const completionResponseLimiter =
  (state: CompletionPublisherState) =>
  (response: Response): Response => {
    if (response.body === null) {
      return response;
    }
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          state.bytes += chunk.byteLength;
          if (state.bytes > EU_COMPLETION_LIMITS.maxBytes) {
            const error = new EuCompletionStop({
              message: "Completion byte budget reached",
              reason: "byte-budget",
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

const runControlledCompletionRow = async (context: CompletionContext) => {
  const { ensure, receipt, store, state, onRequest } = context;
  return await Result.tryPromise({
    try: async () =>
      await withPublisherRequestRateLimit({
        gateId: "cellar-eu",
        requestsPerSecond: 1,
        operation: async () => await executeCompletionRow(context),
        controls: {
          retry: "durable",
          check: ensure,
          chargeRequest: async () => {
            if (
              state.requests >= EU_COMPLETION_LIMITS.maxRequests ||
              !(await store.reserveRequest({
                sourceId: receipt.sourceId,
                hour: new Date(
                  Math.floor(
                    Temporal.Now.instant().epochMilliseconds / 3_600_000,
                  ) * 3_600_000,
                ),
              }))
            ) {
              throw new EuCompletionStop({
                message: "Completion publisher request budget reached",
                reason: "request-budget",
              });
            }
            state.requests++;
            onRequest();
          },
          onRefusal: (deadline) => {
            state.refusal = deadline;
          },
          onFailure: (error) => {
            state.publisherFailure = { error };
          },
          limitResponse: completionResponseLimiter(state),
        },
      }),
    catch: (error) => error,
  });
};

type CompletionFailureContext = CompletionContext & { error: unknown };
const settleCompletionFailure = async ({
  receipt,
  store,
  state,
  healthyEvidence,
  error,
}: CompletionFailureContext): Promise<EuCompletionRowOutcome> => {
  if (error instanceof CompletionReviewRequired) {
    await store.finish({
      id: receipt.id,
      status: "review-required",
      detail: error.message,
    });
    return { type: "review-required" };
  }
  if (error instanceof EuCompletionStop) {
    await store.recordFailure(receipt, {
      scope: "systemic",
      code: "cancelled",
      healthyEvidence,
    });
    return { type: "stopped", reason: error.reason };
  }
  return {
    type: await store.recordFailure(
      receipt,
      error instanceof CompletionStageFailure
        ? { scope: error.scope, code: error.code, healthyEvidence }
        : {
            scope: "systemic",
            code: state.publisherFailure === null ? "unexpected" : "publisher",
            healthyEvidence,
          },
    ),
  };
};

/** Network results are durable raw envelopes; retries reparse stored bytes canonically. */
export const createEuCompletionRunner = (options: CompletionRunnerOptions) => {
  const state: CompletionPublisherState = {
    requests: 0,
    bytes: 0,
    refusal: null,
    publisherFailure: null,
  };
  const runRow = async (
    reserved: EuCompletionReceipt,
    rowOptions: EuCompletionRowOptions,
  ): Promise<EuCompletionRowOutcome> => {
    state.publisherFailure = null;
    const receipt = await options.store.getReceipt(reserved.id);
    const ensure = async () => {
      if (state.refusal !== null) {
        throw new EuCompletionStop({
          message: "Publisher refused this run",
          reason: "publisher-refused",
        });
      }
      if (state.publisherFailure !== null) {
        throw state.publisherFailure.error;
      }
      await rowOptions.check();
      await options.check();
      options.signal.throwIfAborted();
    };
    const context = { ...options, ...rowOptions, receipt, state, ensure };
    const attempted = await runControlledCompletionRow(context);
    if (state.refusal !== null) {
      const retryAt = new Date(
        Math.max(
          state.refusal,
          Temporal.Now.instant().epochMilliseconds + 1000,
        ),
      );
      await options.store.finish({
        id: receipt.id,
        status: "publisher-refused",
        retryAt,
      });
      return { type: "publisher-refused", retryAt };
    }
    if (attempted.isOk()) {
      return attempted.value;
    }
    return await settleCompletionFailure({
      ...context,
      error: attempted.error,
    });
  };
  return { runRow };
};

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
