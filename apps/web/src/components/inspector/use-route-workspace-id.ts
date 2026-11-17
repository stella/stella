import { useRouterState } from "@tanstack/react-router";

import { resolveSidebarWorkspaceId } from "@/components/app-sidebar.logic";

/**
 * The matter in the URL: a matter page or a matter chat, else undefined.
 *
 * This is the route alone. The inspector's display matter is a different
 * value: it prefers the active tab's matter, so it can name a matter the user
 * has already left. A new chat takes its scope from this hook, through
 * `newChatMatterScope`.
 */
export const useRouteWorkspaceId = (): string | undefined =>
  useRouterState({
    select: ({ matches }) =>
      resolveSidebarWorkspaceId({
        chatWorkspaceId: matches.find(
          (match) =>
            match.routeId ===
            "/_protected/chat/workspaces/$workspaceId/$threadId",
        )?.params.workspaceId,
        workspaceId: matches.find(
          (match) => match.routeId === "/_protected/workspaces/$workspaceId",
        )?.params.workspaceId,
      }),
  });
