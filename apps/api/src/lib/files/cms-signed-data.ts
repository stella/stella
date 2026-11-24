import * as asn1js from "asn1js";
import { Result } from "better-result";
import * as pkijs from "pkijs";

export const CMS_DATA_OID = "1.2.840.113549.1.7.1";
export const CMS_SIGNED_DATA_OID = "1.2.840.113549.1.7.2";
const SIGNING_TIME_OID = "1.2.840.113549.1.9.5";
const MESSAGE_DIGEST_OID = "1.2.840.113549.1.9.4";
const SUBJECT_KEY_IDENTIFIER_OID = "2.5.29.14";
const COMMON_NAME_OID = "2.5.4.3";
const ORGANIZATION_NAME_OID = "2.5.4.10";
const MAX_NAME_LENGTH = 4096;

/** Digest algorithms a signature may state for the bytes it covers. */
export const SIGNED_DIGEST_ALGORITHMS = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.4": "SHA-224",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
} as const;

export type SignedDigestAlgorithm =
  (typeof SIGNED_DIGEST_ALGORITHMS)[keyof typeof SIGNED_DIGEST_ALGORITHMS];

/** The digest a signature states for the bytes it covers; never checked here. */
export type StatedDigest = {
  algorithm: SignedDigestAlgorithm;
  hex: string;
};

type CmsSigner = {
  /** Stable within one parse: the layer id and the SignerInfo position. */
  id: string;
  name: string | null;
  issuerName: string | null;
  serialNumber: string | null;
  signedAt: string | null;
  /** The signed messageDigest attribute, when the signer states one. */
  messageDigest: StatedDigest | null;
};

type CmsSignedData = {
  id: string;
  contentType: string;
  content: Uint8Array;
  signers: CmsSigner[];
};

type CmsSignature = {
  id: string;
  contentType: string;
  /** The encapsulated content, or null when the signature is detached. */
  content: Uint8Array | null;
  signers: CmsSigner[];
};

type CmsFailure = "not_signed_data" | "unsupported_content" | "detached";

const hex = (bytes: Uint8Array | ArrayBuffer) =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString("hex");

const DIGEST_BYTE_LENGTHS = {
  "SHA-1": 20,
  "SHA-224": 28,
  "SHA-256": 32,
  "SHA-384": 48,
  "SHA-512": 64,
} as const satisfies Record<SignedDigestAlgorithm, number>;

/**
 * A stated digest, or null when its length is not the algorithm's: such a
 * value is malformed metadata, never evidence that the signed bytes changed.
 */
export const statedDigestOf = (
  algorithm: SignedDigestAlgorithm,
  bytes: Uint8Array,
): StatedDigest | null =>
  bytes.byteLength === DIGEST_BYTE_LENGTHS[algorithm]
    ? { algorithm, hex: hex(bytes) }
    : null;

const octetParts = (
  value: asn1js.OctetString,
  parts: Uint8Array[],
): boolean => {
  if (!value.idBlock.isConstructed) {
    parts.push(value.valueBlock.valueHexView);
    return true;
  }
  for (const segment of value.valueBlock.value) {
    if (
      !(segment instanceof asn1js.OctetString) ||
      !octetParts(segment, parts)
    ) {
      return false;
    }
  }
  return true;
};

const octetStringBytes = (value: asn1js.OctetString) => {
  const parts: Uint8Array[] = [];
  return octetParts(value, parts) ? Buffer.concat(parts) : null;
};

const isSignedDigestAlgorithm = (
  oid: string,
): oid is keyof typeof SIGNED_DIGEST_ALGORITHMS =>
  Object.hasOwn(SIGNED_DIGEST_ALGORITHMS, oid);

/** A digest algorithm by OID, or null for one a signature may not state here. */
const signedDigestAlgorithm = (oid: string): SignedDigestAlgorithm | null =>
  isSignedDigestAlgorithm(oid) ? SIGNED_DIGEST_ALGORITHMS[oid] : null;

/** A certificate name's display form: its common name, else its organization. */
export const nameAttribute = (name: pkijs.RelativeDistinguishedNames) => {
  const value = (oid: string) => {
    const attribute: unknown = name.typesAndValues.find(
      ({ type }) => type === oid,
    )?.value;
    return attribute instanceof asn1js.Utf8String ||
      attribute instanceof asn1js.PrintableString ||
      attribute instanceof asn1js.TeletexString ||
      attribute instanceof asn1js.UniversalString ||
      attribute instanceof asn1js.BmpString
      ? attribute.getValue()
      : undefined;
  };
  const text = value(COMMON_NAME_OID) ?? value(ORGANIZATION_NAME_OID);
  return text === undefined ? null : signerDisplayName(text);
};

/** A stated signer name as one bounded line of display text. */
export const signerDisplayName = (text: string) => {
  const head = text.slice(0, 2 * MAX_NAME_LENGTH);
  const singleLine = Array.from(head, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return singleLine.slice(0, MAX_NAME_LENGTH) || null;
};

const signingTime = (signer: pkijs.SignerInfo) => {
  const attributes = signer.signedAttrs?.attributes.filter(
    ({ type }) => type === SIGNING_TIME_OID,
  );
  const attribute = attributes?.length === 1 ? attributes[0] : undefined;
  const value: unknown =
    attribute?.values.length === 1 ? attribute.values[0] : undefined;
  if (
    value instanceof asn1js.UTCTime ||
    value instanceof asn1js.GeneralizedTime
  ) {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
};

const messageDigest = (signer: pkijs.SignerInfo): StatedDigest | null => {
  const algorithm = signedDigestAlgorithm(signer.digestAlgorithm.algorithmId);
  const attributes = signer.signedAttrs?.attributes.filter(
    ({ type }) => type === MESSAGE_DIGEST_OID,
  );
  const attribute = attributes?.length === 1 ? attributes[0] : undefined;
  const value: unknown =
    attribute?.values.length === 1 ? attribute.values[0] : undefined;
  if (algorithm === null || !(value instanceof asn1js.OctetString)) {
    return null;
  }
  const bytes = octetStringBytes(value);
  return bytes ? statedDigestOf(algorithm, bytes) : null;
};

/**
 * The name a DER certificate states for its subject, unverified. Null when
 * the bytes are not one certificate or name neither a person nor an
 * organization.
 */
export const certificateSubjectName = (der: Uint8Array): string | null => {
  const parsed = Result.try(() => {
    const { offset, result } = asn1js.fromBER(der);
    return offset === der.byteLength && offset > 0
      ? new pkijs.Certificate({ schema: result })
      : null;
  });
  return parsed.isOk() && parsed.value !== null
    ? nameAttribute(parsed.value.subject)
    : null;
};

const issuerAndSerialKey = (
  issuer: pkijs.RelativeDistinguishedNames,
  serialNumber: asn1js.Integer,
) =>
  // Keep RDN boundaries, which PKI.js's flattened attributes lose.
  `issuer:${hex(issuer.valueBeforeDecode)}:${hex(serialNumber.valueBlock.valueHexView)}`;

const signerKey = (sid: unknown) => {
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    return issuerAndSerialKey(sid.issuer, sid.serialNumber);
  }
  if (
    sid instanceof asn1js.Primitive &&
    sid.idBlock.tagClass === 3 &&
    sid.idBlock.tagNumber === 0
  ) {
    const bytes = sid.valueBlock.valueHexView;
    return bytes.byteLength > 0 ? `key:${hex(bytes)}` : null;
  }
  if (
    sid instanceof asn1js.Constructed &&
    sid.idBlock.tagClass === 3 &&
    sid.idBlock.tagNumber === 0
  ) {
    // BER may encode an implicitly tagged OCTET STRING in segments.
    const parts: Uint8Array[] = [];
    for (const segment of sid.valueBlock.value) {
      if (
        !(segment instanceof asn1js.OctetString) ||
        !octetParts(segment, parts)
      ) {
        return null;
      }
    }
    const bytes = Buffer.concat(parts);
    return bytes.byteLength > 0 ? `key:${hex(bytes)}` : null;
  }
  return null;
};

const certificateSubjectKey = (certificate: pkijs.Certificate) => {
  const extensions = certificate.extensions?.filter(
    ({ extnID }) => extnID === SUBJECT_KEY_IDENTIFIER_OID,
  );
  const identifier = extensions?.at(0);
  if (identifier === undefined || extensions?.length !== 1) {
    return null;
  }
  const extension = identifier.extnValue.valueBlock.valueHexView;
  const parsed = Result.try(() => asn1js.fromBER(extension));
  if (parsed.isErr() || parsed.value.offset !== extension.byteLength) {
    return null;
  }
  const value = parsed.value.result;
  if (!(value instanceof asn1js.OctetString)) {
    return null;
  }
  const bytes = octetStringBytes(value);
  return bytes && bytes.byteLength > 0 ? `key:${hex(bytes)}` : null;
};

const readSigners = (
  signedData: pkijs.SignedData,
  layerId: string,
): CmsSigner[] => {
  const certificates = new Map<string, pkijs.Certificate | null>();
  if (signedData.certificates !== undefined) {
    for (const certificate of signedData.certificates) {
      if (!(certificate instanceof pkijs.Certificate)) {
        continue;
      }
      for (const key of [
        issuerAndSerialKey(certificate.issuer, certificate.serialNumber),
        certificateSubjectKey(certificate),
      ]) {
        if (key !== null) {
          certificates.set(key, certificates.has(key) ? null : certificate);
        }
      }
    }
  }
  return signedData.signerInfos.map((signer, position) => {
    const sid: unknown = signer.sid;
    const key = signerKey(sid);
    const certificate = key === null ? undefined : certificates.get(key);
    const serialNumber =
      certificate?.serialNumber ??
      (sid instanceof pkijs.IssuerAndSerialNumber ? sid.serialNumber : null);
    return {
      // Issuer and serial number can repeat within a layer, so the position
      // in the immutable SignerInfo set is what tells signers apart.
      id: `${layerId}.signer-${position}`,
      name: certificate ? nameAttribute(certificate.subject) : null,
      issuerName: certificate ? nameAttribute(certificate.issuer) : null,
      serialNumber: serialNumber
        ? hex(serialNumber.valueBlock.valueHexView)
        : null,
      signedAt: signingTime(signer),
      messageDigest: messageDigest(signer),
    };
  });
};

/** Checks the ContentInfo OID before decoding an arbitrary embedded document. */
export const hasCmsSignedDataHeader = (bytes: Uint8Array) => {
  const rootLength = bytes.at(1);
  if (bytes.at(0) !== 0x30 || rootLength === undefined) {
    return false;
  }
  const lengthOctets = rootLength > 0x80 ? rootLength - 0x80 : 0;
  const oidOffset = 2 + lengthOctets;
  const oid = Result.try(() =>
    asn1js.fromBER(bytes.subarray(oidOffset, oidOffset + 32)),
  );
  return (
    oid.isOk() &&
    oid.value.offset > 0 &&
    oid.value.result instanceof asn1js.ObjectIdentifier &&
    oid.value.result.valueBlock.toString() === CMS_SIGNED_DATA_OID
  );
};

/** The id of the outermost SignedData layer; nested layers extend its path. */
export const OUTER_CMS_LAYER_ID = "layer-0";

const decodeSignedData = (bytes: Uint8Array) =>
  // asn1js can throw on certain malformed strings, and pkijs throws on schema mismatch.
  Result.try(() => {
    const { offset, result } = asn1js.fromBER(bytes, {
      maxContentLength: bytes.byteLength,
    });
    if (offset !== bytes.byteLength || offset <= 0) {
      return null;
    }
    const contentInfo = new pkijs.ContentInfo({ schema: result });
    return contentInfo.contentType === CMS_SIGNED_DATA_OID
      ? new pkijs.SignedData({ schema: contentInfo.content })
      : null;
  });

/**
 * The stated signers of a CMS signature, attached or detached, such as an
 * external `.p7s` signature beside the document it signs. Not verified.
 */
export const readCmsSigners = (
  bytes: Uint8Array,
  layerId: string,
): Result<CmsSigner[], "not_signed_data"> => {
  const decoded = decodeSignedData(bytes);
  return decoded.isErr() || decoded.value === null
    ? Result.err("not_signed_data")
    : Result.ok(readSigners(decoded.value, layerId));
};

/**
 * The stated signers of a SignedData whose content travels beside it, as in
 * an S/MIME `multipart/signed` signature part. Nothing is verified.
 */
export const readDetachedCmsSigners = (
  bytes: Uint8Array,
): Result<CmsSigner[], "not_signed_data" | "not_detached"> => {
  const decoded = decodeSignedData(bytes);
  if (decoded.isErr() || decoded.value === null) {
    return Result.err("not_signed_data");
  }
  // A SignedData that carries its own content is a signed document, such as
  // an attached .p7m, not a signature over the message beside it.
  if (decoded.value.encapContentInfo.eContent !== undefined) {
    return Result.err("not_detached");
  }
  return Result.ok(readSigners(decoded.value, OUTER_CMS_LAYER_ID));
};

/**
 * Reads one SignedData layer and its stated signers without verifying any
 * signature. A detached signature has no content; the caller decides whether
 * that is acceptable.
 */
export const readCmsSignature = (
  bytes: Uint8Array,
  layerId: string = OUTER_CMS_LAYER_ID,
): Result<CmsSignature, Exclude<CmsFailure, "detached">> => {
  const decoded = decodeSignedData(bytes);
  if (decoded.isErr() || decoded.value === null) {
    return Result.err("not_signed_data");
  }
  const { eContent, eContentType } = decoded.value.encapContentInfo;
  let content: Uint8Array | null = null;
  if (eContent !== undefined) {
    if (!(eContent instanceof asn1js.OctetString)) {
      return Result.err("unsupported_content");
    }
    content = octetStringBytes(eContent);
    if (content === null) {
      return Result.err("unsupported_content");
    }
  }
  return Result.ok({
    id: layerId,
    contentType: eContentType,
    content,
    signers: readSigners(decoded.value, layerId),
  });
};

/** Extracts CMS content and stated signer metadata without verifying signatures. */
export const readCmsSignedData = (
  bytes: Uint8Array,
  layerId: string = OUTER_CMS_LAYER_ID,
): Result<CmsSignedData, CmsFailure> => {
  const signature = readCmsSignature(bytes, layerId);
  if (signature.isErr()) {
    return Result.err(signature.error);
  }
  const { content, ...layer } = signature.value;
  return content === null
    ? Result.err("detached")
    : Result.ok({ ...layer, content });
};
