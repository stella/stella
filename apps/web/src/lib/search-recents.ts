import * as v from "valibot";

import { isSafeIdValue } from "@stll/api-contract";
import { RECENT_FILES_STORAGE_KEY } from "@stll/api-contract/browser-storage";
import type { RecentFile as StoredRecentFile } from "@stll/api-contract/browser-storage";
import { Temporal } from "@stll/time";
import type { DocumentIdentity } from "@stll/ui/document-identity-badge.logic";
import { COURT_TIER_WEIGHT } from "@stll/ui/document-identity-badge.logic";

import { getStorageKey } from "@/consts";
import {
  isCurrentStorageOwner,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";
import {
  definePersistedState,
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

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

export type RecentFileWithIdentity = StoredRecentFile & {
  documentIdentity?: DocumentIdentity | undefined;
};

type RecentFileInput = Omit<RecentFileWithIdentity, "openedAt">;

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

const isRecentFile = (value: unknown): value is RecentFileWithIdentity =>
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

// Top-level shape only: each item is validated individually below.
const JsonArraySchema = v.array(v.unknown());

const recentListEntry = definePersistedState({
  key: ({ key, organizationId, owner }: SearchRecentsScope & { key: string }) =>
    userStorageKey(`${key}:${organizationId}:`, owner),
  area: "local",
  version: 1,
  schema: JsonArraySchema,
  maxBytes: 262_144,
  defaultValue: () => [],
  scopeCheck: (value, scope) =>
    isSearchRecentsScopeCurrent(scope)
      ? { keep: true, value }
      : { keep: false },
  restoredUi: false,
});

const readList = <T>(
  key: string,
  isItem: (value: unknown) => value is T,
  scope: SearchRecentsScope,
): T[] => readPersistedState(recentListEntry, { ...scope, key }).filter(isItem);

const writeList = (
  key: string,
  items: readonly unknown[],
  scope: SearchRecentsScope,
): void => {
  writePersistedState(recentListEntry, { ...scope, key }, [...items]);
};

export const readRecentSearches = (
  scope: SearchRecentsScope,
): RecentSearch[] =>
  isSearchRecentsScopeCurrent(scope)
    ? readList(RECENT_SEARCHES_KEY, isRecentSearch, scope)
    : [];

export const recordRecentSearch = (
  query: string,
  scope: SearchRecentsScope,
): RecentSearch[] => {
  if (!isSearchRecentsScopeCurrent(scope)) {
    return [];
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return readRecentSearches(scope);
  }

  const next = [
    {
      query: trimmed,
      searchedAt: Temporal.Now.instant().toString({
        fractionalSecondDigits: 3,
      }),
    },
    ...readRecentSearches(scope).filter((item) => item.query !== trimmed),
  ].slice(0, MAX_RECENT_SEARCHES);

  writeList(RECENT_SEARCHES_KEY, next, scope);
  return next;
};

export const readRecentFiles = (
  scope: SearchRecentsScope,
): RecentFileWithIdentity[] =>
  isSearchRecentsScopeCurrent(scope)
    ? readList(RECENT_FILES_STORAGE_KEY, isRecentFile, scope)
    : [];

export const recordRecentFile = (
  file: RecentFileInput,
  scope: SearchRecentsScope,
): RecentFileWithIdentity[] => {
  if (!isSearchRecentsScopeCurrent(scope)) {
    return [];
  }
  const title = file.title.trim();
  if (
    !isSafeIdValue(file.entityId) ||
    !isSafeIdValue(file.workspaceId) ||
    !title
  ) {
    return readRecentFiles(scope);
  }

  const next = [
    {
      ...file,
      title,
      openedAt: Temporal.Now.instant().toString({ fractionalSecondDigits: 3 }),
    },
    ...readRecentFiles(scope).filter((item) => item.entityId !== file.entityId),
  ].slice(0, MAX_RECENT_FILES);

  writeList(RECENT_FILES_STORAGE_KEY, next, scope);
  return next;
};
