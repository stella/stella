import { Result, TaggedError } from "better-result";

import { getTranslator } from "@/i18n/translator";

export class EmptyUploadFileError extends TaggedError("EmptyUploadFileError")<{
  message: string;
}> {}

export const validateUploadFileNotEmpty = (
  size: number,
): Result<void, EmptyUploadFileError> => {
  if (size !== 0) {
    return Result.ok();
  }
  return Result.err(
    new EmptyUploadFileError({
      message: getTranslator()("workspaces.files.emptyFile"),
    }),
  );
};
