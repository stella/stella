import type { corpusSliceCensus } from "@/api/lib/case-law/corpus-slice-census";

type CorpusSliceCensusResult = Awaited<ReturnType<typeof corpusSliceCensus>>;

export const corpusSliceCensusOutput = (
  census: CorpusSliceCensusResult,
): { json: string; exitCode: 0 | 1 } => ({
  json: JSON.stringify(census, null, 2),
  exitCode: census.verdict === "complete" ? 0 : 1,
});
