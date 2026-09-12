import { useSyncExternalStore } from "react";

import * as v from "valibot";
import { createStore } from "zustand/vanilla";

import { DEFAULT_HIDDEN_DECISION_COLUMN_IDS } from "@/features/case-law/decision-columns.logic";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

const STORAGE_KEY = "case_law_hidden_columns";

// A public SSR route may not touch browser globals directly; this module is
// the hydration-safe adapter that owns the key, and the results route reads
// it through the hook below.

/**
 * Hidden columns per jurisdiction, because what a row needs to say differs by
 * corpus: one publisher files headnotes and another does not, and a reader who
 * hid a column in Czech case law did not say anything about Polish.
 */
const PreferencesSchema = v.record(v.string(), v.array(v.string()));

type Preferences = v.InferOutput<typeof PreferencesSchema>;

const DEFAULT_HIDDEN: readonly string[] = DEFAULT_HIDDEN_DECISION_COLUMN_IDS;

type PreferencesState = {
  byCountry: Preferences;
  /** Whether `byCountry` reflects storage yet; the first client render does not. */
  hydrated: boolean;
};

const EMPTY: PreferencesState = { byCountry: {}, hydrated: false };

/**
 * Local to the browser: the results page is public, so there is no account to
 * hang a column choice on, and a signed-in reader's choice stays theirs.
 */
const preferencesStore = createStore<PreferencesState>(() => EMPTY);

/**
 * Reads storage once, on the first subscription: that runs after mount, so the
 * client's first render still matches the server's default snapshot.
 */
const hydrate = (): void => {
  if (preferencesStore.getState().hydrated) {
    return;
  }
  let stored: Preferences | null = null;
  try {
    stored = readStoredJson(
      localStorage.getItem(STORAGE_KEY),
      PreferencesSchema,
    );
  } catch {
    // Storage can be blocked outright (private browsing, a locked-down
    // profile); the reader then gets the defaults for this visit.
  }
  preferencesStore.setState({ byCountry: stored ?? {}, hydrated: true });
};

const subscribe = (onChange: () => void) => {
  const unsubscribe = preferencesStore.subscribe(onChange);
  hydrate();
  return unsubscribe;
};

const getSnapshot = () => preferencesStore.getState();

const getServerSnapshot = () => EMPTY;

export const setHiddenDecisionColumnIds = (
  country: string,
  hiddenColumnIds: readonly string[],
): void => {
  hydrate();
  const next = {
    ...preferencesStore.getState().byCountry,
    [country]: [...hiddenColumnIds],
  };
  writeStoredJson(localStorage, STORAGE_KEY, next);
  preferencesStore.setState({ byCountry: next, hydrated: true });
};

/**
 * Which columns this browser hides in a jurisdiction. The defaults until the
 * reader says otherwise, and until storage has been read.
 */
export const useHiddenDecisionColumnIds = (
  country: string,
): readonly string[] => {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return state.byCountry[country] ?? DEFAULT_HIDDEN;
};
