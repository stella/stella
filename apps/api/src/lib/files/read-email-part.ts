/**
 * An email that is a part of a stored file, such as a mailbox's message or
 * an email in an archive, read through the part link's own reader: the same
 * access check, liveness, scan and delivery audit (recorded with the part),
 * then read as any email file is.
 */
import { Result } from "better-result";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";
import {
  FILE_PART_MAX_DEPTH,
  type FilePart,
  filePartDepth,
  filePartId,
  filePartWithin,
  parseFilePartId,
} from "@stll/api-contract/file-parts";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readFilePart } from "@/api/lib/files/file-part";
import type { LegalFileReadOptions } from "@/api/lib/files/legal-file-source";

/** The email at `part` of a stored file, its bytes and its email type. */
export const readEmailPart = async ({
  part,
  ...options
}: LegalFileReadOptions & { part: FilePart }) => {
  const read = await readFilePart({ ...options, part, disposition: "inline" });
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const { bytes, fileName, mimeType } = read.value;
  const emailMimeType = resolveEmailMimeType({ mimeType, fileName });
  return emailMimeType === null
    ? Result.err(
        new HandlerError({
          status: 422,
          code: PREVIEW_UNAVAILABLE_ERROR_CODE,
          message: "This part is not an email",
        }),
      )
    : Result.ok({
        buffer: new Uint8Array(bytes).buffer,
        fileName,
        mimeType: emailMimeType,
      });
};

/**
 * An email part's attachments, addressed from the stored file through the
 * part (`message:3/attachment:0`), so each opens by the file's part link.
 * A part already as deep as a part may sit lists none: they cannot open.
 */
export const attachmentsWithin = <T extends { part: string }>(
  attachments: readonly T[],
  part: FilePart,
): T[] =>
  filePartDepth(part) >= FILE_PART_MAX_DEPTH
    ? []
    : attachments.flatMap((attachment) => {
        const own = parseFilePartId(attachment.part);
        return own === null
          ? []
          : [{ ...attachment, part: filePartId(filePartWithin(own, part)) }];
      });
