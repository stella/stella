import type { ReactNode } from "react";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import { AIAvailabilityProvider } from "@/components/require-ai-key";

export const AuthenticatedStatuteChat = ({
  activeLegal,
  children,
}: {
  activeLegal: ActiveLegalDocument;
  children: ReactNode;
}) => (
  <ChatMentionProviders>
    <AIAvailabilityProvider>
      <ChatEditorProvider>
        <LegalReaderAIChat activeLegal={activeLegal} className="h-full">
          {children}
        </LegalReaderAIChat>
      </ChatEditorProvider>
    </AIAvailabilityProvider>
  </ChatMentionProviders>
);
