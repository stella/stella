import { useEffect } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ClockIcon,
  EyeIcon,
  FilterIcon,
  HashIcon,
  SparklesIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { cn } from "@stella/ui/lib/utils";

import type {
  EntityKind,
  ViewConfig,
  ViewFilterCondition,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { resolveKanbanGroupBy } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type ViewToolbarProps = {
  view: WorkspaceView;
  workspaceId: string;
};

export const ViewToolbar = ({ view, workspaceId }: ViewToolbarProps) => {
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const updateView = useUpdateView();

  const updateConfig = useDebouncedCallback((patch: Partial<ViewConfig>) => {
    updateView.mutate({
      workspaceId,
      viewId: view.id,
      // Always include layout: Elysia coerces absent optional
      // UnionEnum fields to their first value, corrupting the DB.
      layout: view.layout,
      config: { ...view.config, ...patch },
    });
  }, 300);

  // biome-ignore lint/correctness/useExhaustiveDependencies: view.id triggers reset on view switch
  useEffect(() => {
    updateConfig.cancel();
  }, [view.id]);

  const { filters, sorts } = view.config;

  const { visibleProperties } = view.config;

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1">
      {filters.map((filter, i) => {
        const filterKey =
          filter.field === "kind" ? `kind-${i}` : `${filter.propertyId}-${i}`;
        return (
          <FilterChip
            filter={filter}
            key={filterKey}
            onChange={(updated) => {
              const next = [...filters];
              next[i] = updated;
              updateConfig({ filters: next });
            }}
            onRemove={() => {
              updateConfig({
                filters: filters.filter((_, idx) => idx !== i),
              });
            }}
            properties={properties}
          />
        );
      })}
      <AddFilterButton
        isActive={filters.length > 0}
        onAdd={(filter) => updateConfig({ filters: [...filters, filter] })}
        properties={properties}
      />

      {sorts.map((sort, i) => {
        const prop = properties.find((p) => p.id === sort.propertyId);
        return (
          <SortChip
            desc={sort.desc}
            key={`${sort.propertyId}-${sort.desc}`}
            onRemove={() => {
              updateConfig({
                sorts: sorts.filter((_, idx) => idx !== i),
              });
            }}
            onToggle={() => {
              const next = [...sorts];
              next[i] = { ...sort, desc: !sort.desc };
              updateConfig({ sorts: next });
            }}
            propertyName={prop?.name ?? "Unknown"}
            propertyType={prop?.content.type}
          />
        );
      })}
      <AddSortButton
        isActive={sorts.length > 0}
        onAdd={(sort) => updateConfig({ sorts: [...sorts, sort] })}
        properties={properties}
      />

      <PropertiesToggle
        onChange={(next) => updateConfig({ visibleProperties: next })}
        properties={properties}
        visibleProperties={visibleProperties}
      />

      {view.layout === "kanban" && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <KanbanGroupByControl
            groupByPropertyId={view.config.kanban?.groupByPropertyId}
            onChange={(groupByPropertyId) =>
              updateConfig({
                kanban: { groupByPropertyId },
              })
            }
            properties={properties}
          />
        </>
      )}
    </div>
  );
};

// -- Filter components --

type AddFilterButtonProps = {
  properties: WorkspaceProperty[];
  onAdd: (filter: ViewFilterCondition) => void;
  isActive?: boolean;
};

const filterOps = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "contains", label: "contains" },
  { value: "is_empty", label: "is empty" },
] as const;

const AddFilterButton = ({
  properties,
  onAdd,
  isActive,
}: AddFilterButtonProps) => {
  const t = useTranslations();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            className={cn(isActive && "text-primary")}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <FilterIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem
          onClick={() =>
            onAdd({
              field: "kind",
              op: "eq",
              value: "document",
            })
          }
        >
          {t("common.kind")}
        </MenuItem>
        {properties.map((prop) => (
          <MenuItem
            key={prop.id}
            onClick={() =>
              onAdd({
                field: "property",
                propertyId: prop.id,
                op: "eq",
                value: "",
              })
            }
          >
            <PropertyIcon type={prop.content.type} />
            {prop.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};

type FilterChipProps = {
  filter: ViewFilterCondition;
  properties: WorkspaceProperty[];
  onChange: (filter: ViewFilterCondition) => void;
  onRemove: () => void;
};

const FilterChip = ({
  filter,
  properties,
  onChange,
  onRemove,
}: FilterChipProps) => {
  const label =
    filter.field === "kind"
      ? "Kind"
      : (properties.find((p) => p.id === filter.propertyId)?.name ?? "Unknown");

  return (
    <span className="flex items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs">
      <span className="font-medium">{label}</span>
      {filter.field === "property" && (
        <>
          <Select
            onValueChange={(op) =>
              onChange({
                ...filter,
                // SAFETY: Select options are constrained to filterOps literals
                op: op as ViewFilterCondition & { field: "property" } extends {
                  op: infer O;
                }
                  ? O
                  : never,
              })
            }
            value={filter.op}
          >
            <SelectTrigger
              className="h-5 min-h-0 min-w-0 gap-0.5 border-0 bg-transparent px-1 text-xs shadow-none"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {filterOps.map((op) => (
                <SelectItem key={op.value} value={op.value}>
                  {op.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {filter.op !== "is_empty" && (
            <Input
              className="h-5 w-20 border-0 bg-transparent px-1 text-xs shadow-none"
              onChange={(e) =>
                onChange({
                  ...filter,
                  value: e.currentTarget.value,
                })
              }
              value={String(filter.value ?? "")}
            />
          )}
        </>
      )}
      {filter.field === "kind" && (
        <Select
          onValueChange={(v) => {
            if (v !== null) {
              // SAFETY: Select options are
              // the EntityKind literal values
              onChange({
                field: "kind",
                op: "eq",
                value: v as EntityKind,
              });
            }
          }}
          value={String(filter.value)}
        >
          <SelectTrigger
            className="h-5 min-h-0 min-w-0 gap-0.5 border-0 bg-transparent px-1 text-xs shadow-none"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {(["document", "folder", "task", "message"] as const).map(
              (kind) => (
                <SelectItem key={kind} value={kind}>
                  {kind}
                </SelectItem>
              ),
            )}
          </SelectPopup>
        </Select>
      )}
      <Button
        className="ml-0.5 size-5"
        onClick={onRemove}
        size="icon"
        variant="ghost"
      >
        <XIcon className="size-3" />
      </Button>
    </span>
  );
};

// -- Sort components --

type AddSortButtonProps = {
  properties: WorkspaceProperty[];
  onAdd: (sort: { propertyId: string; desc: boolean }) => void;
  isActive?: boolean;
};

const AddSortButton = ({ properties, onAdd, isActive }: AddSortButtonProps) => {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            className={cn(isActive && "text-primary")}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <ArrowUpDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        {properties.map((prop) => (
          <MenuItem
            key={prop.id}
            onClick={() => onAdd({ propertyId: prop.id, desc: false })}
          >
            <PropertyIcon type={prop.content.type} />
            {prop.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};

type SortChipProps = {
  propertyName: string;
  propertyType?: string;
  desc: boolean;
  onToggle: () => void;
  onRemove: () => void;
};

const getSortChipLabel = (
  propertyType: string | undefined,
  desc: boolean,
): string | null => {
  switch (propertyType) {
    case "text":
    case "single-select":
    case "multi-select":
    case "file":
      return desc ? "Z→A" : "A→Z";
    case "int":
      return desc ? "9→1" : "1→9";
    case "date":
      return desc ? "↓" : "↑";
    default:
      return null;
  }
};

const SortChip = ({
  propertyName,
  propertyType,
  desc,
  onToggle,
  onRemove,
}: SortChipProps) => {
  const SortIcon = desc ? ArrowDownIcon : ArrowUpIcon;
  const hint = getSortChipLabel(propertyType, desc);

  return (
    <span className="flex items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs">
      <Button
        className="flex h-auto items-center gap-1 p-0 font-medium"
        onClick={onToggle}
        variant="ghost"
      >
        <SortIcon className="size-3" />
        {propertyName}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </Button>
      <Button
        className="ml-0.5 size-auto rounded p-0.5 hover:bg-muted"
        onClick={onRemove}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon className="size-3" />
      </Button>
    </span>
  );
};

// -- Layout-specific controls --

type KanbanGroupByControlProps = {
  properties: WorkspaceProperty[];
  groupByPropertyId: string | undefined;
  onChange: (propertyId: string) => void;
};

const KanbanGroupByControl = ({
  properties,
  groupByPropertyId,
  onChange,
}: KanbanGroupByControlProps) => {
  const t = useTranslations();
  const eligible = properties.filter((p) => p.content.type === "single-select");

  const resolvedId = resolveKanbanGroupBy(groupByPropertyId ?? "", properties);

  const resolvedLabel = (() => {
    if (resolvedId === "__kind__") {
      return t("common.kind");
    }
    if (resolvedId === "__created_by__") {
      return t("workspaces.filesystem.author");
    }
    return (
      eligible.find((p) => p.id === resolvedId)?.name ??
      t("workspaces.views.selectProperty")
    );
  })();

  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">
        {t("workspaces.views.groupBy")}
      </span>
      <Select
        onValueChange={(v) => {
          if (v !== null) {
            onChange(v);
          }
        }}
        value={resolvedId}
      >
        <SelectTrigger className="h-6 min-h-0 min-w-24 text-xs" size="sm">
          <SelectValue placeholder={resolvedLabel}>{resolvedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="__kind__">{t("common.kind")}</SelectItem>
          <SelectItem value="__created_by__">
            {t("workspaces.filesystem.author")}
          </SelectItem>
          {eligible.map((prop) => (
            <SelectItem key={prop.id} value={prop.id}>
              {prop.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </span>
  );
};

type PropertiesToggleProps = {
  properties: WorkspaceProperty[];
  visibleProperties: string[];
  onChange: (visibleProperties: string[]) => void;
};

const metadataFields = [
  { id: "__created_by__", name: "Author", icon: UserIcon },
  { id: "__updated_at__", name: "Last updated", icon: ClockIcon },
  // TODO: waiting for Damian — version is hardcoded to 1
  { id: "__version__", name: "Version", icon: HashIcon },
] as const;

const PropertiesToggle = ({
  properties,
  visibleProperties,
  onChange,
}: PropertiesToggleProps) => {
  const t = useTranslations();
  const allVisible = visibleProperties.length === 0;

  const toggleProperty = (propertyId: string) => {
    if (allVisible) {
      // Switching from "all visible" to explicit list:
      // include all except the toggled one
      const allIds = [
        ...metadataFields.map((m) => m.id),
        ...properties.map((p) => p.id),
      ];
      onChange(allIds.filter((id) => id !== propertyId));
    } else if (visibleProperties.includes(propertyId)) {
      const next = visibleProperties.filter((id) => id !== propertyId);
      // If removing the last one, go back to "all visible"
      onChange(next.length === 0 ? [] : next);
    } else {
      onChange([...visibleProperties, propertyId]);
    }
  };

  const manualProperties = properties.filter(
    (p) => p.tool.type === "manual-input",
  );
  const aiProperties = properties.filter((p) => p.tool.type === "ai-model");

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
        <EyeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("common.metadata")}</MenuGroupLabel>
          {metadataFields.map((meta) => {
            const isVisible = allVisible || visibleProperties.includes(meta.id);
            return (
              <MenuItem key={meta.id} onClick={() => toggleProperty(meta.id)}>
                <meta.icon className="size-4" />
                <span className="flex-1">{meta.name}</span>
                {isVisible && <span className="text-primary">{"\u2713"}</span>}
              </MenuItem>
            );
          })}
        </MenuGroup>
        {manualProperties.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("common.properties")}</MenuGroupLabel>
              {manualProperties.map((prop) => {
                const isVisible =
                  allVisible || visibleProperties.includes(prop.id);
                return (
                  <MenuItem
                    key={prop.id}
                    onClick={() => toggleProperty(prop.id)}
                  >
                    <PropertyIcon type={prop.content.type} />
                    <span className="flex-1">{prop.name}</span>
                    {isVisible && (
                      <span className="text-primary">{"\u2713"}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </>
        )}
        {aiProperties.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                <SparklesIcon className="mr-1 inline size-3" />
                {t("workspaces.views.aiGenerated")}
              </MenuGroupLabel>
              {aiProperties.map((prop) => {
                const isVisible =
                  allVisible || visibleProperties.includes(prop.id);
                return (
                  <MenuItem
                    key={prop.id}
                    onClick={() => toggleProperty(prop.id)}
                  >
                    <PropertyIcon type={prop.content.type} />
                    <span className="flex-1">{prop.name}</span>
                    {isVisible && (
                      <span className="text-primary">{"\u2713"}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
};
