import * as v from "valibot";

/** Outer envelope first. Names are claims from unverified signer certificates. */
export const cadesPreviewSchema = v.object({
  fileName: v.string(),
  mimeType: v.string(),
  text: v.string(),
  layers: v.array(
    v.object({ signers: v.array(v.object({ name: v.nullable(v.string()) })) }),
  ),
});
