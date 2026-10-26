import { createFileRoute } from "@tanstack/react-router";

import { groupedChatThreadsOptions } from "@/features/chat/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { ChatHistoryPage } from "@/routes/_protected.chat/-components/chat-history-page";
import { chatHistorySearchSchema } from "@/routes/_protected.chat/-components/chat-history.logic";
import type { ChatHistorySearch } from "@/routes/_protected.chat/-components/chat-history.logic";

export const Route = createFileRoute("/_protected/chat/history")({
  validateSearch: chatHistorySearchSchema,
  loaderDeps: ({ search }) => ({ matter: search.matter, q: search.q }),
  loader: ({ context, deps }) => {
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "chat.history.loader.onPrefetchError:failure",
        scope: {
          type: "request",
          method: "GET",
          routeTemplate: "/_protected/chat/history",
        },
      });
    };
    detached(
      Promise.all([
        prefetchNonCriticalInfiniteQuery(
          context.queryClient,
          groupedChatThreadsOptions({
            activeOrganizationId: context.user.activeOrganizationId,
            search: deps.q,
            userId: context.user.id,
            workspaceId: deps.matter,
          }),
          onPrefetchError,
        ),
        prefetchRouteQuery(
          context.queryClient,
          workspacesNavigationOptions({
            organizationId: context.user.activeOrganizationId,
            userId: context.user.id,
          }),
          onPrefetchError,
        ),
      ]),
      "chat-history.prefetch",
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("common.history") }],
  }),
  component: ChatHistoryRoute,
});

function ChatHistoryRoute() {
  const q = Route.useSearch({ select: (search) => search.q });
  const matter = Route.useSearch({ select: (search) => search.matter });
  const navigate = Route.useNavigate();

  const onSearchChange = (search: ChatHistorySearch) => {
    // Refining a filter replaces the entry, so Back leaves the page instead
    // of replaying every keystroke.
    detached(navigate({ search, replace: true }), "chat-history.search");
  };

  return (
    <ChatHistoryPage onSearchChange={onSearchChange} search={{ matter, q }} />
  );
}
