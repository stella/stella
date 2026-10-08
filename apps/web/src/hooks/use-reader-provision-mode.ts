import { useState } from "react";
import type { RefObject } from "react";

import { Result } from "better-result";

import { keepReadingPosition } from "@/components/legal-reader/reader-position";
import {
  parseReaderProvisionMode,
  READER_PROVISION_MODE,
  READER_PROVISION_MODE_STORAGE_KEY,
} from "@/components/legal-reader/reader-provision-mode.logic";
import type { ReaderProvisionMode } from "@/components/legal-reader/reader-provision-mode.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useStorageOwner } from "@/lib/account/use-owner-scoped-state";
import {
  isCurrentStorageOwner,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import { useAnalytics } from "@/lib/analytics/provider";
import { ClientOperationError } from "@/lib/errors/client";

const MODE_CHANGED_EVENT = "reader-provision-mode-changed";

type StoredMode = {
  key: string;
  mode: ReaderProvisionMode;
  readError: ClientOperationError | null;
  storage: Storage | null;
};

const readMode = (storage: Storage, key: string) =>
  Result.try({
    try: () => parseReaderProvisionMode(storage.getItem(key)),
    catch: (cause) =>
      new ClientOperationError({
        action: "read-reader-provision-mode",
        cause,
        message: "Reader provision mode could not be read",
      }),
  });

/**
 * A browser-local reading preference, shared by the page and inspector.
 *
 * Every reader showing the preference keeps its place when it changes, the
 * one whose toggle was pressed and any other reader open beside it: the
 * cards appear under every paragraph at once, above the view as much as in
 * it.
 */
export const useReaderProvisionMode = (
  scrollContainerRef: RefObject<HTMLElement | null>,
) => {
  const storage = useLocalStorage();
  const analytics = useAnalytics();
  const owner = useStorageOwner();
  const key = userStorageKey(READER_PROVISION_MODE_STORAGE_KEY, owner);
  const [stored, setStored] = useState<StoredMode | null>(null);

  // Like text size, the stored choice is read after hydration. An owner
  // change reads that owner's choice before their next text render.
  if (stored === null || stored.storage !== storage || stored.key !== key) {
    const read =
      storage === null
        ? Result.ok(READER_PROVISION_MODE.collapsed)
        : readMode(storage, key);
    setStored({
      key,
      mode: read.unwrapOr(READER_PROVISION_MODE.collapsed),
      readError: Result.isError(read) ? read.error : null,
      storage,
    });
  }

  const readError = stored?.readError ?? null;
  useExternalSyncEffect(() => {
    if (storage === null) {
      return undefined;
    }
    if (readError !== null) {
      analytics.captureError(readError);
    }
    const refresh = () => {
      const read = readMode(storage, key);
      if (Result.isError(read)) {
        analytics.captureError(read.error);
        return;
      }
      keepReadingPosition({ scroller: scrollContainerRef.current }, () => {
        setStored((previous) =>
          previous?.key === key &&
          previous.mode === read.value &&
          previous.readError === null &&
          previous.storage === storage
            ? previous
            : { key, mode: read.value, readError: null, storage },
        );
      });
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === storage &&
        (event.key === key || event.key === null)
      ) {
        refresh();
      }
    };
    window.addEventListener(MODE_CHANGED_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MODE_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [analytics, key, readError, scrollContainerRef, storage]);

  const mode = stored?.mode ?? READER_PROVISION_MODE.collapsed;
  return {
    expandProvisions: mode === READER_PROVISION_MODE.expanded,
    toggle: () => {
      if (!isCurrentStorageOwner(owner)) {
        return;
      }
      const next =
        mode === READER_PROVISION_MODE.expanded
          ? READER_PROVISION_MODE.collapsed
          : READER_PROVISION_MODE.expanded;
      keepReadingPosition({ scroller: scrollContainerRef.current }, () => {
        setStored({ key, mode: next, readError: null, storage });
      });
      if (storage === null) {
        return;
      }
      const written = Result.try({
        try: () => storage.setItem(key, JSON.stringify(next)),
        catch: (cause) =>
          new ClientOperationError({
            action: "write-reader-provision-mode",
            cause,
            message: "Reader provision mode could not be saved",
          }),
      });
      if (Result.isError(written)) {
        analytics.captureError(written.error);
        return;
      }
      window.dispatchEvent(new Event(MODE_CHANGED_EVENT));
    },
  };
};
