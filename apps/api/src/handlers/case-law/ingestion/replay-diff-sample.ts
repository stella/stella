// parser-output-unchanged: saves reviewed-wave evidence without changing parsed output.
import { panic } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-storage";
import {
  readCorpusAst,
  readCorpusSections,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import { corpusTombstoneReaderForTx } from "@/api/lib/legal-search/corpus-tombstones";
import {
  openRawSourceWriteWindow,
  RAW_SOURCE_FAMILY,
  writeCaseLawRawPayload,
} from "@/api/lib/legal-search/raw-source-storage";

import type { BackgroundReplayBatch } from "./background-replay";
import type { createBackgroundReplayStore } from "./background-replay-store";

type SaveReplayDiffSampleOptions = {
  batch: BackgroundReplayBatch;
  after: CorpusPayload;
  scopedDb: ScopedDb;
  store: Pick<
    ReturnType<typeof createBackgroundReplayStore>,
    "needsDryRunDiffSample" | "recordDryRunDiffSample"
  >;
  signal: AbortSignal;
};

/** Evidence shares the decision archive and its erasure sweep; receipts carry only references. */
export const saveReplayDiffSample = async ({
  batch,
  after,
  scopedDb,
  store,
  signal,
}: SaveReplayDiffSampleOptions) => {
  if (batch.source.mode !== "dry-run") {
    panic("Replay diff samples require a dry-run wave");
  }
  if (!(await store.needsDryRunDiffSample(batch.source, batch.decisionId))) {
    return;
  }
  const window = openRawSourceWriteWindow();
  const stored = await scopedDb(async (tx) =>
    (
      await tx
        .select({
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          parserVersion: caseLawDecisions.parserVersion,
          text: caseLawDecisions.fulltext,
          sections: caseLawDecisions.sections,
          ast: caseLawDecisions.documentAst,
          textS3Key: caseLawDecisions.textS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          astS3Key: caseLawDecisions.astS3Key,
        })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.id, batch.decisionId),
            eq(caseLawDecisions.sourceId, batch.source.id),
            isNull(caseLawDecisions.redactedAt),
          ),
        )
        .limit(1)
    ).at(0),
  );
  if (stored === undefined || stored.sourceRawS3Key !== batch.sourceRawS3Key) {
    panic("Replay diff input changed while sampling");
  }
  const seams = {
    signal,
    readTombstones: async (
      locations: Parameters<ReturnType<typeof corpusTombstoneReaderForTx>>[0],
    ) =>
      await scopedDb(
        async (tx) => await corpusTombstoneReaderForTx(tx)(locations),
      ),
  };
  const [text, sections, ast] = await Promise.all([
    stored.textS3Key === null
      ? stored.text
      : readCorpusText(stored.textS3Key, seams),
    stored.normalizedS3Key === null
      ? stored.sections
      : readCorpusSections(stored.normalizedS3Key, seams),
    stored.astS3Key === null
      ? stored.ast
      : readCorpusAst(stored.astS3Key, seams),
  ]);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      decisionId: batch.decisionId,
      sourceRawS3Key: stored.sourceRawS3Key,
      parserVersionFrom: stored.parserVersion,
      parserVersionTo: batch.targetParserVersion,
      before: { text, sections, ast },
      after,
    }),
  );
  const written = await writeCaseLawRawPayload({
    owner: {
      family: RAW_SOURCE_FAMILY.CASE_LAW,
      sourceId: batch.source.id,
      documentId: batch.decisionId,
    },
    window,
    data: bytes,
    contentType: "application/json",
    storedKey: null,
    storedContentType: null,
    signal,
    s3Policy: { mode: "replay-strict", signal },
  });
  if (written.isErr()) {
    throw written.error;
  }
  const key = written.value;
  // The cursor can advance only once the sample and its discoverable reference are durable.
  await store.recordDryRunDiffSample(batch.source, {
    decisionId: batch.decisionId,
    key,
  });
};
