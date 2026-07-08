import { createFileRoute } from "@tanstack/react-router";

import { toChatThreadId } from "@/lib/chat-thread-ref";
// oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch -- chatThreadOptions builds the ChatRuntime from component-provided context getters (auth user, matter ids, send mode); a loader prefetch would cache a stub-context runtime under the same key and the first send would bypass anonymization. Fixing needs the queryFn split into a pure data fetch plus in-component runtime construction
import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";
import { useWorkspaceChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-workspace-chat-mention-registration";

export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/$threadId",
)({
  component: WorkspaceThreadRoute,
  // See sibling route at `/_protected/chat/$threadId` — delay the
  // pending splash so consecutive thread navigations don't flash
  // a logo loader between two cached chats.
  pendingMs: 1000,
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
