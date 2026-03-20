import { useLayoutEffect } from "react";
import type { RefObject } from "react";

import { useShallow } from "zustand/react/shallow";

import { SCROLL_AREA_VIEWPORT_SELECTOR } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { captureScrollPosition } from "@/lib/pdf/utils";

type UsePDFControlledScaleOffsetArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
  controlledScaleOffset: number | undefined;
};

export const usePDFControlledScaleOffset = ({
  containerRef,
  controlledScaleOffset,
}: UsePDFControlledScaleOffsetArgs) => {
  const [scaleOffset, setScaleOffset] = usePDFStore(
    useShallow((s) => [s.scaleOffset, s.setScaleOffset]),
  );

  useLayoutEffect(() => {
    if (
      controlledScaleOffset === undefined ||
      controlledScaleOffset === scaleOffset
    ) {
      return;
    }

    const scrollViewport = containerRef.current?.closest<HTMLElement>(
      SCROLL_AREA_VIEWPORT_SELECTOR,
    );
    const restore = scrollViewport
      ? captureScrollPosition(scrollViewport)
      : null;

    setScaleOffset(controlledScaleOffset);

    if (restore) {
      requestAnimationFrame(restore);
    }
  }, [controlledScaleOffset, scaleOffset, setScaleOffset, containerRef]);
};
