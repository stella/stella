import * as asn1js from "asn1js";
import { Result } from "better-result";
import * as pkijs from "pkijs";

export const CMS_DATA_OID = "1.2.840.113549.1.7.1";
export const CMS_SIGNED_DATA_OID = "1.2.840.113549.1.7.2";
const SIGNING_TIME_OID = "1.2.840.113549.1.9.5";
const SUBJECT_KEY_IDENTIFIER_OID = "2.5.29.14";
const COMMON_NAME_OID = "2.5.4.3";
const ORGANIZATION_NAME_OID = "2.5.4.10";
const MAX_NAME_LENGTH = 4096;

type CmsSigner = {
  name: string | null;
  issuerName: string | null;
  serialNumber: string | null;
  signedAt: string | null;
};

type CmsSignedData = {
  contentType: string;
  content: Uint8Array;
  signers: CmsSigner[];
};

type CmsFailure = "not_signed_data" | "unsupported_content" | "detached";

const hex = (bytes: Uint8Array | ArrayBuffer) =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString("hex");

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

const nameAttribute = (name: pkijs.RelativeDistinguishedNames) => {
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
  if (text === undefined) {
    return null;
  }
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

const readSigners = (signedData: pkijs.SignedData): CmsSigner[] => {
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
  return signedData.signerInfos.map((signer) => {
    const sid: unknown = signer.sid;
    const key = signerKey(sid);
    const certificate = key === null ? undefined : certificates.get(key);
    const serialNumber =
      certificate?.serialNumber ??
      (sid instanceof pkijs.IssuerAndSerialNumber ? sid.serialNumber : null);
    return {
      name: certificate ? nameAttribute(certificate.subject) : null,
      issuerName: certificate ? nameAttribute(certificate.issuer) : null,
      serialNumber: serialNumber
        ? hex(serialNumber.valueBlock.valueHexView)
        : null,
      signedAt: signingTime(signer),
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

/** Extracts CMS content and stated signer metadata without verifying signatures. */
export const readCmsSignedData = (
  bytes: Uint8Array,
): Result<CmsSignedData, CmsFailure> => {
  // asn1js can throw on certain malformed strings, and pkijs throws on schema mismatch.
  const decoded = Result.try(() => {
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
  if (decoded.isErr() || decoded.value === null) {
    return Result.err("not_signed_data");
  }
  const { eContent, eContentType } = decoded.value.encapContentInfo;
  if (eContent === undefined) {
    return Result.err("detached");
  }
  if (!(eContent instanceof asn1js.OctetString)) {
    return Result.err("unsupported_content");
  }
  const content = octetStringBytes(eContent);
  if (content === null) {
    return Result.err("unsupported_content");
  }
  return Result.ok({
    contentType: eContentType,
    content,
    signers: readSigners(decoded.value),
  });
};
