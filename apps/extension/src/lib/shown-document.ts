import * as v from "valibot";

import { BROWSER_SHOWN_DOCUMENT_TYPE } from "@stll/api-contract/browser-control";

/**
 * The one place that decides whether a tab shows a PDF. The signal is the
 * top document's `document.contentType`, read by script in the document
 * Chrome loaded (bound to its document id): Chrome sets it from the
 * response it rendered, after redirects, so it holds for a PDF opened,
 * clicked or redirected to, and for one a site's service worker served.
 * A URL ending in `.pdf` says nothing either way, and response headers
 * would need another permission and still miss cached and service worker
 * responses. A PDF drawn by a page's own script (a viewer built from
 * HTML) is a web page, and a PDF in a subframe is not the tab's document.
 */

const PDF_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/x-pdf",
]);

/** Whether a MIME type, parameters and case aside, is a PDF's. */
export const isPdfMimeType = (mime: string): boolean =>
  PDF_TYPES.has(mime.split(";")[0]?.trim().toLowerCase() ?? "");

/** What the `document-type` page operation answers. */
const documentTypeAnswerSchema = v.strictObject({
  contentType: v.string(),
  url: v.string(),
});

export type ShownDocument =
  | { type: "page" }
  | {
      type: typeof BROWSER_SHOWN_DOCUMENT_TYPE.pdf;
      /** The document's own address, as Chrome loaded it. */
      url: string;
    };

/**
 * What a top document's answer says it is; null for an answer outside the
 * page operation's shape.
 */
export const shownDocumentOf = (answer: unknown): ShownDocument | null => {
  const parsed = v.safeParse(documentTypeAnswerSchema, answer);
  if (!parsed.success) {
    return null;
  }
  return isPdfMimeType(parsed.output.contentType)
    ? { type: BROWSER_SHOWN_DOCUMENT_TYPE.pdf, url: parsed.output.url }
    : { type: "page" };
};

/** A PDF the controlled tab shows, as a read found it. */
export type ShownPdf = {
  tabId: number;
  /** The title the read returned; may be empty. */
  title: string;
  /** The document's own address. */
  url: string;
};
