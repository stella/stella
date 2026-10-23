import { TaggedError } from "better-result";

import { getTranslator } from "@/i18n/translator";

export class EmptyUploadFileError extends TaggedError("EmptyUploadFileError")<{
  message: string;
}> {}

export const assertUploadFileNotEmpty = (size: number): void => {
  if (size !== 0) {
    return;
  }
  throw new EmptyUploadFileError({
    message: getTranslator()("workspaces.files.emptyFile"),
  });
};
