/**
 * A web archive (.mht, .mhtml) as the HTML of its page. The archive is a MIME
 * `multipart/related` message: its first HTML part is the page, and the other
 * parts are the resources the page names by `Content-Location` or `cid:`.
 * The page's images are embedded from those parts; nothing is fetched.
 */
import { Result, TaggedError } from "better-result";
import PostalMime from "postal-mime";

import { load } from "@stll/html";

import {
  createImageEmbedder,
  embeddableImageType,
  embedImages,
  finishRenderedHtml,
  RENDERED_HTML_MAX_CHARS,
} from "@/api/lib/files/rendered-html";
import { isRecord } from "@/api/lib/type-guards";

export class WebArchiveError extends TaggedError("WebArchiveError")<{
  message: string;
  cause?: unknown;
}> {}

type ArchivePart = {
  readonly type: string;
  readonly location: string | null;
  readonly contentId: string | null;
  readonly bytes: Uint8Array;
  /** The part as text in its declared charset, as the parser decodes it. */
  readonly text: () => string | null;
};

/** The parser's own charset-aware decoding of one part, if it offers it. */
const partText = (node: Record<string, unknown>) => (): string | null => {
  const decode = node["getTextContent"];
  if (typeof decode !== "function") {
    return null;
  }
  const text: unknown = Reflect.apply(decode, node, []);
  return typeof text === "string" ? text : null;
};

const headerValue = (node: Record<string, unknown>, key: string) => {
  const headers = node["headers"];
  if (!Array.isArray(headers)) {
    return null;
  }
  for (const header of headers) {
    if (
      isRecord(header) &&
      header["key"] === key &&
      typeof header["value"] === "string"
    ) {
      return header["value"].trim();
    }
  }
  return null;
};

/**
 * Every leaf part of the parsed archive with its own headers. PostalMime's
 * public result leaves out `Content-Location`; its parsed tree keeps every
 * header, so the parts are read from that tree.
 */
const archiveParts = (
  parser: unknown,
): Result<ArchivePart[], WebArchiveError> => {
  if (!isRecord(parser) || !isRecord(parser["root"])) {
    return Result.err(
      new WebArchiveError({ message: "The web archive could not be read" }),
    );
  }
  const parts: ArchivePart[] = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }
    const content = node["content"];
    const contentType = node["contentType"];
    if (content instanceof ArrayBuffer && isRecord(contentType)) {
      const type =
        typeof contentType["value"] === "string"
          ? contentType["value"].toLowerCase()
          : "";
      parts.push({
        type,
        location: headerValue(node, "content-location"),
        contentId:
          headerValue(node, "content-id")?.replace(/^<|>$/gu, "") ?? null,
        bytes: new Uint8Array(content),
        text: partText(node),
      });
    }
    const children = node["childNodes"];
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };
  visit(parser["root"]);
  return Result.ok(parts);
};

/** A reference resolved against the page's location, as a browser would. */
const absoluteReference = (reference: string, base: string | null) => {
  const resolved = Result.try(() =>
    base === null ? new URL(reference) : new URL(reference, base),
  );
  return Result.isOk(resolved) ? resolved.value.href : reference;
};

/** The page of a web archive as self-contained, sanitized HTML. */
export const webArchiveToHtml = async (
  bytes: Uint8Array,
): Promise<Result<Uint8Array, WebArchiveError>> => {
  const parser = new PostalMime({ attachmentEncoding: "arraybuffer" });
  const parsed = await Result.tryPromise({
    try: async () => await parser.parse(bytes),
    catch: (cause) =>
      new WebArchiveError({
        message: "The web archive could not be read",
        cause,
      }),
  });
  if (Result.isError(parsed)) {
    return parsed;
  }
  const parts = archiveParts(parser);
  if (Result.isError(parts)) {
    return parts;
  }
  // The page is the archive's first HTML part, on its own: other HTML parts
  // are resources of the page (a frame's document), not more of it.
  const page = parts.value.find((part) => part.type.startsWith("text/html"));
  if (page === undefined || page.bytes.byteLength > RENDERED_HTML_MAX_CHARS) {
    return Result.err(
      new WebArchiveError({
        message:
          page === undefined
            ? "The web archive has no page"
            : "The web archive's page is too large",
      }),
    );
  }
  const html = page.text();
  if (html === null || html.trim() === "") {
    return Result.err(
      new WebArchiveError({ message: "The web archive has no page" }),
    );
  }
  const base = page.location;
  const byLocation = new Map(
    parts.value.flatMap((part) =>
      part.location === null
        ? []
        : [[absoluteReference(part.location, base), part] as const],
    ),
  );
  const byContentId = new Map(
    parts.value.flatMap((part) =>
      part.contentId === null
        ? []
        : [[part.contentId.toLowerCase(), part] as const],
    ),
  );
  const embed = createImageEmbedder();
  const $ = load(html);
  embedImages($, (source) => {
    const part = source.toLowerCase().startsWith("cid:")
      ? byContentId.get(source.slice(4).toLowerCase())
      : byLocation.get(absoluteReference(source, base));
    if (part === undefined) {
      return null;
    }
    const type = embeddableImageType(part.type, part.location ?? source);
    return type === null ? null : embed(type, part.bytes);
  });
  return Result.ok(finishRenderedHtml($.html()));
};
