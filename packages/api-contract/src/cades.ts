import * as v from "valibot";

/**
 * Outer envelope first. Names are claims from unverified signer certificates.
 * Layer and signer ids are assigned when the envelope is parsed and are stable
 * for one file: a layer's nesting path, then the signer's position in it.
 */
export const cadesPreviewSchema = v.object({
  fileName: v.string(),
  mimeType: v.string(),
  text: v.string(),
  layers: v.array(
    v.object({
      id: v.string(),
      signers: v.array(
        v.object({ id: v.string(), name: v.nullable(v.string()) }),
      ),
    }),
  ),
});
