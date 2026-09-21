/**
 * What the API is willing to sign with.
 *
 * The desktop picks an identity out of a keychain the API cannot see, so the
 * certificate it posts is untrusted input: it is parsed here, and the key
 * family that drives CMS construction is read off the certificate rather than
 * taken from the client's word for it. A certificate outside its validity
 * window, or one whose key usage does not permit signing, is refused before
 * any signing work starts.
 */

import * as pkijs from "pkijs";

import type { PdfSigningKeyType } from "@/api/db/schema";

/** RFC 8017 rsaEncryption. */
const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";
/** RFC 5480 id-ecPublicKey. */
const EC_PUBLIC_KEY_OID = "1.2.840.10045.2.1";
/** RFC 5280 id-ce-keyUsage. */
const KEY_USAGE_OID = "2.5.29.15";

const DER_BIT_STRING_TAG = 0x03;
const DIGITAL_SIGNATURE_BIT_VALUE = 0x80;
const NON_REPUDIATION_BIT_VALUE = 0x40;

/** CMS signature algorithm implied by the certificate's key family. */
const SIGNATURE_ALGORITHM_FOR_KEY_TYPE = {
  RSA: "RSASSA-PKCS1-v1_5",
  EC: "ECDSA",
} as const satisfies Record<PdfSigningKeyType, string>;

export type PdfSigningSignatureAlgorithm =
  (typeof SIGNATURE_ALGORITHM_FOR_KEY_TYPE)[PdfSigningKeyType];

type SigningCertificateRejection =
  | "malformed"
  | "unsupported_key_type"
  | "not_yet_valid"
  | "expired"
  | "key_usage_forbids_signing";

export type SigningCertificateInspection =
  | { status: "rejected"; reason: SigningCertificateRejection }
  | {
      status: "accepted";
      keyType: PdfSigningKeyType;
      signatureAlgorithm: PdfSigningSignatureAlgorithm;
      sha256Hex: string;
    };

const keyTypeForAlgorithmOid = (oid: string): PdfSigningKeyType | null => {
  if (oid === RSA_ENCRYPTION_OID) {
    return "RSA";
  }
  if (oid === EC_PUBLIC_KEY_OID) {
    return "EC";
  }
  return null;
};

/**
 * Whether a KeyUsage extension permits signing, read straight off its DER.
 *
 * `extnValue` holds exactly one `BIT STRING` (RFC 5280 4.2.1.3) whose first
 * content byte carries digitalSignature (bit 0) and nonRepudiation (bit 1).
 * pkijs exposes a loosely typed `parsedValue` for the same data; reading the
 * two bits off the fixed encoding keeps the check total and typed. A `false`
 * return also covers an extension that is not a well-formed BIT STRING and
 * the zero-length one an all-clear KeyUsage encodes as, both of which permit
 * nothing.
 */
const keyUsagePermitsSigning = (extnValue: Uint8Array): boolean => {
  const [tag, length, unusedBits, firstByte] = extnValue;
  if (
    tag !== DER_BIT_STRING_TAG ||
    length === undefined ||
    length < 1 ||
    length > extnValue.length - 2 ||
    unusedBits === undefined ||
    unusedBits > 7 ||
    firstByte === undefined
  ) {
    return false;
  }
  const digitalSignature = firstByte >= DIGITAL_SIGNATURE_BIT_VALUE;
  const nonRepudiation =
    firstByte % DIGITAL_SIGNATURE_BIT_VALUE >= NON_REPUDIATION_BIT_VALUE;
  return digitalSignature || nonRepudiation;
};

export const inspectSigningCertificate = (
  der: Uint8Array,
  now: Date,
): SigningCertificateInspection => {
  let certificate: pkijs.Certificate;
  try {
    // Copy onto a plain ArrayBuffer: the web tsconfig types `der` as
    // `Uint8Array<ArrayBufferLike>`, which pkijs's `BufferSource` rejects.
    certificate = pkijs.Certificate.fromBER(new Uint8Array(der));
  } catch {
    return { status: "rejected", reason: "malformed" };
  }

  const keyType = keyTypeForAlgorithmOid(
    certificate.subjectPublicKeyInfo.algorithm.algorithmId,
  );
  if (keyType === null) {
    return { status: "rejected", reason: "unsupported_key_type" };
  }

  if (now < certificate.notBefore.value) {
    return { status: "rejected", reason: "not_yet_valid" };
  }
  if (now > certificate.notAfter.value) {
    return { status: "rejected", reason: "expired" };
  }

  // No KeyUsage extension means the certificate is unconstrained (RFC 5280
  // 4.2.1.3), so signing is permitted. A present extension must allow it.
  const keyUsage = certificate.extensions?.find(
    (extension) => extension.extnID === KEY_USAGE_OID,
  );
  if (
    keyUsage &&
    !keyUsagePermitsSigning(keyUsage.extnValue.valueBlock.valueHexView)
  ) {
    return { status: "rejected", reason: "key_usage_forbids_signing" };
  }

  return {
    status: "accepted",
    keyType,
    signatureAlgorithm: SIGNATURE_ALGORITHM_FOR_KEY_TYPE[keyType],
    sha256Hex: new Bun.CryptoHasher("sha256").update(der).digest("hex"),
  };
};
