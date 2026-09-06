import { useId, useState } from "react";
import type { RefObject } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { FolderPlusIcon, ListTreeIcon, UngroupIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/menu";

import { useInspectorGroupTransfer } from "@/components/inspector/inspector-group-transfer";
import { getInspectorTabGroupId } from "@/components/inspector/inspector-groups.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterIcon } from "@/components/matter-icon";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  MATTER_SWATCHES,
  getMatterSwatch,
  resolveMatterColor,
} from "@/lib/matter-colors";
import {
  workspacesNavigationOptions,
  workspacesRouteOptions,
} from "@/lib/workspaces/queries";

export type InspectorGroupPresentation = {
  id: string;
  name: string;
  color: string;
} & ({ type: "matter"; workspaceId: string } | { type: "custom" });

export const useInspectorGroups = () => {
  const t = useTranslations();
  const { activeOrganizationId } = useAuthenticatedUser();
  const { data } = useQuery(workspacesNavigationOptions(activeOrganizationId));
  const state = useInspectorTabsStore(
    useShallow((s) => ({
      tabs: s.tabs,
      groups: s.groups,
      groupAssignments: s.groupAssignments,
    })),
  );
  const byId = new Map<string, InspectorGroupPresentation>();
  if (data !== undefined) {
    for (const matter of data.workspaces) {
      const group = {
        id: `matter:${matter.id}`,
        type: "matter",
        workspaceId: matter.id,
        name: matter.name,
        color: matter.color ?? getMatterSwatch(matter.id),
      } as const;
      byId.set(group.id, group);
    }
  }
  for (const group of state.groups) {
    if (group.type !== "custom") {
      continue;
    }
    const presentation = {
      id: group.id,
      type: group.type,
      name: group.name,
      color: group.color,
    };
    byId.set(group.id, presentation);
  }
  const groupedTabs = new Map<string, typeof state.tabs>();
  const ungroupedTabs: typeof state.tabs = [];
  for (const tab of state.tabs) {
    const groupId = getInspectorTabGroupId(state, tab);
    if (groupId === null) {
      ungroupedTabs.push(tab);
      continue;
    }
    const members = groupedTabs.get(groupId);
    if (members) {
      members.push(tab);
    } else {
      groupedTabs.set(groupId, [tab]);
    }
    if (groupId.startsWith("matter:") && !byId.has(groupId)) {
      const workspaceId = groupId.slice("matter:".length);
      byId.set(groupId, {
        id: groupId,
        type: "matter",
        workspaceId,
        name: t("common.matter"),
        color: getMatterSwatch(workspaceId),
      });
    }
  }
  const visibleGroups: {
    group: InspectorGroupPresentation;
    tabs: typeof state.tabs;
  }[] = [];
  for (const [id, tabs] of groupedTabs) {
    const group = byId.get(id);
    if (group === undefined) {
      panic("Inspector tab references a missing group");
    }
    visibleGroups.push({ group, tabs });
  }
  for (const group of byId.values()) {
    if (group.type === "custom" && !groupedTabs.has(group.id)) {
      visibleGroups.push({ group, tabs: [] });
    }
  }
  return { visibleGroups, ungroupedTabs };
};

export const InspectorGroupIcon = ({
  group,
}: {
  group: InspectorGroupPresentation;
}) =>
  group.type === "matter" ? (
    <MatterIcon
      className="size-4 shrink-0"
      matter={{ id: group.workspaceId, color: group.color }}
    />
  ) : (
    <span style={{ color: resolveMatterColor(group.id, group.color) }}>
      <EntityKindIcon className="size-4 shrink-0" kind="folder" />
    </span>
  );

type GroupEditorTarget =
  | { type: "create"; tabId?: string }
  | { type: "edit"; id: string; name: string; color: string };

export const InspectorGroupEditor = ({
  target,
  onClose,
  returnFocus,
}: {
  target: GroupEditorTarget;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null> | undefined;
}) => {
  const t = useTranslations();
  const inputId = useId();
  const format = useFormatter();
  const [name, setName] = useState(target.type === "edit" ? target.name : "");
  const [color, setColor] = useState(
    target.type === "edit" ? target.color : MATTER_SWATCHES[0],
  );
  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    const state = useInspectorTabsStore.getState();
    if (target.type === "edit") {
      state.updateGroup({ id: target.id, name: trimmedName, color });
    } else {
      const id = state.createGroup({ name: trimmedName, color });
      if (target.tabId) {
        state.setTabGroup(target.tabId, id);
      }
    }
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogPopup finalFocus={returnFocus}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {target.type === "edit"
                ? t("inspector.groups.rename")
                : t("inspector.groups.newGroup")}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={inputId}>{t("inspector.groups.name")}</Label>
              <Input
                autoFocus
                id={inputId}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                {t("inspector.groups.color")}
              </legend>
              <div className="flex flex-wrap gap-1">
                {MATTER_SWATCHES.map((swatch, index) => (
                  <Button
                    aria-label={t("inspector.groups.colorOption", {
                      number: format.number(index + 1),
                    })}
                    aria-pressed={color === swatch}
                    key={swatch}
                    onClick={() => setColor(swatch)}
                    size="icon"
                    type="button"
                    variant={color === swatch ? "secondary" : "ghost"}
                  >
                    <span
                      className="size-4 rounded-full"
                      style={{ backgroundColor: `var(${swatch})` }}
                    />
                  </Button>
                ))}
              </div>
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="ghost">
              {t("common.cancel")}
            </Button>
            <Button disabled={!name.trim()} type="submit">
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
};

export const useInspectorGroupMenu = (
  tabId?: string,
  returnFocus?: RefObject<HTMLElement | null>,
) => {
  const t = useTranslations();
  const [editor, setEditor] = useState<GroupEditorTarget | null>(null);
  const transfer = useInspectorGroupTransfer(returnFocus);
  return {
    items: (
      <>
        {tabId && (
          <MenuSub>
            <MenuSubTrigger>
              <ListTreeIcon />
              {t("inspector.groups.moveToGroup")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <InspectorGroupDestinations
                onMove={(groupId) => transfer.requestMove(tabId, groupId)}
              />
              <MenuSeparator />
              <MenuItem onClick={() => transfer.requestMove(tabId, null)}>
                <UngroupIcon />
                {t("inspector.groups.ungroup")}
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
        )}
        <MenuItem
          onClick={() =>
            setEditor(tabId ? { type: "create", tabId } : { type: "create" })
          }
        >
          <FolderPlusIcon />
          {t("inspector.groups.newGroup")}
        </MenuItem>
      </>
    ),
    dialogs: (
      <>
        {editor && (
          <InspectorGroupEditor
            onClose={() => setEditor(null)}
            returnFocus={returnFocus}
            target={editor}
          />
        )}
        {transfer.dialog}
      </>
    ),
  };
};

const InspectorGroupDestinations = ({
  onMove,
}: {
  onMove: (groupId: string) => void;
}) => {
  const { activeOrganizationId } = useAuthenticatedUser();
  const { data } = useQuery(workspacesRouteOptions(activeOrganizationId));
  const customGroups = useInspectorTabsStore((state) => state.groups);
  const destinations: InspectorGroupPresentation[] = [];
  if (data !== undefined) {
    for (const matter of data.workspaces) {
      destinations.push({
        id: `matter:${matter.id}`,
        type: "matter",
        workspaceId: matter.id,
        name: matter.name,
        color: matter.color ?? getMatterSwatch(matter.id),
      });
    }
  }
  for (const group of customGroups) {
    if (group.type === "custom") {
      destinations.push(group);
    }
  }
  return destinations.map((group) => (
    <MenuItem key={group.id} onClick={() => onMove(group.id)}>
      <InspectorGroupIcon group={group} />
      <bdi className="max-w-64 truncate">{group.name}</bdi>
    </MenuItem>
  ));
};
