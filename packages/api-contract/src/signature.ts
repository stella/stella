import * as v from "valibot";

/**
 * How a signature relates to what it signs: in a file of its own beside it
 * (detached), carrying it (enveloping, which includes an attached CMS
 * signature), or inside the signed XML document (enveloped).
 */
export const SIGNATURE_PACKAGINGS = [
  "detached",
  "enveloping",
  "enveloped",
] as const;

export type SignaturePackaging = (typeof SIGNATURE_PACKAGINGS)[number];

/**
 * Whether a matter document's stored bytes have the digest the signature
 * states for the file it covers. Equal digests bind the bytes to what the
 * signer named; they say nothing about whether the signature is valid.
 */
export const SIGNED_FILE_BINDINGS = [
  "digestMatches",
  "digestDiffers",
  "notCompared",
] as const;

export type SignedFileBinding = (typeof SIGNED_FILE_BINDINGS)[number];

const signaturePreview = v.object({
  type: v.literal("signature"),
  standard: v.picklist(["cades", "xades"]),
  packaging: v.picklist(SIGNATURE_PACKAGINGS),
  /** Names are claims from unverified signer certificates. */
  signers: v.array(
    v.object({
      id: v.string(),
      name: v.nullable(v.string()),
      signedAt: v.nullable(v.string()),
    }),
  ),
  /** File names the signature itself says it covers. */
  statedFileNames: v.array(v.string()),
  /**
   * Documents in the same matter that this signature appears to sign, by
   * file name or by digest. Only documents the reader can open are listed.
   */
  signedFiles: v.array(
    v.object({
      entityId: v.string(),
      /** The document's file the binding speaks about. */
      fieldId: v.string(),
      fileName: v.string(),
      binding: v.picklist(SIGNED_FILE_BINDINGS),
    }),
  ),
  /**
   * The document the signature carries (enveloping), or the signed XML
   * document's own text (enveloped). Null for a detached signature.
   */
  document: v.nullable(
    v.object({
      fileName: v.string(),
      mimeType: v.string(),
      text: v.string(),
    }),
  ),
});

/**
 * A file read as a signature. `notSignature` answers only for a file whose
 * name does not settle it (`.sig`, `.xml`): its bytes are not a signature, and
 * the file opens as it would otherwise.
 */
export const signaturePreviewSchema = v.variant("type", [
  signaturePreview,
  v.object({ type: v.literal("notSignature") }),
]);

export type SignaturePreview = v.InferOutput<typeof signaturePreviewSchema>;
