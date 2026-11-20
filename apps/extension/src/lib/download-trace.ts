import { panic } from "better-result";

import { BROWSER_RECENT_NAVIGATIONS_STORAGE_KEY } from "./storage-keys";
import type { TabOwners } from "./tab-containment";

/**
 * The one place a download is traced to whoever started it. Chrome does not
 * say which tab or frame started a download, so the evidence is gathered
 * here, in this order:
 *
 * 1. Navigations. A download that a page navigation turned into (a link, a
 *    form, a redirect, a frame or a new tab loading a file) starts with that
 *    navigation's URL. Every navigation is recorded for a short while, with
 *    its tab, so the download is traced to the tab that navigated, whatever
 *    the server answered and whatever referrer the page sent.
 * 2. Open frames. A download no navigation explains (a page script saving
 *    a `blob:` URL or a link to its own site, "Save link as") is traced by
 *    origin (its URL, a `blob:` URL's creator, its final URL, its referrer)
 *    to the frames open right now.
 *
 * The verdict, `TracedOwner`, can only be made here, so nothing classifies
 * a download another way.
 */

type DownloadSource = Pick<
  chrome.downloads.DownloadItem,
  "byExtensionId" | "finalUrl" | "referrer" | "url"
>;

/**
 * - `contained`: only confined tabs navigated to it or have its origin open;
 * - `user`: only the user's tabs did, or another extension started it;
 * - `ambiguous`: tabs on both sides did, so either may have started it;
 * - `untraceable`: it has no web origin at all (a `data:` URL saved without
 *   a referrer, an opaque origin), so nothing can say who started it;
 * - `unexplained`: it comes from the web, but no recent navigation and no
 *   open frame accounts for it, or Chrome could not list a tab's frames.
 */
export type DownloadOwner =
  "ambiguous" | "contained" | "unexplained" | "untraceable" | "user";

declare const tracedBrand: unique symbol;

/** A download owner this module traced; the only kind the guard acts on. */
export type TracedOwner = DownloadOwner & {
  readonly [tracedBrand]: "TracedOwner";
};

const traced = (owner: DownloadOwner): owner is TracedOwner => owner.length > 0;

const mint = (owner: DownloadOwner): TracedOwner => {
  if (!traced(owner)) {
    return panic("A download owner is never empty");
  }
  return owner;
};

/** A page navigation, recorded so a download it becomes can be traced. */
export type RecordedNavigation = {
  /** When Chrome reported it, in milliseconds since the epoch. */
  at: number;
  tabId: number;
  /** The URL without its fragment, which no request carries. */
  url: string;
};

/**
 * How long a navigation can explain a download: the response that turns it
 * into one may be slow to arrive, but an old record would only tie a later
 * download to a tab that no longer started it.
 */
export const NAVIGATION_WINDOW_MS = 5 * 60_000;

/** Older records are dropped first once there are this many. */
export const NAVIGATION_LIMIT = 256;

/** A web URL without its fragment; null for any other scheme. */
const webUrl = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

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

const isRecordedNavigation = (input: unknown): input is RecordedNavigation =>
  typeof input === "object" &&
  input !== null &&
  "at" in input &&
  typeof input.at === "number" &&
  "tabId" in input &&
  typeof input.tabId === "number" &&
  "url" in input &&
  typeof input.url === "string";

/** The navigations still inside the window at `now`, newest last. */
const recentNavigations = (
  navigations: readonly RecordedNavigation[],
  now: number,
): RecordedNavigation[] =>
  navigations
    .filter(({ at }) => at <= now && now - at <= NAVIGATION_WINDOW_MS)
    .slice(-NAVIGATION_LIMIT);

const readStoredNavigations = async (): Promise<RecordedNavigation[]> => {
  const stored: unknown = (
    await chrome.storage.session.get(BROWSER_RECENT_NAVIGATIONS_STORAGE_KEY)
  )[BROWSER_RECENT_NAVIGATIONS_STORAGE_KEY];
  return Array.isArray(stored) ? stored.filter(isRecordedNavigation) : [];
};

// Recording reads, changes and writes one stored list; the worker applies
// each change in turn so none overwrites another. The list lives in session
// storage, not only here: the worker may stop between a navigation and the
// download it becomes.
let navigationTail: Promise<unknown> = Promise.resolve();

/** Records a navigation Chrome is about to make, in any frame of any tab. */
export const recordNavigation = async ({
  tabId,
  timeStamp,
  url,
}: Pick<
  chrome.webNavigation.WebNavigationBaseCallbackDetails,
  "tabId" | "timeStamp" | "url"
>): Promise<void> => {
  const navigationUrl = webUrl(url);
  if (navigationUrl === null || tabId < 0) {
    return;
  }
  const write = async (): Promise<void> => {
    const navigations = recentNavigations(
      [
        ...(await readStoredNavigations()),
        { at: timeStamp, tabId, url: navigationUrl },
      ],
      timeStamp,
    );
    await chrome.storage.session.set({
      [BROWSER_RECENT_NAVIGATIONS_STORAGE_KEY]: navigations,
    });
  };
  const next = navigationTail.then(write, write);
  navigationTail = next.catch(() => undefined);
  await next;
};

/** Navigations recorded so far, once every pending record is stored. */
const readNavigations = async (): Promise<RecordedNavigation[]> => {
  await navigationTail;
  return await readStoredNavigations();
};

type FrameOrigins = {
  contained: ReadonlySet<string>;
  user: ReadonlySet<string>;
};

/** What a download is traced against, read at one moment. */
export type DownloadEvidence = {
  /** Origins of the frames open on each side; null when a lookup failed. */
  frames: FrameOrigins | null;
  navigations: readonly RecordedNavigation[];
  now: number;
  /** The user's tabs; every other tab is confined. */
  userTabIds: readonly number[];
};

/** A download another extension started through the downloads API. */
const isOtherExtensionDownload = (download: DownloadSource): boolean =>
  download.byExtensionId !== undefined &&
  download.byExtensionId !== chrome.runtime.id;

const downloadOrigins = (download: DownloadSource): string[] =>
  [download.url, download.finalUrl, download.referrer]
    .map(webOrigin)
    .filter((origin) => origin !== null);

const sides = (
  contained: boolean,
  user: boolean,
): "ambiguous" | "contained" | "user" | null => {
  if (contained) {
    return user ? "ambiguous" : "contained";
  }
  return user ? "user" : null;
};

/** Traces a download from evidence already gathered; pure. */
export const resolveDownloadOwner = (
  download: DownloadSource,
  { frames, navigations, now, userTabIds }: DownloadEvidence,
): TracedOwner => {
  if (isOtherExtensionDownload(download)) {
    return mint("user");
  }
  const urls = new Set(
    [download.url, download.finalUrl].map(webUrl).filter((url) => url !== null),
  );
  const navigatedTabs = recentNavigations(navigations, now)
    .filter(({ url }) => urls.has(url))
    .map(({ tabId }) => tabId);
  const byNavigation = sides(
    navigatedTabs.some((tabId) => !userTabIds.includes(tabId)),
    navigatedTabs.some((tabId) => userTabIds.includes(tabId)),
  );
  if (byNavigation !== null) {
    return mint(byNavigation);
  }
  const origins = downloadOrigins(download);
  if (origins.length === 0) {
    return mint("untraceable");
  }
  if (frames === null) {
    return mint("unexplained");
  }
  const byFrames = sides(
    origins.some((origin) => frames.contained.has(origin)),
    origins.some((origin) => frames.user.has(origin)),
  );
  return mint(byFrames ?? "unexplained");
};

/**
 * A tab's frames. Chrome answers null for a tab id that is no longer valid,
 * so a tab closed between being listed and being asked (any tab the user
 * closes while a download starts) has no frames left to trace to. Null when
 * Chrome could not list the frames of a tab that is still open, since a
 * missing answer is not an empty one.
 */
const framesOfTab = async (
  tabId: number,
): Promise<chrome.webNavigation.GetAllFrameResultDetails[] | null> => {
  const frames = await chrome.webNavigation
    .getAllFrames({ tabId })
    .catch(() => null);
  if (frames !== null) {
    return frames;
  }
  const open = await chrome.tabs.get(tabId).then(
    () => true,
    () => false,
  );
  return open ? null : [];
};

/**
 * Origins of every frame in the given tabs; null when Chrome could not list
 * an open tab's frames.
 */
const frameOrigins = async (
  tabIds: readonly number[],
): Promise<Set<string> | null> => {
  const frames = await Promise.all(tabIds.map(framesOfTab));
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
 * confined by the network rules, and counts as confined here too.
 */
const readFrameOrigins = async (
  userTabIds: readonly number[],
): Promise<FrameOrigins | null> => {
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

/** Where tracing reads the time, in epoch milliseconds. */
export type TraceClock = { now: () => number };

/**
 * The worker's clock, on the same scale as Chrome's navigation time stamps.
 * The extension supports browsers without `Temporal`.
 */
export const systemTraceClock: TraceClock = {
  now: () => performance.timeOrigin + performance.now(),
};

/** Traces a download under the given tab owners. */
export const traceDownload = async (
  download: DownloadSource,
  owners: TabOwners,
  clock: TraceClock = systemTraceClock,
): Promise<TracedOwner> => {
  const [navigations, frames] = await Promise.all([
    readNavigations(),
    downloadOrigins(download).length === 0
      ? null
      : readFrameOrigins(owners.user),
  ]);
  return resolveDownloadOwner(download, {
    frames,
    navigations,
    now: clock.now(),
    userTabIds: owners.user,
  });
};
