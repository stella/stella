/**
 * Synthetic `.zfo` files: message XML in the system's shape, wrapped in a CMS
 * SignedData sealed by a throwaway certificate. Every name, box ID and number
 * is invented.
 */
import { PDF } from "@libpdf/core";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

import { sha256Bytes } from "@stll/sha256/bun";

import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";

const ID_DATA = "1.2.840.113549.1.7.1";
const ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const ID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const ID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const ID_SIGNING_TIME = "1.2.840.113549.1.9.5";

export const SEAL_COMMON_NAME = "Test data-box seal";
export const SEAL_SIGNED_AT = new Date("2026-10-14T07:12:40.000Z");

export type FixtureFile = {
  name: string;
  mimeType: string;
  content: Uint8Array;
};

export type FixtureMessage = {
  messageId: string;
  messageType: string;
  senderBoxId: string;
  senderName: string;
  recipientBoxId: string;
  recipientName: string;
  annotation: string;
  senderRefNumber: string;
  senderIdent: string;
  recipientRefNumber: string;
  recipientIdent: string;
  toHands: string;
  personalDelivery: string;
  allowSubstDelivery: string;
  deliveryTime: string;
  acceptanceTime: string;
  messageStatus: string;
  files: FixtureFile[];
};

const decisionPdf = PDF.create();
decisionPdf.addPage();

export const FIXTURE_MESSAGE: FixtureMessage = {
  messageId: "1234567890",
  messageType: "V",
  senderBoxId: "ABC2DEF",
  senderName: "Okresní soud v Testově",
  recipientBoxId: "xyz9876",
  recipientName: "Advokátní kancelář Příklad",
  annotation: "Usnesení o nařízení jednání",
  senderRefNumber: "12 C 345/2026-17",
  senderIdent: "12 C 345/2026",
  recipientRefNumber: "2026/014",
  recipientIdent: "",
  toHands: "Mgr. Jana Testová",
  personalDelivery: "true",
  allowSubstDelivery: "false",
  deliveryTime: "2026-10-14T09:12:33.120+02:00",
  acceptanceTime: "2026-10-14T10:03:00+02:00",
  messageStatus: "6",
  files: [
    {
      name: "usneseni.pdf",
      mimeType: "application/pdf",
      content: await decisionPdf.save(),
    },
    {
      name: "pouceni.txt",
      mimeType: "text/plain",
      content: new TextEncoder().encode("Synthetic instructions."),
    },
  ],
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const element = (name: string, value: string) =>
  value === ""
    ? `<p:${name} xsi:nil="true"/>`
    : `<p:${name}>${escapeXml(value)}</p:${name}>`;

const fileXml = ({ name, mimeType, content }: FixtureFile) =>
  `<p:dmFile dmMimeType="${escapeXml(mimeType)}" dmFileMetaType="main" dmFileDescr="${escapeXml(name)}"><p:dmEncodedContent>${Buffer.from(content).toString("base64")}</p:dmEncodedContent></p:dmFile>`;

/** The message XML a `.zfo` file seals. */
export const messageXml = (message: FixtureMessage = FIXTURE_MESSAGE) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<q:MessageDownloadResponse xmlns:q="http://isds.czechpoint.cz/v20/message" xmlns:p="http://isds.czechpoint.cz/v20" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<q:dmReturnedMessage dmType="${escapeXml(message.messageType)}">`,
    "<p:dmDm>",
    element("dmID", message.messageId),
    element("dbIDSender", message.senderBoxId),
    element("dmSender", message.senderName),
    element("dmSenderAddress", "Testovací 1, 100 00 Testov"),
    element("dmSenderType", "10"),
    element("dmRecipient", message.recipientName),
    element("dmRecipientAddress", "Příkladná 2, 100 00 Testov"),
    element("dbIDRecipient", message.recipientBoxId),
    element("dmToHands", message.toHands),
    element("dmAnnotation", message.annotation),
    element("dmRecipientRefNumber", message.recipientRefNumber),
    element("dmSenderRefNumber", message.senderRefNumber),
    element("dmRecipientIdent", message.recipientIdent),
    element("dmSenderIdent", message.senderIdent),
    element("dmPersonalDelivery", message.personalDelivery),
    element("dmAllowSubstDelivery", message.allowSubstDelivery),
    `<p:dmFiles>${message.files.map(fileXml).join("")}</p:dmFiles>`,
    "</p:dmDm>",
    '<q:dmHash algorithm="SHA-256">AAAA</q:dmHash>',
    element("dmDeliveryTime", message.deliveryTime).replaceAll("p:", "q:"),
    element("dmAcceptanceTime", message.acceptanceTime).replaceAll("p:", "q:"),
    element("dmMessageStatus", message.messageStatus).replaceAll("p:", "q:"),
    "</q:dmReturnedMessage>",
    "</q:MessageDownloadResponse>",
  ].join("");

let sealCertificate: ReturnType<typeof createSelfSignedCertificate> | null =
  null;

type SealContentOptions = {
  certificateCommonName?: string;
  signedAt?: Date;
};

/** Seals `content` the way an exported file is sealed: DER CMS SignedData. */
export const sealContent = async (
  content: Uint8Array,
  {
    certificateCommonName = SEAL_COMMON_NAME,
    signedAt = SEAL_SIGNED_AT,
  }: SealContentOptions = {},
) => {
  const seal =
    certificateCommonName === SEAL_COMMON_NAME
      ? (sealCertificate ??= createSelfSignedCertificate({
          commonName: certificateCommonName,
        }))
      : createSelfSignedCertificate({ commonName: certificateCommonName });
  const certificateMaterial = await seal;
  const certificate = pkijs.Certificate.fromBER(certificateMaterial.der);
  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: ID_DATA,
    }),
    certificates: [certificate],
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: certificate.issuer,
          serialNumber: certificate.serialNumber,
        }),
      }),
    ],
  });
  signedData.encapContentInfo.eContent = new asn1js.OctetString({
    valueHex: content,
  });
  const signerInfo = signedData.signerInfos.at(0);
  if (signerInfo !== undefined) {
    signerInfo.signedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new pkijs.Attribute({
          type: ID_CONTENT_TYPE,
          values: [new asn1js.ObjectIdentifier({ value: ID_DATA })],
        }),
        new pkijs.Attribute({
          type: ID_MESSAGE_DIGEST,
          values: [
            new asn1js.OctetString({
              valueHex: new Uint8Array(sha256Bytes(content)),
            }),
          ],
        }),
        new pkijs.Attribute({
          type: ID_SIGNING_TIME,
          values: [new asn1js.UTCTime({ valueDate: signedAt })],
        }),
      ],
    });
  }
  await signedData.sign(certificateMaterial.privateKey, 0, "SHA-256");
  return new Uint8Array(
    new pkijs.ContentInfo({
      contentType: ID_SIGNED_DATA,
      content: signedData.toSchema(true),
    })
      .toSchema()
      .toBER(false),
  );
};

/** A complete synthetic `.zfo` file. */
export const zfoFile = async (overrides: Partial<FixtureMessage> = {}) =>
  await sealContent(
    new TextEncoder().encode(messageXml({ ...FIXTURE_MESSAGE, ...overrides })),
  );
