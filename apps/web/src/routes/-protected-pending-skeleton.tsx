import { useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import type { RouteComponent } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  HelpCircleIcon,
  NewChatIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from "@stll/ui/icons";
import {
  resolveInspectorPaneWidth,
  shouldForceSidebarCollapsed,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
} from "@stll/ui/inspector";
import { Skeleton } from "@stll/ui/skeleton";
import { StellaWordmarkLatin } from "@stll/ui/stella-wordmark";
import { TruncatedText } from "@stll/ui/truncated-text";
import { useViewportWidth } from "@stll/ui/use-viewport-width";
import { cn } from "@stll/ui/utils";

import {
  countStoredInspectorTabs,
  isPersistedInspectorPaneOpen,
} from "@/components/inspector/inspector-storage-keys";
import type { InspectorStorageScope } from "@/components/inspector/inspector-storage-keys";
import { ProtectedPendingInspectorScopeContext } from "@/components/inspector/protected-pending-inspector-scope";
import type { RouteInspectorEntry } from "@/components/inspector/route-inspector-entry";
import { useIntlMounted } from "@/components/pending-text";
import {
  SIDEBAR_WIDTH_ICON_PX,
  SIDEBAR_WIDTH_PX,
} from "@/components/sidebar-sizing";
import { StellaWordmarkArabic } from "@/components/stella-wordmark";
import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";
import { usePublicShellInboxEntryEnabled } from "@/hooks/use-inbox-preview";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { isPublicLawEnabled } from "@/lib/public-law-launch";
import {
  rememberedTimeBillingAccess,
  rememberedTimeBillingAccessHint,
} from "@/lib/workspaces/time-billing-access-memory";

type PrimaryNavItem = ReturnType<typeof getWorkspacePrimaryNavItems>[number];

const neverChanges = () => () => undefined;

/**
 * The primary entries the real sidebar's first paint shows, from the same
 * list and the same inputs, so the nav keeps its length when the sidebar
 * replaces the frame. What the build decides (case law, Knowledge, the inbox
 * when the deployment ships it) is read as it is: the server and the client
 * read the same build, so even the server's paint has those entries. What
 * this browser keeps is read once the page can read it, never during
 * hydration (the server has no browser storage): the inbox preview switch,
 * and the member's last time billing answer, which the sidebar also shows
 * until the server answers again (for the member's organization once the
 * frame knows it, before that whichever one this browser kept).
 */
const usePendingNavItems = (
  inspectorScope: InspectorStorageScope | undefined,
): readonly PrimaryNavItem[] => {
  const includeInbox = usePublicShellInboxEntryEnabled();
  const includeTimesheets = useSyncExternalStore(
    neverChanges,
    () =>
      inspectorScope === undefined
        ? rememberedTimeBillingAccessHint()
        : rememberedTimeBillingAccess(inspectorScope.organizationId),
    () => false,
  );
  return getWorkspacePrimaryNavItems({
    includeInbox,
    includePublicLaw: isPublicLawEnabled(),
    // The app sidebar never lists the public tools catalogue.
    includePublicTools: false,
    includeTimesheets,
    publicKnowledge: isPublicKnowledgeEnabled(),
  });
};
const PINNED_ROW_KEYS = ["a", "b", "c"] as const;

// Static, SSR-safe placeholder for the client-only `_protected` subtree.
// Chrome that needs no data renders for real (the logo, the primary nav
// icons, the rail toggles), so the frame is already the app; only what
// depends on data shimmers: pinned matters, the account card, the breadcrumb
// and the page body. Cookie preferences and the request locale already exist
// during SSR, so the pending frame uses the same geometry and nav labels. It
// also tracks the viewport and the saved inspector tabs, so it resizes with
// the frame it stands in for. `body` is the leaf route's own pending view
// (`useLeafPendingView`), so the page that loads replaces placeholders
// already sitting where its content will; a route without one gets the
// generic column.
export function ProtectedPendingSkeleton({
  body,
  content,
  inspectorOnEntry,
  inspectorScope,
}: {
  body?: RouteComponent | undefined;
  content?: ReactElement | undefined;
  /** What the leaf route's page does with the inspector when it mounts. */
  inspectorOnEntry?: RouteInspectorEntry | undefined;
  inspectorScope?: InspectorStorageScope;
}) {
  if (inspectorScope !== undefined) {
    return (
      <ProtectedPendingSkeletonContent
        body={body}
        content={content}
        inspectorOnEntry={inspectorOnEntry}
        inspectorScope={inspectorScope}
      />
    );
  }
  return (
    <ProtectedPendingInspectorScopeContext.Consumer>
      {(contextScope) => (
        <ProtectedPendingSkeletonContent
          body={body}
          content={content}
          inspectorOnEntry={inspectorOnEntry}
          inspectorScope={contextScope}
        />
      )}
    </ProtectedPendingInspectorScopeContext.Consumer>
  );
}

function PendingPageBody({ body: Body }: { body: RouteComponent | undefined }) {
  if (Body === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  // Inert: the page's own pending tree may hold its real links and headings,
  // and nothing in a placeholder frame takes focus or a click.
  return (
    <div className="flex min-h-0 flex-1 flex-col" inert>
      <Body />
    </div>
  );
}

const NavItemLabel = ({
  labelKey,
}: {
  labelKey: PrimaryNavItem["labelKey"];
}) => {
  const t = useTranslations();
  return t(labelKey);
};

function NavItemText({
  intlMounted,
  labelKey,
  sidebarOpen,
}: {
  intlMounted: boolean;
  labelKey: PrimaryNavItem["labelKey"];
  sidebarOpen: boolean;
}) {
  if (!intlMounted) {
    // Painted before the app's intl (the server's cold-load frame): the
    // label's line, its text arriving with intl.
    return sidebarOpen ? <Skeleton className="h-3 w-20" /> : null;
  }
  if (sidebarOpen) {
    return (
      <TruncatedText className="text-sm" hint={false}>
        <NavItemLabel labelKey={labelKey} />
      </TruncatedText>
    );
  }
  return (
    <span className="sr-only">
      <NavItemLabel labelKey={labelKey} />
    </span>
  );
}

function ProtectedPendingSkeletonContent({
  body,
  content,
  inspectorOnEntry,
  inspectorScope,
}: {
  body: RouteComponent | undefined;
  content: ReactElement | undefined;
  inspectorOnEntry: RouteInspectorEntry | undefined;
  inspectorScope: InspectorStorageScope | undefined;
}) {
  const intlMounted = useIntlMounted();
  const navItems = usePendingNavItems(inspectorScope);
  const { prefs } = usePresentationPrefs();
  const viewportWidth = useViewportWidth();
  // A page that opens its own tab on entry has the pane open once it is
  // there, which the server's paint knows from the address alone. Otherwise
  // the restore policy the authenticated frame applies, on the stored tabs:
  // the member's tab registry loads with that frame, and the store writes
  // only tabs it would restore.
  const paneRequested =
    inspectorOnEntry === "opens-page-tab" ||
    (inspectorScope !== undefined &&
      isPersistedInspectorPaneOpen(inspectorScope, countStoredInspectorTabs));
  const sidebarOpen =
    prefs.sidebarOpen &&
    !shouldForceSidebarCollapsed({
      expandedSidebarWidth: SIDEBAR_WIDTH_PX,
      inspectorPaneOpen: paneRequested,
      viewportWidth,
    });
  const paneWidth = paneRequested
    ? resolveInspectorPaneWidth({
        desiredWidth: prefs.inspectorWidth,
        sidebarWidth: sidebarOpen ? SIDEBAR_WIDTH_PX : SIDEBAR_WIDTH_ICON_PX,
        viewportWidth,
      })
    : undefined;
  return (
    <div
      aria-hidden={content === undefined ? "true" : undefined}
      className="bg-background flex h-full min-h-dvh"
    >
      {/* Sidebar column: AppSidebar's 16rem width, logo header, primary nav,
          pinned matters, help, account. */}
      <div
        className="bg-sidebar hidden shrink-0 flex-col overflow-hidden border-e md:flex"
        data-slot="pending-sidebar"
        data-state={sidebarOpen ? "expanded" : "collapsed"}
        style={{
          width: sidebarOpen ? SIDEBAR_WIDTH_PX : SIDEBAR_WIDTH_ICON_PX,
        }}
      >
        <div
          className={cn(
            "flex shrink-0 items-center border-b",
            sidebarOpen ? "justify-between ps-3 pe-2" : "justify-center",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          {sidebarOpen ? (
            <>
              <StellaWordmarkLatin className="h-5 w-auto rtl:hidden" />
              <StellaWordmarkArabic className="hidden h-5 w-auto rtl:block" />
            </>
          ) : null}
          <span
            className={cn(
              "text-muted-foreground grid place-items-center",
              SIDE_RAIL_ICON_BUTTON_SIZE,
            )}
          >
            <PanelLeftIcon className="size-4" />
          </span>
        </div>
        <div className="flex flex-col gap-1 p-2">
          {navItems.map((item) => (
            <div
              className="flex h-8 items-center gap-2 px-2"
              data-nav-item={item.id}
              key={item.id}
            >
              <item.icon className="text-muted-foreground size-4 shrink-0" />
              <NavItemText
                intlMounted={intlMounted}
                labelKey={item.labelKey}
                sidebarOpen={sidebarOpen}
              />
            </div>
          ))}
        </div>
        {sidebarOpen && (
          <div className="flex flex-col gap-1 border-t p-2">
            {PINNED_ROW_KEYS.map((key) => (
              <div className="flex h-9 items-center gap-2 px-2" key={key}>
                <Skeleton className="size-4 rounded-sm" />
                <div className="flex flex-1 flex-col gap-1">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-2 w-20" />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex-1" />
        <div className="flex flex-col gap-1 p-2">
          <div className="flex h-8 items-center gap-2 px-2">
            <HelpCircleIcon className="text-muted-foreground size-4 shrink-0" />
            {sidebarOpen && <Skeleton className="h-3 w-24" />}
          </div>
          <div className="flex h-12 items-center gap-2 px-2">
            <Skeleton className="size-8 rounded-full" />
            {sidebarOpen && (
              <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2 w-28" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main content column: header bar (breadcrumb) + page body. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 border-b px-4",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className="h-4 w-40" />
        </div>
        {content === undefined ? (
          <PendingPageBody body={body} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{content}</div>
        )}
      </div>

      {/* Reserve the member's pane while its code and tabs load. */}
      <div
        className={cn(
          "bg-muted/50 text-muted-foreground hidden shrink-0 flex-col border-s md:flex",
          SIDE_RAIL_WIDTH,
        )}
        data-slot="inspector-pending-dock"
        style={paneWidth === undefined ? undefined : { width: paneWidth }}
      >
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-b",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <DirectionalIcon className="size-4" icon={PanelRightIcon} />
        </div>
        <div className="flex-1" />
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-t",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <NewChatIcon className="size-4" />
        </div>
      </div>
    </div>
  );
}
