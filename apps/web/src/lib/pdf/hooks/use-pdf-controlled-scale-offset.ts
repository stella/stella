import { useEffect } from "react";
import type { RefObject } from "react";

import { useShallow } from "zustand/react/shallow";

import { SCROLL_AREA_VIEWPORT_SELECTOR } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";

type UsePDFControlledScaleOffsetArgs = {
  containerRef: RefObject<HTMLDivElement | null>;
  controlledScaleOffset: number;
};

export const usePDFControlledScaleOffset = ({
  containerRef,
  controlledScaleOffset,
}: UsePDFControlledScaleOffsetArgs) => {
  const [scale, scaleOffset, setScaleOffset] = usePDFStore(
    useShallow((s) => [s.scale, s.scaleOffset, s.setScaleOffset]),
  );

  useEffect(() => {
    if (controlledScaleOffset === scaleOffset) {
      return;
    }

    setScaleOffset(controlledScaleOffset);

    const scrollViewport = containerRef.current?.closest<HTMLElement>(
      SCROLL_AREA_VIEWPORT_SELECTOR,
    );

    if (!scrollViewport) {
      return;
    }

    const prevScrollTop = scrollViewport.scrollTop;
    const clientHeight = scrollViewport.clientHeight;

    const oldEffective = scale + scaleOffset;
    const newEffective = scale + controlledScaleOffset;
    const scaleRatio = oldEffective > 0 ? newEffective / oldEffective : 1;

    scrollViewport.scrollTop =
      (prevScrollTop + clientHeight / 2) * scaleRatio - clientHeight / 2;
  }, [controlledScaleOffset, scaleOffset, scale, setScaleOffset, containerRef]);
};
