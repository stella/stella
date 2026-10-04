import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { hideSessionDocument } from "@/lib/account/session-document";
import { signalSessionChange } from "@/lib/account/session-signal";
import { releaseUserStorage } from "@/lib/account/user-scoped-storage";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { rootKeys } from "@/lib/auth-queries";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";

/**
 * Signs out. Whatever the server answers, this browser keeps nothing of the
 * user and the other tabs are told.
 */
export const signOutAndRelease = async (
  areas?: Parameters<typeof releaseUserStorage>[0],
) => {
  const result = await authClient.signOut().finally(() => {
    releaseUserStorage(areas);
    signalSessionChange();
  });
  if (!result.error) {
    hideSessionDocument();
  }
  return result;
};

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
        notifyUserError(
          toAuthClientError(result.error),
          t("errors.actionFailed"),
        );
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
