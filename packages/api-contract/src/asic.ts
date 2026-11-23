import * as v from "valibot";

import { filePartDescriptorEntries } from "./file-parts";
import { previewTextFormatSchema } from "./preview-text";

/** Payload inventory. Membership does not establish coverage by any signature. */
export const asicPreviewSchema = v.object({
  members: v.array(
    v.object({
      ...filePartDescriptorEntries,
      fileName: v.string(),
      text: v.string(),
      textFormat: previewTextFormatSchema,
      status: v.picklist(["readable", "truncated", "unavailable"]),
    }),
  ),
});
