import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type {
  IngestionResult,
  StoredRawReadError,
  StoredRawResultReader,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { ProcessSupplementOptions } from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import type { SafeId } from "@/api/lib/branded-types";

type RebuildStoredJudgmentOptions = {
  judgmentId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  reparseStoredRaw: ProcessSupplementOptions["reparseStoredRaw"];
  readStoredRaw: StoredRawResultReader;
};

type RebuiltJudgment =
  | { type: "rebuilt"; result: IngestionResult }
  | { type: "unreadable"; detail: string }
  /** Object storage did not answer; nothing is known about the payload. */
  | { type: "read-failed"; error: StoredRawReadError };

/**
 * The judgment's own observation, rebuilt from the payload stored with it,
 * as a replay rebuilds it. The payload travels with the result so the write
 * keeps the row's raw pointer on the same content-addressed object.
 */
export const rebuildStoredJudgment = async ({
  judgmentId,
  scopedDb,
  reparseStoredRaw,
  readStoredRaw,
}: RebuildStoredJudgmentOptions): Promise<RebuiltJudgment> => {
  const row = (
    await scopedDb((tx) =>
      tx
        .select({
          caseNumber: caseLawDecisions.caseNumber,
          sourceDocumentId: caseLawDecisions.sourceDocumentId,
          language: caseLawDecisions.language,
          court: caseLawDecisions.court,
          ecli: caseLawDecisions.ecli,
          decisionDate: caseLawDecisions.decisionDate,
          decisionType: caseLawDecisions.decisionType,
          sourceUrl: caseLawDecisions.sourceUrl,
          documentUrl: caseLawDecisions.documentUrl,
          metadata: caseLawDecisions.metadata,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          sourceRawContentType: caseLawDecisions.sourceRawContentType,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, judgmentId))
        .limit(1),
    )
  ).at(0);
  if (row === undefined) {
    return { type: "unreadable", detail: "the judgment row is gone" };
  }
  if (row.sourceRawS3Key === null) {
    return { type: "unreadable", detail: "the judgment has no stored payload" };
  }
  const read = await readStoredRaw(row.sourceRawS3Key);
  if (Result.isError(read)) {
    return read.error.permanent
      ? { type: "unreadable", detail: read.error.message }
      : { type: "read-failed", error: read.error };
  }
  const raw = read.value;
  if (raw === null) {
    return { type: "unreadable", detail: `no object at ${row.sourceRawS3Key}` };
  }
  const reparsed = await reparseStoredRaw({
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
  switch (reparsed.type) {
    case "rejected":
      return {
        type: "unreadable",
        detail: `${reparsed.rejection}: ${reparsed.detail}`,
      };
    case "supplement":
      return {
        type: "unreadable",
        detail: "the judgment's payload is itself a supplement",
      };
    case "parsed":
      break;
    default: {
      reparsed satisfies never;
      return panic(`Unhandled reparse outcome: ${String(reparsed)}`);
    }
  }
  if ((reparsed.result.sourceDocumentId ?? null) !== row.sourceDocumentId) {
    return {
      type: "unreadable",
      detail: `the payload names ${reparsed.result.sourceDocumentId ?? "no id"}`,
    };
  }
  return {
    type: "rebuilt",
    result: {
      ...reparsed.result,
      sourceRawBytes: raw,
      sourceRawContentType:
        row.sourceRawContentType ?? reparsed.result.sourceRawContentType,
    },
  };
};
