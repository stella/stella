import { Result, TaggedError } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { parseImportCorpusSliceArguments } from "@/api/scripts/import-corpus-slice-plan";

class ImportCorpusSliceExecutionError extends TaggedError(
  "ImportCorpusSliceExecutionError",
)<{ message: string }> {}

await runScriptWithErrorOutput(async () => {
  const options = parseImportCorpusSliceArguments(process.argv.slice(2));
  if (Result.isError(options)) {
    throw options.error;
  }
  if (options.value.mode === "dry-run") {
    console.log(
      JSON.stringify({ mode: "dry-run", prefix: options.value.prefix }),
    );
    return;
  }
  const lane = await enterCaseLawMaintenanceLane();
  await lane.release();
  throw new ImportCorpusSliceExecutionError({
    message: "Corpus slice execution requires an object-storage adapter",
  });
});
