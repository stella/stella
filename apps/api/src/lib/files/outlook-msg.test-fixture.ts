/**
 * Outlook .msg property streams for `buildCompoundFile`: MAPI properties as
 * `__substg1.0_<id><type>` streams at the root or under a recipient or
 * attachment storage. Used by the .msg parser and inbound normalization tests.
 */
import {
  buildCompoundFile,
  type CompoundFileFixtureStream,
} from "./compound-file.test-fixture";

const UINT32_RANGE = 4_294_967_296n;

export const rootProperty = (
  propertyId: string,
  propertyType: string,
  bytes: Uint8Array,
): CompoundFileFixtureStream => ({
  path: [`__substg1.0_${propertyId}${propertyType}`],
  bytes,
});

export const storageProperty = (
  storageName: string,
  propertyId: string,
  propertyType: string,
  bytes: Uint8Array,
): CompoundFileFixtureStream => ({
  path: [storageName, `__substg1.0_${propertyId}${propertyType}`],
  bytes,
});

export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export const utf16Property = (value: string): Uint8Array =>
  Buffer.from(`${value}\u0000`, "utf16le");

export const int32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
};

export const fileTimeProperty = (isoDate: string): Uint8Array => {
  const unixMs = BigInt(new Date(isoDate).getTime());
  const windowsEpochOffsetMs = 11_644_473_600_000n;
  const fileTime = (unixMs + windowsEpochOffsetMs) * 10_000n;
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number(fileTime % UINT32_RANGE), true);
  view.setUint32(4, Number(fileTime / UINT32_RANGE), true);
  return bytes;
};

type OutlookRecipientFixture = {
  email: string;
  name?: string;
  type: "to" | "cc";
};

type OutlookAttachmentFixture = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

type OutlookMessageFixture = {
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  submittedAt?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
  recipients?: OutlookRecipientFixture[];
  attachments?: readonly OutlookAttachmentFixture[];
};

const RECIPIENT_TYPE_VALUE = { to: 1, cc: 2 } as const;

const recipientStorage = (index: number) =>
  `__recip_version1.0_${index.toString(16).padStart(8, "0")}`;
const attachmentStorage = (index: number) =>
  `__attach_version1.0_${index.toString(16).padStart(8, "0")}`;

const optionalString = (
  propertyId: string,
  value: string | undefined,
): CompoundFileFixtureStream[] =>
  value === undefined
    ? []
    : [rootProperty(propertyId, "001f", utf16Property(value))];

/** A .msg container holding the stated message; each stream stays under 4 KiB. */
export const buildOutlookMessage = ({
  subject,
  fromName,
  fromEmail,
  submittedAt,
  messageId,
  inReplyTo,
  references,
  text,
  html,
  recipients = [],
  attachments = [],
}: OutlookMessageFixture): ArrayBuffer =>
  toArrayBuffer(
    buildCompoundFile([
      ...optionalString("0037", subject),
      ...optionalString("0c1a", fromName),
      ...optionalString("5d01", fromEmail),
      ...(submittedAt === undefined
        ? []
        : [rootProperty("0039", "0040", fileTimeProperty(submittedAt))]),
      ...optionalString("1035", messageId),
      ...optionalString("1042", inReplyTo),
      ...optionalString("1039", references),
      ...optionalString("1000", text),
      ...optionalString("1013", html),
      ...recipients.flatMap(({ email, name, type }, index) => [
        storageProperty(
          recipientStorage(index),
          "0c15",
          "0003",
          int32(RECIPIENT_TYPE_VALUE[type]),
        ),
        storageProperty(
          recipientStorage(index),
          "39fe",
          "001f",
          utf16Property(email),
        ),
        ...(name === undefined
          ? []
          : [
              storageProperty(
                recipientStorage(index),
                "3001",
                "001f",
                utf16Property(name),
              ),
            ]),
      ]),
      ...attachments.flatMap(({ fileName, mimeType, bytes }, index) => [
        storageProperty(
          attachmentStorage(index),
          "3707",
          "001f",
          utf16Property(fileName),
        ),
        storageProperty(
          attachmentStorage(index),
          "370e",
          "001f",
          utf16Property(mimeType),
        ),
        storageProperty(attachmentStorage(index), "3701", "0102", bytes),
      ]),
    ]),
  );
