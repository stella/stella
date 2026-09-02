import { useSyncExternalStore } from "react";

import * as v from "valibot";
import { createStore } from "zustand/vanilla";

import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

const STORAGE_KEY = "law_search_history";

/** Rows the home shows: a sample the reader scans, not a list they work through. */
const HISTORY_LIMIT = 5;

const HistoryEntrySchema = v.object({
  query: v.string(),
  /** ISO 8601, when the entry was last run. */
  at: v.string(),
});

const HistorySchema = v.array(HistoryEntrySchema);

export type LawSearchHistoryEntry = v.InferOutput<typeof HistoryEntrySchema>;

const EMPTY: readonly LawSearchHistoryEntry[] = [];

type HistoryState = {
  entries: readonly LawSearchHistoryEntry[];
  /** Whether `entries` reflects storage yet; the server and the first client render do not. */
  hydrated: boolean;
};

/**
 * What this browser searched for lately, newest first. Local to the
 * browser: the home is public, so there is no account to hang it on, and a
 * signed-in reader's history stays theirs.
 */
const historyStore = createStore<HistoryState>(() => ({
  entries: EMPTY,
  hydrated: false,
}));

/**
 * Reads storage once, on the first subscription: that runs after mount, so
 * the client's first render still matches the server's empty snapshot.
 */
const hydrate = (): void => {
  if (historyStore.getState().hydrated) {
    return;
  }
  historyStore.setState({
    entries:
      readStoredJson(localStorage.getItem(STORAGE_KEY), HistorySchema) ?? EMPTY,
    hydrated: true,
  });
};

export const recordLawSearch = (query: string): void => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return;
  }
  hydrate();
  const next = [
    { query: trimmed, at: new Date().toISOString() },
    ...historyStore
      .getState()
      .entries.filter((entry) => entry.query !== trimmed),
  ].slice(0, HISTORY_LIMIT);
  writeStoredJson(localStorage, STORAGE_KEY, next);
  historyStore.setState({ entries: next });
};

const subscribe = (onChange: () => void) => {
  const unsubscribe = historyStore.subscribe(onChange);
  hydrate();
  return unsubscribe;
};

const getSnapshot = () => historyStore.getState().entries;

const getServerSnapshot = () => EMPTY;

/** The history as this browser holds it; empty on the server and until hydration. */
export const useLawSearchHistory = (): readonly LawSearchHistoryEntry[] =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
