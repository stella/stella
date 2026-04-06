import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CheckIcon,
  EyeIcon,
  FilterIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { Separator } from "@stella/ui/components/separator";
import { cn } from "@stella/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { useSortLabels } from "@/routes/_protected.workspaces/-hooks/use-sort-labels";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";
import type {
  MattersColumnId,
  MattersSortKey,
} from "@/routes/_protected.workspaces/-types";
import { ALL_COLUMNS } from "@/routes/_protected.workspaces/-types";
import { getUniqueClientsFromWorkspace } from "@/routes/_protected.workspaces/-utils";
import { useConfigStore } from "@/stores/config-store";

const SORT_KEYS: MattersSortKey[] = [
  "name",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
  "clientName",
];

const COLUMN_ID_TO_SORT_KEY: Record<MattersColumnId, MattersSortKey> = {
  client: "clientName",
  reference: "reference",
  entityCount: "entityCount",
  lastActivityAt: "lastActivityAt",
  createdAt: "createdAt",
};

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
  const { data } = useSuspenseQuery(workspacesOptions);
  const config = useConfigStore(useShallow((s) => s.matters));
  const update = useConfigStore((s) => s.updateMatters);
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const uniqueClients = getUniqueClientsFromWorkspace(data.workspaces);
  const activeClient = uniqueClients.find((c) => c.id === config.clientFilter);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1">
      {activeClient && (
        <Chip>
          <span className="font-medium">{t("workspaces.parties.client")}</span>
          <span className="text-muted-foreground">
            {activeClient.displayName}
          </span>
          <Button
            className="ms-0.5 size-4"
            onClick={() => update({ clientFilter: null })}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </Chip>
      )}
      <ClientFilterDropdown
        clients={uniqueClients}
        onSelect={(id) => update({ clientFilter: id })}
        selected={config.clientFilter}
      />

      <ToolbarSeparator />

      <Button
        onClick={() => update({ sortDesc: !config.sortDesc })}
        size="xs"
        variant="ghost"
      >
        {config.sortDesc ? <ArrowDownIcon /> : <ArrowUpIcon />}
        {sortLabels[config.sortKey]}
      </Button>
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="ghost" />}>
          <ArrowUpDownIcon />
          {t("common.sort")}
        </MenuTrigger>
        <MenuPopup>
          {SORT_KEYS.map((key) => (
            <MenuItem
              key={key}
              onClick={() => update({ sortKey: key, sortDesc: true })}
            >
              <span className="flex-1">{sortLabels[key]}</span>
              {config.sortKey === key && (
                <CheckIcon className="text-primary size-3" />
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>

      <ToolbarSeparator />

      <span className="text-muted-foreground text-xs">
        {t("workspaces.views.groupBy")}
      </span>
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="ghost" />}>
          {config.groupBy === "client"
            ? t("workspaces.parties.client")
            : t("workspaces.noGrouping")}
        </MenuTrigger>
        <MenuPopup>
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
        </MenuPopup>
      </Menu>

      {config.viewMode === "table" && (
        <>
          <ToolbarSeparator />
          <ColumnsToggle />
        </>
      )}

      <div className="ms-auto flex items-center gap-1">
        <Input
          className={cn(
            "transition-[width]",
            isSearchFocused || search ? "w-44" : "w-28",
          )}
          onBlur={() => setIsSearchFocused(false)}
          onChange={(e) => onSearchChange(e.currentTarget.value)}
          onFocus={() => setIsSearchFocused(true)}
          placeholder={t("common.search")}
          ref={searchRef}
          size="sm"
          value={search}
        />
        <ToolbarSeparator />
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
        <CreateMatterPopover />
      </div>
    </div>
  );
};

const CreateMatterPopover = () => {
  const t = useTranslations();
  const canCreate = usePermissions({ workspace: ["create"] });
  const { data } = useSuspenseQuery(workspacesOptions);
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);

  const isLimitReached = data.workspaces.length >= data.workspacesCountLimit;
  if (isLimitReached || !canCreate) {
    return null;
  }

  return (
    <Button onClick={() => openCreateMatter()} size="xs">
      <PlusIcon />
      {t("workspaces.newMatter")}
    </Button>
  );
};

const Chip = ({ children }: React.PropsWithChildren) => (
  <span className="bg-muted/50 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs">
    {children}
  </span>
);

type ClientFilterDropdownProps = {
  clients: { id: string; displayName: string }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
};

const ClientFilterDropdown = ({
  clients,
  selected,
  onSelect,
}: ClientFilterDropdownProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState("");

  const filtered = query
    ? clients.filter((c) =>
        c.displayName.toLowerCase().includes(query.toLowerCase()),
      )
    : clients;

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
        <FilterIcon />
        {t("common.filter")}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-52">
        <Input
          autoFocus
          className="mb-2"
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("contacts.search")}
          size="sm"
          value={query}
        />
        <div className="-mx-2 max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">
              {t("contacts.noContactsFound")}
            </p>
          ) : (
            filtered.map((client) => (
              <Button
                className="w-full justify-start gap-2"
                key={client.id}
                onClick={() => onSelect(client.id)}
                size="sm"
                variant="ghost"
              >
                <span className="flex-1 truncate">{client.displayName}</span>
                {selected === client.id && (
                  <CheckIcon className="text-primary size-3 shrink-0" />
                )}
              </Button>
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
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

const ColumnsToggle = () => {
  const t = useTranslations();
  const sortLabels = useSortLabels();

  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
        <EyeIcon />
        {t("common.columns")}
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("common.columns")}</MenuGroupLabel>
          {ALL_COLUMNS.map((id) => (
            <ColumnToggleItem
              id={id}
              key={id}
              label={sortLabels[COLUMN_ID_TO_SORT_KEY[id]]}
            />
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
};

const ToolbarSeparator = () => (
  <Separator className="mx-1 h-4" orientation="vertical" />
);
