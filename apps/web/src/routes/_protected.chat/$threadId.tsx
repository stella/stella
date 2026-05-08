import { createFileRoute } from "@tanstack/react-router";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
});

function ThreadRoute() {
  const threadId = Route.useParams({
    select: (params) => toChatThreadId(params.threadId),
  });

  return <ChatThreadPage threadRef={{ scope: "global", threadId }} />;
}
