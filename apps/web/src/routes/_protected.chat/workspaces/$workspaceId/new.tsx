import { createFileRoute, redirect } from "@tanstack/react-router";

import { createChatThreadId } from "@/lib/chat-thread-ref";

export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/new",
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: {
        workspaceId: params.workspaceId,
        threadId: createChatThreadId(),
      },
      replace: true,
    });
  },
});
