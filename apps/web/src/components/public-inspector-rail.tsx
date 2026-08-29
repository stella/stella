import type { ReactNode } from "react";

import { PanelRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { InspectorRailIconButton, SIDE_RAIL_WIDTH } from "@stll/ui/inspector";
import { cn } from "@stll/ui/utils";
import { WorkspaceEndRail } from "@stll/ui/workspace-shell";

import Tooltip from "@/components/tooltip";

/** Reading width of an expanded public inspector pane, in pixels. */
export const PUBLIC_INSPECTOR_PANE_WIDTH = 420;

/**
 * Public twin of the inspector side rail: same geometry and chrome as the
 * authenticated rail, with every affordance routed by the host.
 */
export const PublicInspectorRail = ({
  onActivate,
}: {
  onActivate: () => void;
}) => {
  const t = useTranslations();

  return (
    <PublicInspectorDock>
      <div className="bg-background flex h-full shadow-lg">
        <WorkspaceEndRail
          chatAction={{
            label: t("inspector.openChat"),
            onActivate,
            status: "enabled",
          }}
          className="h-full"
          label={t("inspector.title")}
          topAction={
            <Tooltip
              content={t("inspector.showPane")}
              render={
                <InspectorRailIconButton
                  aria-label={t("inspector.showPane")}
                  onClick={onActivate}
                />
              }
            >
              <PanelRightIcon className="size-4" />
            </Tooltip>
          }
        />
      </div>
    </PublicInspectorDock>
  );
};

type PublicInspectorDockProps = {
  children: ReactNode;
  /** Widened to the pane while a tab is on screen; a bare rail otherwise. */
  expanded?: boolean;
};

/**
 * The column a public surface docks its inspector into. It reserves its own
 * width in the flow, so the reading column beside it is never covered. Narrow
 * viewports get no dock at all: there the reader owns the whole screen.
 */
export const PublicInspectorDock = ({
  children,
  expanded = false,
}: PublicInspectorDockProps) => {
  const width = expanded ? { width: PUBLIC_INSPECTOR_PANE_WIDTH } : undefined;

  return (
    <div
      className="text-sidebar-foreground hidden md:block"
      data-side="right"
      data-state={expanded ? "expanded" : "collapsed"}
    >
      <div
        className={cn("bg-sidebar relative", !expanded && SIDE_RAIL_WIDTH)}
        style={width}
      />
      <div
        className={cn(
          "fixed inset-y-0 end-0 z-10 hidden h-svh md:flex",
          !expanded && SIDE_RAIL_WIDTH,
        )}
        style={width}
      >
        <div className="bg-sidebar flex h-full w-full flex-col">{children}</div>
      </div>
    </div>
  );
};
