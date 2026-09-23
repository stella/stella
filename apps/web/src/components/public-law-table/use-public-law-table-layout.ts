import { useState } from "react";

import { Result } from "better-result";

import { layoutForSurface } from "@/components/public-law-table/public-law-table-layout.logic";
import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useAnalytics } from "@/lib/analytics/provider";
import { ClientOperationError } from "@/lib/errors/client";

/**
 * Where one public-law table keeps its arrangements and what they mean. A
 * module constant per table, so the hook reads one identity across renders.
 */
export type PublicLawTableLayoutStore<TLayout extends PublicLawTableLayout> = {
  /** The browser storage key; renaming it forgets every stored arrangement. */
  storageKey: string;
  /** Every stored arrangement, normalised once, from the raw stored value. */
  read: (raw: string | null) => Record<string, TLayout>;
  defaultLayout: TLayout;
};

/**
 * How this browser draws a public-law table on one surface, and how to change
 * it.
 *
 * Local to the browser: the public-law pages are public, so there is no account
 * to hang the arrangement on, and a signed-in reader's choice stays theirs. Per
 * surface (a jurisdiction), because what a row needs to say differs by corpus:
 * a reader who hid a column in Czech law did not say anything about Polish.
 */
export const usePublicLawTableLayout = <TLayout extends PublicLawTableLayout>(
  store: PublicLawTableLayoutStore<TLayout>,
  surface: string,
) => {
  const analytics = useAnalytics();
  const storage = useLocalStorage();
  // Null until storage has been read, which is after hydration: the server and
  // the first client render both see the defaults, so the markup agrees.
  const [layouts, setLayouts] = useState<Record<string, TLayout> | null>(null);
  const [readFrom, setReadFrom] = useState<Storage | null>(null);
  if (storage !== null && readFrom !== storage) {
    setReadFrom(storage);
    // Reading can throw even on a storage that exists (a locked-down profile
    // revokes it), so the reader falls back to the defaults and we hear of it.
    const read = Result.try({
      try: () => store.read(storage.getItem(store.storageKey)),
      catch: (cause) =>
        new ClientOperationError({
          action: "read-public-law-table-layout",
          cause,
          message: `Public-law table layout "${store.storageKey}" could not be read`,
        }),
    });
    if (Result.isError(read)) {
      analytics.captureError(read.error);
    }
    setLayouts(Result.isError(read) ? {} : read.value);
  }

  // The same object until the reader changes it: the table compares its
  // controlled state by identity, and a layout rebuilt per render loops it.
  const layout = layoutForSurface({
    defaults: store.defaultLayout,
    layouts,
    surface,
  });

  return {
    layout,
    setLayout: (next: TLayout) => {
      const stored = { ...layouts, [surface]: next };
      setLayouts(stored);
      if (storage === null) {
        return;
      }
      // Best effort for the reader, never silent for us: the choice is already
      // in state, so a storage that refuses the write costs the next visit and
      // nothing else, but the refusal is reported rather than dropped.
      const written = Result.try({
        try: () => {
          storage.setItem(store.storageKey, JSON.stringify(stored));
        },
        catch: (cause) =>
          new ClientOperationError({
            action: "write-public-law-table-layout",
            cause,
            message: `Public-law table layout "${store.storageKey}" could not be saved`,
          }),
      });
      if (Result.isError(written)) {
        analytics.captureError(written.error);
      }
    },
  };
};
