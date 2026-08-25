import { lazy, Suspense } from "react";

import { useRouterState } from "@tanstack/react-router";
import { PanelRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { InspectorRailTab } from "@stll/ui/inspector";
import { cn } from "@stll/ui/utils";

import {
  isGenericInspectorTab,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import { getInspectorView } from "@/components/inspector/view-registry";
import {
  PublicInspectorDock,
  PublicInspectorRail,
} from "@/components/public-inspector-rail";
import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import Tooltip from "@/components/tooltip";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  SIDE_RAIL_CONTAINER_CLASS,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";

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
 */
export const PublicLawInspector = () => {
  const user = useMaybeAuthenticatedUser();
  const requestSignIn = usePublicSignInRequest();
  const tabs = useInspectorTabsStore((state) => state.tabs);
  const minimized = useInspectorTabsStore((state) => state.minimized);
  // The case reader docks its own inspector, chat providers included. Two
  // docks would sit on top of each other, so the shell yields there.
  const caseReaderOwnsDock = useRouterState({
    select: (state) =>
      state.matches.some((match) =>
        match.routeId.startsWith("/law/$country/cases/"),
      ),
  });

  if (user !== null) {
    if (caseReaderOwnsDock || tabs.length === 0) {
      return null;
    }

    return (
      <PublicInspectorDock expanded={!minimized}>
        <Suspense fallback={null}>
          <LazySessionInspector />
        </Suspense>
      </PublicInspectorDock>
    );
  }

  const viewTabs = tabs.filter(isGenericInspectorTab);

  if (viewTabs.length === 0) {
    // `requestSignIn` is provided by the public shell this dock renders in;
    // without it the rail's affordances would lead nowhere.
    return requestSignIn === null ? null : (
      <PublicInspectorRail requestSignIn={requestSignIn} />
    );
  }

  return <AnonymousViewDock tabs={viewTabs} />;
};

type GenericTab = Extract<InspectorTab, { type: "view" }>;

/**
 * What a reader without a session gets: the registry views themselves, on the
 * same geometry as the workspace inspector. No chat, no file tabs — the kinds
 * an account owns are never opened from here.
 */
const AnonymousViewDock = ({ tabs }: { tabs: readonly GenericTab[] }) => {
  const t = useTranslations();
  const activeId = useInspectorTabsStore((state) => state.activeId);
  const minimized = useInspectorTabsStore((state) => state.minimized);
  const setActive = useInspectorTabsStore((state) => state.setActive);
  const setMinimized = useInspectorTabsStore((state) => state.setMinimized);
  const closeTab = useInspectorTabsStore((state) => state.closeTab);

  // A tab may have been closed in a peer browser tab between renders, so the
  // active id is not assumed to name one of these.
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const expanded = !minimized && active !== undefined;

  return (
    <PublicInspectorDock expanded={expanded}>
      <div className="bg-background flex h-full shadow-lg">
        <div className={SIDE_RAIL_CONTAINER_CLASS}>
          <div
            className={cn(
              "flex w-full shrink-0 items-center justify-center border-b",
              TOOLBAR_ROW_HEIGHT,
            )}
          >
            <Tooltip
              content={
                minimized ? t("inspector.showPane") : t("inspector.hidePane")
              }
              render={
                <button
                  aria-label={
                    minimized
                      ? t("inspector.showPane")
                      : t("inspector.hidePane")
                  }
                  className={cn(
                    "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center rounded-md transition-colors",
                    SIDE_RAIL_ICON_BUTTON_SIZE,
                  )}
                  onClick={() => setMinimized(!minimized)}
                  type="button"
                />
              }
            >
              <PanelRightIcon className="size-4" />
            </Tooltip>
          </div>
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
        </div>
        {expanded && (
          <RegisteredView onClose={() => closeTab(active.id)} tab={active} />
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
