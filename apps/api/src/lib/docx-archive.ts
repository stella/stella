import { Result } from "better-result";

import { loadDocx } from "@stll/docx-utils";
import type { ArchiveOptions } from "@stll/docx-utils";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export {
  DOCX_MAX_ENTRIES,
  DOCX_MAX_ENTRY_BYTES,
  DocxArchiveError,
  loadDocx,
  loadDocxArchive,
  type DocxArchive,
} from "@stll/docx-utils";

/** Validate archive bytes before handing them to a document parser. */
export const validateDocxArchive = async (
  bytes: ArrayBuffer | Uint8Array,
  options: ArchiveOptions = {},
): Promise<Result<void, HandlerError<422>>> =>
  (
    await Result.tryPromise({
      try: async () => await loadDocx(bytes, options),
      catch: (cause) =>
        new HandlerError({
          status: 422,
          message: "Invalid archive",
          cause,
        }),
    })
  ).map(() => undefined);
