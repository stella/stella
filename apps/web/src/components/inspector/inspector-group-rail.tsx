import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useDirection } from "@base-ui/react/direction-provider";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { EntityActions } from "@stll/ui/entity-actions";
import type { EntityAction } from "@stll/ui/entity-actions";
import { ChevronRightIcon, PenLineIcon, UngroupIcon } from "@stll/ui/icons";
import { resolveMatterColor } from "@stll/ui/matter-colors";
import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import {
  InspectorGroupEditor,
  InspectorGroupIcon,
} from "@/components/inspector/inspector-group-controls";
import type { InspectorGroupPresentation } from "@/components/inspector/inspector-group-controls";
import { useInspectorGroupTransfer } from "@/components/inspector/inspector-group-transfer";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import Tooltip from "@/components/tooltip";
import { detached } from "@/lib/detached";

export const INSPECTOR_TAB_DRAG_TYPE = "application/x-stella-inspector-tab";

type InspectorRailGroupProps = {
  group: InspectorGroupPresentation;
  tabs: InspectorTab[];
  children: ReactNode;
  collapsed: boolean;
  activeId: string | null;
};

export const InspectorRailGroup = ({
  group,
  tabs,
  children,
  collapsed,
  activeId,
}: InspectorRailGroupProps) => {
  const t = useTranslations();
  const direction = useDirection();
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const contentId = useId();
  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const { requestMove, dialog } = useInspectorGroupTransfer(returnFocus);
  const color = resolveMatterColor(group.id, group.color);
  const toggle = () =>
    useInspectorTabsStore.getState().toggleGroupCollapsed(group.id);
  const label = collapsed
    ? t("inspector.groups.expand", { groupName: group.name })
    : t("inspector.groups.collapse", { groupName: group.name });
  const navigate = useNavigate();
  const actions: EntityAction[] = [
    ...(group.type === "matter"
      ? [
          {
            label: t("workspaces.copyToMatter.goToMatter"),
            icon: <InspectorGroupIcon group={group} />,
            onClick: () => {
              detached(
                navigate({
                  to: "/workspaces/$workspaceId",
                  params: { workspaceId: group.workspaceId },
                }),
                "inspector-group.navigate",
              );
            },
          },
        ]
      : []),
    {
      label,
      icon: <DirectionalIcon icon={ChevronRightIcon} />,
      onClick: toggle,
    },
    ...(group.type === "custom"
      ? [
          {
            label: t("inspector.groups.rename"),
            icon: <PenLineIcon />,
            separatorBefore: true,
            onClick: () => setEditing(true),
          },
          {
            label: t("inspector.groups.remove"),
            icon: <UngroupIcon />,
            onClick: () =>
              useInspectorTabsStore.getState().removeGroup(group.id),
          },
        ]
      : []),
  ];
  return (
    <>
      <section
        aria-label={group.name}
        className={cn("relative py-1", dragOver && "bg-accent")}
      >
        {!collapsed && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-2 end-0.5 z-10 w-px rounded-full opacity-40"
            style={{ backgroundColor: color }}
          />
        )}
        <EntityActions actions={actions} label={label}>
          <Tooltip
            content={
              <div>
                <bdi>{group.name}</bdi>
                <div className="text-muted-foreground">
                  {t("inspector.groups.tabCount", { count: tabs.length })}
                </div>
              </div>
            }
            render={
              <Button
                aria-controls={contentId}
                aria-expanded={!collapsed}
                aria-label={label}
                className="flex min-h-11 w-full justify-center"
                onClick={containedEventHandler(toggle)}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget instanceof Node
                        ? event.relatedTarget
                        : null,
                    )
                  ) {
                    setDragOver(false);
                  }
                }}
                onDragOver={(event) => {
                  if (
                    !event.dataTransfer.types.includes(INSPECTOR_TAB_DRAG_TYPE)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOver(true);
                }}
                onDrop={(event) => {
                  const id = event.dataTransfer.getData(
                    INSPECTOR_TAB_DRAG_TYPE,
                  );
                  setDragOver(false);
                  if (!id) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  requestMove(id, group.id);
                }}
                ref={returnFocus}
                // The ghost treatment is the rail cell's own hover fill; the
                // glyph tile inside keeps the group colour.
                variant="ghost"
              />
            }
            side={direction === "rtl" ? "right" : "left"}
          >
            <span
              className="relative flex size-7 items-center justify-center rounded-md"
              style={{
                backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
              }}
            >
              <DirectionalIcon
                className={cn("size-4", !collapsed && "rotate-90")}
                flip={collapsed}
                icon={ChevronRightIcon}
              />
              {collapsed && tabs.some((tab) => tab.id === activeId) && (
                <span
                  aria-hidden="true"
                  className="absolute end-0 top-0 size-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
              )}
            </span>
          </Tooltip>
        </EntityActions>
        <div hidden={collapsed} id={contentId}>
          {children}
        </div>
      </section>
      {dialog}
      {editing && group.type === "custom" && (
        <InspectorGroupEditor
          returnFocus={returnFocus}
          onClose={() => setEditing(false)}
          target={{
            type: "edit",
            id: group.id,
            name: group.name,
            color: group.color,
          }}
        />
      )}
    </>
  );
};
