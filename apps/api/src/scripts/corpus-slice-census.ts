import { Result, TaggedError } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { corpusSliceCensus } from "@/api/lib/case-law/corpus-slice-census";
import { parseCorpusSliceTransferManifest } from "@/api/lib/case-law/corpus-slice-transfer";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";
import { corpusSliceCensusOutput } from "@/api/scripts/corpus-slice-census-output";

class CorpusSliceCensusScriptError extends TaggedError(
  "CorpusSliceCensusScriptError",
)<{ message: string }> {}

const manifestPath = process.argv.at(2);
if (manifestPath === undefined || process.argv.length !== 3) {
  console.error(
    "Usage: bun src/scripts/corpus-slice-census.ts <manifest.json>",
  );
  process.exit(2);
}

await runScriptWithErrorOutput(async () => {
  const content = await Result.tryPromise({
    try: async () => await Bun.file(manifestPath).text(),
    catch: (cause) =>
      new CorpusSliceCensusScriptError({
        message: `cannot read manifest: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (Result.isError(content)) {
    throw content.error;
  }
  const json = Result.try({
    try: (): unknown => JSON.parse(content.value),
    catch: (cause) =>
      new CorpusSliceCensusScriptError({
        message: `manifest is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (Result.isError(json)) {
    throw json.error;
  }
  const manifest = parseCorpusSliceTransferManifest(json.value);
  if (Result.isError(manifest)) {
    throw manifest.error;
  }
  const { ingestionDb } = await openCaseLawReadOnlySession();
  const census = await corpusSliceCensus(manifest.value.corpus, ingestionDb);
  const output = corpusSliceCensusOutput(census);
  console.log(output.json);
  process.exitCode = output.exitCode;
});
