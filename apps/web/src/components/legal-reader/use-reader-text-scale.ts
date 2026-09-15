import { useState } from "react";
import type { CSSProperties } from "react";

import { Result } from "better-result";

import type { ZoomDirection } from "@/components/inspector/zoom-controls";
import {
  nextReaderTextScale,
  parseReaderTextScale,
  READER_TEXT_SCALE_DEFAULT,
  READER_TEXT_SCALE_STORAGE_KEY,
  readerTextScaleBounds,
} from "@/components/legal-reader/reader-text-scale.logic";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useAnalytics } from "@/lib/analytics/provider";
import { ClientOperationError } from "@/lib/errors/client";

/**
 * What marks the element the scale applies from. The slot and the step travel
 * together so a reader cannot set one without the other: `reader.css` keys the
 * whole derived type ladder off this slot, and the step it multiplies by comes
 * from the same object.
 */
type ReaderTextScaleRootProps = {
  "data-slot": "reader-text-root";
  style: CSSProperties & { "--reader-text-scale": number };
};

type ReaderTextScale = {
  atMax: boolean;
  atMin: boolean;
  /** The current size, as the zoom control's level. */
  level: number;
  reset: () => void;
  /** Spread onto the element the document's sizes are measured from. */
  rootProps: ReaderTextScaleRootProps;
  zoom: (direction: ZoomDirection) => void;
};

/**
 * Reading can throw on a storage that exists (a locked-down profile revokes
 * it), so the access is a `Result` and the reader falls back to its own size.
 */
const readStoredScale = (
  storage: Storage,
): Result<number, ClientOperationError> =>
  Result.try({
    try: () => storage.getItem(READER_TEXT_SCALE_STORAGE_KEY),
    catch: (cause) =>
      new ClientOperationError({
        action: "read-reader-text-scale",
        cause,
        message: "Reader text size could not be read",
      }),
  }).map((raw) => parseReaderTextScale(raw) ?? READER_TEXT_SCALE_DEFAULT);

const writeStoredScale = (
  storage: Storage,
  scale: number,
): Result<void, ClientOperationError> =>
  Result.try({
    try: () => {
      storage.setItem(READER_TEXT_SCALE_STORAGE_KEY, JSON.stringify(scale));
    },
    catch: (cause) =>
      new ClientOperationError({
        action: "write-reader-text-scale",
        cause,
        message: "Reader text size could not be saved",
      }),
  });

/**
 * How large this browser reads legal text, and how to change it. One size for
 * every reader in the pane: a lawyer who sizes a decision to their screen has
 * said the same thing about the statute they open next.
 *
 * Local to the browser, like the table's columns: the readers are public, so
 * there is no account to hang the choice on until there is one.
 */
export const useReaderTextScale = (): ReaderTextScale => {
  const analytics = useAnalytics();
  const storage = useLocalStorage();
  // Null until storage has been read, which is after hydration: the server and
  // the first client render both see the default, so the markup agrees.
  const [storedScale, setStoredScale] = useState<number | null>(null);
  const [readFrom, setReadFrom] = useState<Storage | null>(null);
  if (storage !== null && readFrom !== storage) {
    setReadFrom(storage);
    setStoredScale(
      readStoredScale(storage).unwrapOr(READER_TEXT_SCALE_DEFAULT),
    );
  }

  const scale = storedScale ?? READER_TEXT_SCALE_DEFAULT;
  const applyScale = (next: number) => {
    setStoredScale(next);
    if (storage === null) {
      return;
    }
    // Best effort for the reader, never silent for us: the size is already on
    // screen, so a storage that refuses the write costs the next visit and
    // nothing else — but the refusal is reported rather than dropped.
    const written = writeStoredScale(storage, next);
    if (Result.isError(written)) {
      analytics.captureError(written.error);
    }
  };

  return {
    ...readerTextScaleBounds(scale),
    level: scale,
    reset: () => applyScale(READER_TEXT_SCALE_DEFAULT),
    rootProps: {
      "data-slot": "reader-text-root",
      style: { "--reader-text-scale": scale },
    },
    zoom: (direction) => applyScale(nextReaderTextScale(scale, direction)),
  };
};
