import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { Separator } from "@stll/ui/components/separator";
import { cn } from "@stll/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { useColumnLabels } from "@/routes/_protected.workspaces/-hooks/use-column-labels";
import { useSortLabels } from "@/routes/_protected.workspaces/-hooks/use-sort-labels";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";
import type {
  MattersColumnId,
  MattersSortKey,
} from "@/routes/_protected.workspaces/-types";
import { ALL_COLUMNS } from "@/routes/_protected.workspaces/-types";
import { useConfigStore } from "@/stores/config-store";

const routeApi = getRouteApi("/_protected");

const SORT_KEYS = [
  "name",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
  "clientName",
] as const satisfies readonly MattersSortKey[];

type MattersToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
};

export const MattersToolbar = ({
  search,
  onSearchChange,
  searchRef,
}: MattersToolbarProps) => {
  const t = useTranslations();
  const sortLabels = useSortLabels();
  const config = useConfigStore(useShallow((s) => s.matters));
  const update = useConfigStore((s) => s.updateMatters);

  return (
    <div
      className={cn(
        "flex items-center gap-1 border-b px-2",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <Input
        className="w-64 max-w-[40%]"
        onChange={(e) => onSearchChange(e.currentTarget.value)}
        placeholder={t("common.search")}
        ref={searchRef}
        size="sm"
        value={search}
      />

      <ToolbarSeparator />

      <Menu>
        <MenuTrigger render={<Button size="xs" variant="ghost" />}>
          <SlidersHorizontalIcon />
          <span className="text-muted-foreground text-xs">
            {sortLabels[config.sortKey]}
          </span>
          {config.sortDesc ? (
            <ArrowDownIcon className="size-3" />
          ) : (
            <ArrowUpIcon className="size-3" />
          )}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>{t("common.sort")}</MenuGroupLabel>
            {SORT_KEYS.map((key) => (
              <MenuItem
                key={key}
                onClick={() => {
                  if (config.sortKey === key) {
                    update({ sortDesc: !config.sortDesc });
                  } else {
                    update({ sortKey: key, sortDesc: true });
                  }
                }}
              >
                <span className="flex-1">{sortLabels[key]}</span>
                {config.sortKey === key &&
                  (config.sortDesc ? (
                    <ArrowDownIcon className="text-primary size-3" />
                  ) : (
                    <ArrowUpIcon className="text-primary size-3" />
                  ))}
              </MenuItem>
            ))}
          </MenuGroup>

          <Separator className="my-1" />

          <MenuGroup>
            <MenuGroupLabel>{t("workspaces.views.groupBy")}</MenuGroupLabel>
            <MenuItem onClick={() => update({ groupBy: "none" })}>
              <span className="flex-1">{t("workspaces.noGrouping")}</span>
              {config.groupBy === "none" && (
                <CheckIcon className="text-primary size-3" />
              )}
            </MenuItem>
            <MenuItem onClick={() => update({ groupBy: "client" })}>
              <span className="flex-1">{t("workspaces.parties.client")}</span>
              {config.groupBy === "client" && (
                <CheckIcon className="text-primary size-3" />
              )}
            </MenuItem>
          </MenuGroup>

          {config.viewMode === "table" && (
            <>
              <Separator className="my-1" />
              <ColumnsGroup />
            </>
          )}
        </MenuPopup>
      </Menu>

      <Button
        onClick={() =>
          update({
            viewMode: config.viewMode === "grid" ? "table" : "grid",
          })
        }
        size="xs"
        variant="ghost"
      >
        {config.viewMode === "grid" ? (
          <>
            <ListIcon />
            {t("workspaces.views.layouts.table")}
          </>
        ) : (
          <>
            <LayoutGridIcon />
            {t("workspaces.views.layouts.grid")}
          </>
        )}
      </Button>

      <CreateMatterPopover className="ms-auto" />
    </div>
  );
};

type CreateMatterPopoverProps = {
  className?: string | undefined;
};

const CreateMatterPopover = ({ className }: CreateMatterPopoverProps) => {
  const t = useTranslations();
  const canCreate = usePermissions({ workspace: ["create"] });
  const activeOrganizationId = routeApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data } = useQuery(workspacesOptions(activeOrganizationId));
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);

  if (!data || !canCreate) {
    return null;
  }

  const isLimitReached = data.workspaces.length >= data.workspacesCountLimit;
  if (isLimitReached) {
    return null;
  }

  return (
    <Button className={className} onClick={() => openCreateMatter()} size="xs">
      <PlusIcon />
      {t("workspaces.newMatter")}
    </Button>
  );
};

const ColumnsGroup = () => {
  const t = useTranslations();
  const columnLabels = useColumnLabels();

  return (
    <MenuGroup>
      <MenuGroupLabel>{t("common.columns")}</MenuGroupLabel>
      {ALL_COLUMNS.map((id) => (
        <ColumnToggleItem id={id} key={id} label={columnLabels[id]} />
      ))}
    </MenuGroup>
  );
};

type ColumnToggleItemProps = {
  id: MattersColumnId;
  label: string;
};

const ColumnToggleItem = ({ id, label }: ColumnToggleItemProps) => {
  const hidden = useConfigStore((s) => s.matters.hiddenColumns).includes(id);
  const toggle = useConfigStore((s) => s.toggleMattersColumn);

  return (
    <MenuItem onClick={() => toggle(id)}>
      <span className="flex-1">{label}</span>
      {!hidden && <CheckIcon className="text-primary size-3" />}
    </MenuItem>
  );
};

const ToolbarSeparator = () => (
  <Separator className="mx-1 h-4" orientation="vertical" />
);
