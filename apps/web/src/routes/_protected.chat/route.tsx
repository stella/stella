import { createFileRoute, Outlet } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { ChatActorProvider } from "@/routes/_protected.chat/-hooks/chat-actor-provider";

export const Route = createFileRoute("/_protected/chat")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: ChatLayout,
});

function ChatLayout() {
  return (
    <ChatActorProvider>
      <div className="flex h-full w-full flex-col items-center overflow-hidden">
        <Outlet />
      </div>
    </ChatActorProvider>
  );
}
