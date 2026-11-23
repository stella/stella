import * as v from "valibot";

import { containedFileEntries } from "./file-parts";
import { previewTextFormatSchema } from "./preview-text";

/**
 * A ZIP archive's files in the archive's order, with folders as paths rather
 * than rows. Each file is a part (`member:N`) unless it is encrypted, a link,
 * damaged, or stored with a compression method the reader does not read; the
 * text of readable files shares one character budget, in archive order.
 */
export const zipArchivePreviewSchema = v.object({
  files: v.array(
    v.object({
      ...containedFileEntries,
      text: v.string(),
      textFormat: previewTextFormatSchema,
      status: v.picklist(["readable", "truncated", "unavailable"]),
    }),
  ),
});

export type ZipArchivePreview = v.InferOutput<typeof zipArchivePreviewSchema>;
