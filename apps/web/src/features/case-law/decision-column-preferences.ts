import { useState } from "react";

import { Result } from "better-result";

import {
  StoredDecisionLayoutSchema,
  decisionTableLayouts,
  layoutForCountry,
} from "@/features/case-law/decision-column-preferences.logic";
import type {
  DecisionTableLayout,
  StoredDecisionLayouts,
} from "@/features/case-law/decision-column-preferences.logic";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useAnalytics } from "@/lib/analytics/provider";
import { ClientOperationError } from "@/lib/errors/client";
import { readStoredJson } from "@/lib/stored-json";

const STORAGE_KEY = "case_law_hidden_columns";

/**
 * How the table is drawn, per jurisdiction, because what a row needs to say
 * differs by corpus: one publisher files headnotes and another does not, and a
 * reader who hid a column in Czech case law did not say anything about Polish.
 *
 * Local to the browser: the results page is public, so there is no account to
 * hang the arrangement on, and a signed-in reader's choice stays theirs. The
 * storage arrives as an argument rather than as a global — a public SSR module
 * may not reach for one, and an injected `Storage` is also what lets a test
 * drive this with a fake.
 */
const EMPTY: StoredDecisionLayouts = {};
const NO_LAYOUTS: Record<string, DecisionTableLayout> = {};

/**
 * What storage holds, or the failure that kept it from being read. Reading can
 * throw even on a storage that exists (a locked-down profile revokes it), so
 * the access is a `Result` and the reader falls back to the defaults.
 */
const readDecisionLayouts = (
  storage: Storage,
): Result<Record<string, DecisionTableLayout>, ClientOperationError> =>
  Result.try({
    try: () => storage.getItem(STORAGE_KEY),
    catch: (cause) =>
      new ClientOperationError({
        action: "read-case-law-column-preferences",
        cause,
        message: "Case-law column preferences could not be read",
      }),
  }).map((raw) =>
    decisionTableLayouts(
      readStoredJson(raw, StoredDecisionLayoutSchema) ?? EMPTY,
    ),
  );

/**
 * Persistence is best effort: a reader whose storage is full or blocked still
 * gets the choice for this visit, from the state the hook keeps.
 */
const writeDecisionLayouts = (
  storage: Storage,
  layouts: Record<string, DecisionTableLayout>,
): Result<void, ClientOperationError> =>
  Result.try({
    try: () => {
      storage.setItem(STORAGE_KEY, JSON.stringify(layouts));
    },
    catch: (cause) =>
      new ClientOperationError({
        action: "write-case-law-column-preferences",
        cause,
        message: "Case-law column preferences could not be saved",
      }),
  });

/** How this browser draws the table in a jurisdiction, and how to change it. */
export const useDecisionColumnPreferences = (country: string) => {
  const analytics = useAnalytics();
  const storage = useLocalStorage();
  // Null until storage has been read, which is after hydration: the server and
  // the first client render both see the defaults, so the markup agrees.
  const [layouts, setLayouts] = useState<Record<
    string,
    DecisionTableLayout
  > | null>(null);
  const [readFrom, setReadFrom] = useState<Storage | null>(null);
  if (storage !== null && readFrom !== storage) {
    setReadFrom(storage);
    setLayouts(readDecisionLayouts(storage).unwrapOr(NO_LAYOUTS));
  }

  // The same object until the reader changes it: the table compares its
  // controlled state by identity, and a layout rebuilt per render loops it.
  const layout = layoutForCountry(layouts, country);

  return {
    layout,
    setLayout: (next: DecisionTableLayout) => {
      const stored = { ...layouts, [country]: next };
      setLayouts(stored);
      if (storage === null) {
        return;
      }
      // Best effort for the reader, never silent for us: the choice is already
      // in state, so a storage that refuses the write costs the next visit and
      // nothing else — but the refusal is reported rather than dropped.
      const written = writeDecisionLayouts(storage, stored);
      if (Result.isError(written)) {
        analytics.captureError(written.error);
      }
    },
  };
};
