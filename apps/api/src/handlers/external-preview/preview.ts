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
import { fetchWithResolvedAddress } from "@/api/lib/safe-outbound-fetch";
import type {
  SafeOutboundAddress,
  SafeOutboundFetchResponse,
} from "@/api/lib/safe-outbound-fetch";

const PREVIEW_TIMEOUT_MS = 8000;
const MAX_URL_LENGTH = 2048;
const MAX_PREVIEW_BYTES = 1_000_000;
const MAX_FILE_PREVIEW_BYTES = 20_000_000;
const MAX_PREVIEW_CHARS = 80_000;
const MAX_PREVIEW_REDIRECTS = 5;
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
    const target = yield* Result.await(validatePreviewUrl(query.url));
    const previewFetch = yield* Result.await(
      fetchPreviewUrl(target, { maxBytes: MAX_PREVIEW_BYTES }),
    );
    const { requestedUrl, response, url } = previewFetch;
    const contentType = getContentType(response.headers);

    if (
      isPdfPreviewResponse({
        body: response.body,
        contentType,
        requestedUrl,
        responseUrl: url,
      })
    ) {
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

    const body = readResponseText(response);
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
    const target = yield* Result.await(validatePreviewUrl(query.url));
    const previewFetch = yield* Result.await(
      fetchPreviewUrl(target, { maxBytes: MAX_FILE_PREVIEW_BYTES }),
    );
    const { requestedUrl, response, url } = previewFetch;
    const contentType = getContentType(response.headers);
    const body = response.body;

    if (
      !isPdfPreviewResponse({
        body,
        contentType,
        requestedUrl,
        responseUrl: url,
      })
    ) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "This source cannot be previewed as a file",
        }),
      );
    }

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
): Promise<Result<ValidatedPreviewUrl, HandlerError>> => {
  if (rawUrl.length > MAX_URL_LENGTH) {
    return Result.err(
      new HandlerError({ status: 400, message: "Source URL is too long" }),
    );
  }

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
  return Result.ok({ addresses: resolved.value, url });
};

type ValidatedPreviewUrl = {
  addresses: SafeOutboundAddress[];
  url: URL;
};

type FetchPreviewUrlOptions = {
  maxBytes: number;
};

type FetchPreviewUrlResult = {
  requestedUrl: URL;
  response: SafeOutboundFetchResponse;
  url: URL;
};

const fetchPreviewUrl = async (
  target: ValidatedPreviewUrl,
  { maxBytes }: FetchPreviewUrlOptions,
): Promise<Result<FetchPreviewUrlResult, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      let currentTarget = target;

      for (let redirects = 0; redirects <= MAX_PREVIEW_REDIRECTS; redirects++) {
        const response = await fetchWithResolvedAddress({
          addresses: currentTarget.addresses,
          headers: {
            Accept:
              "application/pdf, text/html, application/xhtml+xml, text/plain;q=0.9",
            "User-Agent": "Stella external source preview",
          },
          maxBytes,
          redirect: "manual",
          timeoutMs: PREVIEW_TIMEOUT_MS,
          url: currentTarget.url,
        });
        if (Result.isError(response)) {
          throw response.error;
        }

        if (isRedirectStatus(response.value.status)) {
          if (redirects === MAX_PREVIEW_REDIRECTS) {
            throw new HandlerError({
              status: 502,
              message: "Source redirected too many times",
            });
          }

          const location = response.value.headers.get("location");
          if (!location) {
            throw new HandlerError({
              status: 502,
              message: "Source redirected without a location",
            });
          }

          const nextTarget = await validatePreviewUrl(
            new URL(location, currentTarget.url).toString(),
          );
          if (Result.isError(nextTarget)) {
            throw nextTarget.error;
          }

          currentTarget = nextTarget.value;
          continue;
        }

        if (!response.value.ok) {
          throw new HandlerError({
            status: 502,
            message: `Source returned HTTP ${response.value.status}`,
          });
        }

        const contentLength = response.value.headers.get("content-length");
        if (contentLength && Number(contentLength) > maxBytes) {
          throw new HandlerError({
            status: 422,
            message: "This source is too large to preview",
          });
        }

        return {
          requestedUrl: target.url,
          response: response.value,
          url: currentTarget.url,
        };
      }

      throw new HandlerError({
        status: 502,
        message: "Source redirected too many times",
      });
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

const isRedirectStatus = (status: number): boolean =>
  status >= 300 && status < 400;

const readResponseText = (response: SafeOutboundFetchResponse): string =>
  new TextDecoder().decode(response.body.slice(0, MAX_PREVIEW_BYTES));

const resolvePublicAddresses = async (
  hostname: string,
): Promise<Result<SafeOutboundAddress[], HandlerError>> => {
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return isPrivateAddress(hostname)
      ? Result.err(
          new HandlerError({
            status: 400,
            message: "Source host is not allowed",
          }),
        )
      : Result.ok([
          {
            address: hostname,
            family: literalFamily === 6 ? 6 : 4,
          },
        ]);
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

  return Result.ok(
    addresses.value.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    })),
  );
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

const getContentType = (headers: Headers): string | null => {
  const raw = headers.get("content-type");
  return raw?.split(";").at(0)?.trim().toLowerCase() ?? null;
};

const isSupportedContentType = (contentType: string | null): boolean =>
  contentType !== null &&
  (HTML_CONTENT_TYPES.has(contentType) || contentType.startsWith("text/"));

export const isPdfPreview = (contentType: string | null, url: URL): boolean =>
  (contentType !== null && PDF_CONTENT_TYPES.has(contentType)) ||
  ((contentType === null || GENERIC_BINARY_CONTENT_TYPES.has(contentType)) &&
    url.pathname.toLowerCase().endsWith(".pdf"));

export const isPdfPreviewResponse = ({
  body,
  contentType,
  requestedUrl,
  responseUrl,
}: {
  body: ArrayBuffer;
  contentType: string | null;
  requestedUrl: URL;
  responseUrl: URL;
}): boolean =>
  isPdfPreview(contentType, responseUrl) ||
  isPdfPreview(contentType, requestedUrl) ||
  isPdfBytes(body);

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
  value.replaceAll(/\s+/gu, " ").trim();

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
