/**
 * Checking an RFC 3161 timestamp token before it is embedded or counted.
 *
 * A token is only trusted time for this signature if it is about this
 * signature (the message imprint is the hash of the signature value), fresh
 * (the nonce this request sent, a generation time near now), and issued by
 * a timestamping key (the CMS signature verifies against a certificate that
 * carries id-kp-timeStamping). Any other token is refused, and the caller
 * moves on to the next authority or signs without trusted time.
 */

import * as asn1js from "asn1js";
import { Result, TaggedError } from "better-result";
import * as pkijs from "pkijs";

import { carriedCertificates } from "@/api/lib/files/pdf-signing/certificate-chain";

/** RFC 5652 id-signedData. */
const SIGNED_DATA_OID = "1.2.840.113549.1.7.2";
/** RFC 3161 id-ct-TSTInfo. */
const TST_INFO_OID = "1.2.840.113549.1.9.16.1.4";
/** RFC 3161 2.3 id-kp-timeStamping. */
const TIME_STAMPING_USAGE = "1.3.6.1.5.5.7.3.8";
/** RFC 5280 id-ce-extKeyUsage. */
const EXTENDED_KEY_USAGE_OID = "2.5.29.37";
/** NIST id-sha256: the only imprint this pipeline asks for. */
const SHA256_OID = "2.16.840.1.101.3.4.2.1";
/** RFC 5652 id-messageDigest. */
const MESSAGE_DIGEST_OID = "1.2.840.113549.1.9.4";
const DER_SET_TAG = 0x31;
/** The token is requested right after signing; its time must be now. */
const MAX_GEN_TIME_SKEW_MS = 10 * 60 * 1000;

export class PdfSigningTimestampInvalidError extends TaggedError(
  "PdfSigningTimestampInvalidError",
)<{ message: string }> {}

export type ValidatedTimestamp = {
  /** Every certificate the token carries, DER. */
  certificates: Uint8Array[];
  genTime: Date;
  /** The certificate whose key signed the token, DER. */
  signerCertificate: Uint8Array;
};

const invalid = (message: string) =>
  new PdfSigningTimestampInvalidError({ message });

/**
 * RFC 3161 2.3: a timestamping certificate carries exactly one extended key
 * usage, id-kp-timeStamping, in an extension marked critical. A key that
 * may also do other things is not a timestamping key.
 */
const isTimeStampingKey = (certificate: pkijs.Certificate) => {
  const extension = certificate.extensions?.find(
    ({ extnID }) => extnID === EXTENDED_KEY_USAGE_OID,
  );
  if (extension === undefined || !extension.critical) {
    return false;
  }
  return Result.try(() => {
    const { keyPurposes } = pkijs.ExtKeyUsage.fromBER(
      new Uint8Array(extension.extnValue.valueBlock.valueHexView),
    );
    return keyPurposes.length === 1 && keyPurposes[0] === TIME_STAMPING_USAGE;
  }).unwrapOr(false);
};

const isValidAt = (certificate: pkijs.Certificate, at: Date) =>
  certificate.notBefore.value.getTime() <= at.getTime() &&
  at.getTime() <= certificate.notAfter.value.getTime();

/** An OCTET STRING's bytes, whether DER-primitive or BER-constructed. */
const octetStringBytes = (value: asn1js.OctetString): Uint8Array => {
  if (!value.idBlock.isConstructed) {
    return new Uint8Array(value.valueBlock.valueHexView);
  }
  return new Uint8Array(
    Buffer.concat(
      value.valueBlock.value.map((chunk) =>
        Buffer.from(
          chunk instanceof asn1js.OctetString
            ? octetStringBytes(chunk)
            : new Uint8Array(0),
        ),
      ),
    ),
  );
};

const derOf = (certificate: pkijs.Certificate) =>
  new Uint8Array(certificate.toSchema().toBER(false));

/** The certificate a SignerInfo names, by issuer and serial or by key id. */
const signerCertificateOf = async (
  signedData: pkijs.SignedData,
  signerInfo: pkijs.SignerInfo,
) => {
  const certificates = carriedCertificates(signedData.certificates);
  if (signerInfo.sid instanceof pkijs.IssuerAndSerialNumber) {
    const { issuer, serialNumber } = signerInfo.sid;
    return (
      certificates.find(
        (certificate) =>
          certificate.issuer.isEqual(issuer) &&
          certificate.serialNumber.isEqual(serialNumber),
      ) ?? null
    );
  }
  const keyId = Buffer.from(
    signerInfo.sid.idBlock.isConstructed
      ? signerInfo.sid.valueBlock.value[0].valueBlock.valueHexView
      : signerInfo.sid.valueBlock.valueHexView,
  );
  for (const certificate of certificates) {
    const hash = await crypto.subtle.digest(
      "SHA-1",
      certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView,
    );
    if (Buffer.from(hash).equals(keyId)) {
      return certificate;
    }
  }
  return null;
};

/**
 * Verify the token's CMS signature by hand. pkijs' own verifier insists on
 * the timestamped data itself for a TSTInfo, and only its hash is known
 * here (the imprint is checked separately against it).
 */
const verifiedSigner = async (
  signedData: pkijs.SignedData,
  content: Uint8Array,
): Promise<pkijs.Certificate | null> => {
  const verified = await Result.tryPromise(async () => {
    const signerInfo = signedData.signerInfos.at(0);
    if (signerInfo === undefined) {
      return null;
    }
    const signer = await signerCertificateOf(signedData, signerInfo);
    if (signer === null) {
      return null;
    }
    const engine = pkijs.getCrypto(true);
    const hashName = engine.getAlgorithmByOID(
      signerInfo.digestAlgorithm.algorithmId,
      true,
      "SignerInfo.digestAlgorithm",
    ).name;

    let signedBytes = content;
    const signedAttributes = signerInfo.signedAttrs;
    if (signedAttributes !== undefined) {
      // With signed attributes the signature covers them, and they bind the
      // content through its message digest.
      const messageDigest = signedAttributes.attributes.find(
        ({ type }) => type === MESSAGE_DIGEST_OID,
      )?.values[0];
      const contentHash = Buffer.from(
        await crypto.subtle.digest(hashName, content),
      );
      if (
        !(messageDigest instanceof asn1js.OctetString) ||
        !Buffer.from(messageDigest.valueBlock.valueHexView).equals(contentHash)
      ) {
        return null;
      }
      const encoded = new Uint8Array(signedAttributes.encodedValue.slice(0));
      // Signed as a SET OF, stored as [0] IMPLICIT (RFC 5652 5.4).
      encoded[0] = DER_SET_TAG;
      signedBytes = encoded;
    }

    const matches = await engine.verifyWithPublicKey(
      signedBytes,
      signerInfo.signature,
      signer.subjectPublicKeyInfo,
      signerInfo.signatureAlgorithm,
      hashName,
    );
    return matches ? signer : null;
  });
  return verified.unwrapOr(null);
};

type ReadToken = {
  content: Uint8Array;
  signedData: pkijs.SignedData;
  tstInfo: pkijs.TSTInfo;
};

const unreadable = () => invalid("The timestamp token could not be read.");

/** The token's SignedData and the TSTInfo it encapsulates. */
const readToken = (
  token: Uint8Array,
): Result<ReadToken, PdfSigningTimestampInvalidError> => {
  const contentInfo = Result.try(() =>
    pkijs.ContentInfo.fromBER(new Uint8Array(token)),
  );
  if (Result.isError(contentInfo)) {
    return Result.err(unreadable());
  }
  if (contentInfo.value.contentType !== SIGNED_DATA_OID) {
    return Result.err(invalid("The timestamp is not a signed token."));
  }
  const signedData = Result.try(
    () => new pkijs.SignedData({ schema: contentInfo.value.content }),
  );
  if (Result.isError(signedData)) {
    return Result.err(unreadable());
  }
  const encapsulated = signedData.value.encapContentInfo.eContent;
  if (
    signedData.value.encapContentInfo.eContentType !== TST_INFO_OID ||
    encapsulated === undefined
  ) {
    return Result.err(invalid("The timestamp token carries no timestamp."));
  }
  const decoded = Result.try(() => {
    const content = octetStringBytes(encapsulated);
    return { content, tstInfo: pkijs.TSTInfo.fromBER(content) };
  });
  if (Result.isError(decoded)) {
    return Result.err(unreadable());
  }
  return Result.ok({ ...decoded.value, signedData: signedData.value });
};

/** The token's contents, or {@link PdfSigningTimestampInvalidError}. */
export const validateTimestampToken = async ({
  digest,
  nonce,
  now,
  token,
}: {
  /** SHA-256 of the signature value the token must be about. */
  digest: Uint8Array;
  /** The nonce the request carried, when it carried one. */
  nonce?: asn1js.Integer;
  now: Date;
  token: Uint8Array;
}): Promise<Result<ValidatedTimestamp, PdfSigningTimestampInvalidError>> => {
  const read = readToken(token);
  if (Result.isError(read)) {
    return read;
  }
  const { content, signedData, tstInfo } = read.value;

  const imprint = tstInfo.messageImprint;
  if (
    imprint.hashAlgorithm.algorithmId !== SHA256_OID ||
    !Buffer.from(imprint.hashedMessage.valueBlock.valueHexView).equals(
      Buffer.from(digest),
    )
  ) {
    return Result.err(
      invalid("The timestamp is about something other than this signature."),
    );
  }
  if (
    nonce !== undefined &&
    (tstInfo.nonce === undefined || !tstInfo.nonce.isEqual(nonce))
  ) {
    return Result.err(invalid("The timestamp does not answer this request."));
  }
  if (
    Math.abs(tstInfo.genTime.getTime() - now.getTime()) > MAX_GEN_TIME_SKEW_MS
  ) {
    return Result.err(invalid("The timestamp's time is not current."));
  }

  const signer = await verifiedSigner(signedData, content);
  if (signer === null) {
    return Result.err(invalid("The timestamp's signature does not verify."));
  }
  if (!isTimeStampingKey(signer)) {
    return Result.err(
      invalid("The timestamp was not signed by a timestamping key."),
    );
  }
  if (!isValidAt(signer, tstInfo.genTime)) {
    return Result.err(
      invalid(
        "The timestamp's certificate was not valid at the time it claims.",
      ),
    );
  }

  return Result.ok({
    certificates: carriedCertificates(signedData.certificates).map(derOf),
    genTime: tstInfo.genTime,
    signerCertificate: derOf(signer),
  });
};
