import { createFileRoute } from "@tanstack/react-router";

import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";
import { useWorkspaceChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-workspace-chat-mention-registration";

export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/$threadId",
)({
  component: WorkspaceThreadRoute,
});

function WorkspaceThreadRoute() {
  const { threadId, workspaceId } = Route.useParams({
    select: (params) => ({
      threadId: params.threadId,
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
