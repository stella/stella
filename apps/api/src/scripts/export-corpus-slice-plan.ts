import { Result, TaggedError } from "better-result";

export const CORPUS_SLICE_TRANSFER_BATCH_SIZE = 500;

export type ExportCorpusSliceOptions = {
  prefix: string;
  mode: "dry-run" | "export" | "copy-objects";
  targetBucket?: string;
  resumeAfterDecisionId?: string;
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
  const copyObjects = args.includes("--copy-objects");
  const execute = args.includes("--execute");
  const targetIndex = args.indexOf("--target-bucket");
  const resumeIndex = args.indexOf("--resume-after-decision-id");
  const targetBucket =
    targetIndex === -1 ? undefined : args.at(targetIndex + 1);
  const resumeAfterDecisionId =
    resumeIndex === -1 ? undefined : args.at(resumeIndex + 1);
  if (copyObjects && targetBucket === undefined) {
    return Result.err(
      new ExportCorpusSliceArgumentsError({
        message: "--copy-objects requires --target-bucket <name>",
      }),
    );
  }
  let mode: ExportCorpusSliceOptions["mode"] = "dry-run";
  if (execute) {
    mode = "export";
  }
  if (copyObjects) {
    mode = "copy-objects";
  }
  return Result.ok({
    prefix,
    mode,
    ...(targetBucket === undefined ? {} : { targetBucket }),
    ...(resumeAfterDecisionId === undefined ? {} : { resumeAfterDecisionId }),
  });
};
