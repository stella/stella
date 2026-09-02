"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";

import { PanelLeftIcon } from "lucide-react";

import {
  ApplicationRail,
  ApplicationRailButton,
  ApplicationRailContent,
  ApplicationRailFooter,
  ApplicationRailHeader,
  ApplicationRailMenu,
} from "@stll/ui/application-rail";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  InspectorDock,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  TOOLBAR_ROW_HEIGHT,
} from "@stll/ui/inspector";
import { Sheet, SheetPopup, SheetTitle } from "@stll/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@stll/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";
import { WorkspaceEndRail, WorkspaceShell } from "@stll/ui/workspace-shell";

import { resolveWorkspaceInspectorPresentation } from "./workspace-frame.logic";

export type WorkspaceFrameNavigationItem = {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onActivate: () => void;
};

/**
 * Renders the described navigation through the sidebar shell from
 * `@stll/ui/sidebar` instead of the fixed application rail: the same
 * collapsible sidebar Stella's own app mounts, so a host gets the header
 * toggle, the labelled menu while expanded, and the tooltips while collapsed
 * without composing the shell itself.
 */
export type WorkspaceFrameSidebarNavigation = {
  /** Shown at the start of the header row while the sidebar is expanded,
   * typically a wordmark. The collapse toggle sits at its end. */
  brand?: ReactNode;
  /** Accessible names for the header toggle in each state. */
  toggleLabel: {
    collapse: string;
    expand: string;
  };
  /** Controlled open state, for a host that persists it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  /** Keeps the sidebar collapsed regardless of the requested state, e.g.
   * while an inspector pane needs the width. */
  forceCollapsed?: boolean;
};

export type WorkspaceFrameNavigation = {
  label: string;
  items: readonly WorkspaceFrameNavigationItem[];
  /** Rail-only: the application rail's header slot. The sidebar
   * presentation owns its header (brand and toggle) and ignores this. */
  header?: ReactNode;
  footer?: ReactNode;
  compact: {
    content: ReactElement;
    label: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trigger: ReactElement | null;
  };
  sidebar?: WorkspaceFrameSidebarNavigation;
};

export type WorkspaceFrameInspector = {
  pane: ReactNode;
  showPaneContent: boolean;
  width: number;
  resizeHandleLabel: string;
  resizeHandleProps: ComponentProps<typeof InspectorDock>["resizeHandleProps"];
  onResetWidth?: (() => void) | undefined;
  mobile?: {
    content: ReactElement;
    label: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
};

export type WorkspaceFrameEndRail = {
  label: string;
  topAction: ReactNode;
  chatAction: ComponentProps<typeof WorkspaceEndRail>["chatAction"];
  children?: ReactNode;
  overlay?: ReactNode;
};

export type WorkspaceFrameProps = {
  children: ReactNode;
} & (
  | {
      composition: "described";
      navigation: WorkspaceFrameNavigation;
      topBar: WorkspaceFrameTopBar;
      endRail: WorkspaceFrameEndRail;
      inspector?: WorkspaceFrameInspector;
    }
  | {
      composition: "host-responsive";
      navigation: ComponentProps<typeof WorkspaceShell>["navigation"];
      topBar: ComponentProps<typeof WorkspaceShell>["topBar"];
      endDock: ReactElement;
    }
);

export type WorkspaceFrameTopBar = {
  leading?: ReactNode;
  center?: ReactNode;
  actions?: ReactNode;
};

type DescribedWorkspaceFrameProps = Extract<
  WorkspaceFrameProps,
  { composition: "described" }
>;

/**
 * Stella's complete workspace frame. Hosts provide route descriptors and
 * actions; this component owns the shell, application rail, end rail, and
 * desktop inspector footprint.
 *
 * The two compositions mount different navigation primitives. `described`
 * renders `navigation.items` through the narrower `ApplicationRail` from
 * `@stll/ui/application-rail` — a fixed-width, always-collapsed rail with no
 * expand/collapse state of its own — or, with `navigation.sidebar`, through
 * the collapsible sidebar shell from `@stll/ui/sidebar`. `host-responsive`
 * passes `navigation` straight through to `WorkspaceShell` and takes no
 * position on what fills it; a host that composes its own sidebar content
 * mounts the shell from `@stll/ui/sidebar` there, as this app's `AppSidebar`
 * does.
 */
export const WorkspaceFrame = (props: WorkspaceFrameProps) => {
  if (props.composition === "host-responsive") {
    return (
      <WorkspaceShell
        endDock={props.endDock}
        navigation={props.navigation}
        topBar={props.topBar}
      >
        {props.children}
      </WorkspaceShell>
    );
  }

  return <DescribedWorkspaceFrame {...props} />;
};

const DescribedWorkspaceFrame = ({
  children,
  endRail,
  inspector,
  navigation,
  topBar,
}: DescribedWorkspaceFrameProps) => {
  const isCompact = useIsMobile();
  const inspectorPresentation = resolveWorkspaceInspectorPresentation({
    hasMobilePresentation: inspector?.mobile !== undefined,
    isCompact,
  });
  const desktopNavigation =
    navigation.sidebar === undefined ? (
      <DescribedApplicationRail navigation={navigation} />
    ) : (
      <DescribedSidebar navigation={navigation} sidebar={navigation.sidebar} />
    );

  const endDock =
    inspector && inspectorPresentation === "desktop" ? (
      <InspectorDock
        rail={<WorkspaceEndRail {...endRail} />}
        resizeHandleLabel={inspector.resizeHandleLabel}
        resizeHandleProps={inspector.resizeHandleProps}
        showPaneContent={inspector.showPaneContent}
        width={inspector.width}
        onResetWidth={inspector.onResetWidth}
      >
        {inspector.pane}
      </InspectorDock>
    ) : (
      <WorkspaceEndRail {...endRail} />
    );

  const shell = (
    <WorkspaceShell
      endDock={endDock}
      navigation={{
        compact: navigation.compact,
        desktop: desktopNavigation,
        mode: "shell-managed",
      }}
      topBar={({ compactNavigationTrigger }) => (
        <div
          className={cn(
            "flex min-w-0 items-center gap-2 overflow-hidden border-b px-4",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          {compactNavigationTrigger}
          <div className="min-w-0 flex-1">{topBar.leading}</div>
          <div className="min-w-0">{topBar.center}</div>
          <div className="ms-auto flex shrink-0 items-center gap-0.5">
            {topBar.actions}
          </div>
        </div>
      )}
    >
      {children}
    </WorkspaceShell>
  );

  const frame =
    navigation.sidebar === undefined ? (
      shell
    ) : (
      <SidebarProvider {...resolveSidebarProviderProps(navigation.sidebar)}>
        {shell}
      </SidebarProvider>
    );

  if (inspector?.mobile === undefined) {
    return frame;
  }

  return (
    <Sheet
      open={inspectorPresentation === "mobile" && inspector.mobile.open}
      onOpenChange={(open) => {
        if (inspectorPresentation === "mobile") {
          inspector.mobile?.onOpenChange(open);
        }
      }}
    >
      {frame}
      {inspectorPresentation === "mobile" ? (
        <SheetPopup
          className="h-dvh w-full max-w-none border-0 p-0"
          showCloseButton={false}
          side="inline-end"
        >
          <SheetTitle className="sr-only">{inspector.mobile.label}</SheetTitle>
          {inspector.mobile.content}
        </SheetPopup>
      ) : null}
    </Sheet>
  );
};

type SidebarProviderProps = ComponentProps<typeof SidebarProvider>;

/**
 * Only the sidebar options the host actually set reach the provider: an
 * explicit `undefined` would otherwise turn a controlled `open` into an
 * uncontrolled one, or clear the provider's own default.
 */
const resolveSidebarProviderProps = ({
  defaultOpen,
  forceCollapsed,
  open,
  onOpenChange,
}: WorkspaceFrameSidebarNavigation): SidebarProviderProps => ({
  ...(defaultOpen === undefined ? {} : { defaultOpen }),
  ...(forceCollapsed === undefined ? {} : { forceCollapsed }),
  ...(open === undefined ? {} : { open }),
  ...(onOpenChange === undefined ? {} : { onOpenChange }),
});

const DescribedApplicationRail = ({
  navigation,
}: {
  navigation: WorkspaceFrameNavigation;
}) => (
  <ApplicationRail aria-label={navigation.label}>
    <ApplicationRailHeader>{navigation.header}</ApplicationRailHeader>
    <ApplicationRailContent>
      <ApplicationRailMenu>
        {navigation.items.map((item) => (
          <ApplicationRailButton
            aria-current={item.active ? "page" : undefined}
            aria-label={item.label}
            data-active={item.active || undefined}
            disabled={item.disabled}
            key={item.id}
            title={item.label}
            className="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
            onClick={item.onActivate}
          >
            {item.icon}
          </ApplicationRailButton>
        ))}
      </ApplicationRailMenu>
    </ApplicationRailContent>
    <ApplicationRailFooter>{navigation.footer}</ApplicationRailFooter>
  </ApplicationRail>
);

/**
 * The described items as Stella's collapsible sidebar. The header is the
 * same row Stella's app shows: brand at the start while expanded, the
 * collapse toggle at the end, at toolbar-row height so it lines up with the
 * top bar beside it. Each item is a sidebar menu button, which shows its
 * label while expanded and a tooltip while collapsed.
 */
const DescribedSidebar = ({
  navigation,
  sidebar,
}: {
  navigation: WorkspaceFrameNavigation;
  sidebar: WorkspaceFrameSidebarNavigation;
}) => {
  const { isMobile, state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  const toggleLabel = collapsed
    ? sidebar.toggleLabel.expand
    : sidebar.toggleLabel.collapse;

  return (
    <Sidebar
      aria-label={navigation.label}
      collapsible="icon"
      mobileTitle={navigation.label}
    >
      <SidebarHeader className={cn("border-b p-0", TOOLBAR_ROW_HEIGHT)}>
        <div
          className={cn(
            "flex h-full items-center",
            collapsed ? "justify-center" : "justify-between ps-3 pe-2",
          )}
        >
          {collapsed ? null : sidebar.brand}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={toggleLabel}
                  className={cn(
                    "text-muted-foreground",
                    SIDE_RAIL_ICON_BUTTON_SIZE,
                  )}
                  data-slot="workspace-frame-sidebar-toggle"
                  size="icon"
                  variant="ghost"
                  onClick={toggleSidebar}
                >
                  {/* A drawer glyph on the sidebar's edge: mirrored under
                   * RTL, where the inline-start sidebar sits on the right. */}
                  <DirectionalIcon className="size-4" icon={PanelLeftIcon} />
                </Button>
              }
            />
            <TooltipPopup side="right">{toggleLabel}</TooltipPopup>
          </Tooltip>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {/* The items stay a navigation landmark, as they are on the rail;
         * the sidebar's own container is a plain region. */}
        <nav aria-label={navigation.label}>
          {/* Collapsed, the group's padding narrows so a 44px item fits the
           * 48px rail; expanded it keeps the sidebar's usual inset. */}
          <SidebarGroup className="group-data-[collapsible=icon]:px-0.5">
            <SidebarMenu>
              {navigation.items.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    aria-current={item.active ? "page" : undefined}
                    disabled={item.disabled}
                    isActive={item.active ?? false}
                    size="rail"
                    tooltip={item.label}
                    onClick={item.onActivate}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>{navigation.footer}</SidebarFooter>
    </Sidebar>
  );
};
