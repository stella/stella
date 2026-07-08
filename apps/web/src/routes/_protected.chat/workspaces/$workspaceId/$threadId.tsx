import { createFileRoute } from "@tanstack/react-router";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ensureRouteQueryData } from "@/lib/react-query";
import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";
import { useWorkspaceChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-workspace-chat-mention-registration";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";

export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/$threadId",
)({
  component: WorkspaceThreadRoute,
  // See sibling route at `/_protected/chat/$threadId` — delay the
  // pending splash so consecutive thread navigations don't flash
  // a logo loader between two cached chats.
  pendingMs: 1000,
  loader: async ({ context, params }) => {
    // Prime the pure thread-data query the page suspends on; see the
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
  const { threadId, workspaceId } = Route.useParams({
    select: (params) => ({
      threadId: toChatThreadId(params.threadId),
      workspaceId: params.workspaceId,
    }),
  });
  useWorkspaceChatMentionRegistration(workspaceId);

  return (
    <ChatThreadPage
      threadRef={{ scope: "workspace", threadId, workspaceId }}
      workspaceId={workspaceId}
    />
  );
}
