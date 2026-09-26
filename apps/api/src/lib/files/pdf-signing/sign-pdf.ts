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

import { PDF, PdfArray, PdfString, PlaceholderError } from "@libpdf/core";
import type {
  DigestAlgorithm,
  Signer,
  SignWarning,
  TimestampAuthority,
} from "@libpdf/core";
import { panic, Result, TaggedError } from "better-result";

import type { PdfSigningKeyType } from "@/api/db/schema";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { isSignedPdf } from "@/api/lib/files/pdf-signatures";
import type { PdfSigningSignatureAlgorithm } from "@/api/lib/files/pdf-signing/certificate";
import {
  certificationPathReachesAnchor,
  completeCertificateChain,
} from "@/api/lib/files/pdf-signing/certificate-chain";
import { readDocMdpPermission } from "@/api/lib/files/pdf-signing/doc-mdp";
import { settleForLibpdf } from "@/api/lib/files/pdf-signing/libpdf-callbacks";
import { createTrackedRevocationProvider } from "@/api/lib/files/pdf-signing/revocation";
import type { TrackedRevocationProvider } from "@/api/lib/files/pdf-signing/revocation";
import {
  addSignatureStamp,
  certificateSubjectName,
  PdfSigningStampError,
  stampLines,
} from "@/api/lib/files/pdf-signing/stamp";
import type { SignatureStamp } from "@/api/lib/files/pdf-signing/stamp";
import { loadStampFont } from "@/api/lib/files/pdf-signing/stamp-font";
import {
  createFallbackTimestampAuthority,
  PdfSigningTimestampUnavailableError,
} from "@/api/lib/files/pdf-signing/timestamp-authority";
import type { NamedTimestampAuthority } from "@/api/lib/files/pdf-signing/timestamp-authority";
import {
  embedValidationData,
  findRevokedCertificates,
  gatherValidationData,
} from "@/api/lib/files/pdf-signing/validation-data";
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

/**
 * The document carries a certification that permits no changes, so any
 * signature appended to it would break the certification.
 */
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

/** The length of a file identifier LibPDF would mint itself. */
const FILE_IDENTIFIER_BYTES = 16;

/**
 * Give a document without a trailer /ID one derived from its bytes. Saving
 * needs an /ID, and LibPDF mints a random one when there is none; that
 * would make each phase's prepared bytes, and so the digest, differ.
 */
const pinFileIdentifier = (pdf: PDF, source: Uint8Array) => {
  const { trailer } = pdf.context.info;
  const existing = trailer.getArray("ID");
  if (
    existing !== undefined &&
    existing.length >= 2 &&
    existing.at(0) instanceof PdfString &&
    existing.at(1) instanceof PdfString
  ) {
    return;
  }
  const identifier = new Uint8Array(
    new Bun.CryptoHasher("sha256")
      .update(source)
      .digest()
      .subarray(0, FILE_IDENTIFIER_BYTES),
  );
  trailer.set(
    "ID",
    new PdfArray([
      PdfString.fromBytes(identifier),
      PdfString.fromBytes(identifier),
    ]),
  );
};

/**
 * Put the stamp's field on the page, when there is one, and name the field
 * to sign into. Runs on a freshly loaded document in both phases; the stamp
 * is built from persisted inputs only, so both produce the same bytes.
 */
const prepareSignatureField = async (
  pdf: PDF,
  invocation: SigningInvocation,
): Promise<Result<string | undefined, PdfSigningStampError>> =>
  invocation.stamp === null
    ? Result.ok(undefined)
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

export type CaptureSigningDigestError =
  | PdfSigningCertifiedDocumentError
  | PdfSigningError
  | PdfSigningPlaceholderTooSmallError
  | PdfSigningStampError
  | PdfSigningWouldBreakSignaturesError
  | TimeoutError;

/** What phase 1 reports for a failure that is none of its own refusals. */
const captureFailure = (cause: unknown): CaptureSigningDigestError => {
  if (
    TimeoutError.is(cause) ||
    PdfSigningStampError.is(cause) ||
    PdfSigningPlaceholderTooSmallError.is(cause)
  ) {
    return cause;
  }
  if (cause instanceof PlaceholderError) {
    return new PdfSigningPlaceholderTooSmallError({
      message: "The signature would not fit the space reserved for it.",
      availableBytes: cause.availableSize,
      requiredBytes: cause.requiredSize,
    });
  }
  return new PdfSigningError({
    message: "Preparing the PDF signature failed.",
    cause,
  });
};

/**
 * Phase 1: the CMS signed attributes and their SHA-256, which is what the
 * desktop's keychain key signs. `reserveTimestamp` sizes the stand-in
 * signature for a phase 2 that will add a timestamp token.
 */
export const captureSigningDigest = async (
  invocation: SigningInvocation & { reserveTimestamp: boolean },
): Promise<Result<CapturedSigningDigest, CaptureSigningDigestError>> => {
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

  const prepare = async (): Promise<
    Result<void, CaptureSigningDigestError>
  > => {
    const pdf = await PDF.load(invocation.basePdf);
    // Checked here, before any digest exists, so the desktop never asks for
    // a PIN on a document the signature would invalidate.
    // A signature is appended as a new revision; where LibPDF would rewrite
    // the file instead (a linearized or repaired file), existing signatures
    // would no longer cover their bytes.
    if (
      isSignedPdf({ pdf, source: invocation.basePdf }) &&
      pdf.canSaveIncrementally() !== null
    ) {
      return Result.err(
        new PdfSigningWouldBreakSignaturesError({
          message:
            "Signing this PDF would invalidate the signatures it already carries.",
        }),
      );
    }
    if (readDocMdpPermission({ pdf, source: invocation.basePdf }) === 1) {
      return Result.err(
        new PdfSigningCertifiedDocumentError({
          message:
            "This PDF is certified and its certification forbids changes.",
        }),
      );
    }
    pinFileIdentifier(pdf, invocation.basePdf);
    const fieldName = await prepareSignatureField(pdf, invocation);
    if (Result.isError(fieldName)) {
      return fieldName;
    }
    await pdf.sign(buildSignOptions(invocation, signer, {}, fieldName.value));
    return Result.ok(undefined);
  };

  const prepared = await Result.tryPromise({
    try: async () =>
      await withTimeout(prepare, {
        label: "pdf-signing.capture-digest",
        timeoutMs: PDF_SIGNING_PREPARE_TIMEOUT_MS,
      }),
    catch: captureFailure,
  });
  const settled = Result.isError(prepared) ? prepared : prepared.value;
  if (Result.isError(settled)) {
    return settled;
  }

  const digest = captured.at(0);
  if (digest === undefined) {
    return Result.err(
      new PdfSigningError({
        message: "LibPDF produced no signed attributes to sign.",
      }),
    );
  }
  return Result.ok(digest);
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

export type ApplySignatureError =
  | PdfSigningCertificateRevokedError
  | PdfSigningDigestMismatchError
  | PdfSigningError
  | TimeoutError;

/**
 * What phase 2 reports for a failure: its own refusals and running out of
 * time as they are, anything else as the embedding having failed.
 */
const embeddingFailure = (cause: unknown): ApplySignatureError =>
  TimeoutError.is(cause) ||
  PdfSigningDigestMismatchError.is(cause) ||
  PdfSigningCertificateRevokedError.is(cause) ||
  PdfSigningError.is(cause)
    ? cause
    : new PdfSigningError({
        message: "Embedding the PDF signature failed.",
        cause,
      });

type SignedOnce = { bytes: Uint8Array; pdf: PDF; warnings: SignWarning[] };

/**
 * Phase 2: the signed PDF. Refuses with {@link PdfSigningDigestMismatchError}
 * when LibPDF asks to sign anything other than what phase 1 published, so a
 * signature can never end up over bytes the desktop did not see.
 */
export const applySignature = async (
  invocation: ApplySignatureInvocation,
): Promise<Result<AppliedSignature, ApplySignatureError>> => {
  const matchingSignature = async (
    data: Uint8Array,
  ): Promise<Result<Uint8Array, PdfSigningDigestMismatchError>> =>
    (await signedAttributesDigestHex(data)) === invocation.expectedDigestHex
      ? Result.ok(invocation.signature)
      : Result.err(
          new PdfSigningDigestMismatchError({
            message:
              "The prepared signature no longer matches this document. Start signing again.",
          }),
        );
  const signer: Signer = {
    certificate: invocation.certificate,
    certificateChain: invocation.certificateChain,
    keyType: invocation.keyType,
    signatureAlgorithm: invocation.signatureAlgorithm,
    sign: async (data) => await settleForLibpdf(matchingSignature(data)),
  };

  /** One LibPDF pass; what it rejects with is the caller's to classify. */
  const signOnce = async (
    trust: TrustOptions,
  ): Promise<Result<SignedOnce, unknown>> => {
    const passed = await Result.tryPromise({
      try: async (): Promise<Result<SignedOnce, PdfSigningStampError>> => {
        const pdf = await PDF.load(invocation.basePdf);
        pinFileIdentifier(pdf, invocation.basePdf);
        const fieldName = await prepareSignatureField(pdf, invocation);
        if (Result.isError(fieldName)) {
          return fieldName;
        }
        const { bytes, warnings } = await pdf.sign(
          buildSignOptions(invocation, signer, trust, fieldName.value),
        );
        return Result.ok({ bytes, pdf, warnings });
      },
      catch: (cause) => cause,
    });
    return Result.isError(passed) ? passed : passed.value;
  };

  const embed = async (): Promise<
    Result<AppliedSignature, ApplySignatureError>
  > => {
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
      return Result.err(
        new PdfSigningCertificateRevokedError({
          message: "A certificate of the signer's chain is revoked.",
        }),
      );
    }
    let timestamped: SignedOnce | null = null;
    if (invocation.timestampAuthorities.length > 0) {
      const attempt = await signOnce({ timestampAuthority });
      if (Result.isOk(attempt)) {
        timestamped = attempt.value;
      } else if (isTimestampFailure(attempt.error)) {
        // The desktop's signature is already spent; a signature without
        // trusted time beats none, and the level and the warning below
        // say exactly what it lacks.
        warnings.push({
          code: "TIMESTAMP_UNAVAILABLE",
          message: describeError(attempt.error),
        });
      } else {
        return Result.err(embeddingFailure(attempt.error));
      }
    }
    const untimestamped = timestamped === null ? await signOnce({}) : null;
    if (untimestamped !== null && Result.isError(untimestamped)) {
      return Result.err(embeddingFailure(untimestamped.error));
    }
    const signed = timestamped ?? untimestamped?.value;
    if (signed === undefined) {
      return panic("a signing pass produced neither a result nor an error");
    }
    warnings.push(...libpdfWarnings(signed.warnings));

    const timestamp = timestampAuthority.used();
    if (
      timestamped === null ||
      timestamp === null ||
      signerRevocation === null
    ) {
      return Result.ok({
        bytes: signed.bytes,
        level: "B-B",
        timestampAuthorityUrl: null,
        warnings: boundWarnings(warnings),
      } satisfies AppliedSignature);
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
      timestampChain: [timestamp.signerCertificate, ...timestampIssuers.chain],
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
    const embedded = await embedValidationData(signed.pdf, validation.material);
    if (Result.isError(embedded)) {
      return Result.err(embeddingFailure(embedded.error));
    }
    return Result.ok({
      bytes: embedded.value,
      level: achievedLevel({
        longTermValidated:
          invocation.certificateChainComplete &&
          timestampIssuers.complete &&
          validation.uncovered.length === 0,
        timestampTrusted,
      }),
      timestampAuthorityUrl: timestampAuthority.usedUrl(),
      warnings: boundWarnings(warnings),
    } satisfies AppliedSignature);
  };

  const applied = await Result.tryPromise({
    try: async () =>
      await withTimeout(embed, {
        label: "pdf-signing.apply-signature",
        timeoutMs: PDF_SIGNING_APPLY_TIMEOUT_MS,
      }),
    catch: embeddingFailure,
  });
  return Result.isError(applied) ? applied : applied.value;
};
