import { useReaderTextScale } from "@stll/decision-reader/use-reader-text-scale";

import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

export const useWebReaderTextScale = () => {
  const { prefs, setPrefs } = usePresentationPrefs();
  return useReaderTextScale({
    initialScale: prefs.readerTextScale,
    onScaleChange: (readerTextScale) => setPrefs(() => ({ readerTextScale })),
  });
};
