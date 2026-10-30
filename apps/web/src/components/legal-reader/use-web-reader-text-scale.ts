import { createReaderTextScale } from "@stll/decision-reader/reader-text-scale";

import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

export const useWebReaderTextScale = () => {
  const { prefs, setPrefs } = usePresentationPrefs();
  return createReaderTextScale({
    initialScale: prefs.readerTextScale,
    onScaleChange: (readerTextScale) => setPrefs(() => ({ readerTextScale })),
  });
};
