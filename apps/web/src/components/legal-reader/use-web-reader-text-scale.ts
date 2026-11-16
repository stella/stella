import { useReaderTextScale } from "@stll/decision-reader/use-reader-text-scale";

import { useLocalStorage } from "@/hooks/use-local-storage";
import { useAnalytics } from "@/lib/analytics/provider";

export const useWebReaderTextScale = (
  readerKind: "decision" | "statute" | "provision",
) => {
  const storage = useLocalStorage();
  const analytics = useAnalytics();
  return useReaderTextScale({
    storage,
    analytics: {
      captureError: (error, operation) =>
        analytics.captureError(error, {
          fingerprintKey: "useWebReaderTextScale:storage",
          scope: {
            type: "handler",
            handlerId: `reader-text-scale.${readerKind}.${operation}`,
          },
        }),
    },
  });
};
