import { useMatch } from "@tanstack/react-router";

import { resolveSidebarWorkspaceId } from "@/components/app-sidebar.logic";

/**
 * The matter in the URL: a matter page or a matter chat, else undefined.
 *
 * This is the route alone. The inspector's display matter is a different
 * value: it prefers the active tab's matter, so it can name a matter the user
 * has already left. A new chat takes its scope from this hook, through
 * `newChatMatterScope`.
 */
export const useRouteWorkspaceId = (): string | undefined => {
  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const workspaceChatMatch = useMatch({
    from: "/_protected/chat/workspaces/$workspaceId/$threadId",
    shouldThrow: false,
  });
  return resolveSidebarWorkspaceId({
    chatWorkspaceId: workspaceChatMatch?.params.workspaceId,
    workspaceId: workspaceMatch?.params.workspaceId,
  });
};
