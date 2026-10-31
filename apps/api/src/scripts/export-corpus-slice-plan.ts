import { Result, TaggedError } from "better-result";

export const CORPUS_SLICE_TRANSFER_BATCH_SIZE = 500;

export type ExportCorpusSliceOptions = {
  prefix: string;
  mode: "dry-run" | "export";
};

export class ExportCorpusSliceArgumentsError extends TaggedError(
  "ExportCorpusSliceArgumentsError",
)<{ message: string }> {}

export const parseExportCorpusSliceArguments = (
  args: readonly string[],
): Result<ExportCorpusSliceOptions, ExportCorpusSliceArgumentsError> => {
  const prefix = args.at(0);
  if (prefix === undefined || prefix.startsWith("--")) {
    return Result.err(
      new ExportCorpusSliceArgumentsError({
        message: "an object prefix is required",
      }),
    );
  }
  const unsupported = args
    .slice(1)
    .find((argument) => argument !== "--execute");
  if (unsupported !== undefined) {
    return Result.err(
      new ExportCorpusSliceArgumentsError({
        message: `unsupported export option: ${unsupported}`,
      }),
    );
  }
  const execute = args.includes("--execute");
  return Result.ok({
    prefix,
    mode: execute ? "export" : "dry-run",
  });
};
