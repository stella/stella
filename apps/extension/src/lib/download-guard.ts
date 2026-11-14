import { panic } from "better-result";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_STOP_REASON,
  type BrowserDownload,
  browserDownloadStagedPath,
  type BrowserDownloadStopReason,
} from "@stll/api-contract/browser-control";

import { CONTROL_TRANSPORT, readControlHolder } from "./control-holder";
import {
  DESKTOP_LINK_STATE,
  desktopChatId,
  readDesktopLinkState,
} from "./desktop-link";
import {
  recordNavigation,
  systemTraceClock,
  type TraceClock,
  type TracedOwner,
  traceDownload,
} from "./download-trace";
import { BROWSER_DOWNLOAD_NOTICES_STORAGE_KEY } from "./storage-keys";
import {
  containedTabIds,
  readContainedTabs,
  type TabOwners,
} from "./tab-containment";

type DownloadAction =
  "allow" | "cancel" | "deliver" | "keep-and-flag" | "refuse";

/** Why a desktop chat does not take a download its tab started. */
type DesktopStopReason = Exclude<
  BrowserDownloadStopReason,
  typeof BROWSER_DOWNLOAD_STOP_REASON.interrupted
>;

/** Whether a desktop chat takes a download its tab started. */
export type DesktopDownloadVerdict =
  { type: "deliver" } | { type: "stop"; reason: DesktopStopReason };

/**
 * Who takes a download from chat's tabs. Nobody under the web connection, or
 * while stella desktop is not connected: such a download is stopped, as
 * always. A desktop chat takes a PDF (`deliver`): Chrome saves it into the
 * staging folder and stella desktop checks the file and moves it into the
 * chat's folder. Anything else is stopped and the chat is told why.
 */
export type DownloadReceiver =
  | { type: "none" }
  | { type: "desktop"; chatId: string; verdict: DesktopDownloadVerdict };

export const NO_DOWNLOAD_RECEIVER: DownloadReceiver = { type: "none" };

const containedAction = (receiver: DownloadReceiver): DownloadAction => {
  switch (receiver.type) {
    case "none":
      return "cancel";
    case "desktop":
      return receiver.verdict.type === "deliver" ? "deliver" : "refuse";
    default:
      receiver satisfies never;
      return panic("Unhandled download receiver");
  }
};

/**
 * What to do with a download while stella controls a tab. It goes through
 * only when it is traced to the user's tabs, alone or beside confined ones;
 * one traced to confined tabs, or to nobody, is stopped while it runs,
 * unless it is traced to chat's tabs and a desktop chat takes it
 * (`DownloadReceiver`). A download traced to both sides goes through: the
 * user may have started it, and stopping it would leave them no way to get
 * a file whenever stella works on the same site. A confined page can only
 * use that when the user's own tabs already reach the same address. A file
 * is never deleted here: tracing cannot prove who started a download, so a
 * finished one stays on disk and the user is told about it. Chrome holds
 * each download until it is judged, so a finished one means Chrome skipped
 * that step.
 */
export const downloadAction = (
  owner: TracedOwner,
  state: chrome.downloads.DownloadItem["state"],
  receiver: DownloadReceiver,
): DownloadAction => {
  switch (owner) {
    case "ambiguous":
    case "user":
      return "allow";
    case "contained":
      return state === "complete" ? "keep-and-flag" : containedAction(receiver);
    case "unexplained":
    case "untraceable":
      return state === "complete" ? "keep-and-flag" : "cancel";
    default:
      owner satisfies never;
      return panic("Unhandled download owner");
  }
};

type DownloadFacts = Pick<
  chrome.downloads.DownloadItem,
  "filename" | "finalUrl" | "mime" | "totalBytes" | "url"
>;

/** A desktop chat's downloads Chrome may run at once; another is stopped. */
export const MAX_RUNNING_DELIVERIES = 4;

const PDF_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/x-pdf",
]);

/** The last segment of a path or URL path, `/` or `\` separated. */
const lastSegment = (value: string): string =>
  value.split(/[/\\]/u).at(-1) ?? "";

const urlFileName = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? decodeURIComponent(lastSegment(url.pathname))
      : "";
  } catch {
    return "";
  }
};

/** The file name the page or server suggested; Chrome's, else the URL's. */
const suggestedDownloadName = (download: DownloadFacts): string =>
  (
    [
      lastSegment(download.filename),
      urlFileName(download.finalUrl),
      urlFileName(download.url),
    ].find((name) => name !== "") ?? ""
  ).slice(0, BROWSER_CONTROL_LIMITS.downloadNameChars);

/**
 * Whether a download says it is a PDF, by its type or its name. It only
 * decides whether Chrome may save it; stella desktop reads the saved
 * file's first bytes before it takes it.
 */
const saysPdf = (download: DownloadFacts): boolean =>
  PDF_TYPES.has(download.mime.split(";")[0]?.trim().toLowerCase() ?? "") ||
  suggestedDownloadName(download).toLowerCase().endsWith(".pdf");

/** Whether a desktop chat takes a download its tab started. */
export const desktopDownloadVerdict = (
  download: DownloadFacts,
  running: number,
): DesktopDownloadVerdict => {
  if (!saysPdf(download)) {
    return { reason: BROWSER_DOWNLOAD_STOP_REASON.notPdf, type: "stop" };
  }
  if (download.totalBytes > BROWSER_CONTROL_LIMITS.downloadBytes) {
    return { reason: BROWSER_DOWNLOAD_STOP_REASON.tooLarge, type: "stop" };
  }
  if (running >= MAX_RUNNING_DELIVERIES) {
    return { reason: BROWSER_DOWNLOAD_STOP_REASON.tooMany, type: "stop" };
  }
  return { type: "deliver" };
};

/** Tells stella desktop about a download of a chat's tab. */
export type DownloadReporter = (
  chatId: string,
  download: BrowserDownload,
) => void;

let reporter: DownloadReporter = () => undefined;

/** Set once by the worker: the desktop link's report. */
export const setDownloadReporter = (report: DownloadReporter): void => {
  reporter = report;
};

/** A download a desktop chat takes, from its judgement until it settles. */
type Delivery = {
  chatId: string;
  /** Where Chrome is told to save it, relative to its download folder. */
  stagedPath: string;
  sourceUrl: string;
  suggestedName: string;
};

/**
 * Every download a desktop chat takes, by id: reserved in the same step
 * that counts the running ones, so downloads judged at once never pass the
 * limit together, and released by every judgement that does not deliver.
 */
const deliveries = new Map<number, Delivery>();

const sourceUrlOf = (download: DownloadFacts): string =>
  (download.finalUrl === "" ? download.url : download.finalUrl).slice(
    0,
    BROWSER_CONTROL_LIMITS.urlChars,
  );

/**
 * The verdict for a desktop chat, and the slot it takes when it delivers,
 * in one synchronous step: no other judgement runs between the count and
 * the reservation.
 */
const reserveDelivery = (
  download: DownloadFacts & { id: number },
  chatId: string,
): DesktopDownloadVerdict => {
  const verdict = desktopDownloadVerdict(download, deliveries.size);
  if (verdict.type === "deliver") {
    deliveries.set(download.id, {
      chatId,
      sourceUrl: sourceUrlOf(download),
      stagedPath: browserDownloadStagedPath(crypto.randomUUID()),
      suggestedName: suggestedDownloadName(download),
    });
  }
  return verdict;
};

/** Who takes a download traced to chat's tabs, judged now. */
const readDownloadReceiver = async (
  download: DownloadFacts & { id: number },
): Promise<DownloadReceiver> => {
  const holder = await readControlHolder();
  switch (holder.transport) {
    case CONTROL_TRANSPORT.web:
      return NO_DOWNLOAD_RECEIVER;
    case CONTROL_TRANSPORT.desktop: {
      const chatId = desktopChatId(holder.controllerId);
      if (
        chatId === null ||
        (await readDesktopLinkState()) !== DESKTOP_LINK_STATE.connected
      ) {
        return NO_DOWNLOAD_RECEIVER;
      }
      return {
        chatId,
        type: "desktop",
        verdict: reserveDelivery(download, chatId),
      };
    }
    default:
      holder satisfies never;
      return panic("Unhandled control transport");
  }
};

/** Downloads stella stopped, and finished ones it kept, since the popup last showed them. */
export type DownloadNotices = { kept: number; stopped: number };

const NO_NOTICES: DownloadNotices = { kept: 0, stopped: 0 };

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;

const parseNotices = (input: unknown): DownloadNotices =>
  typeof input === "object" && input !== null
    ? {
        kept: "kept" in input ? count(input.kept) : 0,
        stopped: "stopped" in input ? count(input.stopped) : 0,
      }
    : NO_NOTICES;

const readNotices = async (): Promise<DownloadNotices> => {
  const stored = await chrome.storage.session.get(
    BROWSER_DOWNLOAD_NOTICES_STORAGE_KEY,
  );
  return parseNotices(stored[BROWSER_DOWNLOAD_NOTICES_STORAGE_KEY]);
};

/** The popup message for what happened, with its substitutions; null when nothing did. */
export const downloadNoticeMessage = ({
  kept,
  stopped,
}: DownloadNotices): { name: string; substitutions: string[] } | null => {
  if (kept > 0 && stopped > 0) {
    return {
      name: "downloadsStoppedAndKept",
      substitutions: [String(stopped), String(kept)],
    };
  }
  if (kept > 0) {
    return { name: "downloadKept", substitutions: [String(kept)] };
  }
  return stopped > 0
    ? { name: "downloadStopped", substitutions: [String(stopped)] }
    : null;
};

/**
 * Records a download stella stopped, or one that finished before it could
 * and was kept, and shows the count on the toolbar icon until the popup
 * opens. The icon's tooltip names what happened.
 */
// Recording and taking notices read, change and write the same stored
// value; the worker applies them one at a time, in the order they arrive,
// so no update overwrites another.
let noticeTail: Promise<unknown> = Promise.resolve();

const serializeNotices = async <T>(task: () => Promise<T>): Promise<T> => {
  const next = noticeTail.then(task, task);
  noticeTail = next.catch(() => undefined);
  return await next;
};

export const recordDownloadNotice = async (
  outcome: keyof DownloadNotices,
): Promise<void> => {
  await serializeNotices(async () => {
    await applyDownloadNotice(outcome);
  });
};

const applyDownloadNotice = async (
  outcome: keyof DownloadNotices,
): Promise<void> => {
  const previous = await readNotices();
  const next = { ...previous, [outcome]: previous[outcome] + 1 };
  await chrome.storage.session.set({
    [BROWSER_DOWNLOAD_NOTICES_STORAGE_KEY]: next,
  });
  await chrome.action.setBadgeText({ text: String(next.kept + next.stopped) });
  const notice = downloadNoticeMessage(next);
  if (notice !== null) {
    await chrome.action.setTitle({
      title: chrome.i18n.getMessage(notice.name, notice.substitutions),
    });
  }
};

// Every judgement, pending or done, by download id: Chrome may report one
// download through several events, and each waits for the same verdict.
const judgements = new Map<number, Promise<void>>();
// Downloads stopped; one Chrome lets run on is stopped again. Downloads kept
// after finishing unjudged are noted once.
const stopped = new Set<number>();
const kept = new Set<number>();

type DownloadScope = TabOwners;

// The owners of tabs, kept in memory so a download is judged under the owners
// in force when Chrome reports it; null until first read after the worker
// starts.
let scopeNow: DownloadScope | null = null;

const readScope = async (): Promise<DownloadScope> => {
  const containment = await readContainedTabs();
  return {
    contained: containedTabIds(containment),
    user: containment.userTabIds,
  };
};

/**
 * Records a navigation while stella controls a tab, so a download it turns
 * into can be traced to the tab that made it.
 */
export const noteNavigation = async (
  details: Parameters<typeof recordNavigation>[0],
): Promise<void> => {
  const scope = scopeNow ?? (await readScope());
  if (scope.contained.length > 0) {
    await recordNavigation(details);
  }
};

/** Takes the owners a containment change publishes, in the same task. */
export const setDownloadScope = (owners: TabOwners): void => {
  scopeNow = owners;
};

/**
 * Reads the stored owners when the worker starts. A change published while
 * the read ran is newer and wins.
 */
export const loadDownloadScope = async (): Promise<void> => {
  const stored = await readScope();
  scopeNow ??= stored;
};

/** A download that finished before it could be stopped stays, and is noted. */
const keepFinishedDownload = async (downloadId: number): Promise<void> => {
  if (kept.has(downloadId)) {
    return;
  }
  kept.add(downloadId);
  await recordDownloadNotice("kept");
};

/** Stops a download; one that finished first is kept and noted. */
const cancelDownload = async (downloadId: number): Promise<void> => {
  stopped.add(downloadId);
  await chrome.downloads.cancel(downloadId).catch(() => undefined);
  const [after] = await chrome.downloads.search({ id: downloadId });
  await (after?.state === "complete"
    ? keepFinishedDownload(downloadId)
    : recordDownloadNotice("stopped"));
};

const runJudgement = async (
  download: chrome.downloads.DownloadItem,
  clock: TraceClock,
): Promise<void> => {
  const scope = scopeNow ?? (await readScope());
  if (scope.contained.length === 0) {
    return;
  }
  const owner = await traceDownload(download, scope, clock);
  const receiver =
    owner === "contained"
      ? await readDownloadReceiver(download)
      : NO_DOWNLOAD_RECEIVER;
  const release = () => {
    deliveries.delete(download.id);
  };
  const current = await chrome.downloads.search({ id: download.id }).then(
    ([item]) => item,
    (error: unknown) => {
      release();
      throw error;
    },
  );
  const action = downloadAction(
    owner,
    current?.state ?? download.state,
    receiver,
  );
  // Only a download that is delivered keeps the slot its verdict reserved.
  if (action !== "deliver") {
    release();
  }
  switch (action) {
    case "allow":
      return;
    case "keep-and-flag":
      await keepFinishedDownload(download.id);
      return;
    case "deliver":
      return;
    case "refuse":
      if (receiver.type === "desktop" && receiver.verdict.type === "stop") {
        reporter(receiver.chatId, {
          outcome: "stopped",
          reason: receiver.verdict.reason,
          sourceUrl: sourceUrlOf(download),
          suggestedName: suggestedDownloadName(download),
        });
      }
      await cancelDownload(download.id);
      return;
    case "cancel":
      await cancelDownload(download.id);
      return;
    default:
      action satisfies never;
      panic("Unhandled download action");
  }
};

/**
 * Judges a download while stella controls a tab. The tab's network rules
 * block attachment and non-page responses before most downloads exist; this
 * catches the rest, such as a response Chrome sniffs into a download or a
 * page script saving a file through `a[download]`. Every report of one
 * download shares one judgement: a later caller waits for a judgement still
 * running.
 */
export const judgeDownload = async (
  download: chrome.downloads.DownloadItem,
  clock: TraceClock = systemTraceClock,
): Promise<void> => {
  const existing = judgements.get(download.id);
  if (existing !== undefined) {
    await existing;
    return;
  }
  const judgement = runJudgement(download, clock).catch(() => undefined);
  judgements.set(download.id, judgement);
  await judgement;
};

/**
 * Called for every download change. Chrome may let a download that was
 * stopped while it waited for its file name run on; it is stopped again,
 * or, once finished, kept and noted.
 */
export const enforceStoppedDownload = async (
  delta: chrome.downloads.DownloadDelta,
): Promise<void> => {
  if (!stopped.has(delta.id) || delta.state?.current === "interrupted") {
    return;
  }
  const [current] = await chrome.downloads.search({ id: delta.id });
  if (current === undefined || current.state === "interrupted") {
    return;
  }
  if (current.state === "complete") {
    await keepFinishedDownload(delta.id);
    return;
  }
  await chrome.downloads.cancel(delta.id).catch(() => undefined);
};

/** `suggest` as `onDeterminingFilename` hands it over. */
export type SuggestFilename = (
  suggestion?: chrome.downloads.FilenameSuggestion,
) => void;

/**
 * Holds a download at its file name until its judgement, started here or
 * by an earlier event, is done. Chrome writes nothing before `suggest` is
 * called; returns true so Chrome waits for it. A download a desktop chat
 * takes is saved under a fresh name in the staging folder, whatever name
 * the page suggested; that name only travels with the report.
 */
export const holdDownloadForJudgement = (
  download: chrome.downloads.DownloadItem,
  suggest: SuggestFilename,
  clock: TraceClock = systemTraceClock,
): boolean => {
  judgeDownload(download, clock)
    .catch(() => undefined)
    .then(() => {
      const delivery = deliveries.get(download.id);
      if (delivery === undefined) {
        suggest();
        return undefined;
      }
      // Chrome names the file only here; the earlier event may not have.
      deliveries.set(download.id, {
        ...delivery,
        suggestedName: suggestedDownloadName(download),
      });
      suggest({ conflictAction: "uniquify", filename: delivery.stagedPath });
      return undefined;
    })
    .catch(() => undefined);
  return true;
};

/**
 * Called for every download change: a download a desktop chat takes is
 * reported once it settles, saved or not. Where Chrome saved it is
 * reported as Chrome says; stella desktop checks the file itself.
 */
export const reportDeliveredDownload = async (
  delta: chrome.downloads.DownloadDelta,
): Promise<void> => {
  const delivery = deliveries.get(delta.id);
  const settled = delta.state?.current;
  if (
    delivery === undefined ||
    (settled !== "complete" && settled !== "interrupted")
  ) {
    return;
  }
  deliveries.delete(delta.id);
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (item?.state !== "complete" || item.filename === "") {
    reporter(delivery.chatId, {
      outcome: "stopped",
      reason: BROWSER_DOWNLOAD_STOP_REASON.interrupted,
      sourceUrl: delivery.sourceUrl,
      suggestedName: delivery.suggestedName,
    });
    return;
  }
  reporter(delivery.chatId, {
    bytes: Math.max(0, item.fileSize > 0 ? item.fileSize : item.bytesReceived),
    mime: item.mime.slice(0, 255),
    outcome: "saved",
    path: item.filename.slice(0, BROWSER_CONTROL_LIMITS.downloadPathChars),
    sourceUrl: sourceUrlOf(item),
    suggestedName: delivery.suggestedName,
  });
};

/**
 * Returns the download notices and clears them once the user has seen them.
 * Runs in the worker, in turn with recording, so a notice recorded while
 * the popup opens is either shown now or kept for next time.
 */
export const takeDownloadNotices = async (): Promise<DownloadNotices> =>
  await serializeNotices(async () => {
    const notices = await readNotices();
    await chrome.storage.session.remove(BROWSER_DOWNLOAD_NOTICES_STORAGE_KEY);
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "" });
    return notices;
  });
