import { Result, TaggedError } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";
import { parseExportCorpusSliceArguments } from "@/api/scripts/export-corpus-slice-plan";

class ExportCorpusSliceExecutionError extends TaggedError(
  "ExportCorpusSliceExecutionError",
)<{ message: string }> {}

await runScriptWithErrorOutput(async () => {
  const options = parseExportCorpusSliceArguments(process.argv.slice(2));
  if (Result.isError(options)) {
    throw options.error;
  }
  await openCaseLawReadOnlySession();
  if (options.value.mode === "dry-run") {
    console.log(
      JSON.stringify({ mode: "dry-run", prefix: options.value.prefix }),
    );
    return;
  }
  throw new ExportCorpusSliceExecutionError({
    message: "Corpus slice execution requires an object-storage adapter",
  });
});
