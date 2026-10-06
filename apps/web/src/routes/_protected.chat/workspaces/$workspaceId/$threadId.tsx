import { createFileRoute } from "@tanstack/react-router";

import { useWorkspaceChatMentionRegistration } from "@/features/chat/hooks/use-workspace-chat-mention-registration";
import { chatThreadOptions } from "@/features/chat/queries";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ensureRouteQueryData } from "@/lib/react-query";

export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/$threadId",
)({
  component: WorkspaceThreadRoute,
  pendingMs: 1000,
  pendingComponent: () => null,
  loader: async ({ context, params }) => {
    // Preload the persistent page's data; see the
    // sibling `/_protected/chat/$threadId` loader for why `context` here
    // is a key-shape stub and never seeds a `ChatRuntime`, and why the
    // loader only fills a COLD cache (cached data renders immediately and
    // background-refetches; awaiting here would clobber the maximize-tab
    // `contextMatterIds` seeding).
    const threadQueryOptions = chatThreadOptions({
      activeOrganizationId: context.user.activeOrganizationId,
      key: {
        scope: "workspace",
        threadId: toChatThreadId(params.threadId),
        workspaceId: params.workspaceId,
      },
      context: { allowMissingThread: true },
    });
    if (
      context.queryClient.getQueryData(threadQueryOptions.queryKey) !==
      undefined
    ) {
      return;
    }
    await ensureRouteQueryData(context.queryClient, threadQueryOptions);
  },
});

function WorkspaceThreadRoute() {
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  useWorkspaceChatMentionRegistration(workspaceId);
  return null;
}
