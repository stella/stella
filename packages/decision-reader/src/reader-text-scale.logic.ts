export type ZoomDirection = "in" | "out";

/**
 * The sizes the reader's text is set at, as multiples of the reader's own body
 * size. A ladder rather than a repeated increment: a step lands on a named rung
 * instead of drifting by floating-point addition, and every value a browser has
 * ever persisted is one of these.
 */
export const READER_TEXT_SCALES = [0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.4] as const;
export type ReaderTextScale = (typeof READER_TEXT_SCALES)[number];

/** The size the reader is set at until someone changes it. A rung. */
export const READER_TEXT_SCALE_DEFAULT = 1;

/**
 * The rung a value sits on. A level that is not one of them — a rung this
 * release dropped — is read as the nearest one still offered, so a step from it
 * is a step a reader recognizes.
 */
const nearestScale = (scale: number): ReaderTextScale => {
  let closest: ReaderTextScale = READER_TEXT_SCALE_DEFAULT;
  for (const rung of READER_TEXT_SCALES) {
    if (Math.abs(rung - scale) < Math.abs(closest - scale)) {
      closest = rung;
    }
  }
  return closest;
};

/** The next rung up or down, or the current one at either end of the ladder. */
export const nextReaderTextScale = (
  scale: number,
  direction: ZoomDirection,
): ReaderTextScale => {
  const current = nearestScale(scale);
  if (direction === "in") {
    return (
      READER_TEXT_SCALES.find(
        (rung): rung is ReaderTextScale => rung > current,
      ) ?? current
    );
  }
  return (
    READER_TEXT_SCALES.toReversed().find(
      (rung): rung is ReaderTextScale => rung < current,
    ) ?? current
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
