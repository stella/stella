import { Result } from "better-result";
import * as v from "valibot";

import { BROWSER_DOWNLOAD_STOP_REASON } from "@stll/api-contract/browser-control";

import { parseControllableUrl } from "./origin-policy";

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

/** The port the worker opens to the offscreen document for one request. */
export const SHOWN_PDF_READER_PORT = "stella-shown-pdf-reader";

/** A message's sender, as far as the reader's check reads it. */
type ReaderSender = {
  readonly id?: string;
  readonly origin?: string;
  readonly tab?: object;
};

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

/**
 * Whether a message comes from this extension's own worker or pages: never
 * from a content script, which carries the extension's id too but runs in
 * a tab, beside a page.
 */
const fromExtensionContext = (
  sender: ReaderSender,
  extensionId: string,
): boolean =>
  sender.id === extensionId &&
  sender.tab === undefined &&
  (sender.origin === undefined ||
    sender.origin === `chrome-extension://${extensionId}`);

/**
 * The request the offscreen document takes from one message; null leaves
 * the message unanswered. It takes only this extension's worker or pages,
 * and reads only an address the origin policy lets a controlled tab load
 * (public HTTPS, never stella or a private host), whatever its caller
 * checked.
 */
export const takeShownPdfReaderRequest = (
  message: unknown,
  sender: ReaderSender | undefined,
  extensionId: string,
): ShownPdfReaderRequest | null => {
  const parsed = v.safeParse(readerRequestSchema, message);
  if (
    !parsed.success ||
    sender === undefined ||
    !fromExtensionContext(sender, extensionId)
  ) {
    return null;
  }
  const request = parsed.output;
  return request.type === "read" && parseControllableUrl(request.url) === null
    ? null
    : request;
};

const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" ||
  (response.status >= 300 && response.status < 400);

/**
 * How long one read may take, its request and its whole body together. A
 * read past it ends as interrupted, so a slow stream never holds one of
 * the chat's delivery slots for long.
 */
export const SHOWN_PDF_READ_TIMEOUT_MS = 120_000;

/**
 * How long the worker waits for the reader's answer: the read's own
 * deadline and a margin for the document to start. Past it the worker
 * stops waiting, whatever the document still does.
 */
const READER_ANSWER_TIMEOUT_MS = SHOWN_PDF_READ_TIMEOUT_MS + 15_000;

type ReadOptions = {
  /** Aborts the request and its body; the read then ends as interrupted. */
  deadline?: AbortSignal;
  /** The offscreen document's `fetch`. */
  fetcher?: typeof fetch;
};

/** Reads the body, at most `maxBytes` of it, until done or the deadline. */
const readBody = async (
  body: NonNullable<Response["body"]>,
  maxBytes: number,
  deadline: AbortSignal,
): Promise<
  { type: "bytes"; chunks: BlobPart[]; total: number } | ShownPdfRead
> => {
  const chunks: BlobPart[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      // await-in-loop: one chunk at a time, so a large file stops early.
      const chunk = await reader.read().catch(() => null);
      if (chunk === null || deadline.aborted) {
        return refusedRead(STOP.interrupted);
      }
      if (chunk.done) {
        return { chunks, total, type: "bytes" };
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        return refusedRead(STOP.tooLarge);
      }
      chunks.push(chunk.value);
    }
  } finally {
    // Stops the response on every early exit; after the end it does nothing.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

/**
 * Fetches `url` once and keeps at most `maxBytes` of it as a `blob:`
 * address, within one deadline for the request and its body. Runs in the
 * offscreen document. The HTTP cache is used when it holds the response,
 * so an address a site serves once can still be saved when the tab's
 * response was cached.
 */
export const readShownPdf = async (
  url: string,
  maxBytes: number,
  {
    deadline = AbortSignal.timeout(SHOWN_PDF_READ_TIMEOUT_MS),
    fetcher = fetch,
  }: ReadOptions = {},
): Promise<ShownPdfRead> => {
  const response = await fetcher(url, {
    cache: "force-cache",
    credentials: "include",
    redirect: "manual",
    signal: deadline,
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
  const read = await readBody(body, maxBytes, deadline);
  if (read.type !== "bytes") {
    return read;
  }
  return {
    bytes: read.total,
    downloadUrl: URL.createObjectURL(
      new Blob(read.chunks, { type: "application/pdf" }),
    ),
    fetchedUrl: response.url === "" ? url : response.url,
    type: "read",
  };
};

/**
 * Answers one read in the offscreen document. When the answer cannot be
 * posted (the worker stopped waiting and closed the port), the bytes it
 * kept are freed at once: nobody will ask for them.
 */
export const answerShownPdfRead = async (
  request: { maxBytes: number; url: string },
  post: (answer: ShownPdfRead) => void,
  {
    read = readShownPdf,
    revoke = URL.revokeObjectURL,
  }: {
    read?: (url: string, maxBytes: number) => Promise<ShownPdfRead>;
    revoke?: (downloadUrl: string) => void;
  } = {},
): Promise<void> => {
  const answer = await read(request.url, request.maxBytes).catch(
    (): ShownPdfRead => refusedRead(STOP.interrupted),
  );
  const posted = Result.try(() => {
    post(answer);
  });
  if (Result.isError(posted) && answer.type === "read") {
    revoke(answer.downloadUrl);
  }
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

/** Runs `task` after `ms`; the returned function cancels it. */
type ReaderTimer = (task: () => void, ms: number) => () => void;

const systemReaderTimer: ReaderTimer = (task, ms) => {
  const timer = setTimeout(task, ms);
  return () => {
    clearTimeout(timer);
  };
};

/**
 * The worker's reader: the offscreen document, over a port per request.
 * Each request resolves with the first answer, or with none once the
 * document closes the port (it refused, or it is gone) or the answer
 * deadline passes; then the port is closed, so a late answer frees its
 * own bytes.
 */
export const createOffscreenShownPdfReader = (
  timer: ReaderTimer = systemReaderTimer,
): ShownPdfReader => {
  const ask = async (request: ShownPdfReaderRequest): Promise<unknown> => {
    await ensureOffscreenDocument();
    return await new Promise<unknown>((resolve) => {
      const port = chrome.runtime.connect({ name: SHOWN_PDF_READER_PORT });
      const finish = (answer: unknown) => {
        cancelTimer();
        resolve(answer);
      };
      const cancelTimer = timer(() => {
        finish(undefined);
        port.disconnect();
      }, READER_ANSWER_TIMEOUT_MS);
      port.onMessage.addListener((answer: unknown) => {
        finish(answer);
        port.disconnect();
      });
      port.onDisconnect.addListener(() => {
        finish(undefined);
      });
      port.postMessage(request);
    });
  };
  return {
    read: async (url, maxBytes) => {
      const answer = await ask({
        maxBytes,
        target: TARGET,
        type: "read",
        url,
      });
      const parsed = v.safeParse(shownPdfReadSchema, answer);
      return parsed.success ? parsed.output : refusedRead(STOP.interrupted);
    },
    release: async (downloadUrl) => {
      await ask({ downloadUrl, target: TARGET, type: "release" });
    },
  };
};
