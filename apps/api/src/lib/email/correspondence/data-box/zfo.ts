/**
 * Reads a data-box (ISDS) message exported as a `.zfo` file: a DER CMS
 * SignedData whose encapsulated content is the message XML. The envelope and
 * the base64 files come from that XML; the seal's signer and signing time are
 * read as found and never verified.
 *
 * Pure and synchronous: the sandboxed extraction worker imports it too.
 */
import * as asn1js from "asn1js";
import { Result, TaggedError } from "better-result";
import * as pkijs from "pkijs";
import { type Element, parseXmlDocument } from "slimdom";
import * as v from "valibot";

import { CORRESPONDENCE_MAX_ATTACHMENTS } from "@stll/api-contract/correspondence";
import {
  DATA_BOX_ID_PATTERN,
  DATA_BOX_MESSAGE_ID_PATTERN,
  DATA_BOX_MESSAGE_STATUSES,
  type DataBoxParty,
  type DataBoxSeal,
  type DataBoxStatedEnvelope,
} from "@stll/api-contract/data-box";
import { numberFromString } from "@stll/api-contract/http-input";
import { declareFingerprintFields } from "@stll/errors";

import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

const SIGNED_DATA_OID = "1.2.840.113549.1.7.2";
const SIGNING_TIME_OID = "1.2.840.113549.1.9.5";
const COMMON_NAME_OID = "2.5.4.3";
const ORGANIZATION_NAME_OID = "2.5.4.10";
const ISDS_NAMESPACE_PREFIX = "http://isds.czechpoint.cz/";

export const DATA_BOX_MESSAGE_LIMITS = {
  /** A `.zfo` is a matter document, so the document upload limit bounds it. */
  maxFileBytes: FILE_SIZE_LIMIT_BYTES.document,
  maxFiles: CORRESPONDENCE_MAX_ATTACHMENTS,
  /** Markup count, a cheap bound on the element tree a parse may build. */
  maxMarkup: 20_000,
  maxFieldCharacters: 4096,
} as const;

type DataBoxMessageLimits = Record<
  keyof typeof DATA_BOX_MESSAGE_LIMITS,
  number
>;

const DATA_BOX_PARSE_FAILURES = [
  "too_large",
  "not_signed_data",
  "malformed_xml",
  "not_a_message",
  "invalid_envelope",
  "too_many_files",
  "invalid_file",
] as const;
type DataBoxParseFailure = (typeof DATA_BOX_PARSE_FAILURES)[number];

export class DataBoxMessageParseError extends TaggedError(
  "DataBoxMessageParseError",
)<{
  message: string;
  reason: DataBoxParseFailure;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const failure = (reason: DataBoxParseFailure, message: string) =>
  Result.err(new DataBoxMessageParseError({ reason, message }));

type DataBoxFile = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type ParsedDataBoxMessage = {
  annotation: string;
  envelope: DataBoxStatedEnvelope;
  files: DataBoxFile[];
};

type SignedContent = { content: Uint8Array; seal: DataBoxSeal };

const UNREAD_SEAL = {
  status: "unverified",
  signerName: null,
  issuerName: null,
  serialNumber: null,
  signedAt: null,
} as const satisfies DataBoxSeal;

// A constructed OCTET STRING (BER) carries its value in segments.
const octetStringBytes = (value: asn1js.OctetString): Uint8Array => {
  if (!value.idBlock.isConstructed) {
    return value.valueBlock.valueHexView.slice();
  }
  const parts: Uint8Array[] = [];
  for (const segment of value.valueBlock.value) {
    if (!(segment instanceof asn1js.OctetString)) {
      return new Uint8Array();
    }
    parts.push(octetStringBytes(segment));
  }
  return new Uint8Array(Buffer.concat(parts));
};

const nameAttribute = (name: pkijs.RelativeDistinguishedNames) => {
  const value = (oid: string) =>
    name.typesAndValues
      .find((attribute) => attribute.type === oid)
      ?.value.getValue() ?? null;
  return boundedText(value(COMMON_NAME_OID) ?? value(ORGANIZATION_NAME_OID));
};

const signingTime = (signerInfo: pkijs.SignerInfo | undefined) => {
  const attribute = signerInfo?.signedAttrs?.attributes.find(
    ({ type }) => type === SIGNING_TIME_OID,
  );
  const value: unknown = attribute?.values.at(0);
  if (
    value instanceof asn1js.UTCTime ||
    value instanceof asn1js.GeneralizedTime
  ) {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
};

const readSeal = (signedData: pkijs.SignedData): DataBoxSeal => {
  const signerInfo = signedData.signerInfos.at(0);
  const sid: unknown = signerInfo?.sid;
  const serialNumber =
    sid instanceof pkijs.IssuerAndSerialNumber
      ? Buffer.from(sid.serialNumber.valueBlock.valueHexView).toString("hex")
      : null;
  const certificate =
    signedData.certificates?.find(
      (candidate): candidate is pkijs.Certificate =>
        candidate instanceof pkijs.Certificate &&
        (serialNumber === null ||
          Buffer.from(candidate.serialNumber.valueBlock.valueHexView).toString(
            "hex",
          ) === serialNumber),
    ) ?? null;
  return {
    status: "unverified",
    signerName:
      certificate === null ? null : nameAttribute(certificate.subject),
    issuerName: certificate === null ? null : nameAttribute(certificate.issuer),
    serialNumber,
    signedAt: signingTime(signerInfo),
  };
};

const unwrapSignedData = (
  bytes: Uint8Array,
): Result<SignedContent, DataBoxMessageParseError> => {
  // asn1js throws on some malformed string bodies instead of reporting them.
  const decoded = Result.try(() => asn1js.fromBER(bytes));
  if (decoded.isErr() || decoded.value.offset === -1) {
    return failure("not_signed_data", "The file is not DER data");
  }
  const { result: schema } = decoded.value;
  const read = Result.try(() => {
    const contentInfo = new pkijs.ContentInfo({ schema });
    if (contentInfo.contentType !== SIGNED_DATA_OID) {
      return null;
    }
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    const eContent = signedData.encapContentInfo.eContent;
    if (!(eContent instanceof asn1js.OctetString)) {
      return null;
    }
    // The seal is optional provenance: an unreadable one never fails the
    // message.
    const seal = Result.try(() => readSeal(signedData));
    return {
      content: octetStringBytes(eContent),
      seal: seal.isOk() ? seal.value : UNREAD_SEAL,
    };
  });
  if (read.isErr() || read.value === null) {
    return failure("not_signed_data", "The file is not a CMS SignedData");
  }
  if (read.value.content.byteLength === 0) {
    return failure("not_signed_data", "The signed content is empty");
  }
  return Result.ok(read.value);
};

const isIsdsElement = (element: Element, localName: string) =>
  element.localName === localName &&
  (element.namespaceURI?.startsWith(ISDS_NAMESPACE_PREFIX) ?? false);

const child = (element: Element, localName: string) =>
  element.children.find((candidate) => isIsdsElement(candidate, localName));

// A field is one line of text: control characters read as spaces.
const isControlCharacter = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
};

const boundedText = (value: string | null | undefined) => {
  // Only a bounded head of the field is read.
  const head = (value ?? "").slice(
    0,
    2 * DATA_BOX_MESSAGE_LIMITS.maxFieldCharacters,
  );
  const text = Array.from(head, (character) =>
    isControlCharacter(character) ? " " : character,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) {
    return null;
  }
  return text.slice(0, DATA_BOX_MESSAGE_LIMITS.maxFieldCharacters);
};

const fieldText = (element: Element, localName: string) => {
  const field = child(element, localName);
  return field === undefined ? null : boundedText(field.textContent);
};

const BOOLEAN_TEXT: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["1", true],
  ["false", false],
  ["0", false],
]);

const fieldBoolean = (element: Element, localName: string) =>
  BOOLEAN_TEXT.get(fieldText(element, localName)?.toLowerCase() ?? "") ?? null;

// Only an explicitly zoned timestamp names an instant.
const ZONED_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const fieldTimestamp = (element: Element, localName: string) => {
  const text = fieldText(element, localName);
  if (text === null || !ZONED_TIMESTAMP.test(text)) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const statusCodeSchema = numberFromString(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(DATA_BOX_MESSAGE_STATUSES.length),
  ),
);

const fieldStatus = (element: Element) => {
  const text = fieldText(element, "dmMessageStatus");
  if (text === null || !/^\d{1,2}$/u.test(text)) {
    return null;
  }
  const code = v.safeParse(statusCodeSchema, text);
  return code.success
    ? (DATA_BOX_MESSAGE_STATUSES.at(code.output - 1) ?? null)
    : null;
};

const boxId = (element: Element, localName: string) => {
  const text = fieldText(element, localName)?.toLowerCase() ?? null;
  return text !== null && DATA_BOX_ID_PATTERN.test(text) ? text : null;
};

type PartyFields = {
  boxId: string;
  name: string;
  address: string;
  referenceNumber: string;
  fileMark: string;
};

const party = (dm: Element, fields: PartyFields): DataBoxParty | null => {
  const id = boxId(dm, fields.boxId);
  if (id === null) {
    return null;
  }
  return {
    boxId: id,
    name: fieldText(dm, fields.name),
    address: fieldText(dm, fields.address),
    referenceNumber: fieldText(dm, fields.referenceNumber),
    fileMark: fieldText(dm, fields.fileMark),
  };
};

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const FALLBACK_MEDIA_TYPE = "application/octet-stream";

const readFiles = (
  dm: Element,
  limits: DataBoxMessageLimits,
): Result<DataBoxFile[], DataBoxMessageParseError> => {
  const container = child(dm, "dmFiles");
  const entries =
    container === undefined
      ? []
      : container.children.filter((element) =>
          isIsdsElement(element, "dmFile"),
        );
  if (entries.length > limits.maxFiles) {
    return failure("too_many_files", "The message has too many files");
  }
  const files: DataBoxFile[] = [];
  for (const [index, entry] of entries.entries()) {
    const encoded = child(entry, "dmEncodedContent");
    if (encoded === undefined) {
      return failure("invalid_file", "A file has no encoded content");
    }
    const base64 = (encoded.textContent ?? "").replace(/\s+/gu, "");
    if (!BASE64.test(base64) || base64.length % 4 !== 0) {
      return failure("invalid_file", "A file's content is not base64");
    }
    const mediaType = (entry.getAttribute("dmMimeType") ?? "")
      .trim()
      .toLowerCase();
    files.push({
      fileName:
        boundedText(entry.getAttribute("dmFileDescr")) ??
        `attachment-${index + 1}`,
      mimeType: MEDIA_TYPE.test(mediaType) ? mediaType : FALLBACK_MEDIA_TYPE,
      bytes: new Uint8Array(Buffer.from(base64, "base64")),
    });
  }
  return Result.ok(files);
};

const MESSAGE_TYPE = /^[A-Z]$/u;
// Neither the system nor its clients emit a document type declaration; one
// can only bring entity definitions this reader has no use for.
const DOCUMENT_TYPE_DECLARATION = /<!doctype|<!entity/iu;

const findMessage = (root: Element): Element | null => {
  if (isIsdsElement(root, "dmReturnedMessage")) {
    return root;
  }
  for (const element of root.children) {
    if (isIsdsElement(element, "dmReturnedMessage")) {
      return element;
    }
  }
  return null;
};

const readMessageXml = (
  { content, seal }: SignedContent,
  limits: DataBoxMessageLimits,
): Result<ParsedDataBoxMessage, DataBoxMessageParseError> => {
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(content),
  );
  if (decoded.isErr()) {
    return failure("malformed_xml", "The message is not UTF-8 text");
  }
  const xml = decoded.value;
  if (DOCUMENT_TYPE_DECLARATION.test(xml)) {
    return failure("malformed_xml", "The message declares a document type");
  }
  let markup = 0;
  for (let index = xml.indexOf("<"); index !== -1;) {
    markup += 1;
    if (markup > limits.maxMarkup) {
      return failure("malformed_xml", "The message has too much markup");
    }
    index = xml.indexOf("<", index + 1);
  }
  const document = Result.try(() => parseXmlDocument(xml));
  const root = document.isOk() ? document.value.documentElement : null;
  if (root === null) {
    return failure("malformed_xml", "The message is not well-formed XML");
  }
  const message = findMessage(root);
  if (message === null) {
    return failure("not_a_message", "The file holds no data-box message");
  }
  const dm = child(message, "dmDm");
  if (dm === undefined) {
    return failure("not_a_message", "The message has no envelope");
  }
  const messageId = fieldText(dm, "dmID");
  const sender = party(dm, {
    boxId: "dbIDSender",
    name: "dmSender",
    address: "dmSenderAddress",
    referenceNumber: "dmSenderRefNumber",
    fileMark: "dmSenderIdent",
  });
  const recipient = party(dm, {
    boxId: "dbIDRecipient",
    name: "dmRecipient",
    address: "dmRecipientAddress",
    referenceNumber: "dmRecipientRefNumber",
    fileMark: "dmRecipientIdent",
  });
  if (
    messageId === null ||
    !DATA_BOX_MESSAGE_ID_PATTERN.test(messageId) ||
    sender === null ||
    recipient === null
  ) {
    return failure("invalid_envelope", "The envelope lacks required fields");
  }
  const files = readFiles(dm, limits);
  if (files.isErr()) {
    return files;
  }
  const messageType = boundedText(message.getAttribute("dmType"));
  return Result.ok({
    annotation: fieldText(dm, "dmAnnotation") ?? "",
    envelope: {
      messageId,
      messageType:
        messageType !== null && MESSAGE_TYPE.test(messageType)
          ? messageType
          : null,
      sender,
      recipient,
      toHands: fieldText(dm, "dmToHands"),
      personalDelivery: fieldBoolean(dm, "dmPersonalDelivery"),
      substituteDelivery: fieldBoolean(dm, "dmAllowSubstDelivery"),
      deliveredAt: fieldTimestamp(message, "dmDeliveryTime"),
      acceptedAt: fieldTimestamp(message, "dmAcceptanceTime"),
      status: fieldStatus(message),
      seal,
    },
    files: files.value,
  });
};

/** Reads one exported message. Never touches the network. */
export const parseDataBoxMessage = (
  bytes: Uint8Array,
  limits: DataBoxMessageLimits = DATA_BOX_MESSAGE_LIMITS,
): Result<ParsedDataBoxMessage, DataBoxMessageParseError> => {
  if (bytes.byteLength > limits.maxFileBytes) {
    return failure("too_large", "The file exceeds the size limit");
  }
  const signed = unwrapSignedData(bytes);
  if (signed.isErr()) {
    return signed;
  }
  return readMessageXml(signed.value, limits);
};

/** The searchable text of a message: its envelope and file names. */
export const dataBoxMessageText = ({
  annotation,
  envelope,
  files,
}: ParsedDataBoxMessage): string =>
  [
    annotation,
    [envelope.sender.name, envelope.sender.boxId].filter(Boolean).join(" "),
    [envelope.recipient.name, envelope.recipient.boxId]
      .filter(Boolean)
      .join(" "),
    envelope.sender.referenceNumber,
    envelope.sender.fileMark,
    envelope.recipient.referenceNumber,
    envelope.recipient.fileMark,
    envelope.toHands,
    envelope.messageId,
    ...files.map((file) => file.fileName),
  ]
    .filter((line) => line !== null && line !== "")
    .join("\n");
