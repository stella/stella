import type { ComponentProps } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { openDecisionConversation } from "@/components/decision-chat-open.logic";
import {
  AIAvailabilityProvider,
  useAIKeyGate,
} from "@/components/require-ai-key";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { decisionChatThreadOptions } from "@/features/chat/queries";
import { useMountEffect } from "@/hooks/use-effect";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadId } from "@/lib/chat-thread-ref";
import type { SafeId } from "@/lib/safe-id";

type AuthenticatedCaseLawWorkspaceProps = {
  decision: ComponentProps<typeof DecisionWorkspace>["decision"];
  decisionId: SafeId<"caseLawDecision">;
  initialAnchorId?: string | undefined;
  landingSessionId?: string | undefined;
  user: AuthenticatedUser;
};

export const AuthenticatedCaseLawWorkspace = ({
  decision,
  decisionId,
  initialAnchorId,
  landingSessionId,
  user,
}: AuthenticatedCaseLawWorkspaceProps) => (
  <AuthenticatedUserProvider user={user}>
    <ChatMentionProviders>
      <AIAvailabilityProvider>
        <ChatEditorProvider>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <AuthenticatedDecisionWorkspace
              decision={decision}
              decisionId={decisionId}
              initialAnchorId={initialAnchorId}
              landingSessionId={landingSessionId}
            />
          </div>
          {/* The law shell docks the inspector; the reader only seeds its tabs. */}
          <AutoOpenDecisionChat
            decisionId={decisionId}
            key={decisionId}
            user={user}
          />
        </ChatEditorProvider>
      </AIAvailabilityProvider>
    </ChatMentionProviders>
  </AuthenticatedUserProvider>
);

const AuthenticatedDecisionWorkspace = ({
  decision,
  decisionId,
  initialAnchorId,
  landingSessionId,
}: Pick<
  AuthenticatedCaseLawWorkspaceProps,
  "decision" | "decisionId" | "initialAnchorId" | "landingSessionId"
>) => {
  const { ensureAIAvailable } = useAIKeyGate();

  return (
    <DecisionWorkspace
      aiMode="enabled"
      decision={decision}
      decisionId={decisionId}
      ensureAIAvailable={ensureAIAvailable}
      initialAnchorId={initialAnchorId}
      landingSessionId={landingSessionId}
    />
  );
};

/** Keys the opener when the server names no conversation. */
const NO_CONVERSATION = "none";

/**
 * Seeds the decision's conversation once the server has said which it is. A
 * failed lookup still gives the reader a chat: a fresh one, as before there
 * was anything to find. The opener is keyed by the answer, so a refetch that
 * names another conversation (one started in another window) opens it too.
 */
const AutoOpenDecisionChat = ({
  decisionId,
  user,
}: {
  decisionId: SafeId<"caseLawDecision">;
  user: AuthenticatedUser;
}) => {
  const conversation = useQuery(
    decisionChatThreadOptions({
      activeOrganizationId: user.activeOrganizationId,
      key: { decisionId, userId: user.id },
    }),
  );
  switch (conversation.status) {
    case "pending":
      return null;
    case "error":
      return (
        <OpenDecisionChat
          decisionId={decisionId}
          key={NO_CONVERSATION}
          threadId={null}
        />
      );
    case "success":
      return (
        <OpenDecisionChat
          decisionId={decisionId}
          key={conversation.data.threadId ?? NO_CONVERSATION}
          threadId={conversation.data.threadId}
        />
      );
    default:
      conversation satisfies never;
      return panic("Unhandled decision conversation lookup state");
  }
};

const OpenDecisionChat = ({
  decisionId,
  threadId,
}: {
  decisionId: SafeId<"caseLawDecision">;
  threadId: ChatThreadId | null;
}) => {
  useMountEffect(() => {
    openDecisionConversation({ decisionId, threadId });
  });
  return null;
};
