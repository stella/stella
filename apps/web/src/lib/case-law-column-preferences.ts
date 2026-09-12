import { useSyncExternalStore } from "react";

import { Result } from "better-result";
import * as v from "valibot";
import { createStore } from "zustand/vanilla";

import { DEFAULT_HIDDEN_DECISION_COLUMN_IDS } from "@/features/case-law/decision-columns.logic";
import { ClientOperationError } from "@/lib/errors/client";
import { readStoredJson } from "@/lib/stored-json";

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
  preferencesStore.setState({
    byCountry: readPreferences().unwrapOr({}),
    hydrated: true,
  });
};

/**
 * What storage holds, or the failure that kept it from being read. Storage can
 * be blocked outright (private browsing, a locked-down profile) and reading it
 * throws rather than returning nothing, so the access is a `Result` and the
 * caller falls back to the defaults for the visit.
 */
const readPreferences = (): Result<Preferences, ClientOperationError> =>
  Result.try({
    try: () => localStorage.getItem(STORAGE_KEY),
    catch: (cause) =>
      new ClientOperationError({
        action: "read-case-law-column-preferences",
        cause,
        message: "Case-law column preferences could not be read",
      }),
  }).map((raw) => readStoredJson(raw, PreferencesSchema) ?? {});

/**
 * Persistence of a column choice is best effort: a reader whose storage is
 * blocked or full still gets the choice for this visit, from the store.
 */
const writePreferences = (
  preferences: Preferences,
): Result<void, ClientOperationError> =>
  Result.try({
    try: () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    },
    catch: (cause) =>
      new ClientOperationError({
        action: "write-case-law-column-preferences",
        cause,
        message: "Case-law column preferences could not be saved",
      }),
  });

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
  writePreferences(next);
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
