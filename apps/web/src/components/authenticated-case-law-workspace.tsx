import { Suspense, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";

import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/components/toast";

import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { InspectorPanel } from "@/components/inspector/inspector-panel";
import { useInspectorStore } from "@/components/inspector/inspector-store";
import {
  AIAvailabilityProvider,
  useAIKeyGate,
} from "@/components/require-ai-key";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import type { SafeId } from "@/lib/safe-id";

type AuthenticatedCaseLawWorkspaceProps = {
  decision: ComponentProps<typeof DecisionWorkspace>["decision"];
  decisionId: SafeId<"caseLawDecision">;
  user: AuthenticatedUser;
};

const INSPECTOR_PANE_DEFAULT_WIDTH = 512;
const INSPECTOR_RAIL_WIDTH = 48;

export function AuthenticatedCaseLawWorkspace({
  decision,
  decisionId,
  user,
}: AuthenticatedCaseLawWorkspaceProps) {
  return (
    <AuthenticatedUserProvider user={user}>
      <ChatMentionProviders>
        <AIAvailabilityProvider>
          <ChatEditorProvider>
            <AuthenticatedDecisionWorkspace
              decision={decision}
              decisionId={decisionId}
            />
            <CaseLawInspector decisionId={decisionId} />
          </ChatEditorProvider>
        </AIAvailabilityProvider>
      </ChatMentionProviders>
    </AuthenticatedUserProvider>
  );
}

function AuthenticatedDecisionWorkspace({
  decision,
  decisionId,
}: Pick<AuthenticatedCaseLawWorkspaceProps, "decision" | "decisionId">) {
  const { ensureAIAvailable } = useAIKeyGate();

  return (
    <DecisionWorkspace
      aiMode="enabled"
      decision={decision}
      decisionId={decisionId}
      ensureAIAvailable={ensureAIAvailable}
    />
  );
}

function CaseLawInspector({
  decisionId,
}: {
  decisionId: SafeId<"caseLawDecision">;
}) {
  const tabs = useInspectorStore((s) => s.tabs);
  const minimized = useInspectorStore((s) => s.minimized);
  const openChat = useInspectorStore((s) => s.openChat);
  const [width, setWidth] = useState(INSPECTOR_PANE_DEFAULT_WIDTH);
  const isDragging = useRef(false);
  const lastAutoOpenedDecisionRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastAutoOpenedDecisionRef.current === decisionId) {
      return;
    }
    lastAutoOpenedDecisionRef.current = decisionId;
    openChat({ activeDecisionId: decisionId });
  }, [decisionId, openChat]);

  const showPaneContent = tabs.length > 0 && !minimized;
  const widthPx = `${showPaneContent ? width : INSPECTOR_RAIL_WIDTH}px`;

  useEffect(() => {
    document.documentElement.style.setProperty(TOAST_RIGHT_OFFSET_VAR, widthPx);
    document.documentElement.style.setProperty(
      "--folio-find-replace-right",
      widthPx,
    );

    return () => {
      document.documentElement.style.removeProperty(TOAST_RIGHT_OFFSET_VAR);
      document.documentElement.style.removeProperty(
        "--folio-find-replace-right",
      );
    };
  }, [widthPx]);

  return (
    <div
      className="text-sidebar-foreground hidden md:block"
      data-side="right"
      data-state={showPaneContent ? "expanded" : "collapsed"}
    >
      <div className="bg-sidebar relative" style={{ width: widthPx }} />
      <div
        className="fixed inset-y-0 end-0 z-10 hidden h-svh md:flex"
        style={{ width: widthPx }}
      >
        {showPaneContent && (
          <div
            className="hover:bg-border active:bg-border absolute inset-y-0 -start-px z-20 flex w-1 cursor-col-resize items-center justify-center border-s"
            onPointerDown={(event) => {
              event.preventDefault();
              isDragging.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!isDragging.current) {
                return;
              }
              const nextWidth = globalThis.innerWidth - event.clientX;
              setWidth(Math.min(800, Math.max(320, nextWidth)));
            }}
            onPointerUp={() => {
              isDragging.current = false;
            }}
          />
        )}
        <div className="bg-sidebar flex h-full w-full flex-col">
          <Suspense fallback={null}>
            <InspectorPanel />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
