import * as v from "valibot";

import { apiDateTimeSchema } from "./api-date";
import { STELLA_API_VERSION_PREFIX } from "./api-version";
import { BROWSER_CONTROL_LIMITS } from "./browser-control";
import { MULTIPART_DOCUMENT_MAX_BYTES } from "./limits";

/**
 * A file the member's browser downloaded for a chat, filed with stella: into
 * the chat's own matter as a document, or, for a chat in no matter, kept
 * with the chat. Both ends hold it to these.
 */

/** The largest download filed: what one multipart request carries, and what the browser saves. */
export const BROWSER_DOWNLOAD_FILE_MAX_BYTES = Math.min(
  MULTIPART_DOCUMENT_MAX_BYTES,
  BROWSER_CONTROL_LIMITS.downloadBytes,
);

/** An address a download is known by, as stored. */
export const BROWSER_DOWNLOAD_URL_MAX_CHARS = BROWSER_CONTROL_LIMITS.urlChars;

/**
 * An address as stella keeps it: a web address without its credentials,
 * query or fragment (a signed download link carries its key there, and a
 * matter's readers must not receive it), any other address only by its
 * scheme (a `data:` address is the file itself).
 */
export const storedBrowserDownloadAddress = (address: string): string => {
  const url = new URL(address);
  return url.protocol === "https:" || url.protocol === "http:"
    ? `${url.origin}${url.pathname}`
    : url.protocol;
};

const addressSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BROWSER_DOWNLOAD_URL_MAX_CHARS),
  // A scheme first: a client reads this field as an address, not free text.
  v.regex(/^[a-z][a-z\d+.-]*:/iu, "Expected an address"),
  v.check((address) => URL.canParse(address), "Expected an address"),
  v.transform(storedBrowserDownloadAddress),
);

/**
 * Where a download came from, as the chat saw it: the address the file was
 * fetched from, the page it came from (null when not known, or when the file
 * came from another site), and when it arrived.
 */
export const browserDownloadOriginSchema = v.strictObject({
  sourceUrl: addressSchema,
  pageUrl: v.nullable(addressSchema),
  downloadedAt: apiDateTimeSchema,
});

export type BrowserDownloadOrigin = v.InferOutput<
  typeof browserDownloadOriginSchema
>;

/** Why a download was not filed, beside the refusals any document write has. */
export const BROWSER_DOWNLOAD_REFUSAL_CODE = {
  /** Its bytes are not a PDF's; only PDFs are filed. */
  notPdf: "browser_download_not_pdf",
  /** The security scan refused it. */
  rejected: "browser_download_rejected",
  /** It could not be read as a PDF (damaged, say). */
  unreadable: "browser_download_unreadable",
  /** The chat's matter cannot take it now (the matter's state, its limits). */
  notStored: "browser_download_not_stored",
  /** The run or the chat it would be filed for is gone. */
  noChat: "browser_download_no_chat",
} as const;

/** The form fields of a filed download beside its `file`. */
export const BROWSER_DOWNLOAD_FORM_FIELD = {
  file: "file",
  sourceUrl: "sourceUrl",
  pageUrl: "pageUrl",
  downloadedAt: "downloadedAt",
} as const;

/** Where a run on the member's computer files a download its chat's tab made. */
export const localRunBrowserDownloadPath = (runId: string) =>
  `${STELLA_API_VERSION_PREFIX}/chat/local-runs/${encodeURIComponent(runId)}/browser-downloads` as const;

/** Where a filed download is; a browser result names it too, so it lives beside the results. */
export {
  type BrowserDownloadFiled,
  browserDownloadFiledSchema,
} from "./browser-control";
