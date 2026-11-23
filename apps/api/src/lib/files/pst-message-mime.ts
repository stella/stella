/**
 * An Outlook mailbox's message, as its MAPI properties hold it, written as
 * the email it is (RFC 5322 with MIME): sender, recipients, date, subject
 * and message ids as headers; its plain text and HTML bodies (an RTF body,
 * through the compressed-RTF and RTF readers, when it has no HTML); its
 * attachments, an attached message as a nested `message/rfc822`. Every
 * header value is encoded and every body base64, so the email is plain
 * ASCII whatever the message holds. An attachment whose content is not
 * read is written empty, under its name, which the email reader lists as
 * one that cannot be read.
 */
import {
  PST_PROPERTY_TYPE,
  pstInteger,
  type PstMessage,
  type PstProperty,
  pstProperty,
  pstTime,
} from "@stll/pst-reader";
import { Temporal } from "@stll/time";

import { codePageDecoder, rtfMessageBody } from "@/api/lib/files/rtf-body";
import { decompressRtf } from "@/api/lib/files/rtf-compressed";

/** MAPI property ids read ([MS-OXPROPS]). */
export const PST_PROPERTY = {
  importance: 0x00_17,
  subject: 0x00_37,
  clientSubmitTime: 0x00_39,
  sentRepresentingName: 0x00_42,
  sentRepresentingAddressType: 0x00_64,
  sentRepresentingEmail: 0x00_65,
  recipientType: 0x0c_15,
  senderName: 0x0c_1a,
  senderAddressType: 0x0c_1e,
  senderEmail: 0x0c_1f,
  displayBcc: 0x0e_02,
  displayCc: 0x0e_03,
  displayTo: 0x0e_04,
  deliveryTime: 0x0e_06,
  messageSize: 0x0e_08,
  attachSize: 0x0e_20,
  body: 0x10_00,
  rtfCompressed: 0x10_09,
  html: 0x10_13,
  internetMessageId: 0x10_35,
  internetReferences: 0x10_39,
  inReplyToId: 0x10_42,
  displayName: 0x30_01,
  addressType: 0x30_02,
  emailAddress: 0x30_03,
  creationTime: 0x30_07,
  attachFilename: 0x37_04,
  attachMethod: 0x37_05,
  attachLongFilename: 0x37_07,
  attachMimeTag: 0x37_0e,
  attachContentId: 0x37_12,
  smtpAddress: 0x39_fe,
  internetCodePage: 0x3f_de,
  messageCodePage: 0x3f_fd,
  senderSmtpAddress: 0x5d_01,
  sentRepresentingSmtpAddress: 0x5d_02,
  recipientDisplayName: 0x5f_f6,
  attachmentHidden: 0x7f_fe,
} as const;

/** An attachment that is an attached message ([MS-OXCMSG] 2.2.2.9). */
const ATTACH_EMBEDDED_MESSAGE = 5;

/** The largest RTF body read out of its compressed stream. */
export const PST_RTF_MAX_BYTES = 16 * 1024 * 1024;

/** Windows-1252, the code page a message that names none is in. */
const DEFAULT_CODE_PAGE = 1252;

const UTF8 = new TextDecoder("utf-8");

/** The code page an 8-bit string of `properties` is in. */
export const pstCodePage = (properties: readonly PstProperty[]): number =>
  pstInteger(properties, PST_PROPERTY.messageCodePage) ??
  pstInteger(properties, PST_PROPERTY.internetCodePage) ??
  DEFAULT_CODE_PAGE;

const decodeText = (
  property: PstProperty | undefined,
  codePage: number,
): string | null => {
  if (property === undefined) {
    return null;
  }
  if (property.type === PST_PROPERTY_TYPE.unicode) {
    return UTF8.decode(property.bytes);
  }
  if (property.type === PST_PROPERTY_TYPE.string8) {
    return codePageDecoder(codePage).decode(property.bytes);
  }
  return null;
};

/** A string property, trimmed and without NULs; null when blank. */
export const pstText = (
  properties: readonly PstProperty[],
  id: number,
  codePage: number = pstCodePage(properties),
): string | null => {
  // A writer may pad a string with NULs, which are not text.
  const text = decodeText(pstProperty(properties, id), codePage)
    ?.split("\u0000")
    .join("");
  return text?.trim() ? text.trim() : null;
};

/**
 * A message's subject. A stored subject may open with a prefix marker
 * (U+0001 and the prefix's length, [MS-PST] 2.5.3.1.1.1), which is not text.
 */
export const pstSubject = (
  properties: readonly PstProperty[],
  codePage: number = pstCodePage(properties),
): string | null => {
  const subject = pstText(properties, PST_PROPERTY.subject, codePage);
  if (subject?.startsWith("\u0001") !== true) {
    return subject;
  }
  const rest = subject.slice(2).trim();
  return rest === "" ? null : rest;
};

const ADDRESS = /^[^\s"(),:;<>@[\\\]]+@[^\s"(),:;<>@[\\\]]+$/u;

/** An address one can write to: an SMTP address, never an X.500 one. */
const smtpAddress = (value: string | null): string | null =>
  value !== null && ADDRESS.test(value) ? value : null;

type Mailbox = {
  readonly name: string | null;
  readonly address: string | null;
};

/** How a mailbox is shown: its name and address, or whichever it has. */
export const pstMailboxText = ({ name, address }: Mailbox): string | null => {
  if (name !== null && address !== null && name !== address) {
    return `${name} <${address}>`;
  }
  return address ?? name;
};

/** The message's sender: who it was sent for, else who sent it. */
export const pstSender = (
  properties: readonly PstProperty[],
  codePage: number = pstCodePage(properties),
): Mailbox => {
  const text = (id: number) => pstText(properties, id, codePage);
  const name =
    text(PST_PROPERTY.sentRepresentingName) ?? text(PST_PROPERTY.senderName);
  const address =
    smtpAddress(text(PST_PROPERTY.sentRepresentingSmtpAddress)) ??
    smtpAddress(text(PST_PROPERTY.senderSmtpAddress)) ??
    smtpAddress(text(PST_PROPERTY.sentRepresentingEmail)) ??
    smtpAddress(text(PST_PROPERTY.senderEmail));
  return { name, address };
};

/** When the message was sent, else received, else made. */
export const pstMessageDate = (
  properties: readonly PstProperty[],
): Date | null =>
  pstTime(properties, PST_PROPERTY.clientSubmitTime) ??
  pstTime(properties, PST_PROPERTY.deliveryTime) ??
  pstTime(properties, PST_PROPERTY.creationTime);

/** Day names by ISO weekday (Monday is 1), as RFC 5322 writes them. */
const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const twoDigits = (value: number) => String(value).padStart(2, "0");

/**
 * An instant as an email's `Date:` header writes it (RFC 5322). The message
 * stores the instant, not the sender's zone, so it is written in UTC.
 */
export const rfc5322Date = (date: Date): string => {
  const at = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO("UTC");
  return `${DAYS[at.dayOfWeek] ?? "Mon"}, ${twoDigits(at.day)} ${
    MONTHS[at.month] ?? "Jan"
  } ${String(at.year)} ${twoDigits(at.hour)}:${twoDigits(
    at.minute,
  )}:${twoDigits(at.second)} +0000`;
};

const CRLF = "\r\n";

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

/** Base64 in lines of 76 characters (RFC 2045). */
const base64Lines = (bytes: Uint8Array): string =>
  (base64(bytes).match(/.{1,76}/gu) ?? []).join(CRLF);

/** Printable ASCII without the characters that end a header. */
const PLAIN_HEADER_TEXT = /^[\x20-\x7e]*$/u;

/** Characters one encoded word may hold, kept well under 75 encoded. */
const ENCODED_WORD_CHARACTERS = 20;

/** A header value as RFC 2047 encoded words when it is not plain ASCII. */
const encodeWords = (value: string): string => {
  // Line breaks inside a stored value would end the header.
  const flat = value.replace(/[\r\n\t]+/gu, " ");
  if (PLAIN_HEADER_TEXT.test(flat)) {
    return flat;
  }
  // Whole graphemes, so no encoded word splits a character.
  const characters = Array.from(
    new Intl.Segmenter("en", { granularity: "grapheme" }).segment(flat),
    ({ segment }) => segment,
  );
  const words: string[] = [];
  for (let at = 0; at < characters.length; at += ENCODED_WORD_CHARACTERS) {
    const chunk = characters.slice(at, at + ENCODED_WORD_CHARACTERS).join("");
    words.push(`=?UTF-8?B?${base64(new TextEncoder().encode(chunk))}?=`);
  }
  return words.join(`${CRLF} `);
};

/** A display name as a header writes it: quoted, or encoded words. */
const displayName = (name: string): string => {
  const flat = name.replace(/[\r\n\t]+/gu, " ");
  return PLAIN_HEADER_TEXT.test(flat)
    ? `"${flat.replace(/["\\]/gu, (character) => `\\${character}`)}"`
    : encodeWords(flat);
};

/** A mailbox in an address header; null when it has neither part. */
const mailboxHeader = ({ name, address }: Mailbox): string | null => {
  if (address !== null) {
    return name === null || name === address
      ? `<${address}>`
      : `${displayName(name)} <${address}>`;
  }
  // A name without an SMTP address (an Exchange-only sender) keeps an empty
  // address: the reader shows the name.
  return name === null ? null : `${displayName(name)} <>`;
};

const RECIPIENT_HEADERS = { 1: "To", 2: "Cc", 3: "Bcc" } as const;

const isRecipientType = (
  value: number | null,
): value is keyof typeof RECIPIENT_HEADERS =>
  value === 1 || value === 2 || value === 3;

const recipientsOf = (
  message: PstMessage,
  codePage: number,
): Map<"To" | "Cc" | "Bcc", Mailbox[]> => {
  const found = new Map<"To" | "Cc" | "Bcc", Mailbox[]>();
  for (const recipient of message.recipients) {
    const type = pstInteger(recipient, PST_PROPERTY.recipientType);
    const header = isRecipientType(type) ? RECIPIENT_HEADERS[type] : "To";
    const text = (id: number) => pstText(recipient, id, codePage);
    const addressType = text(PST_PROPERTY.addressType);
    const mailbox = {
      name:
        text(PST_PROPERTY.displayName) ??
        text(PST_PROPERTY.recipientDisplayName),
      address:
        smtpAddress(text(PST_PROPERTY.smtpAddress)) ??
        (addressType === null || addressType.toUpperCase() === "SMTP"
          ? smtpAddress(text(PST_PROPERTY.emailAddress))
          : null),
    };
    found.set(header, [...(found.get(header) ?? []), mailbox]);
  }
  // A message without a recipient table names its recipients only in its
  // display fields: "Name; Name".
  const shown = [
    ["To", PST_PROPERTY.displayTo],
    ["Cc", PST_PROPERTY.displayCc],
    ["Bcc", PST_PROPERTY.displayBcc],
  ] as const;
  for (const [header, id] of shown) {
    if (found.has(header)) {
      continue;
    }
    const names = (pstText(message.properties, id, codePage) ?? "")
      .split(";")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (names.length > 0) {
      found.set(
        header,
        names.map((name) => ({ name, address: null })),
      );
    }
  }
  return found;
};

/** A message id (`<id@host>`) as stored, when it is one. */
const MESSAGE_ID = /^<[^\s<>]+>$/u;

const messageIds = (value: string | null): string | null => {
  const ids = (value ?? "")
    .split(/\s+/u)
    .filter((id) => MESSAGE_ID.test(id) && PLAIN_HEADER_TEXT.test(id));
  return ids.length === 0 ? null : ids.join(" ");
};

type Body = { readonly text: string | null; readonly html: string | null };

/**
 * The message's bodies: its plain text, and its HTML, else what its RTF
 * body carries (encapsulated HTML, or text).
 */
const bodiesOf = (message: PstMessage, codePage: number): Body => {
  const { properties } = message;
  const text = pstText(properties, PST_PROPERTY.body, codePage);
  const html = pstProperty(properties, PST_PROPERTY.html);
  const htmlCodePage =
    pstInteger(properties, PST_PROPERTY.internetCodePage) ?? codePage;
  // An HTML body is bytes in the message's internet code page, or a string.
  const storedHtml =
    html?.type === PST_PROPERTY_TYPE.binary
      ? codePageDecoder(htmlCodePage).decode(html.bytes)
      : decodeText(html, codePage);
  if (storedHtml?.trim()) {
    return { text, html: storedHtml };
  }
  const rtf = pstProperty(properties, PST_PROPERTY.rtfCompressed);
  if (rtf?.type !== PST_PROPERTY_TYPE.binary) {
    return { text, html: null };
  }
  const decompressed = decompressRtf(rtf.bytes, {
    maxBytes: PST_RTF_MAX_BYTES,
  });
  const fromRtf = decompressed.isOk()
    ? rtfMessageBody(decompressed.value)
    : null;
  if (fromRtf?.type === "html") {
    return { text, html: fromRtf.html };
  }
  return { text: text ?? fromRtf?.text ?? null, html: null };
};

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

/** `name` as an RFC 2231 extended parameter value. */
const extendedValue = (name: string): string =>
  `UTF-8''${encodeURIComponent(name).replace(
    /['()*]/gu,
    (character) =>
      `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, "0")}`,
  )}`;

/** A file name as both a quoted parameter and an extended one. */
const fileNameParameters = (parameter: "name" | "filename", name: string) => {
  const flat = name.replace(/[\r\n\t"\\]+/gu, " ");
  return PLAIN_HEADER_TEXT.test(flat)
    ? `${parameter}="${flat}"`
    : `${parameter}="${encodeWords(flat).replace(/\r\n /gu, "")}";${CRLF} ${parameter}*=${extendedValue(flat)}`;
};

const attachmentName = (
  properties: readonly PstProperty[],
  codePage: number,
): string =>
  pstText(properties, PST_PROPERTY.attachLongFilename, codePage) ??
  pstText(properties, PST_PROPERTY.attachFilename, codePage) ??
  pstText(properties, PST_PROPERTY.displayName, codePage) ??
  "attachment";

/** An attached message's name as the email it is delivered as. */
const messageFileName = (name: string): string =>
  /\.(?:msg|eml)$/iu.test(name)
    ? name.replace(/\.(?:msg|eml)$/iu, ".eml")
    : `${name}.eml`;

type Part = { readonly headers: string[]; readonly body: string };

const writePart = ({ headers, body }: Part): string =>
  `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;

const multipart = (subtype: string, boundary: string, parts: Part[]): Part => ({
  headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
  body: `${parts
    .map((part) => `--${boundary}${CRLF}${writePart(part)}${CRLF}`)
    .join("")}--${boundary}--`,
});

const textPart = (subtype: "plain" | "html", text: string): Part => ({
  headers: [
    `Content-Type: text/${subtype}; charset="utf-8"`,
    "Content-Transfer-Encoding: base64",
  ],
  body: base64Lines(new TextEncoder().encode(text)),
});

const attachmentPart = (
  properties: readonly PstProperty[],
  content: Uint8Array | PstMessage | null,
  codePage: number,
  write: (message: PstMessage) => string,
): Part => {
  const name = attachmentName(properties, codePage);
  const embedded =
    pstInteger(properties, PST_PROPERTY.attachMethod) ===
    ATTACH_EMBEDDED_MESSAGE;
  if (content !== null && !(content instanceof Uint8Array)) {
    const fileName = messageFileName(name);
    return {
      headers: [
        "Content-Type: message/rfc822",
        `Content-Disposition: attachment; ${fileNameParameters("filename", fileName)}`,
        "Content-Transfer-Encoding: 7bit",
      ],
      body: write(content),
    };
  }
  const stated = pstText(properties, PST_PROPERTY.attachMimeTag, codePage)
    ?.toLowerCase()
    .split(";")[0]
    ?.trim();
  const unstated = embedded ? "message/rfc822" : "application/octet-stream";
  const mediaType =
    stated !== undefined && MEDIA_TYPE.test(stated) ? stated : unstated;
  const contentId = pstText(properties, PST_PROPERTY.attachContentId, codePage)
    ?.replace(/^<|>$/gu, "")
    .trim();
  const hidden = pstProperty(properties, PST_PROPERTY.attachmentHidden);
  const inline =
    contentId !== undefined &&
    contentId !== "" &&
    PLAIN_HEADER_TEXT.test(contentId) &&
    !/[<>\s]/u.test(contentId) &&
    hidden?.bytes[0] === 1;
  const fileName = embedded && content === null ? messageFileName(name) : name;
  // An attached message whose content is not read keeps a type the email
  // reader lists as an attachment, never one it opens as a message.
  const type =
    embedded && content === null ? "application/octet-stream" : mediaType;
  return {
    headers: [
      `Content-Type: ${type}; ${fileNameParameters("name", fileName)}`,
      `Content-Disposition: ${inline ? "inline" : "attachment"}; ${fileNameParameters("filename", fileName)}`,
      ...(inline ? [`Content-ID: <${contentId}>`] : []),
      "Content-Transfer-Encoding: base64",
    ],
    body: content === null ? "" : base64Lines(content),
  };
};

const writeMessage = (message: PstMessage, depth: number): string => {
  const codePage = pstCodePage(message.properties);
  const { properties } = message;
  const headers: string[] = [];
  const from = mailboxHeader(pstSender(properties, codePage));
  if (from !== null) {
    headers.push(`From: ${from}`);
  }
  for (const [header, mailboxes] of recipientsOf(message, codePage)) {
    const written = mailboxes.flatMap((mailbox) => {
      const value = mailboxHeader(mailbox);
      return value === null ? [] : [value];
    });
    if (written.length > 0) {
      headers.push(`${header}: ${written.join(`,${CRLF} `)}`);
    }
  }
  const date = pstMessageDate(properties);
  if (date !== null) {
    headers.push(`Date: ${rfc5322Date(date)}`);
  }
  const subject = pstSubject(properties, codePage);
  if (subject !== null) {
    headers.push(`Subject: ${encodeWords(subject)}`);
  }
  const ids = [
    ["Message-ID", PST_PROPERTY.internetMessageId],
    ["In-Reply-To", PST_PROPERTY.inReplyToId],
    ["References", PST_PROPERTY.internetReferences],
  ] as const;
  for (const [header, id] of ids) {
    const value = messageIds(pstText(properties, id, codePage));
    if (value !== null) {
      headers.push(`${header}: ${value}`);
    }
  }
  headers.push("MIME-Version: 1.0");
  const { text, html } = bodiesOf(message, codePage);
  const bodies: Part[] = [
    ...(text === null ? [] : [textPart("plain", text)]),
    ...(html === null ? [] : [textPart("html", html)]),
  ];
  const body: Part =
    bodies.length === 2
      ? multipart("alternative", `=_pst_alternative_${String(depth)}`, bodies)
      : (bodies[0] ?? textPart("plain", ""));
  const attachments = message.attachments.map(
    ({ properties: attachment, content }) =>
      attachmentPart(attachment, content, codePage, (nested) =>
        writeMessage(nested, depth + 1),
      ),
  );
  const whole =
    attachments.length === 0
      ? body
      : multipart("mixed", `=_pst_mixed_${String(depth)}`, [
          body,
          ...attachments,
        ]);
  return writePart({
    headers: [...headers, ...whole.headers],
    body: whole.body,
  });
};

/** A mailbox's message as the email (`message/rfc822`) it opens as. */
export const pstMessageEmail = (message: PstMessage): Uint8Array =>
  new TextEncoder().encode(`${writeMessage(message, 0)}${CRLF}`);
