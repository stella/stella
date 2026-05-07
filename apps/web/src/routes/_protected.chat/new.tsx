import { createFileRoute, redirect } from "@tanstack/react-router";

import { createChatThreadId } from "@/lib/chat-thread-ref";

export const Route = createFileRoute("/_protected/chat/new")({
  beforeLoad: () => {
    throw redirect({
      to: "/chat/$threadId",
      params: { threadId: createChatThreadId() },
      replace: true,
    });
  },
});
