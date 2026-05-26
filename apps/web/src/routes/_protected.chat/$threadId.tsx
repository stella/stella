import { createFileRoute } from "@tanstack/react-router";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
  // Skip the route-level pending splash for chat-thread navigations.
  // Most threads load instantly from cache; the brief splash was
  // jarring between two consecutive chats. With pendingMs at 1s
  // the splash only appears when the load actually stalls.
  pendingMs: 1000,
});

function ThreadRoute() {
  const threadId = Route.useParams({
    select: (params) => toChatThreadId(params.threadId),
  });

  return <ChatThreadPage threadRef={{ scope: "global", threadId }} />;
}
