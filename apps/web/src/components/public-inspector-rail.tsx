import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { PanelRightIcon } from "@stll/ui/icons";
import {
  InspectorDock,
  InspectorRailIconButton,
  resolveInspectorDockWidth,
} from "@stll/ui/inspector";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "@stll/ui/sheet";
import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/toast";
import { useIsMobile } from "@stll/ui/use-mobile";
import { useViewportWidth } from "@stll/ui/use-viewport-width";
import { WorkspaceEndRail } from "@stll/ui/workspace-shell";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useSharedInspectorPaneWidth } from "@/components/inspector/pane-width-storage";
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
 * and keeps the one width the reader dragged it to in every section.
 */
export const PublicInspectorDock = ({
  children,
  expanded = false,
}: PublicInspectorDockProps) => {
  const isMobile = useIsMobile();
  const setMinimized = useInspectorTabsStore((state) => state.setMinimized);
  const t = useTranslations();
  const sidebarWidth = useSidebarInlineSize();
  const viewportWidth = useViewportWidth();
  const { resetWidth, resizeHandleProps, width } = useSharedInspectorPaneWidth({
    openedFrom: "public-law",
    sidebarWidth,
    viewportWidth,
  });

  const dockWidth = resolveInspectorDockWidth({
    paneWidth: width,
    showPaneContent: expanded,
  });
  const widthPx = isMobile ? "0px" : `${dockWidth}px`;

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

  if (isMobile) {
    return (
      <Sheet open={expanded} onOpenChange={(open) => setMinimized(!open)}>
        <SheetPopup
          className="h-dvh w-full max-w-none md:hidden"
          showCloseButton={false}
          side="inline-end"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("inspector.title")}</SheetTitle>
          </SheetHeader>
          {children}
        </SheetPopup>
      </Sheet>
    );
  }

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
