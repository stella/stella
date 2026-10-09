import { Result } from "better-result";
import * as v from "valibot";

import { isSafeIdValue } from "@stll/api-contract";
import { RECENT_FILES_STORAGE_KEY } from "@stll/api-contract/browser-storage";
import type { RecentFile as StoredRecentFile } from "@stll/api-contract/browser-storage";
import { Temporal } from "@stll/time";
import type { DocumentIdentity } from "@stll/ui/document-identity-badge.logic";
import { COURT_TIER_WEIGHT } from "@stll/ui/document-identity-badge.logic";

import { getStorageKey } from "@/consts";
import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  isCurrentStorageOwner,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

const RECENT_SEARCHES_KEY = getStorageKey("search-recent-searches");
const MAX_RECENT_SEARCHES = 6;
const MAX_RECENT_FILES = 6;

export type SearchRecentsScope = {
  owner: StorageOwner;
  organizationId: string;
  userId: string;
};

export type RecentSearch = {
  query: string;
  searchedAt: string;
};

export type RecentFile = StoredRecentFile & {
  documentIdentity?: DocumentIdentity | undefined;
};

type RecentFileInput = Omit<RecentFile, "openedAt">;

const getStorage = (): Storage | null => browserStateStorage("local");

const scopedKey = (key: string, scope: SearchRecentsScope): string =>
  userStorageKey(`${key}:${scope.organizationId}:`, scope.owner);

export const isSearchRecentsScopeCurrent = (
  scope: SearchRecentsScope,
): boolean =>
  scope.owner.kind === "user" &&
  scope.owner.userId === scope.userId &&
  isCurrentStorageOwner(scope.owner);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isResourceId = (value: unknown): value is string =>
  typeof value === "string" && isSafeIdValue(value);

const isRecentSearch = (value: unknown): value is RecentSearch =>
  isRecord(value) &&
  typeof value["query"] === "string" &&
  typeof value["searchedAt"] === "string";

const isRecentDocumentIdentity = (
  value: unknown,
): value is DocumentIdentity => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["kind"]) {
    case "unknown":
      return true;
    case "statute":
      return (
        (value["number"] === null || typeof value["number"] === "string") &&
        (value["year"] === null || typeof value["year"] === "string")
      );
    case "decision":
      return (
        (value["courtAbbreviation"] === undefined ||
          value["courtAbbreviation"] === null ||
          typeof value["courtAbbreviation"] === "string") &&
        (value["courtTier"] === undefined ||
          (typeof value["courtTier"] === "string" &&
            Object.hasOwn(COURT_TIER_WEIGHT, value["courtTier"])))
      );
    default:
      return false;
  }
};

const isRecentFile = (value: unknown): value is RecentFile =>
  isRecord(value) &&
  isResourceId(value["entityId"]) &&
  (value["documentIdentity"] === undefined ||
    isRecentDocumentIdentity(value["documentIdentity"])) &&
  (value["fileFieldId"] === undefined ||
    value["fileFieldId"] === null ||
    typeof value["fileFieldId"] === "string") &&
  (value["filePropertyId"] === undefined ||
    value["filePropertyId"] === null ||
    typeof value["filePropertyId"] === "string") &&
  isResourceId(value["workspaceId"]) &&
  typeof value["workspaceName"] === "string" &&
  typeof value["title"] === "string" &&
  (value["mimeType"] === undefined ||
    value["mimeType"] === null ||
    typeof value["mimeType"] === "string") &&
  typeof value["openedAt"] === "string" &&
  (value["updatedAt"] === undefined || typeof value["updatedAt"] === "string");

// Top-level shape only: each item is validated individually below via
// `isItem`, so one malformed entry drops just that entry rather than the
// whole list.
const JsonArraySchema = v.array(v.unknown());

const readList = <T>(
  key: string,
  isItem: (value: unknown) => value is T,
  storage: Storage | null = getStorage(),
): T[] => {
  if (!storage) {
    return [];
  }

  const raw = Result.try(() => storage.getItem(key)).unwrapOr(null);
  const parsed = readStoredJson(raw, JsonArraySchema);
  return parsed ? parsed.filter(isItem) : [];
};

const writeList = (
  key: string,
  items: readonly unknown[],
  storage: Storage | null = getStorage(),
): void => {
  if (!storage) {
    return;
  }

  writeStoredJson(storage, key, items);
};

export const readRecentSearches = (
  scope: SearchRecentsScope,
  storage: Storage | null = getStorage(),
): RecentSearch[] =>
  isSearchRecentsScopeCurrent(scope)
    ? readList(scopedKey(RECENT_SEARCHES_KEY, scope), isRecentSearch, storage)
    : [];

export const recordRecentSearch = (
  query: string,
  scope: SearchRecentsScope,
  storage: Storage | null = getStorage(),
): RecentSearch[] => {
  if (!isSearchRecentsScopeCurrent(scope)) {
    return [];
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return readRecentSearches(scope, storage);
  }

  const next = [
    {
      query: trimmed,
      searchedAt: Temporal.Now.instant().toString({
        fractionalSecondDigits: 3,
      }),
    },
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
  isSearchRecentsScopeCurrent(scope)
    ? readList(
        scopedKey(RECENT_FILES_STORAGE_KEY, scope),
        isRecentFile,
        storage,
      )
    : [];

export const recordRecentFile = (
  file: RecentFileInput,
  scope: SearchRecentsScope,
  storage: Storage | null = getStorage(),
): RecentFile[] => {
  if (!isSearchRecentsScopeCurrent(scope)) {
    return [];
  }
  const title = file.title.trim();
  if (
    !isSafeIdValue(file.entityId) ||
    !isSafeIdValue(file.workspaceId) ||
    !title
  ) {
    return readRecentFiles(scope, storage);
  }

  const next = [
    {
      ...file,
      title,
      openedAt: Temporal.Now.instant().toString({ fractionalSecondDigits: 3 }),
    },
    ...readRecentFiles(scope, storage).filter(
      (item) => item.entityId !== file.entityId,
    ),
  ].slice(0, MAX_RECENT_FILES);

  writeList(scopedKey(RECENT_FILES_STORAGE_KEY, scope), next, storage);
  return next;
};
