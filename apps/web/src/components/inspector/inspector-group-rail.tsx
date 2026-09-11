import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useDirection } from "@base-ui/react/direction-provider";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, PenLineIcon, UngroupIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { MenuItem, MenuSeparator } from "@stll/ui/menu";
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
import { useAnchoredMenu } from "@/components/inspector/use-anchored-menu";
import Tooltip from "@/components/tooltip";
import { detached } from "@/lib/detached";
import { resolveMatterColor } from "@/lib/matter-colors";

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
  const menu = useAnchoredMenu({
    returnFocus,
    children: (
      <>
        {group.type === "matter" && (
          <InspectorMatterGroupAction group={group} />
        )}
        <MenuItem onClick={toggle}>
          <DirectionalIcon icon={ChevronRightIcon} />
          {label}
        </MenuItem>
        {group.type === "custom" && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => setEditing(true)}>
              <PenLineIcon />
              {t("inspector.groups.rename")}
            </MenuItem>
            <MenuItem
              onClick={() =>
                useInspectorTabsStore.getState().removeGroup(group.id)
              }
            >
              <UngroupIcon />
              {t("inspector.groups.remove")}
            </MenuItem>
          </>
        )}
      </>
    ),
  });
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
            <button
              aria-controls={contentId}
              aria-expanded={!collapsed}
              aria-label={label}
              className="hover:bg-accent focus-visible:ring-ring relative flex min-h-11 w-full items-center justify-center rounded-md outline-hidden focus-visible:ring-2"
              onClick={containedEventHandler(toggle)}
              onContextMenu={containedEventHandler(menu.openAt)}
              onKeyDown={menu.onKeyDown}
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
                const id = event.dataTransfer.getData(INSPECTOR_TAB_DRAG_TYPE);
                setDragOver(false);
                if (!id) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                requestMove(id, group.id);
              }}
              ref={returnFocus}
              type="button"
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
        <div hidden={collapsed} id={contentId}>
          {children}
        </div>
      </section>
      {menu.element}
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

const InspectorMatterGroupAction = ({
  group,
}: {
  group: Extract<InspectorGroupPresentation, { type: "matter" }>;
}) => {
  const navigate = useNavigate();
  const t = useTranslations();
  return (
    <MenuItem
      onClick={() =>
        detached(
          navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId: group.workspaceId },
          }),
          "inspector-group.navigate",
        )
      }
    >
      <InspectorGroupIcon group={group} />
      {t("workspaces.copyToMatter.goToMatter")}
    </MenuItem>
  );
};
