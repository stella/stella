import { panic } from "better-result";

import { BROWSER_DOWNLOAD_NOTICES_STORAGE_KEY } from "./storage-keys";
import {
  containedTabIds,
  readContainedTabs,
  type TabOwners,
} from "./tab-containment";

type DownloadSource = Pick<
  chrome.downloads.DownloadItem,
  "byExtensionId" | "finalUrl" | "referrer" | "url"
>;

/** The web origin a URL belongs to; `blob:` URLs carry their creator's. */
const webOrigin = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    const inner = url.protocol === "blob:" ? new URL(url.pathname) : url;
    return inner.protocol === "https:" || inner.protocol === "http:"
      ? inner.origin
      : null;
  } catch {
    return null;
  }
};

/**
 * Whose download this is. Chrome does not say which tab or frame started a
 * download, so it is traced by origin (its URL, a `blob:` URL's creator,
 * its final URL, its referrer) to the frames open right now:
 * - `contained`: only frames in confined tabs have that origin;
 * - `user`: only frames in the user's own tabs do;
 * - `ambiguous`: frames on both sides do, so either may have started it;
 * - `unknown`: no open frame does (a `data:` download without a referrer,
 *   an opaque origin, a frame already gone).
 * Other extensions' downloads are theirs.
 */
type DownloadOwner = "ambiguous" | "contained" | "unknown" | "user";

type DownloadOrigins = {
  contained: ReadonlySet<string>;
  user: ReadonlySet<string>;
};

const downloadOrigins = (download: DownloadSource): string[] =>
  [download.url, download.finalUrl, download.referrer]
    .map(webOrigin)
    .filter((origin) => origin !== null);

export const downloadOwner = (
  download: DownloadSource,
  origins: DownloadOrigins,
): DownloadOwner => {
  if (download.byExtensionId !== undefined) {
    return "user";
  }
  const sources = downloadOrigins(download);
  const contained = sources.some((origin) => origins.contained.has(origin));
  const user = sources.some((origin) => origins.user.has(origin));
  if (contained) {
    return user ? "ambiguous" : "contained";
  }
  return user ? "user" : "unknown";
};

type DownloadAction = "allow" | "cancel" | "keep-and-flag";

/**
 * What to do with a download while stella controls a tab. Any download not
 * traced to the user alone is stopped while it runs. A file is never
 * deleted: tracing by origin samples the frames open at one moment and
 * cannot prove who started a download, so a finished one stays on disk and
 * the user is told about it. Chrome holds each download until it is judged,
 * so a finished one means Chrome skipped that step.
 */
export const downloadAction = (
  owner: DownloadOwner,
  state: chrome.downloads.DownloadItem["state"],
): DownloadAction => {
  switch (owner) {
    case "user":
      return "allow";
    case "ambiguous":
    case "contained":
    case "unknown":
      return state === "complete" ? "keep-and-flag" : "cancel";
    default:
      owner satisfies never;
      return panic("Unhandled download owner");
  }
};

/**
 * Origins of every frame in the given tabs; null when Chrome could not list
 * a tab's frames, since a missing answer is not an empty one.
 */
const frameOrigins = async (
  tabIds: readonly number[],
): Promise<Set<string> | null> => {
  const frames = await Promise.all(
    tabIds.map(
      async (tabId) =>
        await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null),
    ),
  );
  if (frames.some((tabFrames) => tabFrames === null)) {
    return null;
  }
  return new Set(
    frames
      .flatMap((tabFrames) => tabFrames ?? [])
      .map(({ url }) => webOrigin(url))
      .filter((origin) => origin !== null),
  );
};

/**
 * The user's side is the tabs known to be theirs; every other tab is
 * confined by the network rules, and counts as confined here too. Null when
 * a lookup failed.
 */
const readDownloadOrigins = async (
  userTabIds: readonly number[],
): Promise<DownloadOrigins | null> => {
  const confinedTabIds = (await chrome.tabs.query({}))
    .map(({ id }) => id)
    .filter((tabId) => tabId !== undefined)
    .filter((tabId) => !userTabIds.includes(tabId));
  const [contained, user] = await Promise.all([
    frameOrigins(confinedTabIds),
    frameOrigins(userTabIds),
  ]);
  return contained === null || user === null ? null : { contained, user };
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

// The owners of tabs, kept in memory so a download can be stopped in the
// same task Chrome reports it; null until first read after the worker starts.
let scopeNow: DownloadScope | null = null;

const readScope = async (): Promise<DownloadScope> => {
  const containment = await readContainedTabs();
  return {
    contained: containedTabIds(containment),
    user: containment.userTabIds,
  };
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
): Promise<void> => {
  // A download with no web origin can be traced to nobody. It is stopped in
  // this same task, before the frame lookups below give it time to finish.
  if (
    scopeNow !== null &&
    scopeNow.contained.length > 0 &&
    downloadOrigins(download).length === 0
  ) {
    stopped.add(download.id);
    const cancelled = chrome.downloads.cancel(download.id);
    await cancelled.catch(() => undefined);
    // It may have finished before the cancel landed; then it was kept.
    const [after] = await chrome.downloads.search({ id: download.id });
    await (after?.state === "complete"
      ? keepFinishedDownload(download.id)
      : recordDownloadNotice("stopped"));
    return;
  }
  const scope = scopeNow ?? (await readScope());
  if (scope.contained.length === 0) {
    return;
  }
  const origins =
    downloadOrigins(download).length === 0
      ? null
      : await readDownloadOrigins(scope.user);
  const owner = origins === null ? "unknown" : downloadOwner(download, origins);
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
 * Judges a download while stella controls a tab. Network downloads and
 * non-page `blob:` or `data:` types never get this far (the tab's rules block
 * attachment and non-page responses); this catches a page script saving a
 * displayable type through `a[download]`. Every report of one download
 * shares one judgement: a later caller waits for a judgement still running.
 */
export const judgeDownload = async (
  download: chrome.downloads.DownloadItem,
): Promise<void> => {
  const existing = judgements.get(download.id);
  if (existing !== undefined) {
    await existing;
    return;
  }
  const judgement = runJudgement(download).catch(() => undefined);
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
): boolean => {
  judgeDownload(download)
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
