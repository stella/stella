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
import { InspectorDock } from "@stll/ui/inspector";
import { WorkspaceEndRail, WorkspaceShell } from "@stll/ui/workspace-shell";

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
  mobile?: ReactElement | undefined;
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
  navigation: WorkspaceFrameNavigation;
  topBar: ComponentProps<typeof WorkspaceShell>["topBar"];
  endRail: WorkspaceFrameEndRail;
  inspector?: WorkspaceFrameInspector;
};

/**
 * Stella's complete workspace frame. Hosts provide route descriptors and
 * actions; this component owns the shell, application rail, end rail, and
 * desktop inspector footprint.
 */
export const WorkspaceFrame = ({
  children,
  endRail,
  inspector,
  navigation,
  topBar,
}: WorkspaceFrameProps) => {
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

  const endDock = inspector ? (
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

  return (
    <WorkspaceShell
      endDock={endDock}
      navigation={{
        compact: navigation.compact,
        desktop: desktopNavigation,
        mode: "shell-managed",
      }}
      topBar={topBar}
    >
      {children}
      {inspector?.mobile}
    </WorkspaceShell>
  );
};
