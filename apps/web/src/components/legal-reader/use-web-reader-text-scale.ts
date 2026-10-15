import { useReaderTextScale } from "@stll/decision-reader/use-reader-text-scale";

import { useLocalStorage } from "@/hooks/use-local-storage";
import { useAnalytics } from "@/lib/analytics/provider";

export const useWebReaderTextScale = () => {
  const storage = useLocalStorage();
  const analytics = useAnalytics();
  return useReaderTextScale({ storage, analytics });
};
