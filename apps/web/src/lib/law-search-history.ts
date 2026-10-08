import { useSyncExternalStore } from "react";

import { createStore } from "zustand/vanilla";

import { Temporal } from "@stll/time";

import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  onStorageOwnerChange,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import {
  EMPTY_LAW_RECENT as EMPTY,
  LAW_SEARCH_HISTORY_KEY as STORAGE_KEY,
  lawRecentKey,
  normalizeRecent,
  readLawRecent,
  type LawRecentEntry,
} from "@/lib/law-search-history.logic";
import { writeStoredJson } from "@/lib/stored-json";

export {
  filterLawRecent,
  lawRecentKey,
  readLawRecent,
  type LawRecentEntry,
  type LawRecentFilter,
} from "@/lib/law-search-history.logic";

type RecentState = { entries: readonly LawRecentEntry[]; hydrated: boolean };
const recentStore = createStore<RecentState>(() => ({
  entries: EMPTY,
  hydrated: false,
}));

const hydrate = (): void => {
  if (recentStore.getState().hydrated) {
    return;
  }
  const raw = browserStateStorage("local").getItem(userStorageKey(STORAGE_KEY));
  recentStore.setState({ entries: readLawRecent(raw), hydrated: true });
};
const save = (entries: readonly LawRecentEntry[]): void => {
  writeStoredJson(
    browserStateStorage("local"),
    userStorageKey(STORAGE_KEY),
    entries,
  );
  recentStore.setState({ entries });
};
const record = (entry: LawRecentEntry): void => {
  hydrate();
  save(
    normalizeRecent([
      entry,
      ...recentStore
        .getState()
        .entries.filter(
          (previous) => lawRecentKey(previous) !== lawRecentKey(entry),
        ),
    ]),
  );
};
const now = () =>
  Temporal.Now.instant().toString({ fractionalSecondDigits: 3 });

export const recordLawSearch = (query: string): void => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return;
  }
  record({ kind: "search", query: trimmed, at: now() });
};
type OpenedLawEntry = Omit<
  Extract<LawRecentEntry, { kind: "decision" | "statute" }>,
  "at"
>;
export const recordLawOpen = (entry: OpenedLawEntry): void =>
  record({ ...entry, at: now() });

export const removeLawRecent = (entry: LawRecentEntry): void => {
  hydrate();
  save(
    recentStore
      .getState()
      .entries.filter(
        (previous) => lawRecentKey(previous) !== lawRecentKey(entry),
      ),
  );
};
export const clearLawRecent = (): void => {
  hydrate();
  save(EMPTY);
};

onStorageOwnerChange(() => {
  if (!recentStore.getState().hydrated) {
    return;
  }
  recentStore.setState({ entries: EMPTY, hydrated: false });
  hydrate();
});
const subscribe = (onChange: () => void) => {
  const unsubscribe = recentStore.subscribe(onChange);
  hydrate();
  return unsubscribe;
};
const getSnapshot = () => recentStore.getState().entries;
const getServerSnapshot = () => EMPTY;

/** Browser-local activity, reset on owner change; never shared or sent to analytics. */
export const useLawRecent = (): readonly LawRecentEntry[] =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
