import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import type { StoredRawReader } from "@/api/handlers/case-law/ingestion/adapter";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { LIMITS } from "@/api/lib/limits";
import { readS3ObjectBoundedIfPresent } from "@/api/lib/s3";

import { getAdapter } from "./adapters/adapter-registry";
import type { BackgroundReplayDependencies } from "./background-replay";
import type { createBackgroundReplayStore } from "./background-replay-store";
import {
  parsedReplayInputPredicate,
  REPLAY_REJECTION_POLICY,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
  type ReplayCaseLawSourceOptions,
  type ReplayRowReport,
  replaySingleRowReport,
} from "./replay";
import { saveReplayDiffSample } from "./replay-diff-sample";
import { BACKGROUND_REPLAY_LIMITS } from "./replay-enrolment";

type BackgroundReplayRunnerOptions = {
  rootDb: CaseLawRootHandle;
  ingestionDb: ScopedDb;
  getLease: () => CaseLawSourceIngestionLease | null;
  assertSlot: () => Promise<void>;
  store: ReturnType<typeof createBackgroundReplayStore>;
  log: (record: unknown) => void;
  adapterFor?: typeof getAdapter;
  readStoredRaw?: StoredRawReader;
  signal?: AbortSignal;
  recordFailure?: ReturnType<
    typeof createBackgroundReplayStore
  >["recordFailure"];
};

const readBackgroundStoredRaw = async (
  key: string,
  tickSignal?: AbortSignal,
) => {
  const signal = AbortSignal.any([
    AbortSignal.timeout(BACKGROUND_REPLAY_LIMITS.storedRawReadTimeoutMs),
    ...(tickSignal === undefined ? [] : [tickSignal]),
  ]);
  const bytes = await readS3ObjectBoundedIfPresent({
    key,
    maxBytes: LIMITS.corpusPayloadMaxDecompressedBytes,
    s3Policy: { mode: "replay-strict", signal },
    signal,
  });
  return bytes === null ? null : new Uint8Array(bytes);
};

const readReservedReplayInput = async (
  rootDb: CaseLawRootHandle,
  batch: Parameters<BackgroundReplayDependencies["replay"]>[0],
) =>
  (
    await withAggregateTransaction(
      rootDb,
      async (tx) =>
        await tx
          .select({
            id: caseLawDecisions.id,
            parserVersion: caseLawDecisions.parserVersion,
            redactedAt: caseLawDecisions.redactedAt,
            rawKey: caseLawDecisions.sourceRawS3Key,
            corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
            parsedInputCurrent: parsedReplayInputPredicate(
              batch.targetParserVersion,
            ),
          })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.id, batch.decisionId),
              eq(caseLawDecisions.sourceId, batch.source.id),
            ),
          )
          .limit(1),
    )
  ).at(0);

// The runner always forwards its own (possibly absent) signal.
type ForwardedReplaySignal = {
  signal: BackgroundReplayRunnerOptions["signal"];
};
type ReplayCompletionFenceOptions = Pick<
  BackgroundReplayRunnerOptions,
  "assertSlot" | "getLease"
> &
  ForwardedReplaySignal;
const fenceReplayCompletion = async ({
  signal,
  assertSlot,
  getLease,
}: ReplayCompletionFenceOptions) => {
  signal?.throwIfAborted();
  await assertSlot();
  signal?.throwIfAborted();
  const lease = getLease();
  if (lease === null) {
    panic("Background replay completion lost its source lease");
  }
  await lease.beforeDatabaseMark();
  signal?.throwIfAborted();
};

type GuardedReplayLeaseOptions = Pick<
  BackgroundReplayRunnerOptions,
  "assertSlot"
> &
  ForwardedReplaySignal & { claimed: CaseLawSourceIngestionLease };
const guardReplaySourceLease = ({
  signal,
  assertSlot,
  claimed,
}: GuardedReplayLeaseOptions): CaseLawSourceIngestionLease => ({
  source: claimed.source,
  leaseToken: claimed.leaseToken,
  purpose: claimed.purpose,
  release: claimed.release,
  beforeDatabaseMark: async () => {
    signal?.throwIfAborted();
    await assertSlot();
    await claimed.beforeDatabaseMark();
    signal?.throwIfAborted();
  },
  beforeRemoteEffect: async (effect) => {
    signal?.throwIfAborted();
    await assertSlot();
    return await claimed.beforeRemoteEffect(async () => {
      signal?.throwIfAborted();
      return await effect();
    });
  },
});

/** Every successful real parse reaches the canonical provenance writer in apply mode. */
export const createBackgroundReplayRunner = ({
  rootDb,
  ingestionDb,
  getLease,
  assertSlot,
  store,
  log,
  adapterFor = getAdapter,
  readStoredRaw,
  signal,
  recordFailure = store.recordFailure,
}: BackgroundReplayRunnerOptions) => {
  const readRaw: StoredRawReader =
    readStoredRaw ??
    (async (key) => await readBackgroundStoredRaw(key, signal));
  const sampleSignal =
    signal ?? AbortSignal.timeout(BACKGROUND_REPLAY_LIMITS.hardDurationMs);
  const reports = new Map<string, ReplayRowReport>();
  const reportKey = (
    batch: Parameters<BackgroundReplayDependencies["replay"]>[0],
  ) => `${batch.id}:${batch.claimReadmission}`;
  const runner = {
    replay: async (batch, { apply }) => {
      signal?.throwIfAborted();
      reports.delete(reportKey(batch));
      const expectedRawS3Key = batch.sourceRawS3Key;
      if (expectedRawS3Key === null) {
        const report: ReplayRowReport = {
          id: batch.decisionId,
          caseNumber: "",
          language: "",
          outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
          detail: "The legacy reservation has no captured raw input",
        };
        reports.set(reportKey(batch), report);
        return replaySingleRowReport(report);
      }
      const row = await readReservedReplayInput(rootDb, batch);
      const recovered =
        row?.redactedAt === null &&
        row.rawKey === expectedRawS3Key &&
        row.parsedInputCurrent &&
        row.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED;
      if (!row || row.redactedAt !== null || row.rawKey === null || recovered) {
        const report: ReplayRowReport = {
          id: batch.decisionId,
          caseNumber: "",
          language: "",
          outcome: recovered
            ? REPLAY_ROW_OUTCOME.APPLIED
            : REPLAY_ROW_OUTCOME.UNCHANGED,
          ...(recovered ? { replayedSourceRawS3Key: expectedRawS3Key } : {}),
        };
        if (!recovered && row?.redactedAt === null && row.rawKey === null) {
          report.outcome = REPLAY_ROW_OUTCOME.MISSING_PAYLOAD;
        }
        reports.set(reportKey(batch), report);
        return replaySingleRowReport(report);
      }
      if (
        row.rawKey !== expectedRawS3Key ||
        (row.parserVersion !== null &&
          row.parserVersion > batch.targetParserVersion)
      ) {
        const report: ReplayRowReport = {
          id: batch.decisionId,
          caseNumber: "",
          language: "",
          outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
          detail: "The reserved raw input or parser was superseded",
        };
        reports.set(reportKey(batch), report);
        return replaySingleRowReport(report);
      }
      const adapter = adapterFor(batch.source.adapterKey);
      if (!adapter) {
        return panic("Enrolled replay adapter is missing");
      }
      const options = {
        adapter,
        scopedDb: ingestionDb,
        sourceId: batch.source.id,
        ...(signal === undefined
          ? {}
          : { signal, s3Policy: { mode: "replay-strict" as const, signal } }),
        scope: { type: "decision", decisionId: batch.decisionId } as const,
        bound: { type: "at-most", limit: 1 } as const,
        pageSize: 1,
        readStoredRaw: readRaw,
        expectedRawS3Key,
        rejectionPolicy: REPLAY_REJECTION_POLICY.REPORT,
        onRow: ({ report: rowReport }) => {
          reports.set(reportKey(batch), rowReport);
        },
      } satisfies Omit<ReplayCaseLawSourceOptions, "sourceLease">;
      // Every apply is preceded by a preview; rejection never reaches the writer.
      const preview = await replayCaseLawSource({
        ...options,
        onDerivedOutput: async (after) => {
          if (batch.source.mode !== "dry-run") {
            return;
          }
          await saveReplayDiffSample({
            batch,
            after,
            scopedDb: ingestionDb,
            store,
            signal: sampleSignal,
          });
        },
        sourceLease: null,
      });
      if (preview.type !== "ran") {
        return panic("Reserved replay decision could not be inspected");
      }
      if (preview.report.haltReason !== null) {
        return preview.report;
      }
      if (
        !apply ||
        (preview.report.outcomes[REPLAY_ROW_OUTCOME.WOULD_APPLY] !== 1 &&
          preview.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED] !== 1)
      ) {
        log({
          event: "case_law.replay.preview",
          sourceId: batch.source.id,
          decisionId: batch.decisionId,
          targetParserVersion: batch.targetParserVersion,
          outcomes: preview.report.outcomes,
          rejections: preview.report.rejections,
        });
        return preview.report;
      }
      if (getLease() === null) {
        return panic("Background replay apply has no ingestion lease");
      }
      const claimed = getLease();
      if (claimed === null) {
        return panic("Replay apply lost its source lease");
      }
      // A failed dedicated lock session must stop work before any new remote or DB effect.
      const guardedLease = guardReplaySourceLease({
        signal,
        assertSlot,
        claimed,
      });
      const replayed = await replayCaseLawSource({
        ...options,
        sourceLease: guardedLease,
      });
      if (replayed.type !== "ran") {
        return panic("Reserved replay decision could not be applied");
      }
      return replayed.report;
    },
    completeBatch: async (batch, completion) => {
      const rowReport = reports.get(reportKey(batch));
      if (!rowReport) {
        panic("Replay completed without a row outcome");
      }
      await fenceReplayCompletion({ signal, assertSlot, getLease });
      const disposition = await store.completeBatch(batch, {
        ...completion,
        report: rowReport,
      });
      reports.delete(reportKey(batch));
      return disposition;
    },
    recordFailure: async (batch, failure) => {
      log({
        event: "case_law.replay.row_failure",
        sourceId: batch.source.id,
        decisionId: batch.decisionId,
        haltReason: failure.code,
        failureScope: failure.scope,
        failureCode: failure.code,
        messageClass: failure.messageClass,
      });
      const replayedSourceRawS3Key = reports.get(
        reportKey(batch),
      )?.replayedSourceRawS3Key;
      const disposition = await recordFailure(batch, {
        ...failure,
        ...(replayedSourceRawS3Key === undefined
          ? {}
          : { replayedSourceRawS3Key }),
      });
      reports.delete(reportKey(batch));
      return disposition;
    },
  } satisfies Pick<
    BackgroundReplayDependencies,
    "replay" | "completeBatch" | "recordFailure"
  >;
  return runner;
};
