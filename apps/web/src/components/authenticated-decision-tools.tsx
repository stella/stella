import { useImperativeHandle } from "react";
import type { Ref } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { openDecisionConversation } from "@/components/decision-chat-open.logic";
import {
  AIAvailabilityProvider,
  useAIKeyGate,
} from "@/components/require-ai-key";
import { decisionChatThreadOptions } from "@/features/chat/queries";
import { useMountEffect } from "@/hooks/use-effect";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import type { ChatThreadId } from "@/lib/chat-thread-ref";
import type { SafeId } from "@/lib/safe-id";

/** What a member's decision reader asks of this chunk before it runs AI. */
export type DecisionReaderAIGate = {
  ensureAIAvailable: () => Promise<boolean>;
};

type AuthenticatedDecisionToolsProps = {
  decisionId: SafeId<"caseLawDecision">;
  /** Receives the AI key gate once it is mounted, and null when it leaves. */
  ref: Ref<DecisionReaderAIGate>;
};

/**
 * What a member adds to a public decision page, in a chunk a visitor never
 * loads. It mounts beside the reader, never around it: the reader is already
 * on screen when the chunk arrives, and wrapping it in these providers then
 * would replace it, scroll position, focus and all. The reader's chat overlay
 * brings its own composer providers.
 */
export const AuthenticatedDecisionTools = ({
  decisionId,
  ref,
}: AuthenticatedDecisionToolsProps) => {
  const user = useAuthenticatedUser();
  return (
    <ChatMentionProviders>
      <AIAvailabilityProvider>
        <DecisionAIGateHandle ref={ref} />
      </AIAvailabilityProvider>
      {/* The law shell docks the inspector; the reader only seeds its tabs. */}
      <AutoOpenDecisionChat
        decisionId={decisionId}
        key={decisionId}
        user={user}
      />
    </ChatMentionProviders>
  );
};

/**
 * Hands the page the gate this chunk mounts. The reader calls it only from
 * the actions that run AI, so it is passed up as a handle rather than drawn.
 */
const DecisionAIGateHandle = ({ ref }: { ref: Ref<DecisionReaderAIGate> }) => {
  const { ensureAIAvailable } = useAIKeyGate();
  useImperativeHandle(ref, () => ({ ensureAIAvailable }), [ensureAIAvailable]);
  return null;
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
