import type { PropsWithChildren, ReactNode } from "react";

import type { LucideIcon } from "lucide-react";
import {
  CircleDotIcon,
  FileTextIcon,
  FilterIcon,
  FolderIcon,
  SignalIcon,
  SquareCheckIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";

import type { ViewFilterCondition, WorkspaceProperty } from "@/lib/types";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";

const KIND_ICONS: Record<string, LucideIcon> = {
  document: FileTextIcon,
  folder: FolderIcon,
  task: SquareCheckIcon,
};

type FilterChipsProps = {
  filters: ViewFilterCondition[];
  properties: WorkspaceProperty[];
  onUpdate: (filters: ViewFilterCondition[]) => void;
};

export const FilterChips = ({
  filters,
  properties,
  onUpdate,
}: FilterChipsProps) => {
  const handleChange = (id: string, updated: ViewFilterCondition) => {
    onUpdate(filters.map((f) => (f.id === id ? updated : f)));
  };

  const handleRemove = (id: string) => {
    onUpdate(filters.filter((f) => f.id !== id));
  };

  const renderChip = (filter: ViewFilterCondition) => {
    const shared = {
      onChange: (updated: ViewFilterCondition) =>
        handleChange(filter.id, updated),
      onRemove: () => handleRemove(filter.id),
    };

    switch (filter.field) {
      case "kind":
        return <KindFilterChip filter={filter} key={filter.id} {...shared} />;
      case "builtin":
        return (
          <BuiltinFilterChip filter={filter} key={filter.id} {...shared} />
        );
      case "property":
        return (
          <PropertyFilterChip
            filter={filter}
            key={filter.id}
            properties={properties}
            {...shared}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      {filters.map(renderChip)}
      <AddFilterButton
        filters={filters}
        onAdd={(filter) => onUpdate([...filters, filter])}
        properties={properties}
      />
    </>
  );
};

type AddFilterButtonProps = {
  properties: WorkspaceProperty[];
  filters: ViewFilterCondition[];
  onAdd: (filter: ViewFilterCondition) => void;
};

const hasFilter = (
  filters: ViewFilterCondition[],
  field: string,
  builtinField?: string,
) =>
  filters.some(
    (f) =>
      f.field === field &&
      (builtinField === undefined ||
        (f.field === "builtin" && f.builtinField === builtinField)),
  );

const AddFilterButton = ({
  properties,
  filters,
  onAdd,
}: AddFilterButtonProps) => {
  const t = useTranslations();

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
        <FilterIcon />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem
          disabled={hasFilter(filters, "kind")}
          onClick={() =>
            onAdd({
              id: crypto.randomUUID(),
              field: "kind",
              op: "in",
              value: [],
            })
          }
        >
          <FilterIcon className="size-3.5" />
          {t("common.kind")}
        </MenuItem>
        <MenuItem
          disabled={hasFilter(filters, "builtin", "status")}
          onClick={() =>
            onAdd({
              id: crypto.randomUUID(),
              field: "builtin",
              builtinField: "status",
              op: "eq",
              value: "",
            })
          }
        >
          <CircleDotIcon className="size-3.5" />
          {t("common.status")}
        </MenuItem>
        <MenuItem
          disabled={hasFilter(filters, "builtin", "priority")}
          onClick={() =>
            onAdd({
              id: crypto.randomUUID(),
              field: "builtin",
              builtinField: "priority",
              op: "eq",
              value: "",
            })
          }
        >
          <SignalIcon className="size-3.5" />
          {t("tasks.priority")}
        </MenuItem>
        {properties
          .filter((p) => p.content.type !== "file")
          .map((prop) => (
            <MenuItem
              key={prop.id}
              onClick={() =>
                onAdd({
                  id: crypto.randomUUID(),
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

const ENTITY_KINDS = ["document", "task"] as const;

type FilterChipWrapperProps = {
  label: string;
  onRemove: () => void;
  children: ReactNode;
};

const FilterChipWrapper = ({
  label,
  onRemove,
  children,
}: FilterChipWrapperProps) => (
  <div className="bg-muted/50 flex items-center gap-1 rounded-md border">
    <span className="ps-2 text-xs font-medium">{label}</span>
    {children}
    <Button onClick={onRemove} size="icon-xs" variant="ghost">
      <XIcon />
    </Button>
  </div>
);

type KindFilterChipProps = {
  filter: Extract<ViewFilterCondition, { field: "kind" }>;
  onChange: (filter: ViewFilterCondition) => void;
  onRemove: () => void;
};

const useKindLabels = (): Record<string, string> => {
  const t = useTranslations();
  return {
    document: t("search.kinds.document"),
    folder: t("search.kinds.folder"),
    task: t("search.kinds.task"),
    message: t("search.kinds.message"),
  };
};

const KindFilterChip = ({
  filter,
  onChange,
  onRemove,
}: KindFilterChipProps) => {
  const t = useTranslations();
  const kindLabels = useKindLabels();
  const label =
    filter.value.length === 0
      ? t("common.all")
      : filter.value.map((k) => kindLabels[k] ?? k).join(", ");

  return (
    <FilterChipWrapper label={t("common.kind")} onRemove={onRemove}>
      <Select
        multiple
        onValueChange={(kinds) => onChange({ ...filter, value: kinds })}
        value={filter.value}
      >
        <FilterSelectTrigger>{label}</FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {ENTITY_KINDS.map((kind) => {
            const Icon = KIND_ICONS[kind];
            return (
              <SelectItem key={kind} value={kind}>
                {Icon && <Icon className="size-3.5" />}
                {kindLabels[kind] ?? kind}
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
    </FilterChipWrapper>
  );
};

// -- Builtin field filter (status, priority) --

const STATUS_VALUES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

const PRIORITY_VALUES = ["none", "urgent", "high", "medium", "low"] as const;

type BuiltinFilterChipProps = {
  filter: Extract<ViewFilterCondition, { field: "builtin" }>;
  onChange: (filter: ViewFilterCondition) => void;
  onRemove: () => void;
};

const BuiltinFilterChip = ({
  filter,
  onChange,
  onRemove,
}: BuiltinFilterChipProps) => {
  const t = useTranslations();
  const isStatus = filter.builtinField === "status";
  const label = isStatus ? t("common.status") : t("tasks.priority");
  const values = isStatus ? STATUS_VALUES : PRIORITY_VALUES;

  const resolveLabel = (val: string) =>
    isStatus
      ? // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        t(`tasks.statusValues.${val}` as "tasks.statusValues.open")
      : // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        t(`tasks.priorityValues.${val}` as "tasks.priorityValues.none");

  const opOptions = [
    { value: "eq", label: t("filters.eq") },
    { value: "neq", label: t("filters.neq") },
    { value: "is_empty", label: t("filters.is_empty") },
  ] as const;

  return (
    <FilterChipWrapper label={label} onRemove={onRemove}>
      <Select
        onValueChange={(op) => {
          if (op) {
            onChange({ ...filter, op });
          }
        }}
        value={filter.op}
      >
        <FilterSelectTrigger>
          {opOptions.find((o) => o.value === filter.op)?.label}
        </FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {opOptions.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {filter.op !== "is_empty" && (
        <Select
          onValueChange={(val) => {
            if (val !== null) {
              onChange({ ...filter, value: val });
            }
          }}
          value={String(filter.value ?? "")}
        >
          <FilterSelectTrigger>
            {filter.value !== "" && filter.value !== null
              ? resolveLabel(String(filter.value))
              : "…"}
          </FilterSelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {values.map((val) => (
              <SelectItem key={val} value={val}>
                {resolveLabel(val)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
    </FilterChipWrapper>
  );
};

type PropertyFilterChipProps = {
  filter: Extract<ViewFilterCondition, { field: "property" }>;
  properties: WorkspaceProperty[];
  onChange: (filter: ViewFilterCondition) => void;
  onRemove: () => void;
};

const PropertyFilterChip = ({
  filter,
  properties,
  onChange,
  onRemove,
}: PropertyFilterChipProps) => {
  const t = useTranslations();
  const property = properties.find((p) => p.id === filter.propertyId);

  if (!property) {
    return null;
  }

  const isSingleSelect =
    property.content.type === "single-select" ||
    property.content.type === "multi-select";

  const selectOptions =
    isSingleSelect &&
    (property.content.type === "single-select" ||
      property.content.type === "multi-select")
      ? property.content.options
      : [];

  // For single-select: simpler ops (is / is not / is empty)
  const opOptions = isSingleSelect
    ? ([
        { value: "eq", label: t("filters.eq") },
        { value: "neq", label: t("filters.neq") },
        { value: "is_empty", label: t("filters.is_empty") },
      ] as const)
    : ([
        { value: "eq", label: t("filters.eq") },
        { value: "neq", label: t("filters.neq") },
        { value: "contains", label: t("filters.contains") },
        { value: "is_empty", label: t("filters.is_empty") },
      ] as const);

  return (
    <FilterChipWrapper label={property.name} onRemove={onRemove}>
      <Select
        onValueChange={(op) => {
          if (op) {
            onChange({ ...filter, op });
          }
        }}
        value={filter.op}
      >
        <FilterSelectTrigger>
          {opOptions.find((o) => o.value === filter.op)?.label}
        </FilterSelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {opOptions.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {filter.op !== "is_empty" &&
        (isSingleSelect ? (
          <Select
            onValueChange={(val) => {
              if (val !== null) {
                onChange({ ...filter, value: val });
              }
            }}
            value={String(filter.value ?? "")}
          >
            <FilterSelectTrigger>
              {filter.value !== "" && filter.value !== null
                ? String(filter.value)
                : "…"}
            </FilterSelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {selectOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <Input
            className="h-6! w-24 border-0 bg-transparent px-1 text-xs shadow-none"
            onChange={(e) =>
              onChange({
                ...filter,
                value: e.currentTarget.value,
              })
            }
            size="sm"
            value={String(filter.value ?? "")}
          />
        ))}
    </FilterChipWrapper>
  );
};

const FilterSelectTrigger = ({ children }: PropsWithChildren) => (
  <SelectTrigger
    className="w-auto! min-w-min! gap-0.5 border-0 bg-transparent px-1 text-xs! shadow-none [&_svg]:size-3"
    size="sm"
  >
    <SelectValue>{(): ReactNode => children}</SelectValue>
  </SelectTrigger>
);
