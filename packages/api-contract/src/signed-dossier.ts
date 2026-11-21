import * as v from "valibot";

/**
 * A national signed container's contents. Documents keep the container's
 * order; a document's position in the list addresses its PDF content. Signer
 * names are claims from unverified certificates, and listing a signer does not
 * establish which documents a signature covers.
 */
export const signedDossierPreviewSchema = v.object({
  documents: v.array(
    v.object({
      fileName: v.string(),
      text: v.string(),
      status: v.picklist(["readable", "truncated", "unavailable"]),
      /** Whether the document is a PDF the content route can deliver. */
      pdf: v.boolean(),
    }),
  ),
  signers: v.array(v.object({ id: v.string(), name: v.nullable(v.string()) })),
});
