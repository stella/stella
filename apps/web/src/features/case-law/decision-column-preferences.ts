import { useState } from "react";

import { Result } from "better-result";
import * as v from "valibot";

import { DEFAULT_HIDDEN_DECISION_COLUMN_IDS } from "@/features/case-law/decision-columns.logic";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { ClientOperationError } from "@/lib/errors/client";
import { readStoredJson } from "@/lib/stored-json";

const STORAGE_KEY = "case_law_hidden_columns";

/**
 * Hidden columns per jurisdiction, because what a row needs to say differs by
 * corpus: one publisher files headnotes and another does not, and a reader who
 * hid a column in Czech case law did not say anything about Polish.
 *
 * Local to the browser: the results page is public, so there is no account to
 * hang a column choice on, and a signed-in reader's choice stays theirs. The
 * storage arrives as an argument rather than as a global — a public SSR module
 * may not reach for one, and an injected `Storage` is also what lets a test
 * drive this with a fake.
 */
const PreferencesSchema = v.record(v.string(), v.array(v.string()));

type Preferences = v.InferOutput<typeof PreferencesSchema>;

const DEFAULT_HIDDEN: readonly string[] = DEFAULT_HIDDEN_DECISION_COLUMN_IDS;

const EMPTY: Preferences = {};

/**
 * What storage holds, or the failure that kept it from being read. Reading can
 * throw even on a storage that exists (a locked-down profile revokes it), so
 * the access is a `Result` and the reader falls back to the defaults.
 */
export const readDecisionColumnPreferences = (
  storage: Storage,
): Result<Preferences, ClientOperationError> =>
  Result.try({
    try: () => storage.getItem(STORAGE_KEY),
    catch: (cause) =>
      new ClientOperationError({
        action: "read-case-law-column-preferences",
        cause,
        message: "Case-law column preferences could not be read",
      }),
  }).map((raw) => readStoredJson(raw, PreferencesSchema) ?? EMPTY);

/**
 * Persistence is best effort: a reader whose storage is full or blocked still
 * gets the choice for this visit, from the state the hook keeps.
 */
export const writeDecisionColumnPreferences = (
  storage: Storage,
  preferences: Preferences,
): Result<void, ClientOperationError> =>
  Result.try({
    try: () => {
      storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    },
    catch: (cause) =>
      new ClientOperationError({
        action: "write-case-law-column-preferences",
        cause,
        message: "Case-law column preferences could not be saved",
      }),
  });

/** The columns this browser hides in a jurisdiction, and how to change them. */
export const useDecisionColumnPreferences = (country: string) => {
  const storage = useLocalStorage();
  // Null until storage has been read, which is after hydration: the server and
  // the first client render both see the defaults, so the markup agrees.
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [readFrom, setReadFrom] = useState<Storage | null>(null);
  if (storage !== null && readFrom !== storage) {
    setReadFrom(storage);
    setPreferences(readDecisionColumnPreferences(storage).unwrapOr(EMPTY));
  }

  return {
    hiddenColumnIds: preferences?.[country] ?? DEFAULT_HIDDEN,
    setHiddenColumnIds: (hiddenColumnIds: readonly string[]) => {
      const next = { ...preferences, [country]: [...hiddenColumnIds] };
      setPreferences(next);
      if (storage !== null) {
        writeDecisionColumnPreferences(storage, next);
      }
    },
  };
};
