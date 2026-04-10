import { createFileRoute } from "@tanstack/react-router";

import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
});

function ThreadRoute() {
  const threadId = Route.useParams({
    select: (params) => params.threadId,
  });

  return <ChatThreadPage threadRef={{ scope: "global", threadId }} />;
}
