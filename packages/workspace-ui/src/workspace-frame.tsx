"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";

import {
  ApplicationRail,
  ApplicationRailButton,
  ApplicationRailContent,
  ApplicationRailFooter,
  ApplicationRailHeader,
  ApplicationRailMenu,
} from "@stll/ui/application-rail";
import { InspectorDock, TOOLBAR_ROW_HEIGHT } from "@stll/ui/inspector";
import { Sheet, SheetPopup, SheetTitle } from "@stll/ui/sheet";
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

export type WorkspaceFrameNavigation = {
  label: string;
  items: readonly WorkspaceFrameNavigationItem[];
  header?: ReactNode;
  footer?: ReactNode;
  compact: {
    content: ReactElement;
    label: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trigger: ReactElement | null;
  };
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

/**
 * Stella's complete workspace frame. Hosts provide route descriptors and
 * actions; this component owns the shell, application rail, end rail, and
 * desktop inspector footprint.
 */
export const WorkspaceFrame = (props: WorkspaceFrameProps) => {
  const isCompact = useIsMobile();

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

  const { children, endRail, inspector, navigation, topBar } = props;
  const inspectorPresentation = resolveWorkspaceInspectorPresentation({
    hasMobilePresentation: inspector?.mobile !== undefined,
    isCompact,
  });
  const desktopNavigation = (
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

  const frame = (
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
