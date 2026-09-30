import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { signalSessionChange } from "@/lib/account/session-signal";
import { releaseUserStorage } from "@/lib/account/user-scoped-storage";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { rootKeys } from "@/lib/auth-queries";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

/**
 * Signs out. Whatever the server answers, this browser keeps nothing of the
 * user and the other tabs are told.
 */
export const signOutAndRelease = async (
  areas?: Parameters<typeof releaseUserStorage>[0],
) =>
  await authClient.signOut().finally(() => {
    releaseUserStorage(areas);
    signalSessionChange();
  });

export const useSignOut = () => {
  const analytics = useAnalytics();
  const routeLocation = useLocation();
  const navigate = useNavigate();
  const t = useTranslations();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const result = await signOutAndRelease();

      if (result.error) {
        // Still signed in: read the session again so this tab keeps the
        // user's storage instead of the visitor's.
        await queryClient.refetchQueries({ queryKey: rootKeys.session });
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

      // The document reload disposes all client state instead of invoking the reset owner.
      await navigate({
        to: "/auth",
        search: { redirectTo: routeLocation.pathname },
        reloadDocument: true,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
