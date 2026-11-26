/**
 * Read-only census of every published decision's stored document, by source
 * and parser version: whether the reader schema accepts it, and whether its
 * paragraphs carry the court's own numbers (`paragraphNumbering`). The share
 * `paragraphNumbering.noneButPrinted / valid` is the decisions whose text
 * still prints a court numbering while no stored paragraph carries it.
 *
 * Usage: bun apps/api/src/scripts/corpus-ast-census.ts
 */
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
