import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { RequireAIKey } from "@/components/require-ai-key";
import { pageTitle } from "@/lib/page-title";
import { useGlobalChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-global-chat-mention-registration";

export const Route = createFileRoute("/_protected/chat")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: ChatLayout,
});

function ChatLayout() {
  return (
    <div className="flex h-full w-full flex-col items-center overflow-hidden">
      <ChatMentionProviders>
        <ChatEditorProvider>
          <ChatRouteMentionRegistration />
          <RequireAIKey>
            <Outlet />
          </RequireAIKey>
        </ChatEditorProvider>
      </ChatMentionProviders>
    </div>
  );
}

function ChatRouteMentionRegistration() {
  useGlobalChatMentionRegistration();

  return null;
}
