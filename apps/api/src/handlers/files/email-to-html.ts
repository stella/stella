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
import { Result, TaggedError } from "better-result";
import { type Cheerio, load } from "cheerio";
import { type Element, isTag } from "domhandler";
import PostalMime, { type Address } from "postal-mime";

import { parseOutlookMsg } from "@/api/handlers/files/outlook-msg";

export const EML_MIME_TYPE = "message/rfc822";
export const MSG_MIME_TYPE = "application/vnd.ms-outlook";

export const EMAIL_MIME_TYPES = {
  [EML_MIME_TYPE]: null,
  [MSG_MIME_TYPE]: null,
} as const satisfies Record<string, null>;

const EMAIL_EXTENSION_MIME_TYPES: Record<string, string> = {
  eml: EML_MIME_TYPE,
  msg: MSG_MIME_TYPE,
};

export const isEmailMimeType = (mimeType: string): boolean =>
  mimeType in EMAIL_MIME_TYPES;

export const resolveEmailMimeType = ({
  fileName,
  mimeType,
}: {
  fileName: string;
  mimeType: string;
}): string | null => {
  if (isEmailMimeType(mimeType)) {
    return mimeType;
  }

  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return EMAIL_EXTENSION_MIME_TYPES[extension] ?? null;
};

export class EmailParseError extends TaggedError("EmailParseError")<{
  message: string;
  mimeType: string;
  cause?: unknown;
}>() {}

type InlineImage = { cid: string; mimeType: string; dataBase64: string };

export type EmailAttachment = {
  contentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  bytes: Uint8Array;
};

type EmailBody =
  | { type: "html"; html: string }
  | { type: "text"; text: string };

export type ParsedEmail = {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  body: EmailBody;
  inlineImages: InlineImage[];
  attachments: EmailAttachment[];
};

/**
 * Parse an email and render it to a single self-contained HTML
 * document. Dispatches on MIME type; `.msg` parsing is synchronous,
 * `.eml` is async.
 */
export const emailToHtml = async (
  fileBuffer: ArrayBuffer,
  mimeType: string,
): Promise<Result<string, EmailParseError>> =>
  await Result.tryPromise({
    try: async () => {
      const parsed = await parseEmail(fileBuffer, mimeType);
      return renderEmailHtml(parsed);
    },
    catch: (cause) =>
      new EmailParseError({
        message: "Failed to parse email into HTML",
        mimeType,
        cause,
      }),
  });

export const parseEmail = async (
  fileBuffer: ArrayBuffer,
  mimeType: string,
): Promise<ParsedEmail> => {
  if (mimeType === MSG_MIME_TYPE) {
    return parseMsg(fileBuffer);
  }
  return await parseEml(fileBuffer);
};

export const parsedEmailToText = (parsed: ParsedEmail): string => {
  const parts: string[] = [];
  const rows = [
    ["From", parsed.from],
    ["To", parsed.to.join(", ")],
    ["Cc", parsed.cc.join(", ")],
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

// ── .eml parsing (postal-mime) ──────────────────────────

const parseEml = async (fileBuffer: ArrayBuffer): Promise<ParsedEmail> => {
  const email = await PostalMime.parse(fileBuffer, {
    attachmentEncoding: "arraybuffer",
  });

  const inlineImages: InlineImage[] = [];
  const attachments: EmailAttachment[] = [];
  for (const attachment of email.attachments) {
    const bytes = attachmentContentToBytes(attachment.content);
    if (!bytes) {
      continue;
    }

    attachments.push({
      contentId: attachment.contentId
        ? stripAngleBrackets(attachment.contentId)
        : null,
      fileName: attachment.filename,
      mimeType: attachment.mimeType,
      bytes,
    });

    if (attachment.contentId && attachment.mimeType.startsWith("image/")) {
      inlineImages.push({
        cid: stripAngleBrackets(attachment.contentId),
        mimeType: attachment.mimeType,
        dataBase64: Buffer.from(bytes).toString("base64"),
      });
    }
  }

  return {
    subject: email.subject ?? null,
    from: email.from ? formatAddress(email.from) : null,
    to: (email.to ?? []).map(formatAddress).filter(nonEmpty),
    cc: (email.cc ?? []).map(formatAddress).filter(nonEmpty),
    date: email.date ?? null,
    body: email.html
      ? { type: "html", html: email.html }
      : { type: "text", text: email.text ?? "" },
    inlineImages,
    attachments,
  };
};

const formatAddress = (address: Address): string => {
  if (address.group) {
    return address.group
      .map((member) => formatNameAddress(member.name, member.address))
      .filter(nonEmpty)
      .join(", ");
  }
  return formatNameAddress(address.name, address.address) ?? "";
};

// ── .msg parsing (narrow in-repo CFB/MAPI reader) ───────

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const parseMsg = (fileBuffer: ArrayBuffer): ParsedEmail => {
  const data = parseOutlookMsg(fileBuffer);

  const inlineImages: InlineImage[] = [];
  const attachments: EmailAttachment[] = [];
  for (const attachment of data.attachments) {
    if (!attachment.bytes) {
      continue;
    }

    attachments.push({
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
    if (!isImageMimeType(attachment.mimeType, attachment.fileName)) {
      continue;
    }
    inlineImages.push({
      cid: stripAngleBrackets(attachment.contentId),
      mimeType:
        attachment.mimeType ?? guessImageMime(attachment.fileName ?? undefined),
      dataBase64: Buffer.from(attachment.bytes).toString("base64"),
    });
  }

  return {
    subject: data.subject ?? null,
    from: formatNameAddress(data.fromName, data.fromEmail),
    to: data.to
      .map((recipient) => formatNameAddress(recipient.name, recipient.email))
      .filter(nonEmpty),
    cc: data.cc
      .map((recipient) => formatNameAddress(recipient.name, recipient.email))
      .filter(nonEmpty),
    date: data.date,
    body: data.html
      ? { type: "html", html: data.html }
      : { type: "text", text: data.text ?? "" },
    inlineImages,
    attachments,
  };
};

const guessImageMime = (fileName: string | undefined): string => {
  const extension = (fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSION_MIME[extension] ?? "application/octet-stream";
};

const isImageMimeType = (
  mimeType: string | null,
  fileName: string | null,
): boolean =>
  (mimeType ?? guessImageMime(fileName ?? undefined)).startsWith("image/");

// ── HTML rendering + sanitization ───────────────────────

const HR_STYLE = "border: none; border-top: 1px solid #d4d4d8; margin: 12px 0;";
const PRE_STYLE =
  "white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 13px; margin: 0;";
const EMAIL_PREVIEW_CSS = `
:root {
  color-scheme: light;
}
html {
  background: #fff;
  color: #18181b;
}
body {
  background: #fff;
  color: #18181b;
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.45;
  margin: 12px;
}
body, table, td, div, p, span {
  color-scheme: light;
}
.primary-text {
  color: #3c4043;
}
.secondary-text, .grey-button-text {
  color: #70757a;
}
.accent-text {
  color: #1a73e8;
}
.primary-button {
  background: #1a73e8;
  border-radius: 4px;
  color: #fff;
}
.primary-button-text {
  color: #fff;
}
.postal-email-header {
  background: #fafafa;
  border: 1px solid #e4e4e7;
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
  color: #71717a;
  white-space: nowrap;
}
.postal-email-header-value {
  min-width: 0;
  overflow-wrap: anywhere;
}
.postal-email-header + div {
  border: 1px solid #e4e4e7;
  border-radius: 0 0 8px 8px;
  border-top: 0;
  margin: 0 0 14px;
  padding: 12px;
}
.postal-email-address {
  color: inherit;
  text-decoration: none;
}
`;

export const renderEmailHtml = (parsed: ParsedEmail): string => {
  const header = buildHeaderHtml(parsed);

  if (parsed.body.type === "text") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${EMAIL_PREVIEW_CSS}</style></head><body>${header}<hr style="${HR_STYLE}"><pre style="${PRE_STYLE}">${escapeHtml(parsed.body.text)}</pre></body></html>`;
  }

  const $ = load(parsed.body.html);
  sanitizeDom($);
  stripDuplicateNestedMessageHeaders($);
  inlineCidImages($, parsed.inlineImages);

  if ($("meta[charset]").length === 0) {
    $("head").prepend('<meta charset="utf-8">');
  }
  $("head").append('<meta name="color-scheme" content="light">');
  $("head").append(`<style>${EMAIL_PREVIEW_CSS}</style>`);
  $("body").prepend(`${header}<hr style="${HR_STYLE}">`);

  return $.html();
};

const emailBodyToText = (body: EmailBody): string => {
  if (body.type === "text") {
    return normalizeExtractedText(body.text);
  }

  const $ = load(body.html);
  sanitizeDom($);
  stripDuplicateNestedMessageHeaders($);
  $("br").replaceWith("\n");
  $("p, div, tr, li, blockquote, h1, h2, h3, h4, h5, h6").append("\n");
  return normalizeExtractedText($.root().text());
};

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
];

// eslint-disable-next-line no-script-url -- listing the schemes we strip from untrusted HTML
const ACTIVE_URL_SCHEMES = ["javascript:", "vbscript:"];
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "background",
  "formaction",
  "poster",
  "srcset",
  "xlink:href",
]);
const FETCHING_URL_ATTRIBUTES = new Set([
  "src",
  "background",
  "poster",
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

type CheerioApi = ReturnType<typeof load>;

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

const stripDuplicateNestedMessageHeaders = ($: CheerioApi): void => {
  $(".postal-email-header").each((_, header) => {
    const body = $(header).next();
    const bodyNode = body.get(0);
    if (!bodyNode || !isTag(bodyNode)) {
      return;
    }

    const html = body.html();
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

    body.html(parts.slice(blankIndex + 1).join("<br>"));
  });
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
  if (images.length === 0) {
    return;
  }
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
        `<tr><td style="padding: 2px 12px 2px 0; color: #71717a; vertical-align: top; white-space: nowrap;">${escapeHtml(label)}</td><td style="padding: 2px 0; color: #18181b;">${escapeHtml(value)}</td></tr>`,
      );
    }
  };

  addRow("From", parsed.from);
  addRow("To", parsed.to.join(", "));
  addRow("Cc", parsed.cc.join(", "));
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

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);
