import { panic, Result } from "better-result";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_STOP_REASON,
  browserDocumentAddress,
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
import { parseControllableUrl } from "./origin-policy";
import { isPdfMimeType, type ShownPdf } from "./shown-document";
import {
  BROWSER_DOWNLOAD_NOTICES_STORAGE_KEY,
  BROWSER_SHOWN_PDF_SAVES_STORAGE_KEY,
} from "./storage-keys";
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

/**
 * A desktop chat's downloads Chrome may run at once, shown PDFs it saves
 * included; another is stopped.
 */
export const MAX_RUNNING_DELIVERIES = 4;

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
  isPdfMimeType(download.mime) ||
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

/**
 * Tells stella desktop about a download a chat takes: when Chrome starts
 * saving it, and once it settles. Each delivery has one id throughout; a
 * download stopped before it started is reported settled only.
 */
export type DownloadReporter = {
  started: (chatId: string, deliveryId: string) => void;
  settled: (
    chatId: string,
    deliveryId: string,
    download: BrowserDownload,
  ) => void;
};

const SILENT_REPORTER: DownloadReporter = {
  settled: () => undefined,
  started: () => undefined,
};

let reporter: DownloadReporter = SILENT_REPORTER;

/** Set once by the worker: the desktop link's reports. */
export const setDownloadReporter = (report: DownloadReporter): void => {
  reporter = report;
};

/**
 * How a delivery began: a download a chat's tab started, or a PDF the
 * chat's tab shows that the extension saves itself.
 */
type DeliveryKind = "download" | "shown-pdf";

/** A download a desktop chat takes, from its judgement until it settles. */
type Delivery = {
  chatId: string;
  deliveryId: string;
  kind: DeliveryKind;
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

/**
 * Shown PDFs whose save was asked of Chrome, by delivery id, until Chrome
 * names the download: they count against the limit from the start.
 */
const startingShownSaves = new Map<string, Delivery>();

const runningDeliveries = (): number =>
  deliveries.size + startingShownSaves.size;

const sourceUrlOf = (download: DownloadFacts): string =>
  (download.finalUrl === "" ? download.url : download.finalUrl).slice(
    0,
    BROWSER_CONTROL_LIMITS.urlChars,
  );

/** A fresh delivery: its id also names the staged file. */
const newDelivery = (
  chatId: string,
  kind: DeliveryKind,
  { sourceUrl, suggestedName }: Pick<Delivery, "sourceUrl" | "suggestedName">,
): Delivery => {
  const deliveryId = crypto.randomUUID();
  return {
    chatId,
    deliveryId,
    kind,
    sourceUrl,
    stagedPath: browserDownloadStagedPath(deliveryId),
    suggestedName,
  };
};

/**
 * The verdict for a desktop chat, and the slot it takes when it delivers,
 * in one synchronous step: no other judgement runs between the count and
 * the reservation.
 */
const reserveDelivery = (
  download: DownloadFacts & { id: number },
  chatId: string,
): DesktopDownloadVerdict => {
  const verdict = desktopDownloadVerdict(download, runningDeliveries());
  if (verdict.type === "deliver") {
    deliveries.set(
      download.id,
      newDelivery(chatId, "download", {
        sourceUrl: sourceUrlOf(download),
        suggestedName: suggestedDownloadName(download),
      }),
    );
  }
  return verdict;
};

/**
 * The desktop chat that takes downloads now: the one holding the browser,
 * while stella desktop is connected. Null under the web connection.
 */
const readTakingDesktopChat = async (): Promise<string | null> => {
  const holder = await readControlHolder();
  switch (holder.transport) {
    case CONTROL_TRANSPORT.web:
      return null;
    case CONTROL_TRANSPORT.desktop: {
      const chatId = desktopChatId(holder.controllerId);
      return chatId !== null &&
        (await readDesktopLinkState()) === DESKTOP_LINK_STATE.connected
        ? chatId
        : null;
    }
    default:
      holder satisfies never;
      return panic("Unhandled control transport");
  }
};

/** Who takes a download traced to chat's tabs, judged now. */
const readDownloadReceiver = async (
  download: DownloadFacts & { id: number },
): Promise<DownloadReceiver> => {
  const chatId = await readTakingDesktopChat();
  return chatId === null
    ? NO_DOWNLOAD_RECEIVER
    : { chatId, type: "desktop", verdict: reserveDelivery(download, chatId) };
};

/** Reports a delivery stopped before Chrome saved anything. */
const reportStopped = (
  delivery: Pick<
    Delivery,
    "chatId" | "deliveryId" | "sourceUrl" | "suggestedName"
  >,
  reason: BrowserDownloadStopReason,
): void => {
  reporter.settled(delivery.chatId, delivery.deliveryId, {
    outcome: "stopped",
    reason,
    sourceUrl: delivery.sourceUrl,
    suggestedName: delivery.suggestedName,
  });
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

/**
 * The shown PDF save a download of this extension's is, moved to the
 * deliveries under its download id; null when it is none. Matched by the
 * address the save asked Chrome for.
 */
const claimShownSave = (
  download: Pick<chrome.downloads.DownloadItem, "id" | "url">,
): Delivery | null => {
  const claimed = deliveries.get(download.id);
  if (claimed !== undefined) {
    return claimed;
  }
  const starting = [...startingShownSaves.values()].find(
    ({ sourceUrl }) => sourceUrl === download.url,
  );
  if (starting === undefined) {
    return null;
  }
  startingShownSaves.delete(starting.deliveryId);
  deliveries.set(download.id, starting);
  return starting;
};

/**
 * A download this extension started: only a shown PDF's save, which is
 * never traced, since the extension asked for it. One larger than the limit
 * is stopped, as is any download of the extension's that no save explains.
 */
const judgeOwnDownload = async (
  download: chrome.downloads.DownloadItem,
): Promise<void> => {
  const delivery = claimShownSave(download);
  if (delivery === null) {
    await cancelDownload(download.id);
    return;
  }
  if (download.totalBytes > BROWSER_CONTROL_LIMITS.downloadBytes) {
    deliveries.delete(download.id);
    reportStopped(delivery, BROWSER_DOWNLOAD_STOP_REASON.tooLarge);
    await cancelDownload(download.id);
  }
};

const runJudgement = async (
  download: chrome.downloads.DownloadItem,
  clock: TraceClock,
): Promise<void> => {
  if (
    download.byExtensionId !== undefined &&
    download.byExtensionId === chrome.runtime.id
  ) {
    await judgeOwnDownload(download);
    return;
  }
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
    case "deliver": {
      const delivery = deliveries.get(download.id);
      if (delivery !== undefined) {
        reporter.started(delivery.chatId, delivery.deliveryId);
      }
      return;
    }
    case "refuse":
      if (receiver.type === "desktop" && receiver.verdict.type === "stop") {
        reportStopped(
          {
            chatId: receiver.chatId,
            deliveryId: crypto.randomUUID(),
            sourceUrl: sourceUrlOf(download),
            suggestedName: suggestedDownloadName(download),
          },
          receiver.verdict.reason,
        );
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
      // Chrome names a page's download only here; the earlier event may
      // not have. A shown PDF keeps the name its save chose.
      if (delivery.kind === "download") {
        deliveries.set(download.id, {
          ...delivery,
          suggestedName: suggestedDownloadName(download),
        });
      }
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
    reportStopped(delivery, BROWSER_DOWNLOAD_STOP_REASON.interrupted);
    return;
  }
  reporter.settled(delivery.chatId, delivery.deliveryId, {
    bytes: Math.max(0, item.fileSize > 0 ? item.fileSize : item.bytesReceived),
    mime: item.mime.slice(0, 255),
    outcome: "saved",
    path: item.filename.slice(0, BROWSER_CONTROL_LIMITS.downloadPathChars),
    // A shown PDF is known by the tab's address, wherever its save went.
    sourceUrl:
      delivery.kind === "shown-pdf" ? delivery.sourceUrl : sourceUrlOf(item),
    suggestedName: delivery.suggestedName,
  });
};

/** Shown PDF saves each run remembers; older ones are forgotten first. */
const SHOWN_PDF_SAVES_LIMIT = 64;

// Marking reads, changes and writes one stored list; the worker applies
// each mark in turn so two reads of the same PDF never both save it.
let shownSavesTail: Promise<unknown> = Promise.resolve();

/** Marks a shown PDF of a run as saved; false when it already was. */
const markShownPdf = async (key: string): Promise<boolean> => {
  const mark = async (): Promise<boolean> => {
    const stored: unknown = (
      await chrome.storage.session.get(BROWSER_SHOWN_PDF_SAVES_STORAGE_KEY)
    )[BROWSER_SHOWN_PDF_SAVES_STORAGE_KEY];
    const keys = Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (keys.includes(key)) {
      return false;
    }
    await chrome.storage.session.set({
      [BROWSER_SHOWN_PDF_SAVES_STORAGE_KEY]: [...keys, key].slice(
        -SHOWN_PDF_SAVES_LIMIT,
      ),
    });
    return true;
  };
  const next = shownSavesTail.then(mark, mark);
  shownSavesTail = next.catch(() => undefined);
  return await next;
};

/**
 * The name a shown PDF is saved under: the address's file name when it
 * says PDF, else the title the read returned, else the address's last
 * segment. stella desktop makes it safe.
 */
const shownPdfName = (address: string, title: string): string =>
  (
    [
      urlFileName(address).toLowerCase().endsWith(".pdf")
        ? urlFileName(address)
        : "",
      title.trim(),
      urlFileName(address),
    ].find((name) => name !== "") ?? ""
  ).slice(0, BROWSER_CONTROL_LIMITS.downloadNameChars);

/** A PDF a chat's command found its tab showing, and the run it ran in. */
export type ShownPdfRequest = ShownPdf & {
  /** The id the chat's commands run under. */
  controllerId: string;
  turnId: string;
};

/**
 * Saves a PDF the chat's tab shows through the same path as a download:
 * only for the desktop chat holding the browser while stella desktop is
 * connected, once per address in each of its runs, within the same limits,
 * into the staging folder under a fresh name, reported the same way.
 * Chrome fetches the tab's own address again, with the cookies it applies
 * to it; a site that serves an address once answers that second request
 * with an error, which comes back as an interrupted download or as a file
 * stella desktop refuses.
 */
export const saveShownPdf = async ({
  controllerId,
  title,
  turnId,
  url,
}: ShownPdfRequest): Promise<void> => {
  const chatId = await readTakingDesktopChat();
  if (
    chatId === null ||
    chatId !== desktopChatId(controllerId) ||
    parseControllableUrl(url) === null
  ) {
    return;
  }
  const address = browserDocumentAddress(url);
  if (address.length > BROWSER_CONTROL_LIMITS.urlChars) {
    return;
  }
  const delivery = newDelivery(chatId, "shown-pdf", {
    sourceUrl: address,
    suggestedName: shownPdfName(address, title),
  });
  // The slot is checked and taken in one step, as a judged download's is.
  // A PDF stopped for too many saves is not marked: showing it again tries
  // again.
  if (runningDeliveries() >= MAX_RUNNING_DELIVERIES) {
    reportStopped(delivery, BROWSER_DOWNLOAD_STOP_REASON.tooMany);
    return;
  }
  startingShownSaves.set(delivery.deliveryId, delivery);
  const first = await markShownPdf(`${turnId}\n${chatId}\n${address}`).catch(
    () => false,
  );
  if (!first) {
    startingShownSaves.delete(delivery.deliveryId);
    return;
  }
  reporter.started(chatId, delivery.deliveryId);
  // Without the optional downloads permission there is nothing to ask.
  const started = Reflect.has(chrome, "downloads")
    ? await Result.tryPromise(
        async () =>
          await chrome.downloads.download({
            conflictAction: "uniquify",
            filename: delivery.stagedPath,
            saveAs: false,
            url: address,
          }),
      )
    : null;
  if (started === null || Result.isError(started)) {
    startingShownSaves.delete(delivery.deliveryId);
    reportStopped(delivery, BROWSER_DOWNLOAD_STOP_REASON.interrupted);
    return;
  }
  // Chrome may have named the download already; then its judgement
  // claimed the save.
  claimShownSave({ id: started.value, url: address });
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
