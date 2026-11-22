/**
 * Email (.eml / .msg) to self-contained HTML for preview rendering.
 *
 * LibreOffice cannot read either format, so we parse the message
 * ourselves into a normalized {@link ParsedEmail}, then render a
 * single HTML document (header block + body) that the inspector can
 * render in a sandboxed iframe.
 *
 * `cid:` inline images are embedded as data URIs. Remote resources
 * and all active content (scripts, event handlers, plugin embeds,
 * meta-refresh, javascript: URLs) are stripped before the browser sees
 * the document: email HTML is untrusted input.
 */
import { panic, Result, TaggedError } from "better-result";
import PostalMime, { type Address } from "postal-mime";

import {
  EMAIL_CITATION_BLOCK_MODE,
  EMAIL_HEADER_CITATION_ID,
  EMAIL_TEXT_ATTACHMENT_CHARSET,
  EMAIL_TEXT_ATTACHMENT_CHARSET_LABELS,
  type EmailAttachmentDescriptor,
  type EmailCitationBlock,
  type EmailCitationBlockMode,
  type EmailTextAttachmentCharset,
  MAX_EMAIL_CITATION_BLOCK_TEXT_LENGTH,
  MAX_EMAIL_CITATION_BLOCKS,
} from "@stll/api-contract";
import type { CertifiedEmailEnvelope } from "@stll/api-contract/certified-email";
import {
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
} from "@stll/api-contract/email-mime-types";
import { FILE_PART_KINDS, filePartId } from "@stll/api-contract/file-parts";
import { ownEntry } from "@stll/api-contract/own-key";
import type { Cheerio } from "@stll/html";
import {
  loadEmailDocument,
  serializeEmailNode,
  serializeEmailPreviewMarkup,
} from "@stll/html/email";
import { type Element, isTag, isText } from "@stll/html/nodes";

import { arrayOrEmpty } from "@/api/lib/array";
import {
  certifiedEmailText,
  mayBeCertificationData,
  readCertifiedEmailParts,
} from "@/api/lib/files/certified-email";
import { EMAIL_PREVIEW_PALETTE as PALETTE } from "@/api/lib/files/email-preview-palette";
import { EMAIL_SENDER_CLASS_CSS } from "@/api/lib/files/email-sender-styles";
import { parseOutlookMsg } from "@/api/lib/files/outlook-msg";
import { partMediaType } from "@/api/lib/files/part-media-type";
import { isRecord } from "@/api/lib/type-guards";

/** The most attachments an email's preview lists. */
const MAX_EMAIL_ATTACHMENT_DESCRIPTORS = 100;

const EMAIL_WRITING_DIRECTIONS = {
  auto: null,
  ltr: null,
  rtl: null,
} as const;

export class EmailParseError extends TaggedError("EmailParseError")<{
  message: string;
  mimeType: string;
  cause?: unknown;
}> {}

type InlineImage = { cid: string; mimeType: string; dataBase64: string };

export type EmailAttachment = {
  charset: EmailTextAttachmentCharset | null;
  contentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  bytes: Uint8Array;
};

type EmailBody =
  { type: "html"; html: string } | { type: "text"; text: string };

export type ParsedEmail = {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  date: string | null;
  body: EmailBody;
  inlineImages: InlineImage[];
  attachments: EmailAttachment[];
  /**
   * A certified email's certification data. The fields above are then the
   * original message's when the provider's message carries it, else the
   * provider's notice without the parts the envelope stands for.
   */
  certified: CertifiedEmailEnvelope | null;
};

/**
 * The safe, structured representation returned to the email inspector.
 * Downloadable attachment content remains parser-local: the preview never
 * returns attachment bytes or links. Safe inline CID image bytes may be
 * embedded in bodyHtml so the sandbox can render the message faithfully.
 */
export type EmailPreview = {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  date: string | null;
  attachments: EmailAttachmentDescriptor[];
  bodyFolds: EmailBodyFold[];
  bodyHtml: string;
  citationBlocks: EmailCitationBlock[];
  certified: CertifiedEmailEnvelope | null;
};

/**
 * Parse an email and render it to a single self-contained HTML
 * document. Dispatches on MIME type; `.msg` parsing is synchronous,
 * `.eml` is async.
 */
export const emailToHtml = async (
  fileBuffer: ArrayBuffer,
  mimeType: string,
): Promise<Result<string, EmailParseError>> => {
  const parsed = await parseEmail(fileBuffer, mimeType);
  if (parsed.isErr()) {
    return parsed;
  }
  return Result.try({
    try: () => renderEmailHtml(parsed.value),
    catch: (cause) =>
      cause instanceof EmailParseError
        ? cause
        : new EmailParseError({
            message: "Failed to parse email into HTML",
            mimeType,
            cause,
          }),
  });
};

type EmailPreviewOptions = {
  citationBlockMode?: EmailCitationBlockMode;
};

/** The type an email's attachment is listed and delivered as. */
export const emailAttachmentMediaType = async ({
  bytes,
  fileName,
  mimeType,
}: EmailAttachment): Promise<string> =>
  await partMediaType({ bytes, stated: mimeType, fileName });

const describeEmailAttachment = async (
  attachment: EmailAttachment,
  index: number,
): Promise<EmailAttachmentDescriptor> => ({
  part: filePartId({ kind: FILE_PART_KINDS.attachment, index }),
  charset: attachment.charset,
  fileName: attachment.fileName,
  mediaType: await emailAttachmentMediaType(attachment),
  sizeBytes: attachment.bytes.byteLength,
});

/** An email's attachments as its preview lists them: parts of the file. */
export const describeEmailAttachments = async (
  parsed: ParsedEmail,
  listed: EmailPreviewListing["attachments"],
): Promise<EmailAttachmentDescriptor[]> =>
  await Promise.all(
    listed.flatMap((index) => {
      const attachment = parsed.attachments.at(index);
      return attachment === undefined
        ? []
        : [describeEmailAttachment(attachment, index)];
    }),
  );

export const emailToPreview = async (
  fileBuffer: ArrayBuffer,
  mimeType: string,
  options: EmailPreviewOptions = {},
): Promise<Result<EmailPreview, EmailParseError>> => {
  const parsed = await parseEmail(fileBuffer, mimeType);
  if (parsed.isErr()) {
    return parsed;
  }
  const toParseError = (cause: unknown) =>
    cause instanceof EmailParseError
      ? cause
      : new EmailParseError({
          message: "Failed to parse email preview",
          mimeType,
          cause,
        });
  const listing = Result.try({
    try: () => buildEmailPreview(parsed.value, options),
    catch: toParseError,
  });
  if (listing.isErr()) {
    return listing;
  }
  const attachments = await Result.tryPromise({
    try: async () =>
      await describeEmailAttachments(parsed.value, listing.value.attachments),
    catch: toParseError,
  });
  return attachments.map((described) => ({
    ...listing.value,
    attachments: described,
  }));
};

/**
 * An email's preview before its attachments are typed: the attachments are
 * their positions in the parsed email, which address them as parts.
 */
export type EmailPreviewListing = Omit<EmailPreview, "attachments"> & {
  attachments: readonly number[];
};

export const buildEmailPreview = (
  parsed: ParsedEmail,
  {
    citationBlockMode = EMAIL_CITATION_BLOCK_MODE.include,
  }: EmailPreviewOptions = {},
): EmailPreviewListing => {
  const inlineContentIds = new Set(
    parsed.inlineImages.map(({ cid }) => cid.toLowerCase()),
  );
  const headerCitationBlocks =
    citationBlockMode === EMAIL_CITATION_BLOCK_MODE.include
      ? buildEmailHeaderCitationBlocks(parsed)
      : [];
  const renderedBody = renderEmailBody(
    parsed,
    citationBlockMode === EMAIL_CITATION_BLOCK_MODE.include
      ? MAX_EMAIL_CITATION_BLOCKS - headerCitationBlocks.length
      : 0,
  );

  return {
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    date: parsed.date,
    attachments: parsed.attachments
      .map((attachment, attachmentIndex) => ({ attachment, attachmentIndex }))
      .filter(
        ({ attachment: { contentId } }) =>
          !contentId ||
          !inlineContentIds.has(contentId.toLowerCase()) ||
          !renderedBody.referencedContentIds.has(contentId.toLowerCase()),
      )
      .slice(0, MAX_EMAIL_ATTACHMENT_DESCRIPTORS)
      .map(({ attachmentIndex }) => attachmentIndex),
    bodyFolds: renderedBody.bodyFolds,
    bodyHtml: renderedBody.bodyHtml,
    citationBlocks: [...headerCitationBlocks, ...renderedBody.citationBlocks],
    certified: parsed.certified,
  };
};

const buildEmailHeaderCitationBlocks = (
  parsed: ParsedEmail,
): EmailCitationBlock[] => {
  const values = [
    [EMAIL_HEADER_CITATION_ID.subject, parsed.subject],
    [EMAIL_HEADER_CITATION_ID.from, parsed.from],
    [EMAIL_HEADER_CITATION_ID.to, parsed.to.join(", ")],
    [EMAIL_HEADER_CITATION_ID.cc, parsed.cc.join(", ")],
    [EMAIL_HEADER_CITATION_ID.bcc, parsed.bcc.join(", ")],
    [EMAIL_HEADER_CITATION_ID.date, parsed.date],
  ] as const;

  return values.flatMap(([id, value]) => {
    const text = normalizeEmailCitationText(value ?? "");
    return text.length === 0 ? [] : [{ id, text }];
  });
};

export const parseEmail = async (
  fileBuffer: ArrayBuffer,
  mimeType: string,
): Promise<Result<ParsedEmail, EmailParseError>> => {
  if (mimeType === MSG_MIME_TYPE) {
    return Result.try({
      try: () => parseMsg(fileBuffer),
      catch: (cause) =>
        new EmailParseError({
          message: "Failed to parse email",
          mimeType,
          cause,
        }),
    });
  }
  return await parseEml(fileBuffer);
};

/** The message's headers and body as text, without its certification data. */
const emailMessageText = (parsed: ParsedEmail): string => {
  const parts: string[] = [];
  const rows = [
    ["From", parsed.from],
    ["To", parsed.to.join(", ")],
    ["Cc", parsed.cc.join(", ")],
    ["Bcc", parsed.bcc.join(", ")],
    ["Date", parsed.date],
    ["Subject", parsed.subject],
  ] as const;

  for (const [label, value] of rows) {
    if (value && value.trim().length > 0) {
      parts.push(`${label}: ${value}`);
    }
  }

  const body = emailBodyToText(parsed.body);
  if (body) {
    parts.push(body);
  }

  return normalizeExtractedText(parts.join("\n"));
};

/** The email as text: a certified email's certification data, then the message. */
export const parsedEmailToText = (parsed: ParsedEmail): string => {
  const message = emailMessageText(parsed);
  if (parsed.certified === null) {
    return message;
  }
  return normalizeExtractedText(
    [certifiedEmailText(parsed.certified), message].join("\n"),
  );
};

// ── .eml parsing (postal-mime) ──────────────────────────

const normalizeEmailAttachmentCharset = (
  value: unknown,
): EmailTextAttachmentCharset | null => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    !/^[a-z0-9._:-]+$/iu.test(normalized)
  ) {
    return null;
  }

  return (
    Object.values(EMAIL_TEXT_ATTACHMENT_CHARSET).find((charset) =>
      EMAIL_TEXT_ATTACHMENT_CHARSET_LABELS[charset].some(
        (label) => label === normalized,
      ),
    ) ?? null
  );
};

const resolveEmailAttachmentCharset = (
  mimeType: string | null,
): EmailTextAttachmentCharset | null => {
  if (!mimeType) {
    return null;
  }
  const charsetMatch =
    /(?:^|;)\s*charset\s*=\s*(?:"(?<quoted>[^"]+)"|(?<bare>[^;\s]+))/iu.exec(
      mimeType,
    );
  return normalizeEmailAttachmentCharset(
    charsetMatch?.groups?.["quoted"] ?? charsetMatch?.groups?.["bare"],
  );
};

const buildPostalMimeAttachmentCharsetLookup = (
  parser: unknown,
): Map<unknown, EmailTextAttachmentCharset | null> => {
  const lookup = new Map<unknown, EmailTextAttachmentCharset | null>();
  // PostalMime omits attachment Content-Type parameters from its public
  // result. Its parsed node retains them; fail if that internal contract
  // drifts so non-UTF-8 attachments cannot silently render as corrupted text.
  if (!isRecord(parser) || !isRecord(parser["root"])) {
    return panic("PostalMime parser tree has an unexpected shape");
  }

  const visit = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }

    const content = node["content"];
    if (content !== undefined) {
      const contentType = node["contentType"];
      if (!isRecord(contentType)) {
        panic("PostalMime content type has an unexpected shape");
      }
      const parsed = contentType["parsed"];
      if (!isRecord(parsed)) {
        panic("PostalMime parsed content type has an unexpected shape");
      }
      const params = parsed["params"];
      if (!isRecord(params)) {
        panic("PostalMime content type parameters have an unexpected shape");
      }
      const charset = params["charset"];
      if (charset !== undefined && typeof charset !== "string") {
        panic("PostalMime attachment charset has an unexpected shape");
      }
      lookup.set(content, normalizeEmailAttachmentCharset(charset));
    }

    const childNodes = node["childNodes"];
    if (!Array.isArray(childNodes)) {
      return;
    }
    for (const childNode of childNodes) {
      visit(childNode);
    }
  };

  visit(parser["root"]);
  return lookup;
};

type ParsedEmlMessage = Omit<ParsedEmail, "certified"> & {
  headerNames: string[];
};

const parseEmlMessage = async (
  fileBuffer: ArrayBuffer,
  { keepMessageParts = false }: { keepMessageParts?: boolean } = {},
): Promise<Result<ParsedEmlMessage, EmailParseError>> => {
  const parser = new PostalMime({
    attachmentEncoding: "arraybuffer",
    // A certified email's original message is one of its parts, not text.
    ...(keepMessageParts ? { forceRfc822Attachments: true } : {}),
  });
  const parsed = await Result.tryPromise({
    try: async () => await parser.parse(fileBuffer),
    catch: (cause) =>
      new EmailParseError({
        message: "Failed to parse email",
        mimeType: EML_MIME_TYPE,
        cause,
      }),
  });
  if (parsed.isErr()) {
    return parsed;
  }
  const email = parsed.value;
  const attachmentCharsets = buildPostalMimeAttachmentCharsetLookup(parser);
  // Read only when an inline message contributed attachments, see below.
  let nestedCharsets: Promise<NestedAttachmentCharset[]> | undefined;

  const inlineImages: InlineImage[] = [];
  const attachments: EmailAttachment[] = [];
  for (const attachment of email.attachments) {
    const bytes = attachmentContentToBytes(attachment.content);
    if (!bytes) {
      continue;
    }
    const charset = attachmentCharsets.has(attachment.content)
      ? (attachmentCharsets.get(attachment.content) ?? null)
      : nestedAttachmentCharset(
          await (nestedCharsets ??= readNestedAttachmentCharsets(parser)),
          { bytes, fileName: attachment.filename },
        );
    // Fail if the internal contract drifts so a non-UTF-8 attachment cannot
    // silently render as corrupted text.
    if (charset === undefined) {
      return Result.err(
        new EmailParseError({
          message: "PostalMime attachment is missing from its parser tree",
          mimeType: EML_MIME_TYPE,
        }),
      );
    }

    attachments.push({
      charset,
      contentId: attachment.contentId
        ? stripAngleBrackets(attachment.contentId)
        : null,
      fileName: attachment.filename,
      mimeType: attachment.mimeType,
      bytes,
    });

    if (
      attachment.contentId &&
      isSafeInlineImage(attachment.mimeType, attachment.filename)
    ) {
      inlineImages.push({
        cid: stripAngleBrackets(attachment.contentId),
        mimeType: resolveAttachmentMimeType(
          attachment.mimeType,
          attachment.filename,
        ),
        dataBase64: Buffer.from(bytes).toBase64(),
      });
    }
  }

  const to: string[] = [];
  for (const address of arrayOrEmpty(email.to)) {
    const formatted = formatAddress(address);
    if (nonEmpty(formatted)) {
      to.push(formatted);
    }
  }
  const cc: string[] = [];
  for (const address of arrayOrEmpty(email.cc)) {
    const formatted = formatAddress(address);
    if (nonEmpty(formatted)) {
      cc.push(formatted);
    }
  }
  const bcc: string[] = [];
  for (const address of arrayOrEmpty(email.bcc)) {
    const formatted = formatAddress(address);
    if (nonEmpty(formatted)) {
      bcc.push(formatted);
    }
  }

  return Result.ok({
    subject: email.subject ?? null,
    from: email.from ? formatAddress(email.from) : null,
    to,
    cc,
    bcc,
    date: email.date ?? null,
    body: email.html
      ? { type: "html", html: email.html }
      : { type: "text", text: email.text ?? "" },
    inlineImages,
    attachments,
    headerNames: email.headers.map(({ key }) => key),
  } satisfies ParsedEmlMessage);
};

const withoutHeaderNames = ({
  headerNames: _headerNames,
  ...message
}: ParsedEmlMessage): Omit<ParsedEmail, "certified"> => message;

const toOwnedArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength &&
  bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : bytes.slice().buffer;

type NestedAttachmentCharset = {
  bytes: Uint8Array;
  fileName: string | null;
  charset: EmailTextAttachmentCharset | null;
};

/**
 * Inline messages within inline messages, as deep as PostalMime parses them
 * (its `maxRfc822NestingDepth` default).
 */
const MAX_NESTED_MESSAGE_DEPTH = 10;

const messagePartContents = (node: unknown, found: ArrayBuffer[]) => {
  if (!isRecord(node)) {
    return found;
  }
  const contentType = node["contentType"];
  const content = node["content"];
  if (
    isRecord(contentType) &&
    isRecord(contentType["parsed"]) &&
    contentType["parsed"]["value"] === "message/rfc822" &&
    content instanceof ArrayBuffer
  ) {
    found.push(content);
  }
  const childNodes = node["childNodes"];
  if (Array.isArray(childNodes)) {
    for (const childNode of childNodes) {
      messagePartContents(childNode, found);
    }
  }
  return found;
};

/**
 * PostalMime parses an inline `message/rfc822` part with a nested parser and
 * keeps that parser's attachments but not its tree, where their charsets are.
 * Reading each message part again yields the same attachments with them.
 */
const readNestedAttachmentCharsets = async (
  parser: unknown,
  depth = 0,
): Promise<NestedAttachmentCharset[]> => {
  if (depth >= MAX_NESTED_MESSAGE_DEPTH || !isRecord(parser)) {
    return [];
  }
  const entries: NestedAttachmentCharset[] = [];
  for (const content of messagePartContents(parser["root"], [])) {
    const nested = new PostalMime({ attachmentEncoding: "arraybuffer" });
    const email = await Result.tryPromise(
      async () => await nested.parse(content),
    );
    if (email.isErr()) {
      continue;
    }
    const charsets = buildPostalMimeAttachmentCharsetLookup(nested);
    for (const attachment of email.value.attachments) {
      const bytes = attachmentContentToBytes(attachment.content);
      if (bytes && charsets.has(attachment.content)) {
        entries.push({
          bytes,
          fileName: attachment.filename,
          charset: charsets.get(attachment.content) ?? null,
        });
      }
    }
    entries.push(...(await readNestedAttachmentCharsets(nested, depth + 1)));
  }
  return entries;
};

const nestedAttachmentCharset = (
  entries: readonly NestedAttachmentCharset[],
  { bytes, fileName }: { bytes: Uint8Array; fileName: string | null },
): EmailTextAttachmentCharset | null | undefined => {
  const charsets = new Set(
    entries
      .filter(
        (entry) =>
          entry.fileName === fileName &&
          Buffer.from(entry.bytes).equals(Buffer.from(bytes)),
      )
      .map(({ charset }) => charset),
  );
  // Undefined when no parse found the attachment at all.
  if (charsets.size === 0) {
    return undefined;
  }
  // Identical attachments that declare different charsets name none.
  return charsets.size === 1 ? ([...charsets][0] ?? null) : null;
};

/**
 * An .eml file. A certified email (Italian PEC) is recognised by its parts:
 * it reads as its original message, or as the provider's notice, with the
 * certification data beside it.
 */
const parseEml = async (
  fileBuffer: ArrayBuffer,
): Promise<Result<ParsedEmail, EmailParseError>> => {
  const parsed = await parseEmlMessage(fileBuffer);
  if (
    parsed.isOk() &&
    !parsed.value.attachments.some(({ bytes }) => mayBeCertificationData(bytes))
  ) {
    return Result.ok({ ...withoutHeaderNames(parsed.value), certified: null });
  }
  // The provider's parts are read without parsing the original inline, so an
  // original the inline parse refuses still leaves the provider's notice.
  const provider = await parseEmlMessage(fileBuffer, {
    keepMessageParts: true,
  });
  const certified = provider.isOk()
    ? readCertifiedEmailParts({
        headerNames: provider.value.headerNames,
        parts: provider.value.attachments,
      })
    : null;
  if (!provider.isOk() || certified === null) {
    return parsed.isOk()
      ? Result.ok({ ...withoutHeaderNames(parsed.value), certified: null })
      : parsed;
  }
  if (certified.original !== null) {
    const original = await parseEmlMessage(
      toOwnedArrayBuffer(certified.original),
    );
    if (original.isOk()) {
      // A provider may attach parts of its own beside the original (6.3.4).
      const providerParts = provider.value.attachments.filter(
        (_, index) => !certified.certificationParts.has(index),
      );
      const message = withoutHeaderNames(original.value);
      return Result.ok({
        ...message,
        attachments: [...message.attachments, ...providerParts],
        certified: certified.envelope,
      });
    }
  }
  // Without a readable original, the provider's notice is the message; an
  // original that does not parse stays one of its attachments.
  const notice = withoutHeaderNames(provider.value);
  const unreadOriginal = certified.original;
  return Result.ok({
    ...notice,
    attachments: notice.attachments.filter(
      ({ bytes }, index) =>
        !certified.certificationParts.has(index) ||
        (unreadOriginal !== null && bytes === unreadOriginal),
    ),
    certified: certified.envelope,
  });
};

const formatAddress = (address: Address): string => {
  if (address.group) {
    const names: string[] = [];
    for (const member of address.group) {
      const formatted = formatNameAddress(member.name, member.address);
      if (nonEmpty(formatted)) {
        names.push(formatted);
      }
    }
    return names.join(", ");
  }
  return formatNameAddress(address.name, address.address) ?? "";
};

// ── .msg parsing (narrow in-repo CFB/MAPI reader) ───────

const IMAGE_EXTENSION_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
} as const;

const SAFE_INLINE_IMAGE_MIME_TYPES = new Set<string>(
  Object.values(IMAGE_EXTENSION_MIME),
);
const GENERIC_ATTACHMENT_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

const parseMsg = (fileBuffer: ArrayBuffer): ParsedEmail => {
  const data = parseOutlookMsg(fileBuffer);

  const inlineImages: InlineImage[] = [];
  const attachments: EmailAttachment[] = [];
  for (const attachment of data.attachments) {
    if (!attachment.bytes) {
      continue;
    }

    attachments.push({
      charset: resolveEmailAttachmentCharset(attachment.mimeType),
      contentId: attachment.contentId
        ? stripAngleBrackets(attachment.contentId)
        : null,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
    });

    if (!attachment.contentId) {
      continue;
    }
    if (!isSafeInlineImage(attachment.mimeType, attachment.fileName)) {
      continue;
    }
    inlineImages.push({
      cid: stripAngleBrackets(attachment.contentId),
      mimeType: resolveAttachmentMimeType(
        attachment.mimeType,
        attachment.fileName,
      ),
      dataBase64: Buffer.from(attachment.bytes).toBase64(),
    });
  }

  const to: string[] = [];
  for (const recipient of data.to) {
    const formatted = formatNameAddress(recipient.name, recipient.email);
    if (nonEmpty(formatted)) {
      to.push(formatted);
    }
  }
  const cc: string[] = [];
  for (const recipient of data.cc) {
    const formatted = formatNameAddress(recipient.name, recipient.email);
    if (nonEmpty(formatted)) {
      cc.push(formatted);
    }
  }
  const bcc: string[] = [];
  for (const recipient of data.bcc) {
    const formatted = formatNameAddress(recipient.name, recipient.email);
    if (nonEmpty(formatted)) {
      bcc.push(formatted);
    }
  }

  return {
    subject: data.subject ?? null,
    from: formatNameAddress(data.fromName, data.fromEmail),
    to,
    cc,
    bcc,
    date: data.date,
    body: data.html
      ? { type: "html", html: data.html }
      : { type: "text", text: data.text ?? "" },
    inlineImages,
    attachments,
    certified: null,
  };
};

const guessImageMime = (fileName: string | undefined): string => {
  const extension = (fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
  return (
    ownEntry(IMAGE_EXTENSION_MIME, extension) ?? "application/octet-stream"
  );
};

const resolveAttachmentMimeType = (
  mimeType: string | null,
  fileName: string | null,
): string => {
  const normalized = mimeType?.split(";").at(0)?.trim().toLowerCase() ?? "";
  if (GENERIC_ATTACHMENT_MIME_TYPES.has(normalized)) {
    return guessImageMime(fileName ?? undefined);
  }
  return normalized;
};

const isSafeInlineImage = (
  mimeType: string | null,
  fileName: string | null,
): boolean =>
  SAFE_INLINE_IMAGE_MIME_TYPES.has(
    resolveAttachmentMimeType(mimeType, fileName),
  );

// ── HTML rendering + sanitization ───────────────────────

const HR_STYLE = `border: none; border-top: 1px solid ${PALETTE.divider}; margin: 12px 0;`;
const PRE_STYLE =
  "white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 13px; margin: 0;";
const EMAIL_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const EMAIL_PREVIEW_CSS = `
:root {
  color-scheme: light;
}
html {
  background: ${PALETTE.paper};
  color: ${PALETTE.ink};
}
body {
  background: ${PALETTE.paper};
  color: ${PALETTE.ink};
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.45;
  margin: 12px;
}
body, table, td, div, p, span {
  color-scheme: light;
}${EMAIL_SENDER_CLASS_CSS}
.postal-email-header {
  background: ${PALETTE.headerSurface};
  border: 1px solid ${PALETTE.headerBorder};
  border-radius: 8px 8px 0 0;
  font-size: 13px;
  margin: 16px 0 0;
  padding: 10px 12px;
}
.postal-email-header-row {
  display: grid;
  gap: 12px;
  grid-template-columns: minmax(48px, max-content) minmax(0, 1fr);
  padding: 2px 0;
}
.postal-email-header-key {
  color: ${PALETTE.label};
  white-space: nowrap;
}
.postal-email-header-value {
  min-width: 0;
  overflow-wrap: anywhere;
}
.postal-email-header + div {
  border: 1px solid ${PALETTE.headerBorder};
  border-radius: 0 0 8px 8px;
  border-top: 0;
  margin: 0 0 14px;
  padding: 12px;
}
.postal-email-address {
  color: inherit;
  text-decoration: none;
}
[data-stella-email-fold] {
  margin: 8px 0;
}
[data-stella-email-fold] > summary {
  align-items: center;
  border-radius: 6px;
  color: ${PALETTE.label};
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  list-style: none;
  min-height: 44px;
  min-width: 44px;
  user-select: none;
}
[data-stella-email-fold] > summary:hover {
  background: ${PALETTE.foldHoverSurface};
  color: ${PALETTE.foldHoverInk};
}
[data-stella-email-fold] > summary::-webkit-details-marker {
  display: none;
}
[data-stella-email-fold-label="open"] {
  display: none;
}
[data-stella-email-fold][open] > summary [data-stella-email-fold-label="closed"] {
  display: none;
}
[data-stella-email-fold][open] > summary [data-stella-email-fold-label="open"] {
  display: inline;
}
[data-stella-email-fold][open] > summary {
  margin-bottom: 8px;
}
[data-stella-email-citation-active] {
  background: ${PALETTE.citationSurface};
  border-radius: 3px;
  outline: 2px solid ${PALETTE.citationOutline};
  outline-offset: 2px;
}
.stella-email-plain-line {
  display: block;
  min-height: 1.45em;
}
`;

export const renderEmailHtml = (parsed: ParsedEmail): string => {
  const header = buildHeaderHtml(parsed);

  if (parsed.body.type === "text") {
    const $ = loadEmailDocument(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${EMAIL_PREVIEW_CSS}</style></head><body>${header}<hr style="${HR_STYLE}"><pre style="${PRE_STYLE}">${escapeHtml(parsed.body.text)}</pre></body></html>`,
    );
    return serializeEmailDocument($);
  }

  const $ = loadEmailDocument(parsed.body.html);
  sanitizeDom($);
  stripDuplicateNestedMessageHeaders($);
  inlineCidImages($, parsed.inlineImages);

  if ($("meta[charset]").length === 0) {
    $("head").prepend('<meta charset="utf-8">');
  }
  $("head").append('<meta name="color-scheme" content="light">');
  $("head").append(`<style>${EMAIL_PREVIEW_CSS}</style>`);
  $("body").prepend(`${header}<hr style="${HR_STYLE}">`);

  return serializeEmailDocument($);
};

/**
 * Render a self-contained document suitable for a sandboxed iframe. The
 * primary message metadata is intentionally excluded so the inspector can
 * display it once, outside untrusted email HTML. Nested message headers are
 * retained because they describe forwarded message content.
 */
type RenderedEmailBody = {
  bodyFolds: EmailBodyFold[];
  bodyHtml: string;
  citationBlocks: EmailCitationBlock[];
  referencedContentIds: Set<string>;
};

const renderEmailBody = (
  parsed: ParsedEmail,
  maxCitationBlocks = MAX_EMAIL_CITATION_BLOCKS,
): RenderedEmailBody => {
  if (parsed.body.type === "text") {
    const renderedTextBody = renderPlainTextBody(parsed.body.text);
    const $ = loadEmailDocument(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${EMAIL_PREVIEW_CSS}</style></head><body dir="auto">${renderedTextBody.html}</body></html>`,
    );
    const citationBlocks = annotateEmailCitationBlocks($, maxCitationBlocks);
    return {
      bodyFolds: renderedTextBody.bodyFolds,
      bodyHtml: serializeEmailDocument($),
      citationBlocks,
      referencedContentIds: new Set(),
    };
  }

  const $ = loadEmailDocument(parsed.body.html);
  sanitizeDom($);
  stripDuplicateNestedMessageHeaders($);
  const bodyFolds = foldQuotedHistoryAndSignatures($);
  const citationBlocks = annotateEmailCitationBlocks($, maxCitationBlocks);
  const referencedContentIds = getReferencedInlineContentIds($);
  inlineCidImages($, parsed.inlineImages);

  if ($("meta[charset]").length === 0) {
    $("head").prepend('<meta charset="utf-8">');
  }
  $("head").append('<meta name="color-scheme" content="light">');
  $("head").append(`<style>${EMAIL_PREVIEW_CSS}</style>`);
  if (!hasExplicitWritingDirection($)) {
    $("body").attr("dir", "auto");
  }

  return {
    bodyFolds,
    bodyHtml: serializeEmailDocument($),
    citationBlocks,
    referencedContentIds,
  };
};

export const renderEmailBodyHtml = (parsed: ParsedEmail): string =>
  renderEmailBody(parsed).bodyHtml;

export const sanitizeEmailBodyHtml = (html: string): string => {
  const $ = loadEmailDocument(html);
  sanitizeDom($);
  return serializeEmailDocument($);
};

const getReferencedInlineContentIds = ($: CheerioApi): Set<string> => {
  const contentIds = new Set<string>();
  $("img").each((_, element) => {
    const src = $(element).attr("src")?.trim();
    if (!src || !src.toLowerCase().startsWith("cid:")) {
      return;
    }
    contentIds.add(stripAngleBrackets(src.slice("cid:".length)).toLowerCase());
  });
  return contentIds;
};

const hasExplicitWritingDirection = ($: CheerioApi): boolean => {
  const htmlDirection = $("html").attr("dir")?.trim().toLowerCase();
  const bodyDirection = $("body").attr("dir")?.trim().toLowerCase();
  return (
    (htmlDirection !== undefined &&
      Object.hasOwn(EMAIL_WRITING_DIRECTIONS, htmlDirection)) ||
    (bodyDirection !== undefined &&
      Object.hasOwn(EMAIL_WRITING_DIRECTIONS, bodyDirection))
  );
};

export const emailBodyToText = (body: EmailBody): string => {
  if (body.type === "text") {
    return normalizeExtractedText(body.text);
  }

  const $ = loadEmailDocument(body.html);
  sanitizeDom($);
  stripDuplicateNestedMessageHeaders($);
  $("br").replaceWith("\n");
  $("p, div, tr, li, blockquote, h1, h2, h3, h4, h5, h6").append("\n");
  return normalizeExtractedText($.root().text());
};

const RAW_TEXT_CONTAINER_TAGS = [
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "template",
];

const STRIP_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "link",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "svg",
  "math",
  ...RAW_TEXT_CONTAINER_TAGS,
];

// oxlint-disable-next-line no-script-url -- listing the schemes we strip from untrusted HTML
const ACTIVE_URL_SCHEMES = ["javascript:", "vbscript:"];
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "background",
  "formaction",
  "poster",
  "ping",
  "srcset",
  "xlink:href",
]);
const FETCHING_URL_ATTRIBUTES = new Set([
  "src",
  "background",
  "poster",
  "ping",
  "srcset",
  "xlink:href",
]);
const PRESENTATION_COLOR_ATTRIBUTES = new Set([
  "alink",
  "bgcolor",
  "link",
  "text",
  "vlink",
]);
const SAFE_DATA_IMAGE_RE =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|tiff);base64,/iu;
const BR_TAG_RE = /<br\s*\/?>/iu;
const RFC822_HEADER_LINE_RE = /^[A-Za-z0-9-]+:/u;
const EMAIL_QUOTE_SELECTOR = [
  "blockquote[type='cite']",
  ".gmail_quote",
  ".protonmail_quote",
  ".yahoo_quoted",
  ".zmail_extra",
  "[data-marker='__QUOTED_TEXT__']",
].join(",");
const EMAIL_SIGNATURE_SELECTOR = [
  "#Signature",
  "#signature",
  ".AppleMailSignature",
  ".gmail_signature",
  ".moz-signature",
  ".protonmail_signature_block",
  ".yahoo_signature",
].join(",");
const EMAIL_FOLD_SELECTOR = `${EMAIL_QUOTE_SELECTOR},${EMAIL_SIGNATURE_SELECTOR}`;
const EMAIL_FOLD_KIND = {
  quote: "quoted-history",
  signature: "signature",
} as const;
const EMAIL_FOLD_FLOW_PARENT_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "li",
  "main",
  "nav",
  "section",
  "td",
  "th",
]);

type EmailFoldKind = (typeof EMAIL_FOLD_KIND)[keyof typeof EMAIL_FOLD_KIND];

type EmailBodyFold = {
  id: string;
  kind: EmailFoldKind;
};

type EmailFoldCandidate = {
  element: Element;
  kind: EmailFoldKind;
};

type EmailBodyToken =
  { type: "candidate"; candidate: EmailFoldCandidate } | { type: "content" };

type CheerioApi = ReturnType<typeof loadEmailDocument>;

const serializeEmailDocument = ($: CheerioApi): string => {
  $("noscript").remove();
  $("head").prepend(
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">`,
  );
  return `<!DOCTYPE html>${serializeEmailPreviewMarkup($)}`;
};

const sanitizeDom = ($: CheerioApi): void => {
  $(STRIP_TAGS.join(",")).remove();
  $("meta[http-equiv]").remove();
  $("meta[name]").each((_, node) => {
    const name = $(node).attr("name")?.toLowerCase();
    if (name === "color-scheme" || name === "supported-color-schemes") {
      $(node).remove();
    }
  });

  $("*").each((_, node) => {
    if (!isTag(node)) {
      return;
    }
    for (const attribute of Object.keys(node.attribs)) {
      const name = attribute.toLowerCase();
      if (PRESENTATION_COLOR_ATTRIBUTES.has(name)) {
        $(node).removeAttr(attribute);
        continue;
      }
      if (name.startsWith("data-stella-email-")) {
        $(node).removeAttr(attribute);
        continue;
      }
      if (name.startsWith("on") || name === "style") {
        $(node).removeAttr(attribute);
        continue;
      }
      if (!URL_ATTRIBUTES.has(name)) {
        continue;
      }
      const value = normalizeUrlAttribute(node.attribs[attribute] ?? "");
      if (ACTIVE_URL_SCHEMES.some((scheme) => value.startsWith(scheme))) {
        $(node).removeAttr(attribute);
        continue;
      }
      if (name === "href" && !isSafeLocalHref(value)) {
        $(node).removeAttr(attribute);
        continue;
      }
      if (name === "srcset") {
        $(node).removeAttr(attribute);
        continue;
      }
      if (FETCHING_URL_ATTRIBUTES.has(name) && !isSafeInlineResource(value)) {
        $(node).removeAttr(attribute);
      }
    }
  });
};

const foldQuotedHistoryAndSignatures = ($: CheerioApi): EmailBodyFold[] => {
  const candidates: EmailFoldCandidate[] = [];
  $(EMAIL_FOLD_SELECTOR).each((_, element) => {
    if (!isTag(element) || $(element).parents(EMAIL_FOLD_SELECTOR).length > 0) {
      return;
    }
    candidates.push({
      element,
      kind: $(element).is(EMAIL_QUOTE_SELECTOR)
        ? EMAIL_FOLD_KIND.quote
        : EMAIL_FOLD_KIND.signature,
    });
  });

  if (candidates.length === 0) {
    return [];
  }

  const candidateByElement = new Map(
    candidates.map((candidate) => [candidate.element, candidate]),
  );
  const tokens: EmailBodyToken[] = [];
  const visit = (element: Element): void => {
    const candidate = candidateByElement.get(element);
    if (candidate) {
      tokens.push({ type: "candidate", candidate });
      return;
    }

    if (element.name === "img" && nonEmpty($(element).attr("src"))) {
      tokens.push({ type: "content" });
    }

    for (const child of element.children) {
      if (isText(child)) {
        if (nonEmpty(child.data)) {
          tokens.push({ type: "content" });
        }
        continue;
      }
      if (isTag(child)) {
        visit(child);
      }
    }
  };

  const body = $("body").get(0);
  if (!body || !isTag(body)) {
    return [];
  }
  visit(body);

  const lastVisibleContentIndex = tokens.findLastIndex(
    (token) => token.type === "content",
  );
  if (lastVisibleContentIndex === -1) {
    return [];
  }

  const bodyFolds: EmailBodyFold[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "candidate" || index < lastVisibleContentIndex) {
      continue;
    }
    const bodyFold = {
      id: `fold-${bodyFolds.length}`,
      kind: token.candidate.kind,
    } satisfies EmailBodyFold;
    if (!wrapEmailFold($, token.candidate, bodyFold.id)) {
      continue;
    }
    bodyFolds.push(bodyFold);
  }
  return bodyFolds;
};

const wrapEmailFold = (
  $: CheerioApi,
  { element, kind }: EmailFoldCandidate,
  id: string,
): boolean => {
  const parent = element.parent;
  if (
    !parent ||
    !isTag(parent) ||
    !EMAIL_FOLD_FLOW_PARENT_TAGS.has(parent.name)
  ) {
    return false;
  }

  const details = $(
    `<details data-stella-email-fold="${kind}"><summary data-stella-email-fold-summary="${id}"></summary></details>`,
  );
  $(element).before(details);
  details.append(element);
  return true;
};

type PlainTextSection = {
  type: "content" | EmailFoldKind;
  text: string;
};

type RenderedPlainTextBody = {
  bodyFolds: EmailBodyFold[];
  html: string;
};

const renderPlainTextBody = (text: string): RenderedPlainTextBody => {
  const sections = splitPlainTextBody(text);
  const bodyFolds: EmailBodyFold[] = [];
  const html = sections
    .map(({ type, text: sectionText }) => {
      const lines = sectionText
        .split("\n")
        .map(
          (line) =>
            `<span class="stella-email-plain-line" data-stella-email-citation-unit>${escapeHtml(line)}</span>`,
        )
        .join("");
      const pre = `<pre style="${PRE_STYLE}">${lines}</pre>`;
      if (type === "content") {
        return pre;
      }
      const bodyFold = {
        id: `fold-${bodyFolds.length}`,
        kind: type,
      } satisfies EmailBodyFold;
      bodyFolds.push(bodyFold);
      return `<details data-stella-email-fold="${type}"><summary data-stella-email-fold-summary="${bodyFold.id}"></summary>${pre}</details>`;
    })
    .join("");
  return { bodyFolds, html };
};

const EMAIL_CITATION_BLOCK_TAG_NAMES = [
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "div",
  "dt",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "p",
  "pre",
  "section",
  "td",
  "th",
] as const;
const EMAIL_CITATION_BLOCK_TAGS = new Set<string>(
  EMAIL_CITATION_BLOCK_TAG_NAMES,
);

const isEmailCitationHidden = (element: Element): boolean =>
  element.attribs["hidden"] !== undefined ||
  element.attribs["aria-hidden"]?.trim().toLowerCase() === "true";

const EMAIL_CITATION_REPLACED_ELEMENT_TAGS = new Set([
  "audio",
  "canvas",
  "meter",
  "progress",
  "video",
]);
const EMAIL_CITATION_HIDDEN_CONTAINER_TAGS = new Set(["datalist"]);

const isEmailCitationInert = (element: Element): boolean =>
  element.name === "template" ||
  (element.name === "dialog" && element.attribs["open"] === undefined) ||
  element.attribs["popover"] !== undefined ||
  EMAIL_CITATION_HIDDEN_CONTAINER_TAGS.has(element.name) ||
  EMAIL_CITATION_REPLACED_ELEMENT_TAGS.has(element.name);

const isEmailCitationExcluded = (element: Element): boolean =>
  isEmailCitationHidden(element) || isEmailCitationInert(element);

const annotateEmailCitationBlocks = (
  $: CheerioApi,
  maxBlocks: number,
): EmailCitationBlock[] => {
  const blocks: EmailCitationBlock[] = [];
  const nextCandidate = createEmailCitationCandidateIterator($);
  while (blocks.length < maxBlocks) {
    const candidate = nextCandidate();
    if (!candidate) {
      break;
    }

    const text = normalizeEmailCitationText(
      collectEmailCitationText(candidate),
    );
    if (text.length === 0) {
      continue;
    }

    const id = `body-${String(blocks.length + 1).padStart(4, "0")}`;
    $(candidate)
      .removeAttr("data-stella-email-citation-unit")
      .attr("data-stella-email-anchor", id);
    blocks.push({ id, text });
  }
  $("[data-stella-email-citation-unit]").removeAttr(
    "data-stella-email-citation-unit",
  );
  return blocks;
};

type EmailCitationTraversalNode = Element["children"][number];

type EmailCitationCandidateFrame = {
  childIndex: number;
  element: Element;
  hasNestedCandidate: boolean;
  isCandidate: boolean;
};

const createEmailCitationCandidateFrame = (
  element: Element,
): EmailCitationCandidateFrame => ({
  childIndex: 0,
  element,
  hasNestedCandidate: false,
  isCandidate:
    EMAIL_CITATION_BLOCK_TAGS.has(element.name) ||
    element.attribs["data-stella-email-citation-unit"] !== undefined,
});

const createEmailCitationCandidateIterator = (
  $: CheerioApi,
): (() => Element | null) => {
  const body = $("body").get(0);
  const stack: EmailCitationCandidateFrame[] =
    body && isTag(body) && !isEmailCitationExcluded(body)
      ? [createEmailCitationCandidateFrame(body)]
      : [];

  return () => {
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (!frame) {
        return null;
      }

      const child = frame.element.children.at(frame.childIndex);
      frame.childIndex += 1;
      if (child) {
        if (isTag(child) && !isEmailCitationExcluded(child)) {
          stack.push(createEmailCitationCandidateFrame(child));
        }
        continue;
      }

      stack.pop();
      const containsCandidate = frame.isCandidate || frame.hasNestedCandidate;
      const parent = stack.at(-1);
      if (containsCandidate && parent) {
        parent.hasNestedCandidate = true;
      }
      if (frame.isCandidate && !frame.hasNestedCandidate) {
        return frame.element;
      }
    }
    return null;
  };
};

const collectEmailCitationText = (element: Element): string => {
  const parts: string[] = [];
  const stack: EmailCitationTraversalNode[] = element.children.toReversed();
  while (stack.length > 0) {
    const child = stack.pop();
    if (!child) {
      continue;
    }
    if (isText(child)) {
      parts.push(child.data);
      continue;
    }
    if (!isTag(child)) {
      continue;
    }
    if (isEmailCitationExcluded(child)) {
      continue;
    }
    if (child.name === "br") {
      parts.push("\n");
      continue;
    }
    if (
      EMAIL_CITATION_BLOCK_TAGS.has(child.name) ||
      child.attribs["data-stella-email-citation-unit"] !== undefined
    ) {
      continue;
    }
    for (let index = child.children.length - 1; index >= 0; index--) {
      const descendant = child.children.at(index);
      if (descendant) {
        stack.push(descendant);
      }
    }
  }
  return parts.join("");
};

const normalizeEmailCitationText = (text: string): string =>
  truncateEmailCitationText(text.replace(/\s+/gu, " ").trim());

const truncateEmailCitationText = (text: string): string => {
  let truncated = "";
  let codePointCount = 0;
  for (const codePoint of text) {
    if (codePointCount >= MAX_EMAIL_CITATION_BLOCK_TEXT_LENGTH) {
      break;
    }
    truncated += codePoint;
    codePointCount += 1;
  }
  return truncated;
};

const splitPlainTextBody = (text: string): PlainTextSection[] => {
  const lines = text.split("\n");
  let quoteStart = lines.length;
  let foundQuote = false;

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.replace(/\r$/u, "") ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    if (/^\s*>/u.test(line)) {
      foundQuote = true;
      quoteStart = index;
      continue;
    }
    break;
  }

  if (!foundQuote) {
    quoteStart = lines.length;
  }

  let signatureStart = -1;
  for (let index = quoteStart - 1; index > 0; index--) {
    const line = lines[index]?.replace(/\r$/u, "") ?? "";
    if (line === "-- ") {
      signatureStart = index;
      break;
    }
  }

  const firstFoldStart = signatureStart === -1 ? quoteStart : signatureStart;
  if (firstFoldStart === lines.length) {
    return [{ type: "content", text }];
  }

  const visibleText = lines.slice(0, firstFoldStart).join("\n");
  if (!nonEmpty(visibleText)) {
    return [{ type: "content", text }];
  }

  const sections: PlainTextSection[] = [{ type: "content", text: visibleText }];
  if (signatureStart !== -1) {
    sections.push({
      type: EMAIL_FOLD_KIND.signature,
      text: lines.slice(signatureStart, quoteStart).join("\n"),
    });
  }
  if (foundQuote) {
    sections.push({
      type: EMAIL_FOLD_KIND.quote,
      text: lines.slice(quoteStart).join("\n"),
    });
  }
  return sections;
};

const stripDuplicateNestedMessageHeaders = ($: CheerioApi): void => {
  $(".postal-email-header").each((_, header) => {
    const body = $(header).next();
    stripLeadingRfc822Headers(body);
  });
};

const stripLeadingRfc822Headers = (body: ReturnType<CheerioApi>): void => {
  const bodyNode = body.get(0);
  if (!bodyNode || !isTag(bodyNode)) {
    return;
  }

  const html = body
    .contents()
    .toArray()
    .map((node) => serializeEmailNode(node))
    .join("");
  if (!html) {
    return;
  }

  const parts = html.split(BR_TAG_RE);
  const blankIndex = parts.findIndex((part) => part.trim() === "");
  if (blankIndex <= 0) {
    return;
  }

  const headerLines = parts.slice(0, blankIndex);
  if (!headerLines.every((part) => RFC822_HEADER_LINE_RE.test(part.trim()))) {
    return;
  }

  const fragment = loadEmailDocument(parts.slice(blankIndex + 1).join("<br>"));
  body.empty().append(fragment("body").contents());
};

const normalizeUrlAttribute = (value: string): string => {
  let normalized = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      char.trim() === ""
    ) {
      continue;
    }
    normalized += char;
  }
  return normalized.toLowerCase();
};

const isSafeInlineResource = (value: string): boolean =>
  value.startsWith("cid:") || SAFE_DATA_IMAGE_RE.test(value);

const isSafeLocalHref = (value: string): boolean => value.startsWith("#");

const inlineCidImages = ($: CheerioApi, images: InlineImage[]): void => {
  const byCid = new Map(
    images.map((image) => [image.cid.toLowerCase(), image] as const),
  );

  $("img").each((_, element) => {
    const image: Cheerio<Element> = $(element);
    const src = image.attr("src")?.trim();
    if (!src || !src.toLowerCase().startsWith("cid:")) {
      return;
    }
    const cid = stripAngleBrackets(src.slice("cid:".length)).toLowerCase();
    const match = byCid.get(cid);
    if (match) {
      if (!isSafeInlineImage(match.mimeType, null)) {
        image.removeAttr("src");
        return;
      }
      image.attr("src", `data:${match.mimeType};base64,${match.dataBase64}`);
      return;
    }
    // Unresolved cid: would otherwise render as a broken-image icon.
    image.removeAttr("src");
  });
};

const buildHeaderHtml = (parsed: ParsedEmail): string => {
  const rows: string[] = [];
  const addRow = (label: string, value: string | null) => {
    if (value && value.trim().length > 0) {
      rows.push(
        `<tr><td style="padding: 2px 12px 2px 0; color: ${PALETTE.label}; vertical-align: top; white-space: nowrap;">${escapeHtml(label)}</td><td style="padding: 2px 0; color: ${PALETTE.ink};">${escapeHtml(value)}</td></tr>`,
      );
    }
  };

  addRow("From", parsed.from);
  addRow("To", parsed.to.join(", "));
  addRow("Cc", parsed.cc.join(", "));
  addRow("Bcc", parsed.bcc.join(", "));
  addRow("Date", parsed.date);
  addRow("Subject", parsed.subject);

  return `<table style="border-collapse: collapse; font-family: -apple-system, system-ui, sans-serif; font-size: 13px; margin-bottom: 4px;">${rows.join("")}</table>`;
};

// ── small helpers ───────────────────────────────────────

const formatNameAddress = (
  name: string | null | undefined,
  address: string | null | undefined,
): string | null => {
  const trimmedName = name?.trim();
  const trimmedAddress = address?.trim();
  if (trimmedName && trimmedAddress) {
    return `${trimmedName} <${trimmedAddress}>`;
  }
  return trimmedAddress || trimmedName || null;
};

const stripAngleBrackets = (value: string): string =>
  value.replace(/^<|>$/gu, "").trim();

const nonEmpty = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim().length > 0;

const attachmentContentToBytes = (
  content: ArrayBuffer | Uint8Array | string,
): Uint8Array | null => {
  if (typeof content === "string") {
    return Buffer.from(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  return content;
};

const normalizeExtractedText = (value: string): string =>
  value
    .replace(/\u00a0/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (char) => ownEntry(HTML_ESCAPES, char) ?? char);
