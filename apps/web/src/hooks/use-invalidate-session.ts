import { usePostHog } from "@posthog/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { captureError } from "@/lib/posthog/utils";
import { rootKeys } from "@/routes/-queries";

export const useInvalidateSession = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async () => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: rootKeys.session }),
        queryClient.refetchQueries({ queryKey: rootKeys.role }),
      ]);
      await router.invalidate();
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};
