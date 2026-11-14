import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { withDropAnnouncementData } from "@/components/drag-and-drop-live-region.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { dropTargetForElements } from "@/lib/drag-and-drop/element-registration";
import type { WorkspaceGroup } from "@/lib/workspaces/types";
import { ClientGroupHeader } from "@/routes/_protected.workspaces/-components/client-group-header";
import {
  readMatterCardDragData,
  resolveMatterClientDrop,
} from "@/routes/_protected.workspaces/-components/matter-client-drop.logic";
import type {
  AcceptedMatterClientDrop,
  MatterClientDrop,
} from "@/routes/_protected.workspaces/-components/matter-client-drop.logic";

type ClientGroupSectionProps = {
  group: WorkspaceGroup;
  personalLabel: string;
  collapsed: boolean;
  onToggle: () => void;
  // `null` when the viewer cannot reassign clients; the group is then no drop
  // target.
  onMatterDrop: ((drop: AcceptedMatterClientDrop) => void) | null;
  children: ReactNode;
};

// One group of the client-grouped card grid. The header and its cards share a
// subgrid wrapper so the whole group, gaps included, is a single drop target,
// and a collapsed group still accepts drops on its header.
export const ClientGroupSection = ({
  group,
  personalLabel,
  collapsed,
  onToggle,
  onMatterDrop,
  children,
}: ClientGroupSectionProps) => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const acceptsDrops = onMatterDrop !== null;

  const resolveDrop = useLatestCallback(
    (data: Record<string | symbol, unknown>): MatterClientDrop => {
      const source = readMatterCardDragData(data);
      if (source === null) {
        return { type: "rejected" };
      }
      return resolveMatterClientDrop({ source, group });
    },
  );

  const handleDrop = useLatestCallback(
    (data: Record<string | symbol, unknown>) => {
      const drop = resolveDrop(data);
      if (drop.type === "rejected" || onMatterDrop === null) {
        return;
      }
      onMatterDrop(drop);
    },
  );

  const groupName = useLatestCallback(() =>
    group.type === "client" ? group.clientName : personalLabel,
  );

  useExternalSyncEffect(() => {
    const element = sectionRef.current;
    if (!element || !acceptsDrops) {
      return undefined;
    }
    return dropTargetForElements({
      element,
      name: "matter-client-group",
      canDrop: ({ source }) => resolveDrop(source.data).type !== "rejected",
      getData: () =>
        withDropAnnouncementData({}, { type: "container", name: groupName() }),
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: ({ source }) => {
        setIsDropTarget(false);
        handleDrop(source.data);
      },
    });
  }, [acceptsDrops, groupName, handleDrop, resolveDrop]);

  return (
    <div
      className={cn(
        "group/client-section col-span-full grid auto-rows-min gap-3 rounded-xl md:grid-cols-subgrid",
        isDropTarget && "outline-primary outline-2 outline-offset-4",
      )}
      ref={sectionRef}
    >
      <ClientGroupHeader
        collapsed={collapsed}
        group={group}
        onToggle={onToggle}
        personalLabel={personalLabel}
      />
      {children}
    </div>
  );
};
