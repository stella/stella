/**
 * Email (.eml / .msg) to self-contained HTML for PDF rendering.
 *
 * LibreOffice cannot read either format, so we parse the message
 * ourselves into a normalized {@link ParsedEmail}, then render a
 * single HTML document (header block + body) that the Chromium
 * route in `gotenberg.ts` turns into a PDF derivative.
 *
 * `cid:` inline images are embedded as data URIs. Remote resources
 * are left intact (the renderer fetches them) but all active
 * content (scripts, event handlers, plugin embeds, meta-refresh,
 * javascript: URLs) is stripped: email HTML is untrusted input.
 */
import { decompressRTF } from "@kenjiuno/decompressrtf";
import MsgReader from "@kenjiuno/msgreader";
import { Result, TaggedError } from "better-result";
import { type Cheerio, load } from "cheerio";
import { type Element, isTag } from "domhandler";
import PostalMime, { type Address } from "postal-mime";
import { deEncapsulateSync } from "rtf-stream-parser";

const EML_MIME_TYPE = "message/rfc822";
const MSG_MIME_TYPE = "application/vnd.ms-outlook";

export const EMAIL_MIME_TYPES = {
  [EML_MIME_TYPE]: null,
  [MSG_MIME_TYPE]: null,
} as const satisfies Record<string, null>;

export const isEmailMimeType = (mimeType: string): boolean =>
  mimeType in EMAIL_MIME_TYPES;

export class EmailParseError extends TaggedError("EmailParseError")<{
  message: string;
  mimeType: string;
  cause?: unknown;
}>() {}

type InlineImage = { cid: string; mimeType: string; dataBase64: string };

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
      const parsed =
        mimeType === MSG_MIME_TYPE
          ? parseMsg(fileBuffer)
          : await parseEml(fileBuffer);
      return renderEmailHtml(parsed);
    },
    catch: (cause) =>
      new EmailParseError({
        message: "Failed to parse email into HTML",
        mimeType,
        cause,
      }),
  });

// ── .eml parsing (postal-mime) ──────────────────────────

const parseEml = async (fileBuffer: ArrayBuffer): Promise<ParsedEmail> => {
  const email = await PostalMime.parse(fileBuffer, {
    attachmentEncoding: "base64",
  });

  const inlineImages: InlineImage[] = [];
  for (const attachment of email.attachments) {
    if (!attachment.contentId || typeof attachment.content !== "string") {
      continue;
    }
    if (!attachment.mimeType.startsWith("image/")) {
      continue;
    }
    inlineImages.push({
      cid: stripAngleBrackets(attachment.contentId),
      mimeType: attachment.mimeType,
      dataBase64: attachment.content,
    });
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

// ── .msg parsing (msgreader + RTF de-encapsulation) ─────

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
  const reader = new MsgReader(fileBuffer);
  const data = reader.getFileData();

  const inlineImages: InlineImage[] = [];
  for (const attachment of data.attachments ?? []) {
    if (!attachment.pidContentId) {
      continue;
    }
    const bytes = Result.try({
      try: () => reader.getAttachment(attachment).content,
      catch: (cause) => cause,
    });
    if (Result.isError(bytes)) {
      continue;
    }
    inlineImages.push({
      cid: stripAngleBrackets(attachment.pidContentId),
      mimeType: attachment.attachMimeTag ?? guessImageMime(attachment.fileName),
      dataBase64: Buffer.from(bytes.value).toString("base64"),
    });
  }

  return {
    subject: data.subject ?? null,
    from: formatNameAddress(
      data.senderName,
      data.senderSmtpAddress ?? data.senderEmail,
    ),
    to: msgRecipients(data.recipients, "to"),
    cc: msgRecipients(data.recipients, "cc"),
    date: data.messageDeliveryTime ?? data.clientSubmitTime ?? null,
    body: msgBody(data),
    inlineImages,
  };
};

type MsgRecipient = {
  name?: string;
  email?: string;
  smtpAddress?: string;
  recipType?: "to" | "cc" | "bcc";
};

const msgRecipients = (
  recipients: MsgRecipient[] | undefined,
  kind: "to" | "cc",
): string[] =>
  (recipients ?? [])
    .filter((recipient) => (recipient.recipType ?? "to") === kind)
    .map((recipient) =>
      formatNameAddress(
        recipient.name,
        recipient.smtpAddress ?? recipient.email,
      ),
    )
    .filter(nonEmpty);

type MsgBodyFields = {
  bodyHtml?: string;
  html?: Uint8Array;
  compressedRtf?: Uint8Array;
  body?: string;
};

const msgBody = (data: MsgBodyFields): EmailBody => {
  if (data.bodyHtml) {
    return { type: "html", html: data.bodyHtml };
  }
  if (data.html) {
    return { type: "html", html: new TextDecoder().decode(data.html) };
  }
  if (data.compressedRtf) {
    const fromRtf = deEncapsulateRtf(data.compressedRtf);
    if (fromRtf) {
      return fromRtf;
    }
  }
  return { type: "text", text: data.body ?? "" };
};

/**
 * Outlook stores HTML/text bodies as "encapsulated" content inside
 * compressed RTF. `deEncapsulateSync` recovers the original HTML;
 * for genuine (non-encapsulated) RTF it throws, and we fall back to
 * the plain-text body.
 */
const deEncapsulateRtf = (compressedRtf: Uint8Array): EmailBody | null => {
  const rtf = Buffer.from(decompressRTF(Array.from(compressedRtf)));
  const result = Result.try({
    try: () => deEncapsulateSync(rtf, { mode: "either" }),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    return null;
  }
  const text =
    typeof result.value.text === "string"
      ? result.value.text
      : result.value.text.toString("utf-8");
  return result.value.mode === "html"
    ? { type: "html", html: text }
    : { type: "text", text };
};

const guessImageMime = (fileName: string | undefined): string => {
  const extension = (fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSION_MIME[extension] ?? "application/octet-stream";
};

// ── HTML rendering + sanitization ───────────────────────

const HR_STYLE = "border: none; border-top: 1px solid #d4d4d8; margin: 12px 0;";
const PRE_STYLE =
  "white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 13px; margin: 0;";

export const renderEmailHtml = (parsed: ParsedEmail): string => {
  const header = buildHeaderHtml(parsed);

  if (parsed.body.type === "text") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${header}<hr style="${HR_STYLE}"><pre style="${PRE_STYLE}">${escapeHtml(parsed.body.text)}</pre></body></html>`;
  }

  const $ = load(parsed.body.html);
  sanitizeDom($);
  inlineCidImages($, parsed.inlineImages);

  if ($("meta[charset]").length === 0) {
    $("head").prepend('<meta charset="utf-8">');
  }
  $("body").prepend(`${header}<hr style="${HR_STYLE}">`);

  return $.html();
};

const STRIP_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
];

// eslint-disable-next-line no-script-url -- listing the schemes we strip from untrusted HTML
const ACTIVE_URL_SCHEMES = ["javascript:", "vbscript:"];
const URL_ATTRIBUTES = new Set(["href", "src", "action", "background"]);

type CheerioApi = ReturnType<typeof load>;

const sanitizeDom = ($: CheerioApi): void => {
  $(STRIP_TAGS.join(",")).remove();
  $("meta[http-equiv]").remove();

  $("*").each((_, node) => {
    if (!isTag(node)) {
      return;
    }
    for (const attribute of Object.keys(node.attribs)) {
      const name = attribute.toLowerCase();
      if (name.startsWith("on")) {
        $(node).removeAttr(attribute);
        continue;
      }
      if (!URL_ATTRIBUTES.has(name)) {
        continue;
      }
      const value = (node.attribs[attribute] ?? "").trim().toLowerCase();
      if (ACTIVE_URL_SCHEMES.some((scheme) => value.startsWith(scheme))) {
        $(node).removeAttr(attribute);
      }
    }
  });
};

const inlineCidImages = ($: CheerioApi, images: InlineImage[]): void => {
  if (images.length === 0) {
    return;
  }
  const byCid = new Map(
    images.map((image) => [image.cid.toLowerCase(), image] as const),
  );

  $("img").each((_, element) => {
    const image: Cheerio<Element> = $(element);
    const src = image.attr("src");
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

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);
