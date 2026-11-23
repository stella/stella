import * as asn1js from "asn1js";
import { panic } from "better-result";
import * as pkijs from "pkijs";

import {
  CMS_DATA_OID,
  CMS_SIGNED_DATA_OID,
  SIGNED_DIGEST_ALGORITHMS,
  type SignedDigestAlgorithm,
} from "@/api/lib/files/cms-signed-data";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";

const CONTENT_TYPE_OID = "1.2.840.113549.1.9.3";
const SIGNING_TIME_OID = "1.2.840.113549.1.9.5";
const MESSAGE_DIGEST_OID = "1.2.840.113549.1.9.4";
const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";
export const FIXTURE_SIGNING_TIME = new Date("2026-03-02T09:30:00.000Z");
export const SIGNATURE_FIXTURE_SIGNERS = [
  "Example notary office",
  "Example court registry",
] as const;

const certificates = new Map<string, Promise<pkijs.Certificate>>();

/** A self-signed certificate naming the signer; nothing here is verified. */
const signerCertificate = async (commonName: string) => {
  let certificate = certificates.get(commonName);
  if (certificate === undefined) {
    certificate = createSelfSignedCertificate({ commonName, keyType: "EC" }).then(
      ({ der }) => pkijs.Certificate.fromBER(der),
    );
    certificates.set(commonName, certificate);
  }
  return await certificate;
};

const oidOf = (algorithm: SignedDigestAlgorithm) => {
  const found = Object.entries(SIGNED_DIGEST_ALGORITHMS).find(
    ([, name]) => name === algorithm,
  );
  return found?.[0] ?? panic(`Unknown digest algorithm ${algorithm}`);
};

export const digestOf = async (
  algorithm: SignedDigestAlgorithm,
  bytes: Uint8Array,
) => new Uint8Array(await crypto.subtle.digest(algorithm, bytes.slice()));

type DetachedCmsOptions = {
  digestAlgorithm?: SignedDigestAlgorithm;
  signers?: readonly string[];
  /** Overrides the digest the signer states, to model a changed file. */
  statedDigest?: Uint8Array;
  attached?: boolean;
};

/**
 * A CMS SignedData over `content` whose signers state a messageDigest, the
 * shape of a `.p7s` beside its signed file. The signature values are
 * placeholders: readers report signers and digests, never validity.
 */
export const detachedCms = async (
  content: Uint8Array,
  {
    digestAlgorithm = "SHA-256",
    signers = [SIGNATURE_FIXTURE_SIGNERS[0]],
    statedDigest,
    attached = false,
  }: DetachedCmsOptions = {},
) => {
  const digest = statedDigest ?? (await digestOf(digestAlgorithm, content));
  const digestAlgorithmIdentifier = new pkijs.AlgorithmIdentifier({
    algorithmId: oidOf(digestAlgorithm),
  });
  const signerCertificates = await Promise.all(signers.map(signerCertificate));
  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [digestAlgorithmIdentifier],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: CMS_DATA_OID,
      ...(attached
        ? { eContent: new asn1js.OctetString({ valueHex: content.slice() }) }
        : {}),
    }),
    certificates: signerCertificates,
    signerInfos: signerCertificates.map(
      (certificate) =>
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: certificate.issuer,
            serialNumber: certificate.serialNumber,
          }),
          digestAlgorithm: digestAlgorithmIdentifier,
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({
                type: CONTENT_TYPE_OID,
                values: [new asn1js.ObjectIdentifier({ value: CMS_DATA_OID })],
              }),
              new pkijs.Attribute({
                type: SIGNING_TIME_OID,
                values: [new asn1js.UTCTime({ valueDate: FIXTURE_SIGNING_TIME })],
              }),
              new pkijs.Attribute({
                type: MESSAGE_DIGEST_OID,
                values: [new asn1js.OctetString({ valueHex: digest.slice() })],
              }),
            ],
          }),
          signatureAlgorithm: new pkijs.AlgorithmIdentifier({
            algorithmId: RSA_ENCRYPTION_OID,
          }),
          signature: new asn1js.OctetString({ valueHex: new Uint8Array(64) }),
        }),
    ),
  });
  return new Uint8Array(
    new pkijs.ContentInfo({
      contentType: CMS_SIGNED_DATA_OID,
      content: signedData.toSchema(true),
    })
      .toSchema()
      .toBER(false),
  );
};

export const pemArmored = (der: Uint8Array, label = "PKCS7") => {
  const body = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/gu, "$1\n");
  return new TextEncoder().encode(
    `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`,
  );
};

const DS = "http://www.w3.org/2000/09/xmldsig#";
const XADES = "http://uri.etsi.org/01903/v1.3.2#";
const SHA256_METHOD = "http://www.w3.org/2001/04/xmlenc#sha256";

/** The base64 DER of the certificate the fixtures embed for `commonName`. */
export const certificateBase64 = async (commonName: string) =>
  Buffer.from(
    (await signerCertificate(commonName)).toSchema().toBER(false),
  ).toString("base64");

const signatureXml = async ({
  id,
  signer,
  references,
  objects = "",
}: {
  id: string;
  signer: string;
  references: string;
  objects?: string;
}) => `<ds:Signature xmlns:ds="${DS}" Id="${id}">
  <ds:SignedInfo>
    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>
    <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
    ${references}
    <ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${id}-props">
      <ds:DigestMethod Algorithm="${SHA256_METHOD}"/>
      <ds:DigestValue>AAAA</ds:DigestValue>
    </ds:Reference>
  </ds:SignedInfo>
  <ds:SignatureValue>AAAA</ds:SignatureValue>
  <ds:KeyInfo><ds:X509Data><ds:X509Certificate>${await certificateBase64(signer)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
  <ds:Object>
    <xades:QualifyingProperties xmlns:xades="${XADES}" Target="#${id}">
      <xades:SignedProperties Id="${id}-props">
        <xades:SignedSignatureProperties>
          <xades:SigningTime>${FIXTURE_SIGNING_TIME.toISOString()}</xades:SigningTime>
        </xades:SignedSignatureProperties>
      </xades:SignedProperties>
    </xades:QualifyingProperties>
  </ds:Object>
  ${objects}
</ds:Signature>`;

const digestReference = async (uri: string, content: Uint8Array) =>
  `<ds:Reference URI="${uri}">
      <ds:DigestMethod Algorithm="${SHA256_METHOD}"/>
      <ds:DigestValue>${Buffer.from(await digestOf("SHA-256", content)).toString("base64")}</ds:DigestValue>
    </ds:Reference>`;

const xmlBytes = (xml: string) =>
  new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);

/** An XAdES signature carrying `content` in base64, as ePUAP filings do. */
export const envelopingXades = async (
  content: Uint8Array,
  {
    signer = SIGNATURE_FIXTURE_SIGNERS[0],
    mimeType = "application/pdf",
  }: { signer?: string; mimeType?: string } = {},
) =>
  xmlBytes(
    await signatureXml({
      id: "signature-1",
      signer,
      references: await digestReference("#document", content),
      objects: `<ds:Object Id="document" MimeType="${mimeType}" Encoding="http://www.w3.org/2000/09/xmldsig#base64">${Buffer.from(content).toString("base64").replace(/(.{76})/gu, "$1\n")}</ds:Object>`,
    }),
  );

/** An XAdES signature naming a file beside it and stating its SHA-256. */
export const detachedXades = async (
  fileName: string,
  content: Uint8Array,
  {
    signer = SIGNATURE_FIXTURE_SIGNERS[0],
    transformed = false,
  }: { signer?: string; transformed?: boolean } = {},
) =>
  xmlBytes(
    await signatureXml({
      id: "signature-1",
      signer,
      references: transformed
        ? `<ds:Reference URI="${encodeURIComponent(fileName)}">
      <ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></ds:Transforms>
      <ds:DigestMethod Algorithm="${SHA256_METHOD}"/>
      <ds:DigestValue>${Buffer.from(await digestOf("SHA-256", content)).toString("base64")}</ds:DigestValue>
    </ds:Reference>`
        : await digestReference(encodeURIComponent(fileName), content),
    }),
  );

/** A signed XML document holding its own XAdES signature. */
export const envelopedXades = async (
  documentXml: string,
  { signer = SIGNATURE_FIXTURE_SIGNERS[1] }: { signer?: string } = {},
) => {
  const signature = await signatureXml({
    id: "signature-1",
    signer,
    references: `<ds:Reference URI="">
      <ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></ds:Transforms>
      <ds:DigestMethod Algorithm="${SHA256_METHOD}"/>
      <ds:DigestValue>AAAA</ds:DigestValue>
    </ds:Reference>`,
  });
  const closing = documentXml.lastIndexOf("</");
  return xmlBytes(
    `${documentXml.slice(0, closing)}${signature}${documentXml.slice(closing)}`,
  );
};
