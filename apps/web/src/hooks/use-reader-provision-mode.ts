import type { RefObject } from "react";

import { keepReadingPosition } from "@/components/legal-reader/reader-position";
import { useMountEffect } from "@/hooks/use-effect";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

export const useReaderProvisionMode = (
  scrollContainerRef: RefObject<HTMLElement | null>,
) => {
  const { prefs, setPrefs, readerScrollContainers } = usePresentationPrefs();
  useMountEffect(() => {
    readerScrollContainers.add(scrollContainerRef);
    return () => {
      readerScrollContainers.delete(scrollContainerRef);
    };
  });
  return {
    expandProvisions: prefs.readerProvisionMode === "expanded",
    toggle: () => {
      // Every mounted reader changes together; hold each passage before the
      // shared preference adds or removes provision cards above it.
      for (const scroller of readerScrollContainers) {
        keepReadingPosition({ scroller: scroller.current }, () => undefined);
      }
      setPrefs((latest) => ({
        readerProvisionMode:
          latest.readerProvisionMode === "expanded" ? "collapsed" : "expanded",
      }));
    },
  };
};
