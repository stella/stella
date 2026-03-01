import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";

export const useSignOut = () => {
  const posthog = usePostHog();
  const location = useLocation();
  const navigate = useNavigate();
  const t = useTranslations();

  return useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();

      if (result.error) {
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }

      await navigate({
        to: "/auth",
        search: { redirectTo: location.pathname },
        reloadDocument: true,
      });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};
