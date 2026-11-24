import * as v from "valibot";

import { filePartDescriptorSchema } from "./file-parts";
import { previewTextFormatSchema } from "./preview-text";

/**
 * A national signed container's contents. Documents keep the container's
 * order; a document's position in the list addresses it as a part. Signer
 * names are claims from unverified certificates, and listing a signer does not
 * establish which documents a signature covers.
 */
export const signedDossierPreviewSchema = v.object({
  /** Whether the container is a delivery receipt rather than a dossier. */
  receipt: v.boolean(),
  documents: v.array(
    v.object({
      /** Stable for one file: the document's position in the container. */
      id: v.string(),
      fileName: v.string(),
      text: v.string(),
      textFormat: previewTextFormatSchema,
      status: v.picklist(["readable", "truncated", "unavailable"]),
      /** The document as a part of the file; null when it cannot be read. */
      part: v.nullable(filePartDescriptorSchema),
    }),
  ),
  signers: v.array(v.object({ id: v.string(), name: v.nullable(v.string()) })),
});
