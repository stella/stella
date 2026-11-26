import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_REFETCH_MS,
  BROWSER_DOWNLOAD_STOP_REASON,
  encodeDownloadChunk,
} from "@stll/api-contract/browser-control";

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

/**
 * The bytes each read kept, by their `blob:` address, in the offscreen
 * document: a slice is read from here, never fetched again.
 */
const keptBlobs = new Map<string, Blob>();

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

const offsetSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(BROWSER_CONTROL_LIMITS.downloadBytes),
);

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
  v.strictObject({
    downloadUrl: v.pipe(v.string(), v.startsWith("blob:")),
    end: offsetSchema,
    start: offsetSchema,
    target: v.literal(TARGET),
    type: v.literal("slice"),
  }),
]);

/** A slice the offscreen document read of bytes it keeps, base64. */
const shownPdfSliceSchema = v.strictObject({
  data: v.pipe(v.string(), v.minLength(1), v.base64()),
  type: v.literal("slice"),
});

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
  switch (request.type) {
    case "read":
      return parseControllableUrl(request.url) === null ? null : request;
    case "release":
      return request;
    // One piece at a time, never more than a download piece holds.
    case "slice":
      return request.end > request.start &&
        request.end - request.start <= BROWSER_CONTROL_LIMITS.downloadChunkBytes
        ? request
        : null;
    default:
      request satisfies never;
      return panic("Unhandled shown PDF reader request");
  }
};

const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" ||
  (response.status >= 300 && response.status < 400);

/**
 * How long the reader waits for the response to start; past it the read
 * ends as interrupted.
 */
const SHOWN_PDF_HEADERS_TIMEOUT_MS = 30_000;

/**
 * How long the reader waits for the next chunk of the body; a stream that
 * stalls this long ends the read as interrupted. A body that keeps
 * arriving is read to its end or to the size limit.
 */
const SHOWN_PDF_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long the worker waits for the reader's answer before it stops
 * waiting and frees the save's slot, whatever the document still does:
 * long enough for the size limit to arrive over a slow connection.
 */
const READER_ANSWER_TIMEOUT_MS = BROWSER_DOWNLOAD_REFETCH_MS;

type ReadOptions = {
  /** The offscreen document's `fetch`. */
  fetcher?: typeof fetch;
  /** Sets the read's deadlines; a test passes its own. */
  timer?: ReaderTimer;
};

/**
 * Reads the body, at most `maxBytes` of it, until its end. Each chunk must
 * arrive within the idle deadline, which aborts the request otherwise.
 */
const readBody = async (
  body: NonNullable<Response["body"]>,
  maxBytes: number,
  awaitChunk: <T>(chunk: Promise<T>) => Promise<T>,
): Promise<
  { type: "bytes"; chunks: BlobPart[]; total: number } | ShownPdfRead
> => {
  const chunks: BlobPart[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      // await-in-loop: one chunk at a time, so a large file stops early.
      const chunk = await awaitChunk(reader.read()).catch(() => null);
      if (chunk === null) {
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
 * address. Runs in the offscreen document. The response must start within
 * the headers deadline and each chunk of its body arrive within the idle
 * deadline; either aborts the request. The HTTP cache is used when it
 * holds the response, so an address a site serves once can still be saved
 * when the tab's response was cached.
 */
export const readShownPdf = async (
  url: string,
  maxBytes: number,
  { fetcher = fetch, timer = systemReaderTimer }: ReadOptions = {},
): Promise<ShownPdfRead> => {
  const request = new AbortController();
  const abort = () => {
    request.abort();
  };
  /** Awaits `step`, aborting the request if it takes longer than `ms`. */
  const within =
    (ms: number) =>
    async <T>(step: Promise<T>): Promise<T> => {
      const cancel = timer(abort, ms);
      return await step.finally(cancel);
    };
  const response = await within(SHOWN_PDF_HEADERS_TIMEOUT_MS)(
    fetcher(url, {
      cache: "force-cache",
      credentials: "include",
      redirect: "manual",
      signal: request.signal,
    }),
  ).catch(() => null);
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
  const read = await readBody(
    body,
    maxBytes,
    within(SHOWN_PDF_IDLE_TIMEOUT_MS),
  );
  if (read.type !== "bytes") {
    return read;
  }
  const blob = new Blob(read.chunks, { type: "application/pdf" });
  const downloadUrl = URL.createObjectURL(blob);
  keptBlobs.set(downloadUrl, blob);
  return {
    bytes: read.total,
    downloadUrl,
    fetchedUrl: response.url === "" ? url : response.url,
    type: "read",
  };
};

/** Frees a read's bytes: its address and the bytes it names. */
export const releaseKeptBytes = (downloadUrl: string): void => {
  keptBlobs.delete(downloadUrl);
  URL.revokeObjectURL(downloadUrl);
};

/**
 * Answers one slice of bytes a read kept, base64, in the offscreen
 * document; bytes no read keeps (released, or never read) close the port
 * unanswered.
 */
export const answerShownPdfSlice = async (
  request: { downloadUrl: string; end: number; start: number },
  post: (answer: v.InferOutput<typeof shownPdfSliceSchema>) => void,
): Promise<boolean> => {
  const blob = keptBlobs.get(request.downloadUrl);
  if (blob === undefined || request.end > blob.size) {
    return false;
  }
  const bytes = new Uint8Array(
    await blob.slice(request.start, request.end).arrayBuffer(),
  );
  post({ data: encodeDownloadChunk(bytes), type: "slice" });
  return true;
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
    revoke = releaseKeptBytes,
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
  /**
   * The bytes from `start` to `end` of what a read kept, base64, at most a
   * download piece of them; null when the reader keeps none there.
   */
  slice: (
    downloadUrl: string,
    start: number,
    end: number,
  ) => Promise<string | null>;
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
    slice: async (downloadUrl, start, end) => {
      const answer = await ask({
        downloadUrl,
        end,
        start,
        target: TARGET,
        type: "slice",
      });
      const parsed = v.safeParse(shownPdfSliceSchema, answer);
      return parsed.success ? parsed.output.data : null;
    },
  };
};
