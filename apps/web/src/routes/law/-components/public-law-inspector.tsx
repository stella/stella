import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { PanelRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { InspectorRailIconButton, InspectorRailTab } from "@stll/ui/inspector";
import { WorkspaceEndRail } from "@stll/ui/workspace-shell";
import type { WorkspaceEndRailChatAction } from "@stll/ui/workspace-shell";

import { useMainLegalDocument } from "@/components/ai-suggestions/use-main-legal-document";
import { useRequireAccount } from "@/components/auth/use-require-account";
import { railChatOpenArgs } from "@/components/inspector/inspector-rail-chat.logic";
import {
  isGenericInspectorTab,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import { getInspectorView } from "@/components/inspector/view-registry";
import { PublicInspectorDock } from "@/components/public-inspector-rail";
import Tooltip from "@/components/tooltip";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";

// The full inspector pulls the chat stack in with it. Only a reader with a
// session can reach any of it, so it stays out of this shell's own chunk.
const LazySessionInspector = lazy(async () => {
  const module = await import("@/components/public-session-inspector");
  return { default: module.PublicSessionInspector };
});

/**
 * The inspector for the public law surface. A reader with a session gets the
 * workspace inspector, so a tab opened here behaves the way it does anywhere
 * else in the product; without one the dock renders the views the reader
 * opened and routes every account affordance to sign-in.
 *
 * The rail is always there, with or without a tab and on every law route: a
 * reader who has opened nothing yet can still see that a panel exists and
 * open it, which is what a matter's own inspector does. This is the only dock
 * on the surface; a reader seeds tabs into the store and never docks its own.
 */
export const PublicLawInspector = () => {
  const user = useMaybeAuthenticatedUser();
  const tabs = useInspectorTabsStore((state) => state.tabs);
  const minimized = useInspectorTabsStore((state) => state.minimized);

  if (user === null) {
    return <AnonymousViewDock tabs={tabs.filter(isGenericInspectorTab)} />;
  }

  return (
    // The pane widens only for a tab; with none the rail stands alone and
    // the inspector draws its own empty state behind the toggle.
    <PublicInspectorDock expanded={!minimized && tabs.length > 0}>
      {/*
        The fallback is the rail, never nothing: the toggle is the only way
        into the pane, and a dock that drops it while the inspector's chunk
        (or anything it opens) loads leaves the reader with a blank column.
      */}
      <Suspense fallback={<SessionRailPlaceholder />}>
        <LazySessionInspector />
      </Suspense>
    </PublicInspectorDock>
  );
};

type GenericTab = Extract<InspectorTab, { type: "view" }>;

type PublicLawRailProps = {
  chatAction: WorkspaceEndRailChatAction;
  /** The tabs the dock draws, if it has any of its own to draw. */
  children?: ReactNode;
  minimized: boolean;
  onToggle: () => void;
};

/**
 * The rail every public law dock stands on: one definition, so the toggle
 * reads and behaves the same whether the pane behind it is the workspace
 * inspector, the registry views, or still loading.
 */
const PublicLawRail = ({
  chatAction,
  children,
  minimized,
  onToggle,
}: PublicLawRailProps) => {
  const t = useTranslations();
  const toggleLabel = minimized
    ? t("inspector.showPane")
    : t("inspector.hidePane");

  return (
    <WorkspaceEndRail
      chatAction={chatAction}
      className="h-full"
      label={t("inspector.title")}
      topAction={
        <Tooltip
          content={toggleLabel}
          render={
            <InspectorRailIconButton
              aria-label={toggleLabel}
              onClick={onToggle}
            />
          }
        >
          <PanelRightIcon className="size-4" />
        </Tooltip>
      }
    >
      {children}
    </WorkspaceEndRail>
  );
};

/**
 * What stands in for the workspace inspector while its chunk loads. Both of
 * its affordances are the tab store's, which needs none of that chunk, so the
 * reader can fold the pane or start a chat before it arrives; the tabs are the
 * inspector's own to draw, and it draws them a frame later.
 */
const SessionRailPlaceholder = () => {
  const t = useTranslations();
  const minimized = useInspectorTabsStore((state) => state.minimized);
  const setMinimized = useInspectorTabsStore((state) => state.setMinimized);
  const openChat = useInspectorTabsStore((state) => state.openChat);
  const legalDocument = useMainLegalDocument();

  return (
    <div className="bg-background flex h-full shadow-lg">
      <PublicLawRail
        chatAction={{
          label: t("chat.newChat"),
          onActivate: () => {
            openChat(railChatOpenArgs({ legalDocument }));
          },
          status: "enabled",
        }}
        minimized={minimized}
        onToggle={() => setMinimized(!minimized)}
      />
    </div>
  );
};

/**
 * What a reader without a session gets: the registry views themselves, on the
 * same geometry as the workspace inspector, and the same chat affordance on
 * the rail. The chat opens the account gate rather than a thread; the tab
 * kinds an account owns are still never drawn from here.
 */
const AnonymousViewDock = ({ tabs }: { tabs: readonly GenericTab[] }) => {
  const t = useTranslations();
  const activeId = useInspectorTabsStore((state) => state.activeId);
  const minimized = useInspectorTabsStore((state) => state.minimized);
  const setActive = useInspectorTabsStore((state) => state.setActive);
  const setMinimized = useInspectorTabsStore((state) => state.setMinimized);
  const closeTab = useInspectorTabsStore((state) => state.closeTab);
  const ensureAccount = useRequireAccount();

  // A tab may have been closed in a peer browser tab between renders, so the
  // active id is not assumed to name one of these.
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const expanded = !minimized && active !== undefined;

  return (
    <PublicInspectorDock expanded={expanded}>
      <div className="bg-background flex h-full shadow-lg">
        <PublicLawRail
          chatAction={{
            label: t("inspector.openChat"),
            // The gate returns false for every visitor who reaches this dock,
            // which is the point: the chat is offered, and the account is
            // asked for here rather than by hiding the affordance.
            onActivate: () => {
              ensureAccount();
            },
            status: "enabled",
          }}
          minimized={minimized}
          onToggle={() => setMinimized(!minimized)}
        >
          <div className="flex flex-col">
            {tabs.map((tab) => (
              <RailTabButton
                active={tab.id === active?.id && !minimized}
                key={tab.id}
                onActivate={() => {
                  setActive(tab.id);
                  setMinimized(false);
                }}
                tab={tab}
              />
            ))}
          </div>
        </PublicLawRail>
        {/*
          The view's own chunk may still be loading; the rail above is outside
          this boundary, so the toggle stays whatever the pane is doing.
        */}
        {expanded && (
          <Suspense fallback={<div className="bg-background flex-1" />}>
            <RegisteredView onClose={() => closeTab(active.id)} tab={active} />
          </Suspense>
        )}
      </div>
    </PublicInspectorDock>
  );
};

type RailTabButtonProps = {
  active: boolean;
  onActivate: () => void;
  tab: GenericTab;
};

const RailTabButton = ({ active, onActivate, tab }: RailTabButtonProps) => {
  const registration = getInspectorView(tab.viewType);

  if (registration === undefined) {
    return null;
  }

  const RailIcon = registration.railIcon;

  return (
    <Tooltip
      content={tab.label}
      render={
        <InspectorRailTab
          active={active}
          aria-label={tab.label}
          onClick={onActivate}
        />
      }
    >
      <RailIcon active={active} tab={tab} />
    </Tooltip>
  );
};

type RegisteredViewProps = {
  onClose: () => void;
  tab: GenericTab;
};

/**
 * Mounts the registered renderer as a component, not as a call, so the view
 * owns its own hooks and re-render queue. Nothing renders while the chunk
 * carrying the registration is still loading.
 */
const RegisteredView = ({ onClose, tab }: RegisteredViewProps) => {
  const registration = getInspectorView(tab.viewType);

  if (registration === undefined) {
    return null;
  }

  const Renderer = registration.render;

  return (
    <Renderer
      onClose={onClose}
      tab={{
        id: tab.id,
        label: tab.label,
        ownerRouteId: tab.ownerRouteId,
        payload: tab.payload,
      }}
    />
  );
};
