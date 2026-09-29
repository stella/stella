import type { ComponentProps } from "react";

import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { INSPECTOR_PANE_INTENT } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  AIAvailabilityProvider,
  useAIKeyGate,
} from "@/components/require-ai-key";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { decisionChatKey } from "@/features/chat/legal-document-chat-key";
import { useMountEffect } from "@/hooks/use-effect";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import type { SafeId } from "@/lib/safe-id";

type AuthenticatedCaseLawWorkspaceProps = {
  decision: ComponentProps<typeof DecisionWorkspace>["decision"];
  decisionId: SafeId<"caseLawDecision">;
  initialAnchorId?: string | undefined;
  initialSearchQuery?: string | undefined;
  user: AuthenticatedUser;
};

export const AuthenticatedCaseLawWorkspace = ({
  decision,
  decisionId,
  initialAnchorId,
  initialSearchQuery,
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
              initialSearchQuery={initialSearchQuery}
            />
          </div>
          {/* The law shell docks the inspector; the reader only seeds its tabs. */}
          <AutoOpenDecisionChat decisionId={decisionId} key={decisionId} />
        </ChatEditorProvider>
      </AIAvailabilityProvider>
    </ChatMentionProviders>
  </AuthenticatedUserProvider>
);

const AuthenticatedDecisionWorkspace = ({
  decision,
  decisionId,
  initialAnchorId,
  initialSearchQuery,
}: Pick<
  AuthenticatedCaseLawWorkspaceProps,
  "decision" | "decisionId" | "initialAnchorId" | "initialSearchQuery"
>) => {
  const { ensureAIAvailable } = useAIKeyGate();

  return (
    <DecisionWorkspace
      aiMode="enabled"
      decision={decision}
      decisionId={decisionId}
      ensureAIAvailable={ensureAIAvailable}
      initialAnchorId={initialAnchorId}
      initialSearchQuery={initialSearchQuery}
    />
  );
};

const AutoOpenDecisionChat = ({
  decisionId,
}: {
  decisionId: SafeId<"caseLawDecision">;
}) => {
  const openChat = useInspectorTabsStore((state) => state.openChat);
  useMountEffect(() => {
    // The rail gets the decision's chat; the pane belongs to the reader, and
    // DecisionDetailsTab already settled it for this mount.
    openChat({
      activeLegalKey: decisionChatKey(decisionId),
      pane: INSPECTOR_PANE_INTENT.keep,
    });
  });
  return null;
};
