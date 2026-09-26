import { Result, TaggedError } from "better-result";
import { load } from "cheerio";
import PostalMime, {
  addressParser,
  type Address,
  type Email,
} from "postal-mime";

import { Temporal } from "@stll/time";

import {
  renderEmailBodyHtml,
  type ParsedEmail,
} from "@/api/lib/files/email-to-html";
import {
  sanitizeFilename,
  type SanitizedFileName,
} from "@/api/lib/sanitize-filename";

import { INBOUND_MAIL_LIMITS } from "./limits";

export type InboundAttachment = {
  fileName: SanitizedFileName;
  mimeType: string;
  bytes: Uint8Array;
};

export type NormalizedInboundMessage = {
  from: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  subject: string | null;
  text: string;
  html: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: InboundAttachment[];
  contentHash: string;
};

export type ParsedInboundMessage = {
  outerSender: string | null;
  message: NormalizedInboundMessage;
} & (
  | { forwardSource: "none" | "inline" }
  | { forwardSource: "attached"; originalRaw: Uint8Array }
);

export type InboundMessageErrorReason =
  | "invalidMime"
  | "invalidFrom"
  | "rawTooLarge"
  | "headersTooLarge"
  | "bodyTooLarge"
  | "tooManyRecipients"
  | "tooManyAttachments"
  | "attachmentTooLarge"
  | "unsafeAttachment";

export class InboundMessageError extends TaggedError("InboundMessageError")<{
  message: string;
  reason: InboundMessageErrorReason;
}> {}

const INVALID_MAILBOX = /[\s<>;,]/u;
const MESSAGE_ID_PATTERN = /<[^<>\s]+@[^<>\s]+>/gu;
const RFC_EXPLICIT_ZONE_DATE =
  /^(?:[a-z]{3},?\s+)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|UTC|GMT|UT)$/iu;
const ISO_EXPLICIT_ZONE_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/iu;
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const UNSAFE_ATTACHMENT_EXTENSIONS = new Set([
  "apk",
  "app",
  "bat",
  "cmd",
  "com",
  "command",
  "deb",
  "desktop",
  "dll",
  "dmg",
  "exe",
  "hta",
  "htm",
  "html",
  "ipa",
  "jar",
  "js",
  "jse",
  "lnk",
  "mjs",
  "msi",
  "pif",
  "pkg",
  "ps1",
  "py",
  "reg",
  "rpm",
  "scf",
  "scr",
  "sh",
  "svg",
  "url",
  "vbe",
  "vbs",
  "wasm",
  "wsf",
  "xhtml",
]);
const UNSAFE_ATTACHMENT_MIME_TYPES = new Set([
  "application/hta",
  "application/javascript",
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-msi",
  "application/x-sh",
  "image/svg+xml",
  "text/html",
  "text/javascript",
]);

const fail = (reason: InboundMessageErrorReason): never => {
  throw new InboundMessageError({ reason, message: reason });
};

const normalizeMailbox = (address: Address): string | null => {
  if (address.group || !address.address) {
    return null;
  }
  const mailbox = address.address.trim().toLowerCase();
  const at = mailbox.lastIndexOf("@");
  if (
    at <= 0 ||
    at === mailbox.length - 1 ||
    INVALID_MAILBOX.test(mailbox) ||
    mailbox.indexOf("@") !== at
  ) {
    return null;
  }
  return mailbox;
};

const parseOneMailbox = (value: string): string | null => {
  const addresses = addressParser(value, { flatten: true });
  const address = addresses.at(0);
  return addresses.length === 1 && address ? normalizeMailbox(address) : null;
};

const normalizeAddresses = (addresses: Address[] | undefined): string[] => {
  const result: string[] = [];
  for (const address of addresses ?? []) {
    if (address.group) {
      for (const member of address.group) {
        const mailbox = normalizeMailbox(member);
        if (mailbox) {
          result.push(mailbox);
        }
      }
      continue;
    }
    const mailbox = normalizeMailbox(address);
    if (mailbox) {
      result.push(mailbox);
    }
  }
  return result;
};

const normalizeHeaderId = (value: string | undefined): string | null => {
  const id = value?.match(MESSAGE_ID_PATTERN)?.at(0);
  if (!id) {
    return null;
  }
  const at = id.lastIndexOf("@");
  return `${id.slice(0, at + 1)}${id.slice(at + 1, -1).toLowerCase()}>`;
};

const normalizeReferences = (value: string | undefined): string[] =>
  value?.match(MESSAGE_ID_PATTERN)?.flatMap((id) => {
    const normalized = normalizeHeaderId(id);
    return normalized ? [normalized] : [];
  }) ?? [];

const parseExplicitDateParts = (value: string) => {
  const rfc = RFC_EXPLICIT_ZONE_DATE.exec(value);
  if (rfc) {
    return {
      year: Number(rfc[3]),
      month: MONTHS.indexOf(rfc[2]?.toLowerCase() ?? "") + 1,
      day: Number(rfc[1]),
      hour: Number(rfc[4]),
      minute: Number(rfc[5]),
      second: Number(rfc[6] ?? 0),
      zone: rfc[7] ?? "",
    };
  }
  const iso = ISO_EXPLICIT_ZONE_DATE.exec(value);
  if (!iso) {
    return null;
  }
  return {
    year: Number(iso[1]),
    month: Number(iso[2]),
    day: Number(iso[3]),
    hour: Number(iso[4]),
    minute: Number(iso[5]),
    second: Number(iso[6] ?? 0),
    zone: iso[7] ?? "",
  };
};

const hasInvalidDateOffset = (zone: string): boolean => {
  const numericZone = /^[+-](\d{2}):?(\d{2})$/u.exec(zone);
  return (
    zone === "-0000" ||
    zone === "-00:00" ||
    (numericZone !== null &&
      (Number(numericZone[1]) > 23 || Number(numericZone[2]) > 59))
  );
};

const explicitZoneDate = (value: string): string | null => {
  const trimmed = value.trim().replace(/\s+\([^()]*\)$/u, "");
  const parts = parseExplicitDateParts(trimmed);
  if (!parts || hasInvalidDateOffset(parts.zone)) {
    return null;
  }
  const { year, month, day, hour, minute, second } = parts;
  if (
    Result.try(() =>
      Temporal.PlainDateTime.from(
        { year, month, day, hour, minute, second },
        { overflow: "reject" },
      ),
    ).isErr()
  ) {
    return null;
  }
  // RFC 5322 dates are a legacy protocol grammar that Temporal cannot parse.
  const epoch = new Date(trimmed).getTime();
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
};

const checkRaw = (raw: Uint8Array): number => {
  if (raw.byteLength > INBOUND_MAIL_LIMITS.rawBytes) {
    fail("rawTooLarge");
  }
  const searchEnd = Math.min(
    raw.byteLength,
    INBOUND_MAIL_LIMITS.headerBytes + 4,
  );
  let headerEnd = -1;
  for (let index = 0; index < searchEnd - 1; index += 1) {
    if (raw[index] === 10 && raw[index + 1] === 10) {
      headerEnd = index;
      break;
    }
    if (
      raw[index] === 13 &&
      raw[index + 1] === 10 &&
      raw[index + 2] === 13 &&
      raw[index + 3] === 10
    ) {
      headerEnd = index;
      break;
    }
  }
  if (headerEnd < 0) {
    fail("headersTooLarge");
  }
  return headerEnd;
};

const rawDateHeader = (raw: Uint8Array, headerEnd: number): string | null => {
  const headers = new TextDecoder("latin1")
    .decode(raw.subarray(0, headerEnd))
    .replace(/\r?\n[\t ]+/gu, " ");
  const dates = headers.split(/\r?\n/u).flatMap((line) => {
    const match = /^date:\s*(.*)$/iu.exec(line);
    return match ? [match[1] ?? ""] : [];
  });
  return dates.length === 1 ? (dates.at(0) ?? null) : null;
};

const parseMime = async (raw: Uint8Array) => {
  const headerEnd = checkRaw(raw);
  try {
    const email = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      forceRfc822Attachments: true,
      maxNestingDepth: INBOUND_MAIL_LIMITS.mimeDepth,
      maxHeadersSize: INBOUND_MAIL_LIMITS.headerBytes,
      maxRfc822NestingDepth: 0,
    });
    return {
      email,
      date: explicitZoneDate(rawDateHeader(raw, headerEnd) ?? ""),
    };
  } catch {
    return fail("invalidMime");
  }
};

const checkedOuterSender = (email: Email): string | null => {
  const fromHeaders = email.headers.filter(({ key }) => key === "from");
  if (fromHeaders.length === 0) {
    return null;
  }
  if (fromHeaders.length !== 1) {
    return fail("invalidFrom");
  }
  const header = fromHeaders.at(0);
  if (!header) {
    return fail("invalidFrom");
  }
  return parseOneMailbox(header.value) ?? fail("invalidFrom");
};

const normalizeText = (value: string | undefined): string =>
  (value ?? "").replace(/\r\n?/gu, "\n").trim();

const sanitizeBodyHtml = (email: Email): string | null => {
  if (!email.html) {
    return null;
  }
  if (
    new TextEncoder().encode(email.html).byteLength >
    INBOUND_MAIL_LIMITS.bodyBytes
  ) {
    fail("bodyTooLarge");
  }
  const parsed = {
    subject: null,
    from: null,
    to: [],
    cc: [],
    bcc: [],
    date: null,
    body: { type: "html", html: email.html },
    inlineImages: [],
    attachments: [],
  } satisfies ParsedEmail;
  return load(renderEmailBodyHtml(parsed))("body").html();
};

const checkedAttachments = (email: Email): InboundAttachment[] => {
  if (email.attachments.length > INBOUND_MAIL_LIMITS.attachmentCount) {
    fail("tooManyAttachments");
  }
  const attachments: InboundAttachment[] = [];
  for (const attachment of email.attachments) {
    const mimeType =
      attachment.mimeType.toLowerCase().split(";").at(0)?.trim() ?? "";
    const fileName = sanitizeFilename(attachment.filename ?? "attachment");
    const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
    if (
      UNSAFE_ATTACHMENT_EXTENSIONS.has(extension) ||
      UNSAFE_ATTACHMENT_MIME_TYPES.has(mimeType)
    ) {
      fail("unsafeAttachment");
    }
    const bytes =
      typeof attachment.content === "string"
        ? new TextEncoder().encode(attachment.content)
        : new Uint8Array(attachment.content);
    if (bytes.byteLength > INBOUND_MAIL_LIMITS.attachmentBytes) {
      fail("attachmentTooLarge");
    }
    if (
      (bytes[0] === 0x7f &&
        bytes[1] === 0x45 &&
        bytes[2] === 0x4c &&
        bytes[3] === 0x46) ||
      (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
      (bytes[0] === 0x23 && bytes[1] === 0x21)
    ) {
      fail("unsafeAttachment");
    }
    attachments.push({ fileName, mimeType, bytes });
  }
  // Content dedup ignores MIME part order, so ordinal attachment links must
  // use the same canonical order when different deliveries resume a filing.
  return attachments
    .map((attachment) => ({
      attachment,
      key: JSON.stringify([
        attachment.mimeType,
        new Bun.CryptoHasher("sha256").update(attachment.bytes).digest("hex"),
      ]),
    }))
    .toSorted((a, b) => (a.key < b.key ? -1 : Number(a.key > b.key)))
    .map(({ attachment }) => attachment);
};

const contentHash = (
  message: Omit<NormalizedInboundMessage, "contentHash">,
): string => {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(
    JSON.stringify({
      from: message.from,
      to: message.to.toSorted(),
      cc: message.cc.toSorted(),
      date: message.date,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  );
  const attachmentFingerprints = message.attachments.map(
    ({ mimeType, bytes }) => [
      mimeType,
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    ],
  );
  for (const fingerprint of attachmentFingerprints
    .map((parts) => JSON.stringify(parts))
    .toSorted()) {
    hash.update(fingerprint);
  }
  return hash.digest("hex");
};

const normalizeMessage = (
  email: Email,
  date: string | null,
): NormalizedInboundMessage => {
  const fromHeaders = email.headers.filter(({ key }) => key === "from");
  if (fromHeaders.length > 1) {
    fail("invalidFrom");
  }
  const fromHeader = fromHeaders.at(0);
  const from = fromHeader ? parseOneMailbox(fromHeader.value) : null;
  if (fromHeader && !from) {
    fail("invalidFrom");
  }
  const to = normalizeAddresses(email.to);
  const cc = normalizeAddresses(email.cc);
  if (to.length + cc.length > INBOUND_MAIL_LIMITS.recipients) {
    fail("tooManyRecipients");
  }
  const text = normalizeText(email.text);
  const html = sanitizeBodyHtml(email);
  if (
    text.length > INBOUND_MAIL_LIMITS.bodyCharacters ||
    (html !== null && html.length > INBOUND_MAIL_LIMITS.bodyCharacters) ||
    new TextEncoder().encode(text).byteLength > INBOUND_MAIL_LIMITS.bodyBytes ||
    (html &&
      new TextEncoder().encode(html).byteLength > INBOUND_MAIL_LIMITS.bodyBytes)
  ) {
    fail("bodyTooLarge");
  }
  const message = {
    from,
    to,
    cc,
    date,
    subject: email.subject?.trim() ?? null,
    text,
    html,
    messageId: normalizeHeaderId(email.messageId),
    inReplyTo: normalizeHeaderId(email.inReplyTo),
    references: normalizeReferences(email.references),
    attachments: checkedAttachments(email),
  };
  return { ...message, contentHash: contentHash(message) };
};

const FORWARD_MARKER =
  /^(?:-{2,}\s*(?:forwarded message|original message|původní zpráva|ursprüngliche nachricht|message transféré|mensaje reenviado|messaggio inoltrato)\s*-{2,}|begin forwarded message:|début du message transféré\s*:|anfang der weitergeleiteten nachricht\s*:|inicio del mensaje reenviado\s*:|začátek přeposlané zprávy\s*:?)$/iu;
const ORIGINAL_QUOTE_MARKER =
  /^-{2,}\s*(?:original message|původní zpráva|ursprüngliche nachricht)\s*-{2,}$/iu;
const FORWARD_SUBJECT_PREFIX =
  /^\s*(?:(?:fw|fwd|wg|přep|tr|transféré)\s*:|přeposlaná zpráva(?:\s*:|\s*$))/iu;
const REPLY_SUBJECT_PREFIX = /^\s*(?:re|aw|sv|odp|rép)\s*:/iu;
const HEADER_KIND = {
  from: "from",
  von: "from",
  od: "from",
  de: "from",
  da: "from",
  to: "to",
  an: "to",
  komu: "to",
  à: "to",
  para: "to",
  a: "to",
  cc: "cc",
  kopie: "cc",
  sent: "date",
  gesendet: "date",
  odesláno: "date",
  envoyé: "date",
  enviado: "date",
  inviato: "date",
  date: "date",
  datum: "date",
  fecha: "date",
  subject: "subject",
  betreff: "subject",
  předmět: "subject",
  objet: "subject",
  asunto: "subject",
  oggetto: "subject",
} as const;
const FORWARD_HEADER = new RegExp(
  `^(${Object.keys(HEADER_KIND).join("|")})\\s*:\\s*(.*)$`,
  "iu",
);

const forwardMarkerIndex = (
  lines: string[],
  subject: string | null,
): number | null => {
  const markers = lines.flatMap((line, index) =>
    FORWARD_MARKER.test(line.trim()) ? [index] : [],
  );
  if (markers.length !== 1) {
    return null;
  }
  const marker = markers.at(0);
  if (marker === undefined) {
    return null;
  }
  if (
    ORIGINAL_QUOTE_MARKER.test(lines[marker]?.trim() ?? "") &&
    !FORWARD_SUBJECT_PREFIX.test(subject ?? "")
  ) {
    return null;
  }
  return marker;
};

const parseForwardHeaders = (lines: string[], marker: number) => {
  const headers = new Map<string, string>();
  let index = marker + 1;
  while (index < lines.length && index < marker + 24) {
    const line = lines.at(index)?.trim() ?? "";
    if (!line) {
      index += 1;
      if (headers.size > 0) {
        break;
      }
      continue;
    }
    const match = FORWARD_HEADER.exec(line);
    if (!match) {
      break;
    }
    const label = match.at(1)?.toLowerCase();
    const value = match.at(2)?.trim();
    if (!label || !value) {
      return null;
    }
    const kind = Object.entries(HEADER_KIND)
      .find(([name]) => name === label)
      ?.at(1);
    if (!kind || headers.has(kind)) {
      return null;
    }
    headers.set(kind, value);
    index += 1;
  }
  return { headers, index };
};

const parseInlineForward = (
  outer: NormalizedInboundMessage,
): NormalizedInboundMessage | null => {
  const lines = outer.text.split("\n");
  const marker = forwardMarkerIndex(lines, outer.subject);
  if (marker === null) {
    return null;
  }
  const block = parseForwardHeaders(lines, marker);
  if (block === null) {
    return null;
  }
  const { headers, index } = block;
  const fromHeader = headers.get("from");
  const toHeader = headers.get("to");
  const date = headers.get("date");
  const subject = headers.get("subject");
  const normalizedDate = explicitZoneDate(date ?? "");
  if (!fromHeader || !toHeader || !subject || !normalizedDate) {
    return null;
  }
  const from = parseOneMailbox(fromHeader);
  const to = normalizeAddresses(addressParser(toHeader, { flatten: true }));
  const ccHeader = headers.get("cc");
  const cc = ccHeader
    ? normalizeAddresses(addressParser(ccHeader, { flatten: true }))
    : [];
  if (
    !from ||
    to.length === 0 ||
    to.length + cc.length > INBOUND_MAIL_LIMITS.recipients
  ) {
    return null;
  }
  const text = normalizeText(lines.slice(index).join("\n"));
  if (!text) {
    return null;
  }
  const message = {
    from,
    to,
    cc,
    date: normalizedDate,
    subject,
    text,
    html: null,
    messageId: null,
    inReplyTo: null,
    references: [],
    attachments: outer.attachments,
  };
  return { ...message, contentHash: contentHash(message) };
};

export const parseInboundMessage = async (
  raw: Uint8Array,
): Promise<ParsedInboundMessage> => {
  const { email: outerEmail, date: outerDate } = await parseMime(raw);
  const outerSender = checkedOuterSender(outerEmail);
  const message = normalizeMessage(outerEmail, outerDate);
  if (
    (message.inReplyTo !== null || message.references.length > 0) &&
    REPLY_SUBJECT_PREFIX.test(message.subject ?? "")
  ) {
    return { outerSender, message, forwardSource: "none" };
  }
  const rfc822Parts = outerEmail.attachments.filter(
    ({ mimeType }) => mimeType.toLowerCase() === "message/rfc822",
  );
  const part = rfc822Parts.length === 1 ? rfc822Parts.at(0) : undefined;
  if (part) {
    const bytes =
      typeof part.content === "string"
        ? new TextEncoder().encode(part.content)
        : new Uint8Array(part.content);
    if (bytes.byteLength > INBOUND_MAIL_LIMITS.attachmentBytes) {
      fail("attachmentTooLarge");
    }
    const attached = await Result.tryPromise({
      try: async () => await parseMime(bytes),
      catch: (cause) => cause,
    });
    const fromHeaders = attached.isOk()
      ? attached.value.email.headers.filter(({ key }) => key === "from")
      : [];
    const fromHeader = fromHeaders.at(0);
    if (
      attached.isOk() &&
      fromHeaders.length === 1 &&
      fromHeader &&
      parseOneMailbox(fromHeader.value)
    ) {
      return {
        outerSender,
        message: normalizeMessage(attached.value.email, attached.value.date),
        forwardSource: "attached",
        originalRaw: bytes,
      };
    }
  }
  if (rfc822Parts.length > 1) {
    return { outerSender, message, forwardSource: "none" };
  }
  const forwarded = parseInlineForward(message);
  return forwarded
    ? { outerSender, message: forwarded, forwardSource: "inline" }
    : { outerSender, message, forwardSource: "none" };
};
