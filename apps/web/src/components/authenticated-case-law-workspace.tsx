import { Suspense } from "react";
import type { ComponentProps } from "react";

import { useTranslations } from "use-intl";

import {
  InspectorDock,
  resolveInspectorDockWidth,
  useInspectorPaneWidth,
} from "@stll/ui/inspector";
import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/toast";
import { useViewportWidth } from "@stll/ui/use-viewport-width";

import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { InspectorPanel } from "@/components/inspector/inspector-panel";
import { INSPECTOR_PANE_INTENT } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { inspectorPaneWidthStorageKey } from "@/components/inspector/pane-width-storage";
import {
  AIAvailabilityProvider,
  useAIKeyGate,
} from "@/components/require-ai-key";
import { useSidebarInlineSize } from "@/components/sidebar";
import { DecisionWorkspace } from "@/features/case-law/components/case-viewer/decision-workspace";
import { decisionChatKey } from "@/features/chat/legal-document-chat-key";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { LAW_END_DOCK_WIDTH_VAR } from "@/lib/law-end-dock";
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
          <CaseLawInspector decisionId={decisionId} />
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

const CaseLawInspector = ({
  decisionId,
}: {
  decisionId: SafeId<"caseLawDecision">;
}) => {
  const t = useTranslations();
  const tabs = useInspectorTabsStore((s) => s.tabs);
  const minimized = useInspectorTabsStore((s) => s.minimized);
  // The width policy is the shared inspector's, so the case reader's pane
  // drags, resizes from the keyboard and is remembered exactly as a matter's
  // does; this view only supplies the sidebar's inline size.
  const sidebarWidth = useSidebarInlineSize();
  const viewportWidth = useViewportWidth();
  const { resetWidth, resizeHandleProps, width } = useInspectorPaneWidth({
    sidebarWidth,
    storageKey: inspectorPaneWidthStorageKey("public-law"),
    viewportWidth,
  });

  const showPaneContent = tabs.length > 0 && !minimized;
  const dockWidth = resolveInspectorDockWidth({
    paneWidth: width,
    showPaneContent,
  });
  const widthPx = `${dockWidth}px`;

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
      {/* Mounted inside the content column, so its full-height pane crosses
          the shell's sticky top bar: the dock's own h-12 header owns the top
          row for its width, as in the workspace chrome. The bar pads its
          inline-end by LAW_END_DOCK_WIDTH_VAR so its actions are not
          covered. */}
      <InspectorDock
        mount="content"
        resizeHandleLabel={t("inspector.resizePane")}
        resizeHandleProps={resizeHandleProps}
        showPaneContent={showPaneContent}
        width={dockWidth}
        onResetWidth={resetWidth}
      >
        <Suspense fallback={null}>
          <InspectorPanel />
        </Suspense>
      </InspectorDock>
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
    // The rail gets the decision's chat; the pane belongs to the reader, and
    // DecisionDetailsTab already settled it for this mount.
    openChat({
      activeLegalKey: decisionChatKey(decisionId),
      pane: INSPECTOR_PANE_INTENT.keep,
    });
  });
  return null;
};
