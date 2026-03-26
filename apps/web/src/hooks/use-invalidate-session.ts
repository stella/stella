import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { rootKeys } from "@/routes/-queries";

export const useInvalidateSession = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async () => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: rootKeys.session }),
        queryClient.refetchQueries({ queryKey: rootKeys.role }),
      ]);
      await router.invalidate();
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
