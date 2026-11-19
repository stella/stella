/**
 * Reads ISDS messages and delivery receipts exported as `.zfo` files: CMS
 * SignedData whose encapsulated content is the message XML. The envelope and
 * the base64 files come from that XML; the seal's signer and signing time are
 * read as found and never verified.
 *
 * Pure and synchronous: the sandboxed extraction worker imports it too.
 */
import * as asn1js from "asn1js";
import { Result, TaggedError } from "better-result";
import * as pkijs from "pkijs";
import {
  type Element,
  parseXmlDocument,
  serializeToWellFormedString,
} from "slimdom";
import * as v from "valibot";

import { apiDateTimeSchema, isApiDate } from "@stll/api-contract/api-date";
import { CORRESPONDENCE_MAX_ATTACHMENTS } from "@stll/api-contract/correspondence";
import {
  DATA_BOX_MESSAGE_ID_PATTERN,
  DATA_BOX_MESSAGE_STATUSES,
  type DataBoxDeliveryEvent,
  type DataBoxParty,
  type DataBoxSeal,
  type DataBoxStatedEnvelope,
  STORED_DATA_BOX_ID_PATTERN,
} from "@stll/api-contract/data-box";
import { numberFromString } from "@stll/api-contract/http-input";
import { declareFingerprintFields } from "@stll/errors";

import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

import type {
  DataBoxMessageMetadata,
  DataBoxReceipt,
} from "./preview-contract";

const SIGNED_DATA_OID = "1.2.840.113549.1.7.2";
const SIGNING_TIME_OID = "1.2.840.113549.1.9.5";
const COMMON_NAME_OID = "2.5.4.3";
const ORGANIZATION_NAME_OID = "2.5.4.10";
const ISDS_NAMESPACE_PREFIXES = [
  "http://isds.czechpoint.cz/",
  "http://isds.czebox.cz/",
];

export const DATA_BOX_MESSAGE_LIMITS = {
  /** A `.zfo` is a matter document, so the document upload limit bounds it. */
  maxFileBytes: FILE_SIZE_LIMIT_BYTES.document,
  maxFiles: CORRESPONDENCE_MAX_ATTACHMENTS,
  /** Delivery events in one receipt; a real receipt lists a handful. */
  maxEvents: 100,
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
  "too_many_events",
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

type DataBoxFile = DataBoxMessageMetadata["files"][number] & {
  bytes: Uint8Array;
};
export type ParsedDataBoxMessage = Omit<DataBoxMessageMetadata, "files"> & {
  files: DataBoxFile[];
};
export type ParsedDataBoxDocument = ParsedDataBoxMessage | DataBoxReceipt;

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
  ISDS_NAMESPACE_PREFIXES.some((prefix) =>
    element.namespaceURI?.startsWith(prefix),
  );

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

// ISDS timestamps name instants. Date alone normalizes an impossible local
// calendar day into the following month, changing the stated delivery date.
const readTimestamp = (text: string | null) => {
  if (
    !text ||
    !v.is(apiDateTimeSchema, text) ||
    !isApiDate(text.slice(0, 10))
  ) {
    return null;
  }
  return new Date(text).toISOString();
};

const fieldTimestamp = (element: Element, localName: string) =>
  readTimestamp(fieldText(element, localName));

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
  return text !== null && STORED_DATA_BOX_ID_PATTERN.test(text) ? text : null;
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

const readFileBytes = (
  entry: Element,
): Result<Uint8Array, DataBoxMessageParseError> => {
  const encoded = child(entry, "dmEncodedContent");
  const inlineXml = child(entry, "dmXMLContent");
  if (encoded !== undefined && inlineXml === undefined) {
    const base64 = (encoded.textContent ?? "").replace(/\s+/gu, "");
    return BASE64.test(base64) && base64.length % 4 === 0
      ? Result.ok(new Uint8Array(Buffer.from(base64, "base64")))
      : failure("invalid_file", "A file's content is not base64");
  }
  // Legacy ISDS exports carry XML fragments, including multiple or zero
  // elements. The serialized fragment is a derivative of the signed XML.
  if (encoded === undefined && inlineXml !== undefined) {
    const serialized = Result.try(() =>
      inlineXml.childNodes
        .map((node) => serializeToWellFormedString(node))
        .join(""),
    );
    if (serialized.isOk()) {
      return Result.ok(new TextEncoder().encode(serialized.value));
    }
  }
  return failure("invalid_file", "A file has no recognizable content");
};

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
    const bytes = readFileBytes(entry);
    if (bytes.isErr()) {
      return bytes;
    }
    const mediaType = (entry.getAttribute("dmMimeType") ?? "")
      .trim()
      .toLowerCase();
    files.push({
      fileName:
        boundedText(entry.getAttribute("dmFileDescr")) ??
        `attachment-${index + 1}`,
      mimeType: MEDIA_TYPE.test(mediaType) ? mediaType : FALLBACK_MEDIA_TYPE,
      bytes: bytes.value,
    });
  }
  return Result.ok(files);
};

const MESSAGE_TYPE = /^[A-Z]$/u;
// Neither the system nor its clients emit a document type declaration; one
// can only bring entity definitions this reader has no use for.
const DOCUMENT_TYPE_DECLARATION = /<!doctype|<!entity/iu;

// The schema repeats dmEvent. Some exports group multiple time/description
// pairs in a single dmEvent, as in the ISDS GetDeliveryInfo example.
const readDeliveryEvents = (
  receipt: Element,
  limits: DataBoxMessageLimits,
): Result<DataBoxDeliveryEvent[], DataBoxMessageParseError> => {
  const events: DataBoxDeliveryEvent[] = [];
  // An event with neither a readable time nor a description states nothing.
  const record = (occurredAt: string | null, description: string | null) => {
    if (occurredAt !== null || description !== null) {
      events.push({ occurredAt, description });
    }
  };
  const container = child(receipt, "dmEvents");
  if (container === undefined) {
    return Result.ok(events);
  }
  for (const event of container.children) {
    if (!isIsdsElement(event, "dmEvent")) {
      continue;
    }
    let time: string | null | undefined;
    for (const detail of event.children) {
      if (isIsdsElement(detail, "dmEventTime")) {
        if (time !== undefined) {
          record(time, null);
        }
        time = readTimestamp(boundedText(detail.textContent));
      } else if (isIsdsElement(detail, "dmEventDescr")) {
        record(time ?? null, boundedText(detail.textContent));
        time = undefined;
      }
      // Every reader of the receipt holds all its events, so their count stays bounded.
      if (events.length > limits.maxEvents) {
        return failure("too_many_events", "The receipt has too many events");
      }
    }
    if (time !== undefined) {
      record(time, null);
    }
  }
  return events.length > limits.maxEvents
    ? failure("too_many_events", "The receipt has too many events")
    : Result.ok(events);
};

const readDocumentXml = (
  { content, seal }: SignedContent,
  limits: DataBoxMessageLimits,
): Result<ParsedDataBoxDocument, DataBoxMessageParseError> => {
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
  const message = isIsdsElement(root, "dmReturnedMessage")
    ? root
    : child(root, "dmReturnedMessage");
  const receipt = isIsdsElement(root, "GetDeliveryInfoResponse")
    ? child(root, "dmDelivery")
    : undefined;
  const record = message ?? receipt;
  if (
    record === undefined ||
    (message !== undefined && receipt !== undefined)
  ) {
    return failure(
      "not_a_message",
      "The file holds no recognizable ISDS message or receipt",
    );
  }
  const dm = child(record, "dmDm");
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
  const messageType = boundedText(record.getAttribute("dmType"));
  const annotation = fieldText(dm, "dmAnnotation") ?? "";
  const envelope = {
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
    deliveredAt: fieldTimestamp(record, "dmDeliveryTime"),
    acceptedAt: fieldTimestamp(record, "dmAcceptanceTime"),
    status: fieldStatus(record),
    seal,
  } satisfies DataBoxStatedEnvelope;
  if (receipt !== undefined) {
    const events = readDeliveryEvents(receipt, limits);
    if (events.isErr()) {
      return events;
    }
    return Result.ok({
      kind: "receipt",
      annotation,
      envelope,
      events: events.value,
    });
  }
  const files = readFiles(dm, limits);
  if (files.isErr()) {
    return files;
  }
  return Result.ok({
    kind: "message",
    annotation,
    envelope,
    files: files.value,
  });
};

/** Reads one exported message or receipt. Never touches the network. */
export const parseDataBoxDocument = (
  bytes: Uint8Array,
  limits: DataBoxMessageLimits = DATA_BOX_MESSAGE_LIMITS,
): Result<ParsedDataBoxDocument, DataBoxMessageParseError> => {
  if (bytes.byteLength > limits.maxFileBytes) {
    return failure("too_large", "The file exceeds the size limit");
  }
  const signed = unwrapSignedData(bytes);
  if (signed.isErr()) {
    return signed;
  }
  return readDocumentXml(signed.value, limits);
};

/** Only a complete message can create a correspondence record and its attachments. */
export const parseDataBoxMessage = (
  bytes: Uint8Array,
  limits: DataBoxMessageLimits = DATA_BOX_MESSAGE_LIMITS,
): Result<ParsedDataBoxMessage, DataBoxMessageParseError> => {
  const document = parseDataBoxDocument(bytes, limits);
  if (document.isErr()) {
    return document;
  }
  return document.value.kind === "message"
    ? Result.ok(document.value)
    : failure("not_a_message", "The file holds a delivery receipt");
};
