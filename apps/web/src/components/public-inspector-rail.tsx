import type { ReactNode } from "react";

import { PanelRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  InspectorDock,
  InspectorRailIconButton,
  resolveInspectorDockWidth,
  useInspectorPaneWidth,
} from "@stll/ui/inspector";
import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/toast";
import { useViewportWidth } from "@stll/ui/use-viewport-width";
import { WorkspaceEndRail } from "@stll/ui/workspace-shell";

import { inspectorPaneWidthStorageKey } from "@/components/inspector/pane-width-storage";
import { useSidebarInlineSize } from "@/components/sidebar";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect } from "@/hooks/use-effect";

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
 * The column a public surface docks its inspector into: the same
 * `InspectorDock` a matter uses, so the pane drags, resizes from the keyboard
 * and is remembered here exactly as it is there. Only the storage key
 * differs — the public surface is read at its own width.
 */
export const PublicInspectorDock = ({
  children,
  expanded = false,
}: PublicInspectorDockProps) => {
  const t = useTranslations();
  const sidebarWidth = useSidebarInlineSize();
  const viewportWidth = useViewportWidth();
  const { resetWidth, resizeHandleProps, width } = useInspectorPaneWidth({
    sidebarWidth,
    storageKey: inspectorPaneWidthStorageKey("public-law"),
    viewportWidth,
  });

  const dockWidth = resolveInspectorDockWidth({
    paneWidth: width,
    showPaneContent: expanded,
  });
  const widthPx = `${dockWidth}px`;

  // Toasts and a document's find bar sit beside the dock, not beneath it.
  useExternalSyncEffect(() => {
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
    <InspectorDock
      resizeHandleLabel={t("inspector.resizePane")}
      resizeHandleProps={resizeHandleProps}
      showPaneContent={expanded}
      width={dockWidth}
      onResetWidth={resetWidth}
    >
      {children}
    </InspectorDock>
  );
};
