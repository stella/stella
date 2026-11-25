import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  BROWSER_WEB_DOWNLOAD_STOP_REASON,
  type BrowserExtensionDownloadMessage,
  type BrowserWebDownloadStopReason,
  decodeDownloadChunk,
} from "@stll/api-contract/browser-control";
import { BROWSER_DOWNLOAD_FILE_MAX_BYTES } from "@stll/api-contract/browser-downloads";

import type { ShownPdfReader } from "./shown-pdf-reader";
import type { WebDownloadTarget } from "./web-download-target";

/**
 * A download chat's tabs made under the web connection, handed to the
 * stella tab whose command ran last (`WebDownloadTarget`). Chrome's own
 * download is stopped; the offscreen reader fetches the file's address
 * once more, with the same rules as a shown PDF (public HTTPS only, the
 * cookies Chrome applies, never a redirect), and keeps the bytes as a
 * `blob:` address of the extension's own. They go to the stella tab in
 * pieces, and the bytes are freed once the last is sent or the hand-over
 * stops. The stella tab files the file with its chat.
 */
export type WebDelivery = {
  target: WebDownloadTarget;
  deliveryId: string;
  sourceUrl: string;
  suggestedName: string;
  /** The page chat's tab was on, only when the file came from its site. */
  pageUrl: string | null;
};

/** Hands one message to the target's stella tab; false when it is gone. */
export type WebDownloadSend = (
  target: WebDownloadTarget,
  message: BrowserExtensionDownloadMessage,
) => Promise<boolean>;

/** The stella tab's document, as it last messaged; Chrome's own send. */
export const sendToStellaTab: WebDownloadSend = async (target, message) => {
  const sent =
    target.documentId === null
      ? chrome.tabs.sendMessage(target.tabId, message)
      : chrome.tabs.sendMessage(target.tabId, message, {
          documentId: target.documentId,
        });
  return await sent.then(
    () => true,
    () => false,
  );
};

const PDF_MAGIC = "%PDF-";

const startsAsPdf = (firstPiece: string): boolean => {
  const bytes = decodeDownloadChunk(firstPiece);
  return (
    bytes !== null &&
    bytes.length >= PDF_MAGIC.length &&
    [...PDF_MAGIC].every(
      (character, index) => bytes[index] === character.codePointAt(0),
    )
  );
};

const envelope = (delivery: WebDelivery) => ({
  controllerId: delivery.target.controllerId,
  deliveryId: delivery.deliveryId,
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
});

/** Tells the stella tab a download started; sent before anything else of it. */
export const announceWebDelivery = async (
  delivery: WebDelivery,
  send: WebDownloadSend,
): Promise<boolean> =>
  await send(delivery.target, {
    ...envelope(delivery),
    pageUrl: delivery.pageUrl,
    sourceUrl: delivery.sourceUrl,
    suggestedName: delivery.suggestedName,
    turnId: delivery.target.turnId,
    type: "download-started",
  });

/** Tells the stella tab the extension stopped a download it announced. */
export const stopWebDelivery = async (
  delivery: WebDelivery,
  reason: BrowserWebDownloadStopReason,
  send: WebDownloadSend,
): Promise<void> => {
  await send(delivery.target, {
    ...envelope(delivery),
    end: { outcome: "stopped", reason },
    type: "download-end",
  });
};

/**
 * Fetches an announced download once more and hands its bytes on: every
 * piece in order, then the end with the bytes and pieces sent. A fetch the
 * reader refuses ends with its reason; bytes that are not a PDF's (a sign-in
 * page, an error page, an address served once) end as not refetchable. A
 * stella tab that is gone ends the hand-over; nobody is left to tell.
 */
export const captureWebDelivery = async (
  delivery: WebDelivery,
  reader: ShownPdfReader,
  send: WebDownloadSend,
): Promise<void> => {
  const read = await reader
    .read(delivery.sourceUrl, BROWSER_DOWNLOAD_FILE_MAX_BYTES)
    .catch(() => null);
  if (read === null || read.type === "refused") {
    await stopWebDelivery(
      delivery,
      read?.reason ?? BROWSER_WEB_DOWNLOAD_STOP_REASON.interrupted,
      send,
    );
    return;
  }
  try {
    const pieceBytes = BROWSER_CONTROL_LIMITS.downloadChunkBytes;
    const pieces = Math.ceil(read.bytes / pieceBytes);
    for (let index = 0; index < pieces; index += 1) {
      // await-in-loop: one piece at a time, in order, so the stella tab
      // holds at most what it was sent and a gone tab stops the rest.
      const data = await reader
        .slice(
          read.downloadUrl,
          index * pieceBytes,
          Math.min(read.bytes, (index + 1) * pieceBytes),
        )
        .catch(() => null);
      if (data === null) {
        await stopWebDelivery(
          delivery,
          BROWSER_WEB_DOWNLOAD_STOP_REASON.interrupted,
          send,
        );
        return;
      }
      if (index === 0 && !startsAsPdf(data)) {
        await stopWebDelivery(
          delivery,
          BROWSER_WEB_DOWNLOAD_STOP_REASON.notRefetchable,
          send,
        );
        return;
      }
      const sent = await send(delivery.target, {
        ...envelope(delivery),
        data,
        index,
        type: "download-chunk",
      });
      if (!sent) {
        return;
      }
    }
    if (pieces === 0) {
      await stopWebDelivery(
        delivery,
        BROWSER_WEB_DOWNLOAD_STOP_REASON.notRefetchable,
        send,
      );
      return;
    }
    await send(delivery.target, {
      ...envelope(delivery),
      end: { bytes: read.bytes, chunks: pieces, outcome: "captured" },
      type: "download-end",
    });
  } finally {
    await reader.release(read.downloadUrl).catch(() => undefined);
  }
};
