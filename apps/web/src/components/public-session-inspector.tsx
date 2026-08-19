import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { InspectorPanel } from "@/components/inspector/inspector-panel";
import { AIAvailabilityProvider } from "@/components/require-ai-key";

/**
 * The workspace inspector on a public surface, once a session exists. It is
 * mounted without a matter: a tab opened from a public reader belongs to the
 * reader, not to a matter, so chats it opens are global ones.
 */
export const PublicSessionInspector = () => (
  <ChatMentionProviders>
    <AIAvailabilityProvider>
      <ChatEditorProvider>
        <InspectorPanel />
      </ChatEditorProvider>
    </AIAvailabilityProvider>
  </ChatMentionProviders>
);
