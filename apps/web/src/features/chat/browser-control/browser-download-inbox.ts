import { panic, Result } from "better-result";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_REFETCH_MS,
  BROWSER_WEB_DOWNLOAD_STOP_REASON,
  type BrowserControlResult,
  type BrowserExtensionDownloadMessage,
  type BrowserResultDownload,
  type BrowserWebDownloadStopReason,
  decodeDownloadChunk,
} from "@stll/api-contract/browser-control";
import { BROWSER_DOWNLOAD_FILE_MAX_BYTES } from "@stll/api-contract/browser-downloads";

import { detached } from "@/lib/detached";

/**
 * The one place this stella tab takes the downloads a chat's browser steps
 * made (the extension stops Chrome's own download and hands the file over
 * in pieces), files each with the chat whose command ran it, and hands
 * what became of it to that chat's next browser result.
 *
 * A download is taken only for a chat turn this tab ran a browser command
 * for (`rememberTurn`): the turn names the chat thread, and the API files
 * the file into that thread's own matter, never one the extension or a
 * page names. Its pieces must arrive in order, whole, within the size a
 * download may have, and without a long pause; otherwise it is dropped and
 * reported as not filed.
 */

/** Files one download with its chat; answers what the chat's result says of it. */
export type FileBrowserDownload = (download: {
  threadId: string;
  file: File;
  sourceUrl: string;
  pageUrl: string | null;
  downloadedAt: string;
}) => Promise<BrowserResultDownload>;

/** Runs `task` after `ms`; the returned function cancels it. */
export type InboxTimer = (task: () => void, ms: number) => () => void;

const systemTimer: InboxTimer = (task, ms) => {
  const timeout = setTimeout(task, ms);
  return () => {
    clearTimeout(timeout);
  };
};

/**
 * How long a step's result waits for the downloads its step started, as a
 * local run waits (`DOWNLOAD_SETTLE_WAIT_MS`). One that takes longer rides
 * on the chat's next browser result.
 */
export const BROWSER_DOWNLOAD_SETTLE_WAIT_MS = 3000;

/** A download whose next piece takes longer than this is dropped. */
export const BROWSER_DOWNLOAD_IDLE_MS = 60_000;

/**
 * How long the first piece may take: the extension fetches the whole file
 * before it sends any, within its own deadline for that fetch.
 */
export const BROWSER_DOWNLOAD_FIRST_PIECE_MS =
  BROWSER_DOWNLOAD_REFETCH_MS + BROWSER_DOWNLOAD_IDLE_MS;

/** Downloads taken at once; the extension runs fewer. */
const MAX_ARRIVING = 8;

/** Chat turns remembered, newest kept. */
const MAX_TURNS = 64;

/** What a chat's results have not reported yet, oldest dropped first. */
const MAX_UNREPORTED = 32;

const NO_NAME = "download.pdf";

const STOPPED_MESSAGES = {
  [BROWSER_WEB_DOWNLOAD_STOP_REASON.notPdf]:
    "The file is not a PDF, so it was not filed. Only PDFs are filed.",
  [BROWSER_WEB_DOWNLOAD_STOP_REASON.tooLarge]:
    "The file is larger than a filed download may be, so it was not filed.",
  [BROWSER_WEB_DOWNLOAD_STOP_REASON.tooMany]:
    "Too many downloads were running at once, so this one was not filed. Download it again once the others are listed.",
  [BROWSER_WEB_DOWNLOAD_STOP_REASON.interrupted]:
    "The download did not finish, so it was not filed.",
  [BROWSER_WEB_DOWNLOAD_STOP_REASON.redirected]:
    "Fetching the file again led to another address, which is never followed, so it was not filed.",
  [BROWSER_WEB_DOWNLOAD_STOP_REASON.otherSite]:
    "The file came from another website than the page, so it was not fetched with the user's sign-in there and was not filed. Open the file's own page in the tab to file it from there.",
  [BROWSER_WEB_DOWNLOAD_STOP_REASON.notRefetchable]:
    "The file could not be fetched again from its address (the page made it itself, or the site answered with something other than the PDF), so it was not filed. If the PDF opens in the tab, tell the user its address.",
} satisfies Record<BrowserWebDownloadStopReason, string>;

const NOT_FILED_MESSAGE = "The file could not be filed.";

const INCOMPLETE_MESSAGE =
  "The file did not arrive whole, so it was not filed.";

/** A turn at the Plan level files nothing, as a run on the member's computer. */
const PLAN_MESSAGE = "In Plan mode stella files nothing into the matter.";

/** The chat a turn's commands ran for, and whether its level files anything. */
type Turn = { threadId: string; filesNothing: boolean };

/** Delivery ids remembered so a repeated start is never taken twice. */
const MAX_SEEN = 256;

type Arriving = {
  threadId: string;
  sequence: number;
  sourceUrl: string;
  pageUrl: string | null;
  name: string;
  downloadedAt: string;
  pieces: Uint8Array[];
  bytes: number;
  /** Ends the wait for the next piece. */
  cancelIdle: () => void;
  /** Set once its end arrived and the file is being filed. */
  filing: boolean;
};

type StartedMessage = Extract<
  BrowserExtensionDownloadMessage,
  { type: "download-started" }
>;
type ChunkMessage = Extract<
  BrowserExtensionDownloadMessage,
  { type: "download-chunk" }
>;
type EndMessage = Extract<
  BrowserExtensionDownloadMessage,
  { type: "download-end" }
>;

/** Everything one inbox holds, shared by the steps below. */
type InboxState = {
  file: FileBrowserDownload;
  timer: InboxTimer;
  now: () => Date;
  turns: Map<string, Turn>;
  arriving: Map<string, Arriving>;
  /** Delivery ids seen, so a repeated start is never taken twice. */
  seen: Set<string>;
  unreported: Map<string, BrowserResultDownload[]>;
  /** Called whenever a delivery ends or a report lands. */
  listeners: Set<() => void>;
  sequence: number;
  /**
   * Each chat's open browser steps, and when its last one closed: a
   * download is taken only while a step of its chat runs or has just
   * ended, so one that starts later is never filed for whichever chat ran
   * the last command.
   */
  openSteps: Map<string, number>;
  closedAt: Map<string, number>;
};

const notify = (state: InboxState): void => {
  for (const listener of [...state.listeners]) {
    listener();
  }
};

const report = (
  state: InboxState,
  threadId: string,
  download: BrowserResultDownload,
): void => {
  const waiting = state.unreported.get(threadId);
  if (waiting === undefined) {
    state.unreported.set(threadId, [download]);
    return;
  }
  waiting.push(download);
  waiting.splice(0, Math.max(0, waiting.length - MAX_UNREPORTED));
};

const notFiled = (
  delivery: Pick<Arriving, "name" | "sourceUrl">,
  message: string,
): BrowserResultDownload => ({
  message,
  name: delivery.name,
  outcome: "not-filed",
  sourceUrl: delivery.sourceUrl,
});

/** Ends a delivery with what its chat is told; every exit goes through it. */
const finish = (
  state: InboxState,
  deliveryId: string,
  outcome: (delivery: Arriving) => BrowserResultDownload,
): void => {
  const delivery = state.arriving.get(deliveryId);
  if (delivery === undefined) {
    return;
  }
  delivery.cancelIdle();
  state.arriving.delete(deliveryId);
  report(state, delivery.threadId, outcome(delivery));
  notify(state);
};

const drop = (state: InboxState, deliveryId: string, message: string): void => {
  finish(state, deliveryId, (delivery) => notFiled(delivery, message));
};

/** Drops a delivery whose next piece does not come in time. */
const awaitPiece = (
  state: InboxState,
  deliveryId: string,
  ms: number,
): (() => void) =>
  state.timer(() => {
    drop(state, deliveryId, INCOMPLETE_MESSAGE);
  }, ms);

/** Whether a step of `threadId` runs now, or ended within the settle wait. */
const inStep = (state: InboxState, threadId: string): boolean => {
  if ((state.openSteps.get(threadId) ?? 0) > 0) {
    return true;
  }
  const closedAt = state.closedAt.get(threadId);
  return (
    closedAt !== undefined &&
    state.now().getTime() - closedAt <= BROWSER_DOWNLOAD_SETTLE_WAIT_MS
  );
};

const rememberSeen = (state: InboxState, deliveryId: string): void => {
  state.seen.add(deliveryId);
  for (const oldest of state.seen) {
    if (state.seen.size <= MAX_SEEN) {
      return;
    }
    state.seen.delete(oldest);
  }
};

/** Why a recognised download is not taken; null when it is. */
const refusalOf = (state: InboxState, turn: Turn): string | null => {
  if (turn.filesNothing) {
    return PLAN_MESSAGE;
  }
  if (state.arriving.size >= MAX_ARRIVING) {
    return STOPPED_MESSAGES[BROWSER_WEB_DOWNLOAD_STOP_REASON.tooMany];
  }
  return null;
};

const start = (state: InboxState, message: StartedMessage): void => {
  const turn = state.turns.get(message.turnId);
  if (
    turn === undefined ||
    state.seen.has(message.deliveryId) ||
    !inStep(state, turn.threadId)
  ) {
    return;
  }
  rememberSeen(state, message.deliveryId);
  const { threadId } = turn;
  const download = {
    name: message.suggestedName,
    sourceUrl: message.sourceUrl,
  };
  // Neither is taken: its pieces are ignored, and the chat only hears it
  // was not filed.
  const refusal = refusalOf(state, turn);
  if (refusal !== null) {
    report(state, threadId, notFiled(download, refusal));
    notify(state);
    return;
  }
  state.sequence += 1;
  state.arriving.set(message.deliveryId, {
    ...download,
    bytes: 0,
    cancelIdle: awaitPiece(
      state,
      message.deliveryId,
      BROWSER_DOWNLOAD_FIRST_PIECE_MS,
    ),
    downloadedAt: state.now().toISOString(),
    filing: false,
    pageUrl: message.pageUrl,
    pieces: [],
    sequence: state.sequence,
    threadId,
  });
};

const takePiece = (state: InboxState, message: ChunkMessage): void => {
  const delivery = state.arriving.get(message.deliveryId);
  if (delivery === undefined || delivery.filing) {
    return;
  }
  const bytes = decodeDownloadChunk(message.data);
  if (bytes === null || message.index !== delivery.pieces.length) {
    drop(state, message.deliveryId, INCOMPLETE_MESSAGE);
    return;
  }
  if (delivery.bytes + bytes.byteLength > BROWSER_DOWNLOAD_FILE_MAX_BYTES) {
    drop(
      state,
      message.deliveryId,
      STOPPED_MESSAGES[BROWSER_WEB_DOWNLOAD_STOP_REASON.tooLarge],
    );
    return;
  }
  delivery.pieces.push(bytes);
  delivery.bytes += bytes.byteLength;
  delivery.cancelIdle();
  delivery.cancelIdle = awaitPiece(
    state,
    message.deliveryId,
    BROWSER_DOWNLOAD_IDLE_MS,
  );
};

/** The whole file of a delivery, its pieces released. */
const wholeFile = (delivery: Arriving): File => {
  const body = new Uint8Array(delivery.bytes);
  let offset = 0;
  for (const piece of delivery.pieces) {
    body.set(piece, offset);
    offset += piece.byteLength;
  }
  delivery.pieces = [];
  return new File([body], delivery.name === "" ? NO_NAME : delivery.name, {
    type: "application/pdf",
  });
};

const fileWhole = async (
  state: InboxState,
  deliveryId: string,
  delivery: Arriving,
): Promise<void> => {
  const filed = await Result.tryPromise({
    try: async () =>
      await state.file({
        downloadedAt: delivery.downloadedAt,
        file: wholeFile(delivery),
        pageUrl: delivery.pageUrl,
        sourceUrl: delivery.sourceUrl,
        threadId: delivery.threadId,
      }),
    catch: (cause) => cause,
  });
  finish(state, deliveryId, (ended) =>
    Result.isOk(filed) ? filed.value : notFiled(ended, NOT_FILED_MESSAGE),
  );
};

const end = (state: InboxState, message: EndMessage): void => {
  const delivery = state.arriving.get(message.deliveryId);
  if (delivery === undefined || delivery.filing) {
    return;
  }
  const outcome = message.end;
  switch (outcome.outcome) {
    case "stopped":
      drop(state, message.deliveryId, STOPPED_MESSAGES[outcome.reason]);
      return;
    case "captured":
      if (
        outcome.chunks !== delivery.pieces.length ||
        outcome.bytes !== delivery.bytes
      ) {
        drop(state, message.deliveryId, INCOMPLETE_MESSAGE);
        return;
      }
      delivery.filing = true;
      delivery.cancelIdle();
      delivery.cancelIdle = () => undefined;
      detached(
        fileWhole(state, message.deliveryId, delivery),
        "browser-downloads.file",
      );
      return;
    default:
      outcome satisfies never;
      panic("Unhandled browser download end");
  }
};

const receive = (
  state: InboxState,
  message: BrowserExtensionDownloadMessage,
): void => {
  switch (message.type) {
    case "download-started":
      start(state, message);
      return;
    case "download-chunk":
      takePiece(state, message);
      return;
    case "download-end":
      end(state, message);
      return;
    default:
      message satisfies never;
      panic("Unhandled browser download message");
  }
};

/** Whether a download of `threadId` started after `since` is still arriving or filing. */
const pending = (state: InboxState, threadId: string, since: number): boolean =>
  [...state.arriving.values()].some(
    (delivery) => delivery.threadId === threadId && delivery.sequence > since,
  );

/** Waits, at most the settle wait, while such a download is pending. */
const settle = async (
  state: InboxState,
  threadId: string,
  since: number,
): Promise<void> => {
  if (!pending(state, threadId, since)) {
    return;
  }
  const settled = Promise.withResolvers<undefined>();
  const check = () => {
    if (!pending(state, threadId, since)) {
      settled.resolve(undefined);
    }
  };
  const cancel = state.timer(() => {
    settled.resolve(undefined);
  }, BROWSER_DOWNLOAD_SETTLE_WAIT_MS);
  state.listeners.add(check);
  await settled.promise;
  state.listeners.delete(check);
  cancel();
};

/** The downloads a chat's next result reports, oldest first, at most a result's worth. */
const take = (state: InboxState, threadId: string): BrowserResultDownload[] => {
  const waiting = state.unreported.get(threadId);
  if (waiting === undefined) {
    return [];
  }
  const taken = waiting.splice(0, BROWSER_CONTROL_LIMITS.resultDownloads);
  if (waiting.length === 0) {
    state.unreported.delete(threadId);
  }
  return taken;
};

/** `result` with `downloads` as its list; only this tab reports downloads, never the extension. */
const withDownloads = (
  result: BrowserControlResult,
  downloads: BrowserResultDownload[],
): BrowserControlResult => {
  const { downloads: _fromExtension, ...rest } = result;
  return downloads.length === 0 ? rest : { ...rest, downloads };
};

export const createBrowserDownloadInbox = ({
  file,
  timer = systemTimer,
  now = () => new Date(),
}: {
  file: FileBrowserDownload;
  timer?: InboxTimer;
  now?: () => Date;
}) => {
  const state: InboxState = {
    arriving: new Map(),
    file,
    closedAt: new Map(),
    listeners: new Set(),
    openSteps: new Map(),
    now,
    seen: new Set(),
    sequence: 0,
    timer,
    turns: new Map(),
    unreported: new Map(),
  };
  return {
    /**
     * The chat thread a turn's browser commands run for, and whether its
     * permission level files nothing (Plan); its latest command decides.
     */
    rememberTurn(turnId: string, turn: Turn): void {
      state.turns.delete(turnId);
      state.turns.set(turnId, turn);
      for (const oldest of state.turns.keys()) {
        if (state.turns.size <= MAX_TURNS) {
          break;
        }
        state.turns.delete(oldest);
      }
    },
    receive(message: BrowserExtensionDownloadMessage): void {
      receive(state, message);
    },
    /**
     * Opens one browser step of a chat. Its result waits a moment for the
     * downloads that started while the step ran (a sign-in hand-over
     * included), then carries every download of the chat not reported
     * yet; one still arriving rides on a later result.
     */
    openStep(threadId: string) {
      const since = state.sequence;
      state.openSteps.set(threadId, (state.openSteps.get(threadId) ?? 0) + 1);
      let ended = false;
      /** Ends the step once, however it ends: closed with a result, or not. */
      const endStep = () => {
        if (ended) {
          return;
        }
        ended = true;
        const open = (state.openSteps.get(threadId) ?? 1) - 1;
        if (open > 0) {
          state.openSteps.set(threadId, open);
        } else {
          state.openSteps.delete(threadId);
        }
        state.closedAt.set(threadId, state.now().getTime());
      };
      return {
        end: endStep,
        close: async (
          result: BrowserControlResult,
        ): Promise<BrowserControlResult> => {
          endStep();
          await settle(state, threadId, since);
          return withDownloads(result, take(state, threadId));
        },
      };
    },
    /** Resolves once no download is arriving or being filed. */
    async idle(): Promise<void> {
      if (state.arriving.size === 0) {
        return;
      }
      const idle = Promise.withResolvers<undefined>();
      const check = () => {
        if (state.arriving.size === 0) {
          idle.resolve(undefined);
        }
      };
      state.listeners.add(check);
      await idle.promise;
      state.listeners.delete(check);
    },
  };
};
