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
import { type Element, isTag, isText } from "domhandler";
import PostalMime, { type Address } from "postal-mime";

import { arrayOrEmpty } from "@/api/lib/array";
import { MAX_EMAIL_ATTACHMENT_DESCRIPTORS } from "@/api/lib/files/email-attachment-token";
import { parseOutlookMsg } from "@/api/lib/files/outlook-msg";

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

const EMAIL_WRITING_DIRECTIONS = {
  auto: null,
  ltr: null,
  rtl: null,
} as const;

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
}> {}

type InlineImage = { cid: string; mimeType: string; dataBase64: string };

export type EmailAttachment = {
  contentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  bytes: Uint8Array;
};

export type EmailAttachmentDescriptor = {
  id: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  previewable: boolean;
};

type EmailBody =
  | { type: "html"; html: string }
  | { type: "text"; text: string };

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

export const emailToPreview = async (
  fileBuffer: ArrayBuffer,
  mimeType: string,
  options: { createAttachmentId?: (attachmentIndex: number) => string } = {},
): Promise<Result<EmailPreview, EmailParseError>> =>
  await Result.tryPromise({
    try: async () =>
      buildEmailPreview(await parseEmail(fileBuffer, mimeType), options),
    catch: (cause) =>
      new EmailParseError({
        message: "Failed to parse email preview",
        mimeType,
        cause,
      }),
  });

export const buildEmailPreview = (
  parsed: ParsedEmail,
  {
    createAttachmentId = (attachmentIndex) =>
      `attachment-${String(attachmentIndex)}`,
  }: { createAttachmentId?: (attachmentIndex: number) => string } = {},
): EmailPreview => {
  const inlineContentIds = new Set(
    parsed.inlineImages.map(({ cid }) => cid.toLowerCase()),
  );
  const renderedBody = renderEmailBody(parsed);

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
      .map(({ attachment, attachmentIndex }) => ({
        id: createAttachmentId(attachmentIndex),
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.bytes.byteLength,
        previewable: isEmailAttachmentPreviewable(attachment.mimeType),
      })),
    bodyFolds: renderedBody.bodyFolds,
    bodyHtml: renderedBody.bodyHtml,
  };
};

export const isEmailAttachmentPreviewable = (
  mimeType: string | null,
): boolean => {
  const normalized = mimeType?.split(";").at(0)?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/pdf" ||
    /^image\/(?:png|jpe?g|gif|webp)$/u.test(normalized)
  );
};

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
        dataBase64: Buffer.from(bytes).toString("base64"),
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

  return {
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
  };
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

const SAFE_INLINE_IMAGE_MIME_TYPES = new Set(
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
      dataBase64: Buffer.from(attachment.bytes).toString("base64"),
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
  };
};

const guessImageMime = (fileName: string | undefined): string => {
  const extension = (fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSION_MIME[extension] ?? "application/octet-stream";
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

const HR_STYLE = "border: none; border-top: 1px solid #d4d4d8; margin: 12px 0;";
const PRE_STYLE =
  "white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 13px; margin: 0;";
const EMAIL_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
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
[data-stella-email-fold] {
  margin: 8px 0;
}
[data-stella-email-fold] > summary {
  align-items: center;
  border-radius: 6px;
  color: #71717a;
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  list-style: none;
  min-height: 44px;
  min-width: 44px;
  user-select: none;
}
[data-stella-email-fold] > summary:hover {
  background: #f4f4f5;
  color: #3f3f46;
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
`;

export const renderEmailHtml = (parsed: ParsedEmail): string => {
  const header = buildHeaderHtml(parsed);

  if (parsed.body.type === "text") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}"><meta name="color-scheme" content="light"><style>${EMAIL_PREVIEW_CSS}</style></head><body>${header}<hr style="${HR_STYLE}"><pre style="${PRE_STYLE}">${escapeHtml(parsed.body.text)}</pre></body></html>`;
  }

  const $ = load(parsed.body.html);
  sanitizeDom($);
  stripDuplicateNestedMessageHeaders($);
  inlineCidImages($, parsed.inlineImages);

  if ($("meta[charset]").length === 0) {
    $("head").prepend('<meta charset="utf-8">');
  }
  $("head").append(
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">`,
  );
  $("head").append('<meta name="color-scheme" content="light">');
  $("head").append(`<style>${EMAIL_PREVIEW_CSS}</style>`);
  $("body").prepend(`${header}<hr style="${HR_STYLE}">`);

  return $.html();
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
  referencedContentIds: Set<string>;
};

const renderEmailBody = (parsed: ParsedEmail): RenderedEmailBody => {
  if (parsed.body.type === "text") {
    const renderedTextBody = renderPlainTextBody(parsed.body.text);
    return {
      bodyFolds: renderedTextBody.bodyFolds,
      bodyHtml: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}"><meta name="color-scheme" content="light"><style>${EMAIL_PREVIEW_CSS}</style></head><body dir="auto">${renderedTextBody.html}</body></html>`,
      referencedContentIds: new Set(),
    };
  }

  const $ = load(parsed.body.html);
  sanitizeDom($);
  stripDuplicateNestedMessageHeaders($);
  const bodyFolds = foldQuotedHistoryAndSignatures($);
  const referencedContentIds = getReferencedInlineContentIds($);
  inlineCidImages($, parsed.inlineImages);

  if ($("meta[charset]").length === 0) {
    $("head").prepend('<meta charset="utf-8">');
  }
  $("head").append(
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">`,
  );
  $("head").append('<meta name="color-scheme" content="light">');
  $("head").append(`<style>${EMAIL_PREVIEW_CSS}</style>`);
  if (!hasExplicitWritingDirection($)) {
    $("body").attr("dir", "auto");
  }

  return {
    bodyFolds,
    bodyHtml: `<!DOCTYPE html>${$.html()}`,
    referencedContentIds,
  };
};

export const renderEmailBodyHtml = (parsed: ParsedEmail): string =>
  renderEmailBody(parsed).bodyHtml;

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
      htmlDirection in EMAIL_WRITING_DIRECTIONS) ||
    (bodyDirection !== undefined && bodyDirection in EMAIL_WRITING_DIRECTIONS)
  );
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
  | { type: "candidate"; candidate: EmailFoldCandidate }
  | { type: "content" };

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
      if (name.startsWith("data-stella-email-fold")) {
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
      const pre = `<pre style="${PRE_STYLE}">${escapeHtml(sectionText)}</pre>`;
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
        `<tr><td style="padding: 2px 12px 2px 0; color: #71717a; vertical-align: top; white-space: nowrap;">${escapeHtml(label)}</td><td style="padding: 2px 0; color: #18181b;">${escapeHtml(value)}</td></tr>`,
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

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);
