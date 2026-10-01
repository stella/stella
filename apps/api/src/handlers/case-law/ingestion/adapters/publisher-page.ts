// parser-output-unchanged: Validation rejects invalid publisher responses without transforming parsed decision content.
import { panic, Result } from "better-result";
import * as cheerio from "cheerio";
import { parseXmlDocument } from "slimdom";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

type PublisherPageReason =
  | "too-small"
  | "content-type"
  | "interstitial"
  | "invalid-syntax"
  | "invalid-shape";

export class PublisherPageError extends AdapterFetchError {
  override readonly name = "PublisherPageError";
  readonly reason: PublisherPageReason;

  constructor({
    reason,
    ...context
  }: {
    reason: PublisherPageReason;
    adapterKey: string;
    cursor: string | null;
  }) {
    super({ ...context, message: `Publisher page rejected: ${reason}` });
    this.reason = reason;
  }
}

type PublisherPageKind = "json" | "html" | "xml" | "pdf" | "zip";

type PublisherPageExpectation = {
  kind: PublisherPageKind;
  minBytes?: number;
  /** Shape of the parsed JSON, or the text/bytes for other content kinds. */
  shape?: (value: unknown) => boolean;
};

type ValidatePublisherPageOptions = {
  body: string | Uint8Array;
  expectation: PublisherPageExpectation;
  adapterKey: string;
  cursor: string | null;
  headers?: Headers;
};

const MIME_TYPES = {
  json: ["application/json", "text/json"],
  html: ["text/html", "application/xhtml+xml"],
  xml: ["application/xml", "text/xml"],
  pdf: ["application/pdf"],
  zip: ["application/zip", "application/x-zip-compressed"],
} as const satisfies Record<PublisherPageKind, readonly string[]>;

const matchesContentType = (
  headers: Headers | undefined,
  kind: PublisherPageKind,
): boolean => {
  const mime = headers
    ?.get("content-type")
    ?.split(";")
    .at(0)
    ?.trim()
    .toLowerCase();
  // Some publishers omit the header or serve binary downloads as octet-stream.
  // A declared structured type must agree with the response contract.
  if (!mime || mime === "text/plain" || mime === "application/octet-stream") {
    return true;
  }
  if (MIME_TYPES[kind].some((allowed) => allowed === mime)) {
    return true;
  }
  return (
    (kind === "json" && mime.endsWith("+json")) ||
    (kind === "xml" && mime.endsWith("+xml"))
  );
};

const isHtmlInterstitial = (text: string): boolean => {
  const $ = cheerio.load(text);
  if ($("form input[type=password]").length > 0) {
    return true;
  }
  if (
    $("meta[http-equiv]")
      .toArray()
      .some(
        (element) => $(element).attr("http-equiv")?.toLowerCase() === "refresh",
      )
  ) {
    return true;
  }
  const content = $("body").clone();
  content.find("script, style, noscript").remove();
  content.find("form").each((_index, form) => {
    const node = $(form);
    if (node.find("table, article, ol, ul").length === 0) {
      node.remove();
    }
  });
  return $("form, script").length > 0 && content.text().trim() === "";
};

const isCompleteZip = (bytes: Uint8Array): boolean => {
  if (
    bytes.at(0) !== 0x50 ||
    bytes.at(1) !== 0x4b ||
    bytes.at(2) !== 3 ||
    bytes.at(3) !== 4
  ) {
    return false;
  }
  // The end record includes the comment length; accepting a signature alone
  // would let an interrupted archive reach the item reader.
  for (
    let offset = Math.max(0, bytes.length - 22 - 65_535);
    offset <= bytes.length - 22;
    offset++
  ) {
    if (
      bytes.at(offset) !== 0x50 ||
      bytes.at(offset + 1) !== 0x4b ||
      bytes.at(offset + 2) !== 5 ||
      bytes.at(offset + 3) !== 6
    ) {
      continue;
    }
    const commentLength =
      (bytes.at(offset + 20) ?? 0) + (bytes.at(offset + 21) ?? 0) * 256;
    if (offset + 22 + commentLength === bytes.length) {
      return true;
    }
  }
  return false;
};

type ReadPublisherPageContentOptions = {
  kind: PublisherPageKind;
  body: string | Uint8Array;
  bytes: Uint8Array;
  text: string;
  reject: (reason: PublisherPageReason) => Result<never, PublisherPageError>;
};

const readPublisherPageContent = ({
  kind,
  body,
  bytes,
  text,
  reject,
}: ReadPublisherPageContentOptions): Result<unknown, PublisherPageError> => {
  switch (kind) {
    case "json": {
      const parsed = Result.try({
        try: (): unknown => JSON.parse(text),
        catch: () => null,
      });
      if (parsed.isErr()) {
        return reject("invalid-syntax");
      }
      return Result.ok(parsed.value);
    }
    case "xml": {
      const parsed = Result.try({
        try: () => parseXmlDocument(text),
        catch: () => null,
      });
      if (parsed.isErr()) {
        return reject("invalid-syntax");
      }
      return Result.ok(body);
    }
    case "pdf":
      if (!text.startsWith("%PDF-") || !text.trimEnd().endsWith("%%EOF")) {
        return reject("invalid-syntax");
      }
      return Result.ok(body);
    case "zip":
      if (!isCompleteZip(bytes)) {
        return reject("invalid-syntax");
      }
      return Result.ok(body);
    case "html":
      if (isHtmlInterstitial(text)) {
        return reject("interstitial");
      }
      return Result.ok(body);
  }
  // Every page kind returns above; a new kind fails here at compile time.
  kind satisfies never;
  return panic("Unhandled publisher page kind");
};

/** Validate the response before a listing parser can mistake refusal for absence. */
export const validatePublisherPage = ({
  body,
  expectation,
  adapterKey,
  cursor,
  headers,
}: ValidatePublisherPageOptions): Result<unknown, PublisherPageError> => {
  const reject = (reason: PublisherPageReason) =>
    Result.err(new PublisherPageError({ adapterKey, cursor, reason }));
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength < (expectation.minBytes ?? 1)) {
    return reject("too-small");
  }
  if (!matchesContentType(headers, expectation.kind)) {
    return reject("content-type");
  }
  if (headers?.has("retry-after")) {
    return reject("interstitial");
  }
  const text =
    typeof body === "string"
      ? body
      : new TextDecoder().decode(
          expectation.kind === "zip" ? bytes.subarray(0, 256) : bytes,
        );
  if (
    (expectation.kind === "json" ||
      expectation.kind === "html" ||
      expectation.kind === "xml") &&
    text.trim() === ""
  ) {
    return reject("too-small");
  }
  const looksHtml =
    /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<form\b|<script\b)/iu.test(
      text,
    );
  if (looksHtml && expectation.kind !== "html") {
    return reject("content-type");
  }
  const content = readPublisherPageContent({
    kind: expectation.kind,
    body,
    bytes,
    text,
    reject,
  });
  if (content.isErr()) {
    return content;
  }
  if (expectation.shape !== undefined && !expectation.shape(content.value)) {
    return reject("invalid-shape");
  }
  return content;
};
