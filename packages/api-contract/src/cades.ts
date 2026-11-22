import * as v from "valibot";

import { eInvoicePreviewSchema } from "./e-invoice";
import { previewTextFormatSchema } from "./preview-text";

/**
 * Outer envelope first. Names are claims from unverified signer certificates.
 * Layer and signer ids are assigned when the envelope is parsed and are stable
 * for one file: a layer's nesting path, then the signer's position in it.
 */
export const cadesPreviewSchema = v.object({
  fileName: v.string(),
  mimeType: v.string(),
  text: v.string(),
  textFormat: previewTextFormatSchema,
  layers: v.array(
    v.object({
      id: v.string(),
      signers: v.array(
        v.object({ id: v.string(), name: v.nullable(v.string()) }),
      ),
    }),
  ),
  /** The signed file read as a structured invoice, when it is one. */
  invoice: v.nullable(eInvoicePreviewSchema),
});
