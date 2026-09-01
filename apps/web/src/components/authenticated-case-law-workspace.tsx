import { Suspense, useRef, useState } from "react";
import type { ComponentProps } from "react";

import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/toast";

import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { InspectorPanel } from "@/components/inspector/inspector-panel";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  AIAvailabilityProvider,
  useAIKeyGate,
} from "@/components/require-ai-key";
import { useDecisionAnnotations } from "@/features/case-law/annotations/use-decision-annotations";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { LAW_END_DOCK_WIDTH_VAR } from "@/lib/law-end-dock";
import type { SafeId } from "@/lib/safe-id";

type AuthenticatedCaseLawWorkspaceProps = {
  decision: ComponentProps<typeof DecisionWorkspace>["decision"];
  decisionId: SafeId<"caseLawDecision">;
  initialSearchQuery?: string | undefined;
  user: AuthenticatedUser;
};

const INSPECTOR_PANE_DEFAULT_WIDTH = 512;
const INSPECTOR_RAIL_WIDTH = 48;

export const AuthenticatedCaseLawWorkspace = ({
  decision,
  decisionId,
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
              initialSearchQuery={initialSearchQuery}
            />
          </div>
          <CaseLawInspector decisionId={decisionId} />
        </ChatEditorProvider>
      </AIAvailabilityProvider>
    </ChatMentionProviders>
  </AuthenticatedUserProvider>
);

const AuthenticatedDecisionWorkspace = ({
  decision,
  decisionId,
  initialSearchQuery,
}: Pick<
  AuthenticatedCaseLawWorkspaceProps,
  "decision" | "decisionId" | "initialSearchQuery"
>) => {
  const { ensureAIAvailable } = useAIKeyGate();
  const { annotations, create, remove, update } =
    useDecisionAnnotations(decisionId);

  return (
    <DecisionWorkspace
      aiMode="enabled"
      annotations={{
        annotations,
        controller: {
          create: create.mutateAsync,
          remove: remove.mutateAsync,
          update: update.mutateAsync,
        },
      }}
      decision={decision}
      decisionId={decisionId}
      ensureAIAvailable={ensureAIAvailable}
      initialSearchQuery={initialSearchQuery}
    />
  );
};

const CaseLawInspector = ({
  decisionId,
}: {
  decisionId: SafeId<"caseLawDecision">;
}) => {
  const tabs = useInspectorTabsStore((s) => s.tabs);
  const minimized = useInspectorTabsStore((s) => s.minimized);
  const [width, setWidth] = useState(INSPECTOR_PANE_DEFAULT_WIDTH);
  const isDragging = useRef(false);

  const showPaneContent = tabs.length > 0 && !minimized;
  const widthPx = `${showPaneContent ? width : INSPECTOR_RAIL_WIDTH}px`;

  useExternalSyncEffect(() => {
    document.documentElement.style.setProperty(TOAST_RIGHT_OFFSET_VAR, widthPx);
    document.documentElement.style.setProperty(
      "--folio-find-replace-right",
      widthPx,
    );
    // The law shell's top bar spans the full window; it pads its inline-end
    // by this width so its actions stay visible beside the dock.
    document.documentElement.style.setProperty(LAW_END_DOCK_WIDTH_VAR, widthPx);

    return () => {
      document.documentElement.style.removeProperty(TOAST_RIGHT_OFFSET_VAR);
      document.documentElement.style.removeProperty(
        "--folio-find-replace-right",
      );
      document.documentElement.style.removeProperty(LAW_END_DOCK_WIDTH_VAR);
    };
  }, [widthPx]);

  return (
    <>
      <AutoOpenDecisionChat decisionId={decisionId} key={decisionId} />
      <div
        className="text-sidebar-foreground hidden md:block"
        data-side="right"
        data-state={showPaneContent ? "expanded" : "collapsed"}
      >
        <div className="bg-sidebar relative" style={{ width: widthPx }} />
        {/* Full-height, above the shell top bar (sticky z-20): the dock's own
            h-12 header owns the top row for its width, as in the workspace
            chrome. The bar pads its inline-end by LAW_END_DOCK_WIDTH_VAR so
            its actions are not covered. */}
        <div
          className="fixed inset-y-0 end-0 z-30 hidden h-svh md:flex"
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
    </>
  );
};

const AutoOpenDecisionChat = ({
  decisionId,
}: {
  decisionId: SafeId<"caseLawDecision">;
}) => {
  const openChat = useInspectorTabsStore((state) => state.openChat);
  useMountEffect(() => {
    openChat({ activeDecisionId: decisionId });
  });
  return null;
};
