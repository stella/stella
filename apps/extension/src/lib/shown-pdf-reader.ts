import * as v from "valibot";

import { BROWSER_DOWNLOAD_STOP_REASON } from "@stll/api-contract/browser-control";

/**
 * The one place a PDF the chat's tab shows is fetched for its save. The
 * request asks for the document's own address once and never follows a
 * redirect (`redirect: "manual"`): a redirect ends the save, so no other
 * address, public or private, is ever requested. It is made from the
 * extension's offscreen document, which keeps the bytes as a `blob:`
 * address of the extension's own; Chrome then saves that address, which
 * cannot redirect either. `chrome.downloads.download` of the web address
 * is never used: Chrome would follow every redirect itself, outside the
 * tab's network rules.
 */

const TARGET = "stella-shown-pdf-reader";

const STOP = BROWSER_DOWNLOAD_STOP_REASON;

/** What a read gives back to the worker. */
export type ShownPdfRead =
  | {
      type: "read";
      bytes: number;
      /** The extension's own `blob:` address holding the bytes. */
      downloadUrl: string;
      /** The address the response came from. */
      fetchedUrl: string;
    }
  | {
      type: "refused";
      reason:
        typeof STOP.interrupted | typeof STOP.redirected | typeof STOP.tooLarge;
    };

const refusedRead = (
  reason: Extract<ShownPdfRead, { type: "refused" }>["reason"],
): ShownPdfRead => ({ reason, type: "refused" });

const shownPdfReadSchema = v.variant("type", [
  v.strictObject({
    bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    downloadUrl: v.pipe(v.string(), v.startsWith("blob:")),
    fetchedUrl: v.string(),
    type: v.literal("read"),
  }),
  v.strictObject({
    reason: v.picklist([STOP.interrupted, STOP.redirected, STOP.tooLarge]),
    type: v.literal("refused"),
  }),
]);

const readerRequestSchema = v.variant("type", [
  v.strictObject({
    maxBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    target: v.literal(TARGET),
    type: v.literal("read"),
    url: v.string(),
  }),
  v.strictObject({
    downloadUrl: v.pipe(v.string(), v.startsWith("blob:")),
    target: v.literal(TARGET),
    type: v.literal("release"),
  }),
]);

type ShownPdfReaderRequest = v.InferOutput<typeof readerRequestSchema>;

/** A message for the offscreen reader; null for any other message. */
export const parseShownPdfReaderRequest = (
  input: unknown,
): ShownPdfReaderRequest | null => {
  const parsed = v.safeParse(readerRequestSchema, input);
  return parsed.success ? parsed.output : null;
};

const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" ||
  (response.status >= 300 && response.status < 400);

/**
 * Fetches `url` once and keeps at most `maxBytes` of it as a `blob:`
 * address. Runs in the offscreen document; `fetcher` is that document's
 * `fetch`. The HTTP cache is used when it holds the response, so an
 * address a site serves once can still be saved when the tab's response
 * was cached.
 */
export const readShownPdf = async (
  url: string,
  maxBytes: number,
  fetcher: typeof fetch = fetch,
): Promise<ShownPdfRead> => {
  const response = await fetcher(url, {
    cache: "force-cache",
    credentials: "include",
    redirect: "manual",
  }).catch(() => null);
  if (response === null) {
    return refusedRead(STOP.interrupted);
  }
  if (isRedirect(response)) {
    await response.body?.cancel().catch(() => undefined);
    return refusedRead(STOP.redirected);
  }
  const body = response.body;
  if (!response.ok || body === null) {
    await body?.cancel().catch(() => undefined);
    return refusedRead(STOP.interrupted);
  }
  const reader = body.getReader();
  const chunks: BlobPart[] = [];
  let total = 0;
  for (;;) {
    // await-in-loop: one chunk at a time, so a large file stops early.
    const chunk = await reader.read().catch(() => null);
    if (chunk === null) {
      return refusedRead(STOP.interrupted);
    }
    if (chunk.done) {
      break;
    }
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return refusedRead(STOP.tooLarge);
    }
    chunks.push(chunk.value);
  }
  return {
    bytes: total,
    downloadUrl: URL.createObjectURL(
      new Blob(chunks, { type: "application/pdf" }),
    ),
    fetchedUrl: response.url === "" ? url : response.url,
    type: "read",
  };
};

/** How the worker reaches the reader; the download guard holds one. */
export type ShownPdfReader = {
  read: (url: string, maxBytes: number) => Promise<ShownPdfRead>;
  /** Frees a `blob:` address once Chrome no longer needs it. */
  release: (downloadUrl: string) => Promise<void>;
};

const OFFSCREEN_PATH = "offscreen.html";

let creating: Promise<void> | null = null;

/** Opens the offscreen document unless it is open; concurrent callers share one opening. */
const ensureOffscreenDocument = async (): Promise<void> => {
  const open = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (open.length > 0) {
    return;
  }
  creating ??= chrome.offscreen
    .createDocument({
      justification:
        "Keeps a PDF the chat's tab shows as a blob address until Chrome has saved it.",
      reasons: ["BLOBS"],
      url: OFFSCREEN_PATH,
    })
    .finally(() => {
      creating = null;
    });
  await creating;
};

/** The worker's reader: the offscreen document, over runtime messages. */
export const offscreenShownPdfReader: ShownPdfReader = {
  read: async (url, maxBytes) => {
    await ensureOffscreenDocument();
    const answer: unknown = await chrome.runtime.sendMessage({
      maxBytes,
      target: TARGET,
      type: "read",
      url,
    } satisfies ShownPdfReaderRequest);
    const parsed = v.safeParse(shownPdfReadSchema, answer);
    return parsed.success ? parsed.output : refusedRead(STOP.interrupted);
  },
  release: async (downloadUrl) => {
    await chrome.runtime
      .sendMessage({
        downloadUrl,
        target: TARGET,
        type: "release",
      } satisfies ShownPdfReaderRequest)
      .catch(() => undefined);
  },
};
