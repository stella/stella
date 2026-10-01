import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
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
  type ReplayRowReport,
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
};

const readBackgroundStoredRaw: StoredRawReader = async (key) => {
  const bytes = await readS3ObjectBoundedIfPresent({
    key,
    maxBytes: LIMITS.corpusPayloadMaxDecompressedBytes,
    signal: AbortSignal.timeout(
      BACKGROUND_REPLAY_LIMITS.storedRawReadTimeoutMs,
    ),
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
  readStoredRaw = readBackgroundStoredRaw,
}: BackgroundReplayRunnerOptions) => {
  const reports = new Map<string, ReplayRowReport>();
  const runner = {
    replay: async (batch, { apply }) => {
      const adapter = adapterFor(batch.source.adapterKey);
      if (!adapter) {
        return panic("Enrolled replay adapter is missing");
      }
      const row = (
        await rootDb.transaction(
          async (tx) =>
            await tx
              .select({
                id: caseLawDecisions.id,
                parserVersion: caseLawDecisions.parserVersion,
                redactedAt: caseLawDecisions.redactedAt,
                rawKey: caseLawDecisions.sourceRawS3Key,
              })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, batch.decisionId))
              .limit(1),
        )
      ).at(0);
      const options = {
        adapter,
        scopedDb: ingestionDb,
        sourceId: batch.source.id,
        scope: { type: "decision", decisionId: batch.decisionId } as const,
        bound: { type: "at-most", limit: 1 } as const,
        pageSize: 1,
        readStoredRaw,
        rejectionPolicy: REPLAY_REJECTION_POLICY.REPORT,
        onRow: ({ report: rowReport }: { report: ReplayRowReport }) => {
          reports.set(batch.id, rowReport);
        },
      };
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
        !row ||
        row.redactedAt !== null ||
        row.rawKey === null ||
        (row.parserVersion !== null &&
          row.parserVersion >= batch.targetParserVersion)
      ) {
        reports.set(batch.id, {
          id: batch.decisionId,
          caseNumber: "",
          language: "",
          outcome: REPLAY_ROW_OUTCOME.UNCHANGED,
        });
        return {
          ...preview.report,
          visited: 1,
          outcomes: {
            ...preview.report.outcomes,
            [REPLAY_ROW_OUTCOME.WOULD_APPLY]: 0,
            [REPLAY_ROW_OUTCOME.REJECTED]: 0,
            [REPLAY_ROW_OUTCOME.MISSING_PAYLOAD]: 0,
            [REPLAY_ROW_OUTCOME.UNCHANGED]: 1,
          },
        };
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
        release: claimed.release,
        beforeDatabaseMark: async () => {
          await assertSlot();
          await claimed.beforeDatabaseMark();
        },
        beforeRemoteEffect: async (effect) => {
          await assertSlot();
          return await claimed.beforeRemoteEffect(effect);
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
      await store.completeBatch(batch, {
        ...completion,
        report: rowReport,
      });
      reports.delete(batch.id);
    },
  } satisfies Pick<BackgroundReplayDependencies, "replay" | "completeBatch">;
  return runner;
};
