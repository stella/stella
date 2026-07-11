import { useMutation } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

export const useSignOut = () => {
  const analytics = useAnalytics();
  const location = useLocation();
  const navigate = useNavigate();
  const t = useTranslations();

  return useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();

      if (result.error) {
        stellaToast.add({
          title: userErrorFromThrown(
            toAuthClientError(result.error),
            t("errors.actionFailed"),
          ),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }

      analytics.reset();

      await navigate({
        to: "/auth",
        search: { redirectTo: location.pathname },
        reloadDocument: true,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
