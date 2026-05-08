import { Result } from "better-result";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { t } from "elysia";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { htmlToMarkdown } from "@/api/lib/markdown/html-to-markdown";

const PREVIEW_TIMEOUT_MS = 8000;
const MAX_URL_LENGTH = 2048;
const MAX_PREVIEW_BYTES = 1_000_000;
const MAX_FILE_PREVIEW_BYTES = 20_000_000;
const MAX_PREVIEW_CHARS = 80_000;
const MIN_READABLE_TEXT_CHARS = 80;

const HTML_CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html"]);
const GENERIC_BINARY_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
]);
const PDF_CONTENT_TYPES = new Set(["application/pdf"]);
const PDF_MAGIC_BYTES = "%PDF-";

type ExternalPreviewResponse = {
  contentType: string | null;
  format: "markdown" | "pdf" | "text";
  title: string | null;
  text: string;
  url: string;
};

const config = {
  permissions: { workspace: ["read"] },
  query: t.Object({
    url: t.String({ minLength: 1, maxLength: MAX_URL_LENGTH }),
  }),
} satisfies HandlerConfig;

const previewExternalSource = createSafeRootHandler(
  config,
  async function* ({ query }) {
    const url = yield* Result.await(validatePreviewUrl(query.url));
    const response = yield* Result.await(
      fetchPreviewUrl(url, { maxBytes: MAX_FILE_PREVIEW_BYTES }),
    );
    const contentType = getContentType(response);

    if (isPdfPreview(contentType, url)) {
      const preview: ExternalPreviewResponse = {
        contentType,
        format: "pdf" as const,
        title: null,
        text: "",
        url: url.toString(),
      };
      return Result.ok(preview);
    }

    if (!isSupportedContentType(contentType)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "This source cannot be previewed as text",
        }),
      );
    }

    const body = yield* Result.await(readLimitedResponseText(response));
    const title =
      contentType !== null && HTML_CONTENT_TYPES.has(contentType)
        ? extractHtmlTitle(body)
        : null;
    const preview =
      contentType !== null && HTML_CONTENT_TYPES.has(contentType)
        ? {
            format: "markdown" as const,
            text: extractReadableMarkdownFromHtml(body, url),
          }
        : {
            format: "text" as const,
            text: limitText(body.trim(), MAX_PREVIEW_CHARS),
          };

    if (normalizeWhitespace(preview.text).length < MIN_READABLE_TEXT_CHARS) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "This source does not expose enough readable text",
        }),
      );
    }

    const result: ExternalPreviewResponse = {
      contentType,
      format: preview.format,
      title,
      text: preview.text,
      url: url.toString(),
    };

    return Result.ok(result);
  },
);

export default previewExternalSource;

export const previewExternalFile = createSafeRootHandler(
  config,
  async function* ({ query }) {
    const url = yield* Result.await(validatePreviewUrl(query.url));
    const response = yield* Result.await(
      fetchPreviewUrl(url, { maxBytes: MAX_FILE_PREVIEW_BYTES }),
    );
    const contentType = getContentType(response);

    if (!isPdfPreview(contentType, url)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "This source cannot be previewed as a file",
        }),
      );
    }

    const body = yield* Result.await(
      readLimitedResponseBytes(response, MAX_FILE_PREVIEW_BYTES),
    );

    if (!isPdfBytes(body)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "This source did not return a valid PDF",
        }),
      );
    }

    return Result.ok(
      new Response(body, {
        headers: {
          "Cache-Control": "private, max-age=600",
          "Content-Disposition": "inline",
          "Content-Security-Policy":
            "default-src 'none'; object-src 'none'; base-uri 'none'",
          "Content-Type": "application/pdf",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      }),
    );
  },
);

export const extractReadableTextFromHtml = (html: string): string => {
  const markdown = extractReadableMarkdownFromHtml(
    html,
    new URL("https://placeholder.invalid"),
  );
  return normalizeMarkdownText(markdown);
};

export const extractReadableMarkdownFromHtml = (
  html: string,
  baseUrl: URL,
): string => {
  const $ = cheerio.load(html);
  sanitizePreviewHtml($, baseUrl);

  const root = findReadableRoot($);
  const blocks: string[] = [];
  const seen = new Set<string>();

  root.find(READABLE_BLOCK_SELECTOR).each((_, element) => {
    if (hasReadableBlockChildren($, element)) {
      return;
    }

    const text = normalizeWhitespace($(element).text());
    if (text.length === 0 || seen.has(text)) {
      return;
    }

    const markdown = renderReadableBlockMarkdown($, element);
    if (!markdown) {
      return;
    }

    seen.add(text);
    blocks.push(markdown);
  });

  if (blocks.length > 0) {
    return limitText(blocks.join("\n\n"), MAX_PREVIEW_CHARS);
  }

  return limitText(normalizeMarkdownText(root.text()), MAX_PREVIEW_CHARS);
};

const READABLE_BLOCK_SELECTOR = [
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
  "table",
  "td",
  "th",
].join(", ");

const findReadableRoot = ($: cheerio.CheerioAPI) => {
  const candidates = $(
    "article, main, [role='main'], section, div, body",
  ).toArray();
  let best = $("body").first();
  let bestLength = normalizeWhitespace(best.text()).length;

  for (const candidate of candidates) {
    const element = $(candidate);
    const textLength = normalizeWhitespace(element.text()).length;
    if (textLength > bestLength) {
      best = element;
      bestLength = textLength;
    }
  }

  return best;
};

const sanitizePreviewHtml = ($: cheerio.CheerioAPI, baseUrl: URL): void => {
  $("script, style, noscript, svg, canvas, iframe, form").remove();
  $("header, nav, footer, aside").remove();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    try {
      const url = new URL(href, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        $(element).removeAttr("href");
        return;
      }
      url.hash = "";
      $(element).attr("href", url.toString());
    } catch {
      $(element).removeAttr("href");
    }
  });
};

const hasReadableBlockChildren = (
  $: cheerio.CheerioAPI,
  element: Element,
): boolean => $(element).children(READABLE_BLOCK_SELECTOR).length > 0;

const renderReadableBlockMarkdown = (
  $: cheerio.CheerioAPI,
  element: Element,
): string => {
  const tagName = element.tagName.toLowerCase();
  const html = $.html(element);
  if (!html) {
    return "";
  }

  if (
    tagName === "blockquote" ||
    tagName === "pre" ||
    tagName === "table" ||
    tagName.startsWith("h")
  ) {
    return htmlToMarkdown(html).trim();
  }

  const innerHtml = $(element).html() ?? "";
  const paragraph = htmlToMarkdown(`<p>${innerHtml}</p>`).trim();
  if (tagName === "li") {
    return `- ${paragraph.replaceAll("\n", "\n  ")}`;
  }
  return paragraph;
};

const extractHtmlTitle = (html: string): string | null => {
  const $ = cheerio.load(html);
  const title =
    $("meta[property='og:title']").attr("content") ??
    $("meta[name='twitter:title']").attr("content") ??
    $("title").text();
  const normalized = normalizeWhitespace(title);
  return normalized.length > 0 ? normalized : null;
};

const validatePreviewUrl = async (
  rawUrl: string,
): Promise<Result<URL, HandlerError>> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid source URL" }),
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Only HTTP and HTTPS sources can be previewed",
      }),
    );
  }

  if (url.username || url.password) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Source URLs with credentials cannot be previewed",
      }),
    );
  }

  if (isBlockedHostname(url.hostname)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Source host is not allowed" }),
    );
  }

  const resolved = await resolvePublicAddresses(url.hostname);
  if (Result.isError(resolved)) {
    return Result.err(resolved.error);
  }

  url.hash = "";
  return Result.ok(url);
};

type FetchPreviewUrlOptions = {
  maxBytes: number;
};

const fetchPreviewUrl = async (
  url: URL,
  { maxBytes }: FetchPreviewUrlOptions,
): Promise<Result<Response, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        headers: {
          Accept:
            "application/pdf, text/html, application/xhtml+xml, text/plain;q=0.9",
          "User-Agent": "Stella external source preview",
        },
        redirect: "error",
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new HandlerError({
          status: 502,
          message: `Source returned HTTP ${response.status}`,
        });
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxBytes) {
        throw new HandlerError({
          status: 422,
          message: "This source is too large to preview",
        });
      }

      return response;
    },
    catch: (cause) =>
      HandlerError.is(cause)
        ? cause
        : new HandlerError({
            status: 502,
            message: "Source could not be fetched",
            cause,
          }),
  });

const readLimitedResponseText = async (
  response: Response,
): Promise<Result<string, HandlerError>> =>
  await Result.gen(async function* () {
    const buffer = yield* Result.await(
      readLimitedResponseBytes(response, MAX_PREVIEW_BYTES),
    );
    return Result.ok(new TextDecoder().decode(buffer));
  });

const readLimitedResponseBytes = async (
  response: Response,
  maxBytes: number,
): Promise<Result<ArrayBuffer, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new HandlerError({
          status: 422,
          message: "This source is too large to preview",
        });
      }
      return buffer;
    },
    catch: (cause) =>
      HandlerError.is(cause)
        ? cause
        : new HandlerError({
            status: 502,
            message: "Source body could not be read",
            cause,
          }),
  });

const resolvePublicAddresses = async (
  hostname: string,
): Promise<Result<void, HandlerError>> => {
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return isPrivateAddress(hostname)
      ? Result.err(
          new HandlerError({
            status: 400,
            message: "Source host is not allowed",
          }),
        )
      : Result.ok(undefined);
  }

  const addresses = await Result.tryPromise({
    try: async () => await lookup(hostname, { all: true }),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "Source host could not be resolved",
        cause,
      }),
  });

  if (Result.isError(addresses)) {
    return Result.err(addresses.error);
  }

  if (
    addresses.value.length === 0 ||
    addresses.value.some(({ address }) => isPrivateAddress(address))
  ) {
    return Result.err(
      new HandlerError({ status: 400, message: "Source host is not allowed" }),
    );
  }

  return Result.ok(undefined);
};

const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost");
};

const isPrivateAddress = (address: string): boolean => {
  if (address.startsWith("::ffff:")) {
    return isPrivateAddress(address.slice("::ffff:".length));
  }

  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b] = octets;
  if (a === undefined || b === undefined) {
    return true;
  }

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const getContentType = (response: Response): string | null => {
  const raw = response.headers.get("content-type");
  return raw?.split(";").at(0)?.trim().toLowerCase() ?? null;
};

const isSupportedContentType = (contentType: string | null): boolean =>
  contentType !== null &&
  (HTML_CONTENT_TYPES.has(contentType) || contentType.startsWith("text/"));

export const isPdfPreview = (contentType: string | null, url: URL): boolean =>
  (contentType !== null && PDF_CONTENT_TYPES.has(contentType)) ||
  ((contentType === null || GENERIC_BINARY_CONTENT_TYPES.has(contentType)) &&
    url.pathname.toLowerCase().endsWith(".pdf"));

export const isPdfBytes = (body: ArrayBuffer): boolean => {
  if (body.byteLength < PDF_MAGIC_BYTES.length) {
    return false;
  }

  const prefix = new TextDecoder().decode(
    body.slice(0, PDF_MAGIC_BYTES.length),
  );
  return prefix === PDF_MAGIC_BYTES;
};

const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/\s+/g, " ").trim();

const normalizeMarkdownText = (value: string): string =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n");

const limitText = (value: string, maxLength: number): string =>
  value.length > maxLength
    ? `${value.slice(0, maxLength).trimEnd()}...`
    : value;
