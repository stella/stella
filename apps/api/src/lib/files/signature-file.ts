import { Result, TaggedError } from "better-result";

import { UPLOAD_DOCUMENT_MAX_BYTES } from "@stll/api-contract/limits";
import type { SignaturePackaging } from "@stll/api-contract/signature";
import { declareFingerprintFields } from "@stll/errors";

import {
  hasCmsSignedDataHeader,
  readCmsSignature,
  type StatedDigest,
} from "@/api/lib/files/cms-signed-data";
import { parseP7m } from "@/api/lib/files/p7m";

export const SIGNATURE_FILE_LIMITS = {
  maxFileBytes: UPLOAD_DOCUMENT_MAX_BYTES,
  /** Signatures, references and signers read from one file. */
  maxEntries: 64,
} as const;

const SIGNATURE_PARSE_MESSAGES = {
  too_large: "The file exceeds the size limit",
  not_signature: "The file is not a signature this reader recognizes",
  unsupported: "The signature's content is unsupported",
  limit: "The signature exceeds the reading limits",
} as const;

export class SignatureParseError extends TaggedError("SignatureParseError")<{
  message: string;
  reason: keyof typeof SIGNATURE_PARSE_MESSAGES;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export const signatureFailure = (
  reason: keyof typeof SIGNATURE_PARSE_MESSAGES,
) =>
  Result.err(
    new SignatureParseError({
      reason,
      message: SIGNATURE_PARSE_MESSAGES[reason],
    }),
  );

export type SignatureSigner = {
  /** Stable within one parse of one file. */
  id: string;
  /** The subject a certificate names. Never verified. */
  name: string | null;
  signedAt: string | null;
};

/** One file a detached signature says it covers. */
export type SignatureReference = {
  /** The name the signature gives it; CMS carries none. */
  fileName: string | null;
  /** The digest the signature states for its bytes, when comparable. */
  digest: StatedDigest | null;
};

export type ParsedSignatureFile = {
  standard: "cades" | "xades";
  packaging: SignaturePackaging;
  signers: SignatureSigner[];
  references: SignatureReference[];
  /** Bytes the signature carries: an attached or enveloping document. */
  embedded: { bytes: Uint8Array; mimeType: string | null } | null;
  /** Readable text of a signed XML document the signature sits inside. */
  documentText: string | null;
};

const PEM_BODY =
  /^-----BEGIN [A-Z0-9 ]{1,40}-----([A-Za-z0-9+/=\s]*)-----END [A-Z0-9 ]{1,40}-----\s*$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** Strict base64, with any whitespace between groups; null otherwise. */
export const decodeBase64Text = (text: string): Uint8Array | null => {
  const compact = text.replace(/\s+/gu, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !BASE64.test(compact)
  ) {
    return null;
  }
  return new Uint8Array(Buffer.from(compact, "base64"));
};

/** DER or BER as is; PEM armor or bare base64 when it decodes to SignedData. */
const cmsBytes = (bytes: Uint8Array): Uint8Array | null => {
  if (bytes.at(0) === 0x30) {
    return bytes;
  }
  // PEM armor and base64 are ASCII; bytes that are not UTF-8 are neither.
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (Result.isError(decoded)) {
    return null;
  }
  const text = decoded.value.trim();
  const body = PEM_BODY.exec(text)?.[1] ?? text;
  const der = decodeBase64Text(body);
  return der !== null && hasCmsSignedDataHeader(der) ? der : null;
};

const distinctDigests = (digests: readonly StatedDigest[]) =>
  [
    ...new Map(
      digests.map((digest) => [`${digest.algorithm}:${digest.hex}`, digest]),
    ).values(),
  ].slice(0, SIGNATURE_FILE_LIMITS.maxEntries);

/**
 * A `.p7s` or `.sig` CMS signature. A detached one states the digest of the
 * bytes it covers; an attached one carries them, read as a `.p7m` would be.
 */
export const parseCmsSignatureFile = (
  bytes: Uint8Array,
): Result<ParsedSignatureFile, SignatureParseError> => {
  if (bytes.byteLength > SIGNATURE_FILE_LIMITS.maxFileBytes) {
    return signatureFailure("too_large");
  }
  const der = cmsBytes(bytes);
  if (der === null) {
    return signatureFailure("not_signature");
  }
  const signature = readCmsSignature(der);
  if (signature.isErr()) {
    return signatureFailure(
      signature.error === "not_signed_data" ? "not_signature" : "unsupported",
    );
  }
  if (signature.value.signers.length === 0) {
    return signatureFailure("not_signature");
  }
  if (signature.value.content !== null) {
    const attached = parseP7m(der);
    if (attached.isErr()) {
      return signatureFailure(
        attached.error.reason === "not_signed_data"
          ? "not_signature"
          : "unsupported",
      );
    }
    return Result.ok({
      standard: "cades",
      packaging: "enveloping",
      signers: attached.value.layers.flatMap(({ signers }) =>
        signers.map(({ id, name, signedAt }) => ({ id, name, signedAt })),
      ),
      references: [],
      embedded: { bytes: attached.value.bytes, mimeType: null },
      documentText: null,
    });
  }
  const { signers } = signature.value;
  const digests = distinctDigests(
    signers.flatMap(({ messageDigest }) =>
      messageDigest === null ? [] : [messageDigest],
    ),
  );
  return Result.ok({
    standard: "cades",
    packaging: "detached",
    signers: signers.map(({ id, name, signedAt }) => ({ id, name, signedAt })),
    references:
      digests.length === 0
        ? [{ fileName: null, digest: null }]
        : digests.map((digest) => ({ fileName: null, digest })),
    embedded: null,
    documentText: null,
  });
};
