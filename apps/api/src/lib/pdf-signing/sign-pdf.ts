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
 *             answers with a stand-in signature as large as the real one
 *             plus its timestamp can get, so an undersized placeholder is
 *             found here, before the desktop asks for a PIN; nothing is
 *             stored and no timestamp is fetched;
 *   phase 2 - a signer that re-derives the digest, refuses to continue if it
 *             differs from the one phase 1 published, and returns the
 *             desktop's signature.
 *
 * Both phases must be handed the SAME options object: signing time,
 * placeholder size, subFilter, reason and location all feed the incremental
 * save whose
 * hash becomes a signed attribute, so any drift between the phases would make
 * the desktop's signature cover bytes the document does not contain. The
 * signing time is therefore persisted in phase 1 and replayed in phase 2,
 * never re-read from the clock.
 */

import { PDF, PlaceholderError } from "@libpdf/core";
import type {
  DigestAlgorithm,
  Signer,
  SignWarning,
  TimestampAuthority,
} from "@libpdf/core";
import { TaggedError } from "better-result";

import type { PdfSigningKeyType } from "@/api/db/schema";
import { isSignedPdf } from "@/api/lib/files/pdf-signatures";
import type { PdfSigningSignatureAlgorithm } from "@/api/lib/pdf-signing/certificate";
import {
  certificationPathReachesAnchor,
  completeCertificateChain,
} from "@/api/lib/pdf-signing/certificate-chain";
import { readDocMdpPermission } from "@/api/lib/pdf-signing/doc-mdp";
import { createTrackedRevocationProvider } from "@/api/lib/pdf-signing/revocation";
import type { TrackedRevocationProvider } from "@/api/lib/pdf-signing/revocation";
import {
  addSignatureStamp,
  certificateSubjectName,
  stampLines,
} from "@/api/lib/pdf-signing/stamp";
import type { SignatureStamp } from "@/api/lib/pdf-signing/stamp";
import { loadStampFont } from "@/api/lib/pdf-signing/stamp-font";
import {
  createFallbackTimestampAuthority,
  PdfSigningTimestampUnavailableError,
} from "@/api/lib/pdf-signing/timestamp-authority";
import type { NamedTimestampAuthority } from "@/api/lib/pdf-signing/timestamp-authority";
import {
  embedValidationData,
  findRevokedCertificates,
  gatherValidationData,
} from "@/api/lib/pdf-signing/validation-data";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * PAdES levels this pipeline produces: without trusted time a signature
 * claims its own time (B-B); with a timestamp it is B-T; with validation data
 * for its whole chain as well, B-LT.
 */
export type PdfSigningLevel = "B-B" | "B-T" | "B-LT";

const DIGEST_ALGORITHM = "SHA-256" as const satisfies DigestAlgorithm;

/** Phase 1 is local work over the stored bytes. */
const PDF_SIGNING_PREPARE_TIMEOUT_MS = 30_000;
/**
 * Phase 2 adds the timestamp authorities, tried in turn, and the revocation
 * fetches; both are bounded on their own, this bounds the whole.
 */
const PDF_SIGNING_APPLY_TIMEOUT_MS = 75_000;

class PdfSigningError extends TaggedError("PdfSigningError")<{
  message: string;
  cause?: unknown;
}> {}

export class PdfSigningDigestMismatchError extends TaggedError(
  "PdfSigningDigestMismatchError",
)<{ message: string }> {}

/**
 * The document carries a certification that permits no changes, so any
 * signature appended to it would break the certification.
 */
/**
 * The document already carries signatures and LibPDF could only sign it by
 * rewriting the whole file, which would break every one of them.
 */
export class PdfSigningWouldBreakSignaturesError extends TaggedError(
  "PdfSigningWouldBreakSignaturesError",
)<{ message: string }> {}

/** Revocation data says a certificate of the signer's chain is revoked. */
export class PdfSigningCertificateRevokedError extends TaggedError(
  "PdfSigningCertificateRevokedError",
)<{ message: string }> {}

export class PdfSigningCertifiedDocumentError extends TaggedError(
  "PdfSigningCertifiedDocumentError",
)<{ message: string }> {}

/**
 * The CMS would not fit the reserved `/Contents`. Raised in phase 1, where
 * the stand-in signature is at least as large as anything phase 2 embeds.
 */
export class PdfSigningPlaceholderTooSmallError extends TaggedError(
  "PdfSigningPlaceholderTooSmallError",
)<{ message: string; availableBytes: number; requiredBytes: number }> {}

/**
 * Bytes reserved in `/Contents` for everything that is not a certificate:
 * the signed attributes, SignerInfo and CMS framing.
 */
const CMS_OVERHEAD_BYTES = 4096;
/** An RSA-8192 signature; every EC and smaller RSA signature is shorter. */
const SIGNATURE_VALUE_MAX_BYTES = 1024;
/**
 * A timestamp token is an unsigned attribute of the CMS, so it shares
 * `/Contents`. Tokens carry the authority's certificate and often its chain;
 * this covers the large ones seen from qualified authorities.
 */
const TIMESTAMP_TOKEN_RESERVE_BYTES = 16_384;
const PLACEHOLDER_FLOOR_BYTES = 16_384;
const TIMESTAMPED_PLACEHOLDER_FLOOR_BYTES = 32_768;
const PLACEHOLDER_GRANULARITY_BYTES = 1024;

/**
 * The `/Contents` reservation for this signer: its certificates, the largest
 * signature value, the CMS framing and, when a timestamp is coming, room for
 * the token. The size feeds the hashed byte range, so it is computed once in
 * phase 1 and replayed from the session in phase 2.
 */
export const signaturePlaceholderSize = ({
  certificate,
  certificateChain,
  timestamped,
}: {
  certificate: Uint8Array;
  certificateChain: readonly Uint8Array[];
  timestamped: boolean;
}): number => {
  const needed =
    certificate.byteLength +
    certificateChain.reduce((total, entry) => total + entry.byteLength, 0) +
    SIGNATURE_VALUE_MAX_BYTES +
    CMS_OVERHEAD_BYTES +
    (timestamped ? TIMESTAMP_TOKEN_RESERVE_BYTES : 0);
  const rounded =
    Math.ceil(needed / PLACEHOLDER_GRANULARITY_BYTES) *
    PLACEHOLDER_GRANULARITY_BYTES;
  return Math.max(
    rounded,
    timestamped ? TIMESTAMPED_PLACEHOLDER_FLOOR_BYTES : PLACEHOLDER_FLOOR_BYTES,
  );
};

type SigningIdentity = {
  certificate: Uint8Array;
  certificateChain: Uint8Array[];
  keyType: PdfSigningKeyType;
  signatureAlgorithm: PdfSigningSignatureAlgorithm;
};

type SigningInvocation = SigningIdentity & {
  basePdf: Uint8Array;
  location: string | null;
  /** `/Contents` reservation in bytes; see {@link signaturePlaceholderSize}. */
  placeholderSize: number;
  reason: string | null;
  signingTime: Date;
  /** A visible stamp to sign into, or `null` for an invisible signature. */
  stamp: SignatureStamp | null;
};

/**
 * Put the stamp's field on the page, when there is one, and name the field
 * to sign into. Runs on a freshly loaded document in both phases; the stamp
 * is built from persisted inputs only, so both produce the same bytes.
 */
const prepareSignatureField = async (
  pdf: PDF,
  invocation: SigningInvocation,
): Promise<string | undefined> =>
  invocation.stamp === null
    ? undefined
    : addSignatureStamp({
        fontBytes: await loadStampFont(),
        lines: stampLines({
          location: invocation.location,
          reason: invocation.reason,
          signerName: certificateSubjectName(invocation.certificate),
          signingTime: invocation.signingTime,
          stamp: invocation.stamp,
        }),
        pdf,
        stamp: invocation.stamp,
      });

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
 * What only phase 2 adds: trusted time. The timestamp is an unsigned
 * attribute, so phase 1 leaves it out and the digest it publishes is still
 * the one phase 2 reproduces. Validation data is never LibPDF's to gather
 * (see `validation-data.ts`), so its `longTermValidation` stays off.
 */
type TrustOptions = {
  timestampAuthority?: TimestampAuthority;
};

/**
 * The option object both phases share. Built from persisted values only, so
 * phase 2 reproduces phase 1 byte for byte.
 */
const buildSignOptions = (
  { location, placeholderSize, reason, signingTime }: SigningInvocation,
  signer: Signer,
  trust: TrustOptions,
  fieldName: string | undefined,
) =>
  ({
    signer,
    subFilter: "ETSI.CAdES.detached",
    digestAlgorithm: DIGEST_ALGORITHM,
    estimatedSize: placeholderSize,
    signingTime,
    ...(fieldName !== undefined && { fieldName }),
    ...trust,
    ...(reason !== null && { reason }),
    ...(location !== null && { location }),
  }) as const;

export type CapturedSigningDigest = {
  /** SHA-256 of `signedAttributes`: what the desktop's keychain signs. */
  digestHex: string;
  /** The DER-encoded CMS signed attributes the signature covers. */
  signedAttributes: Uint8Array;
};

/**
 * Phase 1: the CMS signed attributes and their SHA-256, which is what the
 * desktop's keychain key signs. `reserveTimestamp` sizes the stand-in
 * signature for a phase 2 that will add a timestamp token.
 */
export const captureSigningDigest = async (
  invocation: SigningInvocation & { reserveTimestamp: boolean },
): Promise<CapturedSigningDigest> => {
  const captured: CapturedSigningDigest[] = [];
  const standIn = new Uint8Array(
    SIGNATURE_VALUE_MAX_BYTES +
      (invocation.reserveTimestamp ? TIMESTAMP_TOKEN_RESERVE_BYTES : 0),
  );
  const signer: Signer = {
    certificate: invocation.certificate,
    certificateChain: invocation.certificateChain,
    keyType: invocation.keyType,
    signatureAlgorithm: invocation.signatureAlgorithm,
    sign: async (data) => {
      captured.push({
        digestHex: await signedAttributesDigestHex(data),
        signedAttributes: new Uint8Array(data),
      });
      // LibPDF has no "prepare only" mode. Answering with a stand-in lets it
      // assemble the whole CMS and try to fit it into the placeholder, which
      // is the one check that must not wait for the desktop's signature.
      return standIn;
    },
  };

  await withTimeout(
    async () => {
      const pdf = await PDF.load(invocation.basePdf);
      // Checked here, before any digest exists, so the desktop never asks
      // for a PIN on a document the signature would invalidate.
      // A signature is appended as a new revision; where LibPDF would
      // rewrite the file instead (a linearized or repaired file), existing
      // signatures would no longer cover their bytes.
      if (
        isSignedPdf({ pdf, source: invocation.basePdf }) &&
        pdf.canSaveIncrementally() !== null
      ) {
        throw new PdfSigningWouldBreakSignaturesError({
          message:
            "Signing this PDF would invalidate the signatures it already carries.",
        });
      }
      if (readDocMdpPermission({ pdf, source: invocation.basePdf }) === 1) {
        throw new PdfSigningCertifiedDocumentError({
          message:
            "This PDF is certified and its certification forbids changes.",
        });
      }
      try {
        const fieldName = await prepareSignatureField(pdf, invocation);
        await pdf.sign(buildSignOptions(invocation, signer, {}, fieldName));
      } catch (error) {
        if (error instanceof PlaceholderError) {
          throw new PdfSigningPlaceholderTooSmallError({
            message: "The signature would not fit the space reserved for it.",
            availableBytes: error.availableSize,
            requiredBytes: error.requiredSize,
          });
        }
        throw new PdfSigningError({
          message: "Preparing the PDF signature failed.",
          cause: error,
        });
      }
    },
    {
      label: "pdf-signing.capture-digest",
      timeoutMs: PDF_SIGNING_PREPARE_TIMEOUT_MS,
    },
  );

  const digest = captured.at(0);
  if (digest === undefined) {
    throw new PdfSigningError({
      message: "LibPDF produced no signed attributes to sign.",
    });
  }
  return digest;
};

type ApplySignatureInvocation = SigningInvocation & {
  expectedDigestHex: string;
  signature: Uint8Array;
  /** Tried in order; empty signs without trusted time. */
  timestampAuthorities: readonly NamedTimestampAuthority[];
  /** Whether `certificateChain` reaches a self-signed root. */
  certificateChainComplete: boolean;
  /**
   * Certificates a timestamp's chain must reach for its time to count; see
   * `timestamp-trust.ts`. Empty: timestamps are embedded, never trusted.
   */
  timestampTrustAnchors: readonly Uint8Array[];
  revocationProvider?: TrackedRevocationProvider;
};

export type AppliedSignature = {
  bytes: Uint8Array;
  /** The level actually achieved, never the configured one. */
  level: PdfSigningLevel;
  /** The authority whose timestamp the signature carries. */
  timestampAuthorityUrl: string | null;
  /** What kept the signature below B-LT, and anything LibPDF noted. */
  warnings: PdfSigningWarning[];
};

export type PdfSigningWarning = { code: string; message: string };

const WARNING_LIMIT = 20;
const WARNING_MESSAGE_MAX_LENGTH = 500;

/** Warnings are stored with the version; keep what one version carries small. */
const boundWarnings = (warnings: readonly PdfSigningWarning[]) =>
  warnings.slice(0, WARNING_LIMIT).map(({ code, message }) => ({
    code: code.slice(0, 64),
    message: message.slice(0, WARNING_MESSAGE_MAX_LENGTH),
  }));

/**
 * LibPDF's own warnings, minus `MDP_VIOLATION`: it is raised for any
 * certified document, and phase 1 has already refused the certifications
 * that forbid a signature, so on what reaches here it is noise.
 */
const libpdfWarnings = (warnings: readonly SignWarning[]) =>
  warnings
    .filter(({ code }) => code !== "MDP_VIOLATION")
    .map(({ code, message }) => ({ code, message }));

/**
 * The level a timestamped signature reached. Time from an authority no
 * trust anchor vouches for is not trusted time, so such a signature is
 * B-B however much validation data it carries.
 */
const achievedLevel = ({
  longTermValidated,
  timestampTrusted,
}: {
  longTermValidated: boolean;
  timestampTrusted: boolean;
}): PdfSigningLevel => {
  if (!timestampTrusted) {
    return "B-B";
  }
  return longTermValidated ? "B-LT" : "B-T";
};

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Failures that only cost the timestamp: every authority failed, or a token
 * came back too large for the reservation phase 1 made.
 */
const isTimestampFailure = (error: unknown) =>
  PdfSigningTimestampUnavailableError.is(error) ||
  error instanceof PlaceholderError;

/**
 * Phase 2: the signed PDF. Throws {@link PdfSigningDigestMismatchError} when
 * LibPDF asks to sign anything other than what phase 1 published, so a
 * signature can never end up over bytes the desktop did not see.
 */
export const applySignature = async (
  invocation: ApplySignatureInvocation,
): Promise<AppliedSignature> => {
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

  const signOnce = async (trust: TrustOptions) => {
    const pdf = await PDF.load(invocation.basePdf);
    const fieldName = await prepareSignatureField(pdf, invocation);
    const { bytes, warnings } = await pdf.sign(
      buildSignOptions(invocation, signer, trust, fieldName),
    );
    return { bytes, pdf, warnings };
  };

  return await withTimeout(
    async () => {
      try {
        const warnings: PdfSigningWarning[] = [];
        const timestampAuthority = createFallbackTimestampAuthority(
          invocation.timestampAuthorities,
        );
        const provider =
          invocation.revocationProvider ?? createTrackedRevocationProvider();
        const signerChain = [
          invocation.certificate,
          ...invocation.certificateChain,
        ];
        // Gathered before anything is embedded: validation data is only
        // needed with trusted time, and a revocation it turns up must stop
        // the signature, not just be stored beside it. Phase 1 made the same
        // check before the PIN; this one covers the minutes in between.
        const signerRevocation =
          invocation.timestampAuthorities.length > 0
            ? await findRevokedCertificates({ provider, signerChain })
            : null;
        if (signerRevocation !== null && signerRevocation.revoked.length > 0) {
          throw new PdfSigningCertificateRevokedError({
            message: "A certificate of the signer's chain is revoked.",
          });
        }
        const timestamped =
          invocation.timestampAuthorities.length > 0
            ? await signOnce({ timestampAuthority }).catch((error: unknown) => {
                if (!isTimestampFailure(error)) {
                  throw error;
                }
                // The desktop's signature is already spent; a signature
                // without trusted time beats none, and the level and the
                // warning below say exactly what it lacks.
                warnings.push({
                  code: "TIMESTAMP_UNAVAILABLE",
                  message: describeError(error),
                });
                return null;
              })
            : null;
        const signed = timestamped ?? (await signOnce({}));
        warnings.push(...libpdfWarnings(signed.warnings));

        const timestamp = timestampAuthority.used();
        if (
          timestamped === null ||
          timestamp === null ||
          signerRevocation === null
        ) {
          return {
            bytes: signed.bytes,
            level: "B-B",
            timestampAuthorityUrl: null,
            warnings: boundWarnings(warnings),
          } satisfies AppliedSignature;
        }

        // The chain is phase 1's completed one, so what is left to gather is
        // revocation data; LibPDF reloaded `pdf` with the signed bytes, so
        // the store lands in one more incremental update after them.
        // The timestamp's own chain, completed like the signer's: what the
        // token carries, then its issuers' AIA URLs through the guard.
        const timestampIssuers = await completeCertificateChain({
          candidates: [
            ...timestamp.certificates,
            ...invocation.timestampTrustAnchors,
          ],
          certificate: timestamp.signerCertificate,
        });
        const timestampTrusted = await certificationPathReachesAnchor({
          anchors: invocation.timestampTrustAnchors,
          at: timestamp.genTime,
          chain: [timestamp.signerCertificate, ...timestampIssuers.chain],
        });
        const validation = await gatherValidationData({
          provider,
          signer: signerRevocation.material,
          signerChain,
          timestampChain: [
            timestamp.signerCertificate,
            ...timestampIssuers.chain,
          ],
        });
        if (!invocation.certificateChainComplete) {
          warnings.push({
            code: "CHAIN_INCOMPLETE",
            message:
              "The signer's certificate chain does not reach a root certificate.",
          });
        }
        if (!timestampTrusted) {
          warnings.push({
            code: "TIMESTAMP_UNTRUSTED",
            message:
              "The timestamp authority's chain reaches no configured trust anchor; its time is embedded but not relied on.",
          });
        }
        if (!timestampIssuers.complete) {
          warnings.push({
            code: "TIMESTAMP_CHAIN_INCOMPLETE",
            message:
              "The timestamp authority's certificate chain does not reach a root certificate.",
          });
        }
        if (validation.uncovered.length > 0) {
          warnings.push({
            code: "REVOCATION_UNAVAILABLE",
            message: `No revocation data for ${validation.uncovered.length} certificate(s) in the signer's or the timestamp authority's chain.`,
          });
        }
        return {
          bytes: await embedValidationData(signed.pdf, validation.material),
          level: achievedLevel({
            longTermValidated:
              invocation.certificateChainComplete &&
              timestampIssuers.complete &&
              validation.uncovered.length === 0,
            timestampTrusted,
          }),
          timestampAuthorityUrl: timestampAuthority.usedUrl(),
          warnings: boundWarnings(warnings),
        } satisfies AppliedSignature;
      } catch (error) {
        if (
          PdfSigningDigestMismatchError.is(error) ||
          PdfSigningCertificateRevokedError.is(error)
        ) {
          throw error;
        }
        throw new PdfSigningError({
          message: "Embedding the PDF signature failed.",
          cause: error,
        });
      }
    },
    {
      label: "pdf-signing.apply-signature",
      timeoutMs: PDF_SIGNING_APPLY_TIMEOUT_MS,
    },
  );
};
