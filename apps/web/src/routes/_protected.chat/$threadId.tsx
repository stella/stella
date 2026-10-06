import { createFileRoute } from "@tanstack/react-router";

import { chatThreadOptions } from "@/features/chat/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { mcpConnectorsOptions, skillsOptions } from "@/lib/knowledge/queries";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import {
  ensureRouteQueryData,
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { usageEntitlementOptions } from "@/lib/usage-queries";

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
  pendingComponent: ChatThreadPending,
  pendingMs: 1000,
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const organizationId = context.user.activeOrganizationId;
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };
    const prefetchManagerEntitlement = async () => {
      // Parent and child loaders can run together; share the role query
      // before warming this manager-only endpoint.
      await prefetchRouteQuery(queryClient, roleOptions, onPrefetchError);
      const role = queryClient.getQueryData(roleOptions.queryKey);
      if (!hasOrganizationManagementAccess(role)) {
        return;
      }
      await prefetchRouteQuery(
        queryClient,
        usageEntitlementOptions({ organizationId }),
        onPrefetchError,
      );
    };

    // Composer data is independent of messages. Start it before the cold
    // thread query blocks mounting the page and its query observers.
    detached(
      Promise.all([
        prefetchNonCriticalInfiniteQuery(
          queryClient,
          skillsOptions(organizationId, context.user.id),
          onPrefetchError,
        ),
        prefetchRouteQuery(
          queryClient,
          mcpConnectorsOptions(organizationId),
          onPrefetchError,
        ),
        prefetchManagerEntitlement(),
      ]),
      "chat-thread.prefetch",
    );
    // Preload the persistent page's data before committing a cold navigation.
    // `context` here is a key-shape stub only (no live getters):
    // `chatThreadOptions` never builds a `ChatRuntime` from it — the
    // component builds that separately, from its own live getters, via
    // `useChatThreadRuntime`. See that factory's docs.
    const threadQueryOptions = chatThreadOptions({
      activeOrganizationId: context.user.activeOrganizationId,
      key: {
        scope: "global",
        threadId: toChatThreadId(params.threadId),
      },
      context: { allowMissingThread: true },
    });
    // Cached data — fresh, stale, or invalidated — renders immediately;
    // the component's own observer background-refetches stale entries
    // after mount and the runtime registry's idle reconcile picks the
    // refetched messages up. Awaiting a refetch here would block first
    // paint on a warm navigation and, worse, clobber the "move to main"
    // seeding: `buildMaximizeTabAction` seeds this key with the inspector
    // tab's unpersisted `contextMatterIds` and then invalidates, so an
    // awaited refetch would replace the seed with the server's (possibly
    // empty) set before the page's matter picker ever saw it. The loader
    // only fills a cold cache.
    if (
      context.queryClient.getQueryData(threadQueryOptions.queryKey) !==
      undefined
    ) {
      return;
    }
    await ensureRouteQueryData(context.queryClient, threadQueryOptions);
  },
});

function ThreadRoute() {
  return null;
}

function ChatThreadPending() {
  return null;
}
