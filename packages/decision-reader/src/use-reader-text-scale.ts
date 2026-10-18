import type { CSSProperties } from "react";

import type {
  ReaderTextScale as ReaderTextScaleValue,
  ZoomDirection,
} from "./reader-text-scale.logic";
import {
  nextReaderTextScale,
  READER_TEXT_SCALE_DEFAULT,
  readerTextScaleBounds,
} from "./reader-text-scale.logic";

export type ReaderTextScaleOptions = {
  initialScale?: ReaderTextScaleValue;
  onScaleChange?: (scale: ReaderTextScaleValue) => void;
};

type ReaderTextScaleRootProps = {
  "data-slot": "reader-text-root";
  style: CSSProperties & { "--reader-text-scale": number };
};

type ReaderTextScale = {
  atMax: boolean;
  atMin: boolean;
  level: number;
  reset: () => void;
  rootProps: ReaderTextScaleRootProps;
  zoom: (direction: ZoomDirection) => void;
};

/** The host owns the choice and supplies its server-renderable value. */
export const useReaderTextScale = ({
  initialScale = READER_TEXT_SCALE_DEFAULT,
  onScaleChange,
}: ReaderTextScaleOptions = {}): ReaderTextScale => {
  const applyScale = (scale: ReaderTextScaleValue) => onScaleChange?.(scale);
  return {
    ...readerTextScaleBounds(initialScale),
    level: initialScale,
    reset: () => applyScale(READER_TEXT_SCALE_DEFAULT),
    rootProps: {
      "data-slot": "reader-text-root",
      style: { "--reader-text-scale": initialScale },
    },
    zoom: (direction) =>
      applyScale(nextReaderTextScale(initialScale, direction)),
  };
};
