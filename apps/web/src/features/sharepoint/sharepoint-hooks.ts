import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

import {
  sharepointAccessOptions,
  sharepointKeys,
  type SharepointViewer,
} from "./sharepoint-queries";

export const useSharepointViewer = (): SharepointViewer => {
  const { id: userId, activeOrganizationId } = useAuthenticatedUser();
  return { organizationId: activeOrganizationId, userId };
};

/**
 * The SharePoint gate for the signed-in member as a query view: pending, a
 * failed read, or the answer (404 unavailable, 403 disabled, or enabled).
 * Only an enabled answer offers SharePoint. A surface people expect (the
 * connections row, the organization switch) shows a failed read with a retry;
 * every other surface stays hidden until the gate is known.
 */
export const useSharepointAccess = () => {
  const view = queryView(
    useQuery(sharepointAccessOptions(useSharepointViewer())),
  );
  useQueryViewError(view, "useSharepointAccess:query");
  return view;
};

export type SharepointAccessView = ReturnType<typeof useSharepointAccess>;

/**
 * Starts Microsoft consent: the API mints the authorize URL and the browser
 * leaves for it. Microsoft returns through the API callback to
 * `/sharepoint/oauth-callback`.
 */
export const useSharepointConnect = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  return useMutation({
    mutationFn: async () =>
      await invokeAppOnlyWrite("sharepoint.connect", async () =>
        unwrapApiResponse(await api.sharepoint.connect.post()),
      ),
    onSuccess: ({ authorizeUrl }) => {
      window.location.assign(authorizeUrl);
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
      analytics.captureError(error, {
        fingerprintKey: "useSharepointConnect:failure",
        scope: { type: "handler", handlerId: "useSharepointConnect:failure" },
      });
    },
  });
};

/** Removes the member's own Microsoft connection and its stored tokens. */
export const useSharepointDisconnect = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const viewer = useSharepointViewer();
  return useMutation({
    mutationFn: async () =>
      await invokeAppOnlyWrite("sharepoint.connection.delete", async () =>
        unwrapApiResponse(await api.sharepoint.connection.delete()),
      ),
    onSuccess: async () => {
      stellaToast.add({ title: t("sharepoint.disconnected"), type: "success" });
      await queryClient.invalidateQueries({
        queryKey: sharepointKeys.viewer(viewer),
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
      analytics.captureError(error, {
        fingerprintKey: "useSharepointDisconnect:failure",
        scope: {
          type: "handler",
          handlerId: "useSharepointDisconnect:failure",
        },
      });
    },
  });
};
