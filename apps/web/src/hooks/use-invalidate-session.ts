import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { refreshAuthQueries } from "@/lib/auth-queries";

export const useInvalidateSession = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async () => {
      await refreshAuthQueries(queryClient);
      await router.invalidate();
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
