import type { SafeId } from "@/api/lib/branded-types";
import { readCorpusPayloadOrFallback } from "@/api/lib/legal-search/corpus-storage";

type ReadServedDecisionTextOptions = {
  textS3Key: string | null;
  contentHash: string | null;
  decisionId: SafeId<"caseLawDecision">;
  corpusReadEnabled: boolean;
  readStore: () => Promise<string | null>;
  readRow: () => Promise<string | null>;
};

/** Empty row markers cannot stand in for an unreadable canonical object. */
export const readServedDecisionText = async ({
  textS3Key,
  contentHash,
  decisionId,
  corpusReadEnabled,
  readStore,
  readRow,
}: ReadServedDecisionTextOptions): Promise<string | null> => {
  if (!corpusReadEnabled || textS3Key === null || contentHash === null) {
    return await readRow();
  }
  return await readCorpusPayloadOrFallback({
    documentId: decisionId,
    key: textS3Key,
    step: "readDecision.corpusText",
    read: readStore,
    fallback: async () => {
      const text = await readRow();
      return text === "" ? null : text;
    },
  });
};
