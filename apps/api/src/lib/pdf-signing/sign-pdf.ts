/**
 * Two-phase remote signing against LibPDF.
 *
 * The private key never leaves the desktop keychain, so one `pdf.sign()` call
 * cannot produce a signed document: the bytes to sign are only known once
 * LibPDF has built the CMS signed attributes, and the signature only exists
 * once the desktop has answered. The exchange therefore runs `pdf.sign()`
 * twice over the same base bytes:
 *
 *   phase 1 - a signer that records the data LibPDF asks it to sign and
 *             aborts, so nothing is written and no timestamp is fetched;
 *   phase 2 - a signer that re-derives the digest, refuses to continue if it
 *             differs from the one phase 1 published, and returns the
 *             desktop's signature.
 *
 * Both phases must be handed the SAME options object: signing time, PAdES
 * level, subFilter, reason and location all feed the incremental save whose
 * hash becomes a signed attribute, so any drift between the phases would make
 * the desktop's signature cover bytes the document does not contain. The
 * signing time is therefore persisted in phase 1 and replayed in phase 2,
 * never re-read from the clock.
 */

import { PDF, HttpTimestampAuthority } from "@libpdf/core";
import type { DigestAlgorithm, Signer } from "@libpdf/core";
import { TaggedError } from "better-result";

import type { PdfSigningKeyType } from "@/api/db/schema";
import { env } from "@/api/env";
import type { PdfSigningSignatureAlgorithm } from "@/api/lib/pdf-signing/certificate";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * PAdES levels this pipeline produces: without a timestamp authority a
 * signature claims its own time (B-B); with one it also carries trusted time
 * and revocation data (B-LT). There is no configuration that yields B-T.
 */
export type PdfSigningLevel = "B-B" | "B-LT";

const DIGEST_ALGORITHM = "SHA-256" as const satisfies DigestAlgorithm;

/** One request's whole LibPDF budget, including a timestamp round trip. */
const PDF_SIGNING_TIMEOUT_MS = 30_000;

class PdfSigningError extends TaggedError("PdfSigningError")<{
  message: string;
  cause?: unknown;
}> {}

export class PdfSigningDigestMismatchError extends TaggedError(
  "PdfSigningDigestMismatchError",
)<{ message: string }> {}

/** Phase 1's abort. Private to this module: it is control flow, not a fault. */
class SignedAttributesCapturedError extends TaggedError(
  "SignedAttributesCapturedError",
)<{ message: string }> {}

type SigningIdentity = {
  certificate: Uint8Array;
  certificateChain: Uint8Array[];
  keyType: PdfSigningKeyType;
  signatureAlgorithm: PdfSigningSignatureAlgorithm;
};

type SigningInvocation = SigningIdentity & {
  basePdf: Uint8Array;
  location: string | null;
  reason: string | null;
  signingTime: Date;
};

export const pdfSigningLevel = (): PdfSigningLevel =>
  env.PDF_SIGNING_TSA_URL === undefined ? "B-B" : "B-LT";

/**
 * The digest the desktop's keychain signs.
 *
 * WebCrypto rather than `Bun.CryptoHasher` because this runs inside LibPDF's
 * async `Signer.sign`, which is the one place the bytes exist; keeping the
 * hash on the same async boundary keeps both phases computing it identically.
 */
const signedAttributesDigestHex = async (data: Uint8Array) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  ).toString("hex");

/**
 * The option object both phases share. Built from persisted values only, so
 * phase 2 reproduces phase 1 byte for byte.
 */
const buildSignOptions = (
  { location, reason, signingTime }: SigningInvocation,
  signer: Signer,
) => {
  const tsaUrl = env.PDF_SIGNING_TSA_URL;
  return {
    signer,
    subFilter: "ETSI.CAdES.detached",
    digestAlgorithm: DIGEST_ALGORITHM,
    level: pdfSigningLevel(),
    longTermValidation: tsaUrl !== undefined,
    signingTime,
    ...(tsaUrl !== undefined && {
      timestampAuthority: new HttpTimestampAuthority(tsaUrl),
    }),
    ...(reason !== null && { reason }),
    ...(location !== null && { location }),
  } as const;
};

/**
 * Phase 1: the SHA-256 of the CMS signed attributes, which is what the
 * desktop's keychain key signs.
 */
export const captureSigningDigest = async (
  invocation: SigningInvocation,
): Promise<string> => {
  const captured: string[] = [];
  const signer: Signer = {
    certificate: invocation.certificate,
    certificateChain: invocation.certificateChain,
    keyType: invocation.keyType,
    signatureAlgorithm: invocation.signatureAlgorithm,
    sign: async (data) => {
      captured.push(await signedAttributesDigestHex(data));
      // LibPDF has no "prepare only" mode; aborting from inside the signer is
      // the documented seam, and it stops before the timestamp request.
      throw new SignedAttributesCapturedError({
        message: "Signed attributes captured.",
      });
    },
  };

  await withTimeout(
    async () => {
      const pdf = await PDF.load(invocation.basePdf);
      try {
        await pdf.sign(buildSignOptions(invocation, signer));
      } catch (error) {
        if (!SignedAttributesCapturedError.is(error)) {
          throw new PdfSigningError({
            message: "Preparing the PDF signature failed.",
            cause: error,
          });
        }
      }
    },
    { label: "pdf-signing.capture-digest", timeoutMs: PDF_SIGNING_TIMEOUT_MS },
  );

  const digestHex = captured.at(0);
  if (digestHex === undefined) {
    throw new PdfSigningError({
      message: "LibPDF produced no signed attributes to sign.",
    });
  }
  return digestHex;
};

type ApplySignatureInvocation = SigningInvocation & {
  expectedDigestHex: string;
  signature: Uint8Array;
};

/**
 * Phase 2: the signed PDF. Throws {@link PdfSigningDigestMismatchError} when
 * LibPDF asks to sign anything other than what phase 1 published, so a
 * signature can never end up over bytes the desktop did not see.
 */
export const applySignature = async (
  invocation: ApplySignatureInvocation,
): Promise<Uint8Array> => {
  const signer: Signer = {
    certificate: invocation.certificate,
    certificateChain: invocation.certificateChain,
    keyType: invocation.keyType,
    signatureAlgorithm: invocation.signatureAlgorithm,
    sign: async (data) => {
      if (
        (await signedAttributesDigestHex(data)) !== invocation.expectedDigestHex
      ) {
        throw new PdfSigningDigestMismatchError({
          message:
            "The prepared signature no longer matches this document. Start signing again.",
        });
      }
      return invocation.signature;
    },
  };

  return await withTimeout(
    async () => {
      const pdf = await PDF.load(invocation.basePdf);
      try {
        const { bytes } = await pdf.sign(buildSignOptions(invocation, signer));
        return bytes;
      } catch (error) {
        if (PdfSigningDigestMismatchError.is(error)) {
          throw error;
        }
        throw new PdfSigningError({
          message: "Embedding the PDF signature failed.",
          cause: error,
        });
      }
    },
    { label: "pdf-signing.apply-signature", timeoutMs: PDF_SIGNING_TIMEOUT_MS },
  );
};
