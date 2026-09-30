import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import {
  readCorpusAst,
  readCorpusText,
  readCorpusSections,
} from "@/api/lib/legal-search/corpus-storage";
import { corpusTombstoneReaderForTx } from "@/api/lib/legal-search/corpus-tombstones";

import type { CaseLawCorpusDependencies } from "./dependencies";

type ValidationSnapshotOptions = {
  scopedDb: ScopedDb;
  decisionId: SafeId<"caseLawDecision">;
  readBytes?: CaseLawCorpusDependencies["readBytes"];
};

/** Read the authoritative payload, including rows whose Postgres columns were trimmed. */
export const loadValidationSnapshot = async ({
  scopedDb,
  decisionId,
  readBytes,
}: ValidationSnapshotOptions) => {
  const row = (
    await scopedDb((tx) =>
      tx
        .select({
          sourceId: caseLawDecisions.sourceId,
          country: caseLawDecisions.country,
          metadata: caseLawDecisions.metadata,
          updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
          text: caseLawDecisions.fulltext,
          ast: caseLawDecisions.documentAst,
          sections: caseLawDecisions.sections,
          textS3Key: caseLawDecisions.textS3Key,
          astS3Key: caseLawDecisions.astS3Key,
          normalizedS3Key: caseLawDecisions.normalizedS3Key,
          redactedAt: caseLawDecisions.redactedAt,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          sourceRawContentType: caseLawDecisions.sourceRawContentType,
          contentHash: caseLawDecisions.contentHash,
          parserVersion: caseLawDecisions.parserVersion,
          sourceHash: caseLawDecisions.sourceHash,
          sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
          corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1),
    )
  ).at(0);
  if (row === undefined || row.redactedAt !== null) {
    return null;
  }
  const seams = {
    ...readBytes,
    readTombstones: async (
      locations: Parameters<ReturnType<typeof corpusTombstoneReaderForTx>>[0],
    ) =>
      await scopedDb(
        async (tx) => await corpusTombstoneReaderForTx(tx)(locations),
      ),
  };
  const [text, ast, sections] = await Promise.all([
    row.textS3Key === null ? row.text : readCorpusText(row.textS3Key, seams),
    row.astS3Key === null ? row.ast : readCorpusAst(row.astS3Key, seams),
    row.normalizedS3Key === null
      ? row.sections
      : readCorpusSections(row.normalizedS3Key, seams),
  ]);
  return { row, payload: { text, ast, sections } };
};
