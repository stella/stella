import { panic } from "better-result";

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

type DownloadAction = "allow" | "cancel" | "keep-and-flag";

/**
 * What to do with a download while stella controls a tab. It goes through
 * only when it is traced to the user's tabs, alone or beside confined ones;
 * one traced to confined tabs, or to nobody, is stopped while it runs. A
 * download traced to both sides goes through: the user may have started
 * it, and stopping it would leave them no way to get a file whenever stella
 * works on the same site. A confined page can only use that when the user's
 * own tabs already reach the same address. A file is never deleted: tracing cannot prove who started a
 * download, so a finished one stays on disk and the user is told about it.
 * Chrome holds each download until it is judged, so a finished one means
 * Chrome skipped that step.
 */
export const downloadAction = (
  owner: TracedOwner,
  state: chrome.downloads.DownloadItem["state"],
): DownloadAction => {
  switch (owner) {
    case "ambiguous":
    case "user":
      return "allow";
    case "contained":
    case "unexplained":
    case "untraceable":
      return state === "complete" ? "keep-and-flag" : "cancel";
    default:
      owner satisfies never;
      return panic("Unhandled download owner");
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

const runJudgement = async (
  download: chrome.downloads.DownloadItem,
  clock: TraceClock,
): Promise<void> => {
  const scope = scopeNow ?? (await readScope());
  if (scope.contained.length === 0) {
    return;
  }
  const owner = await traceDownload(download, scope, clock);
  const [current] = await chrome.downloads.search({ id: download.id });
  const action = downloadAction(owner, current?.state ?? download.state);
  if (action === "allow") {
    return;
  }
  if (action === "keep-and-flag") {
    await keepFinishedDownload(download.id);
    return;
  }
  stopped.add(download.id);
  await chrome.downloads.cancel(download.id).catch(() => undefined);
  const [after] = await chrome.downloads.search({ id: download.id });
  await (after?.state === "complete"
    ? keepFinishedDownload(download.id)
    : recordDownloadNotice("stopped"));
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

/**
 * Holds a download at its file name until its judgement, started here or
 * by an earlier event, is done. Chrome writes nothing before `suggest` is
 * called; returns true so Chrome waits for it.
 */
export const holdDownloadForJudgement = (
  download: chrome.downloads.DownloadItem,
  suggest: () => void,
  clock: TraceClock = systemTraceClock,
): boolean => {
  judgeDownload(download, clock)
    .catch(() => undefined)
    .then(() => {
      suggest();
      return undefined;
    })
    .catch(() => undefined);
  return true;
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
