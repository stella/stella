/**
 * Headless API for the document watermark.
 *
 * Mirrors the `content-controls` module's shape: pure functions that
 * read and write a `Document` immutably. Word stores watermarks inside
 * header parts; folio's getter scans every header and returns the
 * first watermark found, and the setter writes the modeled watermark
 * to every header part so all sections render it.
 */

import type { Document, HeaderFooter, Watermark } from "../types/document";

export type {
  Watermark,
  TextWatermark,
  PictureWatermark,
} from "../types/document";

/**
 * Read the document's watermark. Walks every header part and returns
 * the first watermark encountered (header insertion order). Returns
 * `undefined` when no header carries one.
 */
export function getDocumentWatermark(doc: Document): Watermark | undefined {
  const headers = doc.package.headers;
  if (!headers) {
    return undefined;
  }
  for (const header of headers.values()) {
    if (header.watermark) {
      return header.watermark;
    }
  }
  return undefined;
}

/**
 * Set (or clear) the document's watermark. Writes the modeled
 * `watermark` to every header part, and clears the captured raw VML so
 * the serializer takes the model-driven synthesis path. Pass
 * `undefined` to remove the watermark from every header.
 *
 * Throws when the document has no header parts to write to — folio
 * does not synthesize a default header here because that touches
 * section relationships, content-type registration, and the rezip
 * layer. Callers facing a header-less document should add a default
 * header via the existing header-creation helpers first, then call
 * this setter.
 */
export function setDocumentWatermark(
  doc: Document,
  watermark: Watermark | undefined,
): Document {
  const headers = doc.package.headers;
  if (!headers || headers.size === 0) {
    throw new TypeError(
      "setDocumentWatermark: document has no header parts; add a default header before setting a watermark",
    );
  }
  const nextHeaders = new Map<string, HeaderFooter>();
  for (const [rId, header] of headers) {
    const next: HeaderFooter = { ...header };
    if (watermark === undefined) {
      delete next.watermark;
      // No watermark left to position — drop the parsed block index too
      // so the serializer doesn't emit at a phantom slot.
      delete next.watermarkBlockIndex;
    } else {
      // Give every header its own watermark object. A picture watermark's
      // `imageRId` is local to each header part's own rels; the package-layer
      // rebind pass at save time rewrites each copy's `imageRId` to a rId that
      // resolves in that header's `word/_rels/header*.xml.rels`. Sharing one
      // object would let that rebind leak across headers.
      next.watermark = { ...watermark };
    }
    // Clear the captured raw VML so the serializer regenerates from the
    // model. Without this, an untouched raw payload would shadow the
    // caller's mutation. `watermarkBlockIndex` is preserved across a
    // text/picture mutation so the new watermark appears at the same
    // flow position as the old one.
    delete next.rawWatermarkXml;
    nextHeaders.set(rId, next);
  }
  return {
    ...doc,
    package: {
      ...doc.package,
      headers: nextHeaders,
    },
  };
}
