import * as v from "valibot";

import type { ZoomDirection } from "@/components/inspector/zoom-controls";
import { readStoredJson } from "@/lib/stored-json";

/**
 * The sizes the reader's text is set at, as multiples of the reader's own body
 * size. A ladder rather than a repeated increment: a step lands on a named rung
 * instead of drifting by floating-point addition, and every value a browser has
 * ever persisted is one of these.
 */
export const READER_TEXT_SCALES = [0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.4] as const;

/** The size the reader is set at until someone changes it. A rung. */
export const READER_TEXT_SCALE_DEFAULT = 1;

export const READER_TEXT_SCALE_STORAGE_KEY = "reader_text_scale";

const StoredReaderTextScaleSchema = v.picklist(READER_TEXT_SCALES);

/**
 * The rung a value sits on. A level that is not one of them — a rung this
 * release dropped — is read as the nearest one still offered, so a step from it
 * is a step a reader recognizes.
 */
const nearestScale = (scale: number): number => {
  const byDistance = [...READER_TEXT_SCALES].toSorted(
    (left, right) => Math.abs(left - scale) - Math.abs(right - scale),
  );
  return byDistance.at(0) ?? READER_TEXT_SCALE_DEFAULT;
};

/** The next rung up or down, or the current one at either end of the ladder. */
export const nextReaderTextScale = (
  scale: number,
  direction: ZoomDirection,
): number => {
  const current = nearestScale(scale);
  if (direction === "in") {
    return READER_TEXT_SCALES.find((rung) => rung > current) ?? current;
  }
  return (
    READER_TEXT_SCALES.toReversed().find((rung) => rung < current) ?? current
  );
};

type ReaderTextScaleBounds = {
  atMax: boolean;
  atMin: boolean;
};

/** Which of the two buttons has nothing left to do. */
export const readerTextScaleBounds = (scale: number): ReaderTextScaleBounds => {
  const current = nearestScale(scale);
  return {
    atMax: READER_TEXT_SCALES.every((rung) => rung <= current),
    atMin: READER_TEXT_SCALES.every((rung) => rung >= current),
  };
};

/** What this browser last chose, or null for a key that says nothing usable. */
export const parseReaderTextScale = (raw: string | null): number | null =>
  readStoredJson(raw, StoredReaderTextScaleSchema);
