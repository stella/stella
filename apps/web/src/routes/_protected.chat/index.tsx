import { createFileRoute } from "@tanstack/react-router";

import { groupedChatThreadsOptions } from "@/features/chat/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { skillsOptions } from "@/lib/knowledge/queries";
import {
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { routePresentation } from "@/routes/-route-presentation";
import { ChatIndexPage } from "@/routes/_protected.chat/-components/chat-index.page";
import { ChatIndexPending } from "@/routes/_protected.chat/-components/chat-index.pending";

export const Route = createFileRoute("/_protected/chat/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  loader: ({ context }) => {
    const activeOrganizationId = context.user.activeOrganizationId;
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "chat.index.loader.onPrefetchError:failure",
        scope: {
          type: "request",
          method: "GET",
          routeTemplate: "/_protected/chat/",
        },
      });
    };

    detached(
      Promise.all([
        prefetchRouteQuery(
          context.queryClient,
          workspacesNavigationOptions({
            organizationId: activeOrganizationId,
            userId: context.user.id,
          }),
          onPrefetchError,
        ),
        prefetchNonCriticalInfiniteQuery(
          context.queryClient,
          groupedChatThreadsOptions({
            activeOrganizationId,
            userId: context.user.id,
          }),
          onPrefetchError,
        ),
        prefetchNonCriticalInfiniteQuery(
          context.queryClient,
          skillsOptions(activeOrganizationId, context.user.id),
          onPrefetchError,
        ),
      ]),
      "chat-index.prefetch",
    );
  },
  component: ChatIndexPage,
  pendingComponent: ChatIndexPending,
});
