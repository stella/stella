import { Result, TaggedError } from "better-result";

export type ImportCorpusSliceOptions = {
  prefix: string;
  mode: "dry-run" | "import";
};

export class ImportCorpusSliceArgumentsError extends TaggedError(
  "ImportCorpusSliceArgumentsError",
)<{ message: string }> {}

export const parseImportCorpusSliceArguments = (
  args: readonly string[],
): Result<ImportCorpusSliceOptions, ImportCorpusSliceArgumentsError> => {
  const prefix = args.at(0);
  if (prefix === undefined || prefix.startsWith("--")) {
    return Result.err(
      new ImportCorpusSliceArgumentsError({
        message: "an object prefix is required",
      }),
    );
  }
  return Result.ok({
    prefix,
    mode: args.includes("--execute") ? "import" : "dry-run",
  });
};
