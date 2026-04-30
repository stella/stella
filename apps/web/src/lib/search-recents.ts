import { getStorageKey } from "@/consts";

const RECENT_SEARCHES_KEY = getStorageKey("search-recent-searches");
const RECENT_FILES_KEY = getStorageKey("search-recent-files");
const MAX_RECENT_SEARCHES = 6;
const MAX_RECENT_FILES = 6;

export type SearchRecentsScope = {
  organizationId: string;
  userId: string;
};

export type RecentSearch = {
  query: string;
  searchedAt: string;
};

export type RecentFile = {
  entityId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  mimeType?: string | null | undefined;
  openedAt: string;
};

type RecentFileInput = Omit<RecentFile, "openedAt">;

const getStorage = (): Storage | null =>
  typeof window === "undefined" ? null : window.localStorage;

const scopedKey = (key: string, scope: SearchRecentsScope): string =>
  `${key}:${scope.organizationId}:${scope.userId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRecentSearch = (value: unknown): value is RecentSearch =>
  isRecord(value) &&
  typeof value["query"] === "string" &&
  typeof value["searchedAt"] === "string";

const isRecentFile = (value: unknown): value is RecentFile =>
  isRecord(value) &&
  typeof value["entityId"] === "string" &&
  typeof value["workspaceId"] === "string" &&
  typeof value["workspaceName"] === "string" &&
  typeof value["title"] === "string" &&
  (value["mimeType"] === undefined ||
    value["mimeType"] === null ||
    typeof value["mimeType"] === "string") &&
  typeof value["openedAt"] === "string";

const readList = <T>(
  key: string,
  isItem: (value: unknown) => value is T,
  storage: Storage | null = getStorage(),
): T[] => {
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isItem) : [];
  } catch {
    return [];
  }
};

const writeList = <T>(
  key: string,
  items: readonly T[],
  storage: Storage | null = getStorage(),
): void => {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(key, JSON.stringify(items));
  } catch {
    // localStorage can be unavailable or full; recents are best-effort UI state.
  }
};

export const readRecentSearches = (
  scope: SearchRecentsScope,
  storage: Storage | null = getStorage(),
): RecentSearch[] =>
  readList(scopedKey(RECENT_SEARCHES_KEY, scope), isRecentSearch, storage);

export const recordRecentSearch = (
  query: string,
  scope: SearchRecentsScope,
  storage: Storage | null = getStorage(),
): RecentSearch[] => {
  const trimmed = query.trim();
  if (!trimmed) {
    return readRecentSearches(scope, storage);
  }

  const next = [
    { query: trimmed, searchedAt: new Date().toISOString() },
    ...readRecentSearches(scope, storage).filter(
      (item) => item.query !== trimmed,
    ),
  ].slice(0, MAX_RECENT_SEARCHES);

  writeList(scopedKey(RECENT_SEARCHES_KEY, scope), next, storage);
  return next;
};

export const readRecentFiles = (
  scope: SearchRecentsScope,
  storage: Storage | null = getStorage(),
): RecentFile[] =>
  readList(scopedKey(RECENT_FILES_KEY, scope), isRecentFile, storage);

export const recordRecentFile = (
  file: RecentFileInput,
  scope: SearchRecentsScope,
  storage: Storage | null = getStorage(),
): RecentFile[] => {
  const title = file.title.trim();
  if (!title) {
    return readRecentFiles(scope, storage);
  }

  const next = [
    { ...file, title, openedAt: new Date().toISOString() },
    ...readRecentFiles(scope, storage).filter(
      (item) => item.entityId !== file.entityId,
    ),
  ].slice(0, MAX_RECENT_FILES);

  writeList(scopedKey(RECENT_FILES_KEY, scope), next, storage);
  return next;
};
