import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  CASE_LAW_CORPUS_MIRROR_STATUS,
} from "@/api/db/schema";
import type { StoredRawReader } from "@/api/handlers/case-law/ingestion/adapter";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { LIMITS } from "@/api/lib/limits";
import { readS3ObjectBoundedIfPresent } from "@/api/lib/s3";

import { getAdapter } from "./adapters/adapter-registry";
import type { BackgroundReplayDependencies } from "./background-replay";
import type { createBackgroundReplayStore } from "./background-replay-store";
import {
  REPLAY_REJECTION_POLICY,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
  replaySingleRowReport,
  type ReplayRowReport,
  type ReplayCaseLawSourceOptions,
} from "./replay";
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

/** Preview and apply share the canonical replay path; only would-apply enters the writer. */
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
  const fence = async () => {
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
  const reports = new Map<string, ReplayRowReport>();
  const runner = {
    replay: async (batch, { apply }) => {
      signal?.throwIfAborted();
      reports.delete(batch.id);
      const row = (
        await rootDb.transaction(
          async (tx) =>
            await tx
              .select({
                id: caseLawDecisions.id,
                parserVersion: caseLawDecisions.parserVersion,
                redactedAt: caseLawDecisions.redactedAt,
                rawKey: caseLawDecisions.sourceRawS3Key,
                corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
              })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, batch.decisionId))
              .limit(1),
        )
      ).at(0);
      if (
        !row ||
        row.redactedAt !== null ||
        row.rawKey === null ||
        (row.parserVersion !== null &&
          row.parserVersion >= batch.targetParserVersion &&
          row.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED)
      ) {
        const recovered =
          row?.redactedAt === null &&
          row.parserVersion !== null &&
          row.parserVersion >= batch.targetParserVersion &&
          row.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED;
        const report: ReplayRowReport = {
          id: batch.decisionId,
          caseNumber: "",
          language: "",
          outcome: recovered
            ? REPLAY_ROW_OUTCOME.APPLIED
            : REPLAY_ROW_OUTCOME.UNCHANGED,
        };
        if (!recovered && row?.redactedAt === null && row.rawKey === null) {
          report.outcome = REPLAY_ROW_OUTCOME.MISSING_PAYLOAD;
        }
        reports.set(batch.id, report);
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
        readStoredRaw: async (key) => {
          signal?.throwIfAborted();
          const raw = await readRaw(key);
          signal?.throwIfAborted();
          return raw;
        },
        rejectionPolicy: REPLAY_REJECTION_POLICY.REPORT,
        onRow: ({ report: rowReport }) => {
          reports.set(batch.id, rowReport);
        },
      } satisfies Omit<ReplayCaseLawSourceOptions, "sourceLease">;
      // Every apply is preceded by a preview; rejection never reaches the writer.
      const preview = await replayCaseLawSource({
        ...options,
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
        preview.report.outcomes[REPLAY_ROW_OUTCOME.WOULD_APPLY] !== 1
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
      const guardedLease: CaseLawSourceIngestionLease = {
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
      };
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
      const rowReport = reports.get(batch.id);
      if (!rowReport) {
        panic("Replay completed without a row outcome");
      }
      await fence();
      const disposition = await store.completeBatch(batch, {
        ...completion,
        report: rowReport,
      });
      reports.delete(batch.id);
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
      const disposition = await recordFailure(batch, failure);
      reports.delete(batch.id);
      return disposition;
    },
  } satisfies Pick<
    BackgroundReplayDependencies,
    "replay" | "completeBatch" | "recordFailure"
  >;
  return runner;
};
