/**
 * The HTML stella builds from a web archive or an e-book for its preview.
 * Images the document carries itself are embedded as data URIs, within a byte
 * budget; the result then goes through the email sanitizer, which keeps only
 * inert markup and embedded images, so the converter is never handed a
 * reference to fetch. The converter's own HTML input checks run on it after.
 */
import type { load } from "@stll/html";

import { sanitizeEmailBodyHtml } from "@/api/lib/files/email-to-html";

/** Image types an embedded image may have, as the sanitizer keeps them. */
const EMBEDDABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const IMAGE_TYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
]);

/** The total bytes of images one rendered document embeds. */
export const RENDERED_HTML_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;

/** The longest HTML a rendered document may be, before sanitizing. */
export const RENDERED_HTML_MAX_CHARS = 16 * 1024 * 1024;

/** An image's type from its declared type, else its name's extension. */
export const embeddableImageType = (
  declared: string | null | undefined,
  name: string,
): string | null => {
  const type = declared?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (EMBEDDABLE_IMAGE_TYPES.has(type)) {
    return type;
  }
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return IMAGE_TYPE_BY_EXTENSION.get(extension) ?? null;
};

/** Hands out data URIs until the document's image budget is spent. */
export const createImageEmbedder = () => {
  let remaining = RENDERED_HTML_IMAGE_BUDGET_BYTES;
  return (type: string, bytes: Uint8Array): string | null => {
    if (!EMBEDDABLE_IMAGE_TYPES.has(type) || bytes.byteLength > remaining) {
      return null;
    }
    remaining -= bytes.byteLength;
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  };
};

export type HtmlDocument = ReturnType<typeof load>;

/**
 * Rewrites every `img` source in `$` through `resolve`: a data URI it returns
 * replaces the source, and an image it cannot resolve loses its source, so
 * nothing outside the document is referenced.
 */
export const embedImages = (
  $: HtmlDocument,
  resolve: (source: string) => string | null,
): void => {
  $("img").each((_, element) => {
    const image = $(element);
    const source = image.attr("src")?.trim() ?? "";
    const embedded = source === "" ? null : resolve(source);
    image.removeAttr("srcset");
    if (embedded === null) {
      image.removeAttr("src");
    } else {
      image.attr("src", embedded);
    }
  });
};

/** The sanitized, self-contained document the converter receives. */
export const finishRenderedHtml = (html: string): Uint8Array =>
  new TextEncoder().encode(sanitizeEmailBodyHtml(html));
