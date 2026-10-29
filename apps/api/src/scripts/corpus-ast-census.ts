import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import {
  censusTombstoneReader,
  corpusAstCensus,
  readCorpusAstCensusBatch,
  readCorpusAstCensusPayload,
} from "@/api/lib/case-law/corpus-ast-census";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";

await runScriptWithErrorOutput(async () => {
  const { ingestionDb } = await openCaseLawReadOnlySession();
  const counts = await corpusAstCensus({
    readBatch: async (after) =>
      await readCorpusAstCensusBatch(ingestionDb, after),
    readPayload: readCorpusAstCensusPayload,
    readTombstones: censusTombstoneReader(ingestionDb),
  });
  console.log(JSON.stringify({ counts }));
  process.exitCode = counts.some(
    ({ invalid, unreadable }) => invalid > 0 || unreadable > 0,
  )
    ? 1
    : 0;
});
