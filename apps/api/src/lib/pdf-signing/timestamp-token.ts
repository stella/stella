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
import { TaggedError } from "better-result";
import * as pkijs from "pkijs";

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

const allowsTimeStamping = (certificate: pkijs.Certificate) => {
  const extension = certificate.extensions?.find(
    ({ extnID }) => extnID === EXTENDED_KEY_USAGE_OID,
  );
  if (extension === undefined) {
    return false;
  }
  try {
    return pkijs.ExtKeyUsage.fromBER(
      new Uint8Array(extension.extnValue.valueBlock.valueHexView),
    ).keyPurposes.includes(TIME_STAMPING_USAGE);
  } catch {
    return false;
  }
};

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
  const certificates = (signedData.certificates ?? []).filter(
    (entry) => entry instanceof pkijs.Certificate,
  );
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
) => {
  try {
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

    const verified = await engine.verifyWithPublicKey(
      signedBytes,
      signerInfo.signature,
      signer.subjectPublicKeyInfo,
      signerInfo.signatureAlgorithm,
      hashName,
    );
    return verified ? signer : null;
  } catch {
    return null;
  }
};

/** Throws {@link PdfSigningTimestampInvalidError} for any token it refuses. */
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
}): Promise<ValidatedTimestamp> => {
  let signedData: pkijs.SignedData;
  let tstInfo: pkijs.TSTInfo;
  let content: Uint8Array;
  try {
    const contentInfo = pkijs.ContentInfo.fromBER(new Uint8Array(token));
    if (contentInfo.contentType !== SIGNED_DATA_OID) {
      throw invalid("The timestamp is not a signed token.");
    }
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
    const encapsulated = signedData.encapContentInfo.eContent;
    if (
      signedData.encapContentInfo.eContentType !== TST_INFO_OID ||
      encapsulated === undefined
    ) {
      throw invalid("The timestamp token carries no timestamp.");
    }
    content = octetStringBytes(encapsulated);
    tstInfo = pkijs.TSTInfo.fromBER(content);
  } catch (error) {
    if (PdfSigningTimestampInvalidError.is(error)) {
      throw error;
    }
    throw invalid("The timestamp token could not be read.");
  }

  const imprint = tstInfo.messageImprint;
  if (
    imprint.hashAlgorithm.algorithmId !== SHA256_OID ||
    !Buffer.from(imprint.hashedMessage.valueBlock.valueHexView).equals(
      Buffer.from(digest),
    )
  ) {
    throw invalid(
      "The timestamp is about something other than this signature.",
    );
  }
  if (
    nonce !== undefined &&
    (tstInfo.nonce === undefined || !tstInfo.nonce.isEqual(nonce))
  ) {
    throw invalid("The timestamp does not answer this request.");
  }
  if (
    Math.abs(tstInfo.genTime.getTime() - now.getTime()) > MAX_GEN_TIME_SKEW_MS
  ) {
    throw invalid("The timestamp's time is not current.");
  }

  const signer = await verifiedSigner(signedData, content);
  if (signer === null) {
    throw invalid("The timestamp's signature does not verify.");
  }
  if (!allowsTimeStamping(signer)) {
    throw invalid("The timestamp was not signed by a timestamping key.");
  }

  return {
    certificates: (signedData.certificates ?? [])
      .filter((entry) => entry instanceof pkijs.Certificate)
      .map(derOf),
    genTime: tstInfo.genTime,
    signerCertificate: derOf(signer),
  };
};
